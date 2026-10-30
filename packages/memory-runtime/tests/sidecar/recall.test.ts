// W4b 碎片化召回：gist/detail、沉默、预算、跨 Agent、Raw、stale、冲突、
// anchor 去重、trace/feedback。使用 fake capability server，不启动真实 MCP/core。

import { describe, it, expect, afterEach } from '@jest/globals';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CapabilityClient } from '../../src/sidecar/capability-client.js';
import { defaultSidecarConfig, type SidecarConfig } from '../../src/sidecar/config.js';
import { defaultSidecarPolicy, type SidecarPolicy } from '../../src/sidecar/domains.js';
import { SidecarLocalLayer } from '../../src/sidecar/local-layer.js';
import { RecallService } from '../../src/sidecar/recall.js';
import { startFakeCapability, type FakeCapabilityServer, type FakeCompact, type FakeMemoryRecord } from './fake-capability.js';

const NOW = 1_760_000_000_000;

interface Harness {
  home: string;
  local: SidecarLocalLayer;
  fake: FakeCapabilityServer;
  service: RecallService;
  config: SidecarConfig;
}

const harnesses: Harness[] = [];

function record(partial: Partial<FakeMemoryRecord> & Pick<FakeMemoryRecord, 'id' | 'type' | 'domain'>): FakeMemoryRecord {
  return {
    ownerType: partial.domain === 'user' ? 'user' : partial.domain.startsWith('agent:') ? 'agent' : 'other',
    ownerId: partial.domain === 'user' ? 'u_test' : partial.domain.startsWith('agent:') ? partial.domain.slice(6) : partial.domain,
    namespace: partial.domain,
    provenance: {
      source: 'runtime',
      writerType: 'agent',
      writerId: 'opencode',
      extractor: 'heuristic',
      model: null,
      version: '0.3.0',
      deviceId: 'device-local',
      hostId: 'h_test',
      threadId: 'th_recall',
      agentId: 'opencode',
      agentName: 'OpenCode',
      confirmation: 'none',
      at: NOW - 86_400_000,
    },
    content: {},
    tags: [],
    validFrom: NOW - 86_400_000,
    validTo: null,
    createdAt: NOW - 86_400_000,
    updatedAt: NOW - 86_400_000,
    detailAvailable: true,
    legacy: false,
    score: 0.9,
    why: 'vector+keyword',
    ...partial,
  };
}

async function setup(options: {
  records?: FakeMemoryRecord[];
  compacts?: FakeCompact[];
  policy?: SidecarPolicy;
  mutateConfig?: (config: SidecarConfig) => void;
} = {}): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), 'mebular-recall-'));
  const local = new SidecarLocalLayer({ root: join(home, 'memory-runtime'), now: () => NOW });
  await local.init();
  const fake = await startFakeCapability();
  fake.setRecords(options.records ?? []);
  fake.setCompacts(options.compacts ?? []);
  const client = new CapabilityClient({ baseUrl: fake.baseUrl, token: 'cap-token', retries: 0, retryDelayMs: 0 });
  const config = defaultSidecarConfig();
  config.http.port = 0;
  options.mutateConfig?.(config);
  const service = new RecallService({
    config,
    local,
    client,
    identity: { cloudId: 'cl_test', profileId: 'default', hostId: 'h_test', deviceId: 'device-local' },
    policy: options.policy ?? defaultSidecarPolicy(),
    now: () => NOW,
  });
  const harness = { home, local, fake, service, config };
  harnesses.push(harness);
  return harness;
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.fake.close();
    await rm(harness.home, { recursive: true, force: true });
  }
});

function policyAllowingHermes(): SidecarPolicy {
  return {
    schema: 1,
    agents: {
      opencode: {
        readDomains: ['user', 'default', 'agent:opencode', 'agent:hermes', 'task:*'],
        writeDomains: ['user', 'default', 'agent:opencode', 'task:*', 'shared'],
        userWriteConfirmation: true,
      },
    },
  };
}

function preferenceRecord(): FakeMemoryRecord {
  return record({
    id: '01JPREF0001',
    type: 'fact',
    kind: 'preference',
    domain: 'user',
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
      threadId: 'th_recall',
      agentId: 'opencode',
      agentName: 'OpenCode',
      confirmation: 'explicit',
      at: NOW - 86_400_000,
    },
  });
}

