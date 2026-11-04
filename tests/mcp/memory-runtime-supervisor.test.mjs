// W3b：MCP Memory Runtime sidecar supervisor。
//
// 覆盖：enabled 启动 fake sidecar / disabled 零副作用 / 已有健康 attach /
// profile·home 不匹配拒绝接管 / 崩溃退避与重启上限 / 启动超时 / stop / token 注入不泄漏 /
// 可执行文件解析优先级。

import { describe, it, expect, afterEach } from '@jest/globals';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MemoryRuntimeSupervisor,
  pidAlive,
  resolveMemoryRuntimeCommand,
} from '../../packages/mcp/src/memory-runtime-supervisor.mjs';

const FAKE = fileURLToPath(new URL('./fixtures/memory-runtime-fake-sidecar.mjs', import.meta.url));
const cleanups = [];
const dirs = [];

async function tempDir(prefix = 'memory-runtime-supervisor-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()().catch(() => undefined);
  }
  while (dirs.length > 0) {
    await rm(dirs.pop(), { recursive: true, force: true });
  }
});

async function waitFor(check, { timeoutMs = 5000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error('waitFor timeout');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
  }
}

async function writeCapabilityToken(home, token = 'capability-secret-token') {
  const dir = join(home, 'memory-runtime');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(
    join(dir, 'capability-token'),
    JSON.stringify({ version: 1, token, issuedAt: Date.now(), expiresAt: 0, mcpPid: process.pid }),
    { mode: 0o600 },
  );
  return token;
}

async function writeHostToken(home, token) {
  const dir = join(home, 'memory-runtime');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, 'host-token'), JSON.stringify({
    version: 1, token, issuedAt: Date.now(), expiresAt: 0,
  }), { mode: 0o600 });
}

function enabledConfig(extra = {}) {
  return {
    memoryRuntime: {
      enabled: true,
      command: FAKE,
      startTimeoutMs: 3000,
      ...extra,
    },
  };
}

function envFor(home, extra = {}) {
  return {
    MEBULAR_HOME: home,
    PATH: '',
    ...extra,
  };
}

