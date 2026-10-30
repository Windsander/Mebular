// sidecar host API：health 无 token、version/status host token、loopback/Host/Origin、
// 501 业务占位、统一信封。

import { describe, it, expect, afterEach } from '@jest/globals';
import { request } from 'node:http';
import { defaultSidecarConfig } from '../../src/sidecar/config.js';
import {
  SidecarServer,
  isLoopbackAddress,
  isLoopbackHostHeader,
  isLoopbackOrigin,
  type SidecarStatusSnapshot,
} from '../../src/sidecar/server.js';

const servers: SidecarServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

function statusSnapshot(): SidecarStatusSnapshot {
  return {
    mode: 'immersive',
    identity: { cloudId: 'cl_test', profileId: 'default', hostId: 'h_test' },
    capability: { reachable: true, version: 1, lastOkAt: 1000, error: null },
    model: { configured: 'heuristic', active: 'heuristic', degraded: false, reason: null },
    counts: { rawChunks: 2, traces: 1, cachedRecords: 3, outbox: 0, deadLetter: 0 },
    outbox: { items: 0, bytes: 0, oldestAt: null },
    limits: { maxChunkBytes: 262144, maxContextTokens: 12000, maxRecall: 50 },
    warnings: [],
  };
}

async function startServer(): Promise<SidecarServer> {
  const config = defaultSidecarConfig();
  config.http.port = 0;
  const server = new SidecarServer({
    config,
    hostToken: 'host-token',
    identity: { cloudId: 'cl_test', profileId: 'default', hostId: 'h_test' },
    getStatus: statusSnapshot,
  });
  await server.listen();
  servers.push(server);
  return server;
}

interface RawResponse {
  status: number;
  body: any;
}

function rawRequest(
  url: string,
  { method = 'GET', headers = {}, body }: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<RawResponse> {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: `${parsed.pathname}${parsed.search}`,
      method,
      headers,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, body: text.length > 0 ? JSON.parse(text) as unknown : null });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function auth(): Record<string, string> {
  return { authorization: 'Bearer host-token' };
}

describe('SidecarServer', () => {
  it('health 无需 token，返回最小信息且不包含 token', async () => {
    const server = await startServer();
    const response = await fetch(`${server.url}/health`);
    const body = await response.json() as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.state).toBe('ready');
    expect(body.ready).toBe(true);
    expect(body.pid).toBe(process.pid);
    expect(body.runtimeVersion).toBe('0.3.0');
    expect(body.apiVersion).toBe(1);
    expect(JSON.stringify(body)).not.toContain('host-token');
  });

  it('version/status 要求 host token', async () => {
    const server = await startServer();

    const noAuth = await fetch(`${server.url}/version`);
    expect(noAuth.status).toBe(401);
    expect((await noAuth.json() as any).error.code).toBe('unauthorized');

    const wrong = await fetch(`${server.url}/status`, {
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(wrong.status).toBe(401);
    expect((await wrong.json() as any).error.code).toBe('invalid_token');

    const version = await fetch(`${server.url}/version`, { headers: auth() });
    expect(version.status).toBe(200);
    const versionBody = await version.json() as any;
    expect(versionBody.ok).toBe(true);
    expect(versionBody.data).toMatchObject({
      runtimeVersion: '0.3.0',
      apiVersion: 1,
      capabilityApiVersion: 1,
      minMcpVersion: '0.3.0',
      maxMcpVersion: '0.3.x',
      state: 'ready',
    });

    const status = await fetch(`${server.url}/status`, { headers: auth() });
    expect(status.status).toBe(200);
    const statusBody = await status.json() as any;
    expect(statusBody.data.counts).toMatchObject({ rawChunks: 2, traces: 1, cachedRecords: 3 });
    expect(statusBody.data.identity).toMatchObject({ cloudId: 'cl_test', profileId: 'default' });
    expect(statusBody.data.capability.reachable).toBe(true);
    expect(JSON.stringify(statusBody)).not.toContain('host-token');
  });

  it('拒绝非 loopback Host / Origin，不以 CORS 放宽', async () => {
    const server = await startServer();
    const badHost = await rawRequest(`${server.url}/health`, {
      headers: { host: 'evil.example' },
    });
    expect(badHost.status).toBe(403);
    expect(badHost.body.error.code).toBe('loopback_required');

    const badOrigin = await rawRequest(`${server.url}/health`, {
      headers: { origin: 'https://evil.example' },
    });
    expect(badOrigin.status).toBe(403);
    expect(badOrigin.body.error.code).toBe('forbidden_origin');

    const good = await rawRequest(`${server.url}/health`, {
      headers: { origin: `http://127.0.0.1:${server.listenedPort}` },
    });
    expect(good.status).toBe(200);
    expect(good.body.accessControlAllowOrigin).toBeUndefined();
  });

  it('W3a 业务端点返回 501，未知路径 404，错误方法 405', async () => {
    const server = await startServer();
    const ingest = await rawRequest(`${server.url}/ingest`, {
      method: 'POST',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'test' }),
    });
    expect(ingest.status).toBe(501);
    expect(ingest.body.error).toMatchObject({ code: 'not_implemented', details: { plannedIn: 'W4' } });

    const unknown = await rawRequest(`${server.url}/nope`, { headers: auth() });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('not_found');

    const wrongMethod = await rawRequest(`${server.url}/version`, {
      method: 'POST',
      headers: auth(),
    });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.body.error.code).toBe('method_not_allowed');

    const healthPost = await rawRequest(`${server.url}/health`, { method: 'POST' });
    expect(healthPost.status).toBe(405);

    const outside = await rawRequest(`http://127.0.0.1:${server.listenedPort}/other`, {
      headers: auth(),
    });
    expect(outside.status).toBe(404);
  });

  it('loopback 辅助判定拒绝非本机地址', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('10.0.0.1')).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);

    expect(isLoopbackHostHeader('127.0.0.1:7341', 7341)).toBe(true);
    expect(isLoopbackHostHeader('localhost:7341', 7341)).toBe(true);
    expect(isLoopbackHostHeader('[::1]:7341', 7341)).toBe(true);
    expect(isLoopbackHostHeader('127.0.0.1:7342', 7341)).toBe(false);
    expect(isLoopbackHostHeader('evil.example:7341', 7341)).toBe(false);

    expect(isLoopbackOrigin(undefined, 7341)).toBe(true);
    expect(isLoopbackOrigin('http://127.0.0.1:7341', 7341)).toBe(true);
    expect(isLoopbackOrigin('http://localhost:7341', 7341)).toBe(true);
    expect(isLoopbackOrigin('http://127.0.0.1:7342', 7341)).toBe(false);
    expect(isLoopbackOrigin('https://evil.example', 7341)).toBe(false);
    expect(isLoopbackOrigin('null', 7341)).toBe(false);
  });
});
