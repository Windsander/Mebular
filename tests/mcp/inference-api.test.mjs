// /admin/api/models 与 model-source：MCP 只做 Memory Runtime sidecar 的薄代理。
//
// 覆盖：轻量/不可用结构化错误、目录/状态映射、安装 202/job、select/cancel/remove/start/stop/test、
// unsupported、auth + CSRF + Origin + scope、无 token/path 泄漏、MCP 不写 sidecar config。

import { describe, it, expect, afterEach } from '@jest/globals';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHttpServer, hashToken } from '../../packages/mcp/src/serve.mjs';

const FAKE = fileURLToPath(new URL('./fixtures/memory-runtime-fake-sidecar.mjs', import.meta.url));
const PACK_4B = 'qwen3-4b-instruct-q4_k_m';
const PACK_8B = 'qwen3-8b-instruct-q4_k_m';
const dirs = [];
const servers = [];

afterEach(async () => {
  while (servers.length > 0) await servers.pop().close().catch(() => undefined);
  while (dirs.length > 0) await rm(dirs.pop(), { recursive: true, force: true });
  delete process.env.FAKE_SIDECAR_ADMIN_OUT;
  delete process.env.FAKE_SIDECAR_AUTH_OUT;
  delete process.env.MEBULAR_CLOUD_ROOT;
});

async function tempDir(prefix = 'mebular-inference-api-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const fakeApp = {
  deviceId: 'device-inference-proxy',
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
    deviceId: 'device-inference-proxy',
    peerId: null,
    listenAddrs: [],
    relays: [],
  }),
};

async function start({
  enabled = true,
  command = FAKE,
  auth = 'none',
  tokensFile = null,
  env = {},
} = {}) {
  const home = await tempDir();
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

async function ready(base) {
  return waitFor(async () => {
    const response = await fetch(`${base}/admin/api/memory-runtime/status`);
    if (response.status !== 200) return null;
    const body = await response.json();
    return body.state === 'ready' ? body : null;
  });
}

async function csrf(base, bearer = null) {
  const response = await fetch(`${base}/console/`, {
    ...(bearer ? { headers: { authorization: `Bearer ${bearer}` } } : {}),
  });
  const token = response.headers.get('x-mebular-csrf');
  const cookie = response.headers.getSetCookie()
    .find((value) => value.startsWith('mebular_csrf='))
    ?.split(';')[0];
  expect(token).toBeTruthy();
  expect(cookie).toBeTruthy();
  return { token, cookie };
}

async function post(base, path, body, auth = null) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(auth?.token ? { 'x-mebular-csrf': auth.token } : {}),
      ...(auth?.cookie ? { cookie: auth.cookie } : {}),
      ...(auth?.bearer ? { authorization: `Bearer ${auth.bearer}` } : {}),
      ...(auth?.origin ? { origin: auth.origin } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe('MCP 模型薄代理 · 禁用/不可用', () => {
  it('轻量模式：模型与状态明确 memory_runtime_disabled，零 sidecar 目录副作用', async () => {
    const { home, base } = await start({ enabled: false });
    for (const path of ['/admin/api/models', '/admin/api/models/status']) {
      const response = await fetch(`${base}${path}`);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { code: 'memory_runtime_disabled' },
        enabled: false,
        state: 'stopped',
      });
    }
    expect(existsSync(join(home, 'memory-runtime'))).toBe(false);
    expect(existsSync(join(home, 'memory-runtime.json'))).toBe(false);

    const source = await fetch(`${base}/admin/api/memory-runtime/model-source`);
    expect(source.status).toBe(200);
    expect(await source.json()).toMatchObject({
      ok: true,
      source: 'heuristic',
      enabled: false,
      available: false,
      applies: 'next_start',
    });
  });

  it('sidecar 不可用：结构化 memory_runtime_unavailable，不抛 500', async () => {
    const missing = join(await tempDir(), 'missing-memory-runtime');
    const { base } = await start({ enabled: true, command: missing });
    await waitFor(async () => {
      const response = await fetch(`${base}/admin/api/memory-runtime/status`);
      const body = await response.json();
      return body.enabled === true && body.state !== 'starting' && body.state !== 'ready';
    });
    const response = await fetch(`${base}/admin/api/models`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: 'memory_runtime_unavailable', retryable: true },
      enabled: true,
    });
  });
});

