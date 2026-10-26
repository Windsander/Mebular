// 共享 Runtime Supervisor：上下文解析 / provider 发现 / ensure 分支 / 只读状态。
//
// 全部确定性、离线、无真实守护：health/service/spawn/port 均可注入替身。
// 覆盖：默认与自定义 cloudRoot、current profile、显式 home、active lock、instance mismatch、
// service、provider、端口冲突、启动锁、无 provider → download_required。

import { describe, it, expect, afterEach } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { homeKey, writeRegistry } from '../../packages/mcp/src/profiles.mjs';
import { registerRuntimeProvider, runtimeProvidersPath } from '../../packages/mcp/src/runtime-providers.mjs';
import {
  RUNTIME_START_LOCK_FILE,
  discoverRuntimeProviders,
  ensureRuntime,
  isPortOpen,
  probeRuntimeHealth,
  resolveRuntime,
  resolveRuntimeContext,
  resolveRuntimeHttp,
  runtimeStartLockPath,
  runtimeStatus,
  stopRuntimeChild,
  stopRuntimeChildGracefully,
  superviseRuntime,
  toPublicRuntimeResult,
  tryAcquireRuntimeStartLock,
  waitForRuntime,
} from '../../packages/mcp/src/runtime-supervisor.mjs';

const tempDirs = [];

async function tempDir(prefix = 'runtime-supervisor-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    await rm(dir, { recursive: true, force: true });
  }
});

function profileEntry(id, name, home, extra = {}) {
  return {
    id,
    name,
    home,
    kind: 'delegated',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastUsedAt: null,
    masterFingerprint: null,
    deviceId: 'device-test',
    ...extra,
  };
}

async function makeRoot({ current = 'default', port = 17331 } = {}) {
  const userHome = await tempDir('runtime-user-');
  const root = join(userHome, '.mebular');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'config.json'), JSON.stringify({
    deviceId: 'device-test',
    mcp: { http: { host: '127.0.0.1', port, auth: 'none' } },
  }, null, 2), 'utf-8');
  await writeRegistry(root, {
    v: 1,
    current,
    profiles: [
      profileEntry('default', '忆云 1', '.', { kind: 'root' }),
      profileEntry('p_a', '忆云 2', 'profiles/p_a'),
    ],
  });
  return { root, userHome };
}

function envFor(root, extra = {}) {
  return { PATH: process.env.PATH ?? '', MEBULAR_CLOUD_ROOT: root, ...extra };
}

const down = async () => ({ ok: false, reason: 'unreachable' });
const mismatch = async () => ({ ok: false, reason: 'instance_mismatch', instance: 'other' });
const waitTimeout = async () => ({ ok: false, reason: 'timeout' });

function healthy(home, { version = '0.1.2', cloudId = 'default' } = {}) {
  return async () => ({
    ok: true,
    body: { status: 'ok', instance: homeKey(home), version, cloudId },
    instance: homeKey(home),
  });
}

function fakeSpawn() {
  const calls = [];
  const child = {
    pid: 4242,
    exitCode: null,
    signalCode: null,
    killed: false,
    unrefed: false,
    signals: [],
    unref() { this.unrefed = true; },
    kill(signal) {
      this.killed = true;
      this.signal = signal;
      this.signals.push(signal);
      return true;
    },
  };
  return {
    calls,
    child,
    spawnFn: (execPath, args, options) => {
      calls.push({ execPath, args, options });
      return child;
    },
  };
}

/** 可控 child：只在指定信号上退出，用于验证 SIGTERM→SIGKILL 升级与 supervise 生命周期。 */
function controllableChild({ exitOn = 'SIGTERM' } = {}) {
  const listeners = new Map();
  const emit = (event, ...args) => {
    for (const listener of listeners.get(event) ?? []) listener(...args);
  };
  const child = {
    pid: 5151,
    exitCode: null,
    signalCode: null,
    killed: false,
    signals: [],
    unrefed: false,
    unref() { this.unrefed = true; },
    once(event, listener) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      return this;
    },
    removeListener(event, listener) {
      const list = (listeners.get(event) ?? []).filter((entry) => entry !== listener);
      listeners.set(event, list);
      return this;
    },
    emit,
    kill(signal) {
      this.killed = true;
      this.signals.push(signal);
      if (signal === exitOn) {
        this.signalCode = signal;
        setImmediate(() => emit('exit', null, signal));
      }
      return true;
    },
  };
  return child;
}

