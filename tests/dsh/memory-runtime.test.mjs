// DSH memory runtime adapter: fake ctx/fetch/llm unit tests.
//
// The adapter is HTTP-only and opt-in. These tests never start a real daemon
// and never import @mebular/*.

import { afterEach, describe, expect, it } from '@jest/globals';
import { apply } from '../../packages/dsh-plugin/index.js';
import {
  MEMORY_MESSAGE_SOURCE,
  buildRecallMessage,
  createMemoryRuntimeAdapter,
  parseCandidateOutput,
  redactMemoryText,
  resolveMemoryRuntimeConfig,
} from '../../packages/dsh-plugin/memory-runtime.js';

const BASE = 'http://127.0.0.1:7331';

function fakeContext() {
  const listeners = new Map();
  return {
    listeners,
    on(event, handler) {
      const list = listeners.get(event) ?? [];
      list.push(handler);
      listeners.set(event, list);
      return () => {
        const current = listeners.get(event) ?? [];
        listeners.set(event, current.filter((entry) => entry !== handler));
      };
    },
  };
}

function handlerFor(ctx, event) {
  return ctx.listeners.get(event)?.[0];
}

async function waterfall(ctx, event, payload, fallback) {
  const handlers = ctx.listeners.get(event) ?? [];
  const invoke = (index) => {
    if (index >= handlers.length) return fallback();
    return handlers[index](payload, () => invoke(index + 1));
  };
  return invoke(0);
}

function jsonOk(data) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ ok: true, requestId: 'req_test', data }),
  };
}

function jsonFail(status = 500, code = 'internal') {
  return {
    ok: false,
    status,
    json: async () => ({ ok: false, requestId: 'req_test', error: { code, message: 'failed' } }),
  };
}

function installFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    let body = null;
    if (typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const call = { url: String(url), init, body };
    calls.push(call);
    return handler(call);
  };
  return { calls, fetchImpl };
}

function makeSession({
  id = 's1',
  inherited = 0,
  firstLive = inherited,
  seq = 10,
  header = {},
  surface = { nodes: [1], contentGeneration: 0 },
  events = [],
  requestHeader,
  ownSeqs,
} = {}) {
  return {
    id,
    inheritedEventCount: inherited,
    firstLiveSeq: firstLive,
    seq,
    header,
    surface,
    ownEvents: () => events,
    requestHeader: () => requestHeader,
    isOwnSeq(seqNumber) {
      if (Array.isArray(ownSeqs)) return ownSeqs.includes(seqNumber);
      return seqNumber >= Math.max(inherited, firstLive, 0);
    },
  };
}

function makeAgent({ id = 'a1', session = makeSession(), tools = null, preset } = {}) {
  const agent = {
    id,
    session,
    ctx: tools === null ? {} : { tools },
  };
  if (preset !== undefined) agent.session = { ...session, header: { ...session.header, agentPreset: preset } };
  return agent;
}

function humanMessage(text) {
  return {
    id: 'human-1',
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  };
}

function event(type, seq, data, time = seq) {
  return { type, seq, time, data };
}

const cleanups = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    try {
      await cleanup();
    } catch {
      // Test cleanup is best-effort.
    }
  }
});

function adapterFor(options) {
  const ctx = options.ctx ?? fakeContext();
  const adapter = createMemoryRuntimeAdapter({ ...options, ctx });
  cleanups.push(() => adapter.dispose());
  return { ctx, adapter };
}

describe('@mebular/dsh-plugin memory runtime：配置与默认关闭', () => {
  it('默认关闭；关闭时不注册监听器、不产生 timer 或 fetch', async () => {
    const config = resolveMemoryRuntimeConfig({});
    expect(config.enabled).toBe(false);
    expect(config.recall).toBe(false);
    expect(config.ingest).toBe(false);
    expect(config.checkpoints).toBe(false);
    expect(config.hideMemoryTools).toBe(false);
    expect(config.maintenance.enabled).toBe(false);

    const ctx = fakeContext();
    const fetch = installFetch(() => {
      throw new Error('must not fetch');
    });
    const adapter = createMemoryRuntimeAdapter({ ctx, config: {}, fetchImpl: fetch.fetchImpl });
    cleanups.push(() => adapter.dispose());
    expect(ctx.listeners.size).toBe(0);
    await adapter.flush();
    expect(fetch.calls).toHaveLength(0);
    expect(adapter.getState().enabled).toBe(false);
  });

  it('enabled=true 打开召回/摄取/checkpoint/工具遮蔽，maintenance 仍需显式开启', () => {
    const config = resolveMemoryRuntimeConfig({ enabled: true });
    expect(config.enabled).toBe(true);
    expect(config.recall).toBe(true);
    expect(config.ingest).toBe(true);
    expect(config.checkpoints).toBe(true);
    expect(config.hideMemoryTools).toBe(true);
    expect(config.maintenance.enabled).toBe(false);
    expect(resolveMemoryRuntimeConfig({ enabled: true, maintenance: true }).maintenance.enabled).toBe(true);
  });

  it('apply 默认不注册 runtime 监听；显式开启后才注册', async () => {
    function applyHarness(memoryRuntime) {
      const listeners = new Map();
      const disposers = [];
      const ctx = {
        logger: { info() {}, warn() {} },
        on(event, handler) {
          listeners.set(event, handler);
          return () => listeners.delete(event);
        },
        effect(run) {
          const disposer = run();
          disposers.push(disposer);
          return disposer;
        },
      };
      const options = {
        lifecycle: {
          start: async () => {},
          inspect: async () => ({ status: 'up', daemonUrl: BASE }),
          dispose: async () => {},
        },
        installManager: { start() {}, getState() { return null; }, dispose() {} },
        upgradeManager: { start() {}, getState() { return null; }, dispose() {} },
        fetchImpl: installFetch(() => jsonOk({})).fetchImpl,
        bridgeIntervalMs: 100_000,
        setIntervalFn: (callback) => ({ callback, unref() {} }),
        clearIntervalFn: () => {},
      };
      apply(ctx, {
        daemonUrl: BASE,
        panel: false,
        ...(memoryRuntime === undefined ? {} : { memoryRuntime }),
      }, options);
      return {
        listeners,
        async dispose() {
          for (const disposer of disposers.slice().reverse()) {
            if (typeof disposer === 'function') await disposer();
          }
        },
      };
    }

    const off = applyHarness(undefined);
    expect(off.listeners.size).toBe(0);
    await off.dispose();

    const on = applyHarness({ enabled: true, ingest: false, checkpoints: false, hideMemoryTools: false });
    expect(on.listeners.has('agent/pre-step')).toBe(true);
    expect(on.listeners.has('session/event')).toBe(false);
    await on.dispose();
    expect(on.listeners.size).toBe(0);
  });
});

