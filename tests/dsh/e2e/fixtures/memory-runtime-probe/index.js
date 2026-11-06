// Test-only DSH probe for the memory runtime E2E.
//
// It drives the documented DSH seams through DSH/Cordis itself:
//   - `agent/pre-step` waterfall for recall injection and anchor dedupe;
//   - `session/event` for ingest and compaction checkpoints;
//   - `agent/created` + `tools/change` for memory tool masking.
//
// No model is started. The probe only emits/awaits events on a fake agent and
// writes an observation document; assertions happen in the harness.

import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const name = '@mebular/dsh-memory-runtime-probe';

const DEFAULT_TIMEOUT_MS = 60000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function humanMessage(text, id) {
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  };
}

function sessionEvent(type, seq, data) {
  return { type, seq, time: Date.now(), data };
}

export function apply(ctx, config = {}) {
  const out = typeof process.env.MEMORY_E2E_OUT === 'string' && process.env.MEMORY_E2E_OUT.length > 0
    ? process.env.MEMORY_E2E_OUT
    : null;
  if (out === null) {
    try { ctx.logger?.warn?.('@mebular/dsh-memory-runtime-probe: MEMORY_E2E_OUT is not set'); } catch { /* ignore */ }
    return;
  }
  // Dispatch only to @mebular/dsh-plugin listeners. The real DSH process has
  // other root listeners for agent/session events (file references, session
  // projection) that need a real live Agent/Session; this probe intentionally
  // uses synthetic seams, so it must not feed those listeners.
  const dispatch = typeof ctx.extend === 'function'
    ? ctx.extend({
      [Symbol.for('cordis.filter')]: (target) => {
        try {
          return target?.fiber?.runtime?.name === '@mebular/dsh-plugin';
        } catch {
          return false;
        }
      },
    })
    : ctx;
  const emit = (event, ...args) => ctx.emit(dispatch, event, ...args);
  const waterfall = (event, ...args) => ctx.waterfall(dispatch, event, ...args);
  const timeoutMs = Number.isFinite(config?.timeoutMs) && config.timeoutMs > 0
    ? config.timeoutMs
    : DEFAULT_TIMEOUT_MS;
  const startFile = typeof process.env.MEMORY_E2E_START_FILE === 'string'
    && process.env.MEMORY_E2E_START_FILE.length > 0
    ? process.env.MEMORY_E2E_START_FILE
    : null;
  const scenario = typeof process.env.MEMORY_E2E_SCENARIO === 'string'
    ? process.env.MEMORY_E2E_SCENARIO
    : 'default';
  const phaseOut = typeof process.env.MEMORY_E2E_PHASE_OUT === 'string'
    && process.env.MEMORY_E2E_PHASE_OUT.length > 0
    ? process.env.MEMORY_E2E_PHASE_OUT
    : null;
  const continueFile = typeof process.env.MEMORY_E2E_CONTINUE_FILE === 'string'
    && process.env.MEMORY_E2E_CONTINUE_FILE.length > 0
    ? process.env.MEMORY_E2E_CONTINUE_FILE
    : null;
  const startedAt = new Date().toISOString();
  const state = {
    pid: process.pid,
    startedAt,
    updatedAt: startedAt,
    done: false,
    error: null,
    preStep: null,
    tools: null,
    session: null,
    compaction: null,
  };
  let stopped = false;

  function persist() {
    state.updatedAt = new Date().toISOString();
    try {
      mkdirSync(dirname(out), { recursive: true });
      const tmp = `${out}.tmp-${process.pid}`;
      writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
      renameSync(tmp, out);
    } catch {
      // Best effort.
    }
  }

  function writePhase(phase, extra = {}) {
    state.phase = phase;
    state.faults = { ...(state.faults ?? {}), ...extra };
    persist();
    if (phaseOut === null) return;
    try {
      mkdirSync(dirname(phaseOut), { recursive: true });
      const tmp = `${phaseOut}.tmp-${process.pid}`;
      writeFileSync(tmp, `${JSON.stringify({ phase, ...extra })}\n`, 'utf-8');
      renameSync(tmp, phaseOut);
    } catch {
      // Best effort.
    }
  }

  async function waitContinue() {
    if (continueFile === null) return;
    while (!stopped && !existsSync(continueFile)) await sleep(50);
    if (stopped) return;
    try {
      rmSync(continueFile, { force: true });
    } catch {
      // Best effort.
    }
  }

  function adapterState() {
    const symbol = Symbol.for('mebular.dsh.memoryRuntime.testState');
    try {
      return globalThis?.[symbol]?.()
        ?? ctx?.[symbol]?.()
        ?? ctx?.root?.[symbol]?.()
        ?? null;
    } catch {
      return null;
    }
  }

  function fakeSession() {
    const events = [];
    const nodes = [];
    const append = (type, data, options = {}) => {
      const seq = events.length;
      events.push({ type, seq, time: seq, data: structuredClone(data) });
      const op = options.surfaceOp;
      if (op === 'append') nodes.push(seq);
      else if (op?.op === 'replace') {
        const start = nodes.indexOf(op.startSeq);
        const end = nodes.indexOf(op.endSeq);
        if (start < 0 || end < start) throw new Error('invalid surface replace');
        nodes.splice(start, end - start + 1);
        nodes.push(seq);
      }
      return events[seq];
    };
    return {
      id: 'memory-e2e-session',
      inheritedEventCount: 0,
      firstLiveSeq: 0,
      seq: 100,
      surface: { nodes, contentGeneration: 0 },
      ownEvents: () => events,
      snapshotEvents: () => events,
      isOwnSeq: () => true,
      append,
    };
  }

  function surfaceMemory(session) {
    const current = new Set(session.surface.nodes);
    return session.snapshotEvents()
      .filter((event) => current.has(event.seq)
        && event.type === 'user/message'
        && event.data?.source?.kind === 'mebular-memory')
      .map((event) => event.data);
  }

  function surfaceText(session) {
    return surfaceMemory(session)
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .join('\n');
  }

  function fakeAgent(session, tools) {
    return {
      id: 'memory-e2e-agent',
      session,
      ctx: tools === null ? {} : { tools },
    };
  }

  function compactionEvents(compactionId, seqBase, summary) {
    return [
      sessionEvent('compaction/start', seqBase, { compactionId, turn: 1 }),
      sessionEvent('compaction/summary', seqBase + 1, {
        compactionId,
        summary: [{ type: 'text', text: summary }],
        shadowedRange: { start: 1, end: 9 },
        shadowedSeqs: [1, 2, 3],
        shadowedTokenCount: 42,
        provider: 'fake',
        model: 'no-model',
      }),
      sessionEvent('user/message', seqBase + 2, {
        id: `fault-replacement-${compactionId}`,
        role: 'user',
        content: [{ type: 'text', text: summary }],
        source: { kind: 'compact-checkpoint', compactionId },
      }),
      sessionEvent('compaction/end', seqBase + 3, { compactionId, turn: 1 }),
    ];
  }

  function summarizeCompaction(checkpointId) {
    const value = adapterState();
    return {
      checkpoint: value?.checkpoints ?? null,
      compaction: (value?.compactions ?? []).find((entry) => entry.compactionId === checkpointId) ?? null,
      runtimeEnabled: value?.enabled ?? null,
    };
  }

  function summarizeIngest() {
    return adapterState()?.ingest ?? null;
  }

  async function runFaults() {
    const session = fakeSession();
    const faultSummary = (label) => [
      '## Objective',
      label,
      '## Next Move',
      '- continue the fault scenario',
    ].join('\n');
    const emitCompaction = (compactionId, seqBase, summary) => {
      for (const event of compactionEvents(compactionId, seqBase, summary)) {
        emit('session/event', session, event);
      }
    };

    writePhase('start');
    await waitContinue();

    emitCompaction('fault-429', 10, faultSummary('rate limited checkpoint summary'));
    await sleep(1000);
    writePhase('rate-limited-done', { state: summarizeCompaction('fault-429') });
    await waitContinue();

    // summary_only deliberately: cloud summary_only is still authoritative even
    // though the sidecar reports degraded:true.
    emitCompaction('fault-timeout', 20, 'timeout checkpoint summary only');
    await sleep(5000);
    writePhase('timeout-done', { state: summarizeCompaction('fault-timeout') });
    await waitContinue();

    emitCompaction('fault-outbox', 30, faultSummary('outbox checkpoint summary'));
    await sleep(1000);
    writePhase('outbox-pending', { state: summarizeCompaction('fault-outbox') });
    await waitContinue();

    // No duplicate event: the bounded reconciliation timer must observe the
    // sidecar outbox replay and move the same operation to committed.
    await sleep(12000);
    writePhase('outbox-reconciled', { state: summarizeCompaction('fault-outbox') });
    await waitContinue();

    // A duplicate of an already reconciled operation must not write again.
    emitCompaction('fault-outbox', 30, faultSummary('outbox checkpoint summary'));
    await sleep(1000);
    writePhase('outbox-duplicate-done', { state: summarizeCompaction('fault-outbox') });
    await waitContinue();

    emitCompaction('fault-revision', 40, faultSummary('revision checkpoint summary'));
    await sleep(2500);
    writePhase('revision-done', { state: summarizeCompaction('fault-revision') });
    await waitContinue();

    emit('session/event', session, sessionEvent(
      'user/message',
      60,
      humanMessage('I prefer dark theme for detail partial', 'fault-detail-partial'),
    ));
    await sleep(1500);
    writePhase('detail-partial-done', { ingest: summarizeIngest() });
    await waitContinue();

    emitCompaction('fault-delete', 70, faultSummary('delete recreate checkpoint summary'));
    await sleep(1200);
    writePhase('delete-ready', { state: summarizeCompaction('fault-delete') });
    await waitContinue();

    // Same logical compaction after an external delete: the adapter must verify
    // absence and recreate with a nonce requestId instead of replaying old 200.
    emitCompaction('fault-delete', 70, faultSummary('delete recreate checkpoint summary'));
    await sleep(1800);
    writePhase('delete-recreated', { state: summarizeCompaction('fault-delete') });
    await waitContinue();

    emitCompaction('fault-disable', 80, faultSummary('disabled in-flight checkpoint summary'));
    await sleep(200);
    writePhase('disable-inflight', { state: summarizeCompaction('fault-disable') });
    await waitContinue();
    // Force discovery re-read while the PUT is still in flight.
    emit('tools/change');
    await sleep(1600);
    writePhase('disabled-done', { state: summarizeCompaction('fault-disable') });
    await sleep(100);
    state.done = true;
  }

  async function run() {
    await sleep(750);
    if (startFile !== null) {
      while (!stopped && !existsSync(startFile)) await sleep(100);
      if (stopped) return;
    }
    if (scenario === 'faults') {
      await runFaults();
      return;
    }
    const session = fakeSession();
    const toolNames = [
      'mcp__mebular__memory_query',
      'mcp__mebular__memory_write',
      'mcp__mebular__task_list',
      'mcp__other__tool',
    ];
    const denies = [];
    const tools = {
      schemas() {
        return toolNames.map((toolName) => ({ name: toolName }));
      },
      restrict(filter) {
        denies.push(Array.isArray(filter?.deny) ? [...filter.deny] : []);
        return () => {};
      },
    };
    const agent = fakeAgent(session, tools);

    emit('agent/created', { agent });
    await sleep(200);
    state.tools = {
      initialDeny: denies.at(-1) ?? null,
      replayedDeny: null,
      taskKept: !(denies.at(-1) ?? []).includes('mcp__mebular__task_list'),
    };

    toolNames.push('mcp__mebular__memory_new_tool');
    emit('tools/change');
    await sleep(100);
    state.tools.replayedDeny = denies.at(-1) ?? null;

    const env = process.env;
    const detailQuery = typeof env.MEMORY_E2E_DETAIL_QUERY === 'string' && env.MEMORY_E2E_DETAIL_QUERY.length > 0
      ? env.MEMORY_E2E_DETAIL_QUERY
      : '我原话怎么说的？';
    const silentQuery = typeof env.MEMORY_E2E_SILENT_QUERY === 'string' && env.MEMORY_E2E_SILENT_QUERY.length > 0
      ? env.MEMORY_E2E_SILENT_QUERY
      : 'tomorrow weather small talk';
    const step = (text, id, turn) => {
      const stepMessages = [humanMessage(text, id)];
      return {
        payload: {
          agent,
          messages: stepMessages,
          turn,
          step: 1,
          signal: new AbortController().signal,
        },
        fallback: async () => ({ kind: 'enter', messages: stepMessages }),
      };
    };
    const firstStep = step('memory e2e query', 'memory-e2e-human-1', 1);
    const first = await waterfall('agent/pre-step', firstStep.payload, firstStep.fallback);
    const firstMemory = surfaceMemory(session);
    const second = await waterfall('agent/pre-step', firstStep.payload, firstStep.fallback);
    const secondMemory = surfaceMemory(session);
    const nextStep = step('memory e2e query', 'memory-e2e-human-2', 2);
    const nextTurn = await waterfall('agent/pre-step', nextStep.payload, nextStep.fallback);
    const nextMemory = surfaceMemory(session);
    const detailStep = step(detailQuery, 'memory-e2e-human-3', 3);
    await waterfall('agent/pre-step', detailStep.payload, detailStep.fallback);
    const detailMemory = surfaceMemory(session);
    const detailText = surfaceText(session);
    const silenceStep = step(silentQuery, 'memory-e2e-human-4', 4);
    await waterfall('agent/pre-step', silenceStep.payload, silenceStep.fallback);
    const silenceMemory = surfaceMemory(session);
    state.preStep = {
      firstMessageCount: Array.isArray(first?.messages) ? first.messages.length : null,
      injected: firstMemory.length > 0,
      injectedSource: firstMemory.at(-1)?.source?.kind ?? null,
      secondMessageCount: Array.isArray(second?.messages) ? second.messages.length : null,
      secondInjected: secondMemory.length > 0,
      nextTurnMessageCount: Array.isArray(nextTurn?.messages) ? nextTurn.messages.length : null,
      nextTurnInjected: nextMemory.length > 0,
      detailInjected: detailMemory.length > 0,
      detailSource: detailMemory.at(-1)?.source?.kind ?? null,
      detailText,
      silenceInjected: silenceMemory.length > 0,
      silenceText: surfaceText(session),
    };

    const userEvent = sessionEvent('user/message', 1, humanMessage('memory e2e ingest', 'memory-e2e-user-1'));
    emit('session/event', session, userEvent);
    emit('session/event', session, userEvent);
    emit('session/event', session, sessionEvent('assistant/message', 2, {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'memory e2e assistant' }],
      },
    }));
    emit('session/event', session, sessionEvent(
      'user/message',
      3,
      humanMessage('memory e2e second turn', 'memory-e2e-user-2'),
    ));
    emit('session/event', session, sessionEvent('assistant/message', 4, {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'memory e2e second assistant' }],
      },
    }));
    state.session = { emitted: 5 };

    const compactionSummary = [
      '## Objective',
      'Continue the memory e2e task.',
      '## Requirements',
      '- Keep checkpoint schema 2',
      '## Decisions',
      '- Reuse graph storage — no second store',
      '## Work State',
      '- Done: compaction summary emitted',
      '- Doing: real host checkpoint',
      '- Blocked: none',
      '## Next Move',
      '- Verify the next turn injects the checkpoint',
      '## Relevant Files',
      '- packages/dsh-plugin/memory-runtime.js (write, in_progress)',
    ].join('\n');
    for (const event of [
      sessionEvent('compaction/start', 10, { compactionId: 'memory-e2e-compaction', turn: 1 }),
      sessionEvent('compaction/summary', 11, {
        compactionId: 'memory-e2e-compaction',
        summary: [{ type: 'text', text: compactionSummary }],
        shadowedRange: { start: 1, end: 9 },
        shadowedSeqs: [1, 2, 3],
        shadowedTokenCount: 42,
        provider: 'fake',
        model: 'no-model',
      }),
      sessionEvent('user/message', 12, {
        id: 'memory-e2e-replacement-1',
        role: 'user',
        content: [{ type: 'text', text: 'memory e2e compacted summary' }],
        source: { kind: 'compact-checkpoint', compactionId: 'memory-e2e-compaction' },
      }),
      sessionEvent('compaction/end', 13, { compactionId: 'memory-e2e-compaction', turn: 1 }),
    ]) {
      emit('session/event', session, event);
    }
    state.compaction = { emitted: true };

    await sleep(900);
    const checkpointStep = step('继续上次任务', 'memory-e2e-human-5', 5);
    await waterfall('agent/pre-step', checkpointStep.payload, checkpointStep.fallback);
    const checkpointMemory = surfaceMemory(session);
    state.preStep.checkpointInjected = checkpointMemory.length > 0;
    state.preStep.checkpointSource = checkpointMemory.at(-1)?.source?.kind ?? null;
    state.preStep.checkpointText = surfaceText(session);

    await sleep(500);
    state.done = true;
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => { stopped = true; }, '@mebular/dsh-memory-runtime-probe: stop flag');
  }
  persist();
  const deadline = setTimeout(() => {
    if (!state.done) {
      state.error = state.error ?? `probe timed out after ${timeoutMs}ms`;
      persist();
    }
  }, timeoutMs);
  deadline.unref?.();
  Promise.resolve()
    .then(run)
    .catch((error) => {
      state.error = String(error?.message ?? error);
    })
    .finally(() => {
      clearTimeout(deadline);
      state.done = state.error === null;
      persist();
    });
}
