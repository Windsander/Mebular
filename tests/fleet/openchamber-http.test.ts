// Fleet M4：中立 HTTP OpenChamber seam 的单测（本地 fake provider，自洽可再生）。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpOpenChamberSeam, OpenChamberAgent } from '../../packages/fleet/src/index.js';
import { mkEvent } from './helpers.js';
import { reduceTaskEvents } from '../../packages/fleet/src/index.js';

type Behavior = (req: { auth: string | undefined; body: Record<string, unknown> }) => { status: number; json?: unknown; raw?: string; never?: boolean };

interface FakeServer {
  endpoint: string;
  last: { auth?: string; body?: Record<string, unknown> };
  close: () => Promise<void>;
}

async function startServer(behavior: Behavior): Promise<FakeServer> {
  const last: FakeServer['last'] = {};
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      const auth = req.headers['x-bridge-token'] as string | undefined;
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(data) as Record<string, unknown>;
      } catch {
        body = {};
      }
      last.auth = auth;
      last.body = body;
      const out = behavior({ auth, body });
      if (out.never === true) return; // 不响应 → 触发客户端超时
      res.statusCode = out.status;
      res.setHeader('content-type', 'application/json');
      res.end(out.json !== undefined ? JSON.stringify(out.json) : (out.raw ?? ''));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    endpoint: `http://127.0.0.1:${port}/agent/run-once`,
    last,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fleet-ochttp-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const task = (intent: string) =>
  reduceTaskEvents([mkEvent('created', `oc-${intent}`, { to: { device: 'device-B', agent: 'openchamber' }, intent, trace: { chain: [] } })])!;

describe('HttpOpenChamberSeam（中立 HTTP 客户端）', () => {
  it('成功：返回 text/sessionId，并带上可配鉴权头与请求字段', async () => {
    const server = await startServer(() => ({ status: 200, json: { ok: true, result: { sessionId: 'ses-1', text: 'OC_OK', ms: 5 } } }));
    const seam = new HttpOpenChamberSeam({ endpoint: server.endpoint, token: 'sekret-token', timeoutMs: 2000 });
    const out = await seam.prompt({ prompt: 'hi', agent: 'build', model: 'p/m' });
    expect(out).toEqual({ text: 'OC_OK', sessionId: 'ses-1' });
    expect(server.last.auth).toBe('sekret-token');
    expect(server.last.body).toMatchObject({ prompt: 'hi', agent: 'build', model: 'p/m' });
    expect(typeof server.last.body?.timeoutSec).toBe('number');
    await server.close();
  });

  it('token 从文件读取（JSON 点分路径 / 原始文本）', async () => {
    const server = await startServer(() => ({ status: 200, json: { ok: true, result: { text: 'ok' } } }));
    const jsonFile = join(dir, 'daemon.json');
    await writeFile(jsonFile, JSON.stringify({ port: 1, token: 'file-token' }), { mode: 0o600 });
    const seam = new HttpOpenChamberSeam({ endpoint: server.endpoint, tokenFile: jsonFile, tokenJsonPath: 'token' });
    await seam.prompt({ prompt: 'x' });
    expect(server.last.auth).toBe('file-token');

    const rawFile = join(dir, 'token.txt');
    await writeFile(rawFile, 'raw-token\n');
    const seam2 = new HttpOpenChamberSeam({ endpoint: server.endpoint, tokenFile: rawFile });
    await seam2.prompt({ prompt: 'x' });
    expect(server.last.auth).toBe('raw-token');
    await server.close();
  });

  it('可配 authHeader', async () => {
    let seen: string | undefined;
    const server = http.createServer((req, res) => {
      seen = req.headers['x-custom-auth'] as string | undefined;
      req.resume();
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, result: { text: 'ok' } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    const seam = new HttpOpenChamberSeam({ endpoint: `http://127.0.0.1:${port}/x`, token: 't', authHeader: 'X-Custom-Auth' });
    await seam.prompt({ prompt: 'x' });
    expect(seen).toBe('t');
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('负例：错误/未授权/超时/非 JSON，且错误不泄露 token', async () => {
    const errServer = await startServer(() => ({ status: 200, json: { ok: false, error: 'session failed' } }));
    expect((await new HttpOpenChamberSeam({ endpoint: errServer.endpoint, token: 't' }).prompt({ prompt: 'x' })).error).toBe('session failed');
    await errServer.close();

    const unauth = await startServer(({ auth }) => (auth === 'right' ? { status: 200, json: { ok: true, result: { text: 'ok' } } } : { status: 401, json: { ok: false, error: 'unauthorized' } }));
    const bad = await new HttpOpenChamberSeam({ endpoint: unauth.endpoint, token: 'wrong-secret' }).prompt({ prompt: 'x' });
    expect(bad.error).toBe('unauthorized');
    expect(bad.error ?? '').not.toContain('wrong-secret');
    await unauth.close();

    const slow = await startServer(() => ({ status: 200, never: true }));
    expect((await new HttpOpenChamberSeam({ endpoint: slow.endpoint, token: 't', timeoutMs: 150 }).prompt({ prompt: 'x' })).error).toMatch(/unavailable or timed out/);
    await slow.close();

    const nonJson = await startServer(() => ({ status: 200, raw: 'not json' }));
    expect((await new HttpOpenChamberSeam({ endpoint: nonJson.endpoint, token: 't' }).prompt({ prompt: 'x' })).error).toMatch(/non-JSON/);
    await nonJson.close();
  });

  it('负例：缺 endpoint / 缺 token', async () => {
    expect((await new HttpOpenChamberSeam({ token: 't' }).prompt({ prompt: 'x' })).error).toMatch(/endpoint not configured/);
    expect((await new HttpOpenChamberSeam({ endpoint: 'http://127.0.0.1:1/x', tokenFile: join(dir, 'nope.json') }).prompt({ prompt: 'x' })).error).toMatch(/token unavailable/);
  });

  it('OpenChamberAgent 归一：成功→done，失败→OPENCHAMBER_ERROR', async () => {
    const ok = await startServer(() => ({ status: 200, json: { ok: true, result: { sessionId: 'ses-9', text: 'RESULT' } } }));
    const agent = new OpenChamberAgent(new HttpOpenChamberSeam({ endpoint: ok.endpoint, token: 't' }));
    expect(await agent.execute(task('do'))).toEqual({ ok: true, reason: 'session:ses-9', resultRef: 'RESULT' });
    await ok.close();

    const bad = await startServer(() => ({ status: 200, json: { ok: false, error: 'boom' } }));
    const agent2 = new OpenChamberAgent(new HttpOpenChamberSeam({ endpoint: bad.endpoint, token: 't' }));
    expect(await agent2.execute(task('do'))).toEqual({ ok: false, reason: 'OPENCHAMBER_ERROR: boom' });
    await bad.close();
  });
});
