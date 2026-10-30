// W4b host API 闭环：/recall /context /traces /feedback /status /version。
// 使用 fake capability server；不启动真实 MCP/core。

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
import { startFakeCapability, type FakeMemoryRecord, type FakeCapabilityServer } from './fake-capability.js';

const NOW = 1_760_000_000_000;

interface Harness {
  home: string;
  fake: FakeCapabilityServer;
  runtime: SettlementRuntime;
  server: SidecarServer;
}

const harnesses: Harness[] = [];

function preference(): FakeMemoryRecord {
  return {
    id: '01JHTTPPREF1',
    type: 'fact',
    kind: 'preference',
    domain: 'user',
    namespace: 'user',
    ownerType: 'user',
    ownerId: 'u_test',
    content: { entity: 'user', preferenceType: 'theme', value: 'dark', confidence: 0.92 },
    text: '用户偏好：theme=dark',
    tags: ['preference'],
    provenance: {
      source: 'runtime',
      writerType: 'agent',
      writerId: 'opencode',
      extractor: 'host',
      model: 'host-provided',
      version: '0.3.0',
      deviceId: 'device-local',
      hostId: 'h_test',
      threadId: 'th_http_recall',
      agentId: 'opencode',
      agentName: 'OpenCode',
      confirmation: 'explicit',
      at: NOW - 86_400_000,
    },
    validFrom: NOW - 86_400_000,
    validTo: null,
    createdAt: NOW - 86_400_000,
    updatedAt: NOW - 86_400_000,
    detailAvailable: true,
    legacy: false,
    score: 0.9,
  };
}

