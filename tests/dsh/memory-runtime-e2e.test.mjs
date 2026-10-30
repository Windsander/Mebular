// DSH memory runtime E2E against a real Cordis context and a fake Runtime HTTP
// server. No model request is made; DSH seams are driven through the same event
// names the host uses (`agent/pre-step`, `session/event`, `agent/created`,
// `tools/change`).

import { Context } from '@deepseek-ai/cordis';
import { afterEach, describe, expect, it } from '@jest/globals';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from '../../packages/dsh-plugin/index.js';
import { MEMORY_MESSAGE_SOURCE } from '../../packages/dsh-plugin/memory-runtime.js';
import { createFakeRuntime } from './e2e/fake-runtime-server.mjs';

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

function makeSession({ id = 's1', surface = { nodes: [1], contentGeneration: 0 }, events = [] } = {}) {
  return {
    id,
    inheritedEventCount: 0,
    firstLiveSeq: 0,
    seq: 10,
    surface,
    ownEvents: () => events,
    isOwnSeq: () => true,
  };
}

function makeAgent({ id = 'a1', session = makeSession(), tools = null } = {}) {
  return {
    id,
    session,
    ctx: tools === null ? {} : { tools },
  };
}

function humanMessage(text, id = 'human-1') {
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  };
}

function sessionEvent(type, seq, data, time = seq) {
  return { type, seq, time, data };
}

async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 20, label = 'condition' } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - started >= timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function startPlugin(runtime, memoryRuntime, extraOptions = {}) {
  const ctx = new Context();
  const memoryRuntimeConfig = memoryRuntime === undefined || memoryRuntime === false
    ? memoryRuntime
    : { url: runtime.sidecarUrl, ...memoryRuntime };
  const config = {
    panel: false,
    daemonUrl: runtime.url,
    ...(memoryRuntime === undefined ? {} : { memoryRuntime: memoryRuntimeConfig }),
  };
  const fiber = ctx.plugin({
    name: '@mebular/dsh-plugin',
    apply: (pluginCtx, pluginConfig) => apply(pluginCtx, pluginConfig, {
      daemonUrl: runtime.url,
      panel: false,
      env: {},
      bridgeIntervalMs: 100_000,
      setIntervalFn: () => ({ unref() {} }),
      clearIntervalFn: () => {},
      ...extraOptions,
    }),
  }, config);
  await fiber;
  cleanups.push(async () => {
    await fiber.dispose();
    await ctx.dispose?.();
  });
  return { ctx, fiber };
}

async function fakeRuntime(options) {
  const runtime = await createFakeRuntime(options);
  cleanups.push(() => runtime.close());
  return runtime;
}

function runtimeRequests(runtime) {
  return runtime.state.requests.filter((request) => request.path.startsWith('/memory-runtime/v1'));
}