describe('RecallService', () => {
  it('宽泛 query 只返回 gist，不展开详情，保留 owner/provenance/citation', async () => {
    const { service, fake } = await setup({ records: [preferenceRecord()] });
    const response = await service.handleRecall({
      agentId: 'opencode',
      threadId: 'th_recall',
      query: '你记得我的喜好吗？',
    });

    expect(response.degraded).toBe(false);
    expect(response.data.silenceReason).toBeNull();
    expect(response.data.fragments).toHaveLength(1);
    const fragment = response.data.fragments[0]!;
    expect(fragment).toMatchObject({
      kind: 'preference',
      layer: 'fuzzy',
      trust: 'untrusted',
      detailAvailable: false,
      source: 'settled',
      stale: false,
      owner: { role: 'user', domain: 'user' },
    });
    expect(fragment.gist).toContain('偏好');
    expect(fragment.detail).toBeUndefined();
    expect(fragment.sourceIds).toEqual(['01JPREF0001']);
    expect(fragment.citations[0]).toMatchObject({ id: '01JPREF0001', type: 'fact', domain: 'user' });
    expect(fragment.provenance).toMatchObject({
      source: 'runtime',
      agentId: 'opencode',
      agentName: 'OpenCode',
      deviceId: 'device-local',
      confirmation: 'explicit',
    });
    expect(response.data.records[0]).not.toHaveProperty('content');
    expect(fake.requests.some((request) => request.path.endsWith('/query'))).toBe(true);
    expect(fake.requests.some((request) => request.path.endsWith('/search'))).toBe(true);
    expect(fake.requests.some((request) => request.path.endsWith('/profile'))).toBe(true);
  });

  it('细节 query 展开 MemoryRecord；无本机 Raw 时标 settled，不冒充原文', async () => {
    const { service } = await setup({
      records: [record({
        id: '01JPORT0001',
        type: 'fact',
        kind: 'fact',
        domain: 'agent:opencode',
        content: { subject: 'mebular', predicate: 'localPort', object: '7331', confidence: 0.9 },
        text: 'mebular localPort 7331',
      })],
    });
    const response = await service.handleRecall({
      agentId: 'opencode',
      threadId: 'th_recall',
      query: 'mebular 的本地端口是多少？',
    });

    expect(response.data.fragments).toHaveLength(1);
    const fragment = response.data.fragments[0]!;
    expect(fragment.gist).toContain('7331');
    expect(fragment.detail).toMatchObject({
      format: 'structured',
      truncated: false,
      availability: expect.arrayContaining(['cloud']),
    });
    expect(fragment.detail?.text).toContain('7331');
    expect(fragment.detailAvailable).toBe(false);
    expect(fragment.source).toBe('settled');
    expect(fragment.detailAvailability).toEqual(expect.arrayContaining(['cloud']));
    expect(response.data.records[0]).toMatchObject({ id: '01JPORT0001', why: 'exact_value+keyword' });
  });

  it('无命中返回空 fragments/silence，不写虚假内容', async () => {
    const { service, local } = await setup({ records: [] });
    const response = await service.handleContext({
      agentId: 'opencode',
      threadId: 'th_recall',
      turnId: 'turn_empty',
      query: '完全不存在的记忆主题',
    });

    expect(response.data.fragments).toEqual([]);
    expect(response.data.blocks).toEqual([]);
    expect(response.data.silenceReason).toBe('no_hits');
    expect(response.data.estimatedTokens).toBe(0);
    expect(response.data.trusted).toBe(false);
    expect(response.data.untrusted).toBe(true);
    expect(response.data.traceId).toMatch(/^tr_/);
    expect(await local.store.listTraces()).toHaveLength(1);
  });

  it('context 预算截断并保留 citation/owner/confidence', async () => {
    const long = '部署失败是因为迁移脚本先删除索引再重建，随后回滚步骤没有等待副本同步完成。'.repeat(30);
    const { service } = await setup({
      records: [record({
        id: '01JEPI0001',
        type: 'episode',
        kind: 'episode',
        domain: 'agent:opencode',
        content: { title: '部署失败复盘', content: long, episodeType: 'error', startTime: NOW - 86_400_000 },
        text: long,
      })],
    });
    const response = await service.handleContext({
      agentId: 'opencode',
      threadId: 'th_recall',
      turnId: 'turn_budget',
      query: '上次部署为什么失败？',
      maxFragments: 2,
      maxBytes: 1000,
      tokenBudget: 500,
    });

    expect(response.data.blocks.length).toBeGreaterThan(0);
    expect(response.data.truncated).toBe(true);
    const bytes = response.data.blocks.reduce((sum, block) => sum + block.bytes, 0);
    expect(bytes).toBeLessThanOrEqual(1000);
    for (const block of response.data.blocks) {
      expect(block.citations.length).toBeGreaterThan(0);
      expect(block.owner.domain).toBe('agent:opencode');
      expect(block.confidence).toBeGreaterThan(0);
      expect(block.trust).toBe('untrusted');
    }
  });

  it('其他 Agent 的域/归属/provenance 不被抹掉', async () => {
    const { service } = await setup({
      policy: policyAllowingHermes(),
      records: [record({
        id: '01JHERMES001',
        type: 'episode',
        kind: 'episode',
        domain: 'agent:hermes',
        ownerType: 'agent',
        ownerId: 'hermes',
        content: { title: 'Hermes 的任务记忆', content: 'Hermes 决定先合并 sidecar 边界，再做召回。', episodeType: 'decision' },
        text: 'Hermes 决定先合并 sidecar 边界，再做召回。',
        provenance: {
          source: 'runtime',
          writerType: 'agent',
          writerId: 'hermes',
          extractor: 'heuristic',
          model: null,
          version: '0.3.0',
          deviceId: 'device-hermes',
          hostId: 'h_hermes',
          threadId: 'th_hermes',
          agentId: 'hermes',
          agentName: 'Hermes',
          confirmation: 'none',
          at: NOW - 86_400_000,
        },
      })],
    });
    const response = await service.handleContext({
      agentId: 'opencode',
      threadId: 'th_recall',
      turnId: 'turn_hermes',
      query: 'Hermes 上次说什么？',
      domains: ['user', 'agent:opencode', 'agent:hermes', 'default'],
      includeOtherAgents: true,
    });

    expect(response.data.fragments).toHaveLength(1);
    const fragment = response.data.fragments[0]!;
    expect(fragment.owner).toMatchObject({
      role: 'agent',
      domain: 'agent:hermes',
      agentId: 'hermes',
      agentName: 'Hermes',
    });
    expect(fragment.crossAgent).toBe(true);
    expect(fragment.provenance).toMatchObject({
      agentId: 'hermes',
      agentName: 'Hermes',
      deviceId: 'device-hermes',
      writerId: 'hermes',
    });
    expect(response.data.blocks[0]?.content).toContain('agent:hermes (Hermes)');
    expect(response.data.citations.every((citation) => citation.domain === 'agent:hermes')).toBe(true);
  });

  it('本机有 Raw 时原文可用；Raw 缺失时诚实降级', async () => {
    const text = '我当时说的是：先冻结契约，再迁移 runtime，不要先改宿主。';
    const rawId = 'rc_recall_raw_1';
    const { service, local } = await setup({
      records: [record({
        id: '01JRAW0001',
        type: 'episode',
        kind: 'episode',
        domain: 'agent:opencode',
        content: { title: '原话记录', content: text, episodeType: 'conversation' },
        text,
        provenance: {
          source: 'runtime',
          writerType: 'agent',
          writerId: 'opencode',
          extractor: 'heuristic',
          model: null,
          version: '0.3.0',
          deviceId: 'device-local',
          hostId: 'h_test',
          threadId: 'th_recall',
          agentId: 'opencode',
          agentName: 'OpenCode',
          messageIds: ['m_raw_1'],
          rawChunkIds: [rawId],
          confirmation: 'none',
          at: NOW - 86_400_000,
        },
      })],
    });
    await local.store.putRawChunk('cl_test', {
      schema: 1,
      id: rawId,
      threadId: 'th_recall',
      agentId: 'opencode',
      hostId: 'h_test',
      role: 'user',
      text,
      mime: 'text/plain',
      at: NOW - 86_400_000,
      messageId: 'm_raw_1',
      chunkIndex: 0,
      contentHash: createHash('sha256').update(text).digest('hex'),
      redaction: { applied: false, rules: [] },
      expiresAt: NOW + 86_400_000,
    });

    const first = await service.handleRecall({
      agentId: 'opencode',
      threadId: 'th_recall',
      query: '我当时原话怎么说的？',
    });
    const withRaw = first.data.fragments[0]!;
    expect(withRaw.detailAvailable).toBe(true);
    expect(withRaw.source).toBe('local_raw');
    expect(withRaw.detail).toMatchObject({ format: 'verbatim', availability: expect.arrayContaining(['local_raw']) });
    expect(withRaw.detail?.text).toBe(text);

    await local.store.deleteRawChunk(rawId);
    const second = await service.handleRecall({
      agentId: 'opencode',
      threadId: 'th_recall',
      query: '我当时原话怎么说的？',
      anchor: 'raw-missing-anchor',
    });
    const withoutRaw = second.data.fragments[0]!;
    expect(withoutRaw.detailAvailable).toBe(false);
    expect(withoutRaw.source).toBe('settled');
    expect(withoutRaw.detail?.format).not.toBe('verbatim');
    expect(withoutRaw.detail?.availability).toEqual(expect.arrayContaining(['missing_cross_device']));
    expect(withoutRaw.detail?.text).toContain('原文仅保留在写入设备');
    expect(second.data.warnings).toEqual(expect.arrayContaining(['raw_unavailable']));
  });

  it('stale compact 默认不注入；显式 includeHistory 时保留 stale 标记', async () => {
    const { service } = await setup({
      compacts: [{
        id: '01JCOMPACT01',
        domain: 'user',
        summary: '旧摘要：mebular 本地端口=7331，但源记录已变更。',
        sourceIds: ['01JOLDPORT1'],
        stale: true,
      }],
    });
    const silent = await service.handleRecall({
      agentId: 'opencode',
      threadId: 'th_recall',
      query: '本地端口是多少？',
    });
    expect(silent.data.fragments).toEqual([]);
    expect(silent.data.silenceReason).toBe('only_stale');

    const history = await service.handleRecall({
      agentId: 'opencode',
      threadId: 'th_recall',
      query: '本地端口是多少？',
      includeHistory: true,
      anchor: 'stale-history',
    });
    expect(history.data.fragments).toHaveLength(1);
    expect(history.data.fragments[0]).toMatchObject({
      kind: 'compact',
      stale: true,
      detailAvailable: false,
      source: 'settled',
    });
  });

  it('冲突事实成组展开、相邻呈现，不静默选边', async () => {
    const { service } = await setup({
      records: [
        record({
          id: '01JPORT7331',
          type: 'fact',
          kind: 'fact',
          domain: 'agent:opencode',
          content: { subject: 'mebular', predicate: 'localPort', object: '7331', confidence: 0.9 },
          text: 'mebular localPort 7331',
        }),
        record({
          id: '01JPORT7332',
          type: 'fact',
          kind: 'fact',
          domain: 'agent:opencode',
          content: { subject: 'mebular', predicate: 'localPort', object: '7332', confidence: 0.9 },
          text: 'mebular localPort 7332',
        }),
      ],
    });
    const response = await service.handleContext({
      agentId: 'opencode',
      threadId: 'th_recall',
      turnId: 'turn_conflict',
      query: '到底用 7331 还是 7332？',
      maxFragments: 3,
    });

    expect(response.data.fragments).toHaveLength(2);
    const [first, second] = response.data.fragments;
    expect(first?.conflictGroup).toBeDefined();
    expect(first?.conflictGroup).toBe(second?.conflictGroup);
    expect(first?.detail).toBeDefined();
    expect(second?.detail).toBeDefined();
    expect(response.data.blocks).toHaveLength(2);
    expect(response.data.blocks[0]?.citations[0]?.id).toMatch(/01JPORT733[12]/);
    expect(response.data.blocks[1]?.citations[0]?.id).toMatch(/01JPORT733[12]/);
  });

  it('定向 query 的低置信度观察会展开以核对，不把猜测当事实', async () => {
    const { service } = await setup({
      records: [record({
        id: '01JOBSERVE01',
        type: 'fact',
        kind: 'observation',
        domain: 'agent:opencode',
        content: { content: '用户可能喜欢浅色主题，但未确认。', confidence: 0.45 },
        text: '用户可能喜欢浅色主题，但未确认。',
        score: 0.35,
      })],
    });
    const response = await service.handleRecall({
      agentId: 'opencode',
      threadId: 'th_recall',
      query: 'Mebular 主题方案',
    });

    expect(response.data.fragments).toHaveLength(1);
    expect(response.data.fragments[0]?.kind).toBe('observation');
    expect(response.data.fragments[0]?.confidence).toBeLessThan(0.55);
    expect(response.data.fragments[0]?.detail).toBeDefined();
  });

  it('按 sidecar policy 过滤未授权域：其他 Agent 记忆不可读', async () => {
    const { service, fake } = await setup({
      records: [record({
        id: '01JHERMES002',
        type: 'episode',
        kind: 'episode',
        domain: 'agent:hermes',
        ownerType: 'agent',
        ownerId: 'hermes',
        content: { title: 'Hermes 的秘密', content: '这条记忆不应被当前 Agent 读取。', episodeType: 'task' },
        text: '这条记忆不应被当前 Agent 读取。',
        provenance: { source: 'runtime', agentId: 'hermes', agentName: 'Hermes', deviceId: 'device-hermes', extractor: 'heuristic' },
      })],
    });
    const response = await service.handleRecall({
      agentId: 'opencode',
      threadId: 'th_recall',
      query: 'Hermes 上次说什么？',
      domains: ['agent:hermes'],
      includeOtherAgents: true,
    });

    expect(response.data.fragments).toEqual([]);
    expect(response.data.silenceReason).toBe('domain_forbidden');
    expect(response.data.warnings).toEqual(expect.arrayContaining(['domain_read_forbidden:agent:hermes']));
    expect(fake.requests.some((request) => request.path.endsWith('/query'))).toBe(false);
  });

  it('同一 human turn anchor 只注入一次', async () => {
    const { service } = await setup({ records: [preferenceRecord()] });
    const request = {
      agentId: 'opencode',
      threadId: 'th_recall',
      turnId: 'turn_anchor_1',
      query: '你记得我的喜好吗？',
    };
    const first = await service.handleContext(request);
    expect(first.data.blocks.length).toBeGreaterThan(0);

    const second = await service.handleContext(request);
    expect(second.data.blocks).toEqual([]);
    expect(second.data.fragments).toEqual([]);
    expect(second.data.silenceReason).toBe('duplicate_turn');
  });

  it('trace/feedback 只写本地，不返回正文或 token；preview 脱敏', async () => {
    const { service, local } = await setup({ records: [preferenceRecord()] });
    const response = await service.handleContext({
      agentId: 'opencode',
      threadId: 'th_recall',
      turnId: 'turn_trace',
      query: '我的偏好是什么？ api_key=sk-secret1234567890',
    });
    expect(response.data.traceId).toMatch(/^tr_/);

    const traces = await service.getTraces({ limit: 10 });
    expect(traces.traces).toHaveLength(1);
    const preview = traces.traces[0]!;
    expect(preview.queryPreview).not.toContain('sk-secret1234567890');
    expect(preview).toMatchObject({ degraded: false });
    expect(preview.counts).toBeDefined();

    const detail = await service.getTrace(response.data.traceId!);
    expect(detail).toMatchObject({ schema: 2, id: response.data.traceId });
    expect(JSON.stringify(detail)).not.toContain('sk-secret1234567890');
    expect(JSON.stringify(detail)).not.toContain('用户偏好：theme=dark'.repeat(2));

    const feedback = await service.submitFeedback(response.data.traceId!, {
      useful: true,
      reason: 'helpful',
    });
    expect(feedback.feedback).toMatchObject({ useful: true, reason: 'helpful' });
    expect((await local.store.getTrace(response.data.traceId!))?.feedback).toMatchObject({ useful: true });
    expect(await local.store.listTraces()).toHaveLength(1);
  });
});
