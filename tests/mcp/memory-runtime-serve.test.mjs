// W3b：serve.mjs 与 Memory Runtime supervisor 的集成。
//
// 覆盖：memoryRuntime.enabled=true 时异步启动 sidecar（不阻塞 READY）、discovery/overview
// 只读状态、关闭时停止自己启动的 sidecar；disabled 时零目录/token/进程副作用。

import { describe, it, expect, afterEach } from '@jest/globals';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHttpServer } from '../../packages/mcp/src/serve.mjs';
import { restoreBackup } from '../../packages/mcp/src/config-apply.mjs';
import { acquireConfigFileLock } from '../../packages/mcp/src/config-lock.mjs';
import { pidAlive } from '../../packages/mcp/src/memory-runtime-supervisor.mjs';

const FAKE = fileURLToPath(new URL('./fixtures/memory-runtime-fake-sidecar.mjs', import.meta.url));
const dirs = [];
const servers = [];
const savedCloudRoot = process.env.MEBULAR_CLOUD_ROOT;
const savedCapabilityToken = process.env.MEBULAR_CAPABILITY_TOKEN;
const savedFakeMode = process.env.FAKE_SIDECAR_MODE;
const savedFakeDelay = process.env.FAKE_SIDECAR_DELAY_MS;

afterEach(async () => {
  while (servers.length > 0) await servers.pop().close().catch(() => undefined);
  while (dirs.length > 0) await rm(dirs.pop(), { recursive: true, force: true });
  if (savedCloudRoot === undefined) delete process.env.MEBULAR_CLOUD_ROOT;
  else process.env.MEBULAR_CLOUD_ROOT = savedCloudRoot;
  if (savedCapabilityToken === undefined) delete process.env.MEBULAR_CAPABILITY_TOKEN;
  else process.env.MEBULAR_CAPABILITY_TOKEN = savedCapabilityToken;
  if (savedFakeMode === undefined) delete process.env.FAKE_SIDECAR_MODE;
  else process.env.FAKE_SIDECAR_MODE = savedFakeMode;
  if (savedFakeDelay === undefined) delete process.env.FAKE_SIDECAR_DELAY_MS;
  else process.env.FAKE_SIDECAR_DELAY_MS = savedFakeDelay;
});

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'memory-runtime-serve-'));
  dirs.push(dir);
  return dir;
}

const fakeApp = {
  deviceId: 'device-fake',
  isInitialized: () => true,
  storage: { listNodes: async () => [] },
  graph: { getNode: async () => null },
  getNamespaceDirectory: async () => [],
  getBlockedDevices: async () => [],
  getDeviceNames: async () => ({}),
  getConvergenceStatus: () => null,
};
const fakeService = {
  status: async () => ({
    running: false,
    pendingEventCount: 0,
    deviceId: 'device-fake',
    peerId: null,
    listenAddrs: [],
    relays: [],
  }),
};

async function start({ enabled, beforeConfigWrite = null, afterConfigRename = null }) {
  const home = await tempDir();
  process.env.MEBULAR_CLOUD_ROOT = join(home, 'cloud');
  delete process.env.MEBULAR_CAPABILITY_TOKEN;
  const server = await startHttpServer({
    home,
    app: fakeApp,
    service: fakeService,
    config: {
      memoryRuntime: { enabled, command: FAKE, startTimeoutMs: 3000 },
      mcp: { http: { host: '127.0.0.1', port: 0, auth: 'none' } },
    },
    buildServer: () => ({ connect: async () => undefined, close: async () => undefined }),
    host: '127.0.0.1',
    port: 0,
    auth: 'none',
    writesEnabled: true,
    manageMemoryRuntime: true,
    ...(beforeConfigWrite ? { beforeConfigWrite } : {}),
    ...(afterConfigRename ? { afterConfigRename } : {}),
  });
  servers.push(server);
  return { home, server, base: `http://127.0.0.1:${server.port}` };
}

async function overview(base) {
  const response = await fetch(`${base}/admin/api/overview`);
  expect(response.status).toBe(200);
  return response.json();
}

async function waitFor(check, { timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error('waitFor timeout');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 40));
  }
}

