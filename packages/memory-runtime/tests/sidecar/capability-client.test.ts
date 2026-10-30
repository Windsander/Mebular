// capability client：读/写/internal-object/sync、Bearer、重试、超时、401 轮换、错误映射。
// 使用本机 fake HTTP server，不启动真实 MCP daemon/模型。

import { describe, it, expect, afterEach } from '@jest/globals';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  CapabilityClient,
  CapabilityClientError,
} from '../../src/sidecar/capability-client.js';

interface FakeRequest {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: unknown;
}

interface FakeResult {
  status?: number;
  body: unknown;
  delayMs?: number;
}

interface FakeServer {
  baseUrl: string;
  requests: FakeRequest[];
  close: () => Promise<void>;
}

const servers: FakeServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

async function startFake(handler: (request: FakeRequest, index: number) => FakeResult | Promise<FakeResult>): Promise<FakeServer> {
  const requests: FakeRequest[] = [];
  const server: Server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const request: FakeRequest = {
        method: req.method ?? 'GET',
        path: url.pathname,
        headers: req.headers,
        body: text.length > 0 ? JSON.parse(text) as unknown : null,
      };
      requests.push(request);
      const result = await handler(request, requests.length);
      if (result.delayMs) await new Promise((resolve) => setTimeout(resolve, result.delayMs));
      res.statusCode = result.status ?? 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(result.body));
    })().catch(() => {
      if (!res.writableEnded) {
        res.statusCode = 500;
        res.end('{"ok":false,"error":{"code":"internal"}}');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  const fake: FakeServer = {
    baseUrl: `http://127.0.0.1:${address.port}/internal/memory/v1`,
    requests,
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
  };
  servers.push(fake);
  return fake;
}

function ok(data: unknown) {
  return {
    ok: true,
    requestId: 'req_fake',
    capabilityVersion: 1,
    data,
    warnings: [],
    degraded: false,
  };
}

function error(status: number, code: string, retryable = false) {
  return {
    status,
    body: {
      ok: false,
      requestId: 'req_fake',
      capabilityVersion: 1,
      error: { code, message: 'fake error', retryable, details: { domain: 'agent:test' } },
    },
  };
}

describe('CapabilityClient', () => {
  it('读端点使用 Bearer token 并返回统一信封 data', async () => {
    const fake = await startFake((request) => ({
      body: ok({ path: request.path }),
    }));
    const client = new CapabilityClient({ baseUrl: fake.baseUrl, token: 'cap-token', retries: 0 });

    const version = await client.getVersion();
    expect(version.data).toEqual({ path: '/internal/memory/v1/version' });
    expect(version.status).toBe(200);
    expect(version.warnings).toEqual([]);

    const calls: Array<[string, Promise<{ data: unknown }>]> = [
      ['/status', client.getStatus({ actor: JSON.stringify({ type: 'user' }), includeCounts: 'false' })],
      ['/namespaces', client.getNamespaces({ actor: 'agent:test' })],
      ['/query', client.query({ query: 'x' })],
      ['/search', client.search({ query: 'x' })],
      ['/history', client.history({})],
      ['/profile', client.profile({})],
      ['/skills', client.skills({})],
      ['/graph', client.graph({ startId: '01J' })],
    ];
    for (const [path, promise] of calls) {
      const response = await promise;
      expect(response.data).toEqual({ path: `/internal/memory/v1${path}` });
    }

    expect(fake.requests).toHaveLength(9);
    for (const request of fake.requests) {
      expect(request.headers.authorization).toBe('Bearer cap-token');
      expect(request.headers['x-mebular-capability-version']).toBe('1');
    }
    const statusRequest = fake.requests.find((request) => request.path.endsWith('/status'));
    expect(statusRequest?.headers['x-request-id']).toMatch(/^req_/);
  });

  it('写端点覆盖 write/update/delete/archive/internal-object/sync，并带幂等键', async () => {
    const fake = await startFake((request) => ({
      body: ok({ path: request.path, method: request.method }),
    }));
    const client = new CapabilityClient({ baseUrl: fake.baseUrl, token: 'cap-token', retries: 0 });

    await client.write({ items: [{ domain: 'agent:test' }] }, { idempotencyKey: 'idem-1' });
    await client.update({ items: [] });
    await client.delete({ ids: ['01J'] });
    await client.archive({ ids: ['01J'], archived: true });
    await client.internalObject({ kind: 'compact', op: 'upsert', domain: 'agent:test' });
    await client.sync({ action: 'now' });
    const syncStatus = await client.getSync({ actor: 'user' });

    expect(syncStatus.data).toEqual({ path: '/internal/memory/v1/sync', method: 'GET' });
    expect(fake.requests.map((request) => request.path)).toEqual([
      '/internal/memory/v1/write',
      '/internal/memory/v1/update',
      '/internal/memory/v1/delete',
      '/internal/memory/v1/archive',
      '/internal/memory/v1/internal-object',
      '/internal/memory/v1/sync',
      '/internal/memory/v1/sync',
    ]);
    expect(fake.requests[0]?.headers['idempotency-key']).toBe('idem-1');
    expect(fake.requests[0]?.body).toEqual({ items: [{ domain: 'agent:test' }] });
    expect(fake.requests[4]?.body).toEqual({ kind: 'compact', op: 'upsert', domain: 'agent:test' });
    expect(fake.requests[5]?.method).toBe('POST');
    expect(fake.requests[6]?.method).toBe('GET');
    expect(fake.requests[6]?.headers.authorization).toBe('Bearer cap-token');
  });

  it('detail 端点覆盖 write/get/list/delete，并保留 op/幂等键', async () => {
    const fake = await startFake((request) => ({
      body: ok({ path: request.path, method: request.method, body: request.body }),
    }));
    const client = new CapabilityClient({ baseUrl: fake.baseUrl, token: 'cap-token', retries: 0 });

    const write = await client.detailWrite({
      requestId: 'req_det',
      actor: { type: 'agent', agentId: 'test' },
      items: [{ clientItemId: 'det_1', domain: 'user', detailKind: 'raw_chunk', recordIds: ['01J'], text: 'x' }],
    }, { idempotencyKey: 'req_det' });
    const get = await client.detailGet({ actor: { type: 'agent', agentId: 'test' }, id: '01D', includeText: true });
    const list = await client.detailList({ actor: { type: 'agent', agentId: 'test' }, domains: ['user'] });
    const remove = await client.detailDelete({ actor: { type: 'user' }, ids: ['01D'], reason: 'user_requested' });

    expect((write.data as any).body.op).toBe('write');
    expect((get.data as any).body.op).toBe('get');
    expect((list.data as any).body.op).toBe('list');
    expect((remove.data as any).body.op).toBe('delete');
    expect(fake.requests.map((request) => request.path)).toEqual([
      '/internal/memory/v1/detail',
      '/internal/memory/v1/detail',
      '/internal/memory/v1/detail',
      '/internal/memory/v1/detail',
    ]);
    expect(fake.requests[0]?.headers['idempotency-key']).toBe('req_det');
  });

  it('detail 错误映射保留 410/403/413 稳定 code', async () => {
    const fake = await startFake((request) => {
      const body = request.body as any;
      if (body?.op === 'get') return error(410, 'detail_deleted');
      if (body?.op === 'list') return error(403, 'domain_read_forbidden');
      return error(413, 'detail_quota_exceeded');
    });
    const client = new CapabilityClient({ baseUrl: fake.baseUrl, token: 'cap-token', retries: 0 });
    await expect(client.detailGet({ id: '01D' })).rejects.toMatchObject({
      code: 'detail_deleted',
      status: 410,
    });
    await expect(client.detailList({ domains: ['user'] })).rejects.toMatchObject({
      code: 'domain_read_forbidden',
      status: 403,
    });
    await expect(client.detailWrite({ items: [] })).rejects.toMatchObject({
      code: 'detail_quota_exceeded',
      status: 413,
    });
  });

  it('把 403/409/422 映射为稳定错误，不泄漏 token', async () => {
    const fake = await startFake(() => error(403, 'domain_write_forbidden'));
    const client = new CapabilityClient({ baseUrl: fake.baseUrl, token: 'super-secret-token', retries: 0 });

    let caught: unknown;
    try {
      await client.write({ items: [] });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CapabilityClientError);
    const failure = caught as CapabilityClientError;
    expect(failure.code).toBe('domain_write_forbidden');
    expect(failure.status).toBe(403);
    expect(failure.retryable).toBe(false);
    expect(failure.details).toEqual({ domain: 'agent:test' });
    expect(JSON.stringify({ message: failure.message, details: failure.details })).not.toContain('super-secret-token');
  });

  it('网络/5xx 按退避重试，成功后返回', async () => {
    const fake = await startFake((_request, index) => (
      index < 3 ? error(503, 'capability_unavailable', true) : { body: ok({ ready: true }) }
    ));
    const client = new CapabilityClient({
      baseUrl: fake.baseUrl,
      token: 'cap-token',
      retries: 2,
      retryDelayMs: 1,
    });
    const response = await client.getVersion();
    expect(response.data).toEqual({ ready: true });
    expect(fake.requests).toHaveLength(3);
  });

  it('超时映射为 timeout，可按配置停用重试', async () => {
    const fake = await startFake(() => ({ body: ok({ slow: true }), delayMs: 150 }));
    const client = new CapabilityClient({
      baseUrl: fake.baseUrl,
      token: 'cap-token',
      timeoutMs: 20,
      retries: 0,
    });
    await expect(client.getVersion()).rejects.toMatchObject({
      code: 'timeout',
      retryable: true,
    });
  });

  it('401 时重读 token 并重试一次', async () => {
    let current = 'old-token';
    const fake = await startFake((request) => (
      request.headers.authorization === 'Bearer new-token'
        ? { body: ok({ rotated: true }) }
        : error(401, 'capability_token_invalid')
    ));
    const client = new CapabilityClient({
      baseUrl: fake.baseUrl,
      token: 'old-token',
      readToken: () => {
        current = 'new-token';
        return current;
      },
      retries: 0,
    });
    const response = await client.getVersion();
    expect(response.data).toEqual({ rotated: true });
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[0]?.headers.authorization).toBe('Bearer old-token');
    expect(fake.requests[1]?.headers.authorization).toBe('Bearer new-token');
  });

  it('拒绝非 loopback base URL', () => {
    expect(() => new CapabilityClient({ baseUrl: 'http://192.168.1.2:7331/internal/memory/v1' }))
      .toThrow(CapabilityClientError);
    expect(() => new CapabilityClient({ baseUrl: 'not-a-url' })).toThrow(CapabilityClientError);
  });
});