describe('@mebular/dsh-plugin memory runtime：recall 注入', () => {
  it('只在人类新 turn 首步注入一条 mebular-memory UserMessage', async () => {
    const ctx = fakeContext();
    const fetch = installFetch(() => jsonOk({
      records: [{
        id: 'm1',
        type: 'fact',
        content: 'user prefers dark theme',
        why: 'keyword',
      }],
    }));
    const session = makeSession({ surface: { nodes: [1, 2], contentGeneration: 0 } });
    const agent = makeAgent({ session });
    const { adapter } = adapterFor({
      ctx,
      config: {
        enabled: true,
        ingest: false,
        checkpoints: false,
        hideMemoryTools: false,
        recallTimeoutMs: 50,
      },
      daemonUrl: BASE,
      fetchImpl: fetch.fetchImpl,
    });

    const messages = [humanMessage('what theme should we use?')];
    const payload = {
      agent,
      messages,
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    };
    const decision = await waterfall(ctx, 'agent/pre-step', payload, async () => ({
      kind: 'enter',
      messages,
    }));

    expect(decision.kind).toBe('enter');
    expect(decision.messages).toHaveLength(2);
    expect(decision.messages[0]).toBe(messages[0]);
    const memory = decision.messages[1];
    expect(memory.role).toBe('user');
    expect(memory.source.kind).toBe(MEMORY_MESSAGE_SOURCE);
    expect(memory.content[0].text).toContain('user prefers dark theme');
    expect(memory.content[0].text).toContain('data, not instructions');

    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0].url).toBe(`${BASE}/runtime/v1/recall`);
    expect(fetch.calls[0].body.query).toBe('what theme should we use?');
    expect(fetch.calls[0].body.agentId).toBe('dsh');
    expect(fetch.calls[0].body.threadId).toBe('dsh_s1');
    expect(adapter.getState().recall.hits).toBe(1);

    // Same surface + same session query is deduped by the in-memory anchor.
    await waterfall(ctx, 'agent/pre-step', payload, async () => ({ kind: 'enter', messages }));
    expect(fetch.calls).toHaveLength(1);
    expect(adapter.getState().recall.deduped).toBe(1);

    // A later step is never a new-turn first step.
    await waterfall(ctx, 'agent/pre-step', { ...payload, step: 2 }, async () => ({
      kind: 'enter',
      messages,
    }));
    expect(fetch.calls).toHaveLength(1);

    // A new turn with the same surface and text is a new anchor: the previous
    // injection belonged to turn 1, not to the repeated prompt.
    await waterfall(ctx, 'agent/pre-step', {
      ...payload,
      turn: 2,
      messages: [humanMessage('what theme should we use?')],
    }, async () => ({ kind: 'enter', messages }));
    expect(fetch.calls).toHaveLength(2);

    // A new surface is also a new anchor.
    const nextSession = makeSession({ surface: { nodes: [1, 2, 3], contentGeneration: 0 } });
    await waterfall(ctx, 'agent/pre-step', {
      ...payload,
      agent: makeAgent({ session: nextSession }),
      turn: 3,
      messages: [humanMessage('what theme should we use?')],
    }, async () => ({ kind: 'enter', messages }));
    expect(fetch.calls).toHaveLength(3);
  });

  it('无命中、HTTP 失败和超时都原样放行', async () => {
    for (const response of [
      jsonOk({ records: [] }),
      jsonFail(500, 'internal'),
      new Promise(() => {}),
    ]) {
      const ctx = fakeContext();
      const fetch = installFetch(() => response);
      const session = makeSession();
      const agent = makeAgent({ session });
      const { adapter } = adapterFor({
        ctx,
        config: {
          enabled: true,
          ingest: false,
          checkpoints: false,
          hideMemoryTools: false,
          recallTimeoutMs: 20,
        },
        daemonUrl: BASE,
        fetchImpl: fetch.fetchImpl,
      });
      const messages = [humanMessage('hello')];
      const before = Date.now();
      const decision = await waterfall(ctx, 'agent/pre-step', {
        agent,
        messages,
        turn: 1,
        step: 1,
        signal: new AbortController().signal,
      }, async () => ({ kind: 'enter', messages }));
      expect(Date.now() - before).toBeLessThan(1000);
      expect(decision.messages).toBe(messages);
      expect(fetch.calls).toHaveLength(1);
      await adapter.dispose();
    }
  });

  it('非人类消息（compaction 替换、agent 注入）不触发 recall', async () => {
    const ctx = fakeContext();
    const fetch = installFetch(() => jsonOk({ records: [{ id: 'm1', type: 'fact', content: 'x' }] }));
    const { adapter } = adapterFor({
      ctx,
      config: { enabled: true, ingest: false, checkpoints: false, hideMemoryTools: false },
      daemonUrl: BASE,
      fetchImpl: fetch.fetchImpl,
    });
    const messages = [{
      id: 'compact-1',
      role: 'user',
      content: [{ type: 'text', text: 'summary' }],
      source: { kind: 'compact-checkpoint', compactionId: 'c1' },
    }];
    const decision = await waterfall(ctx, 'agent/pre-step', {
      agent: makeAgent(),
      messages,
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    }, async () => ({ kind: 'enter', messages }));
    expect(decision.messages).toBe(messages);
    expect(fetch.calls).toHaveLength(0);
    expect(adapter.getState().recall.skipped).toBe(1);
  });

  it('记忆管家 agent 不注入召回', async () => {
    const ctx = fakeContext();
    const fetch = installFetch(() => jsonOk({ records: [{ id: 'm1', type: 'fact', content: 'x' }] }));
    adapterFor({
      ctx,
      config: { enabled: true, ingest: false, checkpoints: false, hideMemoryTools: false },
      daemonUrl: BASE,
      fetchImpl: fetch.fetchImpl,
    });
    const messages = [humanMessage('hello')];
    const session = makeSession({ header: { agentPreset: 'mebular-memory' } });
    const decision = await waterfall(ctx, 'agent/pre-step', {
      agent: makeAgent({ session }),
      messages,
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    }, async () => ({ kind: 'enter', messages }));
    expect(decision.messages).toBe(messages);
    expect(fetch.calls).toHaveLength(0);
  });
});

