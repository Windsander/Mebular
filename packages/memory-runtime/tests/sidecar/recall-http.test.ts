// W4b host API 闭环：/recall /context /traces /feedback /status /version。
// 使用 fake capability server；不启动真实 MCP/core。

import { describe, it, expect, afterEach } from '@jest/globals';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

function interventionCheckpoint(threadId: string, domain: string, goal: string) {
  return {
    id: '01JINPUTDEFERCKPT',
    domain,
    agentId: 'opencode',
    threadId,
    revision: 1,
    state: {
      schema: 2,
      contentMode: 'structured',
      task: { key: domain, threadId, fleetTaskId: null },
      goal,
      constraints: [],
      decisions: [],
      progress: { done: [], doing: [], blocked: [] },
      nextSteps: [{ id: 'n1', text: 'continue' }],
      files: [],
      openQuestions: [],
      references: { recordIds: [], detailIds: [], messageIds: [], fleetTaskId: null, urls: [] },
    },
    summary: null,
    recordIds: [],
    lease: null,
    expiresAt: 0,
  };
}

async function setup(options: {
  intervention?: Partial<ReturnType<typeof defaultSidecarConfig>['intervention']>;
  modelSource?: ReturnType<typeof defaultSidecarConfig>['model']['source'];
  /** 模拟旧用户配置缺少 model.source；缺省按测试显式 source 处理。 */
  sourceMissing?: boolean;
  trace?: 'off' | 'local';
  now?: () => number;
  withPolicy?: boolean;
  interventionApi?: boolean;
  /** 在 runtime.init 前把 policy 目录位置占成文件，模拟 PolicyStore init 失败。 */
  policyBlocker?: boolean;
} = {}): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), 'mebular-recall-http-'));
  const now = options.now ?? (() => NOW);
  const local = new SidecarLocalLayer({ root: join(home, 'memory-runtime'), now });
  await local.init();
  if (options.policyBlocker) {
    await writeFile(join(home, 'memory-runtime', 'policy'), 'blocker', { mode: 0o600 });
  }
  const fake = await startFakeCapability({ now });
  fake.setRecords([preference()]);
  const client = new CapabilityClient({ baseUrl: fake.baseUrl, token: 'cap-token', retries: 0, retryDelayMs: 0 });
  const identity = { cloudId: 'cl_test', profileId: 'default', hostId: 'h_test' };
  const config = defaultSidecarConfig();
  config.http.port = 0;
  if (options.trace) config.trace = options.trace;
  config.model.sourcePresent = options.sourceMissing !== true;
  if (options.modelSource) config.model.source = options.modelSource;
  if (options.intervention) {
    config.intervention = { ...config.intervention, ...options.intervention };
    // 真实文件里显式写 mode 会由 normalize 置 true；测试注入时按同样语义处理。
    if (Object.prototype.hasOwnProperty.call(options.intervention, 'mode')) {
      config.intervention.legacyModePresent = true;
    }
  }
  const runtime = new SettlementRuntime({
    config,
    local,
    client,
    identity,
    policy: defaultSidecarPolicy(),
    ...(options.withPolicy === false ? {} : { policyStatePath: join(home, 'memory-runtime', 'policy', 'state.json') }),
    autoStartReplayer: false,
    now,
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
    ...(options.interventionApi === false ? {} : { intervention: runtime }),
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
      query: '你记得我的偏好吗？',
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

  it('/recall/:recallId/expand 优先 user raw chunk，不混入 assistant raw chunk', async () => {
    const { server, fake } = await setup();
    const userText = '我原话：以后默认用深色主题。';
    const assistantText = 'FAKE_ASSISTANT_REPLY\n\n以后默认用深色主题，记住。';
    fake.setRecords([{
      ...preference(),
      id: '01JROLEQUOTE1',
      type: 'episode',
      kind: 'episode',
      content: { episodeType: 'conversation', title: '原话', content: userText },
      text: userText,
      provenance: {
        ...preference().provenance,
        detailIds: ['01JROLEASSIST1', '01JROLEUSER01'],
      },
    }]);
    fake.details.push({
      id: '01JROLEASSIST1',
      detailKind: 'raw_chunk',
      domain: 'user',
      recordIds: ['01JROLEQUOTE1'],
      role: 'assistant',
      text: assistantText,
      messageId: 'm_assistant_detail',
      chunkIndex: 0,
      provenance: { source: 'runtime', deviceId: 'device-a', agentId: 'dsh' },
      createdAt: NOW - 60_000,
    }, {
      id: '01JROLEUSER01',
      detailKind: 'raw_chunk',
      domain: 'user',
      recordIds: ['01JROLEQUOTE1'],
      role: 'user',
      text: userText,
      messageId: 'm_user_detail',
      chunkIndex: 1,
      provenance: { source: 'runtime', deviceId: 'device-a', agentId: 'dsh' },
      createdAt: NOW - 59_000,
    });

    const recall = await post(`${server.url}/recall`, {
      agentId: 'opencode',
      threadId: 'th_http_recall',
      query: '我原话怎么说的？',
    });
    expect(recall.status).toBe(200);
    const fragment = recall.body.data.fragments[0];
    expect(fragment.detailIds).toEqual(['01JROLEASSIST1', '01JROLEUSER01']);

    const expand = await post(`${server.url}/recall/${recall.body.data.recallId}/expand`, {
      agentId: 'opencode',
      threadId: 'th_http_recall',
      fragmentId: fragment.id,
    });
    expect(expand.status).toBe(200);
    expect(expand.body.data.detail).toMatchObject({
      text: userText,
      format: 'verbatim',
      availability: expect.arrayContaining(['available']),
      owner: { role: 'user', domain: 'user' },
      provenance: { source: 'runtime', threadId: 'th_http_recall' },
      source: 'capability',
      stale: false,
    });
    expect(expand.body.data.detail.text).not.toContain('FAKE_ASSISTANT_REPLY');
    expect(expand.body.data.detail.citations).toEqual([{
      id: '01JROLEUSER01',
      type: 'detail_record',
      domain: 'user',
    }]);
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
      query: '看看当前进度',
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
      query: '看看当前进度',
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
      query: '看看当前进度',
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
      query: '看看当前进度',
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
      query: '看看当前进度',
    });
    expect(expired.body.data.blocks).toEqual([]);
    expect(expired.body.data.silenceReason).toBe('no_hits');

    fake.checkpoints[0]!.expiresAt = 0;
    fake.checkpoints[0]!.summary = null;
    const noSummary = await post(`${server.url}/context`, {
      agentId: 'opencode',
      threadId: 'th_ckpt_ctx',
      turnId: 'turn_ckpt_5',
      query: '看看当前进度',
    });
    expect(noSummary.body.data.blocks).toEqual([]);
    expect(noSummary.body.data.degraded).toBe(true);
    expect(noSummary.body.data.warnings).toContain('summary_unavailable');
  });

  it('/context includeSelf：顺序、关闭、合法缺失、capability 不可用时不注入 cache', async () => {
    const { server, fake } = await setup();
    fake.selfRecords.push({
      id: '01JSELFHTTP',
      domain: 'agent:opencode',
      agentId: 'opencode',
      revision: 1,
      content: { displayName: 'OpenCode HTTP', goals: ['stabilize context'] },
      createdAt: NOW - 1000,
      updatedAt: NOW - 1000,
    } as any);
    fake.checkpoints.push({
      id: '01JCKPTHTTP',
      domain: 'task:th_http_self',
      agentId: 'opencode',
      threadId: 'th_http_self',
      revision: 1,
      state: {
        schema: 2,
        contentMode: 'structured',
        task: { key: 'task:th_http_self', threadId: 'th_http_self', fleetTaskId: null },
        goal: 'HTTP self order',
        constraints: [],
        decisions: [],
        progress: { done: [], doing: [], blocked: [] },
        nextSteps: [{ id: 'n1', text: 'verify order' }],
        files: [],
        openQuestions: [],
        references: { recordIds: [], detailIds: [], messageIds: [], fleetTaskId: null, urls: [] },
      },
      summary: null,
      recordIds: [],
      lease: null,
      expiresAt: 0,
      createdAt: NOW - 500,
      updatedAt: NOW - 500,
    } as any);

    const included = await post(`${server.url}/context`, {
      agentId: 'opencode',
      threadId: 'th_http_self',
      turnId: 'turn_http_self_1',
      query: '你记得我的偏好吗？',
      includeSelf: true,
      includeCheckpoint: true,
    });
    expect(included.status).toBe(200);
    expect(included.body.data.blocks.map((block: any) => block.kind)).toEqual(['self', 'checkpoint', 'fragment']);
    expect(included.body.data.blocks[0].content).toContain('OpenCode HTTP');
    expect(included.body.data.blocks[0].provenance).toBeTruthy();

    const excluded = await post(`${server.url}/context`, {
      agentId: 'opencode',
      threadId: 'th_http_self',
      turnId: 'turn_http_self_2',
      query: '你记得我的偏好吗？',
      includeSelf: false,
      includeCheckpoint: true,
    });
    expect(excluded.body.data.blocks.map((block: any) => block.kind)).toEqual(['checkpoint', 'fragment']);

    fake.setFailure({ status: 503, code: 'capability_unavailable', retryable: true });
    const offline = await post(`${server.url}/context`, {
      agentId: 'opencode',
      threadId: 'th_http_self',
      turnId: 'turn_http_self_3',
      query: '我的偏好是什么？',
      includeSelf: true,
      includeCheckpoint: true,
    });
    expect(offline.status).toBe(200);
    expect(offline.body.data.blocks).toEqual([]);
    expect(offline.body.data.degraded).toBe(true);
    expect(offline.body.data.warnings).toEqual(expect.arrayContaining([
      'self_stale',
      'checkpoint_stale',
    ]));
    fake.setFailure(null);
  });

  it('/context includeSelf：SelfRecord 不存在时非 degraded 空且无 self 块', async () => {
    // 该用例只验证 self 缺失，不验证介入策略；用 baseline 避免 must_speak 降级噪声。
    const { server, fake } = await setup({ sourceMissing: true });
    fake.selfRecords.length = 0;
    const context = await post(`${server.url}/context`, {
      agentId: 'opencode',
      threadId: 'th_http_self_absent',
      turnId: 'turn_http_self_absent',
      query: '我的偏好是什么？',
      includeSelf: true,
    });
    expect(context.status).toBe(200);
    expect(context.body.data.blocks.some((block: any) => block.kind === 'self')).toBe(false);
    expect(context.body.data.degraded).toBe(false);
    expect(context.body.data.warnings).not.toContain('self_unavailable');
  });

  it('/context CJK 预算按 UTF-8 字节：self/checkpoint 不超 maxBytes', async () => {
    const { server, fake } = await setup();
    fake.selfRecords.push({
      id: '01JSELFCJK',
      domain: 'agent:opencode',
      agentId: 'opencode',
      revision: 1,
      content: {
        displayName: '中文'.repeat(400),
        goals: ['稳定性'.repeat(300)],
        boundaries: ['边界'.repeat(200)],
      },
      createdAt: NOW - 1000,
      updatedAt: NOW - 1000,
    } as any);
    fake.checkpoints.push({
      id: '01JCKPTCJK',
      domain: 'task:th_http_cjk',
      agentId: 'opencode',
      threadId: 'th_http_cjk',
      revision: 1,
      state: {
        schema: 2,
        contentMode: 'structured',
        task: { key: 'task:th_http_cjk', threadId: 'th_http_cjk', fleetTaskId: null },
        goal: '检查点目标'.repeat(500),
        constraints: [],
        decisions: [],
        progress: { done: [], doing: [], blocked: [] },
        nextSteps: [{ id: 'n1', text: '下一步'.repeat(300) }],
        files: [],
        openQuestions: [],
        references: { recordIds: [], detailIds: [], messageIds: [], fleetTaskId: null, urls: [] },
      },
      summary: null,
      recordIds: [],
      lease: null,
      expiresAt: 0,
      createdAt: NOW - 500,
      updatedAt: NOW - 500,
    } as any);

    const context = await post(`${server.url}/context`, {
      agentId: 'opencode',
      threadId: 'th_http_cjk',
      turnId: 'turn_http_cjk',
      query: '我的偏好是什么？',
      includeSelf: true,
      includeCheckpoint: true,
      maxBytes: 2400,
      tokenBudget: 1200,
    });
    expect(context.status).toBe(200);
    expect(context.body.data.blocks[0].kind).toBe('self');
    expect(context.body.data.blocks[1].kind).toBe('checkpoint');
    for (const block of context.body.data.blocks) {
      expect(Buffer.byteLength(block.content, 'utf8')).toBeLessThanOrEqual(2400);
      expect(block.bytes).toBe(Buffer.byteLength(block.content, 'utf8'));
    }
    expect(context.body.data.estimatedBytes).toBeLessThanOrEqual(2400);
    expect(context.body.data.estimatedTokens).toBeLessThanOrEqual(1200);
  });

  it('旧 intervention.mode=off 被忽略：production 由 model.source=heuristic 派生', async () => {
    const { server, runtime } = await setup({
      modelSource: 'heuristic',
      intervention: { mode: 'off', minConfidence: 0.5, explorationRate: 0, maxSilentStreak: 99 },
    });
    const context = await post(`${server.url}/context`, {
      agentId: 'opencode',
      threadId: 'th_off',
      turnId: 'turn_off_1',
      query: '今天天气怎么样',
    });
    expect(context.status).toBe(200);
    expect(context.body.data.fragments.length).toBeGreaterThan(0);
    expect(context.body.data.decision.policyVersion).toMatch(/^heuristic:/);
    expect(context.body.data.decision.enforced).toBe(true);
    expect(context.body.data.applied.wouldAction).toBeUndefined();
    const stats = await runtime.policyStore!.snapshot();
    expect(stats.global.spoken).toBe(1);
    const trace = await fetch(`${server.url}/traces/${context.body.data.traceId}`, { headers: auth() });
    const traceBody = await trace.json() as any;
    expect(traceBody.data.decision.policyVersion).toMatch(/^heuristic:/);
    expect(traceBody.data.applied.wouldAction).toBeUndefined();

    const version = await fetch(`${server.url}/version`, { headers: auth() });
    const versionBody = await version.json() as any;
    expect(versionBody.data.capabilities.intervention).toMatchObject({
      mode: 'heuristic',
      configuredSource: 'heuristic',
      sourcePresent: true,
      legacyModeIgnored: true,
      warnings: ['legacy_intervention_mode_ignored'],
    });
  });

  it('enabled=true + model.source 缺失：保持 0.3 baseline，不静默 heuristic', async () => {
    const { server } = await setup({
      sourceMissing: true,
      intervention: { minConfidence: 0.95, explorationRate: 0, maxSilentStreak: 99 },
    });
    const context = await post(`${server.url}/context`, {
      agentId: 'opencode',
      threadId: 'th_source_missing',
      turnId: 'turn_source_missing_1',
      query: '今天天气怎么样',
    });
    expect(context.status).toBe(200);
    // baseline 会注入，但 decision 不是 heuristic。
    expect(context.body.data.fragments.length).toBeGreaterThan(0);
    expect(context.body.data.decision).toMatchObject({
      policyVersion: 'v0-baseline',
      enforced: false,
    });
    expect(context.body.data.applied.wouldAction).toBeUndefined();
    const status = await fetch(`${server.url}/status`, { headers: auth() });
    const statusBody = await status.json() as any;
    expect(statusBody.data.intervention).toMatchObject({
      mode: 'off',
      planner: 'off',
      sourcePresent: false,
      legacyModeIgnored: false,
    });
    expect(statusBody.data.intervention.warnings).toContain('model_source_missing');
  });

  it('旧 mode=shadow 不启用 shadow；只有内部 diagnosticShadow 才生效', async () => {
    const legacy = await setup({
      modelSource: 'heuristic',
      intervention: { mode: 'shadow', minConfidence: 0.5, explorationRate: 0, maxSilentStreak: 99 },
    });
    const legacyContext = await post(`${legacy.server.url}/context`, {
      agentId: 'opencode',
      threadId: 'th_shadow_legacy',
      turnId: 'turn_shadow_legacy_1',
      query: '你记得我的喜好吗？',
    });
    expect(legacyContext.status).toBe(200);
    expect(legacyContext.body.data.decision.enforced).toBe(true);
    expect(legacyContext.body.data.applied.wouldAction).toBeUndefined();
    const version = await fetch(`${legacy.server.url}/version`, { headers: auth() });
    const versionBody = await version.json() as any;
    expect(versionBody.data.capabilities.intervention).toMatchObject({
      mode: 'heuristic',
      configuredSource: 'heuristic',
      planner: 'heuristic',
      legacyModeIgnored: true,
      diagnosticShadow: false,
    });
    expect(versionBody.data.capabilities.intervention.warnings)
      .toContain('legacy_intervention_mode_ignored');
  });

  it('diagnostic shadow 只记录建议：applied 记录 wouldAction/wouldDepth', async () => {
    const shadow = await setup({
      modelSource: 'heuristic',
      intervention: { diagnosticShadow: true, explorationRate: 0, maxSilentStreak: 99 },
    });
    const shadowContext = await post(`${shadow.server.url}/context`, {
      agentId: 'opencode',
      threadId: 'th_shadow',
      turnId: 'turn_shadow_1',
      query: '你记得我的喜好吗？',
    });
    expect(shadowContext.status).toBe(200);
    expect(shadowContext.body.data.decision.policyVersion).toMatch(/^(v0-rules|heuristic:)/);
    expect(shadowContext.body.data.decision.enforced).toBe(false);
    const trace = await fetch(`${shadow.server.url}/traces/${shadowContext.body.data.traceId}`, { headers: auth() });
    const traceBody = await trace.json() as any;
    expect(traceBody.data.applied).toMatchObject({
      wouldAction: shadowContext.body.data.decision.action,
      wouldDepth: shadowContext.body.data.decision.depth,
    });
    const version = await fetch(`${shadow.server.url}/version`, { headers: auth() });
    const versionBody = await version.json() as any;
    expect(versionBody.data.capabilities.intervention).toMatchObject({
      mode: 'shadow',
      diagnosticShadow: true,
    });
  });

  it('off（model.source 缺失）+ user_negated：输入级 defer，不注入 memory，checkpoint 保留，无策略警告', async () => {
    const { server, fake } = await setup({ sourceMissing: true, intervention: { minConfidence: 0.55 } });
    fake.setRecords([preference()]);
    fake.checkpoints.push(interventionCheckpoint(
      'th_off_negated',
      'task:th_off_negated',
      'OFF-NEGATED-CHECKPOINT',
    ) as any);
    const context = await post(`${server.url}/context`, {
      agentId: 'opencode',
      threadId: 'th_off_negated',
      turnId: 'turn_off_negated',
      query: '别用记忆回答我的偏好',
    });
    expect(context.status).toBe(200);
    expect(context.body.data.decision).toMatchObject({
      action: 'defer',
      depth: 'gist',
      reason: 'defer_explicit',
      policyVersion: 'v0-baseline',
      enforced: false,
    });
    expect(context.body.data.fragments).toEqual([]);
    expect(context.body.data.blocks.map((block: any) => block.kind)).toEqual(['checkpoint']);
    expect(context.body.data.blocks[0].content).toContain('OFF-NEGATED-CHECKPOINT');
    expect(context.body.data.warnings).not.toContain('intervention_defer');
    expect(context.body.data.applied).toMatchObject({
      action: 'defer',
      depth: 'gist',
      fragments: 0,
    });

    const trace = await fetch(`${server.url}/traces/${context.body.data.traceId}`, { headers: auth() });
    const traceBody = await trace.json() as any;
    expect(traceBody.data.decision).toMatchObject({
      action: 'defer',
      reason: 'defer_explicit',
      policyVersion: 'v0-baseline',
      enforced: false,
    });
    expect(traceBody.data.applied).toMatchObject({ action: 'defer', depth: 'gist', fragments: 0 });
    expect(traceBody.data.applied.wouldAction).toBeUndefined();
  });

  it('shadow + user_negated：实际注入 defer，不走 baseline，不记录 wouldAction', async () => {
    const { server, fake } = await setup({ intervention: { diagnosticShadow: true } });
    fake.setRecords([preference()]);
    fake.checkpoints.push(interventionCheckpoint(
      'th_shadow_negated',
      'task:th_shadow_negated',
      'SHADOW-NEGATED-CHECKPOINT',
    ) as any);
    const context = await post(`${server.url}/context`, {
      agentId: 'opencode',
      threadId: 'th_shadow_negated',
      turnId: 'turn_shadow_negated',
      query: '别用记忆回答我的偏好',
    });
    expect(context.status).toBe(200);
    expect(context.body.data.decision).toMatchObject({
      action: 'defer',
      depth: 'gist',
      reason: 'defer_explicit',
      policyVersion: 'v0-rules',
      enforced: false,
    });
    expect(context.body.data.fragments).toEqual([]);
    expect(context.body.data.blocks.map((block: any) => block.kind)).toEqual(['checkpoint']);
    expect(context.body.data.blocks[0].content).toContain('SHADOW-NEGATED-CHECKPOINT');
    expect(context.body.data.warnings).toContain('intervention_defer');
    expect(context.body.data.applied).toMatchObject({
      action: 'defer',
      depth: 'gist',
      fragments: 0,
    });
    // 输入级 defer 不是策略建议：shadow 不记录 baseline wouldAction，避免自相矛盾。
    expect(context.body.data.applied.wouldAction).toBeUndefined();

    const trace = await fetch(`${server.url}/traces/${context.body.data.traceId}`, { headers: auth() });
    const traceBody = await trace.json() as any;
    expect(traceBody.data.decision).toMatchObject({
      action: 'defer',
      reason: 'defer_explicit',
      enforced: false,
    });
    expect(traceBody.data.applied).toMatchObject({ action: 'defer', depth: 'gist', fragments: 0 });
    expect(traceBody.data.applied.wouldAction).toBeUndefined();
  });

  it('explicit heuristic + user_negated：输入级 defer 优先，规则决策但不注入 memory', async () => {
    const { server, fake } = await setup({
      modelSource: 'heuristic',
      intervention: { explorationRate: 0, maxSilentStreak: 99 },
    });
    fake.setRecords([preference()]);
    fake.checkpoints.push(interventionCheckpoint(
      'th_heuristic_negated',
      'task:th_heuristic_negated',
      'HEURISTIC-NEGATED-CHECKPOINT',
    ) as any);
    const context = await post(`${server.url}/context`, {
      agentId: 'opencode',
      threadId: 'th_heuristic_negated',
      turnId: 'turn_heuristic_negated',
      query: '别用记忆回答我的偏好',
    });
    expect(context.status).toBe(200);
    expect(context.body.data.decision).toMatchObject({
      action: 'defer',
      depth: 'gist',
      reason: 'defer_explicit',
      policyVersion: 'v0-rules',
      enforced: true,
    });
    expect(context.body.data.fragments).toEqual([]);
    expect(context.body.data.blocks.map((block: any) => block.kind)).toEqual(['checkpoint']);
    expect(context.body.data.blocks[0].content).toContain('HEURISTIC-NEGATED-CHECKPOINT');
    expect(context.body.data.warnings).toContain('intervention_defer');
    expect(context.body.data.applied).toMatchObject({
      action: 'defer',
      depth: 'gist',
      fragments: 0,
    });
    expect(context.body.data.applied.wouldAction).toBeUndefined();
  });

  it('shadow 的策略计数用 applied baseline：decision silent / applied speak 记 spoken 而不是 silent', async () => {
    const { server, runtime } = await setup({
      modelSource: 'heuristic',
      intervention: { diagnosticShadow: true, minConfidence: 0.95, explorationRate: 0, maxSilentStreak: 99 },
    });
    const context = await post(`${server.url}/context`, {
      agentId: 'opencode',
      threadId: 'th_shadow_applied',
      turnId: 'turn_shadow_applied',
      query: '今天天气怎么样',
    });
    expect(context.status).toBe(200);
    expect(context.body.data.decision).toMatchObject({ action: 'silent', enforced: false });
    expect(context.body.data.applied).toMatchObject({ action: 'speak', wouldAction: 'silent' });
    expect(context.body.data.fragments.length).toBeGreaterThan(0);
    const stats = await runtime.policyStore!.snapshot();
    expect(stats.global.spoken).toBe(1);
    expect(stats.global.silent).toBe(0);
    const trace = await fetch(`${server.url}/traces/${context.body.data.traceId}`, { headers: auth() });
    const traceBody = await trace.json() as any;
    expect(traceBody.data.applied).toMatchObject({ action: 'speak', wouldAction: 'silent' });
  });

  it('heuristic silent/defer：跳过 memory fragments，self/checkpoint 仍按原顺序注入；user_negated=defer', async () => {
    const { server, fake } = await setup({
      intervention: { mode: 'heuristic', minConfidence: 0.95, explorationRate: 0, maxSilentStreak: 99 },
    });
    fake.setRecords([preference()]);
    fake.checkpoints.push({
      id: '01JCKPTINT',
      domain: 'task:th_intervention',
      agentId: 'opencode',
      threadId: 'th_intervention',
      revision: 1,
      state: {
        schema: 2,
        contentMode: 'structured',
        task: { key: 'task:th_intervention', threadId: 'th_intervention', fleetTaskId: null },
        goal: '保持 self/checkpoint 注入',
        constraints: [],
        decisions: [],
        progress: { done: [], doing: [], blocked: [] },
        nextSteps: [{ id: 'n1', text: 'continue' }],
        files: [],
        openQuestions: [],
        references: { recordIds: [], detailIds: [], messageIds: [], fleetTaskId: null, urls: [] },
      },
      summary: null,
      recordIds: [],
      lease: null,
      expiresAt: 0,
    } as any);

    const context = await post(`${server.url}/context`, {
      agentId: 'opencode',
      threadId: 'th_intervention',
      turnId: 'turn_intervention_silent',
      query: '今天天气怎么样',
    });
    expect(context.status).toBe(200);
    expect(context.body.data.decision).toMatchObject({ action: 'silent', enforced: true });
    expect(context.body.data.fragments).toEqual([]);
    expect(context.body.data.blocks.map((block: any) => block.kind)).toEqual(['checkpoint']);
    expect(context.body.data.blocks[0].content).toContain('保持 self/checkpoint 注入');
    expect(context.body.data.warnings).toContain('intervention_silent');
    const trace = await fetch(`${server.url}/traces/${context.body.data.traceId}`, { headers: auth() });
    const traceBody = await trace.json() as any;
    expect(traceBody.data.applied).toMatchObject({ action: 'silent', fragments: 0 });
    expect(traceBody.data.applied.suppressed.length).toBeGreaterThan(0);

    // 显式 defer：decision 与 applied 都必须是 defer，而不是 silent；
    // checkpoint 仍按原路径注入，后续归因才能区分「主动推迟」与「策略沉默」。
    const deferred = await post(`${server.url}/context`, {
      agentId: 'opencode',
      threadId: 'th_intervention',
      turnId: 'turn_intervention_defer',
      query: '这个先放一放，我们晚点再聊记忆。',
    });
    expect(deferred.status).toBe(200);
    expect(deferred.body.data.decision).toMatchObject({
      action: 'defer',
      depth: 'gist',
      reason: 'defer_explicit',
      enforced: true,
    });
    expect(deferred.body.data.fragments).toEqual([]);
    expect(deferred.body.data.blocks.map((block: any) => block.kind)).toEqual(['checkpoint']);
    expect(deferred.body.data.warnings).toContain('intervention_defer');
    const deferTrace = await fetch(`${server.url}/traces/${deferred.body.data.traceId}`, { headers: auth() });
    const deferTraceBody = await deferTrace.json() as any;
    expect(deferTraceBody.data.applied).toMatchObject({ action: 'defer', depth: 'gist', fragments: 0 });

    // user_negated 也是显式 defer：不注入 memory fragments，但 checkpoint 仍加载；
    // decision/applied 都必须是 defer，而不是 recall 层的 user_negated silent。
    const negated = await post(`${server.url}/context`, {
      agentId: 'opencode',
      threadId: 'th_intervention',
      turnId: 'turn_intervention_negated',
      query: '别用记忆回答我的偏好',
    });
    expect(negated.status).toBe(200);
    expect(negated.body.data.decision).toMatchObject({
      action: 'defer',
      depth: 'gist',
      reason: 'defer_explicit',
    });
    expect(negated.body.data.fragments).toEqual([]);
    expect(negated.body.data.blocks.map((block: any) => block.kind)).toEqual(['checkpoint']);
    expect(negated.body.data.blocks[0].content).toContain('保持 self/checkpoint 注入');
    expect(negated.body.data.warnings).toContain('intervention_defer');
    const negatedTrace = await fetch(`${server.url}/traces/${negated.body.data.traceId}`, { headers: auth() });
    const negatedTraceBody = await negatedTrace.json() as any;
    expect(negatedTraceBody.data.decision).toMatchObject({
      action: 'defer',
      reason: 'defer_explicit',
    });
    expect(negatedTraceBody.data.applied).toMatchObject({ action: 'defer', fragments: 0 });

    // 没有 self/checkpoint 时，沉默原因必须保留策略原因而不是 budget_too_small。
    const bare = await post(`${server.url}/context`, {
      agentId: 'opencode',
      threadId: 'th_intervention_bare',
      turnId: 'turn_intervention_bare',
      query: '今天天气怎么样',
    });
    expect(bare.body.data.blocks).toEqual([]);
    expect(bare.body.data.silenceReason).toBe('intervention_silent');
  });

  it('novelty：top-1 已注入时选择 top-2 新鲜候选，trace scores/reason 一致', async () => {
    const { server, fake } = await setup({
      intervention: { mode: 'heuristic', minConfidence: 0.55, explorationRate: 0, maxSilentStreak: 99 },
    });
    const top = preference();
    const fresh = {
      ...preference(),
      id: '01JHTTPPREF2',
      content: { entity: 'user', preferenceType: 'theme', value: 'light', confidence: 0.82 },
      text: '用户偏好：theme=light',
      score: 0.8,
    };
    fake.setRecords([top, fresh]);

    const context = await post(`${server.url}/context`, {
      agentId: 'opencode',
      threadId: 'th_novelty',
      turnId: 'turn_novelty_fresh',
      query: '深色主题',
      alreadyInjectedIds: ['01JHTTPPREF1'],
    });
    expect(context.status).toBe(200);
    const fragment = context.body.data.fragments[0];
    expect(fragment.sourceIds).toContain('01JHTTPPREF2');
    expect(context.body.data.decision).toMatchObject({
      action: 'speak',
      reason: 'high_relevance',
      scores: { novelty: 1 },
    });
    expect(context.body.data.decision.scores.top).toBeCloseTo(fragment.score.final, 3);
    expect(context.body.data.fragments).toHaveLength(1);

    const trace = await fetch(`${server.url}/traces/${context.body.data.traceId}`, { headers: auth() });
    const traceBody = await trace.json() as any;
    expect(traceBody.data.decision).toMatchObject({
      action: 'speak',
      reason: 'high_relevance',
      scores: { novelty: 1 },
    });
    expect(traceBody.data.decision.scores.top).toBe(context.body.data.decision.scores.top);
    expect(traceBody.data.applied).toMatchObject({ action: 'speak', fragments: 1 });
  });

  it('must_speak 不能被低阈值/高负例率否决；gist 不生详情', async () => {
    const { server, runtime } = await setup({
      intervention: { mode: 'heuristic', minConfidence: 0.95, explorationRate: 0, maxSilentStreak: 1 },
    });
    // 制造很高的 recentUselessRate，普通策略一定会沉默。
    for (let index = 0; index < 20; index += 1) {
      await runtime.policyStore!.recordDecision({ agentId: 'opencode', domain: 'user', action: 'speak' });
      await runtime.policyStore!.recordOutcome({ agentId: 'opencode', domain: 'user', kind: 'dismissed' });
    }
    const context = await post(`${server.url}/context`, {
      agentId: 'opencode',
      threadId: 'th_must_speak',
      turnId: 'turn_must_speak',
      query: '你还记得我的喜好吗？',
    });
    expect(context.status).toBe(200);
    expect(context.body.data.decision).toMatchObject({
      action: 'speak',
      depth: 'gist',
      mustSpeak: true,
      enforced: true,
    });
    expect(context.body.data.decision.reason).toMatch(/^must_speak:/);
    expect(context.body.data.fragments.length).toBeGreaterThan(0);
    expect(context.body.data.fragments[0].detail).toBeUndefined();
  });

  it('heuristic detail/quote：why 展开 detail，原话请求展开 quote', async () => {
    const detailHarness = await setup({ intervention: { mode: 'heuristic', explorationRate: 0 } });
    const detailText = '深色主题更省电，也更适合夜间使用。';
    detailHarness.fake.setRecords([{
      ...preference(),
      id: '01JINTDETAILREC',
      provenance: { ...preference().provenance, detailIds: ['01JINTWHYDETAIL'] },
    }]);
    detailHarness.fake.details.push({
      id: '01JINTWHYDETAIL',
      detailKind: 'raw_chunk',
      domain: 'user',
      recordIds: ['01JINTDETAILREC'],
      role: 'user',
      text: detailText,
      messageId: 'm_int_why',
      chunkIndex: 0,
      provenance: { source: 'runtime', deviceId: 'device-a', agentId: 'opencode' },
      createdAt: NOW - 60_000,
    });
    const detailContext = await post(`${detailHarness.server.url}/context`, {
      agentId: 'opencode',
      threadId: 'th_detail',
      turnId: 'turn_detail',
      query: '之前为什么偏好深色主题？',
    });
    expect(detailContext.status).toBe(200);
    expect(detailContext.body.data.decision).toMatchObject({ action: 'speak', depth: 'detail' });
    expect(detailContext.body.data.fragments[0].detail).toMatchObject({ format: 'structured' });
    expect(detailContext.body.data.fragments[0].detail.text).toContain('theme=dark');

    const quoteHarness = await setup({ intervention: { mode: 'heuristic', explorationRate: 0 } });
    const text = '我原话：以后默认用深色主题。';
    quoteHarness.fake.setRecords([{
      ...preference(),
      id: '01JINTQUOTE1',
      type: 'episode',
      kind: 'episode',
      content: { episodeType: 'conversation', title: '原话', content: text },
      text,
      provenance: { ...preference().provenance, detailIds: ['01JINTDETAIL1'] },
    }]);
    quoteHarness.fake.details.push({
      id: '01JINTDETAIL1',
      detailKind: 'raw_chunk',
      domain: 'user',
      recordIds: ['01JINTQUOTE1'],
      role: 'user',
      text,
      messageId: 'm_int_detail',
      chunkIndex: 0,
      provenance: { source: 'runtime', deviceId: 'device-a', agentId: 'opencode' },
      createdAt: NOW - 60_000,
    });
    const quoteContext = await post(`${quoteHarness.server.url}/context`, {
      agentId: 'opencode',
      threadId: 'th_quote',
      turnId: 'turn_quote',
      query: '我当时原话怎么说的？',
    });
    expect(quoteContext.status).toBe(200);
    expect(quoteContext.body.data.decision).toMatchObject({ action: 'speak', depth: 'quote' });
    expect(quoteContext.body.data.fragments[0].detail).toMatchObject({
      format: 'verbatim',
      text,
    });
  });

  it('outcome：同 trace 同 kind 幂等、保留历史、非法输入 400、trace=off 明确降级', async () => {
    const { server, runtime } = await setup({ intervention: { mode: 'heuristic' } });
    const context = await post(`${server.url}/context`, {
      agentId: 'opencode',
      threadId: 'th_outcome',
      turnId: 'turn_outcome',
      query: '我的偏好是什么？',
    });
    const traceId = context.body.data.traceId as string;
    expect(traceId).toMatch(/^tr_/);

    const first = await post(`${server.url}/recall/${traceId}/outcome`, {
      kind: 'accepted',
      source: 'host',
      confidence: 0.8,
      note: 'user said thanks',
    });
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({ recorded: true, duplicate: false, degraded: false });

    const again = await post(`${server.url}/recall/${traceId}/outcome`, {
      kind: 'accepted',
      source: 'host',
    });
    expect(again.status).toBe(200);
    expect(again.body.data).toMatchObject({ recorded: false, duplicate: true });

    const second = await post(`${server.url}/recall/${traceId}/outcome`, {
      kind: 'dismissed',
      source: 'console',
    });
    expect(second.status).toBe(200);
    expect(second.body.data.recorded).toBe(true);

    const trace = await fetch(`${server.url}/traces/${traceId}`, { headers: auth() });
    const traceBody = await trace.json() as any;
    expect(traceBody.data.outcome).toMatchObject({ kind: 'dismissed', source: 'console' });
    expect(traceBody.data.outcomeHistory.map((entry: any) => entry.kind)).toEqual(['accepted', 'dismissed']);

    const stats = await runtime.policyStore!.snapshot();
    expect(stats.global.accepted).toBe(1);
    expect(stats.global.dismissed).toBe(1);

    const invalid = await post(`${server.url}/recall/${traceId}/outcome`, { kind: 'nope', source: 'host' });
    expect(invalid.status).toBe(400);
    const tooLongNote = await post(`${server.url}/recall/${traceId}/outcome`, {
      kind: 'ignored',
      source: 'host',
      note: 'x'.repeat(201),
    });
    expect(tooLongNote.status).toBe(400);
    const maxNote = await post(`${server.url}/recall/${traceId}/outcome`, {
      kind: 'ignored',
      source: 'host',
      note: 'y'.repeat(200),
    });
    expect(maxNote.status).toBe(200);
    const missing = await post(`${server.url}/recall/tr_missing/outcome`, { kind: 'missed', source: 'host' });
    expect(missing.status).toBe(404);

    const off = await setup({ trace: 'off' });
    const offline = await post(`${off.server.url}/recall/tr_offline/outcome`, { kind: 'missed', source: 'host' });
    expect(offline.status).toBe(200);
    expect(offline.body.data).toMatchObject({ recorded: false, degraded: true });
    expect(offline.body.data.warnings).toContain('trace_off');
    const offStats = await off.runtime.policyStore!.snapshot();
    expect(offStats.global).toMatchObject({ spoken: 0, silent: 0, missed: 0 });
    const offContext = await post(`${off.server.url}/context`, {
      agentId: 'opencode',
      threadId: 'th_off_no_learn',
      turnId: 'turn_off_no_learn',
      query: '我的偏好是什么？',
    });
    expect(offContext.body.data.traceId).toBeNull();
    const offStatsAfter = await off.runtime.policyStore!.snapshot();
    expect(offStatsAfter.global).toMatchObject({ spoken: 0, silent: 0 });
  });

  it('outcome 幂等记录 seenOutcomeKinds，不受 5 条 history 截断影响', async () => {
    const { server, runtime } = await setup({ intervention: { mode: 'heuristic' } });
    const context = await post(`${server.url}/context`, {
      agentId: 'opencode',
      threadId: 'th_seen_kinds',
      turnId: 'turn_seen_kinds',
      query: '我的偏好是什么？',
    });
    const traceId = context.body.data.traceId as string;
    const kinds = ['accepted', 'ignored', 'reasked', 'corrected', 'dismissed', 'missed', 'too_shallow', 'too_deep'];
    for (const kind of kinds) {
      const result = await post(`${server.url}/recall/${traceId}/outcome`, { kind, source: 'host' });
      expect(result.status).toBe(200);
      expect(result.body.data.recorded).toBe(true);
    }
    // 早期 kind 已超出 history 上限，但 seenOutcomeKinds 仍能保证幂等。
    const again = await post(`${server.url}/recall/${traceId}/outcome`, { kind: 'accepted', source: 'host' });
    expect(again.status).toBe(200);
    expect(again.body.data).toMatchObject({ recorded: false, duplicate: true });
    const trace = await fetch(`${server.url}/traces/${traceId}`, { headers: auth() });
    const traceBody = await trace.json() as any;
    expect(traceBody.data.outcomeHistory).toHaveLength(5);
    expect(traceBody.data.seenOutcomeKinds).toEqual(kinds);
    const stats = await runtime.policyStore!.snapshot();
    expect(stats.global.accepted).toBe(1);
  });

  it('applied 以实际注入块为准：预算裁掉 memory 片段时不显示 speak', async () => {
    const { server, fake, runtime } = await setup({ intervention: { mode: 'heuristic', explorationRate: 0 } });
    fake.setRecords([{
      ...preference(),
      id: '01JLONGGIST',
      content: { entity: 'user', preferenceType: 'note', value: 'x'.repeat(800) },
      text: 'x'.repeat(800),
      provenance: { ...preference().provenance },
    }]);
    const context = await post(`${server.url}/context`, {
      agentId: 'opencode',
      threadId: 'th_budget',
      turnId: 'turn_budget',
      query: '为什么偏好这条笔记？',
      maxBytes: 128,
      tokenBudget: 100,
    });
    expect(context.status).toBe(200);
    expect(context.body.data.decision).toMatchObject({ action: 'speak', enforced: true });
    expect(context.body.data.applied).toMatchObject({ action: 'silent', fragments: 0 });
    expect(context.body.data.fragments).toEqual([]);
    expect(context.body.data.blocks).toEqual([]);
    // 预算裁掉全部 fragment 时，策略统计必须记 silenced，而不是 decision 的 spoken。
    const stats = await runtime.policyStore!.snapshot();
    expect(stats.global.spoken).toBe(0);
    expect(stats.global.silent).toBe(1);
    const trace = await fetch(`${server.url}/traces/${context.body.data.traceId}`, { headers: auth() });
    const traceBody = await trace.json() as any;
    expect(traceBody.data.applied).toMatchObject({ action: 'silent', fragments: 0 });
  });

  it('outcome ignored 使用至少 10 分钟窗口；其他 kind 仍用 outcomeWindowMs', async () => {
    let now = NOW;
    const { server } = await setup({ intervention: { mode: 'heuristic' }, now: () => now });
    const trace = async (thread: string): Promise<string> => {
      const context = await post(`${server.url}/context`, {
        agentId: 'opencode',
        threadId: thread,
        turnId: `turn_${thread}`,
        query: '我的偏好是什么？',
      });
      return context.body.data.traceId as string;
    };

    const first = await trace('th_window_1');
    now += 5 * 60 * 1000;
    const ignored = await post(`${server.url}/recall/${first}/outcome`, {
      kind: 'ignored',
      source: 'host',
    });
    expect(ignored.body.data.withinWindow).toBe(true);
    expect(ignored.body.data.warnings).toEqual([]);

    const lateAccepted = await post(`${server.url}/recall/${first}/outcome`, {
      kind: 'accepted',
      source: 'host',
    });
    expect(lateAccepted.body.data.withinWindow).toBe(false);
    expect(lateAccepted.body.data.warnings).toEqual(['outcome_outside_window']);

    const second = await trace('th_window_2');
    now += 11 * 60 * 1000;
    const lateIgnored = await post(`${server.url}/recall/${second}/outcome`, {
      kind: 'ignored',
      source: 'host',
    });
    expect(lateIgnored.body.data.withinWindow).toBe(false);
    expect(lateIgnored.body.data.warnings).toEqual(['outcome_outside_window']);
  });

  it('/status 暴露 policy.degraded；flush 恢复后清除', async () => {
    const { server, runtime, home } = await setup({ intervention: { mode: 'heuristic' } });
    const statePath = join(home, 'memory-runtime', 'policy', 'state.json');
    await mkdir(statePath, { recursive: true });
    // 用普通 turn：must_speak 无候选会按设计 degraded=true，属于召回语义，
    // 不应混进「policy flush 恢复」的 degraded 断言。
    await post(`${server.url}/context`, {
      agentId: 'opencode',
      threadId: 'th_policy_fail',
      turnId: 'turn_policy_fail',
      query: '深色主题',
    });

    expect(await runtime.flushPolicy()).toBe(false);
    expect(runtime.degraded).toBe(true);
    const failed = await fetch(`${server.url}/status`, { headers: auth() });
    const failedBody = await failed.json() as any;
    expect(failedBody.data.policy).toMatchObject({
      degraded: true,
      lastError: { code: expect.any(String), at: NOW },
    });
    expect(JSON.stringify(failedBody)).not.toContain(statePath);

    await rm(statePath, { recursive: true, force: true });
    expect(await runtime.flushPolicy()).toBe(true);
    expect(runtime.degraded).toBe(false);
    const recovered = await fetch(`${server.url}/status`, { headers: auth() });
    const recoveredBody = await recovered.json() as any;
    expect(recoveredBody.data.policy).toEqual({ degraded: false, lastError: null });
  });

  it('PolicyStore init 失败后由后台 flush 恢复：/status 不残留 stale degraded', async () => {
    const { server, runtime, home } = await setup({
      intervention: { mode: 'heuristic' },
      policyBlocker: true,
    });
    expect(runtime.policyStore!.isDegraded).toBe(true);
    const failed = await fetch(`${server.url}/status`, { headers: auth() });
    const failedBody = await failed.json() as any;
    expect(failedBody.data.policy.degraded).toBe(true);
    expect(failedBody.data.policy.lastError?.code).toBeTruthy();

    // 移除阻塞文件，让后续 write-behind 定时 flush 自行成功；不调用 flushPolicy/reset。
    const policyDir = join(home, 'memory-runtime', 'policy');
    await rm(policyDir, { force: true });
    await mkdir(policyDir, { recursive: true });
    await post(`${server.url}/context`, {
      agentId: 'opencode',
      threadId: 'th_policy_recover',
      turnId: 'turn_policy_recover',
      query: '深色主题',
    });

    const deadline = Date.now() + 3000;
    while (runtime.policyStore!.isDegraded && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(runtime.policyStore!.isDegraded).toBe(false);
    expect(runtime.degraded).toBe(false);
    const recovered = await fetch(`${server.url}/status`, { headers: auth() });
    const recoveredBody = await recovered.json() as any;
    expect(recoveredBody.data.policy).toEqual({ degraded: false, lastError: null });
  });

  it('POST /intervention/reset：成功、重复 reset、未启用与错误路径', async () => {
    const { server, runtime } = await setup({ intervention: { mode: 'heuristic' } });
    await post(`${server.url}/context`, {
      agentId: 'opencode',
      threadId: 'th_reset',
      turnId: 'turn_reset',
      query: '我的偏好是什么？',
    });
    const before = await runtime.policyStore!.snapshot();
    expect(before.global.spoken + before.global.silent).toBeGreaterThan(0);

    const reset = await post(`${server.url}/intervention/reset`, {});
    expect(reset.status).toBe(200);
    expect(reset.body).toMatchObject({
      ok: true,
      data: { reset: true, policyVersion: 'v0-rules' },
      degraded: false,
    });
    expect(reset.body.data.removedDomains).toBeGreaterThanOrEqual(1);
    const after = await runtime.policyStore!.snapshot();
    expect(after.global).toMatchObject({ spoken: 0, silent: 0 });
    expect(after.domains).toEqual([]);

    const repeated = await post(`${server.url}/intervention/reset`, {});
    expect(repeated.status).toBe(200);
    expect(repeated.body.data).toMatchObject({ reset: true, removedDomains: 0 });

    const wrongMethod = await fetch(`${server.url}/intervention/reset`, { headers: auth() });
    expect(wrongMethod.status).toBe(405);
    expect((await wrongMethod.json() as any).error.code).toBe('method_not_allowed');

    const unavailable = await setup({ withPolicy: false });
    const denied = await post(`${unavailable.server.url}/intervention/reset`, {});
    expect(denied.status).toBe(409);
    expect(denied.body).toMatchObject({
      ok: false,
      error: { code: 'intervention_unavailable' },
    });

    const noApi = await setup({ interventionApi: false });
    const notImplemented = await post(`${noApi.server.url}/intervention/reset`, {});
    expect(notImplemented.status).toBe(501);
    expect(notImplemented.body.error.code).toBe('not_implemented');
  });

  it('reset 挡住 reset 前 trace 的迟到 outcome；reset 后新 trace 正常记录', async () => {
    let now = NOW;
    const { server, runtime } = await setup({ intervention: { mode: 'heuristic' }, now: () => now });
    const oldContext = await post(`${server.url}/context`, {
      agentId: 'opencode',
      threadId: 'th_reset_late',
      turnId: 'turn_reset_late_old',
      query: '我的偏好是什么？',
    });
    const oldTraceId = oldContext.body.data.traceId as string;
    now += 1000;
    const reset = await post(`${server.url}/intervention/reset`, {});
    expect(reset.status).toBe(200);
    const afterReset = await runtime.policyStore!.snapshot();
    expect(afterReset.global).toMatchObject({ spoken: 0, silent: 0 });

    now += 1000;
    const late = await post(`${server.url}/recall/${oldTraceId}/outcome`, { kind: 'accepted', source: 'host' });
    expect(late.status).toBe(200);
    expect(late.body.data).toMatchObject({ recorded: false, duplicate: false, degraded: false });
    expect(late.body.data.warnings).toContain('outcome_before_reset');
    const stillClean = await runtime.policyStore!.snapshot();
    expect(stillClean.global.accepted).toBe(0);
    expect(stillClean.global.spoken + stillClean.global.silent).toBe(0);
    const oldTrace = await fetch(`${server.url}/traces/${oldTraceId}`, { headers: auth() });
    const oldTraceBody = await oldTrace.json() as any;
    expect(oldTraceBody.data.outcome ?? null).toBeNull();
    expect(oldTraceBody.data.outcomeHistory ?? []).toEqual([]);

    now += 1000;
    const freshContext = await post(`${server.url}/context`, {
      agentId: 'opencode',
      threadId: 'th_reset_late',
      turnId: 'turn_reset_late_new',
      query: '我的偏好是什么？',
    });
    const freshTraceId = freshContext.body.data.traceId as string;
    const fresh = await post(`${server.url}/recall/${freshTraceId}/outcome`, { kind: 'accepted', source: 'host' });
    expect(fresh.status).toBe(200);
    expect(fresh.body.data.recorded).toBe(true);
    const finalStats = await runtime.policyStore!.snapshot();
    expect(finalStats.global.accepted).toBe(1);
    expect(finalStats.global.spoken + finalStats.global.silent).toBeGreaterThan(0);
  });

  it('/version 暴露 effective intervention 能力位；旧字段保持兼容', async () => {
    const { server } = await setup({ modelSource: 'heuristic', intervention: { mode: 'heuristic' } });
    const version = await fetch(`${server.url}/version`, { headers: auth() });
    const body = await version.json() as any;
    expect(version.status).toBe(200);
    expect(body.data.capabilities).toMatchObject({
      ingest: true,
      recall: true,
      context: true,
      feedback: true,
      traces: true,
      intervention: {
        decision: true,
        outcome: true,
        shadow: true,
        reset: true,
        mode: 'heuristic',
        configuredSource: 'heuristic',
        planner: 'heuristic',
        legacyModeIgnored: false,
        diagnosticShadow: false,
        warnings: [],
      },
    });
  });

  it('/status 返回 effective mode/source 与旧 mode warning；不泄漏密钥', async () => {
    const { server } = await setup({
      modelSource: 'api',
      intervention: { mode: 'off' },
    });
    const response = await fetch(`${server.url}/status`, { headers: auth() });
    const body = await response.json() as any;
    expect(response.status).toBe(200);
    expect(body.data.intervention).toMatchObject({
      mode: 'model',
      planner: 'model',
      source: 'api',
      derivedMode: 'model',
      legacyModePresent: true,
      legacyModeIgnored: true,
      legacyModeConflict: true,
      diagnosticShadow: false,
    });
    expect(body.data.intervention.warnings).toContain('legacy_intervention_mode_ignored');
    expect(body.warnings).toContain('legacy_intervention_mode_ignored');
    expect(JSON.stringify(body)).not.toMatch(/keyRef|apiKey|authorization|bearer/i);
  });
});