describe('MCP 模型薄代理 · 读取与映射', () => {
  it('GET 目录/状态返回 sidecar 视图；无 token/path/URL', async () => {
    const { home, base } = await start();
    await ready(base);
    const hostToken = (await readFile(join(home, 'memory-runtime', 'host-token'), 'utf-8')).trim();

    const list = await fetch(`${base}/admin/api/models`);
    expect(list.status).toBe(200);
    const body = await list.json();
    expect(body.packs.map((pack) => pack.packId)).toEqual([PACK_8B, PACK_4B,
      'qwen3-14b-instruct-q4_k_m', 'qwen3-30b-a3b-instruct-q4_k_m']);
    expect(body.packs.every((pack) => pack.manifestAvailable === true)).toBe(true);
    expect(body.effectivePack).toBeNull();
    expect(body.runtime.source).toBe('heuristic');
    expect(JSON.stringify(body)).not.toContain(hostToken);
    expect(JSON.stringify(body)).not.toMatch(/tokenFile|installedPath|modelsDir|keyRef|baseUrl/);

    const status = await fetch(`${base}/admin/api/models/status`);
    expect(status.status).toBe(200);
    const statusBody = await status.json();
    expect(statusBody).toMatchObject({
      ok: true,
      runtime: { source: 'heuristic', pack: null },
      recommendation: { kind: 'local', packId: PACK_8B },
      engine: { state: 'stopped', installed: true },
    });
    expect(statusBody.installedPackIds).toEqual([PACK_4B]);
    expect(JSON.stringify(statusBody)).not.toContain(hostToken);
    expect(JSON.stringify(statusBody)).not.toMatch(/tokenFile|installedPath|modelsDir/);
  });

  it('model-source GET/POST：sidecar 拥有来源；local 缺 pack 400，带 pack 走 activate；MCP 不写 config', async () => {
    const { home, base } = await start();
    await ready(base);
    const configPath = join(home, 'memory-runtime', 'config.json');
    expect(existsSync(configPath)).toBe(false);

    const initial = await fetch(`${base}/admin/api/memory-runtime/model-source`);
    expect(await initial.json()).toMatchObject({
      ok: true,
      source: 'heuristic',
      enabled: true,
      available: true,
      applies: 'hot',
    });

    const auth = await csrf(base);
    const auto = await post(base, '/admin/api/memory-runtime/model-source', { source: 'auto' }, auth);
    expect(auto.status).toBe(200);
    expect(await auto.json()).toMatchObject({ ok: true, source: 'auto', applies: 'hot' });

    const localMissing = await post(base, '/admin/api/memory-runtime/model-source', { source: 'local' }, auth);
    expect(localMissing.status).toBe(400);
    expect(await localMissing.json()).toMatchObject({
      ok: false,
      error: 'pack_required',
      code: 'pack_required',
    });

    const local = await post(base, '/admin/api/memory-runtime/model-source', {
      source: 'local',
      pack: PACK_4B,
    }, auth);
    expect(local.status).toBe(200);
    expect(await local.json()).toMatchObject({
      ok: true,
      source: 'local',
      selectedPack: PACK_4B,
      activated: true,
      applies: 'hot',
    });

    const invalid = await post(base, '/admin/api/memory-runtime/model-source', { source: 'nope' }, auth);
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error).toBe('invalid_model_source');

    // MCP 不直接写 config.json；fake sidecar 也不写，因此文件仍不存在。
    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(`${configPath}.bak`)).toBe(false);
  });
});

