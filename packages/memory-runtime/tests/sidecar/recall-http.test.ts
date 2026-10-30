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
      details: true,
      checkpoint: true,
      compact: true,
      self: true,
    });
    expect(versionBody.data.details).toMatchObject({
      stagingHours: 24,
      cacheDays: 30,
      quotaBytesPerDomain: 268_435_456,
      quotaBytesCloud: 1_073_741_824,
    });
  });

  it('/recall/:recallId/expand 经 capability 读详情；删除/越权/未知 fragment 诚实降级', async () => {
    const { server, fake } = await setup();
    const text = '我当时原话：先冻结契约，再迁移 runtime。';
    fake.setRecords([{
      ...preference(),
      id: '01JHTTPQUOTE1',
      type: 'episode',
      kind: 'episode',
      content: { episodeType: 'conversation', title: '原话', content: text },
      text,
      provenance: {
        ...preference().provenance,
        detailIds: ['01JHTTPDETAIL1'],
      },
    }]);
    fake.details.push({
      id: '01JHTTPDETAIL1',
      detailKind: 'raw_chunk',
      domain: 'user',
      recordIds: ['01JHTTPQUOTE1'],
      role: 'user',
      text,
      messageId: 'm_http_detail',
      chunkIndex: 0,
      provenance: { source: 'runtime', deviceId: 'device-a', agentId: 'opencode' },
      createdAt: NOW - 60_000,
    });

    const recall = await post(`${server.url}/recall`, {
      agentId: 'opencode',
      threadId: 'th_http_recall',
      query: '我当时原话怎么说的？',
    });
    expect(recall.status).toBe(200);
    const fragment = recall.body.data.fragments[0];
    expect(fragment.detailIds).toEqual(['01JHTTPDETAIL1']);
    expect(fragment.detail?.format).toBe('verbatim');

    const expand = await post(`${server.url}/recall/${recall.body.data.recallId}/expand`, {
      agentId: 'opencode',
      threadId: 'th_http_recall',
      fragmentId: fragment.id,
    });
    expect(expand.status).toBe(200);
    expect(expand.body.data).toMatchObject({
      recallId: recall.body.data.recallId,
      fragmentId: fragment.id,
      degraded: false,
    });
    expect(expand.body.data.detail).toMatchObject({
      kind: 'detail_record',
      detailKind: 'raw_chunk',
      format: 'verbatim',
      text,
      availability: expect.arrayContaining(['available']),
      source: 'capability',
      stale: false,
    });
    expect(expand.body.data.detail.citations[0]).toMatchObject({
      id: '01JHTTPDETAIL1',
      type: 'detail_record',
      domain: 'user',
    });

    const admin = await fetch(`${server.url}/details/01JHTTPDETAIL1`, { headers: auth() });
    const adminBody = await admin.json() as any;
    expect(admin.status).toBe(200);
    expect(adminBody.data.detail).toMatchObject({ id: '01JHTTPDETAIL1', text });

    const denied = await post(`${server.url}/recall/${recall.body.data.recallId}/expand`, {
      agentId: 'hermes',
      threadId: 'th_http_recall',
      fragmentId: fragment.id,
    });
    expect(denied.status).toBe(403);

    const missing = await post(`${server.url}/recall/${recall.body.data.recallId}/expand`, {
      agentId: 'opencode',
      fragmentId: 'mf_missing',
    });
    expect(missing.status).toBe(404);

    fake.details[0]!.deletedAt = NOW - 1;
    const deleted = await post(`${server.url}/recall/${recall.body.data.recallId}/expand`, {
      agentId: 'opencode',
      threadId: 'th_http_recall',
      fragmentId: fragment.id,
    });
    expect(deleted.status).toBe(200);
    expect(deleted.body.data.detail).toBeNull();
    expect(deleted.body.data.degraded).toBe(true);
    expect(deleted.body.data.warnings).toEqual(expect.arrayContaining(['detail_deleted']));
    expect(JSON.stringify(deleted.body)).not.toContain(text);
  });

  it('/status 反映 staging/detail cache/outbox 与 detail 配额，不含 token', async () => {
    const { server, runtime } = await setup();
    await runtime.local.store.putStagingChunk('cl_test', {
      schema: 1,
      id: 'rc_status_0001',
      threadId: 'th_http_recall',
      agentId: 'opencode',
      hostId: 'h_test',
      role: 'user',
      text: 'staging only',
      mime: 'text/plain',
      at: NOW,
      contentHash: 'a'.repeat(64),
      redaction: { applied: false, rules: [] },
      expiresAt: NOW + 86_400_000,
    });
    await runtime.local.putCachedDetail('01STATUSDETAIL', { detail: { text: 'cached' } });
    const status = await fetch(`${server.url}/status`, { headers: auth() });
    const body = await status.json() as any;
    expect(status.status).toBe(200);
    expect(body.data.counts).toMatchObject({
      stagingChunks: 1,
      detailCacheEntries: 1,
    });
    expect(body.data.details).toMatchObject({
      available: true,
      staging: { chunks: 1, hours: 24, maxBytes: 268_435_456 },
      cache: { entries: 1, days: 30, maxBytes: 268_435_456 },
      quota: { bytesPerDomain: 268_435_456, bytesCloud: 1_073_741_824 },
      retentionDays: { conversation: 30, tool_output: 7, document_slice: 90 },
    });
    expect(JSON.stringify(body)).not.toContain('host-token');
    expect(JSON.stringify(body)).not.toContain('cap-token');
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

  it('/context 注入结构化 checkpoint：顺序、预算、summary_only 降级、过期沉默', async () => {
    const { server, fake } = await setup();
    fake.setRecords([]);
    const checkpoint = (overrides: Record<string, unknown> = {}) => ({
      id: '01JCHECKPOINT',
      domain: 'task:th_ckpt_ctx',
      agentId: 'opencode',
      threadId: 'th_ckpt_ctx',
      revision: 3,
      state: {
        schema: 2,
        contentMode: 'structured',
        task: { key: 'task:th_ckpt_ctx', threadId: 'th_ckpt_ctx', fleetTaskId: null },
        goal: '完成结构化 checkpoint 注入',
        constraints: [{ id: 'c1', text: '不新增公共工具' }],
        decisions: [{ id: 'd1', text: '复用图存储', reason: '不建第二套存储' }],
        progress: {
          done: [{ id: 'p1', text: '契约冻结' }],
          doing: [{ id: 'p2', text: 'sidecar 注入' }],
          blocked: [{ id: 'p3', text: '等待真实旅程', reason: '发布未闭环' }],
        },
        nextSteps: [{ id: 'n1', text: '跑 DSH 真实旅程' }],
        files: [{ path: 'packages/memory-runtime/src/sidecar/recall.ts', role: 'write' }],
        openQuestions: [{ id: 'q1', text: '预算如何分配？', blocking: true }],
        references: { recordIds: ['01JREF'], detailIds: [], messageIds: [], fleetTaskId: null, urls: [] },
      },
      summary: null,
      recordIds: ['01JREF'],
      lease: null,
      expiresAt: 0,
      ...overrides,
    });
    fake.checkpoints.push(checkpoint() as any);
    const context = await post(`${server.url}/context`, {
      agentId: 'opencode',
      threadId: 'th_ckpt_ctx',
      turnId: 'turn_ckpt_1',
      query: '继续上次任务',
    });
    expect(context.status).toBe(200);
    expect(context.body.data.blocks[0]).toMatchObject({
      kind: 'checkpoint',
      trust: 'untrusted',
      domain: 'task:th_ckpt_ctx',
      contentMode: 'structured',
    });
    expect(context.body.data.blocks[0].content).toContain('Goal:');
    expect(context.body.data.blocks[0].content).toContain('完成结构化 checkpoint 注入');
    expect(context.body.data.blocks[0].content).toContain('Next steps:');
    expect(context.body.data.blocks[0].content).toContain('跑 DSH 真实旅程');
    expect(context.body.data.blocks[0].content).toContain('Blocked:');
    expect(context.body.data.blocks[0].citations.map((entry: any) => entry.id)).toContain('01JREF');
    expect(context.body.data.degraded).toBe(false);

    fake.checkpoints[0]!.state.decisions = Array.from({ length: 50 }, (_, index) => ({
      id: `d${index}`,
      text: `decision ${index} ${'x'.repeat(120)}`,
    }));
    const budgeted = await post(`${server.url}/context`, {
      agentId: 'opencode',
      threadId: 'th_ckpt_ctx',
      turnId: 'turn_ckpt_budget',
      query: '继续上次任务',
      maxBytes: 520,
      maxTokens: 220,
    });
    expect(budgeted.status).toBe(200);
    expect(budgeted.body.data.blocks[0].bytes).toBeLessThanOrEqual(520);
    expect(budgeted.body.data.blocks[0].content).toContain('完成结构化 checkpoint 注入');
    expect(budgeted.body.data.blocks[0].content).toContain('跑 DSH 真实旅程');
    expect(budgeted.body.data.blocks[0].content).toContain('Blocked:');
    expect(budgeted.body.data.blocks[0].content).not.toContain('decision 49');

    fake.checkpoints[0]!.state.decisions = [];
    const noCheckpoint = await post(`${server.url}/context`, {
      agentId: 'opencode',
      threadId: 'th_ckpt_ctx',
      turnId: 'turn_ckpt_2',
      query: '继续上次任务',
      includeCheckpoint: false,
    });
    expect(noCheckpoint.body.data.blocks).toEqual([]);
    expect(noCheckpoint.body.data.silenceReason).toBe('no_hits');

    fake.checkpoints.length = 0;
    fake.checkpoints.push(checkpoint({
      id: '01JCHECKPOINT2',
      revision: 4,
      state: {
        schema: 2,
        contentMode: 'summary_only',
        task: { key: 'task:th_ckpt_ctx', threadId: 'th_ckpt_ctx', fleetTaskId: null },
        goal: null,
        constraints: [],
        decisions: [],
        progress: { done: [], doing: [], blocked: [] },
        nextSteps: [],
        files: [],
        openQuestions: [],
        references: { recordIds: [], detailIds: [], messageIds: [], fleetTaskId: null, urls: [] },
      },
      summary: '只有摘要，没有结构化任务状态',
      recordIds: [],
    }) as any);
    const summaryOnly = await post(`${server.url}/context`, {
      agentId: 'opencode',
      threadId: 'th_ckpt_ctx',
      turnId: 'turn_ckpt_3',
      query: '继续上次任务',
    });
    expect(summaryOnly.body.data.blocks[0]).toMatchObject({
      kind: 'checkpoint',
      degraded: true,
      reason: 'checkpoint_summary_only',
      contentMode: 'summary_only',
    });
    expect(summaryOnly.body.data.blocks[0].content).toContain('只有摘要');
    expect(summaryOnly.body.data.degraded).toBe(true);
    expect(summaryOnly.body.data.warnings).toContain('checkpoint_summary_only');

    const expiredCheckpoint = fake.checkpoints[0];
    if (!expiredCheckpoint) throw new Error('missing checkpoint');
    expiredCheckpoint.expiresAt = NOW - 1;
    const expired = await post(`${server.url}/context`, {
      agentId: 'opencode',
      threadId: 'th_ckpt_ctx',
      turnId: 'turn_ckpt_4',
      query: '继续上次任务',
    });
    expect(expired.body.data.blocks).toEqual([]);
    expect(expired.body.data.silenceReason).toBe('no_hits');

    fake.checkpoints[0]!.expiresAt = 0;
    fake.checkpoints[0]!.summary = null;
    const noSummary = await post(`${server.url}/context`, {
      agentId: 'opencode',
      threadId: 'th_ckpt_ctx',
      turnId: 'turn_ckpt_5',
      query: '继续上次任务',
    });
    expect(noSummary.body.data.blocks).toEqual([]);
    expect(noSummary.body.data.degraded).toBe(true);
    expect(noSummary.body.data.warnings).toContain('summary_unavailable');
  });
});
