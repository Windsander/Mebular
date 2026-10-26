// P2 · @mebular/dsh-plugin host：配置归一、loopback 判定、embedInfo 形状与只读路由。

import { describe, it, expect, afterEach } from '@jest/globals';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AGENT_STATUS_ORDER,
  AGENT_STATUS_SECTION,
  EMBED_INFO_PATH,
  EMBED_PROTOCOL,
  MCP_CLIENT_PACKAGE,
  PANEL_GLOBAL,
  agentStatusText,
  apply,
  buildEmbedInfo,
  createAgentStatus,
  createDaemonLifecycle,
  createEmbedInfoHandler,
  createMcpBridgeSupervisor,
  daemonPortFromUrl,
  DEFAULT_SUPERVISE_STOP_GRACE_MS,
  discoverRuntimeProviders,
  injectPanelGlobal,
  isLoopbackAddress,
  isLoopbackUrl,
  joinUrl,
  mountMcp,
  name as pluginName,
  probeDaemon,
  redactLogLine,
  resolveCliPath,
  resolveConfig,
  runtimeCloudRoot,
  scriptJson,
} from '../../packages/dsh-plugin/index.js';

const BASE = 'http://127.0.0.1:7331';
// Hermetic config resolution: no real ~/.mebular/runtime.json on the test host.
const CONFIG_OPTS = { runtime: null };
const RUNTIME = {
  version: '0.1.0',
  pid: 4242,
  http: { host: '127.0.0.1', port: 9123 },
  consolePath: '/console',
  mcpPath: '/mcp',
  embedProtocol: 1,
};

const HEALTH = { status: 'ok', name: 'mebular', version: '0.1.0', auth: 'none', tls: false };
const EMBED = {
  ok: true,
  name: 'mebular',
  version: '0.1.0',
  embedProtocol: 1,
  consoleUrl: `${BASE}/console`,
  embedUrl: `${BASE}/console/?embed=dsh`,
  mcpUrl: `${BASE}/mcp`,
  loopback: true,
  capabilities: { embedConsole: true },
};

function jsonResponse(payload) {
  return { ok: true, status: 200, json: async () => payload };
}

function mockFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? input);
    calls.push({ url, init });
    return handler(url, init);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

function makeRequest({ method = 'GET', remoteAddress = '127.0.0.1' } = {}) {
  return {
    method,
    url: EMBED_INFO_PATH,
    headers: { host: '127.0.0.1' },
    socket: remoteAddress === null ? {} : { remoteAddress },
  };
}

function makeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
    },
    end(body) {
      this.body = body === undefined ? '' : String(body);
    },
  };
}

function fakeStream() {
  const handlers = [];
  return {
    on(event, handler) {
      if (event === 'data') handlers.push(handler);
      return this;
    },
    emit(text) {
      for (const handler of handlers) handler(text);
    },
  };
}

function fakeChild() {
  const listeners = new Map();
  return {
    stdout: fakeStream(),
    stderr: fakeStream(),
    killCalls: [],
    kill(signal) {
      this.killCalls.push(signal);
      return true;
    },
    once(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
      return this;
    },
    removeListener(event, handler) {
      const list = listeners.get(event) ?? [];
      listeners.set(event, list.filter((entry) => entry !== handler));
      return this;
    },
    emit(event, ...args) {
      for (const handler of listeners.get(event) ?? []) handler(...args);
    },
  };
}

async function waitFor(predicate, timeoutMs = 2000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function cliProvider(path = '/opt/mebular/bin/mebular') {
  return { kind: 'cli', path, source: 'config', version: null };
}

function appProvider(
  path = '/Applications/Mebular.app/Contents/Resources/node_modules/@mebular/core/packages/mcp/bin/mebular.mjs',
) {
  return { kind: 'app', path, source: 'registry', version: '0.2.0' };
}

function discoveryFor(provider = null) {
  return {
    cloudRoot: '/tmp/mebular-dsh-test',
    providers: provider === null ? [] : [provider],
    selected: provider,
    warnings: [],
  };
}

function resolveDocument({ mode = 'child', port = 9123, ...extra } = {}) {
  return {
    ok: true,
    mode,
    http: { scheme: 'http', host: '127.0.0.1', port },
    instance: 'instance-test',
    version: '0.2.0',
    profileId: 'work',
    profile: { id: 'work', name: 'Work' },
    service: {
      registered: mode === 'service',
      running: mode === 'service',
      foreign: false,
    },
    providers: {
      selected: mode === 'service'
        ? { kind: 'cli', source: 'path', version: '0.2.0' }
        : { kind: 'app', source: 'registry', version: '0.2.0' },
    },
    ...extra,
  };
}

function embedFor(daemonUrl) {
  return {
    ...EMBED,
    consoleUrl: `${daemonUrl}/console`,
    embedUrl: `${daemonUrl}/console/?embed=dsh`,
    mcpUrl: `${daemonUrl}/mcp`,
  };
}

/** Controllable supervise handle for deterministic lifecycle tests. */
function superviseHandle(readyData, { exitAfterReady = false } = {}) {
  let resolveExit;
  const exited = new Promise((resolve) => { resolveExit = resolve; });
  if (exitAfterReady) {
    queueMicrotask(() => resolveExit({ code: 0, signal: null }));
  }
  return {
    ready: Promise.resolve({ ok: readyData?.ok === true, data: readyData }),
    exited,
    stopCalls: [],
    exit(code = 0, signal = null) {
      resolveExit({ code, signal });
    },
    async stop(options) {
      this.stopCalls.push(options);
      resolveExit({ code: 0, signal: 'SIGTERM' });
      return { stopped: true };
    },
    getState: () => ({ exited: false }),
  };
}

function runtimeHarness({
  lifecycle = 'attach',
  runtime = 'auto',
  persistence = 'child',
  bootstrap = 'prompt',
  provider = cliProvider(),
  resolveData = resolveDocument(),
  resolveResult = null,
  supervise = null,
  useRealSupervise = false,
  useRealResolve = false,
  spawnFn = null,
  reachable = true,
  probe = null,
  config = {},
  env = { PATH: '/usr/bin', MEBULAR_HOME: '/inherited/home' },
  platform = undefined,
  home = undefined,
  runtimeDoc = null,
  warnings = [],
  logs = [],
  startTimeoutMs = 200,
  superviseStopGraceMs = 10,
  useDefaultSuperviseStopGrace = false,
  sleep = undefined,
} = {}) {
  const calls = { discovery: 0, resolve: [], supervise: [], probes: [] };
  const handle = supervise ?? superviseHandle(resolveData);
  const options = {
    config: {
      lifecycle,
      runtime,
      persistence,
      bootstrap,
      pinnedDaemonUrl: false,
      ...config,
    },
    logger: {
      info: (message) => logs.push(`info:${message}`),
      warn: (message) => {
        warnings.push(message);
        logs.push(`warn:${message}`);
      },
    },
    discoverProviders: async () => {
      calls.discovery += 1;
      return discoveryFor(provider);
    },
    probe: probe ?? (async ({ daemonUrl }) => {
      calls.probes.push(daemonUrl);
      return {
        reachable,
        health: reachable ? HEALTH : null,
        embed: reachable ? embedFor(daemonUrl) : null,
      };
    }),
    pollIntervalMs: 1,
    startTimeoutMs,
    cacheTtlMs: 0,
    env,
    runtime: runtimeDoc,
  };
  if (!useDefaultSuperviseStopGrace && superviseStopGraceMs !== undefined) {
    options.superviseStopGraceMs = superviseStopGraceMs;
  }
  if (typeof sleep === 'function') options.sleep = sleep;
  if (home !== undefined) options.home = home;
  if (!useRealResolve) {
    options.runResolve = async (context) => {
      calls.resolve.push(context);
      return resolveResult ?? { ok: true, data: resolveData };
    };
  }
  if (platform !== undefined) options.platform = platform;
  if (!useRealSupervise) {
    options.startSupervise = async (context) => {
      calls.supervise.push(context);
      return handle;
    };
  } else if (typeof spawnFn === 'function') {
    options.spawnFn = spawnFn;
  }
  return { lifecycle: createDaemonLifecycle(options), calls, handle, warnings, logs };
}

function applyHarness(fetchHandler, {
  panel = true,
  tapIndex = true,
  systemPrompt = true,
  importModule = async () => ({ name: 'fake-mcp-client' }),
  applyOptions = {},
  config,
} = {}) {
  const mock = mockFetch(fetchHandler);
  const routes = [];
  const taps = [];
  const plugins = [];
  const warnings = [];
  const infos = [];
  const intervals = [];
  const effects = [];
  const events = [];
  const activeNames = new Set();
  const agentSections = new Map();
  const promptService = systemPrompt === false
    ? null
    : systemPrompt === true || systemPrompt === undefined
      ? {
          sections: agentSections,
          section(section) {
            if (agentSections.has(section.name)) {
              throw new Error(`duplicate prompt section ${section.name}`);
            }
            agentSections.set(section.name, section);
            return () => {
              if (agentSections.get(section.name) === section) agentSections.delete(section.name);
            };
          },
        }
      : systemPrompt;
  let cleaned = false;
  const ctx = {
    logger: {
      info: (message) => infos.push(message),
      warn: (message) => warnings.push(message),
    },
    emit(event) {
      events.push(event);
    },
    plugin(module, pluginConfig) {
      const serverName = pluginConfig?.serverName;
      if (serverName !== undefined && activeNames.has(serverName)) {
        throw new Error(`duplicate serverName ${serverName}`);
      }
      if (serverName !== undefined) activeNames.add(serverName);
      const entry = { module, config: pluginConfig, disposed: false };
      plugins.push(entry);
      return () => {
        entry.disposed = true;
        if (serverName !== undefined) activeNames.delete(serverName);
      };
    },
    effect(run, label) {
      const disposer = run();
      effects.push({ label, disposer });
      return disposer;
    },
    inject(deps, callback) {
      if (deps.length === 1 && deps[0] === 'systemPrompt') {
        if (promptService === null) return undefined;
        const childEffects = [];
        const injected = callback({
          systemPrompt: promptService,
          emit(event) {
            events.push(event);
          },
          effect(run) {
            const disposer = run();
            childEffects.push(disposer);
            return disposer;
          },
        });
        effects.push({
          label: 'systemPrompt',
          disposer: typeof injected === 'function'
            ? injected
            : () => {
                for (const disposer of childEffects.slice().reverse()) {
                  try {
                    disposer?.();
                  } catch {
                    // Test cleanup is best-effort.
                  }
                }
              },
        });
        return undefined;
      }
      expect(deps).toEqual(['webServer']);
      callback({
        effect(run) {
          const disposer = run();
          effects.push({ label: 'web', disposer });
          return disposer;
        },
        webServer: {
          register(route) {
            routes.push(route);
            return () => {};
          },
          ...(tapIndex
            ? {
                tapIndex(transform) {
                  taps.push(transform);
                  return () => {};
                },
              }
            : {}),
        },
      });
    },
  };
  const harnessOptions = {
    runtime: null,
    importModule,
    bridgeIntervalMs: 5,
    cacheTtlMs: 0,
    // Hermetic default: no host runtime providers on the test machine.
    discoverProviders: async () => discoveryFor(null),
    setIntervalFn(callback, ms) {
      const handle = {
        callback,
        ms,
        cleared: false,
        dispose() {
          this.cleared = true;
          clearInterval(this.id);
        },
        unref() {
          return this;
        },
      };
      handle.id = setInterval(callback, ms);
      intervals.push(handle);
      return handle;
    },
    clearIntervalFn(handle) {
      handle?.dispose?.();
    },
    ...applyOptions,
  };
  apply(ctx, config ?? { daemonUrl: BASE, panel }, harnessOptions);
  const route = routes.find((entry) => entry.path === EMBED_INFO_PATH);
  const harness = {
    mock,
    route,
    routes,
    taps,
    plugins,
    warnings,
    infos,
    intervals,
    effects,
    activeNames,
    agentSections,
    events,
    systemPrompt: promptService,
    ctx,
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      for (const effect of effects.slice().reverse()) {
        try {
          await effect.disposer?.();
        } catch {
          // Test cleanup is best-effort.
        }
      }
    },
  };
  activeHarness = harness;
  return harness;
}

let activeMock = null;
let activeHarness = null;

afterEach(async () => {
  await activeHarness?.cleanup();
  activeHarness = null;
  activeMock?.restore();
  activeMock = null;
});

