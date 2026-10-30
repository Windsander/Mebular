// W5d：Console 经 MCP admin 只读代理访问 Memory Runtime sidecar。
//
// 覆盖：auth / CSRF / Origin；轻量模式明确 disabled；status/traces/detail/feedback；
// host token 只在服务端使用，不出现在任何浏览器响应里。

import { describe, it, expect, afterEach } from '@jest/globals';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHttpServer, hashToken } from '../../packages/mcp/src/serve.mjs';

const FAKE = fileURLToPath(new URL('./fixtures/memory-runtime-fake-sidecar.mjs', import.meta.url));
const dirs = [];
const servers = [];
const savedCloudRoot = process.env.MEBULAR_CLOUD_ROOT;
const savedHostToken = process.env.FAKE_SIDECAR_HOST_TOKEN;
const savedAuthOut = process.env.FAKE_SIDECAR_AUTH_OUT;
const savedFeedbackOut = process.env.FAKE_SIDECAR_FEEDBACK_OUT;

afterEach(async () => {
  while (servers.length > 0) await servers.pop().close().catch(() => undefined);
  while (dirs.length > 0) await rm(dirs.pop(), { recursive: true, force: true });
  if (savedCloudRoot === undefined) delete process.env.MEBULAR_CLOUD_ROOT;
  else process.env.MEBULAR_CLOUD_ROOT = savedCloudRoot;
  if (savedHostToken === undefined) delete process.env.FAKE_SIDECAR_HOST_TOKEN;
  else process.env.FAKE_SIDECAR_HOST_TOKEN = savedHostToken;
  if (savedAuthOut === undefined) delete process.env.FAKE_SIDECAR_AUTH_OUT;
  else process.env.FAKE_SIDECAR_AUTH_OUT = savedAuthOut;
  if (savedFeedbackOut === undefined) delete process.env.FAKE_SIDECAR_FEEDBACK_OUT;
  else process.env.FAKE_SIDECAR_FEEDBACK_OUT = savedFeedbackOut;
});

async function tempDir(prefix = 'memory-runtime-admin-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const fakeApp = {
  deviceId: 'device-proxy',
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
    deviceId: 'device-proxy',
    peerId: null,
    listenAddrs: [],
    relays: [],
  }),
};

async function start({ enabled = false, auth = 'none', tokensFile = null, env = {} } = {}) {
  const home = await tempDir();
  process.env.MEBULAR_CLOUD_ROOT = join(home, 'cloud');
  Object.assign(process.env, env);
  const server = await startHttpServer({
    home,
    app: fakeApp,
    service: fakeService,
    config: {
      memoryRuntime: { enabled, command: FAKE, startTimeoutMs: 3000 },
      mcp: { http: { host: '127.0.0.1', port: 0, auth } },
    },
    buildServer: () => ({ connect: async () => undefined, close: async () => undefined }),
    host: '127.0.0.1',
    port: 0,
    auth,
    ...(tokensFile ? { tokensFile } : {}),
    writesEnabled: true,
    manageMemoryRuntime: true,
  });
  servers.push(server);
  return { home, base: `http://127.0.0.1:${server.port}` };
}