function fakeService({ registered = false, running = false } = {}) {
  const calls = { status: 0, restart: 0 };
  return {
    calls,
    service: {
      async status() {
        calls.status += 1;
        return {
          ok: true,
          registered,
          running,
          label: 'com.mebular.serve.test',
          autostart: true,
          foreign: false,
          unitPath: '/tmp/unit',
        };
      },
      async restart() {
        calls.restart += 1;
        return { ok: true };
      },
    },
  };
}

async function fakeProviderFile(root, name = 'provider-bin.mjs') {
  const path = join(root, name);
  await writeFile(path, '// fake provider\n', 'utf-8');
  return path;
}

function providerRecord(path, extra = {}) {
  return {
    id: 'provider_test',
    kind: 'cli',
    path,
    version: '1.2.3',
    capabilities: ['serve'],
    registeredAt: null,
    updatedAt: null,
    ...extra,
  };
}

describe('resolveRuntimeContext：root / profile / home', () => {
  it('默认 root + default profile；显式 profile home 生效', async () => {
    const { root, userHome } = await makeRoot();
    const context = await resolveRuntimeContext({
      env: envFor(root, { MEBULAR_HOME: root }),
      userHome,
    });
    expect(context.ok).toBe(true);
    expect(context.cloudRoot).toBe(root);
    expect(context.profileId).toBe('default');
    expect(context.home).toBe(root);

    const viaProfile = await resolveRuntimeContext({
      env: envFor(root, { MEBULAR_HOME: join(root, 'profiles', 'p_a') }),
      userHome,
    });
    expect(viaProfile.profileId).toBe('p_a');
    expect(viaProfile.home).toBe(join(root, 'profiles', 'p_a'));
  });

  it('未显式指定 home 时跟随 current profile（非默认）', async () => {
    const { root, userHome } = await makeRoot({ current: 'p_a' });
    const context = await resolveRuntimeContext({ env: envFor(root), userHome });
    expect(context.profileId).toBe('p_a');
    expect(context.home).toBe(join(root, 'profiles', 'p_a'));
  });

  it('显式 home=默认 root 但 current 非默认 → 仍跟随 current（Plugin/CLI 共存关键）', async () => {
    const { root, userHome } = await makeRoot({ current: 'p_a' });
    const context = await resolveRuntimeContext({
      env: envFor(root, { MEBULAR_HOME: root }),
      userHome,
    });
    expect(context.profileId).toBe('p_a');
    expect(context.home).toBe(join(root, 'profiles', 'p_a'));
  });

  it('custom MEBULAR_CLOUD_ROOT：无 home 时落到 root 自身', async () => {
    const userHome = await tempDir('runtime-user-');
    const root = join(userHome, 'custom-cloud');
    await mkdir(root, { recursive: true });
    const context = await resolveRuntimeContext({
      env: { PATH: process.env.PATH ?? '', MEBULAR_CLOUD_ROOT: root },
      userHome,
    });
    expect(context.ok).toBe(true);
    expect(context.cloudRoot).toBe(root);
    expect(context.home).toBe(root);
    expect(context.profileId).toBe(null);
  });

  it('自定义 home / 受限 env → 不可用（不误闯新档案）', async () => {
    const userHome = await tempDir('runtime-user-');
    const context = await resolveRuntimeContext({
      env: { PATH: process.env.PATH ?? '', MEBULAR_HOME: join(userHome, 'custom-home') },
      userHome,
    });
    expect(context.ok).toBe(false);
    expect(context.reason).toBe('custom_home');
  });

  it('HTTP 目标：env > runtime.json > config > 默认；0.0.0.0 归一为 loopback', async () => {
    const { root } = await makeRoot({ port: 17331 });
    const fromConfig = await resolveRuntimeHttp(root, { env: {} });
    expect(fromConfig).toMatchObject({ host: '127.0.0.1', port: 17331 });

    const fromRuntime = await resolveRuntimeHttp(root, {
      env: {},
      runtime: { http: { host: '0.0.0.0', port: 18444 } },
    });
    expect(fromRuntime).toMatchObject({ host: '127.0.0.1', port: 18444 });

    const fromEnv = await resolveRuntimeHttp(root, {
      env: { MEBULAR_HTTP_PORT: '19555', MEBULAR_HTTP_HOST: '0.0.0.0' },
      runtime: { http: { port: 18444 } },
    });
    expect(fromEnv).toMatchObject({ host: '127.0.0.1', port: 19555 });
  });
});