describe('@mebular/dsh-plugin memory runtime：session/event 摄取', () => {
  it('批量摄取 user/assistant/tool，跳过 inherited prefix，并用 (sessionId, seq) 去重', async () => {
    const ctx = fakeContext();
    const fetch = installFetch(() => jsonOk({ accepted: { chunks: 1, records: 0 } }));
    const session = makeSession({ inherited: 3, firstLive: 3, seq: 20 });
    const { adapter } = adapterFor({
      ctx,
      config: {
        enabled: true,
        recall: false,
        checkpoints: false,
        hideMemoryTools: false,
        ingestBatchSize: 2,
        ingestFlushMs: 0,
        ingestTimeoutMs: 100,
      },
      daemonUrl: BASE,
      fetchImpl: fetch.fetchImpl,
    });
    const listener = handlerFor(ctx, 'session/event');
    expect(typeof listener).toBe('function');

    listener(session, event('user/message', 1, humanMessage('inherited')));
    listener(session, event('user/message', 3, humanMessage('hello')));
    listener(session, event('user/message', 3, humanMessage('hello')));
    listener(session, event('assistant/message', 4, {
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] },
    }));
    listener(session, event('tool/call', 5, { name: 'read', arguments: '{"path":"a"}' }));
    listener(session, event('user/message', 6, {
      id: 'mem-1',
      role: 'user',
      content: [{ type: 'text', text: 'memory recall' }],
      source: { kind: MEMORY_MESSAGE_SOURCE },
    }));

    await adapter.flush();
    expect(fetch.calls.length).toBeGreaterThanOrEqual(1);
    const ingested = fetch.calls
      .filter((call) => call.url === `${BASE}/runtime/v1/ingest`)
      .flatMap((call) => call.body.chunks);
    expect(ingested.map((chunk) => chunk.messageId)).toEqual([
      's1:3',
      's1:4',
      's1:5',
    ]);
    expect(ingested.map((chunk) => chunk.role)).toEqual(['user', 'assistant', 'tool']);
    expect(ingested[0].contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(fetch.calls[0].body.requestId).toMatch(/^dsh_/);
    expect(adapter.getState().ingest.duplicates).toBe(1);
    expect(adapter.getState().ingest.inherited).toBe(1);
    expect(adapter.getState().ingest.skipped).toBe(1);
  });

  it('队列有界：超过上限丢弃最旧事件但不阻塞', () => {
    const ctx = fakeContext();
    const fetch = installFetch(() => jsonOk({}));
    const session = makeSession({ seq: 100 });
    const { adapter } = adapterFor({
      ctx,
      config: {
        enabled: true,
        recall: false,
        checkpoints: false,
        hideMemoryTools: false,
        maxQueue: 4,
        ingestFlushMs: 10_000,
      },
      daemonUrl: BASE,
      fetchImpl: fetch.fetchImpl,
      ready: false,
    });
    const listener = handlerFor(ctx, 'session/event');
    for (let seq = 0; seq < 8; seq += 1) {
      listener(session, event('user/message', seq, humanMessage(`message ${seq}`)));
    }
    const state = adapter.getState();
    expect(state.ingest.queued).toBe(4);
    expect(state.ingest.dropped).toBe(4);
    expect(fetch.calls).toHaveLength(0);
  });

  it('HTTP 失败静默丢弃，不影响 loop', async () => {
    const ctx = fakeContext();
    const fetch = installFetch(() => jsonFail(503, 'runtime_not_ready'));
    const session = makeSession();
    const { adapter } = adapterFor({
      ctx,
      config: {
        enabled: true,
        recall: false,
        checkpoints: false,
        hideMemoryTools: false,
        ingestBatchSize: 8,
        ingestFlushMs: 0,
        ingestTimeoutMs: 50,
      },
      daemonUrl: BASE,
      fetchImpl: fetch.fetchImpl,
    });
    handlerFor(ctx, 'session/event')(session, event('user/message', 1, humanMessage('hello')));
    await expect(adapter.flush()).resolves.toBeUndefined();
    expect(adapter.getState().ingest.failed).toBe(1);
  });

  it('dispose 会做有界 flush，即使请求永不返回也会按时结束', async () => {
    const ctx = fakeContext();
    const fetch = installFetch(() => new Promise(() => {}));
    const session = makeSession();
    const { adapter } = adapterFor({
      ctx,
      config: {
        enabled: true,
        recall: false,
        checkpoints: false,
        hideMemoryTools: false,
        ingestBatchSize: 8,
        ingestFlushMs: 10_000,
        ingestTimeoutMs: 1000,
        disposeTimeoutMs: 50,
      },
      daemonUrl: BASE,
      fetchImpl: fetch.fetchImpl,
    });
    handlerFor(ctx, 'session/event')(session, event('user/message', 1, humanMessage('hello')));
    const before = Date.now();
    await adapter.dispose();
    expect(Date.now() - before).toBeLessThan(1000);
    expect(fetch.calls).toHaveLength(1);
    expect(adapter.getState().disposed).toBe(true);
  });

  it('dispose 前会把已排队事件送出', async () => {
    const ctx = fakeContext();
    const fetch = installFetch(() => jsonOk({}));
    const session = makeSession();
    const { adapter } = adapterFor({
      ctx,
      config: {
        enabled: true,
        recall: false,
        checkpoints: false,
        hideMemoryTools: false,
        ingestBatchSize: 8,
        ingestFlushMs: 10_000,
      },
      daemonUrl: BASE,
      fetchImpl: fetch.fetchImpl,
    });
    handlerFor(ctx, 'session/event')(session, event('user/message', 1, humanMessage('hello')));
    await adapter.dispose();
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0].body.chunks[0].text).toBe('hello');
  });
});