describe('@mebular/dsh-plugin memory runtime E2E（真实 Cordis + fake Runtime）', () => {
  it('pre-step 注入 recall，同 surface/query/turn 去重，新 turn 重新召回', async () => {
    const runtime = await fakeRuntime({
      records: [{ id: 'm1', type: 'fact', content: 'user prefers dark theme', why: 'keyword' }],
    });
    const { ctx } = await startPlugin(runtime, {
      enabled: true,
      ingest: false,
      checkpoints: false,
      hideMemoryTools: false,
    });

    const session = makeSession({ surface: { nodes: [1, 2], contentGeneration: 0 } });
    const agent = makeAgent({ session });
    const messages = [humanMessage('what theme should we use?')];
    const payload = {
      agent,
      messages,
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    };
    const fallback = async () => ({ kind: 'enter', messages });

    const first = await ctx.waterfall('agent/pre-step', payload, fallback);
    expect(first.kind).toBe('enter');
    expect(first.messages).toHaveLength(2);
    expect(first.messages[1].source.kind).toBe(MEMORY_MESSAGE_SOURCE);
    expect(first.messages[1].content[0].text).toContain('user prefers dark theme');
    expect(runtime.state.contextCount).toBe(1);

    const second = await ctx.waterfall('agent/pre-step', payload, fallback);
    expect(second.messages).toBe(messages);
    expect(runtime.state.contextCount).toBe(1);

    const nextTurn = await ctx.waterfall('agent/pre-step', { ...payload, turn: 2 }, fallback);
    expect(nextTurn.messages).toHaveLength(2);
    expect(runtime.state.contextCount).toBe(2);

    expect(runtimeRequests(runtime).map((request) => request.path)).toEqual([
      '/memory-runtime/v1/context',
      '/memory-runtime/v1/context',
    ]);
  });

  it('工具遮蔽动态重放：隐藏 memory_*，保留 task_*，tools/change 后补上新工具', async () => {
    const runtime = await fakeRuntime();
    const names = [
      'mcp__mebular__memory_query',
      'mcp__mebular__memory_write',
      'mcp__mebular__task_list',
      'mcp__other__tool',
    ];
    const denies = [];
    let denied = new Set();
    const tools = {
      names,
      denies,
      schemas() {
        return names.map((name) => ({ name }));
      },
      restrict(filter) {
        denies.push(filter.deny);
        denied = new Set(filter.deny ?? []);
        return () => { denied = new Set(); };
      },
    };
    const { ctx } = await startPlugin(runtime, {
      enabled: true,
      recall: false,
      ingest: false,
      checkpoints: false,
      hideMemoryTools: true,
    });

    ctx.emit('agent/created', { agent: makeAgent({ tools }) });
    expect(denies).toHaveLength(1);
    expect(denies[0]).toEqual([
      'mcp__mebular__memory_query',
      'mcp__mebular__memory_write',
    ]);
    expect(denied.has('mcp__mebular__task_list')).toBe(false);
    // `restrict()` is replayed after the suppression microtask clears.
    await Promise.resolve();

    names.push('mcp__mebular__memory_new_tool');
    ctx.emit('tools/change', {});
    await waitFor(() => denies.length === 2, { label: 'tools/change replay' });
    expect(denies[1]).toContain('mcp__mebular__memory_new_tool');
    expect(denies[1]).not.toContain('mcp__mebular__task_list');
  });

  it('compaction start → summary → replacement → end 写入 checkpoint', async () => {
    const runtime = await fakeRuntime();
    const { ctx } = await startPlugin(runtime, {
      enabled: true,
      recall: false,
      ingest: false,
      checkpoints: true,
      hideMemoryTools: false,
    });
    const session = makeSession();
    const events = [
      sessionEvent('compaction/start', 10, { compactionId: 'c1', turn: 1 }),
      sessionEvent('compaction/summary', 11, {
        compactionId: 'c1',
        summary: [{ type: 'text', text: 'the compacted summary' }],
        shadowedRange: { start: 1, end: 9 },
        shadowedSeqs: [1, 2, 3],
        shadowedTokenCount: 120,
        provider: 'fake',
        model: 'no-model',
      }),
      sessionEvent('user/message', 12, {
        id: 'replacement-1',
        role: 'user',
        content: [{ type: 'text', text: 'the compacted summary' }],
        source: { kind: 'compact-checkpoint', compactionId: 'c1' },
      }),
      sessionEvent('compaction/end', 13, { compactionId: 'c1', turn: 1 }),
    ];
    for (const event of events) ctx.emit('session/event', session, event);

    const checkpoint = await waitFor(
      () => runtime.state.checkpoints.find((entry) => entry.committed === true),
      { label: 'checkpoint PUT' },
    );
    expect(checkpoint.threadId).toBe('dsh_s1');
    expect(checkpoint.compactionId).toBe('c1');
    expect(checkpoint.summary).toBe('the compacted summary');
    expect(runtime.state.requests.some((request) => (
      request.method === 'PUT' && request.path === '/memory-runtime/v1/checkpoints/dsh_s1'
    ))).toBe(true);
  });

  it('ingest 重试复用同一 requestId，重复事件只排队一次，服务端可幂等回放', async () => {
    const runtime = await fakeRuntime({ ingestFailTimes: 2, ingestFailureStatus: 503 });
    const { ctx } = await startPlugin(runtime, {
      enabled: true,
      recall: false,
      checkpoints: false,
      hideMemoryTools: false,
      ingestFlushMs: 0,
      ingestRetryBaseMs: 1,
      ingestRetries: 2,
    });
    const session = makeSession();
    const event = sessionEvent('user/message', 3, humanMessage('hello idempotent'));

    ctx.emit('session/event', session, event);
    ctx.emit('session/event', session, event);

    const accepted = await waitFor(
      () => runtime.state.ingests.find((entry) => entry.duplicate === false && entry.chunks === 1),
      { label: 'accepted ingest' },
    );
    const attempts = runtime.state.ingests.filter((entry) => entry.requestId === accepted.requestId);
    expect(attempts).toHaveLength(3);
    expect(attempts.every((entry) => entry.key === accepted.key)).toBe(true);
    expect(accepted.messageIds).toEqual(['s1:3']);

    // Replaying the exact accepted key must not ingest a second time.
    const replay = await fetch(`${runtime.url}/memory-runtime/v1/ingest`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': accepted.key,
      },
      body: JSON.stringify({ requestId: accepted.key, chunks: [] }),
    });
    expect(replay.status).toBe(200);
    expect(runtime.state.ingestDuplicates).toBe(1);
    expect(runtime.state.ingests.filter((entry) => entry.duplicate === false && entry.key === accepted.key)).toHaveLength(1);
  });

  it('auth bearer：配置 token 后所有 Runtime 请求带 Authorization，关闭态零 Runtime 副作用', async () => {
    const runtime = await fakeRuntime({ auth: 'bearer', token: 'dsh-e2e-runtime-token' });
    const { ctx } = await startPlugin(runtime, {
      enabled: true,
      recall: false,
      checkpoints: false,
      hideMemoryTools: false,
      auth: 'bearer',
      token: 'dsh-e2e-runtime-token',
      ingestFlushMs: 0,
    });
    const session = makeSession();
    ctx.emit('session/event', session, sessionEvent('user/message', 1, humanMessage('authorized')));
    await waitFor(() => runtime.state.ingests.length > 0, { label: 'authorized ingest' });

    expect(runtime.state.unauthorized).toBe(0);
    const ingest = runtimeRequests(runtime).find((request) => request.path === '/memory-runtime/v1/ingest');
    expect(ingest.auth).toBe('bearer');
    expect(ingest.authorized).toBe(true);

    // No memoryRuntime: no /memory-runtime/v1 call and no pre-step injection.
    const offRuntime = await fakeRuntime();
    const off = await startPlugin(offRuntime, undefined);
    const messages = [humanMessage('disabled')];
    const decision = await off.ctx.waterfall('agent/pre-step', {
      agent: makeAgent(),
      messages,
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    }, async () => ({ kind: 'enter', messages }));
    expect(decision.messages).toBe(messages);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(runtimeRequests(offRuntime)).toHaveLength(0);
  });

  it('从 <home>/memory-runtime.json 发现 sidecar，并读取 tokenFile', async () => {
    const runtime = await fakeRuntime({
      auth: 'bearer',
      token: 'discovery-e2e-token',
      records: [{ id: 'm1', type: 'fact', content: 'discovery injected fact', why: 'e2e' }],
    });
    const home = await mkdtemp(join(tmpdir(), 'mebular-dsh-memory-runtime-home-'));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const mebularHome = join(home, '.mebular');
    const tokenFile = join(home, 'memory-runtime', 'host-token');
    await mkdir(join(home, 'memory-runtime'), { recursive: true });
    await mkdir(mebularHome, { recursive: true });
    await writeFile(tokenFile, 'discovery-e2e-token', 'utf8');
    await chmod(tokenFile, 0o600);
    await writeFile(join(mebularHome, 'memory-runtime.json'), `${JSON.stringify({
      schema: 1,
      kind: 'mebular-memory-runtime',
      pid: process.pid,
      host: '127.0.0.1',
      port: 0,
      url: runtime.sidecarUrl,
      healthUrl: `${runtime.sidecarUrl}/health`,
      profileId: 'default',
      runtimeVersion: '0.3.0',
      apiVersion: 1,
      capabilityApiVersion: 1,
      state: 'ready',
      degraded: false,
      tokenFile,
      capabilities: { ingest: true, recall: true, context: true, checkpoint: true },
      startedAt: Date.now() - 1000,
      updatedAt: Date.now(),
    })}\n`, 'utf8');

    const { ctx } = await startPlugin(runtime, {
      enabled: true,
      url: null,
      ingest: false,
      checkpoints: false,
      hideMemoryTools: false,
      auth: 'auto',
    }, { userHome: home, env: {} });

    const session = makeSession({ surface: { nodes: [1, 2], contentGeneration: 0 } });
    const agent = makeAgent({ session });
    const messages = [humanMessage('what theme should we use?')];
    const decision = await ctx.waterfall('agent/pre-step', {
      agent,
      messages,
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    }, async () => ({ kind: 'enter', messages }));

    expect(decision.messages).toHaveLength(2);
    expect(decision.messages[1].source.kind).toBe(MEMORY_MESSAGE_SOURCE);
    const request = runtime.state.requests.find((entry) => entry.path === '/memory-runtime/v1/context');
    expect(request).toBeDefined();
    expect(request.auth).toBe('bearer');
    expect(request.authorized).toBe(true);
  });

  it('dispose 前把已排队 ingest flush 出去', async () => {
    const runtime = await fakeRuntime();
    const { ctx, fiber } = await startPlugin(runtime, {
      enabled: true,
      recall: false,
      checkpoints: false,
      hideMemoryTools: false,
      ingestFlushMs: 10_000,
    });
    const session = makeSession();
    ctx.emit('session/event', session, sessionEvent('user/message', 1, humanMessage('flush me')));
    await fiber.dispose();
    expect(runtime.state.ingests.some((entry) => entry.duplicate === false && entry.chunks === 1)).toBe(true);
  });
});