async function waitFor(check, { timeoutMs = 15000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error('waitFor timeout');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
}

async function csrf(base, bearer = null) {
  const response = await fetch(`${base}/console/`, {
    ...(bearer ? { headers: { authorization: `Bearer ${bearer}` } } : {}),
  });
  const token = response.headers.get('x-mebular-csrf');
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  expect(token).toBeTruthy();
  expect(cookie).toBeTruthy();
  return { token, cookie };
}

async function readyStatus(base, headers = null) {
  return waitFor(async () => {
    const response = await fetch(`${base}/admin/api/memory-runtime/status`, headers ? { headers } : undefined);
    if (response.status !== 200) return null;
    const body = await response.json();
    return body.state === 'ready' ? body : null;
  });
}

describe('MCP admin · Memory Runtime sidecar 只读代理', () => {
  it('轻量模式：status/traces 明确 disabled，feedback 409；不创建 sidecar 目录/token', async () => {
    const { home, base } = await start({ enabled: false });
    const status = await fetch(`${base}/admin/api/memory-runtime/status`);
    expect(status.status).toBe(200);
    const statusBody = await status.json();
    expect(statusBody).toMatchObject({
      enabled: false,
      state: 'stopped',
      available: false,
      managed: false,
      attached: false,
      pid: null,
    });
    expect(JSON.stringify(statusBody)).not.toMatch(/tokenFile|host-token/);

    const traces = await fetch(`${base}/admin/api/memory-runtime/traces?limit=20`);
    expect(traces.status).toBe(200);
    expect(await traces.json()).toMatchObject({
      ok: true,
      enabled: false,
      available: false,
      disabled: true,
      state: 'stopped',
      traces: [],
      total: 0,
    });

    const detail = await fetch(`${base}/admin/api/memory-runtime/traces/tr_fake_0001`);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      ok: true,
      enabled: false,
      available: false,
      disabled: true,
      trace: null,
    });

    const { token, cookie } = await csrf(base);
    const feedback = await fetch(`${base}/admin/api/memory-runtime/feedback`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-mebular-csrf': token,
        cookie,
      },
      body: JSON.stringify({ traceId: 'tr_fake_0001', useful: true }),
    });
    expect(feedback.status).toBe(409);
    expect(await feedback.json()).toMatchObject({ ok: false, error: 'memory_runtime_disabled', state: 'stopped' });

    // 轻量模式零副作用：不创建 sidecar 数据目录/discovery/token。
    expect(existsSync(join(home, 'memory-runtime'))).toBe(false);
    expect(existsSync(join(home, 'memory-runtime.json'))).toBe(false);
  });

  it('enabled：服务端用 host token 转发 traces/detail/feedback，响应不泄漏 token', async () => {
    const outDir = await tempDir('memory-runtime-admin-out-');
    const authOut = join(outDir, 'auth.jsonl');
    const feedbackOut = join(outDir, 'feedback.jsonl');
    const { home, base } = await start({
      enabled: true,
      env: {
        FAKE_SIDECAR_AUTH_OUT: authOut,
        FAKE_SIDECAR_FEEDBACK_OUT: feedbackOut,
      },
    });
    const status = await readyStatus(base);
    const hostToken = (await readFile(join(home, 'memory-runtime', 'host-token'), 'utf-8')).trim();
    expect(hostToken.length).toBeGreaterThan(16);
    expect(status).toMatchObject({ enabled: true, state: 'ready', available: true, runtimeVersion: '0.3.0' });
    expect(typeof status.pid).toBe('number');
    expect(JSON.stringify(status)).not.toMatch(/tokenFile|host-token/);
    expect(JSON.stringify(status)).not.toContain(hostToken);

    const tracesResponse = await fetch(`${base}/admin/api/memory-runtime/traces?limit=5`);
    expect(tracesResponse.status).toBe(200);
    const traces = await tracesResponse.json();
    expect(traces).toMatchObject({ ok: true, enabled: true, available: true, total: 1 });
    expect(traces.traces[0].id).toBe('tr_fake_0001');
    expect(JSON.stringify(traces)).not.toContain(hostToken);

    const detailResponse = await fetch(`${base}/admin/api/memory-runtime/traces/tr_fake_0001`);
    expect(detailResponse.status).toBe(200);
    const detail = await detailResponse.json();
    expect(detail).toMatchObject({ ok: true, enabled: true, available: true });
    expect(detail.trace.hits[0]).toMatchObject({ id: 'memory-fake-1', type: 'fact', score: 0.91 });
    expect(Object.keys(detail.trace.debug ?? {})).toEqual([]);
    expect(JSON.stringify(detail)).not.toContain(hostToken);
    expect(JSON.stringify(detail)).not.toMatch(/tokenFile|Bearer/);

    const { token, cookie } = await csrf(base);
    const feedbackResponse = await fetch(`${base}/admin/api/memory-runtime/feedback`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-mebular-csrf': token,
        cookie,
      },
      body: JSON.stringify({ traceId: 'tr_fake_0001', useful: true, reason: 'helpful' }),
    });
    expect(feedbackResponse.status).toBe(200);
    const feedback = await feedbackResponse.json();
    expect(feedback).toMatchObject({ ok: true, data: { traceId: 'tr_fake_0001', feedback: { useful: true } } });
    expect(JSON.stringify(feedback)).not.toContain(hostToken);

    // 浏览器从未发送 host token；代理在服务端带 Bearer。
    const authLines = (await readFile(authOut, 'utf-8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    expect(authLines.length).toBeGreaterThanOrEqual(3);
    for (const line of authLines) expect(line.authorization).toBe(`Bearer ${hostToken}`);
    const feedbackLines = (await readFile(feedbackOut, 'utf-8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    expect(feedbackLines.at(-1)).toMatchObject({
      traceId: 'tr_fake_0001',
      body: { useful: true, reason: 'helpful' },
    });
  }, 30000);

  it('feedback 写端点沿用 Origin + CSRF + memory.admin', async () => {
    const { base } = await start({ enabled: true });
    await readyStatus(base);
    const { token, cookie } = await csrf(base);
    const payload = JSON.stringify({ traceId: 'tr_fake_0001', useful: true });

    const noCsrf = await fetch(`${base}/admin/api/memory-runtime/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: payload,
    });
    expect(noCsrf.status).toBe(403);

    const badOrigin = await fetch(`${base}/admin/api/memory-runtime/feedback`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-mebular-csrf': token,
        cookie,
        origin: 'http://evil.example',
      },
      body: payload,
    });
    expect(badOrigin.status).toBe(403);

    const badFeedback = await fetch(`${base}/admin/api/memory-runtime/feedback`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-mebular-csrf': token,
        cookie,
      },
      body: JSON.stringify({ traceId: 'tr_fake_0001', useful: 'yes' }),
    });
    expect(badFeedback.status).toBe(400);
  }, 30000);

  it('bearer：无 token 401；memory.read 可读 status/traces，写 feedback 仍需 memory.admin', async () => {
    const authDir = await tempDir('memory-runtime-admin-auth-');
    await mkdir(authDir, { recursive: true });
    const tokensFile = join(authDir, 'tokens.json');
    const readToken = 'proxy-read-token';
    const adminToken = 'proxy-admin-token';
    await writeFile(tokensFile, JSON.stringify({
      tokens: [
        { id: 'read', sha256: hashToken(readToken), scope: ['memory.read'], revoked: false },
        { id: 'admin', sha256: hashToken(adminToken), scope: ['memory.read', 'memory.admin'], revoked: false },
      ],
    }), 'utf-8');
    const { base } = await start({ enabled: true, auth: 'bearer', tokensFile });
    await readyStatus(base, { authorization: `Bearer ${readToken}` });

    const anonymous = await fetch(`${base}/admin/api/memory-runtime/status`);
    expect(anonymous.status).toBe(401);
    const read = await fetch(`${base}/admin/api/memory-runtime/traces`, {
      headers: { authorization: `Bearer ${readToken}` },
    });
    expect(read.status).toBe(200);

    const write = await fetch(`${base}/admin/api/memory-runtime/feedback`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${readToken}`,
        'x-mebular-csrf': 'x',
      },
      body: JSON.stringify({ traceId: 'tr_fake_0001', useful: true }),
    });
    expect(write.status).toBe(403);
    expect((await write.json()).message).toContain('memory.admin');
  }, 30000);
});
