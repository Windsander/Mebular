// P2 · @mebular/dsh-plugin host：配置归一、loopback 判定、embedInfo 形状与只读路由。

import { describe, it, expect, afterEach } from '@jest/globals';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EMBED_INFO_PATH,
  EMBED_PROTOCOL,
  MCP_CLIENT_PACKAGE,
  PANEL_GLOBAL,
  apply,
  buildEmbedInfo,
  createDaemonLifecycle,
  createEmbedInfoHandler,
  daemonPortFromUrl,
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

function lifecycleHarness({
  lifecycle = 'attach',
  reachable = false,
  spawnCalls = [],
  children = [],
  cli = null,
  warnings = [],
} = {}) {
  return createDaemonLifecycle({
    config: { daemonUrl: BASE, lifecycle },
    probe: async () => ({
      reachable,
      health: reachable ? HEALTH : null,
      embed: reachable ? EMBED : null,
    }),
    spawnFn: (command, args, options) => {
      spawnCalls.push({ command, args, options });
      const child = fakeChild();
      children.push(child);
      return child;
    },
    resolveCli: () => cli,
    logger: { warn: (message) => warnings.push(message) },
    startTimeoutMs: 5000,
    pollIntervalMs: 5,
    killGraceMs: 50,
    cacheTtlMs: 0,
    env: { PATH: '/usr/bin', MEBULAR_HOME: '/inherited/home' },
  });
}