describe('健康探测 / 等待 / 端口', () => {
  it('probeRuntimeHealth：instance/cloudId 校验与终态原因', async () => {
    const home = '/tmp/mebular-health-home';
    const http = { host: '127.0.0.1', port: 7331, scheme: 'http', url: 'http://127.0.0.1:7331/healthz' };
    const expected = homeKey(home);

    const ok = await probeRuntimeHealth(async () => ({
      ok: true,
      json: async () => ({ instance: expected, version: '1.0.0' }),
    }), http, { expectedInstance: expected });
    expect(ok).toMatchObject({ ok: true, instance: expected });

    const mismatchResult = await probeRuntimeHealth(async () => ({
      ok: true,
      json: async () => ({ instance: 'other' }),
    }), http, { expectedInstance: expected });
    expect(mismatchResult).toMatchObject({ ok: false, reason: 'instance_mismatch' });

    const missing = await probeRuntimeHealth(async () => ({ ok: true, json: async () => ({}) }), http, { expectedInstance: expected });
    expect(missing).toMatchObject({ ok: false, reason: 'instance_missing' });

    const cloudMismatch = await probeRuntimeHealth(async () => ({
      ok: true,
      json: async () => ({ instance: expected, cloudId: 'p_other' }),
    }), http, { expectedInstance: expected, cloudId: 'p_a' });
    expect(cloudMismatch).toMatchObject({ ok: false, reason: 'cloud_mismatch' });

    const status = await probeRuntimeHealth(async () => ({ ok: false, status: 503 }), http);
    expect(status).toMatchObject({ ok: false, reason: 'status', status: 503 });

    const unreachable = await probeRuntimeHealth(async () => { throw new Error('ECONNREFUSED'); }, http);
    expect(unreachable).toMatchObject({ ok: false, reason: 'unreachable' });
  });

  it('waitForRuntime：重试到健康；instance mismatch 立即终止', async () => {
    const http = { url: 'http://127.0.0.1:7331/healthz' };
    let calls = 0;
    const flaky = async () => {
      calls += 1;
      if (calls < 3) throw new Error('ECONNREFUSED');
      return { ok: true, json: async () => ({ instance: 'abc' }) };
    };
    const ok = await waitForRuntime({ fetchImpl: flaky, http, attempts: 5, intervalMs: 1, expectedInstance: 'abc' });
    expect(ok.ok).toBe(true);
    expect(calls).toBe(3);

    let terminalCalls = 0;
    const mismatchFetch = async () => {
      terminalCalls += 1;
      return { ok: true, json: async () => ({ instance: 'other' }) };
    };
    const terminal = await waitForRuntime({
      fetchImpl: mismatchFetch,
      http,
      attempts: 5,
      intervalMs: 1,
      expectedInstance: 'abc',
    });
    expect(terminal).toMatchObject({ ok: false, reason: 'instance_mismatch' });
    expect(terminalCalls).toBe(1);
  });

  it('isPortOpen：监听中 true，关闭后 false', async () => {
    const server = createServer();
    await new Promise((resolvePromise, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolvePromise);
    });
    const port = server.address().port;
    try {
      expect(await isPortOpen({ host: '127.0.0.1', port })).toBe(true);
    } finally {
      await new Promise((resolvePromise) => server.close(resolvePromise));
    }
    expect(await isPortOpen({ host: '127.0.0.1', port }, 200)).toBe(false);
  });
});

describe('discoverRuntimeProviders', () => {
  it('注册表 provider 优先；缺失路径只诊断不启动；self 兜底', async () => {
    const { root } = await makeRoot();
    const path = await fakeProviderFile(root);
    await registerRuntimeProvider(root, { kind: 'cli', path, version: '1.2.3', capabilities: ['serve', 'console'] });
    await registerRuntimeProvider(root, { kind: 'shared', path: join(root, 'missing', 'mebular') });

    const discovery = await discoverRuntimeProviders({
      root,
      env: envFor(root),
      includeSelf: true,
      includeStandardApp: false,
    });
    expect(discovery.entries).toHaveLength(3);
    expect(discovery.available).toHaveLength(2);
    expect(discovery.selected).toMatchObject({ kind: 'cli', path, version: '1.2.3', source: 'registry' });
    expect(discovery.entries.find((entry) => entry.kind === 'shared')).toMatchObject({ available: false });
    expect(discovery.available.some((entry) => entry.source === 'self')).toBe(true);
  });
});

