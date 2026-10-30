// W4a HTTP 闭环：/ingest → /status 计数 → /namespaces；失败开放/degraded。

import { describe, it, expect, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CapabilityClient } from '../../src/sidecar/capability-client.js';
import { defaultSidecarConfig } from '../../src/sidecar/config.js';
import { defaultSidecarPolicy } from '../../src/sidecar/domains.js';
import { SidecarLocalLayer } from '../../src/sidecar/local-layer.js';
import { SidecarServer } from '../../src/sidecar/server.js';
import { SettlementRuntime } from '../../src/sidecar/settlement.js';
import { startFakeCapability, type FakeCapabilityServer } from './fake-capability.js';

interface Harness {
  home: string;
  fake: FakeCapabilityServer;
  runtime: SettlementRuntime;
  server: SidecarServer;
}

const harnesses: Harness[] = [];

async function setup(): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), 'mebular-memory-runtime-http-'));
  const local = new SidecarLocalLayer({ root: join(home, 'memory-runtime') });
  await local.init();
  const fake = await startFakeCapability();
  const client = new CapabilityClient({ baseUrl: fake.baseUrl, token: 'cap-token', retries: 0, retryDelayMs: 0 });
  const identity = { cloudId: 'cl_test', profileId: 'default', hostId: 'h_test' };
  const config = defaultSidecarConfig();
  config.http.port = 0;
  const runtime = new SettlementRuntime({
    config,
    local,
    client,
    identity,
    policy: defaultSidecarPolicy(),
    autoStartReplayer: false,
  });
  await runtime.init();
  const server = new SidecarServer({
    config,
    hostToken: 'host-token',
    identity,
    getStatus: () => runtime.statusSnapshot({
      mode: 'immersive',
      identity,
      capability: { reachable: true, version: 1, lastOkAt: null, error: null },
      model: { configured: 'heuristic', active: 'heuristic', degraded: false, reason: null },
      limits: {
        maxChunkBytes: config.limits.maxChunkBytes,
        maxContextTokens: config.limits.maxContextTokens,
        maxRecall: config.limits.maxRecall,
      },
      warnings: [],
    }),
    ingest: runtime,
    namespaces: runtime,
    getDegraded: () => runtime.degraded,
  });
  await server.listen();
  const harness = { home, fake, runtime, server };
  harnesses.push(harness);
  return harness;
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.runtime.stop();
    await harness.server.close();
    await harness.fake.close();
    await rm(harness.home, { recursive: true, force: true });
  }
});

function auth(): Record<string, string> {
  return { authorization: 'Bearer host-token' };
}

function ingestBody(requestId: string, text = '我喜欢深色主题') {
  return {
    requestId,
    agentId: 'opencode',
    agentName: 'OpenCode',
    threadId: 'th_http',
    capture: 'local',
    chunks: [{ role: 'user', text, messageId: `m_${requestId}`, chunkIndex: 0 }],
  };
}