function applyHarness(fetchHandler, {
  panel = true,
  tapIndex = true,
  importModule = async () => ({ name: 'fake-mcp-client' }),
  applyOptions = {},
  config,
} = {}) {
  const mock = mockFetch(fetchHandler);
  const routes = [];
  const taps = [];
  const plugins = [];
  const warnings = [];
  const ctx = {
    logger: { warn: (message) => warnings.push(message) },
    plugin(module, pluginConfig) {
      plugins.push({ module, config: pluginConfig });
      return () => {};
    },
    inject(deps, callback) {
      expect(deps).toEqual(['webServer']);
      callback({
        effect(run) {
          return run();
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
  apply(ctx, config ?? { daemonUrl: BASE, panel }, { runtime: null, importModule, ...applyOptions });
  const route = routes.find((entry) => entry.path === EMBED_INFO_PATH);
  return { mock, route, routes, taps, plugins, warnings, ctx };
}

let activeMock = null;

afterEach(() => {
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
      });
      expect(resolveConfig({ lifecycle: 'managed', cliPath: ' /opt/mebular ' }, CONFIG_OPTS)).toEqual({
        daemonUrl: 'http://127.0.0.1:8123',
        lifecycle: 'managed',
        panel: true,
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
        lifecycle: 'auto',
        panel: 'maybe',
        cliPath: 42,
      }, {
        warn: (message) => warnings.push(message),
        runtime: null,
      })).toEqual({
        daemonUrl: 'http://127.0.0.1:7331',
        lifecycle: 'attach',
        panel: true,
      });
      expect(warnings).toHaveLength(4);
      expect(warnings.join('\n')).toContain('invalid daemonUrl');
      expect(warnings.join('\n')).toContain('invalid lifecycle');
      expect(warnings.join('\n')).toContain('invalid panel');
      expect(warnings.join('\n')).toContain('invalid cliPath');
      expect(resolveConfig({ lifecycle: ' MANAGED ' }).lifecycle).toBe('managed');
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
      mode: 'attach',
      managed: false,
      panel: true,
      version: '0.1.0',
      embedProtocol: EMBED_PROTOCOL,
      consoleUrl: `${BASE}/console`,
      embedUrl: `${BASE}/console/?embed=dsh`,
      mcpUrl: `${BASE}/mcp`,
      loopback: true,
      reason: null,
    });
    expect(Object.keys(info).sort()).toEqual([
      'consoleUrl', 'embedProtocol', 'embedUrl', 'loopback',
      'managed', 'mcpUrl', 'mode', 'ok', 'panel', 'reason', 'status', 'version',
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
    const ok = await mountMcp(
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

    expect(ok).toBe(true);
    expect(specifiers).toEqual([MCP_CLIENT_PACKAGE]);
    expect(MCP_CLIENT_PACKAGE).toBe('@deepseek-ai/dsh-mcp-client');
    expect(plugins).toEqual([{
      module: mcpModule,
      config: {
        serverName: 'mebular',
        transport: 'streamable-http',
        url: 'http://127.0.0.1:9123/mcp',
        failOnStartupError: false,
      },
    }]);
    expect(logs).toEqual(['info:mcp client mounted']);
  });

  it('peer 缺失（Jest/普通 Node）不抛错、不激活 plugin，只记稳定错误码', async () => {
    const plugins = [];
    const logs = [];
    const error = new Error('Cannot find package');
    error.code = 'ERR_MODULE_NOT_FOUND';
    const ok = await mountMcp(
      { plugin: (module, config) => plugins.push({ module, config }) },
      BASE,
      {
        importModule: async () => {
          throw error;
        },
        log: (level, message) => logs.push(`${level}:${message}`),
      },
    );

    expect(ok).toBe(false);
    expect(plugins).toHaveLength(0);
    expect(logs).toEqual(['warn:mcp client mount failed (ERR_MODULE_NOT_FOUND)']);
  });

  it('没有 ctx.plugin 时跳过挂载，不影响其他能力', async () => {
    const logs = [];
    const ok = await mountMcp({}, BASE, {
      importModule: async () => {
        throw new Error('must not import without ctx.plugin');
      },
      log: (level, message) => logs.push(`${level}:${message}`),
    });
    expect(ok).toBe(false);
    expect(logs).toEqual(['warn:mcp client mount skipped: ctx.plugin is unavailable']);
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
        failOnStartupError: false,
      });

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

  it('apply 的 MCP 挂载失败仍注册只读路由并记录 warn', async () => {
    const harness = applyHarness(
      (url) => {
        if (url === `${BASE}/healthz`) return jsonResponse(HEALTH);
        if (url === `${BASE}/app/embed/info`) return jsonResponse(EMBED);
        throw new Error(`unexpected ${url}`);
      },
      {
        importModule: async () => {
          const error = new Error('missing peer');
          error.code = 'ERR_MODULE_NOT_FOUND';
          throw error;
        },
      },
    );
    activeMock = harness.mock;

    await waitFor(() => harness.warnings.some((line) => line.includes('mcp client mount failed')));
    expect(harness.warnings.join('\n')).toContain('mcp client mount failed (ERR_MODULE_NOT_FOUND)');
    expect(harness.route).toBeDefined();

    const res = makeResponse();
    await harness.route.handler(makeRequest(), res);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe('up');
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
    });
    activeMock = harness.mock;

    expect(harness.routes).toHaveLength(1);
    expect(harness.routes[0]).toMatchObject({ kind: 'exact', path: EMBED_INFO_PATH });

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
    });
    activeMock = harness.mock;

    await harness.route.handler(makeRequest(), makeResponse());
    await harness.route.handler(makeRequest(), makeResponse());
    expect(harness.mock.calls).toHaveLength(2);
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

describe('P3 @mebular/dsh-plugin：attach / managed 生命周期', () => {
  it('attach + up：只探测，不 spawn，mode=attach/managed=false', async () => {
    const spawnCalls = [];
    const lifecycle = lifecycleHarness({
      lifecycle: 'attach',
      reachable: true,
      spawnCalls,
      cli: '/opt/mebular',
    });

    await lifecycle.start();
    const state = await lifecycle.inspect();
    expect(state).toMatchObject({
      status: 'up',
      mode: 'attach',
      managed: false,
      reason: null,
    });
    expect(spawnCalls).toHaveLength(0);

    lifecycle.dispose();
    expect(spawnCalls).toHaveLength(0);
  });

  it('attach + down：不 spawn，状态 down + daemon_unreachable', async () => {
    const spawnCalls = [];
    const lifecycle = lifecycleHarness({
      lifecycle: 'attach',
      reachable: false,
      spawnCalls,
      cli: '/opt/mebular',
    });

    await lifecycle.start();
    const state = await lifecycle.inspect();
    expect(state).toMatchObject({
      status: 'down',
      mode: 'attach',
      managed: false,
      reason: null,
    });
    expect(spawnCalls).toHaveLength(0);

    const info = buildEmbedInfo({
      daemonUrl: BASE,
      reachable: state.reachable,
      health: state.health,
      embed: state.embed,
      status: state.status,
      mode: state.mode,
      managed: state.managed,
      reason: state.reason,
    });
    expect(info.reason).toBe('daemon_unreachable');
    expect(info.embedUrl).toBeNull();
  });

  it('managed + up：复用已有 daemon，不 spawn、不托管', async () => {
    const spawnCalls = [];
    const lifecycle = lifecycleHarness({ lifecycle: 'managed', reachable: true, spawnCalls });

    await lifecycle.start();
    const state = await lifecycle.inspect();
    expect(state).toMatchObject({
      status: 'up',
      mode: 'managed',
      managed: false,
      reason: null,
    });
    expect(spawnCalls).toHaveLength(0);

    lifecycle.dispose();
    expect(spawnCalls).toHaveLength(0);
  });

  it('managed + down + CLI：只 spawn 一次，starting 后 dispose 只杀自己的 child', async () => {
    const spawnCalls = [];
    const children = [];
    const lifecycle = lifecycleHarness({
      lifecycle: 'managed',
      reachable: false,
      spawnCalls,
      children,
      cli: '/opt/mebular',
    });

    const startup = lifecycle.start();
    await waitFor(() => spawnCalls.length === 1);
    const during = await lifecycle.inspect();
    expect(during).toMatchObject({
      status: 'starting',
      mode: 'managed',
      managed: true,
      reason: null,
    });
    expect(during.health).toBeNull();

    expect(spawnCalls[0]).toMatchObject({
      command: '/opt/mebular',
      args: ['serve', '--port', '7331'],
    });
    expect(spawnCalls[0].options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
    // Managed mode inherits MEBULAR_HOME; it never rewrites the Mebular home.
    expect(spawnCalls[0].options.env.MEBULAR_HOME).toBe('/inherited/home');

    lifecycle.dispose();
    await startup;
    expect(children[0].killCalls).toEqual(['SIGTERM']);
    expect(lifecycle.getState()).toMatchObject({ status: 'down', managed: false });
    expect(spawnCalls).toHaveLength(1);
  });

  it('managed + down + CLI 缺失：降级 attach，不 spawn，reason=managed_cli_missing', async () => {
    const spawnCalls = [];
    const warnings = [];
    const lifecycle = lifecycleHarness({
      lifecycle: 'managed',
      reachable: false,
      spawnCalls,
      warnings,
    });

    await lifecycle.start();
    const state = await lifecycle.inspect();
    expect(state).toMatchObject({
      status: 'down',
      mode: 'attach',
      managed: false,
      reason: 'managed_cli_missing',
    });
    expect(spawnCalls).toHaveLength(0);
    expect(warnings.join('\n')).toContain('no Mebular CLI');

    lifecycle.dispose();
    expect(spawnCalls).toHaveLength(0);
  });

  it('managed 启动超时：状态 down + managed_start_failed，只 kill 自己的 child', async () => {
    const spawnCalls = [];
    const children = [];
    const lifecycle = createDaemonLifecycle({
      config: { daemonUrl: BASE, lifecycle: 'managed' },
      probe: async () => ({ reachable: false, health: null, embed: null }),
      spawnFn: (command, args, options) => {
        spawnCalls.push({ command, args, options });
        const child = fakeChild();
        children.push(child);
        return child;
      },
      resolveCli: () => '/opt/mebular',
      logger: { warn() {} },
      startTimeoutMs: 30,
      pollIntervalMs: 5,
      killGraceMs: 10,
      cacheTtlMs: 0,
    });

    await lifecycle.start();
    expect(spawnCalls).toHaveLength(1);
    expect(lifecycle.getState()).toMatchObject({
      status: 'down',
      mode: 'managed',
      managed: false,
      reason: 'managed_start_failed',
    });
    // Timeout cleanup escalates SIGTERM -> SIGKILL for its own child.
    expect(children[0].killCalls).toEqual(['SIGTERM', 'SIGKILL']);

    lifecycle.dispose();
    expect(children[0].killCalls).toEqual(['SIGTERM', 'SIGKILL']);
    expect(lifecycle.getState()).toMatchObject({ managed: false, reason: 'managed_start_failed' });
  });

  it('spawn error：不留下 child，状态 managed_start_failed，日志不含 CLI 路径', async () => {
    const warnings = [];
    const lifecycle = createDaemonLifecycle({
      config: { daemonUrl: BASE, lifecycle: 'managed' },
      probe: async () => ({ reachable: false, health: null, embed: null }),
      spawnFn: () => {
        const error = new Error('spawn /opt/mebular ENOENT');
        error.code = 'ENOENT';
        throw error;
      },
      resolveCli: () => '/opt/mebular',
      logger: { warn: (message) => warnings.push(message) },
      startTimeoutMs: 30,
      pollIntervalMs: 5,
      killGraceMs: 10,
      cacheTtlMs: 0,
    });

    await lifecycle.start();
    expect(lifecycle.getState()).toMatchObject({
      status: 'down',
      mode: 'managed',
      managed: false,
      reason: 'managed_start_failed',
    });
    expect(warnings.join('\n')).toContain('failed to spawn (ENOENT)');
    expect(warnings.join('\n')).not.toContain('/opt/mebular');
    lifecycle.dispose();
  });

  it('Windows .cmd：使用 shell 启动且 args 固定；普通可执行不启用 shell', async () => {
    for (const [cliPath, expectedShell] of [
      ['C:\\Tools\\mebular.cmd', true],
      ['C:\\Tools\\mebular.exe', false],
    ]) {
      const calls = [];
      const lifecycle = createDaemonLifecycle({
        config: { daemonUrl: BASE, lifecycle: 'managed' },
        probe: async () => ({ reachable: false, health: null, embed: null }),
        spawnFn: (command, args, options) => {
          calls.push({ command, args, options });
          return fakeChild();
        },
        resolveCli: () => cliPath,
        platform: 'win32',
        logger: { warn() {} },
        startTimeoutMs: 20,
        pollIntervalMs: 5,
        killGraceMs: 5,
        cacheTtlMs: 0,
      });
      await lifecycle.start();
      expect(calls).toHaveLength(1);
      expect(calls[0].args).toEqual(['serve', '--port', '7331']);
      expect(Boolean(calls[0].options.shell)).toBe(expectedShell);
      lifecycle.dispose();
    }
  });

  it('dispose：SIGTERM 后仍存活，grace 到期发 SIGKILL', async () => {
    const spawnCalls = [];
    const children = [];
    const lifecycle = lifecycleHarness({
      lifecycle: 'managed',
      reachable: false,
      spawnCalls,
      children,
      cli: '/opt/mebular',
    });

    const startup = lifecycle.start();
    await waitFor(() => spawnCalls.length === 1);
    lifecycle.dispose();
    await startup;
    expect(children[0].killCalls[0]).toBe('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(children[0].killCalls).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('managed 子进程日志：secret/token/Authorization 与路径脱敏', async () => {
    const spawnCalls = [];
    const children = [];
    const logs = [];
    const lifecycle = createDaemonLifecycle({
      config: { daemonUrl: BASE, lifecycle: 'managed' },
      probe: async () => ({ reachable: false, health: null, embed: null }),
      spawnFn: (command, args, options) => {
        spawnCalls.push({ command, args, options });
        const child = fakeChild();
        children.push(child);
        return child;
      },
      resolveCli: () => '/opt/mebular',
      logger: {
        info: (message) => logs.push(message),
        warn: (message) => logs.push(message),
      },
      env: { PATH: '/usr/bin', MEBULAR_HOME: '/Users/me/.mebular' },
      startTimeoutMs: 5000,
      pollIntervalMs: 5,
      killGraceMs: 10,
      cacheTtlMs: 0,
    });

    const startup = lifecycle.start();
    await waitFor(() => spawnCalls.length === 1);
    children[0].stderr.emit(
      'token=abc123 Authorization: Bearer eyJhbGci password="pw" /opt/mebular /Users/me/.mebular',
    );
    expect(logs.join('\n')).toContain('token=<redacted>');
    expect(logs.join('\n')).toContain('Authorization: Bearer <redacted>');
    expect(logs.join('\n')).toContain('password="<redacted>"');
    for (const secret of ['abc123', 'eyJhbGci', 'pw', '/opt/mebular', '/Users/me/.mebular']) {
      expect(logs.join('\n')).not.toContain(secret);
    }
    lifecycle.dispose();
    await startup;
  });

  it('外部 daemon 不被 dispose 停止', async () => {
    const spawnCalls = [];
    const lifecycle = lifecycleHarness({ lifecycle: 'managed', reachable: true, spawnCalls });
    await lifecycle.start();
    lifecycle.dispose();
    expect(spawnCalls).toHaveLength(0);
  });

  it('状态契约：up/managed 形状完整且不含敏感字段', async () => {
    const lifecycle = {
      inspect: async () => ({
        status: 'up',
        mode: 'managed',
        managed: true,
        reason: null,
        reachable: true,
        health: HEALTH,
        embed: EMBED,
      }),
    };
    const handler = createEmbedInfoHandler({ config: { daemonUrl: BASE }, lifecycle });
    const res = makeResponse();
    await handler(makeRequest(), res);
    const info = JSON.parse(res.body);

    expect(info).toMatchObject({
      ok: true,
      status: 'up',
      mode: 'managed',
      managed: true,
      panel: true,
      version: '0.1.0',
      embedProtocol: 1,
      consoleUrl: `${BASE}/console`,
      embedUrl: `${BASE}/console/?embed=dsh`,
      mcpUrl: `${BASE}/mcp`,
      loopback: true,
      reason: null,
    });
    expect(Object.keys(info).sort()).toEqual([
      'consoleUrl', 'embedProtocol', 'embedUrl', 'loopback',
      'managed', 'mcpUrl', 'mode', 'ok', 'panel', 'reason', 'status', 'version',
    ]);
    const serialized = JSON.stringify(info).toLowerCase();
    for (const word of ['token', 'secret', 'password', 'authorization', 'cliPath', '/inherited']) {
      expect(serialized).not.toContain(word.toLowerCase());
    }
  });

  it('状态契约：starting 不返回 embedUrl，并由 client 显示启动占位页', async () => {
    const lifecycle = {
      inspect: async () => ({
        status: 'starting',
        mode: 'managed',
        managed: true,
        reason: null,
        reachable: false,
        health: null,
        embed: null,
      }),
    };
    const handler = createEmbedInfoHandler({ config: { daemonUrl: BASE }, lifecycle });
    const res = makeResponse();
    await handler(makeRequest(), res);
    expect(JSON.parse(res.body)).toMatchObject({
      ok: false,
      status: 'starting',
      mode: 'managed',
      managed: true,
      embedUrl: null,
      reason: null,
    });
  });
});

describe('P3 @mebular/dsh-plugin：CLI 解析', () => {
  it('cliPath → MEBULAR_CLI → PATH，第一个存在的胜出（POSIX）', () => {
    const existing = new Set(['/opt/mebular', '/env/mebular', '/usr/local/bin/mebular']);
    const exists = (file) => existing.has(file);
    const posix = { platform: 'linux' };
    expect(resolveCliPath({ ...posix, cliPath: '/opt/mebular', env: { PATH: '/usr/local/bin' }, exists })).toBe('/opt/mebular');
    expect(resolveCliPath({ ...posix, env: { MEBULAR_CLI: '/env/mebular', PATH: '/usr/local/bin' }, exists })).toBe('/env/mebular');
    expect(resolveCliPath({ ...posix, env: { PATH: '/usr/bin:/usr/local/bin' }, exists })).toBe('/usr/local/bin/mebular');
    expect(resolveCliPath({ ...posix, env: { PATH: '/usr/bin' }, exists })).toBeNull();
  });

  it('daemonPortFromUrl 从 daemonUrl 取端口', () => {
    expect(daemonPortFromUrl('http://127.0.0.1:7331')).toBe(7331);
    expect(daemonPortFromUrl('http://127.0.0.1:9000/base')).toBe(9000);
    expect(daemonPortFromUrl('http://127.0.0.1')).toBe(80);
    expect(daemonPortFromUrl('not a url')).toBe(7331);
  });
});
