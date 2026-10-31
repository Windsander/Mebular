// /admin/api/models：沿用现有 auth + CSRF + Origin + memory.admin scope；设备级 store 不写记忆。

import { describe, it, expect, afterEach } from '@jest/globals';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startHttpServer, hashToken } from '../../packages/mcp/src/serve.mjs';
import {
  PACK_4B,
  PACK_8B,
  PACK_14B,
  PACK_30B,
  cleanupDirs,
  makeManifest,
  tempDir,
  writeImportPack,
} from '../../packages/memory-runtime/tests/inference/mcp-helpers.mjs';

const cleanups = [];
const tempDirs = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
  await cleanupDirs(tempDirs);
  delete process.env.MEBULAR_MODEL_HARDWARE_JSON;
  delete process.env.MEBULAR_CLOUD_ROOT;
  delete process.env.MEBULAR_LLAMA_SERVER;
});

const fakeApp = {
  sync: { on() {}, off() {} },
  getBlockedDevices: async () => [],
};
const fakeService = {
  status: async () => ({ running: true, nodeCount: 0, pendingEventCount: 0, peerId: null }),
};

const HARDWARE = {
  platform: 'darwin',
  arch: 'arm64',
  osVersion: 'test',
  cpuModel: 'Apple M3',
  cpuCores: 8,
  totalMemoryBytes: 16 * 1024 ** 3,
  freeMemoryBytes: 8 * 1024 ** 3,
  disk: { path: '/tmp', availableBytes: 100 * 1024 ** 3, totalBytes: 500 * 1024 ** 3 },
  gpu: { vendor: 'apple', name: 'Apple M3', unifiedMemory: true },
  detectedAt: 0,
  warnings: [],
};

async function setup({ auth = 'none', tokensFile = null, env = {} } = {}) {
  const home = await tempDir('mebular-inference-api-');
  const cloud = await tempDir('mebular-inference-api-cloud-');
  tempDirs.push(home, cloud);
  process.env.MEBULAR_CLOUD_ROOT = cloud;
  process.env.MEBULAR_MODEL_HARDWARE_JSON = JSON.stringify(HARDWARE);
  Object.assign(process.env, env);
  const server = await startHttpServer({
    home,
    app: fakeApp,
    service: fakeService,
    config: {},
    host: '127.0.0.1',
    port: 0,
    auth,
    ...(tokensFile ? { tokensFile } : {}),
    writesEnabled: true,
  });
  cleanups.push(() => server.close());
  return { home, base: `http://127.0.0.1:${server.port}` };
}

async function csrf(base) {
  const response = await fetch(`${base}/console/`);
  const token = response.headers.get('x-mebular-csrf');
  const cookie = response.headers.getSetCookie()
    .find((value) => value.startsWith('mebular_csrf='))
    ?.split(';')[0];
  return { token, cookie };
}