describe('sidecar ingest HTTP', () => {
  it('POST /ingest 成功后 /status 暴露 sidecar 计数且不含 token', async () => {
    const { server, runtime } = await setup();
    const response = await fetch(`${server.url}/ingest`, {
      method: 'POST',
      headers: { ...auth(), 'content-type': 'application/json', 'idempotency-key': 'idem_http_1' },
      body: JSON.stringify(ingestBody('idem_http_1')),
    });
    const body = await response.json() as any;
    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data).toMatchObject({
      accepted: { chunks: 1, records: 1 },
      extraction: { status: 'completed', extractor: 'heuristic' },
      queued: false,
      duplicate: false,
    });
    expect(body.data.rawChunkIds).toHaveLength(1);
    expect(runtime.stats).toMatchObject({ ingested: 1, settled: 1 });

    const status = await fetch(`${server.url}/status`, { headers: auth() });
    const statusBody = await status.json() as any;
    expect(status.status).toBe(200);
    expect(statusBody.data.counts).toMatchObject({
      localRawChunks: 1,
      localTraces: 0,
      outbox: 0,
      ingested: 1,
      settled: 1,
    });
    expect(statusBody.data.lastError).toBeNull();
    expect(statusBody.data.degraded).toBe(false);
    expect(JSON.stringify(statusBody)).not.toContain('host-token');
    expect(JSON.stringify(statusBody)).not.toContain('cap-token');
  });

  it('capability 失败：/ingest 202，/status degraded + lastError + outbox', async () => {
    const { server, fake, runtime } = await setup();
    fake.setFailure({ status: 503, code: 'capability_unavailable', retryable: true });

    const response = await fetch(`${server.url}/ingest`, {
      method: 'POST',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify(ingestBody('idem_http_fail', '我的项目是 Mebular')),
    });
    const body = await response.json() as any;
    expect(response.status).toBe(202);
    expect(body.data).toMatchObject({ queued: true, degraded: true });
    expect(response.headers.get('x-mebular-degraded')).toBe('true');

    const status = await fetch(`${server.url}/status`, { headers: auth() });
    const statusBody = await status.json() as any;
    expect(statusBody.data).toMatchObject({ degraded: true });
    expect(statusBody.data.counts).toMatchObject({
      localRawChunks: 1,
      outbox: 1,
      ingested: 1,
      settled: 0,
      deadLetter: 0,
    });
    expect(statusBody.data.lastError).toMatchObject({ code: 'capability_unavailable' });
    expect(runtime.degraded).toBe(true);
  });

  it('GET /namespaces 合并 capability 域视图与本地策略，不泄漏 token', async () => {
    const { server } = await setup();
    await fetch(`${server.url}/ingest`, {
      method: 'POST',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify(ingestBody('idem_http_ns')),
    });
    await fetch(`${server.url}/ingest`, {
      method: 'POST',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({
        requestId: 'idem_http_ns_agent',
        agentId: 'opencode',
        extractor: 'host',
        candidates: [{ kind: 'observation', content: { content: '项目使用 pnpm workspace' } }],
      }),
    });

    const response = await fetch(`${server.url}/namespaces?agentId=opencode`, { headers: auth() });
    const body = await response.json() as any;
    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      agentId: 'opencode',
      capabilityAvailable: true,
      policy: {
        agentId: 'opencode',
        userWriteConfirmation: true,
      },
    });
    const user = body.data.domains.find((domain: any) => domain.domain === 'user');
    expect(user).toMatchObject({
      domain: 'user',
      readable: true,
      writable: true,
      crossAgent: false,
    });
    const agent = body.data.domains.find((domain: any) => domain.domain === 'agent:opencode');
    expect(agent).toMatchObject({ readable: true, writable: true, crossAgent: false });
    expect(JSON.stringify(body)).not.toContain('host-token');
    expect(JSON.stringify(body)).not.toContain('cap-token');
  });

  it('Idempotency-Key 头单独生效（body 不需要 requestId）', async () => {
    const { server, fake } = await setup();
    const body = { ...ingestBody('ignored'), requestId: undefined };
    const first = await fetch(`${server.url}/ingest`, {
      method: 'POST',
      headers: { ...auth(), 'content-type': 'application/json', 'idempotency-key': 'header_only_1' },
      body: JSON.stringify(body),
    });
    const firstBody = await first.json() as any;
    expect(first.status).toBe(200);
    expect(firstBody.data.duplicate).toBe(false);

    const second = await fetch(`${server.url}/ingest`, {
      method: 'POST',
      headers: { ...auth(), 'content-type': 'application/json', 'idempotency-key': 'header_only_1' },
      body: JSON.stringify(body),
    });
    const secondBody = await second.json() as any;
    expect(second.status).toBe(200);
    expect(secondBody.data.duplicate).toBe(true);
    expect(secondBody.data.records[0].id).toBe(firstBody.data.records[0].id);
    expect(fake.writeRequests).toHaveLength(1);
  });

  it('错误方法与错误请求体返回稳定错误码', async () => {
    const { server } = await setup();
    const method = await fetch(`${server.url}/ingest`, { headers: auth() });
    expect(method.status).toBe(405);
    expect((await method.json() as any).error.code).toBe('method_not_allowed');

    const bad = await fetch(`${server.url}/ingest`, {
      method: 'POST',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(bad.status).toBe(400);
    expect((await bad.json() as any).error.code).toBe('invalid_request');
  });
});
