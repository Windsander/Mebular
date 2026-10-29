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

    const messages = [humanMessage('memory e2e query', 'memory-e2e-human-1')];
    const next = async () => ({ kind: 'enter', messages });
    const payload = {
      agent,
      messages,
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    };
    const first = await waterfall('agent/pre-step', payload, next);
    const second = await waterfall('agent/pre-step', payload, next);
    const nextTurn = await waterfall('agent/pre-step', { ...payload, turn: 2 }, next);
    state.preStep = {
      firstMessageCount: Array.isArray(first?.messages) ? first.messages.length : null,
      injected: Array.isArray(first?.messages) && first.messages.length > messages.length,
      injectedSource: first?.messages?.at(-1)?.source?.kind ?? null,
      secondMessageCount: Array.isArray(second?.messages) ? second.messages.length : null,
      nextTurnMessageCount: Array.isArray(nextTurn?.messages) ? nextTurn.messages.length : null,
      nextTurnInjected: Array.isArray(nextTurn?.messages) && nextTurn.messages.length > messages.length,
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
    state.session = { emitted: 3 };

    for (const event of [
      sessionEvent('compaction/start', 10, { compactionId: 'memory-e2e-compaction', turn: 1 }),
      sessionEvent('compaction/summary', 11, {
        compactionId: 'memory-e2e-compaction',
        summary: [{ type: 'text', text: 'memory e2e compacted summary' }],
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
