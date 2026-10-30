// W3b：serve.mjs 与 Memory Runtime supervisor 的集成。
//
// 覆盖：memoryRuntime.enabled=true 时异步启动 sidecar（不阻塞 READY）、discovery/overview
// 只读状态、关闭时停止自己启动的 sidecar；disabled 时零目录/token/进程副作用。

import { describe, it, expect, afterEach } from '@jest/globals';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHttpServer } from '../../packages/mcp/src/serve.mjs';
import { pidAlive } from '../../packages/mcp/src/memory-runtime-supervisor.mjs';

const FAKE = fileURLToPath(new URL('./fixtures/memory-runtime-fake-sidecar.mjs', import.meta.url));
const dirs = [];
const servers = [];
const savedCloudRoot = process.env.MEBULAR_CLOUD_ROOT;
const savedCapabilityToken = process.env.MEBULAR_CAPABILITY_TOKEN;

afterEach(async () => {
  while (servers.length > 0) await servers.pop().close().catch(() => undefined);
  while (dirs.length > 0) await rm(dirs.pop(), { recursive: true, force: true });
  if (savedCloudRoot === undefined) delete process.env.MEBULAR_CLOUD_ROOT;
  else process.env.MEBULAR_CLOUD_ROOT = savedCloudRoot;
  if (savedCapabilityToken === undefined) delete process.env.MEBULAR_CAPABILITY_TOKEN;
  else process.env.MEBULAR_CAPABILITY_TOKEN = savedCapabilityToken;
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

async function start({ enabled }) {
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
  it('enabled：异步启动 sidecar，overview 只读展示且不泄漏 token；关闭时停止', async () => {
    const { home, server, base } = await start({ enabled: true });
    const ready = await waitFor(async () => {
      const body = await overview(base);
      return body.memoryRuntime?.state === 'ready' ? body.memoryRuntime : null;
    });
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
    await waitFor(() => !pidAlive(ready.pid), { timeoutMs: 5000 });
    await waitFor(() => !existsSync(join(home, 'memory-runtime.json')), { timeoutMs: 5000 });
  });

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
    });
    expect(existsSync(join(home, 'memory-runtime.json'))).toBe(true);

    const disabled = await patch({ patch: { 'memoryRuntime.enabled': false } });
    expect(disabled).toMatchObject({ ok: true, restartRequired: false });
    await waitFor(() => !pidAlive(ready.pid), { timeoutMs: 5000 });
    await waitFor(() => !existsSync(join(home, 'memory-runtime.json')), { timeoutMs: 5000 });
    const body = await overview(base);
    expect(body.memoryRuntime).toMatchObject({ enabled: false, state: 'stopped', pid: null });
  });
});