describe('@mebular/dsh-plugin memory runtime：compaction checkpoint', () => {
  function compactionEvents(compactionId = 'c1') {
    return [
      event('compaction/start', 10, { compactionId, turn: 1 }),
      event('compaction/summary', 11, {
        compactionId,
        summary: [{ type: 'text', text: 'the summary' }],
        shadowedRange: { start: 1, end: 9 },
        shadowedSeqs: [1, 2, 3],
        shadowedTokenCount: 120,
        provider: 'deepseek',
        model: 'flash',
      }),
      event('user/message', 12, {
        id: 'replacement-1',
        role: 'user',
        content: [{ type: 'text', text: 'the summary' }],
        source: { kind: 'compact-checkpoint', compactionId },
      }),
      event('compaction/end', 13, { compactionId, turn: 1 }),
    ];
  }

  it('start → summary → replacement → end 折叠为 ContextCheckpoint', async () => {
    const ctx = fakeContext();
    const fetch = installFetch(() => jsonOk({ checkpoint: { revision: 1 } }));
    const session = makeSession();
    const { adapter } = adapterFor({
      ctx,
      config: {
        enabled: true,
        recall: false,
        ingest: false,
        checkpoints: true,
        hideMemoryTools: false,
        checkpointTimeoutMs: 100,
      },
      daemonUrl: BASE,
      fetchImpl: fetch.fetchImpl,
    });
    const listener = handlerFor(ctx, 'session/event');
    for (const entry of compactionEvents()) listener(session, entry);
    await adapter.flush();
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0].url).toBe(`${BASE}/runtime/v1/checkpoints/dsh_s1`);
    expect(fetch.calls[0].init.method).toBe('PUT');
    expect(fetch.calls[0].body.agentId).toBe('dsh');
    expect(fetch.calls[0].body.summary).toBe('the summary');
    expect(fetch.calls[0].body.state).toMatchObject({
      kind: 'dsh-compaction',
      compactionId: 'c1',
      threadId: 'dsh_s1',
      replacementMessageId: 'replacement-1',
      summary: 'the summary',
    });
    expect(adapter.getState().checkpoints.committed).toBe(1);
    expect(adapter.getState().compactions[0]).toMatchObject({ compactionId: 'c1', committed: true });
  });

  it('HTTP 失败不伪装 committed', async () => {
    const ctx = fakeContext();
    const fetch = installFetch(() => jsonFail(409, 'revision_mismatch'));
    const session = makeSession();
    const { adapter } = adapterFor({
      ctx,
      config: {
        enabled: true,
        recall: false,
        ingest: false,
        checkpoints: true,
        hideMemoryTools: false,
        checkpointTimeoutMs: 100,
      },
      daemonUrl: BASE,
      fetchImpl: fetch.fetchImpl,
    });
    const listener = handlerFor(ctx, 'session/event');
    for (const entry of compactionEvents()) listener(session, entry);
    await adapter.flush();
    expect(adapter.getState().checkpoints.committed).toBe(0);
    expect(adapter.getState().checkpoints.failed).toBe(1);
    expect(adapter.getState().compactions[0]).toMatchObject({ compactionId: 'c1', committed: false });
  });

  it('compaction/end 带 error 时不写 checkpoint', async () => {
    const ctx = fakeContext();
    const fetch = installFetch(() => jsonOk({}));
    const session = makeSession();
    const { adapter } = adapterFor({
      ctx,
      config: {
        enabled: true,
        recall: false,
        ingest: false,
        checkpoints: true,
        hideMemoryTools: false,
      },
      daemonUrl: BASE,
      fetchImpl: fetch.fetchImpl,
    });
    const listener = handlerFor(ctx, 'session/event');
    const entries = compactionEvents();
    listener(session, entries[0]);
    listener(session, entries[1]);
    listener(session, entries[2]);
    listener(session, event('compaction/end', 13, { compactionId: 'c1', turn: 1, error: 'summary failed' }));
    await adapter.flush();
    expect(fetch.calls).toHaveLength(0);
    expect(adapter.getState().checkpoints.interrupted).toBe(1);
    expect(adapter.getState().compactions[0]).toMatchObject({ committed: false, error: 'summary failed' });
  });

  it('缺少 replacement 时标记 incomplete，不写 checkpoint', async () => {
    const ctx = fakeContext();
    const fetch = installFetch(() => jsonOk({}));
    const session = makeSession();
    const { adapter } = adapterFor({
      ctx,
      config: {
        enabled: true,
        recall: false,
        ingest: false,
        checkpoints: true,
        hideMemoryTools: false,
      },
      daemonUrl: BASE,
      fetchImpl: fetch.fetchImpl,
    });
    const listener = handlerFor(ctx, 'session/event');
    listener(session, event('compaction/start', 10, { compactionId: 'c1', turn: 1 }));
    listener(session, event('compaction/summary', 11, {
      compactionId: 'c1',
      summary: [{ type: 'text', text: 'summary only' }],
      shadowedRange: { start: 1, end: 2 },
      shadowedSeqs: [1, 2],
      shadowedTokenCount: 10,
      provider: 'p',
      model: 'm',
    }));
    listener(session, event('compaction/end', 12, { compactionId: 'c1', turn: 1 }));
    await adapter.flush();
    expect(fetch.calls).toHaveLength(0);
    expect(adapter.getState().checkpoints.incomplete).toBe(1);
  });
});

