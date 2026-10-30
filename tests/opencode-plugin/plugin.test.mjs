// OpenCode V2 plugin for Mebular Memory Runtime.
//
// All tests are hermetic: fake ctx, fake fetch and fake session only. No real
// OpenCode, OpenChamber, Mebular runtime or native memory file is touched.

import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
    async json() {
      return data;
    },
  };
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
    const path = parsed.pathname.replace(/^\/runtime\/v1/, '');
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
    const headers = init.headers ?? {};
    const call = { url, path, method, body, headers };
    calls.push(call);
    const keyed = routes[`${method} ${path}`];
    const handler = keyed ?? routes[path];
    if (typeof handler === 'function') return handler(call);
    if (handler !== undefined) return jsonResponse({ ok: true, data: handler });
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
      runtimeUrl: BASE,
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
    const definition = createPlugin();
    const cleanup = await definition.setup(ctx);
    const status = definition.status();
    expect(status.id).toBe(PLUGIN_ID);
    expect(status.enabled).toBe(true);
    expect(status.opencode.supported).toBe(true);
    expect(status.runtime.url).toBe(BASE);
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
    const noUrlDefinition = createPlugin();
    await noUrlDefinition.setup(noUrl.ctx);
    expect(noUrlDefinition.status().reason).toBe('runtime_url_missing');
    expect(noUrl.calls.hooks).toHaveLength(0);
  });

  it('reports generate as unavailable without disabling recall/ingest', async () => {
    const { ctx, calls } = makeCtx({ generate: false, options: { runtimeUrl: BASE, modelSource: 'host' } });
    const definition = createPlugin();
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
    await calls.hooks[0].callback(event);
    expect(event.system).toHaveLength(1);
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
      runtimeUrl: 'http://file.example:7331',
      token: 'file-token',
      agentId: 'from-file',
    }));
    const resolved = resolvePluginConfig(
      { token: 'option-token', modelSource: 'current' },
      {
        env: { MEBULAR_RUNTIME_URL: 'http://env.example:7331', MEBULAR_RUNTIME_TOKEN: 'env-token' },
        homeDir: home,
      },
    );
    expect(resolved.runtimeUrl).toBe('http://env.example:7331');
    expect(resolved.token).toBe('option-token');
    expect(resolved.tokenSource).toBe('options');
    expect(resolved.modelSource).toBe('host');
    expect(resolved.agentId).toBe('from-file');

    const fetchImpl = createFetch({ '/context': HIT });
    const { controller } = controllerWith({ fetchImpl, homeDir: home, env: {
      MEBULAR_RUNTIME_URL: 'http://env.example:7331',
      MEBULAR_RUNTIME_TOKEN: 'env-token',
    } });
    const statusText = JSON.stringify(controller.getStatus());
    expect(statusText).not.toContain('env-token');
    expect(controller.getStatus().runtime.tokenConfigured).toBe(true);
    expect(controller.getStatus().runtime.tokenSource).toBe('env');
  });

  it('honors a plugin config file when env/options do not set a URL', async () => {
    const home = await tempDir();
    await writeFile(join(home, 'opencode-plugin.json'), JSON.stringify({
      runtimeUrl: 'http://file.example:7331',
      token: 'file-token',
    }));
    const resolved = resolvePluginConfig({}, { env: {}, homeDir: home });
    expect(resolved.runtimeUrl).toBe('http://file.example:7331');
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
    const checkpoint = fetchImpl.callsFor('/checkpoints/ses_1');
    expect(checkpoint).toHaveLength(1);
    expect(checkpoint[0].method).toBe('PUT');
    expect(checkpoint[0].body).toMatchObject({
      agentId: 'opencode',
      summary: 'The task moved from design to implementation.',
      sync: 'local',
      state: { kind: 'compaction', reason: 'auto' },
    });
    expect(controller.getStatus().counts.checkpoints.sent).toBe(1);
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