describe('P2 @mebular/dsh-plugin host：纯函数', () => {
  it('host 导出包名，供 DSH bundle 识别', () => {
    expect(pluginName).toBe('@mebular/dsh-plugin');
  });

  it('resolveConfig 默认 attach + 7331 + panel on', () => {
    const prior = process.env.MEBULAR_HTTP_PORT;
    try {
      delete process.env.MEBULAR_HTTP_PORT;
      expect(resolveConfig({}, CONFIG_OPTS)).toEqual({
        daemonUrl: 'http://127.0.0.1:7331',
        lifecycle: 'attach',
        panel: true,
        runtime: 'auto',
        persistence: 'child',
        bootstrap: 'prompt',
        pinnedDaemonUrl: false,
      });
    } finally {
      if (prior === undefined) delete process.env.MEBULAR_HTTP_PORT;
      else process.env.MEBULAR_HTTP_PORT = prior;
    }
  });

  it('resolveConfig 读取 MEBULAR_HTTP_PORT，忽略非法值，支持 managed/panel/cliPath', () => {
    const prior = process.env.MEBULAR_HTTP_PORT;
    try {
      process.env.MEBULAR_HTTP_PORT = '8123';
      expect(resolveConfig({}, CONFIG_OPTS).daemonUrl).toBe('http://127.0.0.1:8123');
      expect(resolveConfig({ lifecycle: 'managed', panel: false }, CONFIG_OPTS)).toEqual({
        daemonUrl: 'http://127.0.0.1:8123',
        lifecycle: 'managed',
        panel: false,
        runtime: 'auto',
        persistence: 'child',
        bootstrap: 'prompt',
        pinnedDaemonUrl: false,
      });
      expect(resolveConfig({ lifecycle: 'managed', cliPath: ' /opt/mebular ' }, CONFIG_OPTS)).toEqual({
        daemonUrl: 'http://127.0.0.1:8123',
        lifecycle: 'managed',
        panel: true,
        runtime: 'auto',
        persistence: 'child',
        bootstrap: 'prompt',
        pinnedDaemonUrl: false,
        cliPath: '/opt/mebular',
      });
      process.env.MEBULAR_HTTP_PORT = 'not-a-port';
      expect(resolveConfig({}, CONFIG_OPTS).daemonUrl).toBe('http://127.0.0.1:7331');
      process.env.MEBULAR_HTTP_PORT = '70000';
      expect(resolveConfig({}, CONFIG_OPTS).daemonUrl).toBe('http://127.0.0.1:7331');
    } finally {
      if (prior === undefined) delete process.env.MEBULAR_HTTP_PORT;
      else process.env.MEBULAR_HTTP_PORT = prior;
    }
  });

  it('resolveConfig 非法 lifecycle/panel/cliPath 回退并告警，不抛错', () => {
    const prior = process.env.MEBULAR_HTTP_PORT;
    try {
      delete process.env.MEBULAR_HTTP_PORT;
      const warnings = [];
      expect(resolveConfig({
        daemonUrl: 'file:///tmp/mebular',
        lifecycle: 'sometimes',
        panel: 'maybe',
        cliPath: 42,
        runtime: 'sometimes',
        persistence: 'sometimes',
        bootstrap: 'sometimes',
      }, {
        warn: (message) => warnings.push(message),
        runtime: null,
      })).toEqual({
        daemonUrl: 'http://127.0.0.1:7331',
        lifecycle: 'attach',
        panel: true,
        runtime: 'auto',
        persistence: 'child',
        bootstrap: 'prompt',
        pinnedDaemonUrl: false,
      });
      expect(warnings).toHaveLength(7);
      expect(warnings.join('\n')).toContain('invalid daemonUrl');
      expect(warnings.join('\n')).toContain('invalid lifecycle');
      expect(warnings.join('\n')).toContain('invalid panel');
      expect(warnings.join('\n')).toContain('invalid cliPath');
      expect(warnings.join('\n')).toContain('invalid runtime');
      expect(warnings.join('\n')).toContain('invalid persistence');
      expect(warnings.join('\n')).toContain('invalid bootstrap');
      expect(resolveConfig({ lifecycle: ' MANAGED ' }).lifecycle).toBe('managed');
      expect(resolveConfig({ lifecycle: ' AUTO ' }).lifecycle).toBe('auto');
      expect(resolveConfig({ runtime: 'EXTERNAL' }).runtime).toBe('external');
      expect(resolveConfig({ persistence: 'SERVICE' }).persistence).toBe('service');
      expect(resolveConfig({ bootstrap: 'NEVER' }).bootstrap).toBe('never');
      expect(resolveConfig({ daemonUrl: 'http://127.0.0.1:7000' }).pinnedDaemonUrl).toBe(true);
      expect(resolveConfig({ daemonUrl: 'http://127.0.0.1:7000', pinnedDaemonUrl: false }).pinnedDaemonUrl).toBe(false);
    } finally {
      if (prior === undefined) delete process.env.MEBULAR_HTTP_PORT;
      else process.env.MEBULAR_HTTP_PORT = prior;
    }
  });

  it('resolveConfig 归一化 daemonUrl，拒绝凭据与非 HTTP', () => {
    const prior = process.env.MEBULAR_HTTP_PORT;
    try {
      delete process.env.MEBULAR_HTTP_PORT;
      expect(resolveConfig({ daemonUrl: 'http://127.0.0.1:9000/' }).daemonUrl).toBe('http://127.0.0.1:9000');
      expect(resolveConfig({ daemonUrl: 'http://127.0.0.1:9000/mebular///' }).daemonUrl).toBe('http://127.0.0.1:9000/mebular');
      expect(resolveConfig({ daemonUrl: 'http://127.0.0.1:9000/?x=1#y' }).daemonUrl).toBe('http://127.0.0.1:9000');
      expect(resolveConfig({ daemonUrl: 'http://user:pass@127.0.0.1:9000' }, CONFIG_OPTS).daemonUrl).toBe('http://127.0.0.1:7331');
      expect(resolveConfig({ daemonUrl: 'file:///tmp/mebular' }, CONFIG_OPTS).daemonUrl).toBe('http://127.0.0.1:7331');
      expect(resolveConfig({ daemonUrl: 'nonsense' }, CONFIG_OPTS).daemonUrl).toBe('http://127.0.0.1:7331');
    } finally {
      if (prior === undefined) delete process.env.MEBULAR_HTTP_PORT;
      else process.env.MEBULAR_HTTP_PORT = prior;
    }
  });

  it('joinUrl 处理重复斜杠与无前导斜杠', () => {
    expect(joinUrl('http://127.0.0.1:7331', '/console')).toBe('http://127.0.0.1:7331/console');
    expect(joinUrl('http://127.0.0.1:7331/', 'console')).toBe('http://127.0.0.1:7331/console');
    expect(joinUrl('http://127.0.0.1:7331///', '///mcp')).toBe('http://127.0.0.1:7331/mcp');
    expect(joinUrl('http://127.0.0.1:7331', '')).toBe('http://127.0.0.1:7331');
  });

  it('isLoopbackUrl 只接受 loopback http(s)，拒绝 127.evil.com 之类后缀', () => {
    for (const value of [
      'http://127.0.0.1:7331',
      'http://127.1.2.3:7331',
      'http://localhost:7331',
      'http://foo.localhost:7331',
      'http://[::1]:7331',
      'https://127.0.0.1:7331',
    ]) {
      expect(isLoopbackUrl(value)).toBe(true);
    }
    for (const value of [
      'http://10.0.0.5:7331',
      'http://localhost.example.com:7331',
      'http://127.evil.com:7331',
      'http://192.168.1.1:7331',
      'ftp://127.0.0.1:7331',
      'not a url',
      '',
    ]) {
      expect(isLoopbackUrl(value)).toBe(false);
    }
  });

  it('isLoopbackAddress 接受 IP 回环形式，拒绝主机名与非回环 IP', () => {
    for (const value of ['127.0.0.1', '127.9.9.9', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1']) {
      expect(isLoopbackAddress(value)).toBe(true);
    }
    for (const value of ['10.0.0.1', '::2', '::ffff:10.0.0.1', 'localhost', '127.evil.com', '', undefined]) {
      expect(isLoopbackAddress(value)).toBe(false);
    }
  });

  it('buildEmbedInfo：健康且 loopback 时 ok=true、reason=null', () => {
    const info = buildEmbedInfo({ daemonUrl: BASE, reachable: true, health: HEALTH, embed: EMBED });
    expect(info).toEqual({
      ok: true,
      status: 'up',
      state: 'up',
      mode: 'attach',
      runtimeMode: null,
      managed: false,
      panel: true,
      daemonUrl: BASE,
      version: '0.1.0',
      profile: null,
      provider: null,
      service: null,
      downloadRequired: false,
      install: null,
      update: null,
      upgrade: null,
      embedProtocol: EMBED_PROTOCOL,
      consoleUrl: `${BASE}/console`,
      embedUrl: `${BASE}/console/?embed=dsh`,
      mcpUrl: `${BASE}/mcp`,
      loopback: true,
      reason: null,
    });
    expect(Object.keys(info).sort()).toEqual([
      'consoleUrl', 'daemonUrl', 'downloadRequired', 'embedProtocol', 'embedUrl', 'install', 'loopback',
      'managed', 'mcpUrl', 'mode', 'ok', 'panel', 'profile', 'provider', 'reason',
      'runtimeMode', 'service', 'state', 'status', 'update', 'upgrade', 'version',
    ]);
    const serialized = JSON.stringify(info).toLowerCase();
    for (const word of ['token', 'secret', 'password', 'authorization']) {
      expect(serialized).not.toContain(word);
    }
  });

  it('buildEmbedInfo：daemon 不可达时 ok=false、status=down、embedUrl=null', () => {
    const info = buildEmbedInfo({ daemonUrl: BASE, reachable: false, health: null, embed: null });
    expect(info).toMatchObject({
      ok: false,
      status: 'down',
      version: null,
      embedProtocol: null,
      consoleUrl: `${BASE}/console`,
      embedUrl: null,
      mcpUrl: `${BASE}/mcp`,
      loopback: false,
      reason: 'daemon_unreachable',
    });
  });

  it('buildEmbedInfo：非 loopback daemon 明确拒绝嵌入', () => {
    const info = buildEmbedInfo({
      daemonUrl: 'http://10.0.0.5:7331',
      reachable: true,
      health: HEALTH,
      embed: { ...EMBED, consoleUrl: 'http://10.0.0.5:7331/console', embedUrl: 'http://10.0.0.5:7331/console/?embed=dsh' },
    });
    expect(info.status).toBe('up');
    expect(info.ok).toBe(false);
    expect(info.loopback).toBe(false);
    expect(info.embedUrl).toBeNull();
    expect(info.reason).toBe('not_loopback');
  });

  it('buildEmbedInfo：embedConsole=false / 协议不匹配时拒绝 iframe', () => {
    const disabled = buildEmbedInfo({
      daemonUrl: BASE,
      reachable: true,
      health: HEALTH,
      embed: { ...EMBED, capabilities: { embedConsole: false } },
    });
    expect(disabled.ok).toBe(false);
    expect(disabled.reason).toBe('embed_unsupported');
    expect(disabled.embedUrl).toBeNull();

    const mismatch = buildEmbedInfo({
      daemonUrl: BASE,
      reachable: true,
      health: HEALTH,
      embed: { ...EMBED, embedProtocol: 2 },
    });
    expect(mismatch.status).toBe('up');
    expect(mismatch.ok).toBe(false);
    expect(mismatch.embedProtocol).toBe(2);
    expect(mismatch.embedUrl).toBeNull();
    expect(mismatch.reason).toBe('embed_protocol_unsupported');
  });

  it('buildEmbedInfo：缺少 /app/embed/info 时给出升级提示', () => {
    const info = buildEmbedInfo({ daemonUrl: BASE, reachable: true, health: HEALTH, embed: null });
    expect(info).toMatchObject({
      ok: false,
      status: 'up',
      version: '0.1.0',
      embedProtocol: null,
      embedUrl: null,
      reason: 'embed_info_unavailable',
    });
  });

  it('buildEmbedInfo：daemon 返回非 loopback embedUrl 时拒绝加载', () => {
    const info = buildEmbedInfo({
      daemonUrl: BASE,
      reachable: true,
      health: HEALTH,
      embed: { ...EMBED, embedUrl: 'http://10.0.0.5:7331/console/?embed=dsh' },
    });
    expect(info.ok).toBe(false);
    expect(info.embedUrl).toBeNull();
    expect(info.reason).toBe('embed_url_invalid');
  });

  it('buildEmbedInfo：starting 不嵌入、ok=false、managed 标记保留', () => {
    const info = buildEmbedInfo({
      daemonUrl: BASE,
      reachable: false,
      health: null,
      embed: null,
      status: 'starting',
      mode: 'managed',
      managed: true,
    });
    expect(info).toMatchObject({
      ok: false,
      status: 'starting',
      mode: 'managed',
      managed: true,
      embedUrl: null,
      reason: null,
    });
  });

  it('buildEmbedInfo：managed CLI 缺失时保留稳定 reason', () => {
    const info = buildEmbedInfo({
      daemonUrl: BASE,
      reachable: false,
      health: null,
      embed: null,
      status: 'down',
      mode: 'attach',
      reason: 'managed_cli_missing',
    });
    expect(info).toMatchObject({
      ok: false,
      status: 'down',
      mode: 'attach',
      managed: false,
      embedUrl: null,
      reason: 'managed_cli_missing',
    });
  });
});

describe('P4 @mebular/dsh-plugin host：runtime.json 发现优先级', () => {
  it('显式 daemonUrl > MEBULAR_HTTP_PORT > runtime.json > 7331', () => {
    const pidAlive = () => true;
    expect(resolveConfig(
      { daemonUrl: 'http://127.0.0.1:7000' },
      { env: { MEBULAR_HTTP_PORT: '8123' }, runtime: RUNTIME, pidAlive },
    ).daemonUrl).toBe('http://127.0.0.1:7000');

    expect(resolveConfig(
      {},
      { env: { MEBULAR_HTTP_PORT: '8123' }, runtime: RUNTIME, pidAlive },
    ).daemonUrl).toBe('http://127.0.0.1:8123');

    expect(resolveConfig(
      {},
      { env: {}, runtime: RUNTIME, pidAlive },
    ).daemonUrl).toBe('http://127.0.0.1:9123');

    expect(resolveConfig(
      {},
      { env: {}, runtime: null, pidAlive },
    ).daemonUrl).toBe('http://127.0.0.1:7331');
  });

  it('从 <home>/runtime.json 读取；MEBULAR_HOME 可指定 home', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mebular-dsh-runtime-'));
    try {
      await writeFile(join(home, 'runtime.json'), JSON.stringify(RUNTIME), 'utf-8');
      expect(resolveConfig(
        {},
        { env: { MEBULAR_HOME: home }, pidAlive: () => true },
      ).daemonUrl).toBe('http://127.0.0.1:9123');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('stale pid、损坏 JSON、非法字段都不阻塞，回退 7331', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mebular-dsh-runtime-'));
    try {
      await writeFile(join(home, 'runtime.json'), JSON.stringify(RUNTIME), 'utf-8');
      expect(resolveConfig(
        {},
        { env: { MEBULAR_HOME: home }, pidAlive: () => false },
      ).daemonUrl).toBe('http://127.0.0.1:7331');

      await writeFile(join(home, 'runtime.json'), '{not json', 'utf-8');
      expect(resolveConfig(
        {},
        { env: { MEBULAR_HOME: home }, pidAlive: () => true },
      ).daemonUrl).toBe('http://127.0.0.1:7331');

      await writeFile(join(home, 'runtime.json'), JSON.stringify({
        ...RUNTIME,
        http: { host: '127.0.0.1@evil.example', port: 9123 },
      }), 'utf-8');
      expect(resolveConfig(
        {},
        { env: { MEBULAR_HOME: home }, pidAlive: () => true },
      ).daemonUrl).toBe('http://127.0.0.1:7331');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('P5 @mebular/dsh-plugin host：运行时挂载官方 MCP client', () => {
  it('mountMcp 只动态 import 官方 peer，并用传入的 daemon origin 拼 /mcp', async () => {
    const plugins = [];
    const logs = [];
    const mcpModule = { name: 'fake-mcp-client' };
    const specifiers = [];
    const result = await mountMcp(
      { plugin: (module, config) => plugins.push({ module, config }) },
      'http://127.0.0.1:9123/',
      {
        importModule: async (specifier) => {
          specifiers.push(specifier);
          return mcpModule;
        },
        log: (level, message) => logs.push(`${level}:${message}`),
      },
    );

    expect(result.ok).toBe(true);
    expect(typeof result.dispose).toBe('function');
    expect(specifiers).toEqual([MCP_CLIENT_PACKAGE]);
    expect(MCP_CLIENT_PACKAGE).toBe('@deepseek-ai/dsh-mcp-client');
    expect(plugins).toEqual([{
      module: mcpModule,
      config: {
        serverName: 'mebular',
        transport: 'streamable-http',
        url: 'http://127.0.0.1:9123/mcp',
        failOnStartupError: true,
      },
    }]);
    expect(logs).toEqual(['info:mcp client mounted']);
  });

  it('mountMcp 等待 fiber settle 后才记录 mounted，并返回可 dispose 的 handle', async () => {
    const logs = [];
    const plugins = [];
    let settle;
    let disposeCalls = 0;
    const fiber = new Promise((resolve) => {
      settle = resolve;
    });
    fiber.dispose = () => {
      disposeCalls += 1;
    };
    const pending = mountMcp(
      {
        plugin: (module, config) => {
          plugins.push({ module, config });
          return fiber;
        },
      },
      BASE,
      {
        importModule: async () => ({ name: 'fake-mcp-client' }),
        log: (level, message) => logs.push(`${level}:${message}`),
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(plugins).toHaveLength(1);
    expect(logs).toEqual([]);

    settle();
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(logs).toEqual(['info:mcp client mounted']);
    await result.dispose();
    await result.dispose();
    expect(disposeCalls).toBe(1);
  });

  it('fiber 启动失败时 dispose 子 fiber 并返回稳定错误码', async () => {
    const logs = [];
    let disposeCalls = 0;
    const fiber = Promise.reject(new Error('/Users/me/.mebular token=secret'));
    fiber.dispose = () => {
      disposeCalls += 1;
    };
    const result = await mountMcp(
      { plugin: () => fiber },
      BASE,
      {
        importModule: async () => ({ name: 'fake-mcp-client' }),
        log: (level, message) => logs.push(`${level}:${message}`),
      },
    );

    expect(result).toEqual({ ok: false, code: 'mcp_client_start_failed' });
    expect(disposeCalls).toBe(1);
    expect(logs).toEqual(['warn:mcp client mount failed (mcp_client_start_failed)']);
    expect(logs.join('\n')).not.toContain('/Users/me');
    expect(logs.join('\n')).not.toContain('secret');
  });

  it('fiber 未进入 active 状态时不记录 mounted', async () => {
    const logs = [];
    let disposeCalls = 0;
    const fiber = {
      state: 0,
      then(resolve) {
        resolve({ settled: true });
      },
      dispose() {
        disposeCalls += 1;
      },
    };
    const result = await mountMcp(
      { plugin: () => fiber },
      BASE,
      {
        importModule: async () => ({ name: 'fake-mcp-client' }),
        log: (level, message) => logs.push(`${level}:${message}`),
      },
    );

    expect(result).toEqual({ ok: false, code: 'mcp_client_start_failed' });
    expect(disposeCalls).toBe(1);
    expect(logs).toEqual(['warn:mcp client mount failed (mcp_client_start_failed)']);
  });

  it('peer 缺失（Jest/普通 Node）不抛错、不激活 plugin，只记稳定错误码', async () => {
    const plugins = [];
    const logs = [];
    const error = new Error('Cannot find package at /Users/me/.dsh/node_modules');
    error.code = 'ERR_MODULE_NOT_FOUND';
    const result = await mountMcp(
      { plugin: (module, config) => plugins.push({ module, config }) },
      BASE,
      {
        importModule: async () => {
          throw error;
        },
        log: (level, message) => logs.push(`${level}:${message}`),
      },
    );

    expect(result).toEqual({ ok: false, code: 'peer_missing' });
    expect(plugins).toHaveLength(0);
    expect(logs).toEqual(['warn:mcp client mount failed (peer_missing)']);
    expect(logs.join('\n')).not.toContain('/Users/me');
  });

  it('没有 ctx.plugin 时跳过挂载，不影响其他能力', async () => {
    const logs = [];
    const result = await mountMcp({}, BASE, {
      importModule: async () => {
        throw new Error('must not import without ctx.plugin');
      },
      log: (level, message) => logs.push(`${level}:${message}`),
    });
    expect(result).toEqual({ ok: false, code: 'ctx_unavailable' });
    expect(logs).toEqual(['warn:mcp client mount failed (ctx_unavailable)']);
  });

  it('apply 用 runtime.json 发现的非默认端口挂载 MCP（panel:false 也挂载）', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mebular-dsh-mount-'));
    try {
      await writeFile(join(home, 'runtime.json'), JSON.stringify(RUNTIME), 'utf-8');
      const harness = applyHarness(
        (url) => {
          if (url === 'http://127.0.0.1:9123/healthz') return jsonResponse(HEALTH);
          if (url === 'http://127.0.0.1:9123/app/embed/info') {
            return jsonResponse({
              ...EMBED,
              consoleUrl: 'http://127.0.0.1:9123/console',
              embedUrl: 'http://127.0.0.1:9123/console/?embed=dsh',
              mcpUrl: 'http://127.0.0.1:9123/mcp',
            });
          }
          throw new Error(`unexpected ${url}`);
        },
        {
          config: { panel: false },
          applyOptions: {
            env: {},
            home,
            pidAlive: () => true,
            runtime: undefined,
          },
        },
      );
      activeMock = harness.mock;

      await waitFor(() => harness.plugins.length === 1);
      expect(harness.plugins[0].config).toMatchObject({
        serverName: 'mebular',
        transport: 'streamable-http',
        url: 'http://127.0.0.1:9123/mcp',
        failOnStartupError: true,
      });
      expect(harness.intervals).toHaveLength(1);

      const res = makeResponse();
      await harness.route.handler(makeRequest(), res);
      expect(JSON.parse(res.body)).toMatchObject({
        ok: true,
        status: 'up',
        panel: false,
        mcpUrl: 'http://127.0.0.1:9123/mcp',
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('apply 的 MCP 挂载失败仍注册只读路由，只记录一次稳定错误码', async () => {
    const harness = applyHarness(
      (url) => {
        if (url === `${BASE}/healthz`) return jsonResponse(HEALTH);
        if (url === `${BASE}/app/embed/info`) return jsonResponse(EMBED);
        throw new Error(`unexpected ${url}`);
      },
      {
        importModule: async () => {
          const error = new Error('missing peer at /Users/me/.dsh');
          error.code = 'ERR_MODULE_NOT_FOUND';
          throw error;
        },
      },
    );
    activeMock = harness.mock;

    await waitFor(() => harness.warnings.some((line) => line.includes('peer_missing')));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(harness.warnings.filter((line) => line.includes('peer_missing'))).toHaveLength(1);
    expect(harness.warnings.join('\n')).not.toContain('/Users/me');
    expect(harness.route).toBeDefined();

    const res = makeResponse();
    await harness.route.handler(makeRequest(), res);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe('up');
  });
});

describe('P6 @mebular/dsh-plugin host：MCP bridge supervisor', () => {
  it('attach + daemon down：不挂载、路由仍为 down、只记一次 unavailable 且只有一个 timer', async () => {
    const harness = applyHarness(() => {
      throw new Error('ECONNREFUSED');
    });
    activeMock = harness.mock;

    await waitFor(() => harness.warnings.some((line) => line.includes('mcp bridge unavailable')));
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(harness.plugins).toHaveLength(0);
    expect(harness.intervals).toHaveLength(1);
    expect(harness.warnings).toEqual([
      expect.stringContaining('mcp bridge unavailable (daemon_unreachable): start the Mebular app or run "mebular serve"'),
    ]);

    const res = makeResponse();
    await harness.route.handler(makeRequest(), res);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      ok: false,
      status: 'down',
      reason: 'daemon_unreachable',
      embedUrl: null,
    });

    await harness.cleanup();
    expect(harness.intervals[0].cleared).toBe(true);
  });

  it('daemon down→up：自动挂载一次，只有 mount 成功后才记录 mounted', async () => {
    let reachable = false;
    const harness = applyHarness((url) => {
      if (url === `${BASE}/healthz`) return reachable ? jsonResponse(HEALTH) : jsonResponse({ status: 'down' });
      if (url === `${BASE}/app/embed/info`) return reachable ? jsonResponse(EMBED) : jsonResponse({ ok: false });
      throw new Error(`unexpected ${url}`);
    });
    activeMock = harness.mock;

    await waitFor(() => harness.warnings.some((line) => line.includes('daemon_unreachable')));
    expect(harness.plugins).toHaveLength(0);
    expect(harness.infos.filter((line) => line.includes('mcp client mounted'))).toHaveLength(0);

    reachable = true;
    await waitFor(() => harness.plugins.length === 1);
    await waitFor(() => harness.infos.some((line) => line.includes('mcp client mounted')));
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(harness.plugins).toHaveLength(1);
    expect(harness.infos.filter((line) => line.includes('mcp client mounted'))).toHaveLength(1);
    expect(harness.plugins[0].config.serverName).toBe('mebular');
  });

  it('daemon up→down：dispose bridge、工具注销；再次 up 重新挂载且 serverName 不重复', async () => {
    let reachable = true;
    const harness = applyHarness((url) => {
      if (url === `${BASE}/healthz`) return reachable ? jsonResponse(HEALTH) : jsonResponse({ status: 'down' });
      if (url === `${BASE}/app/embed/info`) return reachable ? jsonResponse(EMBED) : jsonResponse({ ok: false });
      throw new Error(`unexpected ${url}`);
    });
    activeMock = harness.mock;

    await waitFor(() => harness.plugins.length === 1);
    expect(harness.plugins[0].disposed).toBe(false);

    reachable = false;
    await waitFor(() => harness.plugins[0].disposed);
    expect(harness.warnings.join('\n')).toContain('mcp bridge detached (daemon_unreachable): MCP tools unregistered');
    expect(harness.plugins).toHaveLength(1);

    reachable = true;
    await waitFor(() => harness.plugins.length === 2);
    expect(harness.plugins[0].disposed).toBe(true);
    expect(harness.plugins[1].disposed).toBe(false);
    expect(harness.plugins[1].config.serverName).toBe('mebular');
    expect(harness.activeNames.has('mebular')).toBe(true);

    await harness.cleanup();
    expect(harness.plugins[1].disposed).toBe(true);
    expect(harness.activeNames.size).toBe(0);
  });

  it('managed starting：不提前挂载；失败后记录明确原因且不挂载', async () => {
    let snapshot = {
      status: 'starting',
      mode: 'managed',
      managed: true,
      reason: null,
      reachable: false,
      health: null,
      embed: null,
    };
    const lifecycle = {
      start: async () => snapshot,
      inspect: async () => snapshot,
      dispose: () => {},
    };
    const harness = applyHarness(() => {
      throw new Error('fetch must not run with a fake lifecycle');
    }, {
      config: { daemonUrl: BASE, lifecycle: 'managed' },
      applyOptions: { lifecycle },
    });
    activeMock = harness.mock;

    await waitFor(() => harness.infos.some((line) => line.includes('daemon_starting')));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(harness.plugins).toHaveLength(0);
    expect(harness.infos.filter((line) => line.includes('daemon_starting'))).toHaveLength(1);

    snapshot = {
      ...snapshot,
      status: 'down',
      managed: false,
      reason: 'managed_start_failed',
    };
    await waitFor(() => harness.warnings.some((line) => line.includes('managed_start_failed')));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(harness.plugins).toHaveLength(0);
    expect(harness.warnings.filter((line) => line.includes('managed_start_failed'))).toHaveLength(1);
  });

  it('managed CLI 缺失：不挂载并记录稳定 reason', async () => {
    const snapshot = {
      status: 'down',
      mode: 'attach',
      managed: false,
      reason: 'managed_cli_missing',
      reachable: false,
      health: null,
      embed: null,
    };
    const lifecycle = {
      start: async () => snapshot,
      inspect: async () => snapshot,
      dispose: () => {},
    };
    const harness = applyHarness(() => {
      throw new Error('fetch must not run with a fake lifecycle');
    }, {
      config: { daemonUrl: BASE, lifecycle: 'managed' },
      applyOptions: { lifecycle },
    });
    activeMock = harness.mock;

    await waitFor(() => harness.warnings.some((line) => line.includes('managed_cli_missing')));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(harness.plugins).toHaveLength(0);
    expect(harness.warnings.join('\n')).toContain('mcp bridge unavailable (managed_cli_missing)');
    expect(harness.warnings.join('\n')).not.toContain('/opt/');
  });

  it('peer 缺失：不崩溃、不刷日志，面板路由仍工作', async () => {
    const harness = applyHarness((url) => {
      if (url === `${BASE}/healthz`) return jsonResponse(HEALTH);
      if (url === `${BASE}/app/embed/info`) return jsonResponse(EMBED);
      throw new Error(`unexpected ${url}`);
    }, {
      importModule: async () => {
        const error = new Error('missing peer at /Users/me/.dsh');
        error.code = 'ERR_MODULE_NOT_FOUND';
        throw error;
      },
    });
    activeMock = harness.mock;

    await waitFor(() => harness.warnings.some((line) => line.includes('peer_missing')));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(harness.plugins).toHaveLength(0);
    expect(harness.warnings.filter((line) => line.includes('peer_missing'))).toHaveLength(1);

    const res = makeResponse();
    await harness.route.handler(makeRequest(), res);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, status: 'up' });
  });

  it('panel:false 仍运行 bridge supervisor', async () => {
    const harness = applyHarness((url) => {
      if (url === `${BASE}/healthz`) return jsonResponse(HEALTH);
      if (url === `${BASE}/app/embed/info`) return jsonResponse(EMBED);
      throw new Error(`unexpected ${url}`);
    }, { panel: false });
    activeMock = harness.mock;

    await waitFor(() => harness.plugins.length === 1);
    expect(harness.intervals).toHaveLength(1);
    expect(harness.taps).toHaveLength(1);
    expect(harness.plugins[0].config.serverName).toBe('mebular');
  });

  it('supervisor start 幂等，mount 失败按稳定 code 去重', async () => {
    let intervalCalls = 0;
    let clearCalls = 0;
    const warnings = [];
    const supervisor = createMcpBridgeSupervisor({
      lifecycle: {
        inspect: async () => ({
          status: 'up',
          mode: 'attach',
          managed: false,
          reason: null,
          reachable: true,
          health: HEALTH,
          embed: EMBED,
        }),
      },
      daemonUrl: BASE,
      mount: async () => ({ ok: false, code: 'peer_missing' }),
      log: (level, message) => {
        if (level === 'warn') warnings.push(message);
      },
      intervalMs: 1000,
      setIntervalFn: () => {
        intervalCalls += 1;
        return { unref() {} };
      },
      clearIntervalFn: () => {
        clearCalls += 1;
      },
    });

    await supervisor.start();
    await supervisor.start();
    await supervisor.check();
    await supervisor.check();
    expect(intervalCalls).toBe(1);
    expect(warnings.filter((line) => line.includes('peer_missing'))).toHaveLength(1);
    expect(supervisor.getState()).toMatchObject({ mounted: false, timer: true, disposed: false });

    await supervisor.dispose();
    await supervisor.dispose();
    expect(clearCalls).toBe(1);
    expect(supervisor.getState()).toMatchObject({ timer: false, disposed: true });
  });

  it('apply dispose：清 timer、dispose bridge、dispose lifecycle，且不再探测', async () => {
    let inspectCalls = 0;
    let lifecycleDisposed = 0;
    const snapshot = {
      status: 'up',
      mode: 'attach',
      managed: false,
      reason: null,
      reachable: true,
      health: HEALTH,
      embed: EMBED,
    };
    const lifecycle = {
      start: async () => snapshot,
      inspect: async () => {
        inspectCalls += 1;
        return snapshot;
      },
      dispose: () => {
        lifecycleDisposed += 1;
      },
    };
    const harness = applyHarness(() => {
      throw new Error('fetch must not run with a fake lifecycle');
    }, {
      config: { daemonUrl: BASE },
      applyOptions: { lifecycle },
    });
    activeMock = harness.mock;

    await waitFor(() => harness.plugins.length === 1);
    expect(harness.intervals).toHaveLength(1);

    await harness.cleanup();
    expect(harness.intervals[0].cleared).toBe(true);
    expect(harness.plugins[0].disposed).toBe(true);
    expect(lifecycleDisposed).toBe(1);

    const before = inspectCalls;
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(inspectCalls).toBe(before);

    await harness.cleanup();
    expect(lifecycleDisposed).toBe(1);
  });

  it('apply effect 等待 lifecycle.dispose 完成，DSH unload 不会提前结束', async () => {
    const order = [];
    const snapshot = {
      status: 'up',
      mode: 'attach',
      managed: false,
      reason: null,
      reachable: true,
      health: HEALTH,
      embed: EMBED,
    };
    const lifecycle = {
      start: async () => snapshot,
      inspect: async () => snapshot,
      dispose: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push('lifecycle');
      },
    };
    const harness = applyHarness(() => {
      throw new Error('fetch must not run with a fake lifecycle');
    }, {
      config: {},
      applyOptions: { lifecycle },
    });
    activeMock = harness.mock;

    await waitFor(() => harness.plugins.length === 1);
    await harness.cleanup();
    expect(order).toEqual(['lifecycle']);
    expect(harness.intervals[0].cleared).toBe(true);
  });

  it('apply 跟随 resolve 的非默认端口：embed-info、MCP bridge 与 panel 使用同一动态 URL', async () => {
    const provider = appProvider();
    const harness = applyHarness(
      (url) => {
        if (url === 'http://127.0.0.1:9123/healthz') {
          return jsonResponse({ ...HEALTH, version: '0.2.0' });
        }
        if (url === 'http://127.0.0.1:9123/app/embed/info') {
          return jsonResponse(embedFor('http://127.0.0.1:9123'));
        }
        throw new Error(`unexpected ${url}`);
      },
      {
        config: {},
        applyOptions: {
          discoverProviders: async () => discoveryFor(provider),
          runResolve: async () => ({ ok: true, data: resolveDocument({ mode: 'reused' }) }),
        },
      },
    );
    activeMock = harness.mock;

    await waitFor(() => harness.plugins.length === 1);
    expect(harness.plugins[0].config).toMatchObject({
      serverName: 'mebular',
      url: 'http://127.0.0.1:9123/mcp',
    });

    const res = makeResponse();
    harness.mock.calls.length = 0;
    await harness.route.handler(makeRequest(), res);
    const info = JSON.parse(res.body);
    expect(info).toMatchObject({
      ok: true,
      status: 'up',
      daemonUrl: 'http://127.0.0.1:9123',
      consoleUrl: 'http://127.0.0.1:9123/console',
      embedUrl: 'http://127.0.0.1:9123/console/?embed=dsh',
      mcpUrl: 'http://127.0.0.1:9123/mcp',
      profile: { id: 'work', name: 'Work' },
      provider: { kind: 'app' },
      downloadRequired: false,
    });
    expect(harness.mock.calls.length).toBeGreaterThan(0);
    expect(harness.mock.calls.every((call) => call.url.startsWith('http://127.0.0.1:9123'))).toBe(true);
  });

  it('apply + 无 provider + down：route 返回 download_required，不 spawn', async () => {
    let spawnCalls = 0;
    const harness = applyHarness(
      () => {
        throw new Error('ECONNREFUSED');
      },
      {
        config: {},
        applyOptions: {
          spawnFn: () => {
            spawnCalls += 1;
            throw new Error('must not spawn');
          },
        },
      },
    );
    activeMock = harness.mock;

    await waitFor(() => harness.warnings.some((line) => line.includes('download_required')));
    const res = makeResponse();
    await harness.route.handler(makeRequest(), res);
    expect(JSON.parse(res.body)).toMatchObject({
      ok: false,
      status: 'down',
      state: 'download_required',
      reason: 'download_required',
      downloadRequired: true,
      embedUrl: null,
    });
    expect(spawnCalls).toBe(0);
  });

  it('daemon URL 变化：MCP bridge 先 unmount 再 remount，不并存两个实例', async () => {
    let snapshot = {
      status: 'up',
      mode: 'attach',
      managed: false,
      reason: null,
      reachable: true,
      health: HEALTH,
      embed: EMBED,
      daemonUrl: 'http://127.0.0.1:7331',
    };
    const mounts = [];
    const disposed = [];
    const supervisor = createMcpBridgeSupervisor({
      lifecycle: { inspect: async () => snapshot },
      daemonUrl: 'http://127.0.0.1:7331',
      mount: async (url) => {
        mounts.push(url);
        return { ok: true, dispose: async () => { disposed.push(url); } };
      },
      intervalMs: 1000,
      setIntervalFn: () => ({ unref() {} }),
      clearIntervalFn: () => {},
    });

    await supervisor.check();
    expect(mounts).toEqual(['http://127.0.0.1:7331']);
    expect(supervisor.getState()).toMatchObject({ mounted: true, mountedUrl: 'http://127.0.0.1:7331' });

    snapshot = { ...snapshot, daemonUrl: 'http://127.0.0.1:9123' };
    await supervisor.check();
    expect(disposed).toEqual(['http://127.0.0.1:7331']);
    expect(mounts).toEqual(['http://127.0.0.1:7331', 'http://127.0.0.1:9123']);
    expect(supervisor.getState()).toMatchObject({ mounted: true, mountedUrl: 'http://127.0.0.1:9123' });

    await supervisor.dispose();
    expect(disposed).toEqual(['http://127.0.0.1:7331', 'http://127.0.0.1:9123']);
  });
});

describe('P7 @mebular/dsh-plugin host：Agent 可见状态', () => {
  it('agentStatusText：up 为空；非 up 给出短且可行动的恢复文案', () => {
    expect(agentStatusText({ status: 'up', reason: null })).toBe('');
    expect(agentStatusText(null)).toBe('');
    expect(agentStatusText({ status: 'unknown' })).toBe('');

    const starting = agentStatusText({ status: 'starting' });
    expect(starting).toContain('temporarily unavailable');
    expect(starting).not.toContain('do not claim');

    const down = agentStatusText({ status: 'down', reason: null });
    expect(down).toContain('not running');
    expect(down).toContain('mebular serve');
    expect(down).toContain('do not claim Mebular memory is available');

    const unhealthy = agentStatusText({ status: 'down', reason: null, health: { status: 'degraded' } });
    expect(unhealthy).toContain('not healthy');
    expect(unhealthy).toContain('do not claim Mebular memory is available');

    const cliMissing = agentStatusText({ status: 'down', reason: 'managed_cli_missing' });
    expect(cliMissing).toContain('CLI was not found');
    expect(cliMissing).toContain('MEBULAR_CLI');
    expect(cliMissing).toContain('install Mebular');

    const startFailed = agentStatusText({ status: 'down', reason: 'managed_start_failed' });
    expect(startFailed).toContain('failed to start');
    expect(startFailed).toContain('logs');
    expect(startFailed).toContain('mebular serve');

    for (const text of [starting, down, unhealthy, cliMissing, startFailed]) {
      expect(text.length).toBeLessThan(360);
    }
  });

  it('apply 注册唯一的 mebular:status section；down 只 emit 一次', async () => {
    const harness = applyHarness(() => {
      throw new Error('ECONNREFUSED');
    });
    activeMock = harness.mock;

    expect(harness.agentSections.size).toBe(1);
    const section = harness.agentSections.get(AGENT_STATUS_SECTION);
    expect(section).toBeDefined();
    expect(section.order).toBe(AGENT_STATUS_ORDER);
    expect(typeof section.text).toBe('function');

    await waitFor(() => section.text({}).includes('mebular serve'));
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(section.text({})).toContain('not running');
    expect(section.text({})).toContain('do not claim Mebular memory is available');
    expect(harness.events.filter((event) => event === 'system-prompt/change')).toHaveLength(1);
  });

  it('up 时 section 文本为空，不产生 prompt token 或 change 事件', async () => {
    const harness = applyHarness((url) => {
      if (url === `${BASE}/healthz`) return jsonResponse(HEALTH);
      if (url === `${BASE}/app/embed/info`) return jsonResponse(EMBED);
      throw new Error(`unexpected ${url}`);
    }, { applyOptions: { bridgeIntervalMs: 60000 } });
    activeMock = harness.mock;

    await waitFor(() => harness.plugins.length === 1);
    const section = harness.agentSections.get(AGENT_STATUS_SECTION);
    expect(section).toBeDefined();
    expect(section.text({})).toBe('');
    expect(harness.events).toHaveLength(0);
  });

  it('状态切换只在文本变化时 emit，持续轮询不刷屏', async () => {
    let snapshot = {
      status: 'down',
      mode: 'attach',
      managed: false,
      reason: null,
      reachable: false,
      health: null,
      embed: null,
    };
    const lifecycle = {
      start: async () => snapshot,
      inspect: async () => snapshot,
      dispose: () => {},
    };
    const harness = applyHarness(() => {
      throw new Error('fetch must not run with a fake lifecycle');
    }, {
      applyOptions: { lifecycle, bridgeIntervalMs: 5 },
    });
    activeMock = harness.mock;

    await waitFor(() => harness.events.length === 1);
    expect(harness.agentSections.get(AGENT_STATUS_SECTION).text({})).toContain('not running');
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(harness.events).toHaveLength(1);

    snapshot = {
      ...snapshot,
      status: 'up',
      reachable: true,
      health: HEALTH,
      embed: EMBED,
    };
    await waitFor(() => harness.agentSections.get(AGENT_STATUS_SECTION).text({}) === '');
    expect(harness.events).toHaveLength(2);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(harness.events).toHaveLength(2);

    snapshot = {
      ...snapshot,
      status: 'down',
      reachable: false,
      health: null,
      embed: null,
    };
    await waitFor(() => harness.agentSections.get(AGENT_STATUS_SECTION).text({}).length > 0);
    expect(harness.events).toHaveLength(3);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(harness.events).toHaveLength(3);
  });

  it('panel:false 仍注册 Agent 状态 section（它不是 UI 面板）', async () => {
    const harness = applyHarness(() => {
      throw new Error('ECONNREFUSED');
    }, { panel: false });
    activeMock = harness.mock;

    expect(harness.agentSections.get(AGENT_STATUS_SECTION)).toBeDefined();
    await waitFor(() => harness.agentSections.get(AGENT_STATUS_SECTION).text({}).length > 0);
    expect(harness.taps).toHaveLength(1);
    expect(harness.plugins).toHaveLength(0);
  });

  it('没有 systemPrompt 服务时安全跳过，面板/MCP/状态路由不受影响', async () => {
    const harness = applyHarness((url) => {
      if (url === `${BASE}/healthz`) return jsonResponse(HEALTH);
      if (url === `${BASE}/app/embed/info`) return jsonResponse(EMBED);
      throw new Error(`unexpected ${url}`);
    }, { systemPrompt: false });
    activeMock = harness.mock;

    await waitFor(() => harness.plugins.length === 1);
    expect(harness.agentSections.size).toBe(0);
    expect(harness.events).toHaveLength(0);
    expect(harness.warnings).toHaveLength(0);

    const res = makeResponse();
    await harness.route.handler(makeRequest(), res);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe('up');
  });

  it('systemPrompt 服务晚于状态更新可用时，section 仍读取最新文本', () => {
    const sections = new Map();
    const service = {
      section(section) {
        sections.set(section.name, section);
        return () => sections.delete(section.name);
      },
    };
    const status = createAgentStatus();
    expect(status.update({ status: 'down', reason: null })).toBe(true);
    expect(status.isRegistered()).toBe(false);

    expect(status.bind(service, { emit: () => {} })).toBe(true);
    expect(status.isRegistered()).toBe(true);
    expect(sections.get(AGENT_STATUS_SECTION).text({})).toContain('not running');
    status.dispose();
    expect(sections.size).toBe(0);
  });

  it('重复挂载安全：同名 section 只注册一次，dispose 后移除', () => {
    const sections = new Map();
    const service = {
      section(section) {
        if (sections.has(section.name)) throw new Error('duplicate');
        sections.set(section.name, section);
        return () => {
          sections.delete(section.name);
        };
      },
    };
    const eventsA = [];
    const eventsB = [];
    const first = createAgentStatus();
    const second = createAgentStatus();
    expect(first.bind(service, { emit: (event) => eventsA.push(event) })).toBe(true);
    expect(second.bind(service, { emit: (event) => eventsB.push(event) })).toBe(false);

    expect(first.isRegistered()).toBe(true);
    expect(second.isRegistered()).toBe(false);
    expect(sections.size).toBe(1);
    expect(sections.get(AGENT_STATUS_SECTION).text({})).toBe('');

    expect(first.update({ status: 'down', reason: null })).toBe(true);
    expect(second.update({ status: 'down', reason: null })).toBe(true);
    expect(eventsA).toEqual(['system-prompt/change']);
    expect(eventsB).toEqual([]);
    expect(first.update({ status: 'down', reason: null })).toBe(false);
    expect(eventsA).toEqual(['system-prompt/change']);

    first.dispose();
    expect(sections.size).toBe(0);
    expect(first.update({ status: 'starting' })).toBe(false);
    second.dispose();
  });
});

describe('P4 @mebular/dsh-plugin host：panel 注入与日志脱敏', () => {
  it('scriptJson 转义 <、U+2028/U+2029', () => {
    const json = scriptJson({ panel: false, attack: '</script><script>alert(1)</script>', line: '\u2028\u2029' });
    expect(json).toContain('\\u003c/script>');
    expect(json).not.toContain('</script>');
    expect(json).toContain('\\u2028');
    expect(json).toContain('\\u2029');
  });

  it('injectPanelGlobal 注入 head 且重复调用不叠加', () => {
    const html = '<!doctype html><html><head><title>x</title></head><body></body></html>';
    const once = injectPanelGlobal(html, false);
    expect(once).toContain(`${PANEL_GLOBAL}={"panel":false}`);
    expect(once.indexOf('</head>')).toBeGreaterThan(once.indexOf(PANEL_GLOBAL));
    expect(injectPanelGlobal(once, false)).toBe(once);
    expect(injectPanelGlobal('<html><body></body></html>', true)).toContain(`${PANEL_GLOBAL}={"panel":true}`);
  });

  it('redactLogLine 保留键名/协议，替换敏感值与 home/CLI 路径', () => {
    const line = 'token=abc123 secret: "shh" password=pw api_key: key-9 Authorization: Bearer eyJhbGciOi '
      + '{"refresh_token":"rt-1"} --home=/Users/me/.mebular /opt/mebular serve';
    const redacted = redactLogLine(line, { home: '/Users/me/.mebular', cliPath: '/opt/mebular' });
    expect(redacted).toContain('token=<redacted>');
    expect(redacted).toContain('secret: "<redacted>"');
    expect(redacted).toContain('password=<redacted>');
    expect(redacted).toContain('api_key: <redacted>');
    expect(redacted).toContain('Authorization: Bearer <redacted>');
    expect(redacted).toContain('"refresh_token":"<redacted>"');
    expect(redacted).toContain('--home=<home>');
    expect(redacted).toContain('<cli> serve');
    for (const secret of ['abc123', 'shh', 'pw', 'key-9', 'eyJhbGciOi', 'rt-1', '/Users/me/.mebular', '/opt/mebular']) {
      expect(redacted).not.toContain(secret);
    }
  });

  it('redactLogLine 限制单行长度', () => {
    const redacted = redactLogLine('x'.repeat(900));
    expect(redacted.length).toBeLessThanOrEqual(501);
    expect(redacted.endsWith('…')).toBe(true);
  });
});

describe('P2 @mebular/dsh-plugin host：探测与 /mebular/embed-info 路由', () => {
  it('probeDaemon 并行读取 /healthz 与 /app/embed/info', async () => {
    const calls = [];
    const result = await probeDaemon({
      daemonUrl: BASE,
      timeoutMs: 50,
      fetchImpl: async (url) => {
        calls.push(url);
        if (url === `${BASE}/healthz`) return jsonResponse(HEALTH);
        if (url === `${BASE}/app/embed/info`) return jsonResponse(EMBED);
        throw new Error(`unexpected ${url}`);
      },
    });
    expect(result.reachable).toBe(true);
    expect(result.health).toEqual(HEALTH);
    expect(result.embed).toEqual(EMBED);
    expect(calls).toEqual([`${BASE}/healthz`, `${BASE}/app/embed/info`]);
  });

  it('probeDaemon 在 daemon 不可达时不抛错', async () => {
    const result = await probeDaemon({
      daemonUrl: BASE,
      timeoutMs: 50,
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    expect(result.reachable).toBe(false);
    expect(result.health).toBeNull();
    expect(result.embed).toBeNull();
  });

  it('注册 exact 路由并返回 up + no-store JSON', async () => {
    const harness = applyHarness((url) => {
      if (url === `${BASE}/healthz`) return jsonResponse(HEALTH);
      if (url === `${BASE}/app/embed/info`) return jsonResponse(EMBED);
      throw new Error(`unexpected ${url}`);
    }, { applyOptions: { bridgeIntervalMs: 60000 } });
    activeMock = harness.mock;

    expect(harness.routes).toHaveLength(3);
    expect(harness.routes[0]).toMatchObject({ kind: 'exact', path: EMBED_INFO_PATH });
    expect(harness.routes[1]).toMatchObject({ kind: 'exact', path: '/mebular/runtime/install' });
    expect(harness.routes[2]).toMatchObject({ kind: 'exact', path: '/mebular/runtime/upgrade' });
    expect(typeof harness.routes[1].handler).toBe('function');
    expect(typeof harness.routes[2].handler).toBe('function');

    const res = makeResponse();
    await harness.route.handler(makeRequest(), res);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(res.body)).toMatchObject({
      ok: true,
      status: 'up',
      embedProtocol: 1,
      embedUrl: `${BASE}/console/?embed=dsh`,
      reason: null,
    });
    expect(harness.mock.calls.map((call) => call.url)).toEqual([
      `${BASE}/healthz`,
      `${BASE}/app/embed/info`,
    ]);
  });

  it('panel:false：tapIndex 注入安全全局，embed-info 同步返回 panel=false', async () => {
    const harness = applyHarness((url) => {
      if (url === `${BASE}/healthz`) return jsonResponse(HEALTH);
      if (url === `${BASE}/app/embed/info`) return jsonResponse(EMBED);
      throw new Error(`unexpected ${url}`);
    }, { panel: false });
    activeMock = harness.mock;

    expect(harness.taps).toHaveLength(1);
    const html = harness.taps[0]('<html><head><title>dsh</title></head><body></body></html>');
    expect(html).toContain('window.__MEBULAR_DSH__={"panel":false}');
    expect(html.indexOf('window.__MEBULAR_DSH__')).toBeLessThan(html.indexOf('</head>'));

    const res = makeResponse();
    await harness.route.handler(makeRequest(), res);
    expect(JSON.parse(res.body).panel).toBe(false);
  });

  it('没有 tapIndex 时仍注册 embed-info，panel 值由 route 提供', async () => {
    const harness = applyHarness((url) => {
      if (url === `${BASE}/healthz`) return jsonResponse(HEALTH);
      if (url === `${BASE}/app/embed/info`) return jsonResponse(EMBED);
      throw new Error(`unexpected ${url}`);
    }, { panel: false, tapIndex: false });
    activeMock = harness.mock;

    expect(harness.taps).toHaveLength(0);
    expect(harness.route).toBeDefined();
    const res = makeResponse();
    await harness.route.handler(makeRequest(), res);
    expect(JSON.parse(res.body).panel).toBe(false);
  });

  it('1s 内重复请求命中缓存', async () => {
    const harness = applyHarness((url) => {
      if (url === `${BASE}/healthz`) return jsonResponse(HEALTH);
      if (url === `${BASE}/app/embed/info`) return jsonResponse(EMBED);
      throw new Error(`unexpected ${url}`);
    }, { applyOptions: { bridgeIntervalMs: 60000, cacheTtlMs: 60000 } });
    activeMock = harness.mock;

    await waitFor(() => harness.plugins.length === 1);
    harness.mock.calls.length = 0;
    await harness.route.handler(makeRequest(), makeResponse());
    await harness.route.handler(makeRequest(), makeResponse());
    expect(harness.mock.calls).toHaveLength(0);
  });

  it('非 loopback 请求返回 404 且路由不触发探测（任何方法）', async () => {
    const harness = applyHarness(() => {
      throw new Error('fetch must not run');
    });
    activeMock = harness.mock;
    // The host plugin probes once on activation; only route-triggered calls matter here.
    await new Promise((resolve) => setTimeout(resolve, 0));
    harness.mock.calls.length = 0;

    for (const method of ['GET', 'POST']) {
      const res = makeResponse();
      await harness.route.handler(makeRequest({ method, remoteAddress: '192.168.1.7' }), res);
      expect(res.statusCode).toBe(404);
      expect(res.body).toBe('');
    }
    expect(harness.mock.calls).toHaveLength(0);

    const missing = makeResponse();
    await harness.route.handler(makeRequest({ remoteAddress: null }), missing);
    expect(missing.statusCode).toBe(404);
  });

  it('接受 IPv4-mapped loopback 请求', async () => {
    const harness = applyHarness((url) => {
      if (url === `${BASE}/healthz`) return jsonResponse(HEALTH);
      if (url === `${BASE}/app/embed/info`) return jsonResponse(EMBED);
      throw new Error(`unexpected ${url}`);
    });
    activeMock = harness.mock;

    const res = makeResponse();
    await harness.route.handler(makeRequest({ remoteAddress: '::ffff:127.0.0.1' }), res);
    expect(res.statusCode).toBe(200);
  });

  it('loopback 非 GET 返回 405 + Allow: GET', async () => {
    const harness = applyHarness(() => {
      throw new Error('fetch must not run');
    });
    activeMock = harness.mock;
    await new Promise((resolve) => setTimeout(resolve, 0));
    harness.mock.calls.length = 0;

    const res = makeResponse();
    await harness.route.handler(makeRequest({ method: 'POST' }), res);
    expect(res.statusCode).toBe(405);
    expect(res.headers.allow).toBe('GET');
    expect(res.body).toContain('method_not_allowed');
    expect(harness.mock.calls).toHaveLength(0);
  });

  it('daemon 不可达时仍返回 200 + status=down，不抛到 HTTP', async () => {
    const harness = applyHarness(() => {
      throw new Error('ECONNREFUSED');
    });
    activeMock = harness.mock;

    const res = makeResponse();
    await harness.route.handler(makeRequest(), res);
    expect(res.statusCode).toBe(200);
    const info = JSON.parse(res.body);
    expect(info.ok).toBe(false);
    expect(info.status).toBe('down');
    expect(info.embedUrl).toBeNull();
    expect(info.reason).toBe('daemon_unreachable');
  });

  it('createEmbedInfoHandler 支持注入 probe/now，便于复用', async () => {
    let probeCalls = 0;
    let clock = 0;
    const handler = createEmbedInfoHandler({
      config: { daemonUrl: BASE },
      probe: async () => {
        probeCalls += 1;
        return { reachable: true, health: HEALTH, embed: EMBED };
      },
      now: () => clock,
      cacheTtlMs: 1000,
    });

    const first = makeResponse();
    await handler(makeRequest(), first);
    expect(JSON.parse(first.body).ok).toBe(true);

    clock = 500;
    await handler(makeRequest(), makeResponse());
    expect(probeCalls).toBe(1);

    clock = 1500;
    await handler(makeRequest(), makeResponse());
    expect(probeCalls).toBe(2);
  });
});

describe('P8 @mebular/dsh-plugin：共享 runtime 发现', () => {
  it('注册表 app > cli > shared；显式 cliPath 是用户 pin', async () => {
    const exists = (file) => new Set([
      '/opt/App/mebular.mjs',
      '/opt/shared/mebular.mjs',
      '/usr/bin/mebular',
      '/pin/mebular',
    ]).has(file);
    const registry = {
      v: 1,
      providers: [
        { kind: 'shared', path: '/opt/shared/mebular.mjs', version: '0.1.0' },
        { kind: 'cli', path: '/usr/bin/mebular', version: '0.2.0' },
        { kind: 'app', path: '/opt/App/mebular.mjs', version: '0.3.0' },
      ],
    };
    const env = { PATH: '/usr/bin' };
    const base = { env, platform: 'linux', userHome: '/home/u', exists, registry, includeStandardApp: false };

    const discovery = await discoverRuntimeProviders(base);
    expect(discovery.providers.map((entry) => `${entry.kind}:${entry.path}`)).toEqual([
      'app:/opt/App/mebular.mjs',
      'cli:/usr/bin/mebular',
      'shared:/opt/shared/mebular.mjs',
    ]);
    expect(discovery.selected).toMatchObject({ kind: 'app', path: '/opt/App/mebular.mjs', source: 'registry' });
    expect(discovery.cloudRoot).toBe('/home/u/.mebular');

    const pinned = await discoverRuntimeProviders({ ...base, cliPath: '/pin/mebular' });
    expect(pinned.selected).toMatchObject({ kind: 'cli', path: '/pin/mebular', source: 'config' });
    expect(pinned.providers.map((entry) => entry.path)).toContain('/opt/App/mebular.mjs');
  });

  it('MEBULAR_CLI 优先于 PATH，路径不存在则跳过', async () => {
    const exists = (file) => new Set(['/env/mebular', '/usr/local/bin/mebular']).has(file);
    const discovery = await discoverRuntimeProviders({
      env: { PATH: '/usr/local/bin', MEBULAR_CLI: '/env/mebular' },
      platform: 'linux',
      userHome: '/home/u',
      exists,
      registry: { v: 1, providers: [] },
      includeStandardApp: false,
    });
    expect(discovery.selected).toMatchObject({ kind: 'cli', path: '/env/mebular', source: 'env' });

    const missing = await discoverRuntimeProviders({
      env: { PATH: '/usr/local/bin', MEBULAR_CLI: '/missing/mebular' },
      platform: 'linux',
      userHome: '/home/u',
      exists,
      registry: { v: 1, providers: [] },
      includeStandardApp: false,
    });
    expect(missing.selected).toMatchObject({ path: '/usr/local/bin/mebular', source: 'path' });
  });

  it('MEBULAR_CLOUD_ROOT 指定注册表位置；App 标准路径可被发现', async () => {
    const standard = join('/Applications', 'Mebular.app', 'Contents', 'Resources', ...[
      'node_modules', '@mebular', 'core', 'packages', 'mcp', 'bin', 'mebular.mjs',
    ]);
    const exists = (file) => new Set([
      '/custom/root/runtime-providers.json',
      standard,
      '/usr/bin/mebular',
    ]).has(file);
    const discovery = await discoverRuntimeProviders({
      env: { PATH: '/usr/bin', MEBULAR_CLOUD_ROOT: '/custom/root' },
      platform: 'darwin',
      userHome: '/home/u',
      exists,
      registry: { v: 1, providers: [{ kind: 'cli', path: '/usr/bin/mebular' }] },
    });
    expect(discovery.cloudRoot).toBe('/custom/root');
    expect(discovery.selected).toMatchObject({ kind: 'app', path: standard, source: 'standard' });
    expect(runtimeCloudRoot({ env: { MEBULAR_CLOUD_ROOT: '/custom/root' }, userHome: '/home/u' })).toBe('/custom/root');
    expect(runtimeCloudRoot({ env: {}, userHome: '/home/u' })).toBe(join('/home/u', '.mebular'));
  });

  it('Windows PATH 按 PATHEXT 发现 mebular.cmd', async () => {
    const discovery = await discoverRuntimeProviders({
      env: { PATH: 'C:\\bin', PATHEXT: '.EXE;.CMD' },
      platform: 'win32',
      userHome: 'C:\\Users\\me',
      exists: (file) => file === join('C:\\bin', 'mebular.CMD'),
      registry: { v: 1, providers: [] },
      includeStandardApp: false,
    });
    expect(discovery.selected).toMatchObject({ kind: 'cli', source: 'path' });
    expect(discovery.selected.path.toLowerCase()).toContain('mebular.cmd');
  });
});

describe('P8 @mebular/dsh-plugin：共享 runtime 生命周期', () => {
  it('attach + 健康 daemon：复用 resolve 返回的动态 URL，不启动', async () => {
    const harness = runtimeHarness({
      lifecycle: 'attach',
      provider: appProvider(),
      resolveData: resolveDocument({ mode: 'reused' }),
    });

    const state = await harness.lifecycle.start();
    expect(state).toMatchObject({
      status: 'up',
      state: 'up',
      mode: 'attach',
      runtimeMode: null,
      managed: false,
      reason: null,
      daemonUrl: 'http://127.0.0.1:9123',
      profile: { id: 'work', name: 'Work' },
      provider: { kind: 'app', source: 'registry' },
      // The running daemon is authoritative for the version (0.1.0 here),
      // not the provider registration.
      version: '0.1.0',
      downloadRequired: false,
    });
    expect(harness.calls.resolve).toHaveLength(1);
    expect(harness.calls.supervise).toHaveLength(0);
    expect(harness.calls.probes).toContain('http://127.0.0.1:9123');
    expect(harness.calls.discovery).toBe(1);
  });

  it('attach + runtime 已安装未运行：只提示，不启动 supervise', async () => {
    const harness = runtimeHarness({
      lifecycle: 'attach',
      provider: cliProvider(),
      resolveData: resolveDocument({ mode: 'child' }),
      reachable: false,
    });

    const state = await harness.lifecycle.start();
    expect(state).toMatchObject({
      status: 'down',
      state: 'down',
      mode: 'attach',
      reason: null,
      daemonUrl: 'http://127.0.0.1:9123',
      downloadRequired: false,
    });
    expect(harness.calls.supervise).toHaveLength(0);
    const info = buildEmbedInfo({
      daemonUrl: state.daemonUrl,
      reachable: state.reachable,
      status: state.status,
      state: state.state,
      mode: state.mode,
      reason: state.reason,
      downloadRequired: state.downloadRequired,
    });
    expect(info.reason).toBe('daemon_unreachable');
    expect(info.embedUrl).toBeNull();
  });

  it('attach + 无 provider：download_required，不 spawn、不下载', async () => {
    const harness = runtimeHarness({
      lifecycle: 'attach',
      provider: null,
      reachable: false,
    });

    const state = await harness.lifecycle.start();
    expect(state).toMatchObject({
      status: 'down',
      state: 'download_required',
      mode: 'attach',
      reason: 'download_required',
      downloadRequired: true,
    });
    expect(harness.calls.resolve).toHaveLength(0);
    expect(harness.calls.supervise).toHaveLength(0);
  });

  it('managed + 健康 daemon：复用，不 supervise；runtime: external 强制 attach', async () => {
    const reused = runtimeHarness({
      lifecycle: 'managed',
      provider: cliProvider(),
      resolveData: resolveDocument({ mode: 'reused' }),
    });
    expect(await reused.lifecycle.start()).toMatchObject({
      status: 'up',
      mode: 'managed',
      runtimeMode: null,
      managed: false,
    });
    expect(reused.calls.supervise).toHaveLength(0);

    const external = runtimeHarness({
      lifecycle: 'managed',
      runtime: 'external',
      provider: cliProvider(),
      resolveData: resolveDocument({ mode: 'child' }),
      reachable: false,
    });
    expect(await external.lifecycle.start()).toMatchObject({
      status: 'down',
      mode: 'attach',
      reason: null,
    });
    expect(external.calls.supervise).toHaveLength(0);
  });

  it('managed + App .mjs provider：用当前 Node 执行 supervise，dispose 只停 supervise', async () => {
    const provider = appProvider();
    const spawnCalls = [];
    const children = [];
    const harness = runtimeHarness({
      lifecycle: 'managed',
      provider,
      useRealSupervise: true,
      spawnFn: (command, args, options) => {
        spawnCalls.push({ command, args, options });
        const child = fakeChild();
        children.push(child);
        return child;
      },
    });

    const started = harness.lifecycle.start();
    await waitFor(() => spawnCalls.length === 1);
    expect(spawnCalls[0].command).toBe(process.execPath);
    expect(spawnCalls[0].args).toEqual([provider.path, 'runtime', 'supervise', '--json']);
    expect(spawnCalls[0].options.shell).toBeUndefined();

    children[0].stdout.emit(`${JSON.stringify(resolveDocument())}\n`);
    const state = await started;
    expect(state).toMatchObject({
      status: 'up',
      state: 'up',
      mode: 'managed',
      runtimeMode: 'child',
      managed: true,
      daemonUrl: 'http://127.0.0.1:9123',
      provider: { kind: 'app' },
    });
    expect(harness.calls.supervise).toHaveLength(0);

    harness.lifecycle.dispose();
    await waitFor(() => children[0].killCalls.length >= 1);
    expect(children[0].killCalls[0]).toBe('SIGTERM');
    children[0].emit('exit', 0, 'SIGTERM');
    expect(harness.lifecycle.getState()).toMatchObject({ managed: false, status: 'down' });
  });

  it('fake .mjs CLI：真实执行 runtime resolve --json 并采用权威 profile/端口', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mebular-dsh-cli-'));
    const cli = join(home, 'mebular.mjs');
    try {
      await writeFile(cli, [
        "const args = process.argv.slice(2);",
        "if (args[0] !== 'runtime' || args[1] !== 'resolve' || args[2] !== '--json') {",
        "  console.error('unexpected args', args);",
        '  process.exit(3);',
        '}',
        "process.stdout.write(`${JSON.stringify({",
        "  ok: true, mode: 'reused',",
        "  http: { scheme: 'http', host: '127.0.0.1', port: 9123 },",
        "  version: '0.2.0', profileId: 'work', profile: { id: 'work', name: 'Work' },",
        "  service: { registered: true, running: true, foreign: false },",
        "  providers: { selected: { kind: 'app', source: 'registry' } },",
        '})}\\n`);',
      ].join('\n'), 'utf-8');

      const harness = runtimeHarness({
        lifecycle: 'attach',
        provider: appProvider(cli),
        useRealResolve: true,
        home,
      });
      const state = await harness.lifecycle.start();
      expect(state).toMatchObject({
        status: 'up',
        daemonUrl: 'http://127.0.0.1:9123',
        profile: { id: 'work', name: 'Work' },
        service: { registered: true, running: true },
        provider: { kind: 'app' },
      });
      expect(harness.calls.resolve).toHaveLength(0);
      expect(harness.calls.probes).toEqual(['http://127.0.0.1:9123']);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('managed + CLI provider：命令行路径直接执行，Windows .cmd 才用 shell', async () => {
    for (const [providerPath, platform, expectedShell, expectedCommand] of [
      ['/opt/mebular/bin/mebular', 'linux', false, '/opt/mebular/bin/mebular'],
      ['C:\\Tools\\mebular.cmd', 'win32', true, 'C:\\Tools\\mebular.cmd'],
      ['C:\\Tools\\mebular.exe', 'win32', false, 'C:\\Tools\\mebular.exe'],
    ]) {
      const spawnCalls = [];
      const children = [];
      const harness = runtimeHarness({
        lifecycle: 'managed',
        provider: cliProvider(providerPath),
        useRealSupervise: true,
        platform,
        spawnFn: (command, args, options) => {
          spawnCalls.push({ command, args, options });
          const child = fakeChild();
          children.push(child);
          return child;
        },
      });

      const started = harness.lifecycle.start();
      await waitFor(() => spawnCalls.length === 1);
      expect(spawnCalls[0].command).toBe(expectedCommand);
      expect(spawnCalls[0].args).toEqual(['runtime', 'supervise', '--json']);
      expect(Boolean(spawnCalls[0].options.shell)).toBe(expectedShell);

      children[0].stdout.emit(`${JSON.stringify(resolveDocument())}\n`);
      await started;
      harness.lifecycle.dispose();
      children[0].emit('exit', 0, 'SIGTERM');
    }
  });

  it('service 已注册：supervise 输出 service 后正常退出，不当作失败，不停外部 daemon', async () => {
    const handle = superviseHandle(resolveDocument({ mode: 'service' }), { exitAfterReady: true });
    const harness = runtimeHarness({
      lifecycle: 'managed',
      provider: cliProvider(),
      resolveData: resolveDocument({ mode: 'service' }),
      supervise: handle,
    });

    const state = await harness.lifecycle.start();
    expect(harness.calls.supervise).toHaveLength(1);
    expect(state).toMatchObject({
      status: 'up',
      state: 'up',
      runtimeMode: 'service',
      managed: false,
      daemonUrl: 'http://127.0.0.1:9123',
      service: { registered: true, running: true },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.lifecycle.getState()).toMatchObject({ status: 'up', reason: null });
    expect(handle.stopCalls).toHaveLength(0);
    harness.lifecycle.dispose();
    expect(handle.stopCalls).toHaveLength(0);
  });

  it('persistence: service 但未注册：明确 service_not_registered，不启动 child、不安装', async () => {
    const ready = {
      ok: false,
      mode: 'error',
      reason: 'service_not_registered',
      http: { scheme: 'http', host: '127.0.0.1', port: 9123 },
      service: { registered: false, running: false, foreign: false },
      providers: { selected: { kind: 'cli', source: 'path' } },
    };
    const handle = superviseHandle(ready);
    const harness = runtimeHarness({
      lifecycle: 'managed',
      persistence: 'service',
      provider: cliProvider(),
      resolveData: resolveDocument({ mode: 'service' }),
      supervise: handle,
      reachable: false,
    });

    const state = await harness.lifecycle.start();
    expect(state).toMatchObject({
      status: 'down',
      state: 'service_conflict',
      reason: 'service_not_registered',
      downloadRequired: false,
    });
    expect(harness.calls.supervise).toHaveLength(1);
    expect(harness.calls.supervise[0].scriptArgs).toEqual(['--start', 'service']);
    expect(handle.stopCalls).toHaveLength(1);
  });

  it('conflict 原因映射为稳定 state/reason，不启动 supervise', async () => {
    for (const [reason, expectedState] of [
      ['instance_mismatch', 'profile_mismatch'],
      ['instance_missing', 'profile_mismatch'],
      ['cloud_mismatch', 'profile_mismatch'],
      ['CLOUD_ALREADY_ACTIVE', 'profile_mismatch'],
      ['service_unknown', 'service_conflict'],
      ['service_foreign', 'service_conflict'],
      ['port_in_use', 'down'],
      ['version_mismatch', 'version_mismatch'],
    ]) {
      const harness = runtimeHarness({
        lifecycle: 'managed',
        provider: cliProvider(),
        resolveResult: {
          ok: true,
          data: {
            ok: false,
            mode: 'conflict',
            reason,
            http: { scheme: 'http', host: '127.0.0.1', port: 9123 },
            service: { registered: false, running: false, foreign: reason === 'service_foreign' },
            providers: { selected: { kind: 'cli', source: 'path' } },
          },
        },
        reachable: false,
      });
      const state = await harness.lifecycle.start();
      expect(state).toMatchObject({ state: expectedState, reason });
      expect(harness.calls.supervise).toHaveLength(0);
    }
  });

  it('显式 daemonUrl pin：只 attach，不 resolve/supervise，不被动态 URL 覆盖', async () => {
    const harness = runtimeHarness({
      lifecycle: 'managed',
      provider: appProvider(),
      config: { daemonUrl: 'http://127.0.0.1:7000', pinnedDaemonUrl: true },
    });

    const state = await harness.lifecycle.start();
    expect(state).toMatchObject({
      status: 'up',
      mode: 'attach',
      daemonUrl: 'http://127.0.0.1:7000',
      runtimeMode: null,
    });
    expect(harness.calls.discovery).toBe(0);
    expect(harness.calls.resolve).toHaveLength(0);
    expect(harness.calls.supervise).toHaveLength(0);
    expect(harness.calls.probes).toEqual(['http://127.0.0.1:7000']);
  });

  it('两个入口同时冷启动：只有一个 supervise/daemon；一个退出后另一个可 attach 或重启', async () => {
    const world = { up: false, starts: 0 };
    const provider = appProvider();
    const makeEntry = () => {
      const entry = { stops: 0 };
      entry.lifecycle = createDaemonLifecycle({
        config: { lifecycle: 'managed', pinnedDaemonUrl: false },
        discoverProviders: async () => discoveryFor(provider),
        runResolve: async () => ({
          ok: true,
          data: world.up ? resolveDocument({ mode: 'reused' }) : resolveDocument({ mode: 'child' }),
        }),
        startSupervise: async () => {
          if (world.up) {
            return superviseHandle(resolveDocument({ mode: 'reused' }), { exitAfterReady: true });
          }
          world.starts += 1;
          world.up = true;
          const handle = superviseHandle(resolveDocument({ mode: 'child' }));
          handle.stop = async () => {
            entry.stops += 1;
            world.up = false;
            handle.exit(0, 'SIGTERM');
            return { stopped: true };
          };
          return handle;
        },
        probe: async ({ daemonUrl }) => ({
          reachable: world.up,
          health: world.up ? HEALTH : null,
          embed: world.up ? embedFor(daemonUrl) : null,
        }),
        superviseStopGraceMs: 10,
        pollIntervalMs: 1,
        startTimeoutMs: 200,
        cacheTtlMs: 0,
        env: {},
      });
      return entry;
    };

    const first = makeEntry();
    const second = makeEntry();
    const [firstState, secondState] = await Promise.all([
      first.lifecycle.start(),
      second.lifecycle.start(),
    ]);
    expect(world.starts).toBe(1);
    expect(firstState.status).toBe('up');
    expect(secondState.status).toBe('up');
    expect([firstState.managed, secondState.managed].filter(Boolean)).toHaveLength(1);

    first.lifecycle.dispose();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(world.up).toBe(false);
    expect(first.stops).toBe(1);
    expect((await second.lifecycle.inspect()).status).toBe('down');

    const third = makeEntry();
    expect((await third.lifecycle.start()).status).toBe('up');
    expect(world.starts).toBe(2);
    third.lifecycle.dispose();
  });

  it('supervise child 在 up 后退出：状态 down + child_exited，不重启第二个 daemon', async () => {
    const handle = superviseHandle(resolveDocument({ mode: 'child' }));
    const harness = runtimeHarness({
      lifecycle: 'managed',
      provider: cliProvider(),
      supervise: handle,
    });

    expect((await harness.lifecycle.start()).status).toBe('up');
    handle.exit(7, null);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.lifecycle.getState()).toMatchObject({
      status: 'down',
      state: 'down',
      reason: 'child_exited',
      managed: false,
    });
    expect(harness.calls.supervise).toHaveLength(1);
  });

  it('supervise 就绪超时：managed_start_failed 且只停自己的 supervise', async () => {
    const spawnCalls = [];
    const children = [];
    const harness = runtimeHarness({
      lifecycle: 'managed',
      provider: cliProvider(),
      useRealSupervise: true,
      startTimeoutMs: 30,
      // Stop grace is 10ms in this harness; exit there so SIGKILL's 5s wait is
      // never reached.
      sleep: (ms) => {
        if (ms >= 10 && children.length > 0) children[0].emit('exit', 0, 'SIGTERM');
        return Promise.resolve();
      },
      spawnFn: (command, args, options) => {
        spawnCalls.push({ command, args, options });
        const child = fakeChild();
        children.push(child);
        return child;
      },
    });

    const state = await harness.lifecycle.start();
    expect(state).toMatchObject({
      status: 'down',
      state: 'down',
      reason: 'managed_start_failed',
      managed: false,
    });
    expect(spawnCalls).toHaveLength(1);
    expect(children[0].killCalls[0]).toBe('SIGTERM');
    children[0].emit('exit', 0, 'SIGTERM');
  });

  it('resolve 失败 + daemon 不可达：runtime_resolve_failed，不猜测端口', async () => {
    const harness = runtimeHarness({
      lifecycle: 'attach',
      provider: cliProvider(),
      resolveResult: { ok: false, error: 'timeout' },
      reachable: false,
    });
    const state = await harness.lifecycle.start();
    expect(state).toMatchObject({
      status: 'down',
      state: 'down',
      reason: 'runtime_resolve_failed',
    });
    expect(harness.calls.supervise).toHaveLength(0);
  });

  it('bootstrap: never 抑制下载/安装提示但保持 down', async () => {
    const harness = runtimeHarness({
      lifecycle: 'attach',
      provider: null,
      bootstrap: 'never',
      reachable: false,
    });
    const state = await harness.lifecycle.start();
    expect(state).toMatchObject({
      status: 'down',
      state: 'down',
      reason: null,
      downloadRequired: false,
    });
  });

  it('非法 lifecycle/runtime/persistence/bootstrap 回退并告警，不阻止启动', async () => {
    const warnings = [];
    const lifecycle = createDaemonLifecycle({
      config: {
        lifecycle: 'sometimes',
        runtime: 'sometimes',
        persistence: 'sometimes',
        bootstrap: 'sometimes',
        pinnedDaemonUrl: false,
      },
      warn: (message) => warnings.push(message),
      discoverProviders: async () => discoveryFor(null),
      probe: async () => ({ reachable: false, health: null, embed: null }),
      env: {},
      cacheTtlMs: 0,
    });
    const state = await lifecycle.start();
    expect(state).toMatchObject({ status: 'down', mode: 'attach' });
    expect(warnings.join('\n')).toContain('invalid lifecycle');
    expect(warnings.join('\n')).toContain('invalid runtime');
    expect(warnings.join('\n')).toContain('invalid persistence');
    expect(warnings.join('\n')).toContain('invalid bootstrap');
    lifecycle.dispose();
  });

  it('supervise 日志中的 secret 与路径被脱敏', async () => {
    const spawnCalls = [];
    const children = [];
    const harness = runtimeHarness({
      lifecycle: 'managed',
      provider: cliProvider(),
      useRealSupervise: true,
      spawnFn: (command, args, options) => {
        spawnCalls.push({ command, args, options });
        const child = fakeChild();
        children.push(child);
        return child;
      },
    });

    const started = harness.lifecycle.start();
    await waitFor(() => spawnCalls.length === 1);
    children[0].stdout.emit(`${JSON.stringify(resolveDocument())}\n`);
    await started;
    children[0].stderr.emit('token=abc123 Authorization: Bearer eyJhbGci /opt/mebular/bin/mebular /inherited/home');
    await new Promise((resolve) => setTimeout(resolve, 10));

    const output = harness.logs.join('\n');
    expect(output).toContain('token=<redacted>');
    expect(output).toContain('Authorization: Bearer <redacted>');
    for (const secret of ['abc123', 'eyJhbGci', '/opt/mebular/bin/mebular', '/inherited/home']) {
      expect(output).not.toContain(secret);
    }
    harness.lifecycle.dispose();
    children[0].emit('exit', 0, 'SIGTERM');
  });
});

describe('P9 @mebular/dsh-plugin：supervise stop 窗口与 dispose', () => {
  it('默认 stop grace 覆盖 supervisor 的 child 清理预算', () => {
    expect(DEFAULT_SUPERVISE_STOP_GRACE_MS).toBeGreaterThanOrEqual(9000);
  });

  it('supervise 收到 SIGTERM 后约 3s 才退出：不在 2s 提前 SIGKILL，最终无孤儿', async () => {
    const spawnCalls = [];
    const children = [];
    const waits = [];
    const clock = { now: 0 };
    const childExitAfterMs = 3000;
    let exitAt = null;
    const harness = runtimeHarness({
      lifecycle: 'managed',
      provider: appProvider(),
      useRealSupervise: true,
      // Default 10s window: the supervisor may need 2s + 5s to clean its child.
      useDefaultSuperviseStopGrace: true,
      sleep: (ms) => {
        waits.push(ms);
        const target = clock.now + ms;
        // The supervisor cleans its child in ~3s, inside the 10s stop window.
        if (exitAt !== null && exitAt <= target && children.length > 0) {
          clock.now = exitAt;
          children[0].emit('exit', 0, 'SIGTERM');
        }
        clock.now = target;
        return Promise.resolve();
      },
      spawnFn: (command, args, options) => {
        spawnCalls.push({ command, args, options });
        const child = fakeChild();
        const kill = child.kill;
        child.kill = function onKill(signal) {
          if (signal === 'SIGTERM') exitAt = clock.now + childExitAfterMs;
          return kill.call(this, signal);
        };
        children.push(child);
        return child;
      },
    });

    const started = harness.lifecycle.start();
    await waitFor(() => spawnCalls.length === 1);
    children[0].stdout.emit(`${JSON.stringify(resolveDocument())}\n`);
    await started;

    const disposal = harness.lifecycle.dispose();
    await disposal;

    expect(waits).toContain(DEFAULT_SUPERVISE_STOP_GRACE_MS);
    expect(waits).not.toContain(2000);
    // Virtual time reached the 3s child-exit point, long before SIGKILL would
    // even be considered, and only one SIGTERM was sent to supervise.
    expect(clock.now).toBeGreaterThanOrEqual(childExitAfterMs);
    expect(children[0].killCalls).toEqual(['SIGTERM']);
    expect(spawnCalls).toHaveLength(1);
    expect(children).toHaveLength(1);
    expect(harness.logs.join('\n')).not.toContain('did not confirm exit');
  });

  it('dispose 返回同一个 Promise，等待 stop 完成且重复调用只 stop 一次', async () => {
    const handle = superviseHandle(resolveDocument({ mode: 'child' }));
    const harness = runtimeHarness({
      lifecycle: 'managed',
      provider: cliProvider(),
      supervise: handle,
    });
    await harness.lifecycle.start();

    const first = harness.lifecycle.dispose();
    const second = harness.lifecycle.dispose();
    expect(second).toBe(first);
    expect(typeof first?.then).toBe('function');
    await first;
    expect(handle.stopCalls).toHaveLength(1);
    expect(handle.stopCalls[0]).toEqual({ graceMs: 10 });

    const third = harness.lifecycle.dispose();
    expect(third).toBe(first);
    await third;
    expect(handle.stopCalls).toHaveLength(1);
  });

  it('默认 lifecycle 把 10s stop grace 传给 supervise，而不是旧的 2s', async () => {
    const handle = superviseHandle(resolveDocument({ mode: 'child' }));
    const harness = runtimeHarness({
      lifecycle: 'managed',
      provider: cliProvider(),
      supervise: handle,
      useDefaultSuperviseStopGrace: true,
    });
    await harness.lifecycle.start();
    await harness.lifecycle.dispose();

    expect(handle.stopCalls).toEqual([{ graceMs: DEFAULT_SUPERVISE_STOP_GRACE_MS }]);
    expect(handle.stopCalls[0].graceMs).not.toBe(2000);
  });

  it('超过新 stop grace 仍不退出才 SIGKILL，并记录 supervise_stop_failed', async () => {
    const spawnCalls = [];
    const children = [];
    const waits = [];
    const harness = runtimeHarness({
      lifecycle: 'managed',
      provider: appProvider(),
      useRealSupervise: true,
      useDefaultSuperviseStopGrace: true,
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
      spawnFn: (command, args, options) => {
        spawnCalls.push({ command, args, options });
        const child = fakeChild();
        children.push(child);
        return child;
      },
    });

    const started = harness.lifecycle.start();
    await waitFor(() => spawnCalls.length === 1);
    children[0].stdout.emit(`${JSON.stringify(resolveDocument())}\n`);
    await started;

    await harness.lifecycle.dispose();

    expect(children[0].killCalls).toEqual(['SIGTERM', 'SIGKILL']);
    expect(waits[0]).toBe(DEFAULT_SUPERVISE_STOP_GRACE_MS);
    expect(waits[1]).toBe(5000);
    expect(waits[0]).toBeGreaterThan(2000);
    expect(harness.logs.join('\n')).toContain('did not confirm exit');
    expect(harness.lifecycle.getState()).toMatchObject({
      status: 'down',
      state: 'down',
      reason: 'supervise_stop_failed',
    });
    expect(spawnCalls).toHaveLength(1);
    expect(children).toHaveLength(1);
  });
});

describe('P3 @mebular/dsh-plugin：CLI 解析', () => {
  it('cliPath → MEBULAR_CLI → PATH，第一个存在的胜出（POSIX PATH 语义）', () => {
    const pathEntry = join('/usr/local/bin', 'mebular');
    const existing = new Set(['/opt/mebular', '/env/mebular', pathEntry]);
    const exists = (file) => existing.has(file);
    const posix = { platform: 'linux' };
    expect(resolveCliPath({ ...posix, cliPath: '/opt/mebular', env: { PATH: '/usr/local/bin' }, exists })).toBe('/opt/mebular');
    expect(resolveCliPath({ ...posix, env: { MEBULAR_CLI: '/env/mebular', PATH: '/usr/local/bin' }, exists })).toBe('/env/mebular');
    expect(resolveCliPath({ ...posix, env: { PATH: '/usr/bin:/usr/local/bin' }, exists })).toBe(pathEntry);
    expect(resolveCliPath({ ...posix, env: { PATH: '/usr/bin' }, exists })).toBeNull();
  });

  it('Windows：按 ; 与 PATHEXT 解析 PATH', () => {
    const expected = join('C:\\bin', 'mebular.EXE');
    const exists = (file) => file === expected;
    expect(resolveCliPath({
      platform: 'win32',
      env: { PATH: 'C:\\bin', PATHEXT: '.EXE;.CMD' },
      exists,
    })).toBe(expected);
  });

  it('daemonPortFromUrl 从 daemonUrl 取端口', () => {
    expect(daemonPortFromUrl('http://127.0.0.1:7331')).toBe(7331);
    expect(daemonPortFromUrl('http://127.0.0.1:9000/base')).toBe(9000);
    expect(daemonPortFromUrl('http://127.0.0.1')).toBe(80);
    expect(daemonPortFromUrl('not a url')).toBe(7331);
  });
});