describe('@mebular/dsh-plugin memory runtime：工具遮蔽', () => {
  function fakeTools(names) {
    const restrictions = [];
    let denied = new Set();
    return {
      names,
      restrictions,
      root: {
        schemas() {
          return names.map((name) => ({ name }));
        },
      },
      scoped: {
        schemas() {
          return names.filter((name) => !denied.has(name)).map((name) => ({ name }));
        },
        restrict(filter) {
          restrictions.push(filter);
          denied = new Set(filter.deny ?? []);
          return () => {
            denied = new Set();
          };
        },
      },
      get denied() {
        return [...denied];
      },
    };
  }

  it('动态发现 memory_*，保留 task_* 与治理白名单，并在 tools/change 重放', async () => {
    const ctx = fakeContext();
    const tools = fakeTools([
      'mcp__mebular__memory_query',
      'mcp__mebular__memory_write',
      'mcp__mebular__memory_status',
      'mcp__mebular__task_list',
      'mcp__other__tool',
    ]);
    const agent = makeAgent({ tools: tools.scoped });
    ctx.tools = tools.root;
    const { adapter } = adapterFor({
      ctx,
      config: {
        enabled: true,
        recall: false,
        ingest: false,
        checkpoints: false,
        hideMemoryTools: true,
        governanceTools: ['memory_status'],
      },
      fetchImpl: installFetch(() => jsonOk({})).fetchImpl,
    });

    handlerFor(ctx, 'agent/created')({ agent });
    expect(tools.restrictions).toHaveLength(1);
    expect(tools.restrictions[0]).toEqual({
      deny: ['mcp__mebular__memory_query', 'mcp__mebular__memory_write'],
    });

    // Replaying the same tool set does not re-restrict.
    handlerFor(ctx, 'tools/change')();
    await adapter.flush();
    expect(tools.restrictions).toHaveLength(1);

    // A newly discovered tool is added without hardcoding its name.
    tools.names.push('mcp__mebular__memory_new_tool');
    handlerFor(ctx, 'tools/change')();
    await adapter.flush();
    expect(tools.restrictions).toHaveLength(2);
    expect(tools.restrictions[1].deny).toContain('mcp__mebular__memory_new_tool');
    expect(tools.restrictions[1].deny).not.toContain('mcp__mebular__task_list');
    expect(adapter.getState().tools.trackedAgents).toBe(1);
  });

  it('记忆管家 agent 例外；无 memory_* 时不调用 restrict', () => {
    const ctx = fakeContext();
    const tools = fakeTools(['mcp__mebular__memory_query']);
    const butler = makeAgent({ tools: tools.scoped, preset: 'mebular-memory' });
    ctx.tools = tools.root;
    adapterFor({
      ctx,
      config: { enabled: true, recall: false, ingest: false, checkpoints: false, hideMemoryTools: true },
      fetchImpl: installFetch(() => jsonOk({})).fetchImpl,
    });
    handlerFor(ctx, 'agent/created')({ agent: butler });
    expect(tools.restrictions).toHaveLength(0);

    const cleanTools = fakeTools(['mcp__mebular__task_list', 'mcp__other__tool']);
    ctx.tools = cleanTools.root;
    handlerFor(ctx, 'agent/created')({ agent: makeAgent({ id: 'a2', tools: cleanTools.scoped }) });
    expect(cleanTools.restrictions).toHaveLength(0);
  });
});