async function post(base, path, body, auth) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(auth?.token ? { 'x-mebular-csrf': auth.token } : {}),
      ...(auth?.cookie ? { cookie: auth.cookie } : {}),
      ...(auth?.bearer ? { authorization: `Bearer ${auth.bearer}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe('GET /admin/api/models', () => {
  it('返回四项精选目录与设备状态；status 含硬件推荐', async () => {
    const { base } = await setup();
    const list = await fetch(`${base}/admin/api/models`);
    expect(list.status).toBe(200);
    const body = await list.json();
    expect(body.packs.map((pack) => pack.packId)).toEqual([PACK_8B, PACK_30B, PACK_14B, PACK_4B]);
    expect(body.packs.every((pack) => pack.state === 'not_installed')).toBe(true);
    expect(body.packs.every((pack) => pack.manifestAvailable === true)).toBe(true);

    const status = await fetch(`${base}/admin/api/models/status`);
    const statusBody = await status.json();
    expect(statusBody).toMatchObject({
      ok: true,
      runtime: { source: 'heuristic', pack: null },
      recommendation: { kind: 'local', packId: PACK_8B },
    });
    expect(statusBody.engine.state).toBe('stopped');
    expect(JSON.stringify(statusBody)).not.toMatch(/apiKey|sk-/i);
  });
});

async function writeFakeLlama(dir) {
  const path = join(dir, 'llama-server');
  await writeFile(path, `#!/usr/bin/env node
import { createServer } from 'node:http';
const args = process.argv.slice(2);
const get = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const port = Number(get('--port'));
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    if (req.url === '/health') { res.end(JSON.stringify({ status: 'ok' })); return; }
    if (req.url === '/v1/chat/completions') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ ok: true }) } }] }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
});
server.listen(port, '127.0.0.1');
const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
`, 'utf-8');
  await chmod(path, 0o755);
  return path;
}

describe('写端点门禁：CSRF / Origin / scope', () => {
  it('无 CSRF 403；跨站点 Origin 403；同源 + CSRF 才进入业务错误', async () => {
    const { base } = await setup();
    const noCsrf = await post(base, '/admin/api/models/select', { pack: PACK_4B });
    expect(noCsrf.status).toBe(403);

    const auth = await csrf(base);
    const cross = await fetch(`${base}/admin/api/models/select`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://evil.example',
        'x-mebular-csrf': auth.token,
        cookie: auth.cookie,
      },
      body: JSON.stringify({ pack: PACK_4B }),
    });
    expect(cross.status).toBe(403);
    expect((await cross.json()).message).toContain('Origin');

    const allowed = await post(base, '/admin/api/models/select', {
      pack: PACK_4B,
    }, auth);
    expect(allowed.status).toBe(409);
    expect(await allowed.json()).toMatchObject({
      ok: false,
      error: { code: 'not_installed', retryable: false },
    });
  });

  it('import/start/test/stop 全链路：假 llama-server，退出前停止子进程', async () => {
    if (process.platform === 'win32') return;
    const binDir = await tempDir('mebular-inference-api-bin-');
    const source = await tempDir('mebular-inference-api-src-');
    tempDirs.push(binDir, source);
    const binary = await writeFakeLlama(binDir);
    await writeImportPack(source, makeManifest());
    const { base } = await setup({ env: { MEBULAR_LLAMA_SERVER: binary } });
    const auth = await csrf(base);

    const imported = await post(base, '/admin/api/models/import', { path: source }, auth);
    expect(imported.status).toBe(200);
    expect(await imported.json()).toMatchObject({ ok: true, imported: true, pack: PACK_4B });

    const started = await post(base, '/admin/api/models/start', { pack: PACK_4B }, auth);
    expect(started.status).toBe(200);
    expect(await started.json()).toMatchObject({ ok: true, state: 'running', packId: PACK_4B });

    const tested = await post(base, '/admin/api/models/test', { pack: PACK_4B }, auth);
    expect(tested.status).toBe(200);
    expect(await tested.json()).toMatchObject({ ok: true, pack: PACK_4B, startedByTest: false });

    const stopped = await post(base, '/admin/api/models/stop', { pack: PACK_4B }, auth);
    expect(stopped.status).toBe(200);
    expect(await stopped.json()).toMatchObject({ ok: true, stopped: true, pack: PACK_4B });
  });

  it('bearer：无 token 401；memory.read token 读得到但写 403（需要 memory.admin）', async () => {
    const home = await tempDir('mebular-inference-token-home-');
    const authDir = await tempDir('mebular-inference-token-auth-');
    tempDirs.push(home, authDir);
    const token = 'meb-read-token';
    const tokensFile = join(authDir, 'tokens.json');
    await mkdir(authDir, { recursive: true });
    await writeFile(tokensFile, JSON.stringify({
      tokens: [{ id: 'read', sha256: hashToken(token), scope: ['memory.read'], revoked: false }],
    }), 'utf-8');
    const { base } = await setup({ auth: 'bearer', tokensFile });

    const anonymous = await fetch(`${base}/admin/api/models`);
    expect(anonymous.status).toBe(401);

    const read = await fetch(`${base}/admin/api/models`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(read.status).toBe(200);

    const write = await post(
      base,
      '/admin/api/models/select',
      { pack: PACK_4B },
      { token: 'x', cookie: 'mebular_csrf=x', bearer: token },
    );
    expect(write.status).toBe(403);
    expect((await write.json()).message).toContain('memory.admin');
  });
});
