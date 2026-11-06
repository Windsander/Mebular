// W5d/C5：Console 经 MCP admin 薄代理访问 Memory Runtime sidecar。
//
// 覆盖：auth / CSRF / Origin；轻量模式明确 disabled；status/traces/detail/feedback；
// 高级模型来源只读写 `<home>/memory-runtime/config.json` 的 model.source；
// host token、endpoint、keyRef、模型路径不出现在任何浏览器响应里。

import { describe, it, expect, afterEach } from '@jest/globals';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHttpServer, hashToken } from '../../packages/mcp/src/serve.mjs';
import { pidAlive } from '../../packages/mcp/src/memory-runtime-supervisor.mjs';

const FAKE = fileURLToPath(new URL('./fixtures/memory-runtime-fake-sidecar.mjs', import.meta.url));
const dirs = [];
const servers = [];
const sidecars = [];
const savedCloudRoot = process.env.MEBULAR_CLOUD_ROOT;
const savedHostToken = process.env.FAKE_SIDECAR_HOST_TOKEN;
const savedAuthOut = process.env.FAKE_SIDECAR_AUTH_OUT;
const savedFeedbackOut = process.env.FAKE_SIDECAR_FEEDBACK_OUT;

afterEach(async () => {
  while (servers.length > 0) await servers.pop().close().catch(() => undefined);
  while (sidecars.length > 0) {
    const child = sidecars.pop();
    if (pidAlive(child.pid)) process.kill(child.pid, 'SIGTERM');
  }
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

async function start({
  enabled = false,
  auth = 'none',
  tokensFile = null,
  env = {},
  home: requestedHome = null,
  writesEnabled = true,
  command = FAKE,
} = {}) {
  const home = requestedHome ?? await tempDir();
  process.env.MEBULAR_CLOUD_ROOT = join(home, 'cloud');
  Object.assign(process.env, env);
  const server = await startHttpServer({
    home,
    app: fakeApp,
    service: fakeService,
    config: {
      memoryRuntime: { enabled, command, startTimeoutMs: 3000 },
      mcp: { http: { host: '127.0.0.1', port: 0, auth } },
    },
    buildServer: () => ({ connect: async () => undefined, close: async () => undefined }),
    host: '127.0.0.1',
    port: 0,
    auth,
    ...(tokensFile ? { tokensFile } : {}),
    writesEnabled,
    manageMemoryRuntime: true,
  });
  servers.push(server);
  return { home, server, base: `http://127.0.0.1:${server.port}` };
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

async function startAttachedFake(home, authOut, hostToken) {
  const child = spawn(process.execPath, [FAKE, 'serve'], {
    env: {
      ...process.env,
      MEBULAR_HOME: home,
      MEBULAR_MEMORY_RUNTIME_HOME: join(home, 'memory-runtime'),
      FAKE_SIDECAR_HOST_TOKEN: hostToken,
      FAKE_SIDECAR_AUTH_OUT: authOut,
      FAKE_SIDECAR_RECOVER_ON_CAPABILITY_FILE: '1',
    },
    stdio: 'ignore',
  });
  sidecars.push(child);
  await waitFor(() => existsSync(join(home, 'memory-runtime.json')));
  return { child, discovery: JSON.parse(await readFile(join(home, 'memory-runtime.json'), 'utf-8')) };
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

    // 高级模型来源：轻量模式只读默认 heuristic；写入 409，仍不创建目录。
    const modelSource = await fetch(`${base}/admin/api/memory-runtime/model-source`);
    expect(modelSource.status).toBe(200);
    const modelSourceBody = await modelSource.json();
    expect(modelSourceBody).toMatchObject({
      ok: true,
      source: 'heuristic',
      defaultSource: 'heuristic',
      enabled: false,
      applies: 'next_start',
    });
    expect(modelSourceBody.values).toEqual(['heuristic', 'local', 'host', 'api', 'auto']);
    expect(JSON.stringify(modelSourceBody)).not.toMatch(/tokenFile|host-token|keyRef|baseUrl|modelPath/);

    const csrfLight = await csrf(base);
    const writeLight = await fetch(`${base}/admin/api/memory-runtime/model-source`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-mebular-csrf': csrfLight.token,
        cookie: csrfLight.cookie,
      },
      body: JSON.stringify({ source: 'auto' }),
    });
    expect(writeLight.status).toBe(409);
    expect(await writeLight.json()).toMatchObject({
      ok: false,
      error: 'memory_runtime_disabled',
      enabled: false,
    });
    expect(existsSync(join(home, 'memory-runtime'))).toBe(false);
  });

  it('高级模型来源：读取/写入都走 sidecar；MCP 不直接写 config.json，不泄漏密钥/路径', async () => {
    const { home, base } = await start({ enabled: true });
    await readyStatus(base);
    const configPath = join(home, 'memory-runtime', 'config.json');

    const initial = await fetch(`${base}/admin/api/memory-runtime/model-source`);
    expect(initial.status).toBe(200);
    const initialBody = await initial.json();
    expect(initialBody).toMatchObject({ ok: true, source: 'heuristic', enabled: true, applies: 'hot' });
    expect(JSON.stringify(initialBody)).not.toMatch(/tokenFile|host-token|keyRef|baseUrl|modelPath/);

    // 预置无关字段与密钥引用：MCP 代理写来源时必须保持文件原样（真值在 sidecar）。
    const original = JSON.stringify({
      schema: 1,
      detail: { stagingHours: 12 },
      model: {
        source: 'heuristic',
        api: { keyRef: 'env:TEST_MODEL_KEY', baseUrl: 'https://example.invalid/v1', model: 'example' },
      },
    }, null, 2);
    await writeFile(configPath, original, { encoding: 'utf-8', mode: 0o600 });

    const { token, cookie } = await csrf(base);
    const write = await fetch(`${base}/admin/api/memory-runtime/model-source`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-mebular-csrf': token,
        cookie,
      },
      body: JSON.stringify({ source: 'host' }),
    });
    expect(write.status).toBe(200);
    const written = await write.json();
    expect(written).toMatchObject({ ok: true, source: 'host', enabled: true, applies: 'hot' });
    expect(JSON.stringify(written)).not.toMatch(/tokenFile|host-token|keyRef|baseUrl|modelPath|TEST_MODEL_KEY/);

    expect(await readFile(configPath, 'utf-8')).toBe(original);
    expect(existsSync(`${configPath}.bak`)).toBe(false);

    const reread = await (await fetch(`${base}/admin/api/memory-runtime/model-source`)).json();
    expect(reread.source).toBe('host');

    const bad = await fetch(`${base}/admin/api/memory-runtime/model-source`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-mebular-csrf': token,
        cookie,
      },
      body: JSON.stringify({ source: 'not-a-source' }),
    });
    expect(bad.status).toBe(400);
    expect(await readFile(configPath, 'utf-8')).toBe(original);
  }, 30000);

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
    const hostToken = JSON.parse(await readFile(join(home, 'memory-runtime', 'host-token'), 'utf-8')).token;
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
    expect(JSON.stringify(traces)).not.toContain('RAW_TRACE_SECRET');
    expect(JSON.stringify(traces)).not.toContain('UNLISTED_API_TOKEN');

    const detailResponse = await fetch(`${base}/admin/api/memory-runtime/traces/tr_fake_0001`);
    expect(detailResponse.status).toBe(200);
    const detail = await detailResponse.json();
    expect(detail).toMatchObject({ ok: true, enabled: true, available: true });
    expect(detail.trace.hits[0]).toMatchObject({ id: 'memory-fake-1', type: 'fact', score: 0.91 });
    expect(detail.trace.model).toEqual({
      query: 'fake-query-model',
      embedding: 'fake-embedding-model',
      extractor: 'fake-extractor-model',
      tookMs: 3,
    });
    expect(Object.keys(detail.trace.debug ?? {})).toEqual([]);
    expect(JSON.stringify(detail)).not.toContain(hostToken);
    expect(JSON.stringify(detail)).not.toMatch(/tokenFile|Bearer/);
    expect(JSON.stringify(detail)).not.toContain('RAW_TRACE_SECRET');
    expect(JSON.stringify(detail)).not.toContain('UNLISTED_API_TOKEN');

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

  it('真实 JSON token + attached Console：热禁用/恢复、MCP 与操作者重启均可信', async () => {
    const home = await tempDir();
    const authOut = join(home, 'attached-auth.jsonl');
    const tokenA = 'attached-json-host-token-a-0123456789';
    const tokenB = 'attached-json-host-token-b-9876543210';
    const firstExternal = await startAttachedFake(home, authOut, tokenA);
    const first = await start({ enabled: true, home, env: { FAKE_SIDECAR_AUTH_OUT: authOut } });
    const attached = await readyStatus(first.base);
    expect(attached).toMatchObject({ attached: true, managed: false, pid: firstExternal.child.pid, mode: 'immersive' });
    const tokenRecord = JSON.parse(await readFile(firstExternal.discovery.tokenFile, 'utf-8'));
    expect(tokenRecord).toMatchObject({ version: 1, token: tokenA });
    expect(JSON.stringify(attached)).not.toContain(tokenA);
    const initialAuth = (await readFile(authOut, 'utf-8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(initialAuth.some((entry) => entry.authorization === `Bearer ${tokenA}`)).toBe(true);
    expect(initialAuth.every((entry) => entry.authorization !== `Bearer ${JSON.stringify(tokenRecord)}`)).toBe(true);
    expect(initialAuth.every((entry) => typeof entry.requestId === 'string' && entry.requestId.length > 0)).toBe(true);

    const auth = await csrf(first.base);
    const patch = async (base, enabled) => {
      const response = await fetch(`${base}/admin/api/config`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-mebular-csrf': auth.token,
          cookie: auth.cookie,
          origin: base,
        },
        body: JSON.stringify({ patch: { 'memoryRuntime.enabled': enabled } }),
      });
      expect(response.status).toBe(200);
    };
    await patch(first.base, false);
    await waitFor(() => !existsSync(join(home, 'memory-runtime.json')));
    expect(pidAlive(firstExternal.child.pid)).toBe(true);
    const dormant = await fetch(`${firstExternal.discovery.url}/status`, {
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect((await dormant.json()).data.mode).toBe('mcp');
    const rejected = await fetch(`${firstExternal.discovery.url}/ingest`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenA}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(rejected.status).toBe(409);

    await patch(first.base, true);
    expect(await readyStatus(first.base)).toMatchObject({ attached: true, pid: firstExternal.child.pid });
    await first.server.close();
    servers.splice(servers.indexOf(first.server), 1);
    expect(pidAlive(firstExternal.child.pid)).toBe(true);
    await waitFor(() => !existsSync(join(home, 'memory-runtime.json')));

    const second = await start({ enabled: true, home, env: { FAKE_SIDECAR_AUTH_OUT: authOut } });
    expect(await readyStatus(second.base)).toMatchObject({ attached: true, pid: firstExternal.child.pid });

    const exited = new Promise((resolve) => firstExternal.child.once('exit', resolve));
    process.kill(firstExternal.child.pid, 'SIGTERM');
    await exited;
    const secondExternal = await startAttachedFake(home, authOut, tokenB);
    expect(secondExternal.child.pid).not.toBe(firstExternal.child.pid);
    expect(await readyStatus(second.base)).toMatchObject({ attached: true, pid: secondExternal.child.pid });
    const rotatedRecord = JSON.parse(await readFile(secondExternal.discovery.tokenFile, 'utf-8'));
    expect(rotatedRecord.token).toBe(tokenB);
    const rotatedAuth = (await readFile(authOut, 'utf-8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(rotatedAuth.at(-1).authorization).toBe(`Bearer ${tokenB}`);
  }, 45000);

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

  it('D6 writes-enabled 否决变更；D5 不新增 raw detail/checkpoint/self 代理', async () => {
    const authOut = join(await tempDir(), 'unused');
    const { base } = await start({ enabled: true, writesEnabled: false, env: { FAKE_SIDECAR_AUTH_OUT: authOut } });
    await readyStatus(base);
    const { token, cookie } = await csrf(base);
    const write = await fetch(`${base}/admin/api/memory-runtime/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mebular-csrf': token, cookie, origin: base },
      body: JSON.stringify({ traceId: 'tr_fake_0001', useful: true }),
    });
    expect(write.status).toBe(403);
    for (const path of ['details/detail-1', 'checkpoints/thread-1', 'self/agent-1']) {
      const response = await fetch(`${base}/admin/api/memory-runtime/${path}`);
      expect(response.status).toBe(404);
    }
    const forwarded = (await readFile(authOut, 'utf-8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(forwarded.every((entry) => !entry.path.includes('/feedback')
      && !entry.path.includes('/details/')
      && !entry.path.includes('/checkpoints/')
      && !entry.path.includes('/self/'))).toBe(true);
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
    const modelSource = await fetch(`${base}/admin/api/memory-runtime/model-source`, {
      headers: { authorization: `Bearer ${readToken}` },
    });
    expect(modelSource.status).toBe(200);

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

    const admin = await csrf(base, adminToken);
    const allowed = await fetch(`${base}/admin/api/memory-runtime/feedback`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${adminToken}`,
        'x-mebular-csrf': admin.token,
        cookie: admin.cookie,
        origin: base,
      },
      body: JSON.stringify({ traceId: 'tr_fake_0001', useful: true }),
    });
    expect(allowed.status).toBe(200);
  }, 30000);
});