async function fakeHealthServer({ pid = process.pid, profileId = 'default', cloudId = null } = {}) {
  const server = createServer((req, res) => {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    if (req.url?.endsWith('/health')) {
      res.end(JSON.stringify({
        ok: true,
        state: 'ready',
        mode: 'immersive',
        ready: true,
        degraded: false,
        pid,
        profileId,
        cloudId,
      }));
      return;
    }
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  cleanups.push(() => new Promise((resolvePromise) => {
    server.close(() => resolvePromise());
    server.closeAllConnections?.();
  }));
  return server.address().port;
}

async function writeDiscovery(home, {
  port,
  pid = process.pid,
  profileId = 'default',
  cloudId = null,
  tokenFile = join(home, 'memory-runtime', 'host-token'),
  updatedAt = Date.now(),
  startedAt = Date.now(),
  mode = 'immersive',
  state = 'ready',
  url = null,
} = {}) {
  const base = url ?? `http://127.0.0.1:${port}/memory-runtime/v1`;
  await writeFile(join(home, 'memory-runtime.json'), JSON.stringify({
    schema: 1,
    kind: 'mebular-memory-runtime',
    pid,
    host: '127.0.0.1',
    port,
    url: base,
    healthUrl: `${base}/health`,
    cloudId,
    profileId,
    runtimeVersion: '0.3.0',
    apiVersion: 1,
    capabilityApiVersion: 1,
    minMcpVersion: '0.3.0',
    maxMcpVersion: '0.3.x',
    state,
    mode,
    degraded: false,
    tokenFile,
    startedAt,
    updatedAt,
    capabilities: { models: ['heuristic'] },
  }), { mode: 0o600 });
}

describe('MemoryRuntimeSupervisor：生命周期', () => {
  it('enabled：启动 fake sidecar，注入 token/home，ready 后状态可读且不泄漏 token', async () => {
    const home = await tempDir();
    const capabilityToken = await writeCapabilityToken(home, 'cap-secret-abc');
    const envOut = join(home, 'fake-env.json');
    let spawns = 0;
    const supervisor = new MemoryRuntimeSupervisor({
      home,
      config: enabledConfig(),
      env: envFor(home, { FAKE_SIDECAR_ENV_OUT: envOut }),
      profileId: () => 'default',
      mcpUrl: () => 'http://127.0.0.1:7331',
      spawnImpl: (...args) => {
        spawns += 1;
        return spawn(...args);
      },
    });
    cleanups.push(() => supervisor.dispose());

    const status = await supervisor.start();
    expect(spawns).toBe(1);
    expect(status).toMatchObject({
      enabled: true,
      state: 'ready',
      degraded: false,
      managed: true,
      attached: false,
      commandSource: 'config',
    });
    const record = JSON.parse(await readFile(envOut, 'utf-8'));
    expect(record.argv[0]).toBe('serve');
    expect(record.argv).toContain('--parent-pid');
    expect(record.env.MEBULAR_MEMORY_RUNTIME_HOME).toBe(join(home, 'memory-runtime'));
    expect(record.env.MEBULAR_CAPABILITY_TOKEN).toBe(capabilityToken);
    expect(record.env.MEBULAR_MEMORY_RUNTIME_TOKEN).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(record.env.MEBULAR_MCP_URL).toMatch(/^http:\/\/127\.0\.0\.1:/);

    const json = JSON.stringify(await supervisor.status());
    expect(json).not.toContain(capabilityToken);
    expect(json).not.toContain(record.env.MEBULAR_MEMORY_RUNTIME_TOKEN);
    expect(json).not.toMatch(/tokenFile|host-token/);

    await supervisor.stop({ includeAttached: false });
    expect(await supervisor.status()).toMatchObject({ state: 'stopped', pid: null });
  });

  it('managed discovery 清理失败不得报告 clean stopped', async () => {
    if (process.platform === 'win32') return;
    const home = await tempDir();
    await writeCapabilityToken(home);
    const supervisor = new MemoryRuntimeSupervisor({
      home,
      config: enabledConfig(),
      env: envFor(home),
      profileId: () => 'default',
      healthPollMs: 20,
    });
    cleanups.push(async () => {
      await chmod(home, 0o700).catch(() => undefined);
      await supervisor.dispose();
    });
    expect(await supervisor.start()).toMatchObject({ state: 'ready', managed: true });
    await chmod(home, 0o500);
    const stopped = await supervisor.stop({ timeoutMs: 500 });
    expect(stopped).toMatchObject({ state: 'degraded', error: { code: 'disable_incomplete' } });
    expect(existsSync(join(home, 'memory-runtime.json'))).toBe(true);
    await chmod(home, 0o700);
  }, 10000);

  it('disabled：不创建目录/token/discovery/进程', async () => {
    const home = await tempDir();
    let spawns = 0;
    const supervisor = new MemoryRuntimeSupervisor({
      home,
      config: { memoryRuntime: { enabled: false } },
      env: envFor(home),
      spawnImpl: () => { spawns += 1; throw new Error('must not spawn'); },
    });
    cleanups.push(() => supervisor.dispose());

    const status = await supervisor.start();
    expect(spawns).toBe(0);
    expect(status).toMatchObject({ enabled: false, state: 'stopped', reason: 'disabled' });
    expect(existsSync(join(home, 'memory-runtime'))).toBe(false);
    expect(existsSync(join(home, 'memory-runtime.json'))).toBe(false);
  });

  it('MEBULAR_MEMORY_RUNTIME_DISABLE=1：即使 enabled 也不自动启动', async () => {
    const home = await tempDir();
    let spawns = 0;
    const supervisor = new MemoryRuntimeSupervisor({
      home,
      config: enabledConfig(),
      env: envFor(home, { MEBULAR_MEMORY_RUNTIME_DISABLE: '1' }),
      spawnImpl: () => { spawns += 1; throw new Error('must not spawn'); },
    });
    cleanups.push(() => supervisor.dispose());

    expect(await supervisor.start()).toMatchObject({ state: 'stopped', reason: 'disabled' });
    expect(spawns).toBe(0);
    expect(existsSync(join(home, 'memory-runtime'))).toBe(false);
  });

  it('真实 attached 进程：dispose 保留 PID、撤销 discovery 并确认 dormant', async () => {
    const home = await tempDir();
    await writeCapabilityToken(home);
    const external = spawn(process.execPath, [FAKE, 'serve'], {
      env: { ...process.env, ...envFor(home) },
      stdio: 'ignore',
    });
    cleanups.push(async () => {
      if (pidAlive(external.pid)) process.kill(external.pid, 'SIGTERM');
    });
    await waitFor(() => existsSync(join(home, 'memory-runtime.json')));
    const discovery = JSON.parse(await readFile(join(home, 'memory-runtime.json'), 'utf-8'));
    let spawns = 0;
    const supervisor = new MemoryRuntimeSupervisor({
      home,
      config: enabledConfig(),
      env: envFor(home),
      profileId: () => 'default',
      spawnImpl: () => { spawns += 1; throw new Error('must not spawn'); },
    });
    cleanups.push(() => supervisor.dispose());

    const status = await supervisor.start();
    expect(spawns).toBe(0);
    expect(status).toMatchObject({
      state: 'ready', managed: false, attached: true, pid: external.pid, runtimeVersion: '0.3.0',
    });
    await supervisor.dispose();
    expect(pidAlive(external.pid)).toBe(true);
    expect(existsSync(join(home, 'memory-runtime.json'))).toBe(false);
    const hostToken = JSON.parse(await readFile(discovery.tokenFile, 'utf-8')).token;
    const dormant = await fetch(`${discovery.url}/status`, {
      headers: { authorization: `Bearer ${hostToken}` },
    });
    expect(dormant.status).toBe(200);
    expect((await dormant.json()).data.mode).toBe('mcp');
    const rejected = await fetch(`${discovery.url}/ingest`, {
      method: 'POST',
      headers: { authorization: `Bearer ${hostToken}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(rejected.status).toBe(409);
    expect((await rejected.json()).error.code).toBe('mode_mismatch');
  });

  it('stale/dead/mode discovery 不就绪，只读 status 绝不 unlink', async () => {
    const home = await tempDir();
    const port = await fakeHealthServer();
    const now = 2_000_000;
    const supervisor = new MemoryRuntimeSupervisor({
      home,
      config: enabledConfig(),
      env: envFor(home),
      now: () => now,
      profileId: () => 'default',
      spawnImpl: () => { throw new Error('must not spawn'); },
    });
    cleanups.push(() => supervisor.dispose());
    cleanups.push(() => rm(join(home, 'memory-runtime.json'), { force: true }));

    await writeDiscovery(home, { port, updatedAt: now - 15_001 });
    const staleRaw = await readFile(join(home, 'memory-runtime.json'), 'utf-8');
    expect(await supervisor.status()).toMatchObject({
      state: 'degraded', available: false, error: { code: 'discovery_stale' },
    });
    expect(await readFile(join(home, 'memory-runtime.json'), 'utf-8')).toBe(staleRaw);

    await writeDiscovery(home, { port, updatedAt: now - 30_001 });
    expect(await supervisor.status()).toMatchObject({
      state: 'failed', available: false, error: { code: 'discovery_dead' },
    });
    expect(existsSync(join(home, 'memory-runtime.json'))).toBe(true);

    await writeDiscovery(home, { port, pid: 999_999, updatedAt: now });
    expect(await supervisor.status()).toMatchObject({
      state: 'stopped', available: false, error: { code: 'discovery_dead' },
    });
    expect(existsSync(join(home, 'memory-runtime.json'))).toBe(true);

    await rm(join(home, 'memory-runtime.json'));
    expect(await supervisor.status()).toMatchObject({ state: 'stopped', error: null });
    await writeDiscovery(home, { port, updatedAt: now, mode: 'mcp', state: 'stopped' });
    expect(await supervisor.status()).toMatchObject({ state: 'stopped', available: false, error: null });
    await writeDiscovery(home, { port, updatedAt: now, mode: 'mcp', state: 'degraded' });
    expect(await supervisor.status()).toMatchObject({
      state: 'degraded', available: false, error: { code: 'disable_incomplete' },
    });
  });

  it('非 loopback discovery 不发送 health 或凭据', async () => {
    const home = await tempDir();
    let fetches = 0;
    const supervisor = new MemoryRuntimeSupervisor({
      home,
      config: enabledConfig(),
      env: envFor(home),
      profileId: () => 'default',
      fetchImpl: async () => {
        fetches += 1;
        throw new Error('must not fetch');
      },
    });
    cleanups.push(() => supervisor.dispose());
    cleanups.push(() => rm(join(home, 'memory-runtime.json'), { force: true }));
    await writeDiscovery(home, {
      port: 7341,
      url: 'http://192.168.1.20:7341/memory-runtime/v1',
    });
    expect(await supervisor.status()).toMatchObject({
      state: 'failed', available: false, error: { code: 'discovery_invalid' },
    });
    expect(fetches).toBe(0);
  });

  it('health PID 不匹配时不得向该 loopback 服务转发 host token', async () => {
    const home = await tempDir();
    const port = await fakeHealthServer({ pid: process.pid + 1 });
    await writeDiscovery(home, { port, pid: process.pid });
    const calls = [];
    const supervisor = new MemoryRuntimeSupervisor({
      home,
      config: enabledConfig(),
      env: envFor(home),
      profileId: () => 'default',
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init });
        return fetch(url, init);
      },
    });
    cleanups.push(() => supervisor.dispose());
    cleanups.push(() => rm(join(home, 'memory-runtime.json'), { force: true }));
    const result = await supervisor.readStatus();
    expect(result).toMatchObject({ available: false, error: { code: 'instance_mismatch' } });
    expect(calls.some((call) => call.url.endsWith('/status'))).toBe(false);
    expect(calls.every((call) => !call.init?.authorization)).toBe(true);
  });

  it('stale discovery 的 dormant probe 不发送 HTTP，禁用保持 incomplete', async () => {
    const home = await tempDir();
    const port = await fakeHealthServer();
    const now = Date.now();
    await writeDiscovery(home, { port, updatedAt: now - 16_000 });
    let calls = 0;
    const supervisor = new MemoryRuntimeSupervisor({
      home,
      config: enabledConfig(),
      env: envFor(home),
      profileId: () => 'default',
      fetchImpl: async (...args) => {
        calls += 1;
        return fetch(...args);
      },
    });
    cleanups.push(() => supervisor.dispose());
    const stopped = await supervisor.stop({ timeoutMs: 50 });
    expect(stopped).toMatchObject({ state: 'degraded', error: { code: 'disable_incomplete' } });
    expect(calls).toBe(0);
  });

  it('显式 attached stop 也清理已退出实例的匹配 discovery', async () => {
    const home = await tempDir();
    await writeDiscovery(home, { port: 7401, pid: 999_999 });
    const supervisor = new MemoryRuntimeSupervisor({
      home,
      config: enabledConfig(),
      env: envFor(home),
      profileId: () => 'default',
    });
    cleanups.push(() => supervisor.dispose());
    expect(await supervisor.stop({ includeAttached: true, timeoutMs: 50 }))
      .toMatchObject({ state: 'stopped', error: null });
    expect(existsSync(join(home, 'memory-runtime.json'))).toBe(false);
  });

  it('profile / home 不匹配：拒绝接管且不 spawn', async () => {
    const home = await tempDir();
    const port = await fakeHealthServer();
    await writeDiscovery(home, { port, pid: 999_999, profileId: 'other' });
    let spawns = 0;
    const supervisor = new MemoryRuntimeSupervisor({
      home,
      config: enabledConfig(),
      env: envFor(home),
      profileId: () => 'default',
      spawnImpl: () => { spawns += 1; throw new Error('must not spawn'); },
    });
    cleanups.push(() => supervisor.dispose());

    expect(await supervisor.start()).toMatchObject({
      state: 'failed',
      error: { code: 'profile_mismatch' },
    });
    expect(spawns).toBe(0);

    const homeMismatch = await tempDir();
    await writeDiscovery(homeMismatch, {
      port,
      tokenFile: join(homeMismatch, 'other', 'host-token'),
    });
    const other = new MemoryRuntimeSupervisor({
      home: homeMismatch,
      config: enabledConfig(),
      env: envFor(homeMismatch),
      spawnImpl: () => { spawns += 1; throw new Error('must not spawn'); },
    });
    cleanups.push(() => other.dispose());
    expect(await other.start()).toMatchObject({
      state: 'failed',
      error: { code: 'home_mismatch' },
    });
    expect(spawns).toBe(0);
  });
  it('host 401：新实例 JSON token 重读一次，request-id 不变且历次 token 均脱敏', async () => {
    const home = await tempDir();
    const tokenA = 'host-token-a-012345678901234567890';
    const tokenB = 'host-token-b-987654321098765432109';
    await writeHostToken(home, tokenA);
    const port = 7401;
    await writeDiscovery(home, { port, pid: process.pid });
    const replacement = spawn(process.execPath, ['--eval', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    cleanups.push(async () => {
      if (pidAlive(replacement.pid)) process.kill(replacement.pid, 'SIGTERM');
    });
    const productCalls = [];
    const supervisor = new MemoryRuntimeSupervisor({
      home,
      config: enabledConfig(),
      env: envFor(home),
      profileId: () => 'default',
      fetchImpl: async (url, init = {}) => {
        const parsed = new URL(String(url));
        if (parsed.pathname.endsWith('/health')) {
          const current = JSON.parse(await readFile(join(home, 'memory-runtime.json'), 'utf-8'));
          return new Response(JSON.stringify({
            ok: true,
            ready: true,
            state: 'ready',
            mode: 'immersive',
            degraded: false,
            pid: current.pid,
            profileId: 'default',
            cloudId: null,
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (parsed.pathname.includes('/recall/')) {
          productCalls.push({ url: String(url), headers: init.headers });
          if (productCalls.length === 1) {
            await writeHostToken(home, tokenB);
            await writeDiscovery(home, {
              port: port + 1,
              pid: replacement.pid,
              startedAt: Date.now() + 1000,
            });
            return new Response(JSON.stringify({ ok: false, error: { code: 'invalid_token' } }), { status: 401 });
          }
          return new Response(JSON.stringify({
            ok: true,
            data: {
              traceId: 'tr_rotate',
              feedback: { useful: true },
              note: `old=${tokenA} new=${tokenB}`,
            },
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        throw new Error(`unexpected fetch ${parsed.pathname}`);
      },
    });
    cleanups.push(() => supervisor.dispose());
    cleanups.push(() => rm(join(home, 'memory-runtime.json'), { force: true }));
    const result = await supervisor.submitRecallFeedback('tr_rotate', { useful: true });
    expect(result.statusCode).toBe(200);
    expect(productCalls).toHaveLength(2);
    expect(productCalls[0].headers.authorization).toBe(`Bearer ${tokenA}`);
    expect(productCalls[1].headers.authorization).toBe(`Bearer ${tokenB}`);
    expect(productCalls[1].headers['x-request-id']).toBe(productCalls[0].headers['x-request-id']);
    expect(productCalls[0].url).not.toBe(productCalls[1].url);
    expect(JSON.stringify(result.body)).not.toContain(tokenA);
    expect(JSON.stringify(result.body)).not.toContain(tokenB);
  });

  it('禁用期间出现替换实例 B：同样撤销并验证，不能因 A 已 dormant 而漏过', async () => {
    const home = await tempDir();
    await writeHostToken(home, 'replacement-token-a-0123456789');
    await writeDiscovery(home, { port: 7401, pid: process.pid });
    const replacement = spawn(process.execPath, ['--eval', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    cleanups.push(async () => {
      if (pidAlive(replacement.pid)) process.kill(replacement.pid, 'SIGTERM');
    });
    const supervisor = new MemoryRuntimeSupervisor({
      home,
      config: enabledConfig(),
      env: envFor(home),
      profileId: () => 'default',
      fetchImpl: async (url) => {
        const parsed = new URL(String(url));
        const isB = parsed.port === '7402';
        const pid = isB ? replacement.pid : process.pid;
        if (parsed.pathname.endsWith('/health')) {
          return new Response(JSON.stringify({
            ok: true,
            ready: false,
            state: 'stopped',
            mode: 'mcp',
            pid,
            profileId: 'default',
            cloudId: null,
          }), { status: 200 });
        }
        if (parsed.pathname.endsWith('/status')) {
          if (!isB) {
            await writeHostToken(home, 'replacement-token-b-9876543210');
            await writeDiscovery(home, { port: 7402, pid: replacement.pid });
          }
          return new Response(JSON.stringify({
            ok: true,
            data: { mode: 'mcp', state: 'stopped', pid },
          }), { status: 200 });
        }
        throw new Error(`unexpected ${parsed.pathname}`);
      },
    });
    cleanups.push(() => supervisor.dispose());
    const result = await supervisor.stop({ timeoutMs: 500 });
    expect(result).toMatchObject({ state: 'stopped', error: null });
    expect(pidAlive(replacement.pid)).toBe(true);
    expect(existsSync(join(home, 'memory-runtime.json'))).toBe(false);
  });

  it('MCP 重启：等待父监督回收旧 managed child，再启动唯一新 child', async () => {
    const home = await tempDir();
    await writeCapabilityToken(home);
    const old = spawn(process.execPath, [FAKE, 'serve', '--parent-pid', '999999'], {
      env: { ...process.env, ...envFor(home, { FAKE_SIDECAR_PARENT_CHECK_MS: '500' }) },
      stdio: 'ignore',
    });
    cleanups.push(async () => {
      if (pidAlive(old.pid)) process.kill(old.pid, 'SIGTERM');
    });
    await waitFor(() => existsSync(join(home, 'memory-runtime.json')));
    let spawns = 0;
    const supervisor = new MemoryRuntimeSupervisor({
      home,
      config: enabledConfig({ startTimeoutMs: 2500 }),
      env: envFor(home),
      profileId: () => 'default',
      healthPollMs: 20,
      spawnImpl: (...args) => {
        spawns += 1;
        return spawn(...args);
      },
    });
    cleanups.push(() => supervisor.dispose());
    const ready = await supervisor.start();
    expect(spawns).toBe(1);
    expect(ready).toMatchObject({ state: 'ready', managed: true, attached: false });
    expect(ready.pid).not.toBe(old.pid);
    await waitFor(() => !pidAlive(old.pid));
  }, 10000);
});

describe('MemoryRuntimeSupervisor：崩溃与超时', () => {
  it('崩溃退避：最多 2 次重启后进入 restart_limit', async () => {
    const home = await tempDir();
    await writeCapabilityToken(home);
    const spawnsOut = join(home, 'spawns.txt');
    let spawns = 0;
    const supervisor = new MemoryRuntimeSupervisor({
      home,
      config: enabledConfig({ startTimeoutMs: 1000 }),
      env: envFor(home, {
        FAKE_SIDECAR_MODE: 'crash',
        FAKE_SIDECAR_EXIT_AFTER_MS: '5',
        FAKE_SIDECAR_SPAWNS_OUT: spawnsOut,
      }),
      startTimeoutMs: 1000,
      healthPollMs: 20,
      restartBackoffMs: 20,
      restartBackoffMaxMs: 40,
      maxRestartsInWindow: 2,
      spawnImpl: (...args) => {
        spawns += 1;
        return spawn(...args);
      },
    });
    cleanups.push(() => supervisor.dispose());

    await supervisor.start();
    const limited = await waitFor(async () => {
      const status = await supervisor.status();
      return status.error?.code === 'restart_limit' ? status : null;
    }, { timeoutMs: 5000 });
    expect(limited.state).toBe('failed');
    expect(spawns).toBe(3);
    expect((await readFile(spawnsOut, 'utf-8')).trim().split('\n')).toHaveLength(3);
  });

  it('启动超时：start_timeout，不阻塞调用方', async () => {
    const home = await tempDir();
    await writeCapabilityToken(home);
    let spawns = 0;
    const supervisor = new MemoryRuntimeSupervisor({
      home,
      config: enabledConfig({ startTimeoutMs: 120 }),
      env: envFor(home, { FAKE_SIDECAR_MODE: 'hang' }),
      startTimeoutMs: 120,
      healthPollMs: 20,
      maxRestartsInWindow: 0,
      spawnImpl: (...args) => {
        spawns += 1;
        return spawn(...args);
      },
    });
    cleanups.push(() => supervisor.dispose());

    const startedAt = Date.now();
    const status = await supervisor.start();
    expect(Date.now() - startedAt).toBeLessThan(2500);
    expect(spawns).toBe(1);
    expect(status).toMatchObject({
      state: 'failed',
      error: { code: 'start_timeout' },
    });
  });
});

describe('MemoryRuntimeSupervisor：命令解析', () => {
  it('优先级：memoryRuntime.command > MEBULAR_MEMORY_RUNTIME_BIN > 包内 bin', async () => {
    const home = await tempDir();
    const configured = join(home, 'configured.mjs');
    const fromEnv = join(home, 'env.mjs');
    await writeFile(configured, '// configured\n');
    await writeFile(fromEnv, '// env\n');

    expect(resolveMemoryRuntimeCommand({
      config: { memoryRuntime: { command: configured } },
      env: envFor(home, { MEBULAR_MEMORY_RUNTIME_BIN: fromEnv }),
    })).toMatchObject({ ok: true, command: configured, source: 'config' });

    expect(resolveMemoryRuntimeCommand({
      config: {},
      env: envFor(home, { MEBULAR_MEMORY_RUNTIME_BIN: fromEnv }),
    })).toMatchObject({ ok: true, command: fromEnv, source: 'env' });

    const bundled = resolveMemoryRuntimeCommand({ config: {}, env: envFor(home) });
    expect(bundled).toMatchObject({ ok: true, source: 'bundled' });
    expect(bundled.command).toContain('memory-runtime');
    expect(bundled.command).toContain('mebular-memory-runtime.mjs');
  });

  it('显式 env 指向不存在文件：not_installed，不静默回退', async () => {
    const home = await tempDir();
    expect(resolveMemoryRuntimeCommand({
      config: {},
      env: envFor(home, { MEBULAR_MEMORY_RUNTIME_BIN: join(home, 'missing') }),
    })).toMatchObject({ ok: false, source: 'env', reason: 'not_installed' });
  });
});
