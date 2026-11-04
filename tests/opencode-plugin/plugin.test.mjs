// OpenCode V2 plugin for Mebular Memory Runtime.
//
// All tests are hermetic: fake ctx, fake fetch and fake session only. No real
// OpenCode, OpenChamber, Mebular runtime or native memory file is touched.

import { afterEach, describe, expect, it } from '@jest/globals';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import plugin, {
  CONTEXT_BLOCK_MAX_BYTES,
  MIN_OPENCODE_VERSION,
  PLUGIN_ID,
  buildContextBlock,
  createController,
  createPlugin,
  detectCapabilities,
  extractLastUserTurn,
  getStatus,
  normalizeRuntimeUrl,
  parseCandidateOutput,
  resolvePluginConfig,
  supportsOpencodeVersion,
} from '../../packages/opencode-plugin/index.js';

const BASE = 'http://127.0.0.1:7331';
const PACKAGE_DIR = fileURLToPath(new URL('../../packages/opencode-plugin/', import.meta.url));
const temporaryDirectories = [];

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    await rm(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

async function tempDir(prefix = 'mebular-opencode-plugin-') {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function jsonResponse(data, options = {}) {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    headers: options.headers ?? {},
    async json() {
      return data;
    },
  };
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

async function waitFor(predicate, { timeoutMs = 2000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  return null;
}

function ingestResponse(body) {
  return {
    ok: true,
    data: {
      accepted: { chunks: Array.isArray(body?.chunks) ? body.chunks.length : 0, records: 0 },
      rawChunkIds: [],
      records: [],
      extraction: { id: 'ext_test', status: 'completed', extractor: body?.extractor ?? 'heuristic', records: [], warnings: [] },
      duplicate: false,
      warnings: [],
    },
  };
}

function createFetch(routes = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/^\/memory-runtime\/v1/, '');
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
    const headers = init.headers ?? {};
    const call = { url, path, method, body, headers };
    calls.push(call);
    const keyed = routes[`${method} ${path}`];
    const handler = keyed ?? routes[path];
    if (typeof handler === 'function') return handler(call);
    if (handler !== undefined) return jsonResponse({ ok: true, data: handler });
    if (path === '/health') {
      return jsonResponse({
        ok: true,
        apiVersion: 1,
        state: 'ready',
        ready: true,
        degraded: false,
        runtimeVersion: '0.3.0',
        capabilityApiVersion: 1,
      });
    }
    if (path === '/status') {
      return jsonResponse({
        ok: true,
        apiVersion: 1,
        data: {
          runtimeVersion: '0.3.0',
          mode: 'immersive',
          state: 'ready',
          degraded: false,
          capabilities: { ingest: true, recall: true, context: true, checkpoint: true, compact: true, self: true },
        },
      });
    }
    if (path === '/ingest') return jsonResponse({ ok: true, data: ingestResponse(body).data });
    if (path === '/context') return jsonResponse({ ok: true, data: { blocks: [] } });
    if (path.startsWith('/checkpoints/')) return jsonResponse({ ok: true, data: { checkpoint: { revision: 1 }, conflict: null } });
    return jsonResponse({ ok: false, error: { code: 'not_found' } }, { ok: false, status: 404 });
  };
  fetchImpl.calls = calls;
  fetchImpl.callsFor = (path) => calls.filter((call) => call.path === path);
  return fetchImpl;
}

function emptyStream(signal) {
  return {
    async *[Symbol.asyncIterator]() {
      while (!signal?.aborted) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 5);
          timer.unref?.();
          signal?.addEventListener?.('abort', () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
        });
      }
      yield undefined;
    },
  };
}

function replayStream(events, signal, options = {}) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        if (signal?.aborted) return;
        yield event;
      }
      if (options.close) return;
      while (!signal?.aborted) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 5);
          timer.unref?.();
          signal?.addEventListener?.('abort', () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
        });
      }
    },
  };
}

function makeCtx(options = {}) {
  const calls = {
    hooks: [],
    hookDisposed: 0,
    toolsAdded: [],
    toolDisposed: 0,
    subscriptions: [],
    prompts: 0,
    synthetics: 0,
    instructions: 0,
    generate: [],
  };
  const contextMessages = options.contextMessages ?? [];
  const ctx = {
    app: { version: options.version ?? '2.2.0' },
    options: options.options ?? {},
    session: {
      ...(options.hook === false ? {} : {
        hook: async (name, callback) => {
          calls.hooks.push({ name, callback });
          return {
            dispose: async () => {
              calls.hookDisposed += 1;
            },
          };
        },
      }),
      ...(options.generate === false ? {} : {
        generate: async (input) => {
          calls.generate.push(input);
          if (options.generateImpl) return options.generateImpl(input);
          return { text: '[]' };
        },
      }),
      context: options.contextSubmit
        ?? (async () => contextMessages),
      prompt: async () => {
        calls.prompts += 1;
        throw new Error('the plugin must not write session history');
      },
      synthetic: async () => {
        calls.synthetics += 1;
        throw new Error('the plugin must not write synthetic messages');
      },
      instructions: {
        entry: {
          put: async () => {
            calls.instructions += 1;
            throw new Error('the plugin must not write instruction entries');
          },
        },
      },
    },
    event: options.events === false ? undefined : {
      subscribe: async (subscribeOptions) => {
        calls.subscriptions.push(subscribeOptions);
        if (typeof options.subscribeImpl === 'function') {
          return options.subscribeImpl(subscribeOptions, calls.subscriptions.length);
        }
        return options.stream ?? emptyStream(subscribeOptions?.signal);
      },
    },
    tool: options.tools === false ? undefined : {
      transform: async (callback) => {
        callback({
          add: (tool) => calls.toolsAdded.push(tool),
          namespace: () => {},
        });
        return {
          dispose: async () => {
            calls.toolDisposed += 1;
          },
        };
      },
    },
  };
  return { ctx, calls };
}

function controllerWith(options = {}) {
  const { ctx, calls } = makeCtx(options.ctx);
  const fetchImpl = options.fetchImpl ?? createFetch(options.routes);
  const controller = createController({
    ctx,
    config: {
      ...(options.useDiscovery ? {} : { runtimeUrl: BASE }),
      bufferIdleMs: 60000,
      ...(options.config ?? {}),
    },
    fetchImpl,
    env: options.env ?? {},
    homeDir: options.homeDir,
    now: options.now,
  });
  return { ctx, calls, fetchImpl, controller };
}

async function writeDiscovery(home, overrides = {}) {
  const tokenFile = overrides.tokenFile ?? join(home, 'memory-runtime', 'host-token');
  await mkdir(join(home, 'memory-runtime'), { recursive: true });
  if (overrides.token !== false) {
    await writeFile(tokenFile, overrides.token ?? 'discovery-host-token', { mode: 0o600 });
  }
  const now = typeof overrides.updatedAt === 'number' ? overrides.updatedAt : Date.now();
  const discovery = {
    schema: 1,
    kind: 'mebular-memory-runtime',
    pid: process.pid,
    host: '127.0.0.1',
    port: 7341,
    url: 'http://127.0.0.1:7341/memory-runtime/v1',
    healthUrl: 'http://127.0.0.1:7341/memory-runtime/v1/health',
    cloudId: null,
    profileId: 'profile-test',
    runtimeVersion: '0.3.0',
    apiVersion: 1,
    capabilityApiVersion: 1,
    minMcpVersion: '0.3.0',
    maxMcpVersion: '0.3.x',
    state: 'ready',
    degraded: false,
    tokenFile,
    startedAt: now - 1000,
    updatedAt: now,
    capabilities: {
      ingest: true,
      recall: true,
      context: true,
      checkpoint: true,
      compact: true,
      self: true,
      models: ['heuristic', 'host'],
    },
    ...overrides.discovery,
  };
  if (overrides.writeFile !== false) {
    await writeFile(join(home, 'memory-runtime.json'), JSON.stringify(discovery), { mode: 0o600 });
  }
  return { tokenFile, discovery };
}

function userMessages(text = 'please use a dark theme') {
  return [{ id: 'u1', role: 'user', content: [{ type: 'text', text }] }];
}

function hookEvent(messages, overrides = {}) {
  return {
    sessionID: 'ses_test',
    agent: 'build',
    messages,
    tools: {
      read: { description: 'read', input: {} },
      mebular_status: { description: 'status', input: {} },
      mebular_recall: { description: 'recall', input: {} },
    },
    system: [],
    options: {},
    ...overrides,
  };
}

const HIT = {
  blocks: [
    { kind: 'memory', content: 'user prefers a dark theme', citations: [{ id: '01JTEST', type: 'fact' }], tokens: 5 },
  ],
  estimatedTokens: 5,
  truncated: false,
  degraded: false,
  warnings: [],
};

