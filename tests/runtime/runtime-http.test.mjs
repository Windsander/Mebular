// /runtime/v1 HTTP 路由：统一信封、status、mode 持久化、auth/未知路径；MCP 工具面不变。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHttpServer } from '../../packages/mcp/src/serve.mjs';

describe('/runtime/v1', () => {
  let home;
  let running = [];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'mebular-runtime-http-'));
    running = [];
  });

  afterEach(async () => {
    for (const server of running) await server.close().catch(() => undefined);
    await rm(home, { recursive: true, force: true });
  });

  function fakeApp() {
    return {
      deviceId: 'device-http',
      identity: { getUserMasterPublicKey: () => new Uint8Array([1, 2, 3, 4]) },
      graph: { listNodes: async () => [] },
      sync: {
        getSyncStatus: async () => ({ pendingCount: 0 }),
        getSubscriptionNamespaces: () => ['default'],
      },
      node: null,
      atRestEncryption: false,
    };
  }

  async function start({ config = {}, auth = 'none' } = {}) {
    const server = await startHttpServer({
      home,
      app: fakeApp(),
      service: null,
      config,
      host: '127.0.0.1',
      port: 0,
      auth,
    });
    running.push(server);
    return server;
  }

  it('GET status：统一信封 + 身份/能力/计数/limits + X-Mebular-Mode', async () => {
    const server = await start();
    const res = await fetch(`http://127.0.0.1:${server.port}/runtime/v1/status`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-mebular-mode')).toBe('mcp');
    expect(res.headers.get('x-request-id')).toMatch(/^req_/);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.requestId).toMatch(/^req_/);
    expect(Array.isArray(body.warnings)).toBe(true);
    expect(body.data).toMatchObject({
      initialized: true,
      mode: 'mcp',
      identity: {
        deviceId: 'device-http',
        agentId: 'mebular',
      },
      capabilities: {
        mcpTools: true,
        ingest: false,
        rawCapture: 'off',
        trace: 'local',
      },
      counts: {
        memoryRecords: 0,
        compacts: 0,
        checkpoints: 0,
        selfRecords: 0,
        localRawChunks: 0,
      },
      sync: { running: false, pendingEvents: 0, namespaces: ['default'] },
      limits: { maxChunkBytes: 262144, maxContextTokens: 12000, maxRecall: 50 },
    });
    expect(body.data.identity.cloudId).toMatch(/^cl_[0-9a-f]{32}$/);
    expect(body.data.identity.hostId).toMatch(/^h_[0-9a-f]{16}$/);
  });

  it('POST mode：切到 immersive 并原子写 config；重启实例读取最后模式', async () => {
    await writeFile(
      join(home, 'config.json'),
      JSON.stringify({ mcp: { http: { port: 7331 } } }, null, 2),
      'utf8',
    );
    const server = await start({ config: { mcp: { http: { port: 7331 } } } });
    const base = `http://127.0.0.1:${server.port}`;

    const res = await fetch(`${base}/runtime/v1/mode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'immersive' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-mebular-mode')).toBe('immersive');
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      data: {
        mode: 'immersive',
        changed: true,
        requiresRestart: false,
        capabilities: { ingest: false, checkpoint: false, compact: false },
      },
    });

    const disk = JSON.parse(await readFile(join(home, 'config.json'), 'utf8'));
    expect(disk.runtime.mode).toBe('immersive');
    expect(disk.mcp.http.port).toBe(7331);

    // 模拟重启：同一 home/config 新实例，模式来自最后一次原子写。
    const restarted = await start({ config: disk });
    const status = await (await fetch(`http://127.0.0.1:${restarted.port}/runtime/v1/status`)).json();
    expect(status.data.mode).toBe('immersive');

    const back = await fetch(`http://127.0.0.1:${restarted.port}/runtime/v1/mode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'mcp' }),
    });
    expect((await back.json()).data).toMatchObject({ mode: 'mcp', changed: true });
  });

  it('错误信封：invalid mode 400、未知 runtime 路径 404、错误方法 405', async () => {
    const server = await start();
    const base = `http://127.0.0.1:${server.port}`;

    const invalid = await fetch(`${base}/runtime/v1/mode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'turbo' }),
    });
    expect(invalid.status).toBe(400);
    const invalidBody = await invalid.json();
    expect(invalidBody.ok).toBe(false);
    expect(invalidBody.error.code).toBe('invalid_request');

    const missing = await fetch(`${base}/runtime/v1/unknown`);
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe('not_found');

    const wrongMethod = await fetch(`${base}/runtime/v1/mode`);
    expect(wrongMethod.status).toBe(405);
    expect((await wrongMethod.json()).error.code).toBe('method_not_allowed');
  });

  it('auth 复用：bearer 模式下未带 token 的 status 返回 401 统一信封', async () => {
    const server = await start({ auth: 'bearer' });
    const res = await fetch(`http://127.0.0.1:${server.port}/runtime/v1/status`);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatchObject({ code: 'unauthorized', retryable: false });
  });
});