describe('@mebular/dsh-plugin memory runtime：后台当前模型整理', () => {
  function maintAgent({ session, runMaintenance, status = 'idle' } = {}) {
    const agent = makeAgent({ session });
    agent.status = status;
    if (typeof runMaintenance === 'function') agent.runMaintenance = runMaintenance;
    return agent;
  }

  it('idle 时用 requestHeader().config + ctx.llm 生成候选并交给 /ingest，不传 tools', async () => {
    const ctx = fakeContext();
    const fetch = installFetch(() => jsonOk({ accepted: { chunks: 0, records: 1 } }));
    const streamCalls = [];
    const prepareCalls = [];
    ctx.llm = {
      async prepareCall(config, signal) {
        prepareCalls.push({ config, signal });
        return {
          config: { ...config, maxTokens: Math.min(config.maxTokens, 128) },
          stream(options) {
            streamCalls.push(options);
            return (async function* generate() {
              yield { type: 'text-delta', index: 0, text: '{"candidates":[{"kind":"fact","data":{"subject":"user","predicate":"theme","object":"dark","confidence":0.9}}]}' };
            })();
          },
        };
      },
    };
    const session = makeSession({
      seq: 10,
      events: [
        event('user/message', 1, {
          ...humanMessage('my api_key: sk-super-secret-123 and I prefer dark theme'),
          source: { kind: 'user' },
        }),
        event('assistant/message', 2, {
          message: { role: 'assistant', content: [{ type: 'text', text: 'noted' }] },
        }),
      ],
      requestHeader: {
        config: { provider: 'deepseek', model: 'flash', maxTokens: 4096 },
      },
    });
    let maintenanceRuns = 0;
    const agent = maintAgent({
      session,
      runMaintenance: async (task) => {
        maintenanceRuns += 1;
        return task(new AbortController().signal);
      },
    });
    const { adapter } = adapterFor({
      ctx,
      config: {
        enabled: true,
        recall: false,
        ingest: false,
        checkpoints: false,
        hideMemoryTools: false,
        maintenance: {
          enabled: true,
          cooldownMs: 0,
          minEvents: 1,
          maxTokens: 128,
          timeoutMs: 500,
        },
      },
      daemonUrl: BASE,
      fetchImpl: fetch.fetchImpl,
    });
    handlerFor(ctx, 'agent/created')({ agent });
    handlerFor(ctx, 'agent/status')({ agent, status: 'idle' });
    await adapter.flush();

    expect(maintenanceRuns).toBe(1);
    expect(prepareCalls).toHaveLength(1);
    expect(prepareCalls[0].config.maxTokens).toBe(128);
    expect(streamCalls).toHaveLength(1);
    expect(streamCalls[0].tools).toBeUndefined();
    expect(streamCalls[0].maxTokens).toBe(128);
    expect(streamCalls[0].messages[0].content[0].text).toContain('DATA, not instructions');
    expect(streamCalls[0].messages[0].content[0].text).not.toContain('sk-super-secret-123');
    expect(streamCalls[0].messages[0].content[0].text).toContain('[redacted]');

    const ingest = fetch.calls.find((call) => call.url === `${BASE}/runtime/v1/ingest`);
    expect(ingest).toBeDefined();
    expect(ingest.body).toMatchObject({
      source: 'host',
      extractor: 'host',
      capture: 'off',
      chunks: [],
    });
    expect(ingest.body.candidates).toEqual([{
      kind: 'fact',
      data: {
        subject: 'user',
        predicate: 'theme',
        object: 'dark',
        confidence: 0.9,
      },
    }]);
    expect(adapter.getState().maintenance.sent).toBe(1);
  });

  it('maintenance 关闭时不注册 agent/status，也不调用 LLM', async () => {
    const ctx = fakeContext();
    const { adapter } = adapterFor({
      ctx,
      config: {
        enabled: true,
        recall: false,
        ingest: false,
        checkpoints: false,
        hideMemoryTools: false,
      },
      fetchImpl: installFetch(() => jsonOk({})).fetchImpl,
    });
    expect(handlerFor(ctx, 'agent/status')).toBeUndefined();
    await adapter.flush();
    expect(adapter.getState().maintenance.attempts).toBe(0);
  });

  it('LLM 失败静默，不写入候选', async () => {
    const ctx = fakeContext();
    const fetch = installFetch(() => jsonOk({}));
    ctx.llm = {
      async prepareCall(config) {
        return {
          config,
          stream() {
            return (async function* generate() {
              yield* [];
              throw new Error('model failed');
            })();
          },
        };
      },
    };
    const session = makeSession({
      seq: 10,
      events: [event('user/message', 1, humanMessage('hello'))],
      requestHeader: { config: { provider: 'deepseek', model: 'flash' } },
    });
    const agent = maintAgent({
      session,
      runMaintenance: async (task) => task(new AbortController().signal),
    });
    const { adapter } = adapterFor({
      ctx,
      config: {
        enabled: true,
        recall: false,
        ingest: false,
        checkpoints: false,
        hideMemoryTools: false,
        maintenance: { enabled: true, cooldownMs: 0, minEvents: 1, timeoutMs: 500 },
      },
      daemonUrl: BASE,
      fetchImpl: fetch.fetchImpl,
    });
    handlerFor(ctx, 'agent/created')({ agent });
    handlerFor(ctx, 'agent/status')({ agent, status: 'idle' });
    await expect(adapter.flush()).resolves.toBeUndefined();
    expect(fetch.calls).toHaveLength(0);
    expect(adapter.getState().maintenance.failures).toBe(1);
  });

  it('非法/含密钥的候选不会写入', () => {
    const candidates = parseCandidateOutput(JSON.stringify({
      candidates: [
        { kind: 'fact', data: { subject: 'user', predicate: 'token', object: 'sk-abcdef123456' } },
        { kind: 'nope', data: { content: 'x' } },
        { kind: 'fact', data: { subject: 'user', predicate: 'theme', object: 'dark' } },
      ],
    }));
    expect(candidates).toHaveLength(2);
    expect(candidates[0].data.object).not.toContain('sk-abcdef123456');
    expect(candidates[0].data.object).toBe('[redacted]');
  });
});