describe('MCP 模型薄代理 · 写操作映射与门禁', () => {
  it('install 202/job；cancel/select/remove/start/stop/test 映射；unsupported 明确', async () => {
    const outDir = await tempDir('mebular-inference-admin-out-');
    const adminOut = join(outDir, 'admin.jsonl');
    const { home, base } = await start({ env: { FAKE_SIDECAR_ADMIN_OUT: adminOut } });
    await ready(base);
    const hostToken = (await readFile(join(home, 'memory-runtime', 'host-token'), 'utf-8')).trim();
    const auth = await csrf(base);

    const installed = await post(base, '/admin/api/models/install', { pack: PACK_4B }, auth);
    expect(installed.status).toBe(202);
    const installedBody = await installed.json();
    expect(installedBody).toMatchObject({
      ok: true,
      accepted: true,
      pack: PACK_4B,
      job: { jobId: 'job_fake_0001', state: 'downloading' },
      jobId: 'job_fake_0001',
    });
    expect(JSON.stringify(installedBody)).not.toContain(hostToken);

    const cancelled = await post(base, '/admin/api/models/cancel', {}, auth);
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({ ok: true, cancelled: true });

    const selected = await post(base, '/admin/api/models/select', { pack: PACK_4B }, auth);
    expect(selected.status).toBe(200);
    expect(await selected.json()).toMatchObject({
      ok: true,
      selected: true,
      selectedPack: PACK_4B,
      activated: true,
      active: 'local',
      requiresRestart: false,
    });

    const started = await post(base, '/admin/api/models/start', { pack: PACK_4B }, auth);
    expect(started.status).toBe(200);
    expect(await started.json()).toMatchObject({ ok: true, pack: PACK_4B, started: true });

    const stopped = await post(base, '/admin/api/models/stop', { pack: PACK_4B }, auth);
    expect(stopped.status).toBe(200);
    expect(await stopped.json()).toMatchObject({ ok: true, pack: PACK_4B, stopped: true });

    const tested = await post(base, '/admin/api/models/test', { pack: PACK_4B }, auth);
    expect(tested.status).toBe(200);
    expect(await tested.json()).toMatchObject({
      ok: true,
      tested: true,
      pack: PACK_4B,
      state: 'installed',
      installed: true,
    });

    const removed = await post(base, '/admin/api/models/remove', { pack: PACK_4B }, auth);
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({ ok: true, pack: PACK_4B, removed: true });

    for (const action of ['pause', 'resume', 'import']) {
      const response = await post(base, `/admin/api/models/${action}`, { pack: PACK_4B }, auth);
      expect(response.status).toBe(501);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: 'unsupported' } });
    }

    const unknown = await post(base, '/admin/api/models/explode', {}, auth);
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).error).toBe('not_found');

    const lines = (await readFile(adminOut, 'utf-8')).trim().split('\n').filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(lines.some((line) => line.method === 'POST' && line.path.endsWith(`/models/${PACK_4B}/install`))).toBe(true);
    expect(lines.some((line) => line.method === 'POST' && line.path.endsWith('/installs/job_fake_0001/cancel'))).toBe(true);
    expect(lines.some((line) => line.method === 'POST' && line.path.endsWith(`/models/${PACK_4B}/activate`))).toBe(true);
    expect(lines.some((line) => line.method === 'POST' && line.path.endsWith('/inference/settings'))).toBe(false);
  }, 30000);

  it('未安装 pack 时 test 不启动引擎，返回 sidecar 状态检查', async () => {
    const { base } = await start();
    await ready(base);
    const auth = await csrf(base);
    const tested = await post(base, '/admin/api/models/test', { pack: PACK_8B }, auth);
    const body = await tested.json();
    expect(tested.status).toBe(200);
    expect(body).toMatchObject({ ok: true, tested: true, pack: PACK_8B, state: 'not_installed', installed: false });
    expect(body.engine).toMatchObject({ state: 'stopped', installed: true });
  });

  it('无 CSRF 403；跨站 Origin 403；缺失 pack 400；写端点需要 memory.admin', async () => {
    const { base } = await start();
    await ready(base);
    const payload = JSON.stringify({ pack: PACK_4B });

    const noCsrf = await fetch(`${base}/admin/api/models/select`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    });
    expect(noCsrf.status).toBe(403);

    const auth = await csrf(base);
    const cross = await post(base, '/admin/api/models/select', { pack: PACK_4B }, {
      ...auth,
      origin: 'https://evil.example',
    });
    expect(cross.status).toBe(403);
    expect((await cross.json()).message).toContain('Origin');

    const missingPack = await post(base, '/admin/api/models/select', {}, auth);
    expect(missingPack.status).toBe(400);
    expect((await missingPack.json()).error.code).toBe('invalid_request');

    const authDir = await tempDir('mebular-inference-token-auth-');
    await mkdir(authDir, { recursive: true });
    const tokensFile = join(authDir, 'tokens.json');
    const readToken = 'meb-read-token';
    await writeFile(tokensFile, JSON.stringify({
      tokens: [{ id: 'read', sha256: hashToken(readToken), scope: ['memory.read'], revoked: false }],
    }), 'utf-8');
    const bearer = await start({ auth: 'bearer', tokensFile });
    await waitFor(async () => {
      const response = await fetch(`${bearer.base}/admin/api/memory-runtime/status`, {
        headers: { authorization: `Bearer ${readToken}` },
      });
      if (response.status !== 200) return null;
      return (await response.json()).state === 'ready';
    });

    const anonymous = await fetch(`${bearer.base}/admin/api/models`);
    expect(anonymous.status).toBe(401);
    const read = await fetch(`${bearer.base}/admin/api/models`, {
      headers: { authorization: `Bearer ${readToken}` },
    });
    expect(read.status).toBe(200);
    const write = await post(bearer.base, '/admin/api/models/select', { pack: PACK_4B }, {
      token: 'x',
      cookie: 'mebular_csrf=x',
      bearer: readToken,
    });
    expect(write.status).toBe(403);
    expect((await write.json()).message).toContain('memory.admin');
  }, 30000);
});