describe('serve + Memory Runtime supervisor', () => {
  it('close 开始后拒绝新的 config PATCH / 生命周期操作', async () => {
    process.env.FAKE_SIDECAR_MODE = 'slow';
    process.env.FAKE_SIDECAR_DELAY_MS = '2500';
    const { home, base, server } = await start({ enabled: false });
    const consoleResponse = await fetch(`${base}/console/`);
    const csrf = consoleResponse.headers.get('x-mebular-csrf');
    const cookie = consoleResponse.headers.get('set-cookie')?.split(';')[0];
    expect(csrf).toBeTruthy();

    // 先让一个 PATCH 进入生命周期队列并阻塞在慢启动上，close 会等待它。
    const firstPatch = fetch(`${base}/admin/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mebular-csrf': csrf, cookie },
      body: JSON.stringify({ patch: { 'memoryRuntime.enabled': true } }),
    });
    await waitFor(() => existsSync(join(home, 'memory-runtime', 'start.lock')), { timeoutMs: 5000 });
    const closing = server.close();
    expect(server.getState().closing).toBe(true);

    const response = await fetch(`${base}/admin/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mebular-csrf': csrf, cookie },
      body: JSON.stringify({ patch: { 'memoryRuntime.enabled': true } }),
    });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toMatchObject({ ok: false, error: 'closing' });
    expect((await firstPatch).status).toBe(200);
    await closing;
    servers.splice(servers.indexOf(server), 1);
  }, 20000);

  it('已通过入口的 config PATCH 在写盘前遇到 close 时返回 409 且不落盘', async () => {
    let release = () => {};
    let entered = false;
    const gate = new Promise((resolve) => { release = resolve; });
    const { home, base, server } = await start({
      enabled: false,
      beforeConfigWrite: async () => {
        if (entered) return;
        entered = true;
        await gate;
      },
    });
    const consoleResponse = await fetch(`${base}/console/`);
    const csrf = consoleResponse.headers.get('x-mebular-csrf');
    const cookie = consoleResponse.headers.get('set-cookie')?.split(';')[0];
    const patch = fetch(`${base}/admin/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mebular-csrf': csrf, cookie },
      body: JSON.stringify({ patch: { 'memoryRuntime.enabled': true } }),
    });
    await waitFor(() => entered, { timeoutMs: 5000 });
    const closing = server.close();
    expect(server.getState().closing).toBe(true);
    release();
    const response = await patch;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, error: 'closing' });
    const raw = await readFile(join(home, 'config.json'), 'utf-8').catch(() => null);
    if (raw !== null) {
      const config = JSON.parse(raw);
      expect(config.memoryRuntime?.enabled).not.toBe(true);
    }
    await closing;
    servers.splice(servers.indexOf(server), 1);
  }, 15000);

  it('rename 后 close 回滚不覆盖并发配置修改', async () => {
    let release = () => {};
    let entered = false;
    const gate = new Promise((resolve) => { release = resolve; });
    const { home, base, server } = await start({
      enabled: false,
      afterConfigRename: async () => {
        if (entered) return;
        entered = true;
        await gate;
      },
    });
    const consoleResponse = await fetch(`${base}/console/`);
    const csrf = consoleResponse.headers.get('x-mebular-csrf');
    const cookie = consoleResponse.headers.get('set-cookie')?.split(';')[0];
    const patch = fetch(`${base}/admin/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mebular-csrf': csrf, cookie },
      body: JSON.stringify({ patch: { 'memoryRuntime.enabled': true } }),
    });
    await waitFor(() => entered, { timeoutMs: 5000 });
    const concurrent = { memoryRuntime: { enabled: false }, concurrent: { writer: 'other' } };
    await writeFile(join(home, 'config.json'), JSON.stringify(concurrent, null, 2), 'utf-8');
    const closing = server.close();
    release();
    const response = await patch;
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe('config_conflict');
    expect(JSON.parse(await readFile(join(home, 'config.json'), 'utf-8'))).toEqual(concurrent);
    await closing;
    servers.splice(servers.indexOf(server), 1);
  }, 15000);

  it('跨进程配置锁：外部持锁时 PATCH 返回 config_busy，不写配置', async () => {
    const previousTimeout = process.env.MEBULAR_CONFIG_LOCK_TIMEOUT_MS;
    process.env.MEBULAR_CONFIG_LOCK_TIMEOUT_MS = '100';
    try {
      const { home, base } = await start({ enabled: false });
      const lockPath = join(home, 'config.json.write-lock');
      await writeFile(lockPath, JSON.stringify({ pid: process.pid, at: Date.now() - 3_600_000, owner: 'other-owner' }), 'utf-8');
      const consoleResponse = await fetch(`${base}/console/`);
      const csrf = consoleResponse.headers.get('x-mebular-csrf');
      const cookie = consoleResponse.headers.get('set-cookie')?.split(';')[0];
      const response = await fetch(`${base}/admin/api/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-mebular-csrf': csrf, cookie },
        body: JSON.stringify({ patch: { 'memoryRuntime.enabled': true } }),
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ ok: false, error: 'config_busy' });
      const raw = await readFile(join(home, 'config.json'), 'utf-8').catch(() => null);
      expect(raw).toBeNull();
      await rm(lockPath, { force: true });
    } finally {
      if (previousTimeout === undefined) delete process.env.MEBULAR_CONFIG_LOCK_TIMEOUT_MS;
      else process.env.MEBULAR_CONFIG_LOCK_TIMEOUT_MS = previousTimeout;
    }
  }, 15000);

  it('config 锁：空/半截锁在新鲜期内不接管，过期后接管', async () => {
    const previousTimeout = process.env.MEBULAR_CONFIG_LOCK_TIMEOUT_MS;
    process.env.MEBULAR_CONFIG_LOCK_TIMEOUT_MS = '100';
    try {
      const { home, base } = await start({ enabled: false });
      const lockPath = join(home, 'config.json.write-lock');
      const consoleResponse = await fetch(`${base}/console/`);
      const csrf = consoleResponse.headers.get('x-mebular-csrf');
      const cookie = consoleResponse.headers.get('set-cookie')?.split(';')[0];
      const patch = () => fetch(`${base}/admin/api/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-mebular-csrf': csrf, cookie },
        body: JSON.stringify({ patch: { 'memoryRuntime.enabled': true } }),
      });
      await writeFile(lockPath, '{"pid":', 'utf-8');
      const fresh = await patch();
      expect(fresh.status).toBe(409);
      expect(await fresh.json()).toMatchObject({ ok: false, error: 'config_busy' });
      const old = new Date(Date.now() - 60_000);
      await utimes(lockPath, old, old);
      const taken = await patch();
      expect(taken.status).toBe(200);
      await waitFor(() => !existsSync(lockPath));
    } finally {
      if (previousTimeout === undefined) delete process.env.MEBULAR_CONFIG_LOCK_TIMEOUT_MS;
      else process.env.MEBULAR_CONFIG_LOCK_TIMEOUT_MS = previousTimeout;
    }
  }, 15000);

  it('config 锁：死 PID/过期锁可接管并重建，后续写入成功', async () => {
    const { home, base } = await start({ enabled: false });
    const lockPath = join(home, 'config.json.write-lock');
    await writeFile(lockPath, JSON.stringify({
      pid: 999999,
      at: Date.now() - 60_000,
      owner: 'stale-owner',
    }), 'utf-8');
    const consoleResponse = await fetch(`${base}/console/`);
    const csrf = consoleResponse.headers.get('x-mebular-csrf');
    const cookie = consoleResponse.headers.get('set-cookie')?.split(';')[0];
    const patch = () => fetch(`${base}/admin/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mebular-csrf': csrf, cookie },
      body: JSON.stringify({ patch: { 'memoryRuntime.enabled': true } }),
    });
    const first = await patch();
    expect(first.status).toBe(200);
    await waitFor(() => !existsSync(lockPath));
    const second = await patch();
    expect(second.status).toBe(200);
    await waitFor(() => !existsSync(lockPath));
    expect(JSON.parse(await readFile(join(home, 'config.json'), 'utf-8')).memoryRuntime.enabled).toBe(true);
  }, 15000);

  it('config 锁获取异常会释放进程内队列，修复后可重建锁并写入', async () => {
    if (process.platform === 'win32') return;
    const { home, base } = await start({ enabled: false });
    const consoleResponse = await fetch(`${base}/console/`);
    const csrf = consoleResponse.headers.get('x-mebular-csrf');
    const cookie = consoleResponse.headers.get('set-cookie')?.split(';')[0];
    const patch = () => fetch(`${base}/admin/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mebular-csrf': csrf, cookie },
      body: JSON.stringify({ patch: { 'memoryRuntime.enabled': true } }),
    });
    await chmod(home, 0o500);
    try {
      const failed = await patch();
      expect(failed.status).toBe(500);
    } finally {
      await chmod(home, 0o700);
    }
    const recovered = await patch();
    expect(recovered.status).toBe(200);
    await waitFor(() => !existsSync(join(home, 'config.json.write-lock')));
  }, 15000);

  it('restoreBackup 与 PATCH 并发时持锁等待/失败，不会覆盖', async () => {
    let release = () => {};
    let entered = false;
    const gate = new Promise((resolve) => { release = resolve; });
    const previousTimeout = process.env.MEBULAR_CONFIG_LOCK_TIMEOUT_MS;
    process.env.MEBULAR_CONFIG_LOCK_TIMEOUT_MS = '100';
    try {
      const { home, base } = await start({
        enabled: false,
        beforeConfigWrite: async () => {
          if (entered) return;
          entered = true;
          await gate;
        },
      });
      const configFile = join(home, 'config.json');
      const backupFile = join(home, 'restore-source.json');
      await writeFile(configFile, JSON.stringify({ memoryRuntime: { enabled: false } }, null, 2), 'utf-8');
      await writeFile(backupFile, JSON.stringify({ restored: true }, null, 2), 'utf-8');
      const consoleResponse = await fetch(`${base}/console/`);
      const csrf = consoleResponse.headers.get('x-mebular-csrf');
      const cookie = consoleResponse.headers.get('set-cookie')?.split(';')[0];
      const patch = fetch(`${base}/admin/api/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-mebular-csrf': csrf, cookie },
        body: JSON.stringify({ patch: { 'memoryRuntime.enabled': true } }),
      });
      await waitFor(() => entered, { timeoutMs: 5000 });
      await expect(restoreBackup({ configFile, backupFile })).rejects.toMatchObject({ code: 'CONFIG_BUSY' });
      release();
      expect((await patch).status).toBe(200);
      await waitFor(() => existsSync(`${configFile}.write-lock`) === false);
      expect(await restoreBackup({ configFile, backupFile })).toBe(true);
      expect(JSON.parse(await readFile(configFile, 'utf-8'))).toEqual({ restored: true });
    } finally {
      if (previousTimeout === undefined) delete process.env.MEBULAR_CONFIG_LOCK_TIMEOUT_MS;
      else process.env.MEBULAR_CONFIG_LOCK_TIMEOUT_MS = previousTimeout;
    }
  }, 15000);

  it('config 锁：活 PID 无 heartbeat 超时后可接管', async () => {
    const home = await mkdtemp(join(tmpdir(), 'config-lock-live-stale-'));
    const configFile = join(home, 'config.json');
    const lockPath = `${configFile}.write-lock`;
    await writeFile(lockPath, JSON.stringify({
      pid: process.pid,
      at: Date.now() - 60_000,
      owner: 'old-live-owner',
    }), 'utf-8');
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);
    const release = await acquireConfigFileLock(configFile, { timeoutMs: 500, staleMs: 50 });
    expect(release).not.toBeNull();
    await release();
    expect(existsSync(lockPath)).toBe(false);
    await rm(home, { recursive: true, force: true });
  }, 10000);

  it('config 锁：读锁 EACCES 时按 busy 处理且不删除锁', async () => {
    if (process.platform === 'win32') return;
    const home = await mkdtemp(join(tmpdir(), 'config-lock-eacces-'));
    const configFile = join(home, 'config.json');
    const lockPath = `${configFile}.write-lock`;
    await writeFile(lockPath, JSON.stringify({
      pid: 999999,
      at: Date.now(),
      owner: 'unreadable-owner',
    }), 'utf-8');
    await chmod(lockPath, 0o000);
    try {
      const release = await acquireConfigFileLock(configFile, { timeoutMs: 100, staleMs: 10 });
      expect(release).toBeNull();
      expect(existsSync(lockPath)).toBe(true);
    } finally {
      await chmod(lockPath, 0o600);
      await rm(home, { recursive: true, force: true });
    }
  }, 10000);

  it('config 锁：硬链接不受支持时回退 open(wx)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'config-lock-link-fallback-'));
    const configFile = join(home, 'config.json');
    const release = await acquireConfigFileLock(configFile, {
      timeoutMs: 500,
      linkImpl: async () => {
        const error = new Error('hard links unsupported');
        error.code = 'EPERM';
        throw error;
      },
    });
    expect(release).not.toBeNull();
    expect(existsSync(`${configFile}.write-lock`)).toBe(true);
    await release();
    expect(existsSync(`${configFile}.write-lock`)).toBe(false);
    await rm(home, { recursive: true, force: true });
  }, 10000);

  it('enabled：异步启动 sidecar，overview 只读展示且不泄漏 token；关闭时停止', async () => {
    const { home, server, base } = await start({ enabled: true });
    const ready = await waitFor(async () => {
      const body = await overview(base);
      return body.memoryRuntime?.state === 'ready' ? body.memoryRuntime : null;
    }, { timeoutMs: 15000 });
    expect(ready).toMatchObject({
      enabled: true,
      managed: true,
      attached: false,
      runtimeVersion: '0.3.0',
    });
    expect(typeof ready.pid).toBe('number');
    expect(existsSync(join(home, 'memory-runtime.json'))).toBe(true);

    const token = JSON.parse(await readFile(join(home, 'memory-runtime', 'capability-token'), 'utf-8')).token;
    const body = await overview(base);
    expect(JSON.stringify(body.memoryRuntime)).not.toContain(token);
    expect(JSON.stringify(body.memoryRuntime)).not.toMatch(/tokenFile|host-token/);

    await server.close();
    servers.splice(servers.indexOf(server), 1);
    await waitFor(() => !pidAlive(ready.pid), { timeoutMs: 10000 });
    await waitFor(() => !existsSync(join(home, 'memory-runtime.json')), { timeoutMs: 10000 });
  }, 30000);

  it('disabled：轻量模式零 sidecar 目录/token/discovery/进程', async () => {
    const { home, base } = await start({ enabled: false });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
    expect(existsSync(join(home, 'memory-runtime'))).toBe(false);
    expect(existsSync(join(home, 'memory-runtime.json'))).toBe(false);
    const body = await overview(base);
    expect(body.memoryRuntime).toMatchObject({
      enabled: false,
      state: 'stopped',
      managed: false,
      attached: false,
      pid: null,
    });
  });

  it('热切换 enabled：立即启动/停止 sidecar，不重启 MCP', async () => {
    const { home, base } = await start({ enabled: false });
    const consoleResponse = await fetch(`${base}/console/`);
    const csrf = consoleResponse.headers.get('x-mebular-csrf');
    const cookie = consoleResponse.headers.get('set-cookie')?.split(';')[0];
    expect(csrf).toBeTruthy();
    expect(cookie).toBeTruthy();

    async function patch(payload) {
      const response = await fetch(`${base}/admin/api/config`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-mebular-csrf': csrf,
          cookie,
        },
        body: JSON.stringify(payload),
      });
      expect(response.status).toBe(200);
      return response.json();
    }

    const enabled = await patch({ patch: { 'memoryRuntime.enabled': true } });
    expect(enabled).toMatchObject({ ok: true, restartRequired: false });
    const ready = await waitFor(async () => {
      const body = await overview(base);
      return body.memoryRuntime?.state === 'ready' ? body.memoryRuntime : null;
    }, { timeoutMs: 15000 });
    expect(existsSync(join(home, 'memory-runtime.json'))).toBe(true);

    const disabled = await patch({ patch: { 'memoryRuntime.enabled': false } });
    expect(disabled).toMatchObject({ ok: true, restartRequired: false });
    await waitFor(() => !pidAlive(ready.pid), { timeoutMs: 10000 });
    await waitFor(() => !existsSync(join(home, 'memory-runtime.json')), { timeoutMs: 10000 });
    const body = await overview(base);
    expect(body.memoryRuntime).toMatchObject({ enabled: false, state: 'stopped', pid: null });
  }, 30000);
});