describe('@mebular/dsh-plugin memory runtime：Runtime HTTP 认证', () => {
  const authConfig = (extra = {}) => ({
    enabled: true,
    recall: false,
    ingest: true,
    checkpoints: false,
    hideMemoryTools: false,
    ingestFlushMs: 0,
    ingestTimeoutMs: 50,
    ingestRetryBaseMs: 1,
    ...extra,
  });

  function enqueueOne(ctx, adapter) {
    const session = makeSession();
    handlerFor(ctx, 'session/event')(session, event('user/message', 1, humanMessage('hello')));
    return adapter;
  }

  it('配置 token 时发送 Bearer；state 与日志都不包含 token', async () => {
    const ctx = fakeContext();
    const fetch = installFetch(() => jsonOk({}));
    const logs = [];
    const { adapter } = adapterFor({
      ctx,
      config: authConfig({ auth: 'bearer', token: 'config-token-value' }),
      daemonUrl: BASE,
      fetchImpl: fetch.fetchImpl,
      log: (level, message) => logs.push(`${level}:${message}`),
    });
    enqueueOne(ctx, adapter);
    await adapter.flush();

    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0].init.headers.authorization).toBe('Bearer config-token-value');
    const state = adapter.getState();
    expect(state.auth).toMatchObject({
      mode: 'bearer',
      configured: 'bearer',
      tokenPresent: true,
    });
    expect(JSON.stringify(state)).not.toContain('config-token-value');
    expect(logs.join('\n')).not.toContain('config-token-value');
  });

  it('tokenEnv 默认读 MEBULAR_RUNTIME_TOKEN，也支持自定义 env 名', async () => {
    for (const [tokenEnv, env] of [
      [undefined, { MEBULAR_RUNTIME_TOKEN: 'default-env-token' }],
      ['CUSTOM_RUNTIME_TOKEN', { CUSTOM_RUNTIME_TOKEN: 'custom-env-token' }],
    ]) {
      const ctx = fakeContext();
      const fetch = installFetch(() => jsonOk({}));
      const { adapter } = adapterFor({
        ctx,
        config: authConfig({ auth: 'auto', ...(tokenEnv === undefined ? {} : { tokenEnv }) }),
        daemonUrl: BASE,
        fetchImpl: fetch.fetchImpl,
        env,
      });
      enqueueOne(ctx, adapter);
      await adapter.flush();
      expect(fetch.calls[0].init.headers.authorization).toBe(
        `Bearer ${env[tokenEnv ?? 'MEBULAR_RUNTIME_TOKEN']}`,
      );
      expect(JSON.stringify(adapter.getState())).not.toContain(env[tokenEnv ?? 'MEBULAR_RUNTIME_TOKEN']);
    }
  });

  it('auth: none 即使有 token/env 也不发送 Authorization', async () => {
    const ctx = fakeContext();
    const fetch = installFetch(() => jsonOk({}));
    const { adapter } = adapterFor({
      ctx,
      config: authConfig({ auth: 'none', token: 'ignored-token' }),
      daemonUrl: BASE,
      fetchImpl: fetch.fetchImpl,
      env: { MEBULAR_RUNTIME_TOKEN: 'ignored-env-token' },
    });
    enqueueOne(ctx, adapter);
    await adapter.flush();

    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0].init.headers.authorization).toBeUndefined();
    expect(adapter.getState().auth).toMatchObject({
      mode: 'none',
      configured: 'none',
      tokenPresent: false,
    });
  });

  it('无 token 的 auto 模式不发送 Authorization（兼容 runtime auth none）', async () => {
    const ctx = fakeContext();
    const fetch = installFetch(() => jsonOk({}));
    const { adapter } = adapterFor({
      ctx,
      config: authConfig({ auth: 'auto' }),
      daemonUrl: BASE,
      fetchImpl: fetch.fetchImpl,
      env: {},
    });
    enqueueOne(ctx, adapter);
    await adapter.flush();
    expect(fetch.calls[0].init.headers.authorization).toBeUndefined();
    expect(adapter.getState().auth.mode).toBe('none');
  });

  it('bearer 401 不重试，记录 warning/status 且不泄漏 token', async () => {
    const ctx = fakeContext();
    const fetch = installFetch(() => jsonFail(401, 'unauthorized'));
    const logs = [];
    const { adapter } = adapterFor({
      ctx,
      config: authConfig({
        auth: 'bearer',
        token: 'secret-token-never-log',
        ingestRetries: 2,
      }),
      daemonUrl: BASE,
      fetchImpl: fetch.fetchImpl,
      log: (level, message) => logs.push(`${level}:${message}`),
    });
    enqueueOne(ctx, adapter);
    await adapter.flush();

    expect(fetch.calls).toHaveLength(1);
    const state = adapter.getState();
    expect(state.ingest.failed).toBe(1);
    expect(state.ingest.retries).toBe(0);
    expect(state.ingest.lastError).toMatchObject({ code: 'unauthorized', status: 401 });
    expect(state.auth.failures).toBe(1);
    expect(state.auth.lastStatus).toBe(401);
    expect(state.auth.lastCode).toBe('unauthorized');
    expect(state.lastWarning?.code).toContain('unauthorized');
    expect(logs.join('\n')).toContain('unauthorized');
    expect(JSON.stringify(state)).not.toContain('secret-token-never-log');
    expect(logs.join('\n')).not.toContain('secret-token-never-log');
  });

  it('非法 auth/tokenEnv 回退安全默认；空 tokenEnv 禁用 env 读取', async () => {
    const warnings = [];
    const config = resolveMemoryRuntimeConfig({
      enabled: true,
      auth: 'sometimes',
      tokenEnv: 'not a name',
      token: 123,
    }, { warn: (message) => warnings.push(message) });
    expect(config.auth).toBe('auto');
    expect(config.tokenEnv).toBe('MEBULAR_RUNTIME_TOKEN');
    expect(config.token).toBeNull();
    expect(warnings).toHaveLength(3);

    const ctx = fakeContext();
    const fetch = installFetch(() => jsonOk({}));
    const { adapter } = adapterFor({
      ctx,
      config: authConfig({ auth: 'auto', tokenEnv: '' }),
      daemonUrl: BASE,
      fetchImpl: fetch.fetchImpl,
      env: { MEBULAR_RUNTIME_TOKEN: 'must-not-be-read' },
    });
    const session = makeSession();
    handlerFor(ctx, 'session/event')(session, event('user/message', 1, humanMessage('hello')));
    await adapter.flush();
    expect(fetch.calls[0].init.headers.authorization).toBeUndefined();
  });

  it('bearer 缺少 token 时告警但不清空既有功能', async () => {
    const logs = [];
    const ctx = fakeContext();
    const { adapter } = adapterFor({
      ctx,
      config: authConfig({ auth: 'bearer', ingest: false, recall: false, checkpoints: false }),
      fetchImpl: installFetch(() => jsonOk({})).fetchImpl,
      env: {},
      log: (level, message) => logs.push(`${level}:${message}`),
    });
    expect(adapter.getState().auth).toMatchObject({ mode: 'none', configured: 'bearer', tokenPresent: false });
    expect(logs.join('\n')).toContain('no Runtime token');
  });
});