describe('ensureRuntime：attach / service / child / download_required', () => {
  it('健康 daemon → reused，不 spawn、不重启 service', async () => {
    const { root, userHome } = await makeRoot();
    const spawn = fakeSpawn();
    const fake = fakeService();
    const result = await ensureRuntime({
      env: envFor(root),
      userHome,
      probeHealthFn: healthy(root),
      probePortFn: async () => false,
      service: fake.service,
      registryProviders: [],
      includeSelf: false,
      includeStandardApp: false,
      spawnFn: spawn.spawnFn,
    });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('reused');
    expect(result.child).toBeUndefined();
    expect(result.daemon).toMatchObject({ status: 'up', version: '0.1.2' });
    expect(spawn.calls).toHaveLength(0);
    expect(fake.calls.restart).toBe(0);
  });

  it('instance mismatch → conflict，不 spawn', async () => {
    const { root, userHome } = await makeRoot();
    const spawn = fakeSpawn();
    const result = await ensureRuntime({
      env: envFor(root),
      userHome,
      probeHealthFn: mismatch,
      probePortFn: async () => false,
      service: fakeService().service,
      registryProviders: [],
      includeSelf: false,
      includeStandardApp: false,
      spawnFn: spawn.spawnFn,
    });
    expect(result.ok).toBe(false);
    expect(result.mode).toBe('conflict');
    expect(result.reason).toBe('instance_mismatch');
    expect(spawn.calls).toHaveLength(0);
  });

  it('root active.lock 被另一 home 的活 PID 占用 → CLOUD_ALREADY_ACTIVE', async () => {
    const { root, userHome } = await makeRoot();
    await writeFile(join(root, 'active.lock'), JSON.stringify({
      pid: process.pid,
      home: join(root, 'profiles', 'p_a'),
      profileId: 'p_a',
      startedAt: new Date().toISOString(),
    }), 'utf-8');
    const spawn = fakeSpawn();
    const result = await ensureRuntime({
      env: envFor(root),
      userHome,
      probeHealthFn: down,
      probePortFn: async () => false,
      service: fakeService().service,
      registryProviders: [],
      includeSelf: false,
      includeStandardApp: false,
      spawnFn: spawn.spawnFn,
    });
    expect(result.ok).toBe(false);
    expect(result.mode).toBe('conflict');
    expect(result.reason).toBe('CLOUD_ALREADY_ACTIVE');
    expect(result.activeLock).toMatchObject({ conflict: true, profileId: 'p_a' });
    expect(spawn.calls).toHaveLength(0);
  });

  it('已注册 service → 重启并等待健康（mode service）', async () => {
    const { root, userHome } = await makeRoot();
    const fake = fakeService({ registered: true });
    const spawn = fakeSpawn();
    const result = await ensureRuntime({
      env: envFor(root),
      userHome,
      probeHealthFn: down,
      probePortFn: async () => false,
      service: fake.service,
      waitForHealthFn: healthy(root),
      registryProviders: [],
      includeSelf: false,
      includeStandardApp: false,
      spawnFn: spawn.spawnFn,
    });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('service');
    expect(result.service).toMatchObject({ registered: true, running: true, restarted: true });
    expect(fake.calls.restart).toBe(1);
    expect(spawn.calls).toHaveLength(0);
  });

  it('已注册 service 时显式 --start child 仍走 service，不得 spawn/返回 child', async () => {
    const { root, userHome } = await makeRoot();
    const path = await fakeProviderFile(root);
    const fake = fakeService({ registered: true });
    const spawn = fakeSpawn();
    const result = await ensureRuntime({
      env: envFor(root),
      userHome,
      mode: 'child',
      probeHealthFn: down,
      probePortFn: async () => false,
      service: fake.service,
      waitForHealthFn: healthy(root),
      registryProviders: [providerRecord(path)],
      includeSelf: false,
      includeStandardApp: false,
      spawnFn: spawn.spawnFn,
    });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('service');
    expect(result.child).toBeUndefined();
    expect(fake.calls.restart).toBe(1);
    expect(spawn.calls).toHaveLength(0);
  });

  it('显式 --start service 但未注册 → service_not_registered，不 spawn', async () => {
    const { root, userHome } = await makeRoot();
    const path = await fakeProviderFile(root);
    const spawn = fakeSpawn();
    const result = await ensureRuntime({
      env: envFor(root),
      userHome,
      mode: 'service',
      probeHealthFn: down,
      probePortFn: async () => false,
      service: fakeService({ registered: false }).service,
      registryProviders: [providerRecord(path)],
      includeSelf: false,
      includeStandardApp: false,
      spawnFn: spawn.spawnFn,
    });
    expect(result.ok).toBe(false);
    expect(result.mode).toBe('error');
    expect(result.reason).toBe('service_not_registered');
    expect(spawn.calls).toHaveLength(0);
  });

  it('注册表 provider → child；detached 时 unref，成功返回 child 句柄', async () => {
    const { root, userHome } = await makeRoot();
    const path = await fakeProviderFile(root);
    await registerRuntimeProvider(root, { kind: 'cli', path, version: '1.2.3' });
    const spawn = fakeSpawn();
    const result = await ensureRuntime({
      env: envFor(root),
      userHome,
      detached: true,
      probeHealthFn: down,
      probePortFn: async () => false,
      service: fakeService().service,
      waitForHealthFn: healthy(root, { version: '1.2.3' }),
      includeSelf: false,
      includeStandardApp: false,
      spawnFn: spawn.spawnFn,
    });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('child');
    expect(result.version).toBe('1.2.3');
    expect(result.provider).toMatchObject({ kind: 'cli', path, version: '1.2.3', source: 'registry' });
    expect(spawn.calls[0].args).toEqual([path, 'serve', '--port', '17331']);
    expect(spawn.calls[0].options.env).toMatchObject({
      MEBULAR_HOME: root,
      MEBULAR_CLOUD_ROOT: root,
      ELECTRON_RUN_AS_NODE: '1',
    });
    expect(spawn.child.unrefed).toBe(true);
    expect(spawn.calls[0].options.detached).toBe(true);
    expect(toPublicRuntimeResult(result).child).toBeUndefined();
  });

  it('无 provider → download_required；allowDownload=true 也不下载/不 spawn', async () => {
    const { root, userHome } = await makeRoot();
    const spawn = fakeSpawn();
    const result = await ensureRuntime({
      env: envFor(root),
      userHome,
      allowDownload: true,
      probeHealthFn: down,
      probePortFn: async () => false,
      service: fakeService().service,
      registryProviders: [],
      includeSelf: false,
      includeStandardApp: false,
      spawnFn: spawn.spawnFn,
    });
    expect(result.ok).toBe(false);
    expect(result.mode).toBe('download_required');
    expect(result.reason).toBe('download_required');
    expect(result.download).toMatchObject({ required: true, allowed: false, requested: true });
    expect(result.bootstrap).toMatchObject({ state: 'download_required', allowDownload: false });
    expect(spawn.calls).toHaveLength(0);
  });

  it('child 启动后健康失败 → 停止自己拉起的 child，返回 start_failed', async () => {
    const { root, userHome } = await makeRoot();
    const path = await fakeProviderFile(root);
    const spawn = fakeSpawn();
    const result = await ensureRuntime({
      env: envFor(root),
      userHome,
      probeHealthFn: down,
      probePortFn: async () => false,
      service: fakeService().service,
      waitForHealthFn: waitTimeout,
      registryProviders: [providerRecord(path)],
      includeSelf: false,
      includeStandardApp: false,
      spawnFn: spawn.spawnFn,
    });
    expect(result.ok).toBe(false);
    expect(result.mode).toBe('error');
    expect(result.reason).toBe('start_failed');
    expect(spawn.child.killed).toBe(true);
    expect(spawn.child.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('端口被非 Mebular 程序占用 → port_in_use，不 spawn', async () => {
    const { root, userHome } = await makeRoot();
    const path = await fakeProviderFile(root);
    const spawn = fakeSpawn();
    const result = await ensureRuntime({
      env: envFor(root),
      userHome,
      probeHealthFn: down,
      probePortFn: async () => true,
      service: fakeService().service,
      registryProviders: [providerRecord(path)],
      includeSelf: false,
      includeStandardApp: false,
      spawnFn: spawn.spawnFn,
    });
    expect(result.ok).toBe(false);
    expect(result.mode).toBe('conflict');
    expect(result.reason).toBe('port_in_use');
    expect(spawn.calls).toHaveLength(0);
  });

  it('另一个入口持启动锁 → 等待健康超时返回 start_locked，不 spawn', async () => {
    const { root, userHome } = await makeRoot();
    const path = await fakeProviderFile(root);
    await writeFile(runtimeStartLockPath(root), JSON.stringify({
      pid: process.pid,
      home: root,
      startedAt: new Date().toISOString(),
    }), 'utf-8');
    const spawn = fakeSpawn();
    const result = await ensureRuntime({
      env: envFor(root),
      userHome,
      probeHealthFn: down,
      probePortFn: async () => false,
      service: fakeService().service,
      waitForHealthFn: waitTimeout,
      startLockWaitMs: 40,
      startLockIntervalMs: 10,
      registryProviders: [providerRecord(path)],
      includeSelf: false,
      includeStandardApp: false,
      spawnFn: spawn.spawnFn,
    });
    expect(result.ok).toBe(false);
    expect(result.mode).toBe('conflict');
    expect(result.reason).toBe('start_locked');
    expect(spawn.calls).toHaveLength(0);
    // 活锁不属于本次 ensure，不能被删除。
    expect(existsSync(runtimeStartLockPath(root))).toBe(true);
  });

  it('陈旧启动锁自动回收；成功后释放本次锁', async () => {
    const { root, userHome } = await makeRoot();
    const path = await fakeProviderFile(root);
    await writeFile(runtimeStartLockPath(root), JSON.stringify({
      pid: 2147483647,
      home: root,
      startedAt: new Date().toISOString(),
    }), 'utf-8');
    const spawn = fakeSpawn();
    const result = await ensureRuntime({
      env: envFor(root),
      userHome,
      probeHealthFn: down,
      probePortFn: async () => false,
      service: fakeService().service,
      waitForHealthFn: healthy(root),
      registryProviders: [providerRecord(path)],
      includeSelf: false,
      includeStandardApp: false,
      spawnFn: spawn.spawnFn,
    });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('child');
    expect(existsSync(runtimeStartLockPath(root))).toBe(false);
  });

  it('启动锁：活 PID 返回 holder；陈旧 PID 可获取', async () => {
    const root = await tempDir();
    await writeFile(join(root, RUNTIME_START_LOCK_FILE), JSON.stringify({ pid: process.pid }), 'utf-8');
    const busy = await tryAcquireRuntimeStartLock({ root, home: root });
    expect(busy.acquired).toBe(false);
    expect(busy.holder?.pid).toBe(process.pid);

    await writeFile(join(root, RUNTIME_START_LOCK_FILE), JSON.stringify({ pid: 2147483647 }), 'utf-8');
    const free = await tryAcquireRuntimeStartLock({ root, home: root });
    expect(free.acquired).toBe(true);
    await free.release();
    expect(existsSync(runtimeStartLockPath(root))).toBe(false);
  });

  it('stopRuntimeChild 只停止仍存活的 child', () => {
    const spawn = fakeSpawn();
    expect(stopRuntimeChild(spawn.child)).toBe(true);
    expect(spawn.child.killed).toBe(true);
    expect(stopRuntimeChild(spawn.child)).toBe(false);
    expect(stopRuntimeChild(null)).toBe(false);
  });
});

describe('stopRuntimeChildGracefully / superviseRuntime：入口持有 child', () => {
  function captureStream() {
    const chunks = [];
    const waiters = [];
    return {
      chunks,
      write(chunk) {
        chunks.push(String(chunk));
        while (waiters.length > 0) waiters.shift()();
      },
      next() {
        if (chunks.length > 0) return Promise.resolve();
        return new Promise((resolvePromise) => waiters.push(resolvePromise));
      },
    };
  }

  function superviseOptions({ root, userHome, providerPath, spawnFn, stdout, stderr, signalSource, service, waitForHealthFn = healthy(root) }) {
    return {
      env: envFor(root),
      userHome,
      probeHealthFn: down,
      probePortFn: async () => false,
      service,
      waitForHealthFn,
      registryProviders: providerPath === null ? [] : [providerRecord(providerPath)],
      includeSelf: false,
      includeStandardApp: false,
      spawnFn,
      stdout,
      stderr,
      signalSource,
      childStopGraceMs: 50,
      childKillWaitMs: 50,
    };
  }

  it('SIGTERM 后优雅停止 child（不升级），等待退出后返回 0', async () => {
    const child = controllableChild({ exitOn: 'SIGTERM' });
    const result = await stopRuntimeChildGracefully(child, { graceMs: 50, killWaitMs: 50 });
    expect(result).toMatchObject({ stopped: true, escalated: false, signal: 'SIGTERM' });
    expect(child.signals).toEqual(['SIGTERM']);
  });

  it('SIGTERM 超时后升级 SIGKILL，并等待退出', async () => {
    const child = controllableChild({ exitOn: 'SIGKILL' });
    const result = await stopRuntimeChildGracefully(child, { graceMs: 5, killWaitMs: 50 });
    expect(result).toMatchObject({ stopped: true, escalated: true, signal: 'SIGKILL' });
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(child.signalCode).toBe('SIGKILL');
  });

  it('已退出的 child 不再发信号', async () => {
    const child = controllableChild();
    child.signalCode = 'SIGTERM';
    const result = await stopRuntimeChildGracefully(child);
    expect(result).toMatchObject({ stopped: false, escalated: false, reason: 'not_running' });
    expect(child.signals).toEqual([]);
  });

  it('supervise：ready 后 SIGTERM 只停止自己拉起的 child', async () => {
    const { root, userHome } = await makeRoot();
    const path = await fakeProviderFile(root);
    const child = controllableChild({ exitOn: 'SIGTERM' });
    const spawned = [];
    const spawnFn = (execPath, args, options) => {
      spawned.push({ execPath, args, options });
      return child;
    };
    const stdout = captureStream();
    const stderr = captureStream();
    const signalSource = new EventEmitter();
    const promise = superviseRuntime(superviseOptions({
      root,
      userHome,
      providerPath: path,
      spawnFn,
      stdout,
      stderr,
      signalSource,
      service: fakeService().service,
    }));

    await stdout.next();
    const ready = JSON.parse(stdout.chunks[0]);
    expect(ready).toMatchObject({ ok: true, mode: 'child', provider: { kind: 'cli', path, source: 'registry' } });
    expect(ready).not.toHaveProperty('child');
    expect(spawned).toHaveLength(1);
    expect(spawned[0].options.detached).toBe(false);
    expect(spawned[0].options.stdio).toEqual(['ignore', 2, 2]);

    signalSource.emit('SIGTERM', 'SIGTERM');
    const exitCode = await promise;
    expect(exitCode).toBe(0);
    expect(child.signals).toEqual(['SIGTERM']);
    expect(JSON.parse(stderr.chunks.at(-1))).toMatchObject({ ok: true, mode: 'child', reason: 'stopped' });
    // 句柄仍属于本次 supervise；没有第二次 spawn/第二个 daemon。
    expect(spawned).toHaveLength(1);
  });

  it('supervise：child 提前退出 → 传播退出码与 child_exited reason', async () => {
    const { root, userHome } = await makeRoot();
    const path = await fakeProviderFile(root);
    const child = controllableChild({ exitOn: 'SIGTERM' });
    const stdout = captureStream();
    const stderr = captureStream();
    const signalSource = new EventEmitter();
    const promise = superviseRuntime(superviseOptions({
      root,
      userHome,
      providerPath: path,
      spawnFn: () => child,
      stdout,
      stderr,
      signalSource,
      service: fakeService().service,
    }));

    await stdout.next();
    child.exitCode = 7;
    child.emit('exit', 7, null);
    const exitCode = await promise;
    expect(exitCode).toBe(7);
    expect(JSON.parse(stderr.chunks.at(-1))).toMatchObject({
      ok: false,
      mode: 'child',
      reason: 'child_exited',
      exitCode: 7,
    });
  });

  it('supervise：service 已注册时不 spawn，输出 service 结果后退出', async () => {
    const { root, userHome } = await makeRoot();
    const fake = fakeService({ registered: true });
    const stdout = captureStream();
    const stderr = captureStream();
    const spawn = fakeSpawn();
    const signalSource = new EventEmitter();
    const exitCode = await superviseRuntime(superviseOptions({
      root,
      userHome,
      providerPath: await fakeProviderFile(root),
      spawnFn: spawn.spawnFn,
      stdout,
      stderr,
      signalSource,
      service: fake.service,
    }));
    expect(exitCode).toBe(0);
    expect(fake.calls.restart).toBe(1);
    expect(spawn.calls).toHaveLength(0);
    expect(JSON.parse(stdout.chunks[0])).toMatchObject({ ok: true, mode: 'service' });
    expect(stdout.chunks).toHaveLength(1);
  });

  it('supervise：无 provider → download_required，输出一次 JSON 后 exit 2', async () => {
    const { root, userHome } = await makeRoot();
    const stdout = captureStream();
    const stderr = captureStream();
    const spawn = fakeSpawn();
    const signalSource = new EventEmitter();
    const exitCode = await superviseRuntime(superviseOptions({
      root,
      userHome,
      providerPath: null,
      spawnFn: spawn.spawnFn,
      stdout,
      stderr,
      signalSource,
      service: fakeService().service,
    }));
    expect(exitCode).toBe(2);
    expect(spawn.calls).toHaveLength(0);
    expect(JSON.parse(stdout.chunks[0])).toMatchObject({
      ok: false,
      mode: 'download_required',
      download: { allowed: false },
    });
    expect(stdout.chunks).toHaveLength(1);
  });
});

describe('resolveRuntime / runtimeStatus：只读，不启动', () => {
  it('resolve 给出 child 计划但不 spawn', async () => {
    const { root, userHome } = await makeRoot();
    const spawn = fakeSpawn();
    const result = await resolveRuntime({
      env: envFor(root),
      userHome,
      probeHealthFn: down,
      probePortFn: async () => false,
      service: fakeService().service,
      includeSelf: true,
      includeStandardApp: false,
      spawnFn: spawn.spawnFn,
    });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('child');
    expect(result.provider).toMatchObject({ kind: 'cli', source: 'self' });
    expect(spawn.calls).toHaveLength(0);
  });

  it('status：daemon down 仍 ok:true，带 provider/service/next 信息', async () => {
    const { root, userHome } = await makeRoot();
    const spawn = fakeSpawn();
    const result = await runtimeStatus({
      env: envFor(root),
      userHome,
      probeHealthFn: down,
      probePortFn: async () => false,
      service: fakeService({ registered: false }).service,
      includeSelf: true,
      includeStandardApp: false,
      spawnFn: spawn.spawnFn,
    });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('down');
    expect(result.reason).toBe('unreachable');
    expect(result.daemon).toMatchObject({ status: 'down' });
    expect(result.providers.selected).toMatchObject({ kind: 'cli', source: 'self' });
    expect(result.service).toMatchObject({ registered: false });
    expect(spawn.calls).toHaveLength(0);
  });

  it('显式 --port 覆盖 config 端口', async () => {
    const { root, userHome } = await makeRoot({ port: 17331 });
    const result = await resolveRuntime({
      env: envFor(root),
      userHome,
      port: 18444,
      probeHealthFn: down,
      probePortFn: async () => false,
      service: fakeService().service,
      registryProviders: [],
      includeSelf: false,
      includeStandardApp: false,
    });
    expect(result.http).toMatchObject({ port: 18444, url: 'http://127.0.0.1:18444/healthz' });
  });

  it('toPublicRuntimeResult 移除 child 句柄，其余字段保留', () => {
    const publicResult = toPublicRuntimeResult({ ok: true, mode: 'child', child: { pid: 1 }, provider: { kind: 'cli' } });
    expect(publicResult).toEqual({ ok: true, mode: 'child', provider: { kind: 'cli' } });
  });

  it('注册表损坏不阻塞 status（warning 暴露，provider 仍可发现）', async () => {
    const { root, userHome } = await makeRoot();
    await writeFile(runtimeProvidersPath(root), '{broken', 'utf-8');
    const result = await runtimeStatus({
      env: envFor(root),
      userHome,
      probeHealthFn: down,
      probePortFn: async () => false,
      service: fakeService().service,
      includeSelf: true,
      includeStandardApp: false,
    });
    expect(result.ok).toBe(true);
    expect(result.providers.warnings.length).toBeGreaterThan(0);
    expect(result.providers.selected).toMatchObject({ source: 'self' });
  });
});
