// Test-only DSH probe for the memory runtime E2E.
//
// It drives the documented DSH seams through DSH/Cordis itself:
//   - `agent/pre-step` waterfall for recall injection and anchor dedupe;
//   - `session/event` for ingest and compaction checkpoints;
//   - `agent/created` + `tools/change` for memory tool masking.
//
// No model is started. The probe only emits/awaits events on a fake agent and
// writes an observation document; assertions happen in the harness.

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
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

  function fakeSession() {
    return {
      id: 'memory-e2e-session',
      inheritedEventCount: 0,
      firstLiveSeq: 0,
      seq: 100,
      surface: { nodes: [1], contentGeneration: 0 },
      ownEvents: () => [],
      isOwnSeq: () => true,
    };
  }

  function fakeAgent(session, tools) {
    return {
      id: 'memory-e2e-agent',
      session,
      ctx: tools === null ? {} : { tools },
    };
  }

  async function run() {
    await sleep(750);
    if (stopped) return;
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
    await Promise.resolve();
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
    const textOf = (decision) => {
      const last = decision?.messages?.at(-1);
      if (!last || !Array.isArray(last.content)) return '';
      return last.content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('\n');
    };

    const firstStep = step('memory e2e query', 'memory-e2e-human-1', 1);
    const first = await waterfall('agent/pre-step', firstStep.payload, firstStep.fallback);
    const second = await waterfall('agent/pre-step', firstStep.payload, firstStep.fallback);
    const nextStep = step('memory e2e query', 'memory-e2e-human-2', 2);
    const nextTurn = await waterfall('agent/pre-step', nextStep.payload, nextStep.fallback);
    const detailStep = step(detailQuery, 'memory-e2e-human-3', 3);
    const detailTurn = await waterfall('agent/pre-step', detailStep.payload, detailStep.fallback);
    const silenceStep = step(silentQuery, 'memory-e2e-human-4', 4);
    const silenceTurn = await waterfall('agent/pre-step', silenceStep.payload, silenceStep.fallback);
    state.preStep = {
      firstMessageCount: Array.isArray(first?.messages) ? first.messages.length : null,
      injected: Array.isArray(first?.messages) && first.messages.length > 1,
      injectedSource: first?.messages?.at(-1)?.source?.kind ?? null,
      secondMessageCount: Array.isArray(second?.messages) ? second.messages.length : null,
      nextTurnMessageCount: Array.isArray(nextTurn?.messages) ? nextTurn.messages.length : null,
      nextTurnInjected: Array.isArray(nextTurn?.messages) && nextTurn.messages.length > 1,
      detailInjected: Array.isArray(detailTurn?.messages) && detailTurn.messages.length > 1,
      detailSource: detailTurn?.messages?.at(-1)?.source?.kind ?? null,
      detailText: textOf(detailTurn),
      silenceInjected: Array.isArray(silenceTurn?.messages) && silenceTurn.messages.length > 1,
      silenceText: textOf(silenceTurn),
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
    const checkpointTurn = await waterfall('agent/pre-step', checkpointStep.payload, checkpointStep.fallback);
    state.preStep.checkpointInjected = Array.isArray(checkpointTurn?.messages) && checkpointTurn.messages.length > 1;
    state.preStep.checkpointSource = checkpointTurn?.messages?.at(-1)?.source?.kind ?? null;
    state.preStep.checkpointText = textOf(checkpointTurn);

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