describe('@mebular/dsh-plugin memory runtime：ingest 有界重试', () => {
  function retryConfig(extra = {}) {
    return {
      enabled: true,
      recall: false,
      ingest: true,
      checkpoints: false,
      hideMemoryTools: false,
      ingestBatchSize: 8,
      ingestFlushMs: 0,
      ingestTimeoutMs: 50,
      ingestRetryBaseMs: 1,
      ingestRetries: 2,
      ...extra,
    };
  }

  function emitOne(ctx) {
    const session = makeSession();
    handlerFor(ctx, 'session/event')(session, event('user/message', 1, humanMessage('hello')));
  }

  it('503 后按同 requestId/idempotency-key 重试成功', async () => {
    const ctx = fakeContext();
    const responses = [jsonFail(503, 'runtime_not_ready'), jsonFail(503, 'runtime_not_ready'), jsonOk({})];
    const fetch = installFetch(() => responses.shift() ?? jsonOk({}));
    const { adapter } = adapterFor({
      ctx,
      config: retryConfig(),
      daemonUrl: BASE,
      fetchImpl: fetch.fetchImpl,
    });
    emitOne(ctx);
    await adapter.flush();

    expect(fetch.calls).toHaveLength(3);
    const ids = fetch.calls.map((call) => call.body.requestId);
    const keys = fetch.calls.map((call) => call.init.headers['idempotency-key']);
    expect(new Set(ids).size).toBe(1);
    expect(keys).toEqual(ids);
    expect(ids[0]).toMatch(/^dsh_/);
    const state = adapter.getState();
    expect(state.ingest.retries).toBe(2);
    expect(state.ingest.batches).toBe(3);
    expect(state.ingest.sent).toBe(1);
    expect(state.ingest.failed).toBe(0);
    expect(state.ingest.lastError).toBeNull();
  });

  it('重试耗尽后只记一次 failed，并记录 lastError/exhausted/warning', async () => {
    const ctx = fakeContext();
    const fetch = installFetch(() => jsonFail(503, 'runtime_not_ready'));
    const logs = [];
    const { adapter } = adapterFor({
      ctx,
      config: retryConfig(),
      daemonUrl: BASE,
      fetchImpl: fetch.fetchImpl,
      log: (level, message) => logs.push(`${level}:${message}`),
    });
    emitOne(ctx);
    await adapter.flush();

    expect(fetch.calls).toHaveLength(3);
    const state = adapter.getState();
    expect(state.ingest.failed).toBe(1);
    expect(state.ingest.retries).toBe(2);
    expect(state.ingest.exhausted).toBe(1);
    expect(state.ingest.lastError).toMatchObject({ code: 'runtime_not_ready', status: 503 });
    expect(state.lastWarning?.code).toBe('ingest:runtime_not_ready');
    expect(logs.join('\n')).toContain('runtime_not_ready');
  });

  it('4xx 非重试错误只请求一次', async () => {
    const ctx = fakeContext();
    const fetch = installFetch(() => jsonFail(400, 'invalid_request'));
    const { adapter } = adapterFor({
      ctx,
      config: retryConfig(),
      daemonUrl: BASE,
      fetchImpl: fetch.fetchImpl,
    });
    emitOne(ctx);
    await adapter.flush();
    expect(fetch.calls).toHaveLength(1);
    expect(adapter.getState().ingest.retries).toBe(0);
    expect(adapter.getState().ingest.failed).toBe(1);
  });

  it('dispose 取消退避等待，不等待完整重试预算', async () => {
    const ctx = fakeContext();
    let firstCallResolve;
    const firstCall = new Promise((resolve) => { firstCallResolve = resolve; });
    const fetch = installFetch(() => {
      firstCallResolve();
      return jsonFail(503, 'runtime_not_ready');
    });
    const { adapter } = adapterFor({
      ctx,
      config: retryConfig({ ingestRetryBaseMs: 10_000, disposeTimeoutMs: 100 }),
      daemonUrl: BASE,
      fetchImpl: fetch.fetchImpl,
    });
    emitOne(ctx);
    await firstCall;
    const before = Date.now();
    await adapter.dispose();
    expect(Date.now() - before).toBeLessThan(1000);
    expect(fetch.calls).toHaveLength(1);
    expect(adapter.getState().disposed).toBe(true);
  });
});

describe('@mebular/dsh-plugin memory runtime：纯函数', () => {
  it('buildRecallMessage 无记录返回 null，并限制长度', () => {
    expect(buildRecallMessage([])).toBeNull();
    const message = buildRecallMessage([
      { id: 'm1', type: 'fact', content: 'a'.repeat(100) },
      { id: 'm2', type: 'fact', content: 'b'.repeat(100) },
    ], { maxRecallChars: 400 });
    expect(message).not.toBeNull();
    expect(message.content[0].text.length).toBeLessThanOrEqual(500);
    expect(message.source.kind).toBe(MEMORY_MESSAGE_SOURCE);
  });

  it('redactMemoryText 清理常见密钥形状', () => {
    const text = redactMemoryText('Authorization: Bearer abcdefghijklmnop api_key=sk-secret12345 token: supersecret');
    expect(text).not.toContain('abcdefghijklmnop');
    expect(text).not.toContain('sk-secret12345');
    expect(text).not.toContain('supersecret');
    expect(text).toContain('[redacted]');
  });

  it('模块不 import @mebular/*（HTTP only boundary）', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../../packages/dsh-plugin/memory-runtime.js', import.meta.url), 'utf8');
    expect(source).not.toMatch(/from\s+['"]@mebular\//);
    expect(source).not.toMatch(/require\(['"]@mebular\//);
  });
});