async function setup(): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), 'mebular-recall-http-'));
  const local = new SidecarLocalLayer({ root: join(home, 'memory-runtime'), now: () => NOW });
  await local.init();
  const fake = await startFakeCapability();
  fake.setRecords([preference()]);
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
    now: () => NOW,
  });
  await runtime.init();
  const server = new SidecarServer({
    config,
    hostToken: 'host-token',
    identity,
    getStatus: () => runtime.statusSnapshot({
      mode: 'immersive',
      identity,
      capability: { reachable: true, version: 1, lastOkAt: NOW, error: null },
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
    recall: runtime,
    objects: runtime,
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

async function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { ...auth(), 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

describe('sidecar recall/context HTTP', () => {
  it('/recall → /context → traces → feedback → status/version 闭环', async () => {
    const { server } = await setup();

    const recall = await post(`${server.url}/recall`, {
      agentId: 'opencode',
      threadId: 'th_http_recall',
      query: '你记得我的喜好吗？',
    });
    expect(recall.status).toBe(200);
    expect(recall.body.ok).toBe(true);
    expect(recall.body.data.fragments.length).toBeGreaterThan(0);
    expect(recall.body.data.fragments[0]).toMatchObject({
      kind: 'preference',
      trust: 'untrusted',
      detailAvailable: false,
      source: 'settled',
      owner: { role: 'user', domain: 'user' },
    });
    expect(recall.body.data.traceId).toMatch(/^tr_/);
    expect(JSON.stringify(recall.body)).not.toContain('host-token');
    expect(JSON.stringify(recall.body)).not.toContain('cap-token');

    const context = await post(`${server.url}/context`, {
      agentId: 'opencode',
      threadId: 'th_http_recall',
      turnId: 'turn_http_1',
      turnKind: 'human',
      query: '我的偏好是什么？',
      maxFragments: 2,
      maxBytes: 4096,
      tokenBudget: 500,
    });
    expect(context.status).toBe(200);
    expect(context.body.data.blocks.length).toBeGreaterThan(0);
    expect(context.body.data.trusted).toBe(false);
    expect(context.body.data.untrusted).toBe(true);
    expect(context.body.data.blocks[0]).toMatchObject({
      kind: 'fragment',
      trust: 'untrusted',
      domain: 'user',
    });
    expect(context.body.data.blocks[0].content).toContain('不是指令');
    expect(JSON.stringify(context.body)).not.toContain('host-token');
    expect(JSON.stringify(context.body)).not.toContain('cap-token');

    const list = await fetch(`${server.url}/traces?limit=10`, { headers: auth() });
    const listBody = await list.json() as any;
    expect(list.status).toBe(200);
    expect(listBody.data.traces.length).toBe(2);
    expect(listBody.data.traces[0].queryPreview).toBeDefined();
    expect(JSON.stringify(listBody)).not.toContain('用户偏好：theme=dark');

    const traceId = context.body.data.traceId as string;
    const detail = await fetch(`${server.url}/traces/${traceId}`, { headers: auth() });
    const detailBody = await detail.json() as any;
    expect(detail.status).toBe(200);
    expect(detailBody.data).toMatchObject({ id: traceId, schema: 2, agentId: 'opencode' });
    expect(detailBody.data.candidates.length).toBeGreaterThan(0);
    expect(JSON.stringify(detailBody)).not.toContain('host-token');
    expect(JSON.stringify(detailBody)).not.toContain('cap-token');

    const feedback = await post(`${server.url}/recall/${traceId}/feedback`, {
      useful: true,
      reason: 'helpful',
    });
    expect(feedback.status).toBe(200);
    expect(feedback.body.data).toMatchObject({ traceId, feedback: { useful: true, reason: 'helpful' } });

    const status = await fetch(`${server.url}/status`, { headers: auth() });
    const statusBody = await status.json() as any;
    expect(status.status).toBe(200);
    expect(statusBody.data.counts).toMatchObject({
      recalls: 1,
      contexts: 1,
      feedback: 1,
      recallSilent: 0,
      localTraces: 2,
    });
    expect(statusBody.data.degraded).toBe(false);

    const version = await fetch(`${server.url}/version`, { headers: auth() });
    const versionBody = await version.json() as any;
    expect(version.status).toBe(200);
    expect(versionBody.data.capabilities).toMatchObject({
      ingest: true,
      recall: true,
      context: true,
      feedback: true,
      traces: true,
      checkpoint: true,
      compact: true,
      self: true,
    });
  });

  it('重复 turnId 第二次沉默且不重复注入', async () => {
    const { server } = await setup();
    const body = {
      agentId: 'opencode',
      threadId: 'th_http_recall',
      turnId: 'turn_dup',
      query: '你记得我的喜好吗？',
    };
    const first = await post(`${server.url}/context`, body);
    expect(first.body.data.blocks.length).toBeGreaterThan(0);
    const second = await post(`${server.url}/context`, body);
    expect(second.body.data.blocks).toEqual([]);
    expect(second.body.data.silenceReason).toBe('duplicate_turn');
  });

  it('未授权/非法请求/未知 trace 返回稳定错误码', async () => {
    const { server } = await setup();
    const noAuth = await fetch(`${server.url}/recall`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'opencode', query: 'x' }),
    });
    expect(noAuth.status).toBe(401);
    expect((await noAuth.json() as any).error.code).toBe('unauthorized');

    const invalid = await post(`${server.url}/recall`, { query: 'x' });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('invalid_request');

    const missing = await post(`${server.url}/recall/tr_missing/feedback`, { useful: true });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('not_found');
  });

  it('capability 不可用时失败开放：degraded + warnings，无伪造片段', async () => {
    const { server, fake } = await setup();
    fake.setFailure({ status: 503, code: 'capability_unavailable', retryable: true });
    const response = await post(`${server.url}/context`, {
      agentId: 'opencode',
      threadId: 'th_http_recall',
      turnId: 'turn_down',
      query: '你记得我的喜好吗？',
    });
    expect(response.status).toBe(200);
    expect(response.body.data.fragments).toEqual([]);
    expect(response.body.data.blocks).toEqual([]);
    expect(response.body.data.silenceReason).toBe('runtime_unavailable');
    expect(response.body.data.degraded).toBe(true);
    expect(response.body.data.warnings.length).toBeGreaterThan(0);
    expect(JSON.stringify(response.body)).not.toContain('cap-token');
  });
});