describe('@mebular/opencode-plugin package', () => {
  it('has the intended package shape and no Mebular core import', async () => {
    const pkg = JSON.parse(await readFile(join(PACKAGE_DIR, 'package.json'), 'utf8'));
    const source = await readFile(join(PACKAGE_DIR, 'index.js'), 'utf8');
    expect(pkg.name).toBe('@mebular/opencode-plugin');
    expect(pkg.type).toBe('module');
    expect(pkg.main).toBe('index.js');
    expect(pkg.exports['.']).toBe('./index.js');
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(source).not.toMatch(/from ['"]@mebular\//);
    expect(source).not.toContain('openchamber_memory');
    expect(source).not.toContain('instructions.entry.put');
    expect(plugin.id).toBe(PLUGIN_ID);
    expect(typeof plugin.setup).toBe('function');
  });

  it('loads on 2.2.0, registers only its own status tool, and exposes status', async () => {
    const { ctx, calls } = makeCtx({ options: { runtimeUrl: BASE } });
    const definition = createPlugin({ fetchImpl: createFetch(), env: {} });
    const cleanup = await definition.setup(ctx);
    const status = definition.status();
    expect(status.id).toBe(PLUGIN_ID);
    expect(status.enabled).toBe(true);
    expect(status.opencode.supported).toBe(true);
    expect(status.runtime.url).toBe(`${BASE}/memory-runtime/v1`);
    expect(status.runtime.apiVersion).toBe(1);
    expect(status.runtime.tokenConfigured).toBe(false);
    expect(calls.hooks).toHaveLength(1);
    expect(calls.hooks[0].name).toBe('context');
    expect(calls.toolsAdded.map((tool) => tool.name)).toEqual(['mebular_status']);
    expect(calls.toolsAdded.some((tool) => tool.name === 'openchamber_memory')).toBe(false);
    expect(calls.subscriptions).toHaveLength(1);
    expect(getStatus().id).toBe(PLUGIN_ID);
    await cleanup();
    expect(calls.hookDisposed).toBe(1);
    expect(calls.toolDisposed).toBe(1);
  });

  it('disables below 2.2.0, without hooking or fetching', async () => {
    const { ctx, calls } = makeCtx({ version: '2.1.3', options: { runtimeUrl: BASE } });
    const definition = createPlugin();
    const cleanup = await definition.setup(ctx);
    const status = definition.status();
    expect(status.enabled).toBe(false);
    expect(status.reason).toBe('opencode_version_unsupported');
    expect(status.opencode.supported).toBe(false);
    expect(calls.hooks).toHaveLength(0);
    expect(calls.subscriptions).toHaveLength(0);
    await cleanup();
  });

  it('disables when the context hook or runtime URL is missing', async () => {
    const noHook = makeCtx({ hook: false, options: { runtimeUrl: BASE } });
    const noHookDefinition = createPlugin();
    await noHookDefinition.setup(noHook.ctx);
    expect(noHookDefinition.status().reason).toBe('context_hook_missing');

    const noUrl = makeCtx({ options: {} });
    const noUrlDefinition = createPlugin({ fetchImpl: createFetch(), env: {}, homeDir: await tempDir() });
    await noUrlDefinition.setup(noUrl.ctx);
    expect(noUrlDefinition.status().reason).toBe('runtime_not_discovered');
    expect(noUrl.calls.hooks).toHaveLength(0);
  });

  it('reports generate as unavailable without disabling recall/ingest', async () => {
    const { ctx, calls } = makeCtx({ generate: false, options: { runtimeUrl: BASE, modelSource: 'host' } });
    const definition = createPlugin({ fetchImpl: createFetch(), env: {} });
    const cleanup = await definition.setup(ctx);
    const status = definition.status();
    expect(status.enabled).toBe(true);
    expect(status.opencode.capabilities.generate).toBe(false);
    expect(status.model.hostAvailable).toBe(false);
    expect(status.model.reason).toBe('generate_unavailable');
    expect(calls.hooks).toHaveLength(1);
    await cleanup();
  });
});

describe('context hook', () => {
  it('injects nothing when Runtime returns no blocks', async () => {
    const fetchImpl = createFetch({ '/context': { blocks: [] } });
    const { controller } = controllerWith({ fetchImpl, ctx: { contextMessages: userMessages() } });
    const event = hookEvent(userMessages());
    await controller.handleContext(event);
    expect(event.system).toHaveLength(0);
    expect(fetchImpl.callsFor('/context')).toHaveLength(1);
    expect(controller.getStatus().counts.context.empty).toBe(1);
  });

  it('injects one bounded untrusted block on a hit', async () => {
    const fetchImpl = createFetch({ '/context': HIT });
    const { controller } = controllerWith({ fetchImpl, ctx: { contextMessages: userMessages() } });
    const event = hookEvent(userMessages());
    await controller.handleContext(event);
    expect(event.system).toHaveLength(1);
    const text = event.system[0].text;
    expect(text).toContain('<mebular_memory');
    expect(text).toContain('trust="untrusted"');
    expect(text).toContain('user prefers a dark theme');
    expect(text).toContain('</mebular_memory>');
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(CONTEXT_BLOCK_MAX_BYTES);
    expect(fetchImpl.callsFor('/context')[0].body).toMatchObject({
      agentId: 'opencode',
      threadId: 'ses_test',
      query: 'please use a dark theme',
      includeCheckpoint: true,
      includeSelf: true,
    });
  });

  it('only recalls once per user turn and again for a new turn', async () => {
    const fetchImpl = createFetch({ '/context': HIT });
    const { controller } = controllerWith({ fetchImpl });
    const first = hookEvent(userMessages());
    await controller.handleContext(first);
    const continuation = hookEvent(userMessages(), { tools: { read: {}, mebular_status: {} } });
    await controller.handleContext(continuation);
    expect(first.system).toHaveLength(1);
    expect(continuation.system).toHaveLength(0);
    expect(fetchImpl.callsFor('/context')).toHaveLength(1);
    expect(controller.getStatus().counts.context.deduped).toBe(1);

    const secondTurn = hookEvent([
      ...userMessages(),
      { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
      { id: 'u2', role: 'user', content: [{ type: 'text', text: 'now use a light theme' }] },
    ]);
    await controller.handleContext(secondTurn);
    expect(secondTurn.system).toHaveLength(1);
    expect(fetchImpl.callsFor('/context')).toHaveLength(2);
  });

  it('times out without injecting or throwing', async () => {
    const fetchImpl = async () => new Promise(() => {});
    const { controller } = controllerWith({
      fetchImpl,
      config: { recallTimeoutMs: 20 },
    });
    const event = hookEvent(userMessages());
    const started = Date.now();
    await controller.handleContext(event);
    expect(Date.now() - started).toBeLessThan(500);
    expect(event.system).toHaveLength(0);
    expect(controller.getStatus().counts.context.timeouts).toBe(1);
    expect(controller.getStatus().counts.context.failures).toBe(1);
  });

  it('masks every mebular_* tool for ordinary agents and keeps them for governance', async () => {
    const { controller } = controllerWith({});
    const ordinary = hookEvent(userMessages());
    await controller.handleContext(ordinary);
    expect(Object.keys(ordinary.tools)).toEqual(['read']);

    const governance = hookEvent(userMessages(), { agent: 'mebular-governance' });
    await controller.handleContext(governance);
    expect(Object.keys(governance.tools).sort()).toEqual(['mebular_recall', 'mebular_status', 'read']);
    expect(controller.getStatus().counts.tools.maskedTools).toBe(2);
    expect(controller.getStatus().counts.tools.governanceAgents).toBe(1);
  });

  it('never writes session history, synthetic messages, or instruction entries', async () => {
    const fetchImpl = createFetch({ '/context': HIT });
    const made = controllerWith({ fetchImpl, ctx: { contextMessages: userMessages() } });
    const { controller, calls } = made;
    await controller.start();
    const event = hookEvent(userMessages());
    const messagesBefore = JSON.stringify(event.messages);
    await calls.hooks[0].callback(event);
    expect(event.system).toHaveLength(1);
    expect(JSON.stringify(event.messages)).toBe(messagesBefore);
    expect(calls.prompts).toBe(0);
    expect(calls.synthetics).toBe(0);
    expect(calls.instructions).toBe(0);
    await controller.dispose();
  });

  it('does not modify OpenChamber native memory or register its tool', async () => {
    const home = await tempDir();
    const openchamber = join(home, 'openchamber');
    await mkdir(openchamber, { recursive: true });
    const memoryPath = join(openchamber, 'memory.json');
    const settingsPath = join(openchamber, 'settings.json');
    await writeFile(memoryPath, JSON.stringify({ version: 1, entries: [{ id: 'native-1', title: 'native', body: 'keep me' }] }));
    await writeFile(settingsPath, JSON.stringify({ agentMemoryToolEnabled: true }));
    const before = await readFile(memoryPath, 'utf8');

    const fetchImpl = createFetch({ '/context': HIT });
    const { ctx, calls } = makeCtx({ options: { runtimeUrl: BASE }, contextMessages: userMessages() });
    const definition = createPlugin({ fetchImpl, env: {}, homeDir: home });
    const cleanup = await definition.setup(ctx);
    await calls.hooks[0].callback(hookEvent(userMessages()));
    expect(await readFile(memoryPath, 'utf8')).toBe(before);
    expect(calls.instructions).toBe(0);
    expect(calls.prompts).toBe(0);
    expect(calls.toolsAdded.some((tool) => tool.name === 'openchamber_memory')).toBe(false);
    await cleanup();
  });
});

describe('configuration and status', () => {
  it('resolves options over environment over config file, without exposing the token', async () => {
    const home = await tempDir();
    await writeFile(join(home, 'opencode-plugin.json'), JSON.stringify({
      runtimeUrl: 'https://file.example:7331',
      token: 'file-token',
      agentId: 'from-file',
    }));
    const resolved = resolvePluginConfig(
      { token: 'option-token', modelSource: 'current' },
      {
        env: {
          MEBULAR_MEMORY_RUNTIME_URL: 'https://env.example:7331',
          MEBULAR_MEMORY_RUNTIME_TOKEN: 'env-token',
        },
        homeDir: home,
      },
    );
    expect(resolved.runtimeUrl).toBe('https://env.example:7331/memory-runtime/v1');
    expect(resolved.token).toBe('option-token');
    expect(resolved.tokenSource).toBe('options');
    expect(resolved.modelSource).toBe('host');
    expect(resolved.agentId).toBe('from-file');

    const fetchImpl = createFetch({ '/context': HIT });
    const { controller } = controllerWith({ fetchImpl, homeDir: home, env: {
      MEBULAR_MEMORY_RUNTIME_URL: 'https://env.example:7331',
      MEBULAR_MEMORY_RUNTIME_TOKEN: 'env-token',
    } });
    const statusText = JSON.stringify(controller.getStatus());
    expect(statusText).not.toContain('env-token');
    expect(controller.getStatus().runtime.tokenConfigured).toBe(true);
    expect(controller.getStatus().runtime.tokenSource).toBe('env');
    expect(controller.getStatus().model.sourceScope).toBe('opencode-plugin');
    expect(controller.getStatus().model.consoleModelSourceIndependent).toBe(true);
  });

  it('honors a plugin config file when env/options do not set a URL', async () => {
    const home = await tempDir();
    await writeFile(join(home, 'opencode-plugin.json'), JSON.stringify({
      runtimeUrl: 'https://file.example:7331',
      token: 'file-token',
    }));
    const resolved = resolvePluginConfig({}, { env: {}, homeDir: home });
    expect(resolved.runtimeUrl).toBe('https://file.example:7331/memory-runtime/v1');
    expect(resolved.tokenSource).toBe('file');
    expect(resolved.configFileFound).toBe(true);
  });

  it('detects versions and capabilities honestly', () => {
    expect(MIN_OPENCODE_VERSION).toBe('2.2.0');
    expect(supportsOpencodeVersion('2.2.0')).toBe(true);
    expect(supportsOpencodeVersion('2.2.1')).toBe(true);
    expect(supportsOpencodeVersion('2.1.9')).toBe(false);
    expect(supportsOpencodeVersion('')).toBe(false);
    const capabilities = detectCapabilities({
      app: { version: '2.2.0' },
      session: { hook() {}, generate() {} },
      event: { subscribe() {} },
      tool: { transform() {} },
    });
    expect(capabilities).toMatchObject({
      versionSupported: true,
      hook: true,
      generate: true,
      events: true,
      tools: true,
    });
  });
});

describe('request-only context block', () => {
  it('stays within 8 KiB and marks truncation', () => {
    const text = buildContextBlock([
      { kind: 'memory', content: 'x'.repeat(20000), citations: [] },
    ], { maxBytes: 8192 });
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(8192);
    expect(text).toContain('<mebular_memory');
    expect(text).toContain('[truncated]');
    expect(text).toContain('</mebular_memory>');
  });

  it('extracts the last user turn from either message shape', () => {
    expect(extractLastUserTurn([
      { id: 'u1', role: 'user', content: [{ type: 'text', text: 'one' }] },
      { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'two' }] },
      { id: 'u2', type: 'user', text: 'three' },
    ])).toMatchObject({ id: 'u2', text: 'three' });
    expect(extractLastUserTurn([
      { id: 'u3', role: 'user', content: JSON.stringify([{ type: 'text', text: '  quoted content  ' }]) },
    ])).toMatchObject({ id: 'u3', text: 'quoted content' });
    expect(extractLastUserTurn([
      { id: 'u4', role: 'user', content: JSON.stringify('  json string content  ') },
    ])).toMatchObject({ id: 'u4', text: 'json string content' });
    expect(extractLastUserTurn([
      { id: 'u5', role: 'user', content: JSON.stringify([{ type: 'text', text: JSON.stringify('nested string') }]) },
    ])).toMatchObject({ id: 'u5', text: 'nested string' });
    expect(extractLastUserTurn([])).toBeNull();
  });
});

describe('ingest and compaction', () => {
  it('captures a completed turn idempotently', async () => {
    const fetchImpl = createFetch();
    const messages = [
      { id: 'u1', type: 'user', text: 'please remember the dark theme' },
      { id: 'a1', type: 'assistant', content: [{ type: 'text', text: 'Noted.' }] },
    ];
    const { controller } = controllerWith({
      fetchImpl,
      ctx: { contextMessages: messages },
    });
    await controller.handleEvent({
      type: 'session.text.ended',
      data: { sessionID: 'ses_1', assistantMessageID: 'a1', ordinal: 0, text: 'Noted.' },
    });
    await controller.handleEvent({ type: 'session.execution.succeeded', data: { sessionID: 'ses_1' } });
    const ingestCalls = fetchImpl.callsFor('/ingest');
    expect(ingestCalls).toHaveLength(1);
    expect(ingestCalls[0].body.extractor).toBe('heuristic');
    expect(ingestCalls[0].body.chunks.map((chunk) => chunk.role)).toEqual(['user', 'assistant']);
    expect(ingestCalls[0].body.requestId).toMatch(/^opc_[0-9a-f]{48}$/);
    expect(ingestCalls[0].headers['idempotency-key']).toBe(ingestCalls[0].body.requestId);
    expect(ingestCalls[0].body).not.toHaveProperty('capture');

    await controller.handleEvent({
      type: 'session.text.ended',
      data: { sessionID: 'ses_1', assistantMessageID: 'a1', ordinal: 0, text: 'Noted.' },
    });
    await controller.handleEvent({ type: 'session.execution.succeeded', data: { sessionID: 'ses_1' } });
    expect(fetchImpl.callsFor('/ingest')).toHaveLength(1);
  });

  it('captures the user message from the context hook when session.context is unavailable', async () => {
    const fetchImpl = createFetch({ '/context': { blocks: [] } });
    const { controller } = controllerWith({
      fetchImpl,
      ctx: { contextMessages: [] },
    });
    const event = hookEvent(userMessages('remember this preference'));
    await controller.handleContext(event);
    await controller.handleEvent({ type: 'session.execution.succeeded', data: { sessionID: 'ses_test' } });
    const ingest = fetchImpl.callsFor('/ingest');
    expect(ingest).toHaveLength(1);
    expect(ingest[0].body.chunks.map((chunk) => chunk.role)).toEqual(['user']);
    expect(ingest[0].body.chunks[0].text).toBe('remember this preference');
  });

  it('ignores assistant-only buffers, including transient generate text', async () => {
    const fetchImpl = createFetch();
    const { controller } = controllerWith({ fetchImpl });
    await controller.handleEvent({
      type: 'session.text.ended',
      data: { sessionID: 'ses_1', assistantMessageID: 'a1', ordinal: 0, text: 'transient text' },
    });
    await controller.handleEvent({ type: 'session.execution.succeeded', data: { sessionID: 'ses_1' } });
    expect(fetchImpl.callsFor('/ingest')).toHaveLength(0);
  });

  it('captures tool name, input and result', async () => {
    const fetchImpl = createFetch();
    const { controller } = controllerWith({
      fetchImpl,
      ctx: { contextMessages: [{ id: 'u1', type: 'user', text: 'read the file' }] },
    });
    await controller.handleEvent({
      type: 'session.tool.input.started',
      data: { sessionID: 'ses_1', assistantMessageID: 'a1', id: 't1', name: 'read' },
    });
    await controller.handleEvent({
      type: 'session.tool.called',
      data: { sessionID: 'ses_1', assistantMessageID: 'a1', id: 't1', input: { path: 'notes.md' } },
    });
    await controller.handleEvent({
      type: 'session.tool.success',
      data: {
        sessionID: 'ses_1',
        assistantMessageID: 'a1',
        id: 't1',
        content: [{ type: 'text', text: 'file body' }],
      },
    });
    await controller.handleEvent({ type: 'session.execution.succeeded', data: { sessionID: 'ses_1' } });
    const toolChunk = fetchImpl.callsFor('/ingest')[0].body.chunks.find((chunk) => chunk.role === 'tool');
    expect(toolChunk.text).toContain('tool read');
    expect(toolChunk.text).toContain('notes.md');
    expect(toolChunk.text).toContain('file body');
  });

  it('ingests a compaction summary and registers a checkpoint', async () => {
    const fetchImpl = createFetch();
    const { controller } = controllerWith({ fetchImpl });
    await controller.handleEvent({
      id: 'evt_compact_1',
      type: 'session.compaction.ended',
      data: {
        sessionID: 'ses_1',
        reason: 'auto',
        text: 'The task moved from design to implementation.',
        model: { providerID: 'anthropic', id: 'claude' },
      },
    });
    const ingest = fetchImpl.callsFor('/ingest');
    expect(ingest).toHaveLength(1);
    expect(ingest[0].body.chunks[0]).toMatchObject({ role: 'system' });
    expect(ingest[0].body.chunks[0].text).toContain('compaction');
    const checkpoint = fetchImpl.callsFor('/checkpoints/ses_1').filter((call) => call.method === 'PUT');
    expect(checkpoint).toHaveLength(1);
    expect(checkpoint[0].method).toBe('PUT');
    expect(checkpoint[0].body).toMatchObject({
      agentId: 'opencode',
      threadId: 'ses_1',
      domain: 'task:ses_1',
      actor: { type: 'agent', agentId: 'opencode' },
      summary: 'The task moved from design to implementation.',
      state: { kind: 'compaction', reason: 'auto', schema: 2, contentMode: 'summary_only' },
    });
    expect(checkpoint[0].body.sync).toBeUndefined();
    expect(controller.getStatus().counts.checkpoints.sent).toBe(1);
  });

  it('parses structured compaction headings into schema 2 checkpoint fields', async () => {
    const fetchImpl = createFetch();
    const { controller } = controllerWith({ fetchImpl });
    const summary = [
      '## Objective',
      'Ship OpenCode structured checkpoints.',
      '## Requirements',
      '- Keep schema 2',
      '## Decisions',
      '- Reuse sidecar checkpoint — no new endpoint',
      '## Work State',
      '- Done: event wired',
      '- Doing: parser',
      '- Blocked: none',
      '## Next Move',
      '- Verify next turn context',
      '## Relevant Files',
      '- packages/opencode-plugin/index.js (write, in_progress)',
    ].join('\n');
    await controller.handleEvent({
      id: 'evt_compact_2',
      type: 'session.compaction.ended',
      data: {
        sessionID: 'ses_1',
        reason: 'manual',
        text: summary,
        messageCount: 7,
      },
    });
    const checkpoint = fetchImpl.callsFor('/checkpoints/ses_1').filter((call) => call.method === 'PUT');
    expect(checkpoint).toHaveLength(1);
    expect(checkpoint[0].body.state).toMatchObject({
      schema: 2,
      contentMode: 'structured',
      task: { key: 'task:ses_1', threadId: 'ses_1', fleetTaskId: null },
      goal: 'Ship OpenCode structured checkpoints.',
      nextSteps: [{ text: 'Verify next turn context' }],
      progress: {
        done: [{ text: 'event wired' }],
        doing: [{ text: 'parser' }],
        blocked: [],
      },
    });
    expect(checkpoint[0].body.state.constraints[0]).toMatchObject({ text: 'Keep schema 2', source: 'compaction_summary' });
  });

  it('does not block or throw when ingest fails', async () => {
    const fetchImpl = createFetch({
      '/ingest': () => jsonResponse({ ok: false, error: { code: 'runtime_not_ready' } }, { ok: false, status: 503 }),
    });
    const { controller } = controllerWith({
      fetchImpl,
      ctx: { contextMessages: [{ id: 'u1', type: 'user', text: 'hello' }] },
    });
    await expect(controller.handleEvent({ type: 'session.execution.succeeded', data: { sessionID: 'ses_1' } })).resolves.toBeUndefined();
    expect(controller.getStatus().counts.ingest.failed).toBe(1);
  });

  it('separates committed, failed-extraction, pending and queued ingest outcomes', async () => {
    const fetchImpl = createFetch({
      '/ingest': (call) => {
        const threadId = call.body?.threadId;
        if (threadId === 'ses_m1_failed') {
          return jsonResponse({
            ok: true,
            data: {
              accepted: { chunks: 1, records: 0 },
              records: [],
              queued: false,
              extraction: { id: 'ex_failed', status: 'failed', extractor: 'heuristic', records: [], warnings: ['extract_failed'] },
            },
          });
        }
        if (threadId === 'ses_m1_pending') {
          return jsonResponse({
            ok: true,
            data: {
              accepted: { chunks: 1, records: 0 },
              records: [],
              queued: false,
              extraction: { id: 'ex_pending', status: 'pending', extractor: 'heuristic', records: [], warnings: [] },
            },
          });
        }
        if (threadId === 'ses_m1_queued') {
          return jsonResponse({
            ok: true,
            data: {
              accepted: { chunks: 1, records: 0 },
              records: [],
              queued: true,
              extraction: { id: 'ex_queued', status: 'pending', extractor: 'heuristic', records: [], warnings: [] },
            },
          }, { status: 202 });
        }
        return jsonResponse({
          ok: true,
          data: {
            accepted: { chunks: 1, records: 0 },
            records: [],
            queued: false,
            extraction: { id: 'ex_done', status: 'completed', extractor: 'heuristic', records: [], warnings: [] },
          },
        });
      },
    });
    const { controller } = controllerWith({
      fetchImpl,
      ctx: { contextMessages: [{ id: 'u1', type: 'user', text: 'ingest dimension test' }] },
    });
    for (const sessionID of ['ses_m1_failed', 'ses_m1_pending', 'ses_m1_queued', 'ses_m1_completed']) {
      await controller.handleEvent({ type: 'session.execution.succeeded', data: { sessionID } });
    }
    const status = controller.getStatus();
    expect(status.counts.ingest.accepted).toBe(4);
    expect(status.counts.ingest.failedExtraction).toBe(1);
    expect(status.counts.ingest.pending).toBe(1);
    expect(status.counts.ingest.queued).toBe(1);
    expect(status.counts.ingest.committed).toBe(1);
    expect(status.ingest).toMatchObject({
      failedExtraction: 1,
      pending: 1,
      queued: 1,
      committed: 1,
    });
  });

  it('honors Retry-After for one bounded 429 ingest retry', async () => {
    const times = [];
    const fetchImpl = createFetch({
      '/ingest': () => {
        times.push(Date.now());
        return jsonResponse(
          { ok: false, error: { code: 'rate_limited' } },
          { ok: false, status: 429, headers: { 'retry-after': '0.05' } },
        );
      },
    });
    const { controller } = controllerWith({
      fetchImpl,
      config: { maxRetryAfterMs: 1000 },
      ctx: { contextMessages: [{ id: 'u1', type: 'user', text: 'hello 429' }] },
    });
    await controller.handleEvent({ type: 'session.execution.succeeded', data: { sessionID: 'ses_429' } });
    const ingest = fetchImpl.callsFor('/ingest');
    expect(ingest).toHaveLength(2);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(35);
    expect(controller.getStatus().counts.ingest.failed).toBe(1);
    expect(controller.getStatus().counts.ingest.sent).toBe(0);
  });

  it('records explicit Retry-After truncation instead of silently shortening it', async () => {
    const times = [];
    const fetchImpl = createFetch({
      '/ingest': () => {
        times.push(Date.now());
        return jsonResponse(
          { ok: false, error: { code: 'rate_limited' } },
          { ok: false, status: 429, headers: { 'retry-after': '120' } },
        );
      },
    });
    const { controller } = controllerWith({
      fetchImpl,
      config: { maxRetryAfterMs: 30 },
      ctx: { contextMessages: [{ id: 'u1', type: 'user', text: 'long retry-after' }] },
    });
    await controller.handleEvent({ type: 'session.execution.succeeded', data: { sessionID: 'ses_retry_long' } });
    expect(fetchImpl.callsFor('/ingest')).toHaveLength(2);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(20);
    expect(controller.getStatus().counts.ingest.retryAfterTruncated).toBe(1);
    expect(controller.getStatus().lastWarning).toMatchObject({ code: 'retry_after_truncated' });
  });
});

describe('current model extraction (host/current)', () => {
  it('is not called by default', async () => {
    const { ctx, calls, fetchImpl, controller } = controllerWith({
      ctx: {
        contextMessages: [
          { id: 'u1', type: 'user', text: 'remember this preference' },
          { id: 'a1', type: 'assistant', content: [{ type: 'text', text: 'Sure.' }] },
        ],
      },
    });
    await controller.handleEvent({ type: 'session.execution.succeeded', data: { sessionID: 'ses_1' } });
    expect(calls.generate).toHaveLength(0);
    expect(fetchImpl.callsFor('/ingest')[0].body.extractor).toBe('heuristic');
    expect(ctx.session.generate).toBeDefined();
  });

  it('uses ctx.session.generate only when host/current is selected and posts candidates', async () => {
    const { calls, fetchImpl, controller } = controllerWith({
      config: { modelSource: 'host' },
      ctx: {
        contextMessages: [
          { id: 'u1', type: 'user', text: 'I prefer dark mode in the editor' },
          { id: 'a1', type: 'assistant', content: [{ type: 'text', text: 'Understood.' }] },
        ],
        generateImpl: async () => ({
          text: JSON.stringify([{
            kind: 'preference',
            data: { entity: 'user', preferenceType: 'theme', value: 'dark', confidence: 0.9 },
            tags: ['ui'],
          }]),
        }),
      },
    });
    expect(controller.getStatus().model.hostAvailable).toBe(true);
    await controller.handleEvent({ type: 'session.execution.succeeded', data: { sessionID: 'ses_1' } });
    expect(calls.generate).toHaveLength(1);
    expect(calls.generate[0].sessionID).toBe('ses_1');
    expect(calls.generate[0].prompt).toContain('TRANSCRIPT');
    const ingest = fetchImpl.callsFor('/ingest');
    expect(ingest).toHaveLength(1);
    expect(ingest[0].body.extractor).toBe('host');
    expect(ingest[0].body.candidates).toHaveLength(1);
    expect(ingest[0].body.candidates[0]).toMatchObject({ kind: 'preference', data: { value: 'dark' } });
    expect(controller.getStatus().model.succeeded).toBe(1);
  });

  it('falls back to heuristic when session.generate fails', async () => {
    const { calls, fetchImpl, controller } = controllerWith({
      config: { modelSource: 'host' },
      ctx: {
        contextMessages: [
          { id: 'u1', type: 'user', text: 'This preference should survive a model failure' },
          { id: 'a1', type: 'assistant', content: [{ type: 'text', text: 'Okay.' }] },
        ],
        generateImpl: async () => {
          throw new Error('provider unavailable');
        },
      },
    });
    await controller.handleEvent({ type: 'session.execution.succeeded', data: { sessionID: 'ses_1' } });
    expect(calls.generate).toHaveLength(1);
    const ingest = fetchImpl.callsFor('/ingest');
    expect(ingest).toHaveLength(1);
    expect(ingest[0].body.extractor).toBe('heuristic');
    expect(ingest[0].body.candidates).toBeUndefined();
    expect(controller.getStatus().model.failed).toBe(1);
    expect(controller.getStatus().model.fallbacks).toBe(1);
  });

  it('falls back when model output has no usable candidates', async () => {
    const { fetchImpl, controller } = controllerWith({
      config: { modelSource: 'host' },
      ctx: {
        contextMessages: [
          { id: 'u1', type: 'user', text: 'Nothing durable happened here' },
          { id: 'a1', type: 'assistant', content: [{ type: 'text', text: 'Fine.' }] },
        ],
        generateImpl: async () => ({ text: '[]' }),
      },
    });
    await controller.handleEvent({ type: 'session.execution.succeeded', data: { sessionID: 'ses_1' } });
    expect(fetchImpl.callsFor('/ingest')[0].body.extractor).toBe('heuristic');
    expect(controller.getStatus().model.fallbacks).toBe(1);
  });

  it('does not call generate when the capability is unavailable', async () => {
    const { calls, fetchImpl, controller } = controllerWith({
      config: { modelSource: 'host' },
      ctx: {
        generate: false,
        contextMessages: [
          { id: 'u1', type: 'user', text: 'remember this' },
          { id: 'a1', type: 'assistant', content: [{ type: 'text', text: 'ok' }] },
        ],
      },
    });
    await controller.handleEvent({ type: 'session.execution.succeeded', data: { sessionID: 'ses_1' } });
    expect(calls.generate).toHaveLength(0);
    expect(controller.getStatus().model.hostAvailable).toBe(false);
    expect(fetchImpl.callsFor('/ingest')[0].body.extractor).toBe('heuristic');
  });

  it('parses fenced JSON and drops invalid candidates', () => {
    const candidates = parseCandidateOutput([
      '```json',
      JSON.stringify([
        { kind: 'fact', data: { subject: 'user', predicate: 'likes', object: 'dark mode' } },
        { kind: 'fact', data: { subject: '', predicate: 'x', object: 'y' } },
        { kind: 'not-a-kind', data: { content: 'x' } },
      ]),
      '```',
    ].join('\n'));
    expect(candidates).toHaveLength(1);
    expect(candidates[0].data.object).toBe('dark mode');
  });
});

describe('sidecar discovery and host authentication', () => {
  it('ignores legacy enabled/capture fields and warns', () => {
    const config = resolvePluginConfig({
      runtimeUrl: BASE,
      enabled: false,
      capture: 'off',
      ingest: false,
    }, { env: {} });
    expect(config).not.toHaveProperty('enabled');
    expect(config).not.toHaveProperty('capture');
    expect(config.ingest).toBe(false);
    expect(config.warnings).toContain('legacy_enabled_ignored');
    expect(config.warnings).toContain('legacy_capture_ignored');
  });

  it('makes domain and recallLimit real context request fields', async () => {
    const fetchImpl = createFetch({ '/context': { blocks: [] } });
    const { controller } = controllerWith({
      fetchImpl,
      config: { domain: 'task:ses_cfg', recallLimit: 5 },
    });
    await controller.handleContext(hookEvent(userMessages()));
    const body = fetchImpl.callsFor('/context')[0].body;
    expect(body.domains).toEqual(['task:ses_cfg']);
    expect(body.limit).toBe(5);

    const fromEnv = resolvePluginConfig(
      { runtimeUrl: BASE, recallLimit: 4 },
      { env: { MEBULAR_MEMORY_RUNTIME_DOMAIN: 'user' }, homeDir: await tempDir() },
    );
    expect(fromEnv.domains).toContain('user');
    expect(fromEnv.recallLimit).toBe(4);

    const invalidModel = resolvePluginConfig(
      { runtimeUrl: BASE, modelSource: 'console' },
      { env: {}, homeDir: await tempDir() },
    );
    expect(invalidModel.modelSource).toBe('heuristic');
    expect(invalidModel.warnings).toContain('model_source_invalid');
  });

  it('follows discovery appearing after startup without a host-level enabled switch', async () => {
    const home = await tempDir();
    const fetchImpl = createFetch({ '/context': HIT });
    const { ctx, calls } = makeCtx();
    const controller = createController({
      ctx,
      config: { bufferIdleMs: 60000 },
      fetchImpl,
      env: {},
      homeDir: home,
    });
    await controller.start();
    expect(controller.getStatus().enabled).toBe(false);
    expect(controller.getStatus().reason).toBe('runtime_not_discovered');
    expect(fetchImpl.calls).toHaveLength(0);
    expect(calls.hooks).toHaveLength(0);

    await writeDiscovery(home);
    const event = hookEvent(userMessages());
    await controller.handleContext(event);
    expect(event.system).toHaveLength(1);
    expect(controller.getStatus().enabled).toBe(true);
    expect(fetchImpl.callsFor('/context')).toHaveLength(1);
    await controller.dispose();
  });

  it('does not fetch when discovery is absent (light MCP)', async () => {
    const home = await tempDir();
    const fetchImpl = createFetch();
    const { ctx } = makeCtx();
    const controller = createController({ ctx, config: {}, fetchImpl, env: {}, homeDir: home });
    await controller.start();
    await controller.handleContext(hookEvent(userMessages()));
    expect(fetchImpl.calls).toHaveLength(0);
    expect(controller.getStatus().enabled).toBe(false);
    expect(controller.getStatus().reason).toBe('runtime_not_discovered');
    await controller.dispose();
  });

  it('discovers URL and host token from <home>/memory-runtime.json', async () => {
    const home = await tempDir();
    await writeDiscovery(home);
    const resolved = resolvePluginConfig({}, { env: {}, homeDir: home });
    expect(resolved.runtimeUrl).toBe('http://127.0.0.1:7341/memory-runtime/v1');
    expect(resolved.token).toBe('discovery-host-token');
    expect(resolved.tokenSource).toBe('tokenFile');
    expect(resolved.discoveryFound).toBe(true);
    expect(resolved.discoveryState).toBe('ready');

    const fetchImpl = createFetch({ '/context': HIT });
    const { controller, calls } = controllerWith({
      fetchImpl,
      homeDir: home,
      useDiscovery: true,
    });
    await controller.start();
    const status = controller.getStatus();
    expect(status.enabled).toBe(true);
    expect(status.runtime.discovered).toBe(true);
    expect(status.runtime.tokenConfigured).toBe(true);
    expect(status.runtime.tokenSource).toBe('tokenFile');
    expect(JSON.stringify(status)).not.toContain('discovery-host-token');
    expect(calls.hooks).toHaveLength(1);

    const event = hookEvent(userMessages());
    await controller.handleContext(event);
    expect(event.system).toHaveLength(1);
    expect(fetchImpl.callsFor('/status')[0].headers.authorization).toBe('Bearer discovery-host-token');
    await controller.dispose();
  });

  it('reads the sidecar JSON host-token record from tokenFile', async () => {
    const home = await tempDir();
    await writeDiscovery(home, {
      token: JSON.stringify({
        version: 1,
        token: 'json-record-token',
        issuedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      }),
    });
    const resolved = resolvePluginConfig({}, { env: {}, homeDir: home });
    expect(resolved.token).toBe('json-record-token');
    expect(resolved.tokenSource).toBe('tokenFile');
  });

  it('rejects stale discovery instead of guessing a port', async () => {
    const home = await tempDir();
    await writeDiscovery(home, { updatedAt: Date.now() - 16_000 });
    const resolved = resolvePluginConfig({}, { env: {}, homeDir: home });
    expect(resolved.runtimeUrl).toBe('');
    expect(resolved.discoveryError).toBe('runtime_discovery_stale');
    const { controller, calls } = controllerWith({
      fetchImpl: createFetch(),
      homeDir: home,
      useDiscovery: true,
    });
    await controller.start();
    expect(controller.getStatus().enabled).toBe(false);
    expect(controller.getStatus().reason).toBe('runtime_discovery_stale');
    expect(calls.hooks).toHaveLength(0);
  });

  (process.platform === 'win32' ? it.skip : it)('rejects a token file readable by group/other', async () => {
    const home = await tempDir();
    const { tokenFile } = await writeDiscovery(home);
    await chmod(tokenFile, 0o644);
    const resolved = resolvePluginConfig({}, { env: {}, homeDir: home });
    expect(resolved.token).toBe('');
    expect(resolved.tokenError).toBe('token_file_insecure');
    const { controller, calls } = controllerWith({
      fetchImpl: createFetch(),
      homeDir: home,
      useDiscovery: true,
    });
    await controller.start();
    expect(controller.getStatus().enabled).toBe(false);
    expect(controller.getStatus().reason).toBe('token_file_insecure');
    expect(calls.hooks).toHaveLength(0);
  });

  it('prefers explicit runtimeUrl over discovered URL and token file', async () => {
    const home = await tempDir();
    await writeDiscovery(home);
    const resolved = resolvePluginConfig(
      { runtimeUrl: 'https://explicit.example:9000', token: 'option-token' },
      { env: {}, homeDir: home },
    );
    expect(resolved.runtimeUrl).toBe('https://explicit.example:9000/memory-runtime/v1');
    expect(resolved.token).toBe('option-token');
    expect(resolved.tokenSource).toBe('options');
  });

  it('normalizes the host API base and rejects legacy/insecure URLs', () => {
    expect(normalizeRuntimeUrl('http://127.0.0.1:7341')).toEqual({
      url: 'http://127.0.0.1:7341/memory-runtime/v1',
      reason: null,
    });
    expect(normalizeRuntimeUrl('http://127.0.0.1:7341/memory-runtime/v1/')).toEqual({
      url: 'http://127.0.0.1:7341/memory-runtime/v1',
      reason: null,
    });
    expect(normalizeRuntimeUrl('http://127.0.0.1:7341/runtime/v1').reason).toBe('runtime_url_legacy');
    expect(normalizeRuntimeUrl('http://example.com:7341').reason).toBe('runtime_insecure_url');
    expect(normalizeRuntimeUrl('https://example.com:7341').url).toBe('https://example.com:7341/memory-runtime/v1');
    expect(normalizeRuntimeUrl('http://127.0.0.1:7341?token=x').reason).toBe('runtime_url_invalid');
  });

  it('disables when the sidecar rejects the host token', async () => {
    const fetchImpl = createFetch({
      '/status': () => jsonResponse({ ok: false, error: { code: 'unauthorized' } }, { ok: false, status: 401 }),
    });
    const { controller, calls } = controllerWith({ fetchImpl });
    await controller.start();
    expect(controller.getStatus().enabled).toBe(false);
    expect(controller.getStatus().reason).toBe('runtime_unauthorized');
    expect(calls.hooks).toHaveLength(0);
  });

  it('disables when the sidecar API version is incompatible', async () => {
    const fetchImpl = createFetch({
      '/health': () => jsonResponse({
        ok: true,
        apiVersion: 2,
        state: 'ready',
        ready: true,
        runtimeVersion: '9.0.0',
      }),
    });
    const { controller, calls } = controllerWith({ fetchImpl });
    await controller.start();
    expect(controller.getStatus().enabled).toBe(false);
    expect(controller.getStatus().reason).toBe('runtime_api_unsupported');
    expect(calls.hooks).toHaveLength(0);
  });

  it('keeps ingest but disables recall when /context capability is missing', async () => {
    const fetchImpl = createFetch({
      '/status': {
        runtimeVersion: '0.3.0',
        mode: 'immersive',
        capabilities: { ingest: true, context: false, checkpoint: false },
      },
    });
    const { controller } = controllerWith({ fetchImpl });
    await controller.start();
    const status = controller.getStatus();
    expect(status.enabled).toBe(true);
    expect(status.features.recall).toBe(false);
    expect(status.features.ingest).toBe(true);
    expect(status.recallReason).toBe('runtime_capability_missing');
    await controller.handleContext(hookEvent(userMessages()));
    expect(fetchImpl.callsFor('/context')).toHaveLength(0);
    await controller.dispose();
  });

  it('reports unreachable sidecar without registering the context hook', async () => {
    const fetchImpl = async () => {
      throw new Error('connection refused');
    };
    const { controller, calls } = controllerWith({ fetchImpl });
    await controller.start();
    expect(controller.getStatus().enabled).toBe(false);
    expect(controller.getStatus().reason).toBe('runtime_unreachable');
    expect(calls.hooks).toHaveLength(0);
  });
});

describe('fragmented context contract', () => {
  const FRAGMENT_HIT = {
    recallId: 'rr_01JTEST',
    fragments: [
      {
        id: 'mf_01JTEST',
        kind: 'skill',
        gist: '部署命令：pnpm release --tag 0.3.0',
        owner: { role: 'agent', domain: 'agent:opencode', agentId: 'opencode' },
        confidence: 0.86,
        citations: [{ id: '01JREC', type: 'skill' }],
      },
    ],
    blocks: [
      {
        kind: 'fragment',
        content: '[F1] kind=skill owner=agent:opencode confidence=0.86 citation=01JREC\ngist: 部署命令：pnpm release --tag 0.3.0',
        citations: [{ id: '01JREC', type: 'skill' }],
        fragments: ['mf_01JTEST'],
      },
    ],
    truncated: false,
    degraded: false,
    warnings: [],
    silenceReason: null,
    traceId: 'tr_01JTEST',
  };

  it('injects fragmented blocks with actor, turn id and byte budget', async () => {
    const fetchImpl = createFetch({ '/context': FRAGMENT_HIT });
    const { controller, calls } = controllerWith({ fetchImpl });
    const event = hookEvent(userMessages());
    await controller.handleContext(event);
    expect(event.system).toHaveLength(1);
    const text = event.system[0].text;
    expect(text).toContain('<mebular_memory version="1"');
    expect(text).toContain('recall_id="rr_01JTEST"');
    expect(text).toContain('trust="untrusted"');
    expect(text).toContain('[F1]');
    expect(event.system[0].metadata).toEqual({ source: 'mebular', trust: 'untrusted', requestOnly: true });
    const body = fetchImpl.callsFor('/context')[0].body;
    expect(body).toMatchObject({
      actor: { type: 'agent', agentId: 'opencode' },
      agentId: 'opencode',
      threadId: 'ses_test',
      turnId: 'u1',
      turnKind: 'human',
      includeCheckpoint: true,
      includeSelf: true,
      maxBytes: 8192,
      maxFragments: 3,
    });
    expect(calls.generate).toHaveLength(0);
  });

  it('falls back to fragments/records when an older sidecar omits blocks', async () => {
    const fetchImpl = createFetch({
      '/context': {
        recallId: 'rr_old',
        fragments: [{ id: 'mf_old', kind: 'fact', gist: 'legacy fragment', citations: [{ id: '01JOLD' }] }],
        records: [],
      },
    });
    const { controller } = controllerWith({ fetchImpl });
    const event = hookEvent(userMessages());
    await controller.handleContext(event);
    expect(event.system[0].text).toContain('legacy fragment');
  });

  it('passes alreadyInjectedIds on later turns in the same thread', async () => {
    const fetchImpl = createFetch({ '/context': FRAGMENT_HIT });
    const { controller } = controllerWith({ fetchImpl });
    await controller.handleContext(hookEvent(userMessages()));
    const second = hookEvent([
      ...userMessages(),
      { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
      { id: 'u2', role: 'user', content: [{ type: 'text', text: 'next turn' }] },
    ]);
    await controller.handleContext(second);
    const secondBody = fetchImpl.callsFor('/context')[1].body;
    expect(secondBody.alreadyInjectedIds).toContain('mf_01JTEST');
  });

  it('renders a sidecar detail block without reading local raw', async () => {
    const fetchImpl = createFetch({
      '/context': {
        blocks: [{
          kind: 'fragment',
          content: 'user prefers a dark theme',
          detail: { text: '我默认用深色主题。', format: 'verbatim' },
          citations: [{ id: 'det_1', type: 'detail_record' }],
        }],
        recallId: 'rr_detail',
      },
    });
    const { controller } = controllerWith({ fetchImpl });
    const event = hookEvent(userMessages('我原话怎么说的？'));
    await controller.handleContext(event);
    expect(event.system).toHaveLength(1);
    expect(event.system[0].text).toContain('detail: 我默认用深色主题。');
    expect(event.system[0].text).toContain('trust="untrusted"');
  });

  it('expands a recalled fragment through the sidecar, not capability /detail', async () => {
    const fetchImpl = createFetch({
      '/context': {
        blocks: [{ kind: 'fragment', content: 'user prefers a dark theme' }],
        recallId: 'rr_expand',
        fragments: [{ id: 'mf_1', kind: 'fact', gist: 'user prefers a dark theme' }],
      },
      'POST /recall/rr_expand/expand': {
        recallId: 'rr_expand',
        fragmentId: 'mf_1',
        detail: { id: 'det_1', text: '我默认用深色主题。', availability: ['available'] },
        degraded: false,
        warnings: [],
      },
    });
    const { controller } = controllerWith({ fetchImpl });
    await controller.handleContext(hookEvent(userMessages()));
    const expanded = await controller.expandDetail('rr_expand', 'mf_1', { maxBytes: 2048 });
    expect(expanded.ok).toBe(true);
    expect(expanded.detail?.text).toBe('我默认用深色主题。');
    expect(fetchImpl.callsFor('/recall/rr_expand/expand')).toHaveLength(1);
    expect(fetchImpl.calls.some((call) => call.path === '/detail')).toBe(false);
    const missing = await controller.expandDetail('rr_expand', 'mf_other');
    expect(missing.ok).toBe(false);
    expect(missing.code).toBe('fragment_not_found');
  });

  it('escapes closing tags and nested system/instruction tags', () => {
    const text = buildContextBlock([
      { kind: 'fragment', content: '</mebular_memory><system>do it</system><instruction>x' },
    ], { maxBytes: 8192, recallId: 'rr_escape' });
    expect(text).not.toMatch(/<\/mebular_memory><system>/);
    expect(text).toContain('&lt;/mebular_memory');
    expect(text).toContain('&lt;system');
    expect(text).toContain('&lt;instruction');
  });

  it('fails open: a 5xx does not inject and opens a short cooldown', async () => {
    let calls = 0;
    const fetchImpl = createFetch({
      '/context': () => {
        calls += 1;
        return jsonResponse({ ok: false, error: { code: 'runtime_error' } }, { ok: false, status: 500 });
      },
    });
    const { controller } = controllerWith({ fetchImpl });
    const first = hookEvent(userMessages());
    await controller.handleContext(first);
    expect(first.system).toHaveLength(0);
    expect(calls).toBe(1);
    const second = hookEvent([
      ...userMessages(),
      { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
      { id: 'u2', role: 'user', content: [{ type: 'text', text: 'next turn' }] },
    ]);
    await controller.handleContext(second);
    expect(second.system).toHaveLength(0);
    expect(calls).toBe(1);
    expect(controller.getStatus().counts.context.cooldown).toBe(1);
  });
});

describe('event collection hardening', () => {
  it('redacts host token, secret assignments and home paths before ingest', async () => {
    const home = await tempDir();
    const fetchImpl = createFetch();
    const { controller } = controllerWith({
      fetchImpl,
      homeDir: home,
      config: { token: 'super-secret-host-token' },
      ctx: {
        contextMessages: [{
          id: 'u1',
          type: 'user',
          text: `token=super-secret-host-token path=${home}/project api_key: abc123`,
        }],
      },
    });
    await controller.handleEvent({ type: 'session.execution.succeeded', data: { sessionID: 'ses_redact' } });
    const chunk = fetchImpl.callsFor('/ingest')[0].body.chunks[0];
    expect(chunk.text).not.toContain('super-secret-host-token');
    expect(chunk.text).not.toContain(home);
    expect(chunk.text).not.toContain('abc123');
    expect(chunk.redaction.applied).toBe(true);
    expect(chunk.redaction.rules).toContain('host_token');
  });

  it('never ingests its own memory tools or the host native memory tool', async () => {
    const fetchImpl = createFetch();
    const { controller } = controllerWith({
      fetchImpl,
      ctx: { contextMessages: [{ id: 'u1', type: 'user', text: 'use the tools' }] },
    });
    for (const [id, name] of [['t1', 'mebular_recall'], ['t2', 'openchamber_memory']]) {
      await controller.handleEvent({
        type: 'session.tool.input.started',
        data: { sessionID: 'ses_tools', id, name, assistantMessageID: 'a1' },
      });
      await controller.handleEvent({
        type: 'session.tool.called',
        data: { sessionID: 'ses_tools', id, input: { query: 'secret' }, assistantMessageID: 'a1' },
      });
      await controller.handleEvent({
        type: 'session.tool.success',
        data: { sessionID: 'ses_tools', id, content: [{ type: 'text', text: 'native content' }], assistantMessageID: 'a1' },
      });
    }
    await controller.handleEvent({ type: 'session.execution.succeeded', data: { sessionID: 'ses_tools' } });
    const ingest = fetchImpl.callsFor('/ingest');
    expect(ingest).toHaveLength(1);
    expect(ingest[0].body.chunks.map((chunk) => chunk.role)).toEqual(['user']);
    expect(controller.getStatus().counts.ingest.skipped).toBe(2);
  });

  it('writes a state-only checkpoint when compaction has no summary', async () => {
    const fetchImpl = createFetch();
    const { controller } = controllerWith({ fetchImpl });
    await controller.handleEvent({
      id: 'evt_no_summary',
      type: 'session.compaction.ended',
      data: { sessionID: 'ses_1', reason: 'auto', messageCount: 42, lastMessageID: 'msg_9' },
    });
    expect(fetchImpl.callsFor('/ingest')).toHaveLength(0);
    const checkpoint = fetchImpl.callsFor('/checkpoints/ses_1').filter((call) => call.method === 'PUT');
    expect(checkpoint).toHaveLength(1);
    expect(checkpoint[0].body.summary).toBeNull();
    expect(checkpoint[0].body.sync).toBeUndefined();
    expect(checkpoint[0].body.domain).toBe('task:ses_1');
    expect(checkpoint[0].body.state).toMatchObject({
      kind: 'compaction',
      compactionId: expect.stringMatching(/^cmp_[0-9a-f]{32}$/),
      sourceEventId: 'evt_no_summary',
      messageCount: 42,
      lastMessageId: 'msg_9',
    });
  });

  it('retries one revision conflict with the current revision', async () => {
    let puts = 0;
    const fetchImpl = createFetch({
      '/checkpoints/ses_conflict': (call) => {
        if (call.method === 'GET') {
          return jsonResponse({ ok: true, data: { checkpoint: { revision: 4 } } });
        }
        puts += 1;
        if (puts === 1) {
          return jsonResponse({ ok: false, error: { code: 'revision_mismatch' } }, { ok: false, status: 409 });
        }
        return jsonResponse({ ok: true, data: { checkpoint: { revision: call.body.expectedRevision + 1 } } });
      },
    });
    const { controller } = controllerWith({ fetchImpl });
    await controller.handleEvent({
      id: 'evt_conflict',
      type: 'session.compaction.ended',
      data: { sessionID: 'ses_conflict', reason: 'manual', text: 'checkpoint me' },
    });
    const putsCalls = fetchImpl.calls.filter((call) => call.path === '/checkpoints/ses_conflict' && call.method === 'PUT');
    expect(putsCalls).toHaveLength(2);
    expect(putsCalls[1].body.expectedRevision).toBe(4);
    expect(controller.getStatus().counts.checkpoints.conflicts).toBe(1);
    expect(controller.getStatus().counts.checkpoints.sent).toBe(1);
  });

  it('keeps checkpoint requestId and body deterministic across a lost response retry', async () => {
    let puts = 0;
    const bodies = [];
    const fetchImpl = createFetch({
      '/checkpoints/ses_idem': (call) => {
        if (call.method === 'GET') {
          return jsonResponse({ ok: true, data: { checkpoint: null, source: 'cloud' } });
        }
        puts += 1;
        bodies.push(call.body);
        if (puts === 1) throw new Error('simulated lost response after commit');
        return jsonResponse({
          ok: true,
          data: { checkpoint: { revision: 1, pending: false, state: { compactionId: 'cmp_idem' } }, source: 'cloud' },
        });
      },
    });
    const { controller } = controllerWith({
      fetchImpl,
      config: { checkpointRetryMs: 10, checkpointPendingTimeoutMs: 500 },
    });
    await controller.handleEvent({
      id: 'evt_idem',
      type: 'session.compaction.ended',
      data: {
        sessionID: 'ses_idem',
        compactionId: 'cmp_idem',
        at: 1700000000000,
        reason: 'auto',
        messageCount: 2,
      },
    });
    expect(await waitFor(() => controller.getStatus().counts.checkpoints.sent === 1)).toBeTruthy();
    expect(bodies).toHaveLength(2);
    expect(bodies[0].requestId).toMatch(/^opencode_/);
    expect(bodies[0].expectedRevision).toBe(0);
    expect(bodies[0].state.at).toBe(1700000000000);
    expect(bodies[0].state.host.at).toBe(1700000000000);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(controller.getStatus().counts.checkpoints.failed).toBe(0);
  });

  it('preflights checkpoint revision and carries expectedRevision forward', async () => {
    let currentRevision = 0;
    let gets = 0;
    const puts = [];
    const fetchImpl = createFetch({
      '/checkpoints/ses_rev': (call) => {
        if (call.method === 'GET') {
          gets += 1;
          return jsonResponse({
            ok: true,
            data: {
              checkpoint: currentRevision > 0
                ? { revision: currentRevision, pending: false, state: {} }
                : null,
              source: 'cloud',
            },
          });
        }
        puts.push(call.body);
        if (call.body.expectedRevision !== currentRevision) {
          return jsonResponse({ ok: false, error: { code: 'revision_mismatch' } }, { ok: false, status: 409 });
        }
        currentRevision += 1;
        return jsonResponse({
          ok: true,
          data: {
            checkpoint: {
              revision: currentRevision,
              pending: false,
              state: { compactionId: call.body.state.compactionId },
            },
            source: 'cloud',
          },
        });
      },
    });
    const { controller } = controllerWith({ fetchImpl });
    for (const [index, compactionId] of ['cmp_rev_1', 'cmp_rev_2'].entries()) {
      await controller.handleEvent({
        id: `evt_rev_${index}`,
        type: 'session.compaction.ended',
        data: { sessionID: 'ses_rev', compactionId, at: 1700000000000 + index },
      });
    }
    expect(gets).toBe(1);
    expect(puts.map((body) => body.expectedRevision)).toEqual([0, 1]);
    expect(puts.every((body) => body.requestId.startsWith('opencode_'))).toBe(true);
    expect(currentRevision).toBe(2);
    expect(controller.getStatus().checkpoints.last).toMatchObject({ state: 'committed', revision: 2 });
  });

  it('recovers a stale cached revision after checkpoint deletion with a create retry', async () => {
    let currentRevision = 0;
    let gets = 0;
    const puts = [];
    const fetchImpl = createFetch({
      '/checkpoints/ses_recreate': (call) => {
        if (call.method === 'GET') {
          gets += 1;
          return jsonResponse({
            ok: true,
            data: {
              checkpoint: currentRevision > 0
                ? { revision: currentRevision, pending: false, state: {} }
                : null,
              source: 'cloud',
            },
          });
        }
        puts.push(call.body);
        if (call.body.expectedRevision !== currentRevision) {
          return jsonResponse({ ok: false, error: { code: 'revision_mismatch' } }, { ok: false, status: 409 });
        }
        currentRevision += 1;
        return jsonResponse({
          ok: true,
          data: {
            checkpoint: {
              revision: currentRevision,
              pending: false,
              state: { compactionId: call.body.state.compactionId },
            },
            source: 'cloud',
          },
        });
      },
    });
    const { controller } = controllerWith({ fetchImpl });
    for (const [index, compactionId] of ['cmp_recreate_1', 'cmp_recreate_2'].entries()) {
      await controller.handleEvent({
        id: `evt_recreate_${index}`,
        type: 'session.compaction.ended',
        data: { sessionID: 'ses_recreate', compactionId, at: 1700000000000 + index },
      });
    }
    expect(currentRevision).toBe(2);
    currentRevision = 0;
    await controller.handleEvent({
      id: 'evt_recreate_3',
      type: 'session.compaction.ended',
      data: { sessionID: 'ses_recreate', compactionId: 'cmp_recreate_3', at: 1700000000003 },
    });
    expect(puts.map((body) => body.expectedRevision)).toEqual([0, 1, 2, 0]);
    expect(gets).toBe(2);
    expect(currentRevision).toBe(1);
    expect(controller.getStatus().counts.checkpoints.conflicts).toBe(1);
    expect(controller.getStatus().checkpoints.last).toMatchObject({ state: 'committed', revision: 1 });
  });

  it('keeps different compactions with identical summary/count separate', async () => {
    const fetchImpl = createFetch();
    const { controller } = controllerWith({ fetchImpl });
    for (const [index, compactionId] of ['cmp_same_a', 'cmp_same_b'].entries()) {
      await controller.handleEvent({
        id: `evt_same_${index}`,
        type: 'session.compaction.ended',
        data: {
          sessionID: 'ses_same',
          compactionId,
          endSeq: String(index + 1),
          reason: 'auto',
          text: 'identical summary',
          messageCount: 2,
        },
      });
    }
    const puts = fetchImpl.callsFor('/checkpoints/ses_same').filter((call) => call.method === 'PUT');
    expect(puts).toHaveLength(2);
    expect(puts.map((call) => call.body.state.compactionId)).toEqual(['cmp_same_a', 'cmp_same_b']);
  });

  it('dedupes a fresh-envelope replay by compactionId/seq instead of the envelope id', async () => {
    const fetchImpl = createFetch();
    const { controller } = controllerWith({ fetchImpl });
    const data = {
      sessionID: 'ses_envelope',
      compactionId: 'cmp_envelope',
      endSeq: '42',
      reason: 'auto',
      text: 'same logical compaction',
      messageCount: 3,
    };
    await controller.handleEvent({ id: 'envelope_1', type: 'session.compaction.ended', data });
    await controller.handleEvent({ id: 'envelope_2', type: 'session.compaction.ended', data });
    expect(fetchImpl.callsFor('/checkpoints/ses_envelope').filter((call) => call.method === 'PUT')).toHaveLength(1);
    expect(controller.getStatus().counts.events.duplicates).toBe(1);
  });

  it('does not count a 202 checkpoint as committed until an authoritative read confirms it', async () => {
    const fetchImpl = createFetch({
      'PUT /checkpoints/ses_202': () => jsonResponse({
        ok: true,
        data: { checkpoint: { pending: true, revision: null }, pending: true },
      }, { status: 202 }),
      'GET /checkpoints/ses_202': () => jsonResponse({
        ok: true,
        data: { checkpoint: { pending: false, revision: 7, state: { compactionId: 'evt_202' } } },
      }),
    });
    const { controller } = controllerWith({
      fetchImpl,
      config: { checkpointRetryMs: 25, checkpointPendingTimeoutMs: 1000 },
    });
    await controller.handleEvent({
      id: 'evt_202',
      type: 'session.compaction.ended',
      data: { sessionID: 'ses_202', compactionId: 'evt_202', reason: 'auto', text: 'queued checkpoint body' },
    });
    let status = controller.getStatus();
    expect(status.counts.checkpoints.sent).toBe(0);
    expect(status.counts.checkpoints.pending).toBe(1);
    expect(status.checkpoints.last).toMatchObject({ state: 'pending', reason: 'checkpoint_queued' });

    expect(await waitFor(() => controller.getStatus().counts.checkpoints.sent === 1)).toBeTruthy();
    status = controller.getStatus();
    expect(status.counts.checkpoints.pending).toBe(0);
    expect(status.checkpoints.last).toMatchObject({ state: 'committed', revision: 7 });
  });

  it('turns an unconfirmed 202 pending checkpoint into a bounded visible failure', async () => {
    const fetchImpl = createFetch({
      'PUT /checkpoints/ses_202_lost': () => jsonResponse({
        ok: true,
        data: { checkpoint: { pending: true, revision: null }, pending: true },
      }, { status: 202 }),
      'GET /checkpoints/ses_202_lost': () => jsonResponse({
        ok: true,
        data: { checkpoint: { pending: true, revision: null } },
      }),
    });
    const { controller } = controllerWith({
      fetchImpl,
      config: { checkpointRetryMs: 10, checkpointPendingTimeoutMs: 80 },
    });
    await controller.handleEvent({
      id: 'evt_202_lost',
      type: 'session.compaction.ended',
      data: { sessionID: 'ses_202_lost', reason: 'auto', text: 'never commits' },
    });
    expect(controller.getStatus().counts.checkpoints.pending).toBe(1);
    expect(await waitFor(() => controller.getStatus().counts.checkpoints.pending === 0)).toBeTruthy();
    const status = controller.getStatus();
    expect(status.counts.checkpoints.sent).toBe(0);
    expect(status.counts.checkpoints.failed).toBe(1);
    expect(status.counts.checkpoints.expired).toBe(1);
    expect(status.checkpoints.last).toMatchObject({
      state: 'failed',
      reason: 'checkpoint_pending_expired',
    });
  });

  it('bounds repeated revision conflicts instead of leaving a permanent pending counter', async () => {
    let puts = 0;
    let gets = 0;
    const fetchImpl = createFetch({
      '/checkpoints/ses_conflict_forever': (call) => {
        if (call.method === 'GET') {
          gets += 1;
          return jsonResponse({ ok: true, data: { checkpoint: { revision: 4 } } });
        }
        puts += 1;
        return jsonResponse({ ok: false, error: { code: 'revision_mismatch' } }, { ok: false, status: 409 });
      },
    });
    const { controller } = controllerWith({
      fetchImpl,
      config: { checkpointRetryMs: 10, checkpointPendingTimeoutMs: 500 },
    });
    await controller.handleEvent({
      id: 'evt_conflict_forever',
      type: 'session.compaction.ended',
      data: { sessionID: 'ses_conflict_forever', reason: 'manual', text: 'always conflicts' },
    });
    const status = controller.getStatus();
    expect(status.counts.checkpoints.sent).toBe(0);
    expect(status.counts.checkpoints.pending).toBe(0);
    expect(status.counts.checkpoints.failed).toBe(1);
    expect(status.counts.checkpoints.conflicts).toBe(2);
    expect(status.checkpoints.last).toMatchObject({
      state: 'failed',
      reason: 'checkpoint_revision_conflict',
    });
    expect(puts).toBe(2);
    expect(gets).toBe(2);
  });

  it('bounds checkpoint 5xx retries and fails visibly at the deadline', async () => {
    let puts = 0;
    const fetchImpl = createFetch({
      '/checkpoints/ses_checkpoint_5xx': () => {
        puts += 1;
        return jsonResponse({ ok: false, error: { code: 'runtime_error' } }, { ok: false, status: 500 });
      },
    });
    const { controller } = controllerWith({
      fetchImpl,
      config: { checkpointRetryMs: 10, checkpointPendingTimeoutMs: 80 },
    });
    await controller.handleEvent({
      id: 'evt_checkpoint_5xx',
      type: 'session.compaction.ended',
      data: { sessionID: 'ses_checkpoint_5xx', reason: 'auto', text: 'retry bounded' },
    });
    expect(controller.getStatus().counts.checkpoints.pending).toBe(1);
    expect(await waitFor(() => controller.getStatus().counts.checkpoints.pending === 0)).toBeTruthy();
    const status = controller.getStatus();
    expect(status.counts.checkpoints.sent).toBe(0);
    expect(status.counts.checkpoints.failed).toBe(1);
    expect(status.counts.checkpoints.replayed).toBeGreaterThanOrEqual(1);
    expect(status.checkpoints.last).toMatchObject({
      state: 'failed',
      reason: 'checkpoint_pending_expired',
    });
    expect(puts).toBeGreaterThan(1);
  });

  it('makes writesDisabled rejections visible and leaves enabled true', async () => {
    let ingestCalls = 0;
    const fetchImpl = createFetch({
      '/ingest': () => {
        ingestCalls += 1;
        return jsonResponse({ ok: false, error: { code: 'unauthorized' } }, { ok: false, status: 401 });
      },
      '/context': HIT,
    });
    const { controller } = controllerWith({
      fetchImpl,
      config: { writeRecoveryMs: 1000, writeRecoveryMaxMs: 1000, writeRecoveryAttempts: 3 },
      ctx: { contextMessages: [{ id: 'u1', type: 'user', text: 'write auth test' }] },
    });
    await controller.handleEvent({ type: 'session.execution.succeeded', data: { sessionID: 'ses_write_auth' } });
    let status = controller.getStatus();
    expect(status.enabled).toBe(true);
    expect(status.writes.disabled).toBe(true);
    expect(status.writes.reason).toBe('runtime_unauthorized');
    expect(ingestCalls).toBe(1);

    await controller.handleEvent({
      type: 'session.text.ended',
      data: { sessionID: 'ses_write_auth', assistantMessageID: 'a2', text: 'rejected chunk' },
    });
    status = controller.getStatus();
    expect(ingestCalls).toBe(1);
    expect(status.writes.rejected).toBeGreaterThan(0);
    expect(status.counts.ingest.rejected).toBeGreaterThan(0);
    expect(status.writes.lastRejected).toMatchObject({ kind: 'ingest' });

    await controller.handleEvent({
      id: 'evt_write_auth_checkpoint',
      type: 'session.compaction.ended',
      data: { sessionID: 'ses_write_auth', compactionId: 'cmp_write_auth', reason: 'auto' },
    });
    status = controller.getStatus();
    expect(status.counts.checkpoints.rejected).toBe(1);
    expect(status.writes.lastRejected).toMatchObject({ kind: 'checkpoint' });
    expect(status.checkpoints.last).toMatchObject({ state: 'failed', reason: 'checkpoint_unauthorized' });

    const event = hookEvent(userMessages('recover writes'));
    await controller.handleContext(event);
    status = controller.getStatus();
    expect(status.writes.disabled).toBe(false);
    expect(status.counts.writes.recovered).toBeGreaterThanOrEqual(1);
    await controller.dispose();
  });

  it('runs a bounded auth probe and re-enables writes after success', async () => {
    let statusCalls = 0;
    const fetchImpl = createFetch({
      '/ingest': () => jsonResponse({ ok: false, error: { code: 'unauthorized' } }, { ok: false, status: 401 }),
      '/status': () => {
        statusCalls += 1;
        if (statusCalls === 1) {
          return jsonResponse({ ok: false, error: { code: 'unauthorized' } }, { ok: false, status: 401 });
        }
        return jsonResponse({ ok: true, data: { runtimeVersion: '0.3.0', mode: 'immersive', capabilities: {} } });
      },
    });
    const { controller } = controllerWith({
      fetchImpl,
      config: { writeRecoveryMs: 10, writeRecoveryMaxMs: 10, writeRecoveryAttempts: 3 },
      ctx: { contextMessages: [{ id: 'u1', type: 'user', text: 'auth probe test' }] },
    });
    await controller.handleEvent({ type: 'session.execution.succeeded', data: { sessionID: 'ses_probe' } });
    expect(controller.getStatus().writes.disabled).toBe(true);
    expect(await waitFor(() => controller.getStatus().writes.disabled === false)).toBeTruthy();
    expect(controller.getStatus().counts.writes.authProbes).toBeGreaterThanOrEqual(1);
    expect(controller.getStatus().counts.writes.recovered).toBeGreaterThanOrEqual(1);
    await controller.dispose();
  });

  it('does not retry early when Retry-After exceeds the checkpoint deadline', async () => {
    let puts = 0;
    const fetchImpl = createFetch({
      '/checkpoints/ses_checkpoint_retry_after': (call) => {
        if (call.method === 'GET') {
          return jsonResponse({ ok: true, data: { checkpoint: null, source: 'cloud' } });
        }
        puts += 1;
        return jsonResponse(
          { ok: false, error: { code: 'rate_limited' } },
          { ok: false, status: 429, headers: { 'retry-after': '120' } },
        );
      },
    });
    const { controller } = controllerWith({
      fetchImpl,
      config: { checkpointRetryMs: 10, checkpointPendingTimeoutMs: 80 },
    });
    await controller.handleEvent({
      id: 'evt_checkpoint_retry_after',
      type: 'session.compaction.ended',
      data: { sessionID: 'ses_checkpoint_retry_after', compactionId: 'cmp_retry_after' },
    });
    expect(puts).toBe(1);
    let status = controller.getStatus();
    expect(status.checkpoints.last).toMatchObject({
      state: 'pending',
      retryAfterMs: 120000,
      retryAfterLimitedByDeadline: true,
    });
    expect(await waitFor(() => controller.getStatus().counts.checkpoints.pending === 0)).toBeTruthy();
    expect(puts).toBe(1);
    status = controller.getStatus();
    expect(status.checkpoints.last).toMatchObject({
      state: 'failed',
      reason: 'checkpoint_pending_expired',
      retryAfterMs: 120000,
      retryAfterLimitedByDeadline: true,
    });
    expect(status.counts.checkpoints.retryAfterTruncated).toBeGreaterThanOrEqual(1);
  });

  it('does not retry a persistent checkpoint 401 as pending', async () => {
    const fetchImpl = createFetch({
      '/checkpoints/ses_checkpoint_401': () => jsonResponse(
        { ok: false, error: { code: 'unauthorized' } },
        { ok: false, status: 401 },
      ),
    });
    const { controller } = controllerWith({ fetchImpl });
    await controller.handleEvent({
      id: 'evt_checkpoint_401',
      type: 'session.compaction.ended',
      data: { sessionID: 'ses_checkpoint_401', reason: 'auto', text: 'unauthorized' },
    });
    const status = controller.getStatus();
    expect(status.counts.checkpoints.pending).toBe(0);
    expect(status.counts.checkpoints.sent).toBe(0);
    expect(status.counts.checkpoints.failed).toBe(1);
    expect(status.checkpoints.last).toMatchObject({
      state: 'failed',
      reason: 'checkpoint_unauthorized',
    });
  });

  it('uses the host/current model only after a completed turn', async () => {
    const { calls, fetchImpl, controller } = controllerWith({
      config: { modelSource: 'current' },
      ctx: {
        contextMessages: [{ id: 'u1', type: 'user', text: 'remember this' }],
        generateImpl: async () => ({ text: '[]' }),
      },
    });
    await controller.handleContext(hookEvent(userMessages()));
    expect(calls.generate).toHaveLength(0);
    await controller.handleEvent({ type: 'session.execution.succeeded', data: { sessionID: 'ses_current' } });
    expect(calls.generate).toHaveLength(1);
    expect(fetchImpl.callsFor('/ingest')[0].body.extractor).toBe('heuristic');
  });
});

describe('event subscription reconnect and hot disable', () => {
  it('resubscribes after the event stream ends and dedupes replayed events', async () => {
    const replayed = {
      id: 'evt_reconnect_1',
      type: 'session.tool.input.started',
      data: { sessionID: 'ses_reconnect', id: 't1', name: 'read' },
    };
    const { ctx, calls } = makeCtx({
      subscribeImpl: (subscribeOptions, count) => (
        count === 1
          ? replayStream([replayed], subscribeOptions.signal, { close: true })
          : replayStream([replayed], subscribeOptions.signal)
      ),
    });
    const controller = createController({
      ctx,
      config: { runtimeUrl: BASE, eventReconnectMs: 10, eventReconnectMaxMs: 50 },
      fetchImpl: createFetch(),
      env: {},
    });
    await controller.start();
    expect(await waitFor(() => controller.getStatus().counts.events.handled === 1)).toBeTruthy();
    expect(await waitFor(() => calls.subscriptions.length >= 2)).toBeTruthy();
    expect(await waitFor(() => controller.getStatus().counts.events.duplicates === 1)).toBeTruthy();
    const status = controller.getStatus();
    expect(status.counts.events.handled).toBe(1);
    expect(status.counts.events.duplicates).toBe(1);
    expect(status.events.subscribed).toBe(2);
    expect(status.events.reconnects).toBeGreaterThanOrEqual(1);
    await controller.dispose();
    expect(calls.subscriptions.at(-1).signal.aborted).toBe(true);
  });

  it('dedupes a replayed compaction event into one checkpoint write', async () => {
    const fetchImpl = createFetch();
    const { controller } = controllerWith({ fetchImpl });
    const event = {
      id: 'evt_compact_replay',
      type: 'session.compaction.ended',
      data: { sessionID: 'ses_compact_replay', reason: 'auto', text: 'replayed compaction' },
    };
    await controller.handleEvent(event);
    await controller.handleEvent(event);
    expect(fetchImpl.callsFor('/ingest')).toHaveLength(1);
    expect(fetchImpl.callsFor('/checkpoints/ses_compact_replay').filter((call) => call.method === 'PUT')).toHaveLength(1);
    expect(controller.getStatus().counts.events.duplicates).toBe(1);
  });

  it('does not register a late checkpoint response after dispose', async () => {
    let releasePreflight;
    let signalStarted;
    const started = new Promise((resolve) => { signalStarted = resolve; });
    const fetchImpl = async (url, init = {}) => {
      const path = new URL(url).pathname.replace(/^\/memory-runtime\/v1/, '');
      if (path === '/checkpoints/ses_late' && (init.method ?? 'GET') === 'GET') {
        signalStarted();
        await new Promise((resolve) => { releasePreflight = resolve; });
        return jsonResponse({ ok: true, data: { checkpoint: null, source: 'cloud' } });
      }
      return jsonResponse({ ok: false, error: { code: 'not_found' } }, { ok: false, status: 404 });
    };
    const { controller } = controllerWith({
      fetchImpl,
      config: { checkpointPendingTimeoutMs: 500 },
    });
    const task = controller.handleEvent({
      id: 'evt_late',
      type: 'session.compaction.ended',
      data: { sessionID: 'ses_late', compactionId: 'cmp_late', text: 'late response' },
    });
    await started;
    const disposing = controller.dispose();
    releasePreflight();
    await Promise.all([task, disposing]);
    const status = controller.getStatus();
    expect(status.counts.checkpoints.pending).toBe(0);
    expect(status.counts.checkpoints.sent).toBe(0);
    expect(status.counts.checkpoints.failed).toBe(1);
    expect(status.counts.checkpoints.interrupted).toBe(1);
    expect(status.checkpoints.last).toMatchObject({
      state: 'failed',
      reason: 'checkpoint_interrupted',
    });
  });

  it('cancels subscription, buffer timer and pending checkpoint after discovery disappears', async () => {
    const home = await tempDir();
    await writeDiscovery(home);
    let clock = Date.now();
    const fetchImpl = createFetch({
      '/context': HIT,
      'PUT /checkpoints/ses_hot': () => jsonResponse({
        ok: true,
        data: { checkpoint: { pending: true, revision: null }, pending: true },
      }, { status: 202 }),
      'GET /checkpoints/ses_hot': () => jsonResponse({
        ok: true,
        data: { checkpoint: { pending: true, revision: null } },
      }),
    });
    const { ctx, calls } = makeCtx({
      subscribeImpl: (subscribeOptions) => replayStream([], subscribeOptions.signal),
    });
    const controller = createController({
      ctx,
      config: {
        bufferIdleMs: 100,
        eventReconnectMs: 10,
        checkpointRetryMs: 100,
        checkpointPendingTimeoutMs: 5000,
      },
      fetchImpl,
      env: {},
      homeDir: home,
      now: () => clock,
    });
    await controller.start();
    expect(calls.subscriptions).toHaveLength(1);

    await controller.handleEvent({
      id: 'evt_hot',
      type: 'session.compaction.ended',
      data: { sessionID: 'ses_hot', reason: 'auto', text: 'pending across disable' },
    });
    expect(controller.getStatus().counts.checkpoints.pending).toBe(1);
    await controller.handleEvent({
      type: 'session.text.ended',
      data: { sessionID: 'ses_hot', assistantMessageID: 'a1', text: 'buffered but not flushed' },
    });

    await rm(join(home, 'memory-runtime.json'));
    clock += 6000;
    const event = hookEvent(userMessages());
    await controller.handleContext(event);
    expect(event.system).toHaveLength(0);
    const status = controller.getStatus();
    expect(status.enabled).toBe(false);
    expect(status.counts.checkpoints.pending).toBe(0);
    expect(status.counts.checkpoints.interrupted).toBe(1);
    expect(calls.subscriptions[0].signal.aborted).toBe(true);

    const callsAfterDisable = fetchImpl.calls.length;
    await sleep(250);
    expect(fetchImpl.calls.length).toBe(callsAfterDisable);
    expect(calls.subscriptions).toHaveLength(1);
    await controller.dispose();
  });
});

describe('tool surface coexistence', () => {
  it('keeps governance tool access for agent objects and allows explicit opt-out', async () => {
    const governance = hookEvent(userMessages(), { agent: { name: 'mebular-governance' } });
    const ordinary = hookEvent(userMessages(), { agent: { name: 'build' } });
    const enabled = controllerWith({});
    await enabled.controller.handleContext(governance);
    await enabled.controller.handleContext(ordinary);
    expect(Object.keys(governance.tools).sort()).toEqual(['mebular_recall', 'mebular_status', 'read']);
    expect(Object.keys(ordinary.tools)).toEqual(['read']);

    const visible = controllerWith({ config: { hideMemoryTools: false } });
    const event = hookEvent(userMessages());
    await visible.controller.handleContext(event);
    expect(Object.keys(event.tools).sort()).toEqual(['mebular_recall', 'mebular_status', 'read']);
  });
});

describe('host token rotation', () => {
  it('refreshes the token file once after a 401 and retries the request', async () => {
    const home = await tempDir();
    const { tokenFile } = await writeDiscovery(home, { token: 'old-host-token' });
    const fetchImpl = createFetch({
      '/context': (call) => (call.headers.authorization === 'Bearer new-host-token'
        ? jsonResponse({ ok: true, data: HIT })
        : jsonResponse({ ok: false, error: { code: 'invalid_token' } }, { ok: false, status: 401 })),
    });
    const { controller } = controllerWith({ fetchImpl, homeDir: home, useDiscovery: true });
    await controller.start();
    await writeFile(tokenFile, 'new-host-token', { mode: 0o600 });
    const event = hookEvent(userMessages());
    await controller.handleContext(event);
    expect(event.system).toHaveLength(1);
    const contexts = fetchImpl.callsFor('/context');
    expect(contexts).toHaveLength(2);
    expect(contexts[0].headers.authorization).toBe('Bearer old-host-token');
    expect(contexts[1].headers.authorization).toBe('Bearer new-host-token');
    expect(controller.getStatus().enabled).toBe(true);
    expect(controller.getStatus().runtime.tokenConfigured).toBe(true);
    await controller.dispose();
  });
});
