// sidecar 沉降：ingest 幂等、staging、detail 写入/去重/跨域、outbox、无候选。

import { describe, it, expect, afterEach, jest } from '@jest/globals';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CapabilityClient, CapabilityClientError } from '../../src/sidecar/capability-client.js';
import { defaultSidecarConfig } from '../../src/sidecar/config.js';
import { defaultSidecarPolicy } from '../../src/sidecar/domains.js';
import { IngestService } from '../../src/sidecar/ingest.js';
import { LifecycleGate } from '../../src/sidecar/lifecycle-gate.js';
import { SidecarLocalLayer } from '../../src/sidecar/local-layer.js';
import { OutboxReplayer } from '../../src/sidecar/outbox-replayer.js';
import { SettlementRuntime } from '../../src/sidecar/settlement.js';
import { sha256Hex } from '../../src/runtime/local-store.js';
import { startFakeCapability, type FakeCapabilityServer } from './fake-capability.js';

interface Harness {
  home: string;
  local: SidecarLocalLayer;
  fake: FakeCapabilityServer;
  client: CapabilityClient;
  service: IngestService;
}

const harnesses: Harness[] = [];

async function setup(
  policy = defaultSidecarPolicy(),
  options: {
    maxOutboxItems?: number;
    stagingBytes?: number;
    now?: () => number;
    extractionTtlMs?: number;
    lifecycle?: LifecycleGate | null;
  } = {},
): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), 'mebular-memory-runtime-ingest-'));
  const local = new SidecarLocalLayer({
    root: join(home, 'memory-runtime'),
    ...(options.maxOutboxItems !== undefined ? { maxOutboxItems: options.maxOutboxItems } : {}),
    ...(options.stagingBytes !== undefined ? { stagingBytes: options.stagingBytes } : {}),
    ...(options.lifecycle ? { lifecycle: options.lifecycle } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  await local.init();
  const fake = await startFakeCapability(options.now ? { now: options.now } : {});
  const client = new CapabilityClient({
    baseUrl: fake.baseUrl,
    token: 'cap-token',
    retries: 0,
    retryDelayMs: 0,
  });
  const service = new IngestService({
    config: defaultSidecarConfig(),
    local,
    client,
    identity: { cloudId: 'cl_test', profileId: 'default', hostId: 'h_test' },
    policy,
    ...(options.lifecycle ? { lifecycle: options.lifecycle } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.extractionTtlMs ? { extractionTtlMs: options.extractionTtlMs } : {}),
  });
  await service.init();
  const harness = { home, local, fake, client, service };
  harnesses.push(harness);
  return harness;
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.fake.close();
    await rm(harness.home, { recursive: true, force: true });
  }
});

function preferenceRequest(overrides: Record<string, unknown> = {}) {
  return {
    agentId: 'opencode',
    threadId: 'th_1',
    chunks: [{ role: 'user', text: '我喜欢深色主题', messageId: 'm1', chunkIndex: 0 }],
    ...overrides,
  };
}

describe('IngestService settlements', () => {
  it('requestId 幂等：重复请求返回同一结果且不重复写记录/详情', async () => {
    const { service, fake, local } = await setup();
    const request = { requestId: 'req_idem_1', ...preferenceRequest() };

    const first = await service.ingest(request);
    const second = await service.ingest(request);

    expect(first.status).toBe(200);
    expect(first.data.duplicate).toBe(false);
    expect(first.data.accepted).toMatchObject({ chunks: 1, records: 1 });
    expect(first.data.stagingChunkIds).toHaveLength(1);
    expect(first.data.detailIds).toHaveLength(1);
    expect(first.data.records[0]).toMatchObject({ domain: 'user', status: 'created' });
    expect(second.data.duplicate).toBe(true);
    expect(second.data.records[0]!.id).toBe(first.data.records[0]!.id);
    expect(second.data.detailIds).toEqual(first.data.detailIds);
    expect(fake.writeRequests).toHaveLength(1);
    // 每次成功 Detail 写入后都必须做一次权威关联回读。
    expect(fake.detailRequests).toHaveLength(2);
    expect(fake.details).toHaveLength(1);
    expect(fake.details[0]).toMatchObject({ domain: 'user', detailKind: 'raw_chunk' });
    expect(fake.details[0]!.recordIds).toEqual([first.data.records[0]!.id]);
    // 成功后 staging 清理，不做本地权威。
    expect(await local.store.countStagingChunks()).toBe(0);

    expect(service.stats()).toMatchObject({ ingested: 1, settled: 1, degraded: false, lastError: null });
  });

  it('同一 requestId 不同请求体返回 409 idempotency_conflict', async () => {
    const { service, fake } = await setup();
    await service.ingest({ requestId: 'req_conflict', ...preferenceRequest() });

    await expect(service.ingest({
      requestId: 'req_conflict',
      ...preferenceRequest({ chunks: [{ role: 'user', text: '我喜欢浅色主题', messageId: 'm2' }] }),
    })).rejects.toMatchObject({ code: 'idempotency_conflict', status: 409 });
    expect(fake.writeRequests).toHaveLength(1);
  });

  it('staging 与详情按内容 hash 去重；重复内容复用详情 ID', async () => {
    const { service, fake, local } = await setup();
    const first = await service.ingest({ requestId: 'req_hash_1', ...preferenceRequest() });
    const second = await service.ingest({ requestId: 'req_hash_2', ...preferenceRequest() });

    expect(second.data.stagingChunkIds).toEqual(first.data.stagingChunkIds);
    expect(second.data.records[0]).toMatchObject({ status: 'duplicate', duplicate: true });
    expect(second.data.detailIds).toEqual(first.data.detailIds);
    expect(fake.writeRequests).toHaveLength(2);
    expect(fake.detailRequests).toHaveLength(4);
    expect(fake.nodes).toHaveLength(1);
    expect(fake.details).toHaveLength(1);
    expect(await local.store.countStagingChunks()).toBe(0);
  });

  it('chunk 先写 <home>/memory-runtime/staging/chunks.jsonl（0600），成功后删除', async () => {
    const { service, home, local } = await setup();
    const result = await service.ingest(preferenceRequest());
    expect(result.data.stagingChunkIds).toHaveLength(1);

    // 成功沉降后文件可为空，但目录/文件权限仍按私有数据创建。
    const stagingDir = join(home, 'memory-runtime', 'staging');
    if (process.platform !== 'win32') {
      expect((await stat(stagingDir)).mode & 0o777).toBe(0o700);
    }
    expect((await local.stats()).stagingChunks).toBe(0);
  });

  it('capture 旧字段被忽略并 warning，不再控制采集', async () => {
    const { service, local, fake } = await setup();
    const result = await service.ingest(preferenceRequest({ capture: 'off' }));

    expect(result.data.warnings).toContain('legacy_capture_ignored');
    expect(result.data.stagingChunkIds).toHaveLength(1);
    expect(result.data.detailIds).toHaveLength(1);
    expect(fake.detailRequests).toHaveLength(2);
    expect(await local.store.countStagingChunks()).toBe(0);
  });

  it('没有可链接记录时不写详情，抽取结束后删除无用 staging', async () => {
    const { service, local, fake } = await setup();
    const result = await service.ingest({
      requestId: 'req_no_record',
      agentId: 'opencode',
      threadId: 'th_no_record',
      chunks: [{ role: 'assistant', text: '好的，我明白了。', messageId: 'm_assistant' }],
    });

    expect(result.data.records).toEqual([]);
    expect(result.data.detailIds).toEqual([]);
    expect(fake.writeRequests).toHaveLength(0);
    expect(fake.detailRequests).toHaveLength(0);
    expect(result.data.stagingChunkIds).toHaveLength(1);
    expect(await local.store.countStagingChunks()).toBe(0);
  });

  it('宿主候选：user / agent:self / default / task 域与 provenance，详情按域各写一份', async () => {
    const { service, fake } = await setup();
    const result = await service.ingest({
      requestId: 'req_host_domains',
      agentId: 'opencode',
      agentName: 'OpenCode',
      threadId: 'th_task_1',
      extractor: 'host',
      chunks: [{ role: 'user', text: '项目使用 pnpm workspace', messageId: 'm_proj' }],
      candidates: [
        {
          kind: 'preference',
          content: { entity: 'user', preferenceType: 'theme', value: 'dark' },
        },
        {
          kind: 'observation',
          data: { content: '项目使用 pnpm workspace' },
        },
        {
          kind: 'entity',
          content: { entityType: 'project', name: 'Mebular' },
        },
        {
          kind: 'episode',
          content: { episodeType: 'task', content: '完成 sidecar 沉降', title: '沉降' },
        },
      ],
    });

    expect(result.status).toBe(200);
    const items = fake.writeRequests[0]!.body.items as any[];
    expect(items.map((item) => item.domain)).toEqual([
      'user',
      'agent:opencode',
      'default',
      'task:th_task_1',
    ]);
    expect(fake.writeRequests[0]!.headers['idempotency-key']).toBe(fake.writeRequests[0]!.body.requestId);
    expect(fake.writeRequests[0]!.body.actor).toMatchObject({
      type: 'agent',
      agentId: 'opencode',
      displayName: 'OpenCode',
    });

    const userItem = items[0];
    expect(userItem.provenance).toMatchObject({
      source: 'host',
      extractor: 'host',
      confirmation: 'explicit',
      threadId: 'th_task_1',
      agentName: 'OpenCode',
    });
    expect(userItem.ownerType).toBeUndefined();
    expect(userItem.ownerId).toBeUndefined();
    // 旧本地 raw 字段不再作为权威写入。
    expect(userItem.provenance.rawChunkIds).toBeUndefined();

    expect(fake.details.map((detail) => detail.domain).sort()).toEqual([
      'agent:opencode',
      'default',
      'task:th_task_1',
      'user',
    ]);
    for (const detail of fake.details) {
      expect(detail.recordIds).toHaveLength(1);
      const record = fake.nodes.find((node) => node.id === detail.recordIds[0]);
      expect(record?.domain).toBe(detail.domain);
      expect(detail.contentHash).toBe(fake.details[0]!.contentHash);
    }
  });

  it('heuristic 只从 user chunk 提取明确偏好/事实/决策/任务，不臆造', async () => {
    const { service, fake } = await setup();
    const result = await service.ingest({
      requestId: 'req_heuristic',
      agentId: 'opencode',
      threadId: 'th_h1',
      chunks: [
        { role: 'user', text: '我喜欢深色主题', messageId: 'm1' },
        { role: 'user', text: '我的项目是 Mebular', messageId: 'm2' },
        { role: 'user', text: '任务：完成 sidecar 沉降', messageId: 'm3' },
        { role: 'assistant', text: '我喜欢这条不应被抽取', messageId: 'm4' },
      ],
    });

    expect(result.data.warnings).not.toContain('no_extractable_memory');
    const items = fake.writeRequests[0]!.body.items as any[];
    const domains = items.map((item) => item.domain);
    expect(domains).toContain('user');
    expect(domains).toContain('task:th_h1');
    const precedences = items.filter((item) => item.kind === 'preference');
    expect(precedences).toHaveLength(1);
    expect(precedences[0]!.provenance).toMatchObject({
      extractor: 'heuristic',
      source: 'runtime',
      confirmation: 'explicit',
    });
    expect(JSON.stringify(items)).not.toContain('不应被抽取');

    const noThread = await service.ingest({
      requestId: 'req_heuristic_default',
      agentId: 'opencode',
      chunks: [{ role: 'user', text: '决定：使用 capability 写入', messageId: 'm9' }],
    });
    const secondItems = fake.writeRequests[1]!.body.items as any[];
    expect(secondItems.map((item) => item.domain)).toEqual(['default']);
    expect(noThread.data.extraction.extractor).toBe('heuristic');
  });

  it('policy 未授权 user 域时，明确偏好降级到自己的 Agent 域并保留 warning', async () => {
    const { service, fake } = await setup({
      schema: 1,
      agents: {
        opencode: {
          readDomains: ['user', 'default', 'agent:opencode'],
          writeDomains: ['agent:opencode', 'default'],
          userWriteConfirmation: true,
        },
      },
    });
    const result = await service.ingest({ requestId: 'req_policy', ...preferenceRequest() });

    const items = fake.writeRequests[0]!.body.items as any[];
    expect(items[0].domain).toBe('agent:opencode');
    expect(items[0].provenance.confirmation).toBe('none');
    expect(result.data.warnings).toContain('user_domain_not_allowed_downgraded');
    expect(result.data.records[0]).toMatchObject({ domain: 'agent:opencode' });
    expect(fake.details[0]!.domain).toBe('agent:opencode');
  });

  it('全非法候选返回 422，且不写 staging/不调用 capability', async () => {
    const { service, fake, local } = await setup();
    await expect(service.ingest({
      requestId: 'req_invalid',
      agentId: 'opencode',
      chunks: [{ role: 'user', text: '我喜欢深色主题', messageId: 'm1' }],
      candidates: [
        { kind: 'bogus', content: { content: 'x' } },
        { kind: 'fact', content: {} },
      ],
    })).rejects.toMatchObject({ code: 'validation_failed', status: 422 });

    expect(fake.writeRequests).toHaveLength(0);
    expect(fake.detailRequests).toHaveLength(0);
    expect(await local.store.countStagingChunks()).toBe(0);
  });

  it('禁止跨 Agent 写入与未确认观察冒充用户事实', async () => {
    const { service, fake, local } = await setup();
    await expect(service.ingest({
      requestId: 'req_cross_agent',
      agentId: 'opencode',
      extractor: 'host',
      candidates: [{
        kind: 'observation',
        content: { content: 'hermes 的秘密' },
        domain: 'agent:hermes',
      }],
    })).rejects.toMatchObject({ code: 'domain_write_forbidden', status: 403 });

    await expect(service.ingest({
      requestId: 'req_user_observation',
      agentId: 'opencode',
      extractor: 'host',
      candidates: [{
        kind: 'observation',
        content: { content: '用户喜欢深色主题' },
        domain: 'user',
      }],
    })).rejects.toMatchObject({ code: 'domain_write_forbidden', status: 403 });

    await expect(service.ingest({
      requestId: 'req_request_domain_cross',
      agentId: 'opencode',
      domain: 'agent:hermes',
      extractor: 'host',
      candidates: [{ kind: 'observation', content: { content: 'x' } }],
    })).rejects.toMatchObject({ code: 'domain_write_forbidden', status: 403 });

    expect(fake.writeRequests).toHaveLength(0);
    expect(await local.store.countStagingChunks()).toBe(0);
  });

  it('extractor=host 无候选返回 pending；回填候选后写记录与详情，重复回填不重复写', async () => {
    const { service, fake, local } = await setup();
    const pending = await service.ingest({
      requestId: 'req_host_pending',
      agentId: 'opencode',
      threadId: 'th_pending',
      extractor: 'host',
      chunks: [{ role: 'user', text: '我喜欢深色主题', messageId: 'mp1' }],
    });

    expect(pending.status).toBe(202);
    expect(pending.data.queued).toBe(false);
    expect(pending.data.extraction).toMatchObject({ status: 'pending', extractor: 'host' });
    expect(pending.data.accepted.records).toBe(0);
    expect(pending.data.stagingChunkIds).toHaveLength(1);
    expect(pending.data.detailIds).toEqual([]);
    expect(fake.writeRequests).toHaveLength(0);
    expect(fake.detailRequests).toHaveLength(0);
    expect(await local.store.countStagingChunks()).toBe(1);

    const candidates = [{
      kind: 'preference',
      content: { entity: 'user', preferenceType: 'theme', value: 'dark' },
    }];
    const completed = await service.completeExtraction(pending.data.extraction.id, candidates);
    expect(completed.queued).toBe(false);
    expect(completed.extraction).toMatchObject({ status: 'completed', extractor: 'host', model: 'host-provided' });
    expect(completed.extraction.records).toHaveLength(1);
    expect(completed.extraction.detailIds).toHaveLength(1);
    expect(fake.writeRequests).toHaveLength(1);
    expect(fake.detailRequests).toHaveLength(2);
    expect(fake.details).toHaveLength(1);
    expect(await local.store.countStagingChunks()).toBe(0);

    const again = await service.completeExtraction(pending.data.extraction.id, candidates);
    expect(again.extraction.records[0]!.id).toBe(completed.extraction.records[0]!.id);
    expect(fake.writeRequests).toHaveLength(1);
  });

  it('记录 capability 失败进入 outbox；恢复后重放写入记录、详情并清理 staging', async () => {
    const { service, fake, local, client } = await setup();
    fake.setFailure({ status: 503, code: 'capability_unavailable', retryable: true });

    const queued = await service.ingest({
      requestId: 'req_outbox',
      ...preferenceRequest(),
    });
    expect(queued.status).toBe(202);
    expect(queued.data).toMatchObject({ queued: true, degraded: true });
    expect(queued.data.stagingChunkIds).toHaveLength(1);
    expect(queued.data.extraction.status).toBe('pending');
    expect(await local.outbox.stats()).toMatchObject({ items: 1 });
    expect(queued.data.warnings).toEqual(expect.arrayContaining(['capability_unavailable', 'queued_outbox']));
    expect(await local.store.countStagingChunks()).toBe(1);

    fake.setFailure(null);
    const replayer = new OutboxReplayer({
      outbox: local.outbox,
      client,
      onSettled: (item, data) => service.applyReplayedOutbox(item, data),
    });
    const summary = await replayer.replayOnce();
    expect(summary).toMatchObject({ settled: 1, retried: 0, dead: 0, remaining: 0, errors: [] });
    service.applyReplaySummary(summary);
    expect(await local.outbox.stats()).toMatchObject({ items: 0 });
    expect(fake.writeRequests).toHaveLength(2);
    expect(fake.detailRequests).toHaveLength(2);
    expect(fake.details).toHaveLength(1);
    expect(await local.store.countStagingChunks()).toBe(0);
  });

  it('详情写入失败：记录仍在，详情进入 outbox，恢复后重放成功并清理 staging', async () => {
    const { service, fake, local, client } = await setup();
    fake.setDetailFailure({ status: 503, code: 'capability_unavailable', retryable: true });

    const result = await service.ingest({
      requestId: 'req_detail_outbox',
      ...preferenceRequest(),
    });
    expect(result.data.records).toHaveLength(1);
    expect(result.data.detailIds).toEqual([]);
    expect(result.data.detail.queued).toBe(1);
    expect(result.data.queued).toBe(true);
    expect(result.status).toBe(202);
    expect(result.data.warnings).toEqual(expect.arrayContaining(['detail_queued', 'queued_outbox']));
    expect(await local.outbox.stats()).toMatchObject({ items: 1 });
    const outboxItem = (await local.outbox.list())[0]!;
    expect(outboxItem.endpoint).toBe('/detail');
    expect(outboxItem.meta?.kind).toBe('detail');
    expect(outboxItem.expiresAt).toBe((outboxItem.body as any).items[0].expiresAt);
    expect(await local.store.countStagingChunks()).toBe(1);

    fake.setDetailFailure(null);
    const replayer = new OutboxReplayer({
      outbox: local.outbox,
      client,
      onSettled: (item, data) => service.applyReplayedOutbox(item, data),
    });
    const summary = await replayer.replayOnce();
    expect(summary).toMatchObject({ settled: 1, retried: 0, dead: 0, remaining: 0 });
    expect(fake.details).toHaveLength(1);
    expect(await local.outbox.stats()).toMatchObject({ items: 0 });
    expect(await local.store.countStagingChunks()).toBe(0);
  });

  it('详情配额 413 进入 outbox 重试，记录不丢', async () => {
    const { service, fake, local, client } = await setup();
    fake.setDetailFailure({ status: 413, code: 'detail_quota_exceeded', retryable: false });

    const result = await service.ingest({
      requestId: 'req_detail_quota',
      ...preferenceRequest(),
    });
    expect(result.data.records).toHaveLength(1);
    expect(result.data.detail).toMatchObject({ queued: 1, failed: 0 });
    expect(result.data.warnings).toEqual(expect.arrayContaining([
      'detail_write_failed:detail_quota_exceeded',
      'detail_queued',
    ]));
    expect(await local.outbox.stats()).toMatchObject({ items: 1 });

    fake.setDetailFailure(null);
    const replayer = new OutboxReplayer({
      outbox: local.outbox,
      client,
      onSettled: (item, data) => service.applyReplayedOutbox(item, data),
    });
    await replayer.replayOnce();
    expect(fake.details).toHaveLength(1);
    expect(await local.store.countStagingChunks()).toBe(0);
  });

  it('不可重试的记录错误不进 outbox，记录 failed/lastError 且清理无用 staging', async () => {
    const { service, fake, local } = await setup();
    fake.setFailure({ status: 422, code: 'validation_failed', retryable: false });

    const result = await service.ingest({ requestId: 'req_perm_fail', ...preferenceRequest() });

    expect(result.status).toBe(200);
    expect(result.data).toMatchObject({ queued: false, degraded: true });
    expect(result.data.extraction.status).toBe('failed');
    expect(result.data.records).toEqual([]);
    expect(await local.outbox.stats()).toMatchObject({ items: 0 });
    expect(await local.store.countStagingChunks()).toBe(0);
    expect(service.stats()).toMatchObject({
      failed: 1,
      degraded: true,
      lastError: { code: 'validation_failed' },
    });
    expect(fake.writeRequests).toHaveLength(1);
  });

  it('同键新值：通过 capability 查询旧记录并带 supersedes 写入；多值歧义不自动替代', async () => {
    const { service, fake } = await setup();
    const now = Date.now();
    fake.setRecords([{
      id: '01OLD7332',
      type: 'fact',
      kind: 'fact',
      domain: 'agent:opencode',
      content: { subject: 'mebular', predicate: 'localPort', object: '7332' },
      text: 'mebular localPort 7332',
      validFrom: now - 60_000,
      validTo: null,
      provenance: { source: 'runtime', writerId: 'opencode' },
    }]);

    const first = await service.ingest({
      requestId: 'req_supersede_1',
      agentId: 'opencode',
      threadId: 'th_port',
      extractor: 'host',
      chunks: [{ role: 'user', text: '不是 7332，是 7331', messageId: 'm_port_1' }],
      candidates: [{
        kind: 'fact',
        domain: 'agent:opencode',
        content: { subject: 'mebular', predicate: 'localPort', object: '7331' },
        confirmation: 'explicit',
      }],
    });

    expect(first.status).toBe(200);
    expect(first.data.warnings).toEqual(expect.arrayContaining(['supersede_detected']));
    expect(fake.requests.some((request) => request.path.endsWith('/query'))).toBe(true);
    expect(fake.writeRequests).toHaveLength(1);
    const writeItems = fake.writeRequests[0]!.body.items as any[];
    expect(writeItems[0].supersedes).toEqual(['01OLD7332']);

    // 同键已有两个不同当前值：可能是多个合法事实，不自动选边。
    fake.setRecords([
      {
        id: '01OLDA',
        type: 'fact',
        kind: 'fact',
        domain: 'agent:opencode',
        content: { subject: 'project', predicate: 'owner', object: 'alice' },
        validFrom: now - 60_000,
        validTo: null,
      },
      {
        id: '01OLDB',
        type: 'fact',
        kind: 'fact',
        domain: 'agent:opencode',
        content: { subject: 'project', predicate: 'owner', object: 'bob' },
        validFrom: now - 60_000,
        validTo: null,
      },
    ]);
    await service.ingest({
      requestId: 'req_supersede_ambiguous',
      agentId: 'opencode',
      threadId: 'th_owner',
      extractor: 'host',
      chunks: [{ role: 'user', text: '项目负责人是 carol', messageId: 'm_owner_1' }],
      candidates: [{
        kind: 'fact',
        domain: 'agent:opencode',
        content: { subject: 'project', predicate: 'owner', object: 'carol' },
        confirmation: 'explicit',
      }],
    });
    expect(fake.writeRequests).toHaveLength(2);
    const ambiguousItems = fake.writeRequests[1]!.body.items as any[];
    expect(ambiguousItems[0].supersedes).toBeUndefined();

    // 同 object 不是修正，不 supersede。
    fake.setRecords([{
      id: '01SAME',
      type: 'fact',
      kind: 'fact',
      domain: 'agent:opencode',
      content: { subject: 'project', predicate: 'mode', object: 'dark' },
      validFrom: now - 60_000,
      validTo: null,
    }]);
    await service.ingest({
      requestId: 'req_supersede_same',
      agentId: 'opencode',
      threadId: 'th_mode',
      extractor: 'host',
      chunks: [{ role: 'user', text: '项目模式是 dark', messageId: 'm_mode_1' }],
      candidates: [{
        kind: 'fact',
        domain: 'agent:opencode',
        content: { subject: 'project', predicate: 'mode', object: 'dark' },
        confirmation: 'explicit',
      }],
    });
    expect(fake.writeRequests).toHaveLength(3);
    const sameItems = fake.writeRequests[2]!.body.items as any[];
    expect(sameItems[0].supersedes).toBeUndefined();
  });

  it('多域候选只关联实际支撑 chunk/message，不复制无关证据', async () => {
    const { service, fake } = await setup();
    const result = await service.ingest({
      requestId: 'req_scoped_evidence',
      agentId: 'opencode',
      threadId: 'th_scoped_evidence',
      extractor: 'host',
      chunks: [
        { role: 'user', text: '我喜欢深色主题', messageId: 'm_theme', chunkIndex: 0 },
        { role: 'assistant', text: '项目使用 pnpm workspace', messageId: 'm_pnpm', chunkIndex: 1 },
      ],
      candidates: [
        {
          kind: 'preference',
          content: { entity: 'user', preferenceType: 'theme', value: 'dark' },
          sourceMessageIds: ['m_theme'],
        },
        {
          kind: 'observation',
          content: { content: '项目使用 pnpm workspace' },
          sourceMessageIds: ['m_pnpm'],
        },
      ],
    });

    expect(result.status).toBe(200);
    expect(fake.details).toHaveLength(2);
    const userDetail = fake.details.find((detail) => detail.domain === 'user');
    const agentDetail = fake.details.find((detail) => detail.domain === 'agent:opencode');
    expect(userDetail).toMatchObject({ text: '我喜欢深色主题', messageId: 'm_theme' });
    expect(agentDetail).toMatchObject({ text: '项目使用 pnpm workspace', messageId: 'm_pnpm' });
    expect(userDetail?.recordIds).toEqual([
      result.data.records.find((record) => record.domain === 'user')?.id,
    ]);
    expect(agentDetail?.recordIds).toEqual([
      result.data.records.find((record) => record.domain === 'agent:opencode')?.id,
    ]);
    expect(JSON.stringify(userDetail)).not.toContain('pnpm workspace');
    expect(JSON.stringify(agentDetail)).not.toContain('深色主题');
    expect(fake.writeRequests[0]!.body.items.every((item: any) => item.provenance.detailIds === undefined)).toBe(true);
  });

  it('无法证明多 chunk 证据时只写记录，不伪造 Detail 关联', async () => {
    const { service, fake } = await setup();
    const result = await service.ingest({
      requestId: 'req_unresolved_evidence',
      agentId: 'opencode',
      threadId: 'th_unresolved_evidence',
      extractor: 'host',
      chunks: [
        { role: 'user', text: '第一段无关内容', messageId: 'm_unrelated_1' },
        { role: 'assistant', text: '第二段无关内容', messageId: 'm_unrelated_2' },
      ],
      candidates: [{
        kind: 'observation',
        content: { content: '没有直接文本支撑的模型推断' },
      }],
    });

    expect(result.data.records).toHaveLength(1);
    expect(result.data.detailIds).toEqual([]);
    expect(result.data.warnings).toContain('detail_evidence_unresolved');
    expect(fake.details).toEqual([]);
  });

  it('tool/document/conversation 的 detailKind 与 retentionClass 不混用，普通 ingest 不允许 pinned', async () => {
    const { service, fake } = await setup();
    await service.ingest({
      requestId: 'req_detail_retention_kinds',
      agentId: 'opencode',
      threadId: 'th_detail_retention_kinds',
      extractor: 'host',
      chunks: [
        { role: 'tool', text: 'command output', messageId: 'm_tool' },
        { role: 'user', text: '文档切片正文', detailKind: 'document_slice', messageId: 'm_doc' },
        { role: 'user', text: '普通对话正文', messageId: 'm_conversation' },
      ],
      candidates: [
        { kind: 'observation', content: { content: 'command output' }, sourceMessageIds: ['m_tool'] },
        { kind: 'observation', content: { content: '文档切片正文' }, sourceMessageIds: ['m_doc'] },
        { kind: 'observation', content: { content: '普通对话正文' }, sourceMessageIds: ['m_conversation'] },
      ],
    });

    const byMessage = new Map(fake.details.map((detail) => [detail.messageId, detail]));
    expect(byMessage.get('m_tool')).toMatchObject({ detailKind: 'tool_output', retentionClass: 'tool_output' });
    expect(byMessage.get('m_doc')).toMatchObject({ detailKind: 'document_slice', retentionClass: 'document_slice' });
    expect(byMessage.get('m_conversation')).toMatchObject({ detailKind: 'raw_chunk', retentionClass: 'conversation' });
    expect(byMessage.get('m_tool')!.expiresAt!).toBeGreaterThan(0);
    expect(byMessage.get('m_tool')!.expiresAt!).toBeLessThan(byMessage.get('m_conversation')!.expiresAt!);
    expect(byMessage.get('m_conversation')!.expiresAt!).toBeLessThan(byMessage.get('m_doc')!.expiresAt!);

    await expect(service.ingest({
      requestId: 'req_pinned_ingest_forbidden',
      agentId: 'opencode',
      chunks: [{ role: 'user', text: '普通输入不能 pin', retentionClass: 'pinned' }],
      candidates: [{ kind: 'observation', content: { content: '普通输入不能 pin' } }],
    })).rejects.toMatchObject({ code: 'invalid_request', status: 400 });
  });

  it('pending 抽取的 staging 过期时，空闲维护显式 failed 且物理删除证据', async () => {
    let clock = Date.UTC(2026, 0, 1);
    let callback: (() => void) | null = null;
    const { service, local, home } = await setup(defaultSidecarPolicy(), { now: () => clock, extractionTtlMs: 40 * 24 * 60 * 60 * 1000 });
    const pending = await service.ingest({
      requestId: 'req_pending_staging_expiry',
      agentId: 'opencode',
      threadId: 'th_pending_staging_expiry',
      extractor: 'host',
      chunks: [{
        role: 'user',
        text: '等待宿主候选',
        messageId: 'm_pending_staging_expiry',
        expiresAt: clock + 1_000,
      }],
    });
    expect(pending.data.extraction.status).toBe('pending');
    local.startMaintenance({
      intervalMs: 1_000,
      setIntervalFn: ((fn: () => void) => {
        callback = fn;
        return { unref: jest.fn() };
      }) as unknown as typeof setInterval,
      clearIntervalFn: jest.fn() as unknown as typeof clearInterval,
      beforeStagingCleanup: (ids) => service.expireStagingDependencies(ids),
    });

    clock += 1_001;
    callback!();
    await local.idleMaintenance();
    const extraction = await service.getExtraction(pending.data.extraction.id);
    expect(extraction).toMatchObject({ status: 'failed', degraded: true });
    expect(extraction?.warnings).toContain('retention_expired');
    expect(await local.store.countStagingChunks()).toBe(0);
    expect(await readFile(join(home, 'memory-runtime', 'staging', 'chunks.jsonl'), 'utf8')).toBe('');
    const completed = await service.completeExtraction(pending.data.extraction.id, [{
      kind: 'observation',
      content: { content: '迟到的候选不能伪造完整沉降' },
    }]);
    expect(completed.extraction.status).toBe('failed');
    expect(completed.queued).toBe(false);
    await expect(local.outbox.stats()).resolves.toMatchObject({ items: 0 });
    local.stopMaintenance();
  });

  it('部分记录 queued 时保留其 staging 证据，不因另一条记录/Detail 成功而提前删除', async () => {
    const { service, client, fake, local } = await setup();
    jest.spyOn(client, 'write').mockImplementation(async (body: any) => {
      const [first, second] = body.items;
      fake.nodes.push({
        id: 'rec-partial-user',
        type: 'fact',
        kind: 'preference',
        domain: 'user',
        ownerType: 'user',
        ownerId: 'u_test',
        contentHash: 'partial-hash',
        content: first.content,
        provenance: {},
      });
      return {
        ok: true,
        requestId: body.requestId,
        capabilityVersion: 1,
        status: 200,
        degraded: false,
        warnings: [],
        data: {
          results: [
            {
              clientItemId: first.clientItemId,
              status: 'created',
              id: 'rec-partial-user',
              type: 'fact',
              kind: 'preference',
              domain: 'user',
            },
            {
              clientItemId: second.clientItemId,
              status: 'failed',
              kind: 'preference',
              domain: 'user',
              code: 'capability_unavailable',
              retryable: true,
            },
          ],
          created: 1,
          duplicates: 0,
          failed: 1,
          partial: true,
        },
      } as any;
    });

    const result = await service.ingest({
      requestId: 'req_partial_record_queued',
      agentId: 'opencode',
      threadId: 'th_partial_record_queued',
      extractor: 'host',
      chunks: [
        { role: 'user', text: '我喜欢深色主题', messageId: 'm_partial_dark' },
        { role: 'user', text: '我喜欢浅色主题', messageId: 'm_partial_light' },
      ],
      candidates: [
        {
          kind: 'preference',
          content: { entity: 'user', preferenceType: 'theme', value: 'dark' },
          sourceMessageIds: ['m_partial_dark'],
        },
        {
          kind: 'preference',
          content: { entity: 'user', preferenceType: 'theme', value: 'light' },
          sourceMessageIds: ['m_partial_light'],
        },
      ],
    });

    expect(result.status).toBe(202);
    expect(result.data.records).toHaveLength(1);
    expect(result.data.queued).toBe(true);
    expect(await local.store.countStagingChunks()).toBe(2);
    const outbox = await local.outbox.list();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.meta?.kind).toBe('record');
    expect(outbox[0]?.meta?.stagingChunkIds).toHaveLength(2);
  });

  it('相同 chunk 支撑新记录时补齐规范关联，两个记录均可反向找到 Detail', async () => {
    const { service, client, fake, local } = await setup();
    const ingest = (requestId: string, content: string) => service.ingest({
      requestId,
      agentId: 'opencode',
      threadId: 'th_shared_detail_association',
      extractor: 'host',
      chunks: [{ role: 'user', text: '共享证据 A B', messageId: 'm_shared_detail', chunkIndex: 0 }],
      candidates: [{
        kind: 'observation',
        content: { content },
        sourceMessageIds: ['m_shared_detail'],
      }],
    });
    const first = await ingest('req_shared_detail_first', '共享证据 A');
    const second = await ingest('req_shared_detail_second', '共享证据 B');
    const firstRecord = first.data.records[0]!.id;
    const secondRecord = second.data.records[0]!.id;
    expect(secondRecord).not.toBe(firstRecord);
    expect(fake.details).toHaveLength(1);
    expect(fake.details[0]!.recordIds).toEqual(expect.arrayContaining([firstRecord, secondRecord]));

    for (const recordId of [firstRecord, secondRecord]) {
      const listed = await client.detailList({
        actor: { type: 'agent', agentId: 'opencode' },
        domains: ['agent:opencode'],
        recordIds: [recordId],
      });
      expect(listed.data.details.map((detail) => detail.id)).toContain(fake.details[0]!.id);
    }
    expect(await local.store.countStagingChunks()).toBe(0);
  });

  it('33 条同域记录全部反向关联到同一 Detail，不按 32 截断', async () => {
    const { service, client, fake } = await setup();
    const recordIds: string[] = [];
    const result = await service.ingest({
      requestId: 'req_detail_record_ids_33',
      agentId: 'opencode',
      threadId: 'th_detail_record_ids_33',
      extractor: 'host',
      chunks: [{ role: 'user', text: '33 条共享证据', messageId: 'm_detail_record_ids_33', chunkIndex: 0 }],
      candidates: Array.from({ length: 33 }, (_, index) => ({
        kind: 'observation',
        content: { content: `33 条共享证据记录 ${index}` },
        sourceMessageIds: ['m_detail_record_ids_33'],
      })),
    });
    recordIds.push(...result.data.records.map((record) => record.id));
    expect(recordIds).toHaveLength(33);
    expect(fake.details).toHaveLength(1);
    expect(fake.details[0]!.recordIds).toHaveLength(33);
    for (const recordId of recordIds) {
      const listed = await client.detailList({
        actor: { type: 'agent', agentId: 'opencode' },
        domains: ['agent:opencode'],
        recordIds: [recordId],
      });
      expect(listed.data.details.map((detail) => detail.id)).toContain(fake.details[0]!.id);
    }
  });

  it('200 条同域记录全部反向关联，达到 core 上限仍不截断', async () => {
    const { service, client, fake } = await setup();
    const chunk = { role: 'user' as const, text: '200 条共享证据', messageId: 'm_detail_record_ids_200', chunkIndex: 0 };
    const recordIds: string[] = [];
    for (let batch = 0; batch < 2; batch += 1) {
      const result = await service.ingest({
        requestId: `req_detail_record_ids_200_${batch}`,
        agentId: 'opencode',
        threadId: 'th_detail_record_ids_200',
        extractor: 'host',
        chunks: [chunk],
        candidates: Array.from({ length: 100 }, (_, index) => ({
          kind: 'observation',
          content: { content: `200 条共享证据记录 ${batch}_${index}` },
          sourceMessageIds: ['m_detail_record_ids_200'],
        })),
      });
      recordIds.push(...result.data.records.map((record) => record.id));
    }
    expect(recordIds).toHaveLength(200);
    expect(fake.details).toHaveLength(1);
    expect(new Set(fake.details[0]!.recordIds)).toEqual(new Set(recordIds));
    for (const recordId of recordIds) {
      const listed = await client.detailList({
        actor: { type: 'agent', agentId: 'opencode' },
        domains: ['agent:opencode'],
        recordIds: [recordId],
      });
      expect(listed.data.details.map((detail) => detail.id)).toContain(fake.details[0]!.id);
    }
  });

  it('201 条同域记录显式失败，不发送超限 Detail、不截断已有关联', async () => {
    const { service, fake } = await setup();
    const chunk = { role: 'user' as const, text: '201 条共享证据', messageId: 'm_detail_record_ids_201', chunkIndex: 0 };
    for (let batch = 0; batch < 2; batch += 1) {
      await service.ingest({
        requestId: `req_detail_record_ids_201_${batch}`,
        agentId: 'opencode',
        threadId: 'th_detail_record_ids_201',
        extractor: 'host',
        chunks: [chunk],
        candidates: Array.from({ length: 100 }, (_, index) => ({
          kind: 'observation',
          content: { content: `201 条共享证据记录 ${batch}_${index}` },
          sourceMessageIds: ['m_detail_record_ids_201'],
        })),
      });
    }
    const detailRequestsBefore = fake.detailRequests.length;
    const overflow = await service.ingest({
      requestId: 'req_detail_record_ids_201_overflow',
      agentId: 'opencode',
      threadId: 'th_detail_record_ids_201',
      extractor: 'host',
      chunks: [chunk],
      candidates: [{
        kind: 'observation',
        content: { content: '201 条共享证据记录 overflow' },
        sourceMessageIds: ['m_detail_record_ids_201'],
      }],
    });

    expect(overflow.status).toBe(200);
    expect(overflow.data.records).toHaveLength(1);
    expect(overflow.data.detail).toMatchObject({ queued: 0, failed: 1 });
    expect(overflow.data.warnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/^detail_write_failed:/),
    ]));
    expect(overflow.data.extraction.status).toBe('failed');
    expect(fake.detailRequests).toHaveLength(detailRequestsBefore + 1);
    expect(fake.details).toHaveLength(1);
    expect(fake.details[0]!.recordIds).toHaveLength(200);
    expect(fake.details[0]!.recordIds).not.toContain(overflow.data.records[0]!.id);
  });

  it('新 ingest 成功不得删除 pending host extraction 仍依赖的共享 staging', async () => {
    const { service, fake, local } = await setup();
    const chunk = { role: 'user' as const, text: '共享 pending 证据', messageId: 'm_shared_pending', chunkIndex: 0 };
    const pending = await service.ingest({
      requestId: 'req_shared_pending_extraction',
      agentId: 'opencode',
      threadId: 'th_shared_pending',
      extractor: 'host',
      chunks: [chunk],
    });
    expect(pending.status).toBe(202);
    const stagingId = pending.data.stagingChunkIds[0]!;

    const completed = await service.ingest({
      requestId: 'req_shared_pending_new_ingest',
      agentId: 'opencode',
      threadId: 'th_shared_pending',
      extractor: 'host',
      chunks: [chunk],
      candidates: [{
        kind: 'observation',
        content: { content: '共享 pending 证据记录' },
        sourceMessageIds: ['m_shared_pending'],
      }],
    });
    expect(completed.data.records).toHaveLength(1);
    expect(completed.data.stagingChunkIds).toContain(stagingId);
    expect(await local.store.countStagingChunks()).toBe(1);
    expect((await service.getExtraction(pending.data.extraction.id))?.status).toBe('pending');

    const resumed = await service.completeExtraction(pending.data.extraction.id, [{
      kind: 'observation',
      content: { content: '共享 pending 证据迟到记录' },
    }]);
    expect(resumed.extraction.status).toBe('completed');
    expect(fake.details).toHaveLength(1);
    expect(fake.details[0]!.recordIds).toHaveLength(2);
    expect(await local.store.countStagingChunks()).toBe(0);
  });

  it('replay 成功不得删除 pending host extraction 仍依赖的共享 staging', async () => {
    const { service, fake, local } = await setup();
    const chunk = { role: 'user' as const, text: '共享 pending 重放证据', messageId: 'm_shared_pending_replay', chunkIndex: 0 };
    const pending = await service.ingest({
      requestId: 'req_shared_pending_replay_extraction',
      agentId: 'opencode',
      threadId: 'th_shared_pending_replay',
      extractor: 'host',
      chunks: [chunk],
    });
    expect(pending.status).toBe(202);

    fake.setFailure({ status: 503, code: 'capability_unavailable', retryable: true });
    await service.ingest({
      requestId: 'req_shared_pending_replay_ingest',
      agentId: 'opencode',
      threadId: 'th_shared_pending_replay',
      extractor: 'host',
      chunks: [chunk],
      candidates: [{
        kind: 'observation',
        content: { content: '共享 pending 重放记录' },
        sourceMessageIds: ['m_shared_pending_replay'],
      }],
    });
    fake.setFailure(null);

    const replayed = await new OutboxReplayer({
      outbox: local.outbox,
      client: (service as any).client,
      onSettled: (item, data) => service.applyReplayedOutbox(item, data),
    }).replayOnce();
    expect(replayed).toMatchObject({ settled: 1, remaining: 0 });
    expect(await local.store.countStagingChunks()).toBe(1);

    const resumed = await service.completeExtraction(pending.data.extraction.id, [{
      kind: 'observation',
      content: { content: '共享 pending 重放迟到记录' },
    }]);
    expect(resumed.extraction.status).toBe('completed');
    expect(await local.store.countStagingChunks()).toBe(0);
  });

  it('duplicate Detail 按权威回读更新 cache，保留合并后的全部 recordIds 与原 expiresAt', async () => {
    const { service, fake, local } = await setup();
    const chunk = { role: 'user' as const, text: '共享缓存证据 A B', messageId: 'm_shared_cache', chunkIndex: 0 };
    const first = await service.ingest({
      requestId: 'req_duplicate_cache_1',
      agentId: 'opencode',
      threadId: 'th_duplicate_cache',
      extractor: 'host',
      chunks: [chunk],
      candidates: [{
        kind: 'observation',
        content: { content: '共享缓存证据 A' },
        sourceMessageIds: ['m_shared_cache'],
      }],
    });
    const detailId = first.data.detailIds[0]!;
    const firstRecordId = first.data.records[0]!.id;
    const firstExpiresAt = fake.details[0]!.expiresAt;
    const cachedFirst = await local.getCachedDetail<any>(detailId);
    expect(cachedFirst.detail.recordIds).toEqual([firstRecordId]);

    const duplicate = await service.ingest({
      requestId: 'req_duplicate_cache_2',
      agentId: 'opencode',
      threadId: 'th_duplicate_cache',
      extractor: 'host',
      chunks: [chunk],
      candidates: [{
        kind: 'observation',
        content: { content: '共享缓存证据 B' },
        sourceMessageIds: ['m_shared_cache'],
      }],
    });
    expect(duplicate.data.detailIds).toEqual([detailId]);
    const secondRecordId = duplicate.data.records[0]!.id;
    expect(secondRecordId).not.toBe(firstRecordId);
    expect(fake.details).toHaveLength(1);
    expect(fake.details[0]!.recordIds).toEqual(expect.arrayContaining([firstRecordId, secondRecordId]));
    const cached = await local.getCachedDetail<any>(detailId);
    expect(cached.detail.recordIds).toEqual(expect.arrayContaining([firstRecordId, secondRecordId]));
    expect(cached.detail.recordIds).toHaveLength(2);
    expect(cached.detail.expiresAt).toBe(firstExpiresAt);
  });

  it('replay duplicate Detail 也按权威回读更新 cache 的合并 recordIds', async () => {
    const { service, fake, local } = await setup();
    const chunk = { role: 'user' as const, text: '重放缓存证据 A B', messageId: 'm_replay_cache', chunkIndex: 0 };
    const first = await service.ingest({
      requestId: 'req_replay_cache_first',
      agentId: 'opencode',
      threadId: 'th_replay_cache',
      extractor: 'host',
      chunks: [chunk],
      candidates: [{
        kind: 'observation',
        content: { content: '重放缓存证据 A' },
        sourceMessageIds: ['m_replay_cache'],
      }],
    });
    const detailId = first.data.detailIds[0]!;
    const firstRecordId = first.data.records[0]!.id;

    fake.setDetailFailure({ status: 503, code: 'capability_unavailable', retryable: true });
    const queued = await service.ingest({
      requestId: 'req_replay_cache_second',
      agentId: 'opencode',
      threadId: 'th_replay_cache',
      extractor: 'host',
      chunks: [chunk],
      candidates: [{
        kind: 'observation',
        content: { content: '重放缓存证据 B' },
        sourceMessageIds: ['m_replay_cache'],
      }],
    });
    expect(queued.status).toBe(202);
    expect(queued.data.detail.queued).toBe(1);
    const secondRecordId = queued.data.records[0]!.id;
    const beforeReplay = await local.getCachedDetail<any>(detailId);
    expect(beforeReplay.detail.recordIds).toEqual([firstRecordId]);

    fake.setDetailFailure(null);
    const summary = await new OutboxReplayer({
      outbox: local.outbox,
      client: (service as any).client,
      onSettled: (item, data) => service.applyReplayedOutbox(item, data),
    }).replayOnce();
    expect(summary).toMatchObject({ settled: 1, remaining: 0 });
    expect(fake.details).toHaveLength(1);
    const cached = await local.getCachedDetail<any>(detailId);
    expect(cached.detail.recordIds).toEqual(expect.arrayContaining([firstRecordId, secondRecordId]));
    expect(cached.detail.recordIds).toHaveLength(2);
  });

  it('第 100 个 message 的显式证据不被 64 条 provenance 上限截断', async () => {
    const { service, fake } = await setup();
    const chunks = Array.from({ length: 100 }, (_, index) => ({
      role: 'user' as const,
      text: index === 99 ? '第 100 条直接证据' : `无关内容 ${index}`,
      messageId: `m_evidence_${index}`,
      chunkIndex: index,
    }));
    const result = await service.ingest({
      requestId: 'req_evidence_message_100',
      agentId: 'opencode',
      threadId: 'th_evidence_message_100',
      extractor: 'host',
      chunks,
      candidates: [{
        kind: 'observation',
        content: { content: '第 100 条直接证据' },
        sourceMessageIds: ['m_evidence_99'],
      }],
    });

    expect(result.data.detailIds).toHaveLength(1);
    expect(fake.details).toHaveLength(1);
    expect(fake.details[0]).toMatchObject({
      text: '第 100 条直接证据',
      messageId: 'm_evidence_99',
    });
  });

  it('completeExtraction I/O 期间维护等待，不提前删证据或覆盖最终状态', async () => {
    let clock = Date.UTC(2026, 0, 1);
    const { service, client, fake, local } = await setup(defaultSidecarPolicy(), { now: () => clock, extractionTtlMs: 40 * 24 * 60 * 60 * 1000 });
    const pending = await service.ingest({
      requestId: 'req_completion_maintenance_race',
      agentId: 'opencode',
      threadId: 'th_completion_maintenance_race',
      extractor: 'host',
      chunks: [{
        role: 'user',
        text: '等待回填的证据',
        messageId: 'm_completion_race',
        expiresAt: clock + 1_000,
      }],
    });
    let markWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => { markWriteStarted = resolve; });
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    jest.spyOn(client, 'write').mockImplementation(async (body: any) => {
      markWriteStarted();
      await writeGate;
      const item = body.items[0];
      fake.nodes.push({
        id: 'rec-completion-race',
        type: 'episode',
        kind: 'observation',
        domain: 'agent:opencode',
        ownerType: 'agent',
        ownerId: 'opencode',
        contentHash: 'race-hash',
        content: item.content,
        provenance: {},
      });
      return {
        ok: true,
        requestId: body.requestId,
        capabilityVersion: 1,
        status: 200,
        degraded: false,
        warnings: [],
        data: {
          results: [{
            clientItemId: item.clientItemId,
            status: 'created',
            id: 'rec-completion-race',
            type: 'episode',
            kind: 'observation',
            domain: 'agent:opencode',
          }],
          created: 1,
          duplicates: 0,
          failed: 0,
          partial: false,
        },
      } as any;
    });

    const completion = service.completeExtraction(pending.data.extraction.id, [{
      kind: 'observation',
      content: { content: '等待回填的证据' },
    }]);
    await writeStarted;
    clock += 1_001;
    let maintenanceDone = false;
    const maintenance = local.runMaintenance({
      now: clock,
      beforeStagingCleanup: (ids) => service.expireStagingDependencies(ids),
    }).finally(() => { maintenanceDone = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(maintenanceDone).toBe(false);
    expect(await local.store.listStagingChunks({ includeExpired: true })).toHaveLength(1);

    releaseWrite();
    const completed = await completion;
    await maintenance;
    expect(completed.extraction.status).toBe('completed');
    expect((await service.getExtraction(pending.data.extraction.id))?.status).toBe('completed');
    expect(fake.details).toHaveLength(1);
    expect(await local.outbox.stats()).toMatchObject({ items: 0 });
  });

  it('capability 配额淘汰后经真实 client HTTP 路径立即失效 Detail cache', async () => {
    const { service, fake, local } = await setup();
    await local.putCachedDetail('detail-evicted-by-quota', {
      detail: { text: 'old cached detail', expiresAt: 0, availability: ['available'] },
    });
    fake.setDetailEvicted(['detail-evicted-by-quota']);

    await service.ingest({ requestId: 'req_quota_cache_invalidation', ...preferenceRequest() });
    expect(await local.getCachedDetail('detail-evicted-by-quota')).toBeNull();
    expect(fake.detailRequests).toHaveLength(2);
  });

  it('staging 配额淘汰也立即使依赖抽取 failed', async () => {
    const { service, local } = await setup(defaultSidecarPolicy(), { stagingBytes: 4 });
    const pending = await service.ingest({
      requestId: 'req_quota_pending_a',
      agentId: 'opencode',
      threadId: 'th_quota_pending_a',
      extractor: 'host',
      chunks: [{ role: 'user', text: '1111', messageId: 'm_quota_a' }],
    });
    expect(pending.data.extraction.status).toBe('pending');

    await service.ingest({
      requestId: 'req_quota_pending_b',
      agentId: 'opencode',
      threadId: 'th_quota_pending_b',
      extractor: 'host',
      chunks: [{ role: 'user', text: '2222', messageId: 'm_quota_b' }],
    });
    const extraction = await service.getExtraction(pending.data.extraction.id);
    expect(extraction).toMatchObject({ status: 'failed', degraded: true });
    expect(extraction?.warnings).toContain('retention_expired');
    expect((await local.store.listStagingChunks()).map((chunk) => chunk.id)).not.toContain(
      pending.data.stagingChunkIds[0],
    );
  });

  it('重放权威回读异常不得被吞成 settled', async () => {
    const { service, client, fake, local } = await setup();
    fake.setDetailFailure({ status: 503, code: 'capability_unavailable', retryable: true });
    const queued = await service.ingest({ requestId: 'req_replay_readback_failure', ...preferenceRequest() });
    expect(queued.data.detail.queued).toBe(1);
    const item = (await local.outbox.list())[0]!;
    const itemBody = item.body as any;
    jest.spyOn(client, 'post').mockResolvedValue({
      data: {
        results: [{
          clientItemId: itemBody.items[0].clientItemId,
          status: 'created',
          id: 'detail-readback-failure',
          domain: 'user',
          detailKind: 'raw_chunk',
        }],
        created: 1,
        duplicates: 0,
        failed: 0,
        partial: false,
      },
    } as any);
    jest.spyOn(client, 'detailGet').mockRejectedValue(new CapabilityClientError(
      'capability_unavailable',
      'readback unavailable',
      { status: 0, retryable: true },
    ));
    const summary = await new OutboxReplayer({
      outbox: local.outbox,
      client,
      onSettled: (entry, data) => service.applyReplayedOutbox(entry, data),
    }).replayOnce();
    expect(summary).toMatchObject({ settled: 0, retried: 1, remaining: 1 });
    expect(await local.outbox.stats()).toMatchObject({ items: 1 });
  });

  it('Detail 空 results 在首次与重放中均不得 completed/settled 或删除证据', async () => {
    const { service, client, local } = await setup();
    jest.spyOn(client, 'detailWrite').mockResolvedValue({
      ok: true,
      requestId: 'req_detail_empty_results',
      capabilityVersion: 1,
      status: 200,
      degraded: false,
      warnings: [],
      data: { results: [], created: 0, duplicates: 0, failed: 0, partial: false },
    } as any);

    const first = await service.ingest({ requestId: 'req_detail_empty_results', ...preferenceRequest() });
    expect(first.status).toBe(202);
    expect(first.data.extraction.status).toBe('pending');
    expect(first.data.detail.queued).toBe(1);
    expect(await local.store.countStagingChunks()).toBe(1);
    expect(await local.outbox.stats()).toMatchObject({ items: 1 });

    jest.spyOn(client, 'post').mockResolvedValue({
      data: { results: [], created: 0, duplicates: 0, failed: 0, partial: false },
    } as any);
    const replayer = new OutboxReplayer({
      outbox: local.outbox,
      client,
      onSettled: (item, data) => service.applyReplayedOutbox(item, data),
    });
    const replayed = await replayer.replayOnce();
    expect(replayed).toMatchObject({ settled: 0, retried: 1, remaining: 1 });
    expect(await local.outbox.stats()).toMatchObject({ items: 1 });
    expect(await local.store.countStagingChunks()).toBe(1);
  });

  it('Detail 缺失 item 在首次与重放中保留活动项、staging 与已提交 ID', async () => {
    const { service, client, fake, local } = await setup();
    const original = client.detailWrite.bind(client);
    let firstClientItemId = '';
    let firstDetailId = '';
    const spy = jest.spyOn(client, 'detailWrite');
    spy.mockImplementationOnce(async (body: any, options: any) => {
      const firstItem = body.items[0];
      firstClientItemId = firstItem.clientItemId;
      const response = await original({ ...body, items: [firstItem] }, options);
      firstDetailId = response.data.results[0]!.id!;
      return {
        ...response,
        data: {
          ...response.data,
          results: response.data.results,
          created: 1,
          failed: 0,
          partial: false,
        },
      } as any;
    });
    const request = {
      agentId: 'opencode',
      threadId: 'th_detail_missing_item',
      extractor: 'host' as const,
      chunks: [
        { role: 'user' as const, text: '证据一', messageId: 'm_detail_missing_1' },
        { role: 'user' as const, text: '证据二', messageId: 'm_detail_missing_2' },
      ],
      candidates: [
        { kind: 'observation' as const, content: { content: '证据一' }, sourceMessageIds: ['m_detail_missing_1'] },
        { kind: 'observation' as const, content: { content: '证据二' }, sourceMessageIds: ['m_detail_missing_2'] },
      ],
    };
    const first = await service.ingest({ requestId: 'req_detail_missing_item', ...request });
    expect(first.status).toBe(202);
    expect(first.data.detailIds).toEqual([firstDetailId]);
    expect(first.data.extraction.status).toBe('pending');
    expect(first.data.detail.queued).toBe(1);
    expect(await local.store.countStagingChunks()).toBe(2);
    expect(await local.outbox.stats()).toMatchObject({ items: 1 });
    const outboxItem = (await local.outbox.list())[0]!;
    expect((outboxItem.body as any).items).toHaveLength(2);
    expect(outboxItem.requestId).toBe(fake.detailRequests[0]!.body.requestId);

    jest.spyOn(client, 'post').mockResolvedValue(({
      ok: true,
      requestId: 'req_detail_missing_replay',
      capabilityVersion: 1,
      status: 200,
      degraded: false,
      warnings: [],
      data: {
        results: [{
          clientItemId: firstClientItemId,
          status: 'duplicate',
          id: firstDetailId,
          domain: 'agent:opencode',
          detailKind: 'raw_chunk',
        }],
        created: 0,
        duplicates: 1,
        failed: 0,
        partial: false,
      },
    } as any));
    const replayed = await new OutboxReplayer({
      outbox: local.outbox,
      client,
      onSettled: (item, data) => service.applyReplayedOutbox(item, data),
    }).replayOnce();
    expect(replayed).toMatchObject({ settled: 0, retried: 1, remaining: 1 });
    expect(fake.details).toHaveLength(1);
    expect(await local.outbox.stats()).toMatchObject({ items: 1 });
    expect(await local.store.countStagingChunks()).toBe(2);
  });

  it('合法重复 clientItemId 的不同 domainHint 候选也可完成重放', async () => {
    const { service, client, fake, local } = await setup();
    fake.setFailure({ status: 503, code: 'capability_unavailable', retryable: true });
    await service.ingest({
      requestId: 'req_legal_duplicate_client_ids',
      agentId: 'opencode',
      threadId: 'th_legal_duplicate_client_ids',
      extractor: 'host',
      chunks: [{ role: 'user', text: '同域重复客户端身份', messageId: 'm_legal_duplicate' }],
      candidates: [
        { kind: 'observation', content: { content: '同域重复客户端身份' } },
        { kind: 'observation', domain: 'agent:opencode', content: { content: '同域重复客户端身份' } },
      ],
    });
    const item = (await local.outbox.list())[0]!;
    const ids = (item.body as any).items.map((entry: any) => entry.clientItemId);
    expect(ids[0]).toBe(ids[1]);
    fake.setFailure(null);

    const summary = await new OutboxReplayer({
      outbox: local.outbox,
      client,
      onSettled: (entry, data) => service.applyReplayedOutbox(entry, data),
    }).replayOnce();
    expect(summary).toMatchObject({ settled: 2, remaining: 0 });
    expect(await local.outbox.stats()).toMatchObject({ items: 0 });
  });

  it('MemoryRecord 重放按 clientItemId 覆盖，额外成功项不能顶替缺失项', async () => {
    const { service, fake, local } = await setup();
    fake.setFailure({ status: 503, code: 'capability_unavailable', retryable: true });
    await service.ingest({
      requestId: 'req_record_replay_identity',
      agentId: 'opencode',
      threadId: 'th_record_replay_identity',
      extractor: 'host',
      chunks: [
        { role: 'user', text: '身份一', messageId: 'm_record_identity_1' },
        { role: 'user', text: '身份二', messageId: 'm_record_identity_2' },
      ],
      candidates: [
        { kind: 'observation', content: { content: '身份一' }, sourceMessageIds: ['m_record_identity_1'] },
        { kind: 'observation', content: { content: '身份二' }, sourceMessageIds: ['m_record_identity_2'] },
      ],
    });
    const item = (await local.outbox.list())[0]!;
    const bodyItems = (item.body as any).items;
    for (const [id, itemBody] of [['rec-identity-first', bodyItems[0]], ['rec-identity-extra', bodyItems[1]]] as const) {
      fake.nodes.push({
        id,
        type: 'episode',
        kind: 'observation',
        domain: 'agent:opencode',
        ownerType: 'agent',
        ownerId: 'opencode',
        contentHash: `${id}-hash`,
        content: itemBody.content,
        provenance: {},
      });
    }
    fake.setFailure(null);
    const settled = await service.applyReplayedOutbox(item, {
      results: [
        {
          clientItemId: bodyItems[0].clientItemId,
          status: 'created',
          id: 'rec-identity-first',
          type: 'episode',
          kind: 'observation',
          domain: 'agent:opencode',
        },
        {
          clientItemId: 'cand_unexpected_extra',
          status: 'created',
          id: 'rec-identity-extra',
          type: 'episode',
          kind: 'observation',
          domain: 'agent:opencode',
        },
      ],
      created: 2,
      duplicates: 0,
      failed: 0,
      partial: false,
    });
    expect(settled).toBe(false);
    expect(fake.details.every((detail) => !detail.recordIds.includes('rec-identity-extra'))).toBe(true);
    expect(await local.outbox.stats()).toMatchObject({ items: 1 });
    expect(await local.store.countStagingChunks()).toBe(2);
    expect(await service.applyReplayedOutbox(item, {
      results: bodyItems.map((entry: any, index: number) => ({
        clientItemId: entry.clientItemId,
        status: index === 0 ? 'created' : 'duplicate',
        id: index === 0 ? 'rec-identity-first' : 'rec-identity-extra',
        type: 'episode',
        kind: 'observation',
        domain: 'agent:opencode',
      })),
      created: 2,
      failed: 1,
      partial: false,
    })).toBe(false);
  });

  it('record/detail 共享 staging 在 record 活动项结束前不得被 detail 提前清理', async () => {
    const { service, client, fake, local } = await setup();
    fake.setFailure({ status: 503, code: 'capability_unavailable', retryable: true });
    await service.ingest({
      requestId: 'req_shared_replay_dependencies',
      agentId: 'opencode',
      threadId: 'th_shared_replay_dependencies',
      extractor: 'host',
      chunks: [
        { role: 'user', text: '共享重放证据一', messageId: 'm_shared_replay_1' },
        { role: 'user', text: '共享重放证据二', messageId: 'm_shared_replay_2' },
      ],
      candidates: [
        { kind: 'observation', content: { content: '共享重放证据一' }, sourceMessageIds: ['m_shared_replay_1'] },
        { kind: 'observation', content: { content: '共享重放证据二' }, sourceMessageIds: ['m_shared_replay_2'] },
      ],
    });
    fake.setFailure(null);
    jest.spyOn(client, 'detailWrite').mockRejectedValueOnce(new CapabilityClientError(
      'capability_unavailable',
      'detail unavailable',
      { status: 503, retryable: true },
    ));
    const firstReplay = await new OutboxReplayer({
      outbox: local.outbox,
      client,
      onSettled: (item, data) => service.applyReplayedOutbox(item, data),
    }).replayOnce();
    expect(firstReplay.remaining).toBe(2);
    const detailItem = (await local.outbox.list()).find((item) => item.endpoint === '/detail')!;
    const recordItem = (await local.outbox.list()).find((item) => item.meta?.kind === 'record')!;

    const detailResponse = await client.post(detailItem.endpoint, detailItem.body, {
      idempotencyKey: detailItem.requestId,
      retries: 0,
    });
    expect(await service.applyReplayedOutbox(detailItem, detailResponse.data)).toBe(true);
    await local.outbox.completeReplay(detailItem.id, { outcome: 'settled' });
    expect(await local.store.countStagingChunks()).toBe(2);
    expect((await local.outbox.get(recordItem.id))).not.toBeNull();
    await local.outbox.recordAttempt(recordItem.id, { error: 'test_ready', retryDelayMs: 0 });

    const finalReplay = await new OutboxReplayer({
      outbox: local.outbox,
      client,
      onSettled: (item, data) => service.applyReplayedOutbox(item, data),
    }).replayOnce();
    expect(finalReplay).toMatchObject({ settled: 2, remaining: 0 });
    expect(await local.store.countStagingChunks()).toBe(0);
  });

  it('staging 缺失但 record 已提交时必须 dead 并披露已提交 IDs/对象', async () => {
    const { service, client, fake, local, home } = await setup();
    fake.setFailure({ status: 503, code: 'capability_unavailable', retryable: true });
    await service.ingest({ requestId: 'req_missing_staging_dead', ...preferenceRequest() });
    const ids = (await local.store.listStagingChunks()).map((chunk) => chunk.id);
    await local.clearStaging(ids);
    fake.setFailure(null);
    const summary = await new OutboxReplayer({
      outbox: local.outbox,
      client,
      onSettled: (item, data) => service.applyReplayedOutbox(item, data),
    }).replayOnce();
    expect(summary).toMatchObject({ settled: 0, dead: 1, remaining: 0 });
    expect(await local.outbox.deadCount()).toBe(1);
    expect(fake.nodes).toHaveLength(1);
    const committedRecord = fake.nodes[0]!;

    const deadFiles = await readdir(join(home, 'memory-runtime', 'outbox', 'dead'));
    expect(deadFiles).toHaveLength(1);
    const dead = JSON.parse(await readFile(
      join(home, 'memory-runtime', 'outbox', 'dead', deadFiles[0]!),
      'utf8',
    ));
    expect(dead.error).toBe('retention_expired');
    expect(dead.committed.records).toEqual([
      expect.objectContaining({
        id: committedRecord.id,
        domain: committedRecord.domain,
        kind: committedRecord.kind,
      }),
    ]);
  });

  it('Detail 永久部分失败显式 failed，披露已提交 ID 且保留全部仍需证据', async () => {
    const { service, client, local } = await setup();
    const original = client.detailWrite.bind(client);
    jest.spyOn(client, 'detailWrite').mockImplementationOnce(async (body: any, options: any) => {
      const response = await original({ ...body, items: [body.items[0]] }, options);
      return {
        ...response,
        data: {
          ...response.data,
          results: [
            response.data.results[0],
            {
              clientItemId: body.items[1].clientItemId,
              status: 'failed',
              domain: body.items[1].domain,
              detailKind: body.items[1].detailKind,
              code: 'validation_failed',
              retryable: false,
            },
          ],
          created: 1,
          failed: 1,
          partial: true,
        },
      } as any;
    });
    const result = await service.ingest({
      requestId: 'req_detail_permanent_partial',
      agentId: 'opencode',
      threadId: 'th_detail_permanent_partial',
      extractor: 'host',
      chunks: [
        { role: 'user', text: '永久部分一', messageId: 'm_detail_permanent_1' },
        { role: 'user', text: '永久部分二', messageId: 'm_detail_permanent_2' },
      ],
      candidates: [
        { kind: 'observation', content: { content: '永久部分一' }, sourceMessageIds: ['m_detail_permanent_1'] },
        { kind: 'observation', content: { content: '永久部分二' }, sourceMessageIds: ['m_detail_permanent_2'] },
      ],
    });

    expect(result.status).toBe(200);
    expect(result.data.extraction.status).toBe('failed');
    expect(result.data.detailIds).toHaveLength(1);
    expect(result.data.detail.failed).toBe(1);
    expect(result.data.warnings).toContain('detail_partial_settlement');
    expect(await local.store.countStagingChunks()).toBe(2);
    expect(await local.outbox.stats()).toMatchObject({ items: 0 });
  });

  it('MemoryRecord 同批 created+永久 failed 不得整体 completed 或清除 staging', async () => {
    const { service, client, fake, local } = await setup();
    jest.spyOn(client, 'write').mockImplementationOnce(async (body: any) => {
      const [first, second] = body.items;
      fake.nodes.push({
        id: 'rec-record-permanent-partial',
        type: 'episode',
        kind: 'observation',
        domain: 'agent:opencode',
        ownerType: 'agent',
        ownerId: 'opencode',
        contentHash: 'record-permanent-hash',
        content: first.content,
        provenance: {},
      });
      return {
        ok: true,
        requestId: body.requestId,
        capabilityVersion: 1,
        status: 200,
        degraded: false,
        warnings: [],
        data: {
          results: [
            {
              clientItemId: first.clientItemId,
              status: 'created',
              id: 'rec-record-permanent-partial',
              type: 'episode',
              kind: 'observation',
              domain: 'agent:opencode',
            },
            {
              clientItemId: second.clientItemId,
              status: 'failed',
              kind: 'observation',
              domain: 'agent:opencode',
              code: 'validation_failed',
              retryable: false,
            },
          ],
          created: 1,
          failed: 1,
          partial: true,
        },
      } as any;
    });
    const result = await service.ingest({
      requestId: 'req_record_permanent_partial',
      agentId: 'opencode',
      threadId: 'th_record_permanent_partial',
      extractor: 'host',
      chunks: [
        { role: 'user', text: '记录永久部分一', messageId: 'm_record_permanent_1' },
        { role: 'user', text: '记录永久部分二', messageId: 'm_record_permanent_2' },
      ],
      candidates: [
        { kind: 'observation', content: { content: '记录永久部分一' }, sourceMessageIds: ['m_record_permanent_1'] },
        { kind: 'observation', content: { content: '记录永久部分二' }, sourceMessageIds: ['m_record_permanent_2'] },
      ],
    });

    expect(result.status).toBe(200);
    expect(result.data.extraction.status).toBe('failed');
    expect(result.data.records.map((record) => record.id)).toEqual(['rec-record-permanent-partial']);
    expect(result.data.warnings).toContain('partial_settlement');
    expect(await local.store.countStagingChunks()).toBe(2);
    expect(await local.outbox.stats()).toMatchObject({ items: 0 });
  });

  it('新写入 chunk 被自身配额立即淘汰时不得返回 202 pending', async () => {
    const { service, local } = await setup(defaultSidecarPolicy(), { stagingBytes: 4 });
    await expect(service.ingest({
      requestId: 'req_staging_self_evicted',
      agentId: 'opencode',
      extractor: 'host',
      chunks: [{ role: 'user', text: '12345', messageId: 'm_staging_self_evicted' }],
    })).rejects.toMatchObject({ code: 'staging_write_failed', status: 503 });
    expect(await local.store.countStagingChunks()).toBe(0);
  });

  it('staging 写失败不得返回 202 pending；零证据回填显式 failed', async () => {
    const { service, local, fake } = await setup();
    jest.spyOn(local.store, 'putStagingChunk').mockRejectedValueOnce(new Error('EIO'));
    await expect(service.ingest({
      requestId: 'req_staging_write_failed',
      agentId: 'opencode',
      extractor: 'host',
      chunks: [{ role: 'user', text: '必须持久化后才能 pending', messageId: 'm_staging_failed' }],
    })).rejects.toMatchObject({ code: 'staging_write_failed', status: 503 });
    expect(fake.writeRequests).toHaveLength(0);
    expect(fake.detailRequests).toHaveLength(0);

    jest.restoreAllMocks();
    const pending = await service.ingest({
      requestId: 'req_zero_staging_completion',
      agentId: 'opencode',
      threadId: 'th_zero_staging_completion',
      extractor: 'host',
      chunks: [{ role: 'user', text: '随后移除全部证据', messageId: 'm_zero_staging' }],
    });
    const cacheKey = `extraction:v1:${pending.data.extraction.id}`;
    const stored = await local.cache.get<any>(cacheKey);
    stored.stagingChunkIds = [];
    stored.rawChunkIds = [];
    await local.cache.set(cacheKey, stored, { ttlMs: 1_000 });
    const completed = await service.completeExtraction(pending.data.extraction.id, [{
      kind: 'observation',
      content: { content: '没有证据不能完成' },
    }]);
    expect(completed.extraction.status).toBe('failed');
    expect(completed.queued).toBe(false);
    expect(fake.writeRequests).toHaveLength(0);
  });

  it('detail replay 收口 extraction 时合并 committed detailIds/records', async () => {
    const { service, fake, local } = await setup();
    const chunk = { role: 'user' as const, text: '详情收口证据 A B', messageId: 'm_finalize_detail', chunkIndex: 0 };
    await service.ingest({
      requestId: 'req_finalize_detail_first',
      agentId: 'opencode',
      threadId: 'th_finalize_detail',
      extractor: 'host',
      chunks: [chunk],
      candidates: [{
        kind: 'observation',
        content: { content: '详情收口证据 A' },
        sourceMessageIds: ['m_finalize_detail'],
      }],
    });
    fake.setDetailFailure({ status: 503, code: 'capability_unavailable', retryable: true });
    const queued = await service.ingest({
      requestId: 'req_finalize_detail_second',
      agentId: 'opencode',
      threadId: 'th_finalize_detail',
      extractor: 'host',
      chunks: [chunk],
      candidates: [{
        kind: 'observation',
        content: { content: '详情收口证据 B' },
        sourceMessageIds: ['m_finalize_detail'],
      }],
    });
    const extractionId = queued.data.extraction.id;
    const secondRecordId = queued.data.records[0]!.id;
    expect(queued.data.detail.queued).toBe(1);
    expect((await service.getExtraction(extractionId))?.detailIds).toEqual([]);

    fake.setDetailFailure(null);
    const summary = await new OutboxReplayer({
      outbox: local.outbox,
      client: (service as any).client,
      onSettled: (item, data) => service.applyReplayedOutbox(item, data),
    }).replayOnce();
    expect(summary).toMatchObject({ settled: 1, remaining: 0 });
    const view = await service.getExtraction(extractionId);
    expect(view).toMatchObject({ status: 'completed' });
    expect(view?.records.map((record) => record.id)).toContain(secondRecordId);
    expect(view?.detailIds).toContain(fake.details[0]!.id);
    expect(view?.degraded).toBe(false);
  });

  it('record replay 收口 extraction 时合并 committed records/detailIds', async () => {
    const { service, fake, local } = await setup();
    fake.setFailure({ status: 503, code: 'capability_unavailable', retryable: true });
    const queued = await service.ingest({
      requestId: 'req_finalize_record',
      agentId: 'opencode',
      threadId: 'th_finalize_record',
      extractor: 'host',
      chunks: [{ role: 'user', text: '记录收口证据', messageId: 'm_finalize_record' }],
      candidates: [{
        kind: 'observation',
        content: { content: '记录收口证据' },
        sourceMessageIds: ['m_finalize_record'],
      }],
    });
    const extractionId = queued.data.extraction.id;
    expect((await service.getExtraction(extractionId))?.records).toEqual([]);
    fake.setFailure(null);

    const summary = await new OutboxReplayer({
      outbox: local.outbox,
      client: (service as any).client,
      onSettled: (item, data) => service.applyReplayedOutbox(item, data),
    }).replayOnce();
    expect(summary).toMatchObject({ settled: 1, remaining: 0 });
    const view = await service.getExtraction(extractionId);
    expect(view).toMatchObject({ status: 'completed' });
    expect(view?.records.map((record) => record.id)).toEqual([fake.nodes[0]!.id]);
    expect(view?.detailIds).toContain(fake.details[0]!.id);
  });

  it('存在 dead Detail 依赖时后续成功重放不得把 extraction 收口为 completed', async () => {
    const { service, fake, local } = await setup();
    fake.setFailure({ status: 503, code: 'capability_unavailable', retryable: true });
    const queued = await service.ingest({
      requestId: 'req_finalize_dead_dependency',
      agentId: 'opencode',
      threadId: 'th_finalize_dead_dependency',
      extractor: 'host',
      chunks: [{ role: 'user', text: 'dead 依赖证据', messageId: 'm_finalize_dead' }],
      candidates: [{
        kind: 'observation',
        content: { content: 'dead 依赖证据' },
        sourceMessageIds: ['m_finalize_dead'],
      }],
    });
    const extractionId = queued.data.extraction.id;
    await local.outbox.enqueue({
      id: 'ob_finalize_dead_detail',
      requestId: 'req_finalize_dead_detail',
      endpoint: '/detail',
      body: { items: [] },
      meta: { kind: 'detail', extractionIds: [extractionId] },
    });
    expect(await local.outbox.deadLetter('ob_finalize_dead_detail', 'validation_failed')).toBe(true);
    fake.setFailure(null);

    const summary = await new OutboxReplayer({
      outbox: local.outbox,
      client: (service as any).client,
      onSettled: (item, data) => service.applyReplayedOutbox(item, data),
    }).replayOnce();
    expect(summary).toMatchObject({ settled: 1, remaining: 0 });
    const view = await service.getExtraction(extractionId);
    expect(view).toMatchObject({ status: 'failed', degraded: true });
    expect(view?.warnings).toContain('replay_dead_dependency');
    expect(view?.records.map((record) => record.id)).toEqual([fake.nodes[0]!.id]);
  });

  it('仍有活动 Detail 依赖时 extraction 保持 pending，不被成功记录重放提前 completed', async () => {
    const { service, fake, local } = await setup();
    fake.setFailure({ status: 503, code: 'capability_unavailable', retryable: true });
    const queued = await service.ingest({
      requestId: 'req_finalize_partial_dependency',
      agentId: 'opencode',
      threadId: 'th_finalize_partial_dependency',
      extractor: 'host',
      chunks: [{ role: 'user', text: 'partial 依赖证据', messageId: 'm_finalize_partial' }],
      candidates: [{
        kind: 'observation',
        content: { content: 'partial 依赖证据' },
        sourceMessageIds: ['m_finalize_partial'],
      }],
    });
    const extractionId = queued.data.extraction.id;
    const recordItem = (await local.outbox.list())[0]!;
    await local.outbox.enqueue({
      id: 'ob_finalize_partial_detail',
      requestId: 'req_finalize_partial_detail',
      endpoint: '/detail',
      body: { items: [] },
      meta: { kind: 'detail', extractionIds: [extractionId] },
    });
    await service.finalizeReplayedOutbox(recordItem, 'settled');

    const view = await service.getExtraction(extractionId);
    expect(view).toMatchObject({ status: 'pending', degraded: true });
    expect(view?.warnings).toContain('replay_dependency_pending');
  });

  it('无 chunks 的 candidate-only ingest 离线排队，重启后重放仍能收口 extraction', async () => {
    const { home, service, fake, local } = await setup();
    fake.setFailure({ status: 503, code: 'capability_unavailable', retryable: true });
    const queued = await service.ingest({
      requestId: 'req_candidate_only_queue',
      agentId: 'opencode',
      threadId: 'th_candidate_only',
      extractor: 'host',
      chunks: [],
      candidates: [{
        kind: 'observation',
        content: { content: 'candidate only 记录' },
      }],
    });
    expect(queued.status).toBe(202);
    expect(queued.data.stagingChunkIds).toEqual([]);
    const extractionId = queued.data.extraction.id;
    const queuedOutbox = await local.outbox.list();
    expect(queuedOutbox).toHaveLength(1);
    expect(queuedOutbox[0]!.meta?.extractionIds).toContain(extractionId);

    const restartedLocal = new SidecarLocalLayer({ root: join(home, 'memory-runtime') });
    await restartedLocal.init();
    const restartedClient = new CapabilityClient({
      baseUrl: fake.baseUrl,
      token: 'cap-token',
      retries: 0,
      retryDelayMs: 0,
    });
    const restarted = new IngestService({
      config: defaultSidecarConfig(),
      local: restartedLocal,
      client: restartedClient,
      identity: { cloudId: 'cl_test', profileId: 'default', hostId: 'h_test' },
      policy: defaultSidecarPolicy(),
    });
    await restarted.init();
    fake.setFailure(null);

    const summary = await new OutboxReplayer({
      outbox: restartedLocal.outbox,
      client: restartedClient,
      onSettled: (item, data) => restarted.applyReplayedOutbox(item, data),
      onComplete: (item, outcome) => restarted.finalizeReplayedOutbox(item, outcome),
    }).replayOnce();
    expect(summary).toMatchObject({ settled: 1, remaining: 0 });
    const view = await restarted.getExtraction(extractionId);
    expect(view).toMatchObject({ status: 'completed' });
    expect(view?.records.map((record) => record.id)).toEqual([fake.nodes[0]!.id]);
    expect(view?.detailIds).toEqual([]);
  });

  it('无 chunks 的 candidate-only 重放永久失败时 extraction 收口为 failed', async () => {
    const { service, fake, local } = await setup();
    fake.setFailure({ status: 503, code: 'capability_unavailable', retryable: true });
    const queued = await service.ingest({
      requestId: 'req_candidate_only_failure',
      agentId: 'opencode',
      threadId: 'th_candidate_only_failure',
      extractor: 'host',
      chunks: [],
      candidates: [{
        kind: 'observation',
        content: { content: 'candidate only 失败' },
      }],
    });
    const extractionId = queued.data.extraction.id;
    fake.setFailure({ status: 422, code: 'validation_failed', retryable: false });

    const summary = await new OutboxReplayer({
      outbox: local.outbox,
      client: (service as any).client,
      onSettled: (item, data) => service.applyReplayedOutbox(item, data),
      onComplete: (item, outcome) => service.finalizeReplayedOutbox(item, outcome),
    }).replayOnce();
    expect(summary).toMatchObject({ dead: 1, remaining: 0 });
    const view = await service.getExtraction(extractionId);
    expect(view).toMatchObject({ status: 'failed', degraded: true });
    expect(view?.warnings).toContain('replay_dead_dependency');
  });

  it('completeExtraction I/O 与 finalize(retry) 串行，completed 不回退为 pending', async () => {
    const { service, client, fake, local } = await setup();
    fake.setFailure({ status: 503, code: 'capability_unavailable', retryable: true });
    const queued = await service.ingest({
      requestId: 'req_finalize_race_retry',
      agentId: 'opencode',
      threadId: 'th_finalize_race_retry',
      extractor: 'host',
      chunks: [{ role: 'user', text: '并发 retry 证据', messageId: 'm_finalize_race_retry' }],
      candidates: [{
        kind: 'observation',
        content: { content: '并发 retry 记录' },
        sourceMessageIds: ['m_finalize_race_retry'],
      }],
    });
    const extractionId = queued.data.extraction.id;
    const outboxItem = (await local.outbox.list())[0]!;
    fake.setFailure(null);

    let markWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => { markWriteStarted = resolve; });
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    jest.spyOn(client, 'write').mockImplementationOnce(async (body: any) => {
      markWriteStarted();
      await writeGate;
      const item = body.items[0];
      fake.nodes.push({
        id: 'rec-finalize-race-retry',
        type: 'episode',
        kind: 'observation',
        domain: 'agent:opencode',
        ownerType: 'agent',
        ownerId: 'opencode',
        contentHash: 'finalize-race-retry',
        content: item.content,
        provenance: {},
      });
      return {
        ok: true,
        requestId: body.requestId,
        capabilityVersion: 1,
        status: 200,
        degraded: false,
        warnings: [],
        data: {
          results: [{
            clientItemId: item.clientItemId,
            status: 'created',
            id: 'rec-finalize-race-retry',
            type: 'episode',
            kind: 'observation',
            domain: 'agent:opencode',
          }],
          created: 1,
          duplicates: 0,
          failed: 0,
          partial: false,
        },
      } as any;
    });

    const completion = service.completeExtraction(extractionId, [{
      kind: 'observation',
      content: { content: '并发 retry 记录 B' },
      sourceMessageIds: ['m_finalize_race_retry'],
    }]);
    await writeStarted;
    const finalize = service.finalizeReplayedOutbox(outboxItem, 'retry');
    await new Promise((resolve) => setImmediate(resolve));
    expect((await service.getExtraction(extractionId))?.status).toBe('pending');
    releaseWrite();
    await completion;
    await finalize;
    const view = await service.getExtraction(extractionId);
    expect(view).toMatchObject({ status: 'completed' });
    expect(view?.records.map((record) => record.id)).toContain('rec-finalize-race-retry');
  });

  it('completeExtraction I/O 后 finalize 仍合并 committed records/details，不丢失收口', async () => {
    const { service, client, fake, local } = await setup();
    fake.setFailure({ status: 503, code: 'capability_unavailable', retryable: true });
    const queued = await service.ingest({
      requestId: 'req_finalize_race_merge',
      agentId: 'opencode',
      threadId: 'th_finalize_race_merge',
      extractor: 'host',
      chunks: [{ role: 'user', text: '并发 merge 证据', messageId: 'm_finalize_race_merge' }],
      candidates: [{
        kind: 'observation',
        content: { content: '并发 merge 记录' },
        sourceMessageIds: ['m_finalize_race_merge'],
      }],
    });
    const extractionId = queued.data.extraction.id;
    const outboxItem = (await local.outbox.list())[0]!;
    fake.setFailure(null);

    let markWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => { markWriteStarted = resolve; });
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    jest.spyOn(client, 'write').mockImplementationOnce(async (body: any) => {
      markWriteStarted();
      await writeGate;
      const item = body.items[0];
      fake.nodes.push({
        id: 'rec-finalize-race-merge',
        type: 'episode',
        kind: 'observation',
        domain: 'agent:opencode',
        ownerType: 'agent',
        ownerId: 'opencode',
        contentHash: 'finalize-race-merge',
        content: item.content,
        provenance: {},
      });
      return {
        ok: true,
        requestId: body.requestId,
        capabilityVersion: 1,
        status: 200,
        degraded: false,
        warnings: [],
        data: {
          results: [{
            clientItemId: item.clientItemId,
            status: 'created',
            id: 'rec-finalize-race-merge',
            type: 'episode',
            kind: 'observation',
            domain: 'agent:opencode',
          }],
          created: 1,
          duplicates: 0,
          failed: 0,
          partial: false,
        },
      } as any;
    });

    const completion = service.completeExtraction(extractionId, [{
      kind: 'observation',
      content: { content: '并发 merge 记录 B' },
      sourceMessageIds: ['m_finalize_race_merge'],
    }]);
    await writeStarted;
    const finalizeItem = {
      ...outboxItem,
      committed: {
        records: [{
          id: 'rec-finalize-race-committed',
          status: 'created',
          domain: 'agent:opencode',
          kind: 'observation',
        }],
        details: [{
          id: 'detail-finalize-race-committed',
          status: 'created',
          domain: 'agent:opencode',
          kind: 'raw_chunk',
        }],
      },
    };
    const finalize = service.finalizeReplayedOutbox(finalizeItem, 'settled');
    releaseWrite();
    await completion;
    await finalize;
    const view = await service.getExtraction(extractionId);
    expect(view).toMatchObject({ status: 'completed' });
    expect(view?.records.map((record) => record.id)).toEqual(expect.arrayContaining([
      'rec-finalize-race-merge',
      'rec-finalize-race-committed',
    ]));
    expect(view?.detailIds).toContain('detail-finalize-race-committed');
  });

  it('candidate-only 到期由 replayer 统一收口为 failed', async () => {
    let clock = Date.UTC(2026, 0, 1);
    const { service, fake, local } = await setup(defaultSidecarPolicy(), { now: () => clock, extractionTtlMs: 40 * 24 * 60 * 60 * 1000 });
    fake.setFailure({ status: 503, code: 'capability_unavailable', retryable: true });
    const queued = await service.ingest({
      requestId: 'req_candidate_only_deadline',
      agentId: 'opencode',
      threadId: 'th_candidate_only_deadline',
      extractor: 'host',
      chunks: [],
      candidates: [{ kind: 'observation', content: { content: 'candidate-only deadline' } }],
    });
    const extractionId = queued.data.extraction.id;
    fake.setFailure(null);
    clock += 31 * 24 * 60 * 60 * 1000;

    const summary = await new OutboxReplayer({
      outbox: local.outbox,
      client: (service as any).client,
      now: () => clock,
      onSettled: (item, data) => service.applyReplayedOutbox(item, data),
      onComplete: (item, outcome) => service.finalizeReplayedOutbox(item, outcome),
    }).replayOnce();
    expect(summary).toMatchObject({ dead: 1, remaining: 0 });
    const view = await service.getExtraction(extractionId);
    expect(view).toMatchObject({ status: 'failed', degraded: true });
    expect(view?.warnings).toContain('replay_dead_dependency');
  });

  it('candidate-only 被 cleanup 移入 dead 时统一收口为 failed', async () => {
    let clock = Date.UTC(2026, 0, 1);
    const { service, fake, local } = await setup(defaultSidecarPolicy(), { now: () => clock, extractionTtlMs: 40 * 24 * 60 * 60 * 1000 });
    fake.setFailure({ status: 503, code: 'capability_unavailable', retryable: true });
    const queued = await service.ingest({
      requestId: 'req_candidate_only_cleanup',
      agentId: 'opencode',
      threadId: 'th_candidate_only_cleanup',
      extractor: 'host',
      chunks: [],
      candidates: [{ kind: 'observation', content: { content: 'candidate-only cleanup' } }],
    });
    const extractionId = queued.data.extraction.id;
    clock += 31 * 24 * 60 * 60 * 1000;
    await local.cleanup(clock);

    const view = await service.getExtraction(extractionId);
    expect(view).toMatchObject({ status: 'failed', degraded: true });
    expect(view?.warnings).toContain('replay_dead_dependency');
    expect(await local.outbox.deadCount()).toBe(1);
  });

  it('staging 依赖缺失被 cleanup 收口时 extraction 显式 failed', async () => {
    let clock = Date.UTC(2026, 0, 1);
    const { service, fake, local } = await setup(defaultSidecarPolicy(), { now: () => clock, extractionTtlMs: 40 * 24 * 60 * 60 * 1000 });
    fake.setFailure({ status: 503, code: 'capability_unavailable', retryable: true });
    const queued = await service.ingest({
      requestId: 'req_cleanup_dependency_missing',
      agentId: 'opencode',
      threadId: 'th_cleanup_dependency_missing',
      extractor: 'host',
      chunks: [{ role: 'user', text: 'cleanup 依赖缺失', messageId: 'm_cleanup_dependency_missing' }],
      candidates: [{
        kind: 'observation',
        content: { content: 'cleanup 依赖缺失' },
        sourceMessageIds: ['m_cleanup_dependency_missing'],
      }],
    });
    const extractionId = queued.data.extraction.id;
    clock += 25 * 60 * 60 * 1000;
    await local.cleanup(clock);

    const view = await service.getExtraction(extractionId);
    expect(view).toMatchObject({ status: 'failed', degraded: true });
    expect(view?.warnings).toContain('replay_dead_dependency');
    expect(await local.store.countStagingChunks({ includeExpired: true })).toBe(0);
  });

  it('cleanup 先 dead 后 late success 保持 failed 终态，outbox 不留 dead 双态', async () => {
    let clock = Date.UTC(2026, 0, 1);
    const { service, client, fake, local } = await setup(defaultSidecarPolicy(), { now: () => clock, extractionTtlMs: 40 * 24 * 60 * 60 * 1000 });
    fake.setFailure({ status: 503, code: 'capability_unavailable', retryable: true });
    const queued = await service.ingest({
      requestId: 'req_late_success_cleanup',
      agentId: 'opencode',
      threadId: 'th_late_success_cleanup',
      extractor: 'host',
      chunks: [],
      candidates: [{ kind: 'observation', content: { content: 'cleanup late success' } }],
    });
    const extractionId = queued.data.extraction.id;
    fake.setFailure(null);

    const originalPost = client.post.bind(client);
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    jest.spyOn(client, 'post').mockImplementationOnce(async (endpoint: any, body: any, options: any) => {
      markStarted();
      await gate;
      return originalPost(endpoint, body, options);
    });
    const replay = new OutboxReplayer({
      outbox: local.outbox,
      client,
      now: () => clock,
      onSettled: (item, data) => service.applyReplayedOutbox(item, data),
      onComplete: (item, outcome) => service.finalizeReplayedOutbox(item, outcome),
    }).replayOnce();
    await started;

    clock += 31 * 24 * 60 * 60 * 1000;
    await local.cleanup(clock);
    expect((await service.getExtraction(extractionId))?.status).toBe('failed');
    expect(await local.outbox.deadCount()).toBe(1);

    release();
    expect(await replay).toMatchObject({ settled: 1, dead: 0, remaining: 0 });
    const view = await service.getExtraction(extractionId);
    expect(view).toMatchObject({ status: 'failed' });
    expect(await local.outbox.stats()).toMatchObject({ items: 0 });
    expect(await local.outbox.deadStats()).toMatchObject({ items: 0 });
  });

  it('同 id 旧 dead 副本不覆盖重新入队的 active 成功项', async () => {
    const { service, fake, local } = await setup();
    fake.setFailure({ status: 503, code: 'capability_unavailable', retryable: true });
    const queued = await service.ingest({
      requestId: 'req_old_dead_same_id',
      agentId: 'opencode',
      threadId: 'th_old_dead_same_id',
      extractor: 'host',
      chunks: [],
      candidates: [{ kind: 'observation', content: { content: 'old dead same id' } }],
    });
    const extractionId = queued.data.extraction.id;
    const item = (await local.outbox.list())[0]!;
    expect(await local.outbox.deadLetter(item.id, 'validation_failed')).toBe(true);
    await local.outbox.enqueue({
      id: item.id,
      requestId: item.requestId,
      endpoint: item.endpoint,
      body: item.body,
      createdAt: item.createdAt,
      ...(item.meta ? { meta: item.meta } : {}),
    });
    fake.setFailure(null);

    const summary = await new OutboxReplayer({
      outbox: local.outbox,
      client: (service as any).client,
      onSettled: (itemValue, data) => service.applyReplayedOutbox(itemValue, data),
      onComplete: (itemValue, outcome) => service.finalizeReplayedOutbox(itemValue, outcome),
    }).replayOnce();
    expect(summary).toMatchObject({ settled: 1, dead: 0, remaining: 0 });
    const view = await service.getExtraction(extractionId);
    expect(view).toMatchObject({ status: 'completed' });
    expect(view?.warnings).not.toContain('replay_dead_dependency');
    expect(await local.outbox.deadCount()).toBe(0);
  });

  it('completed 收口清除 replay pending/dead 旧 warning', async () => {
    const { service, fake, local } = await setup();
    fake.setFailure({ status: 503, code: 'capability_unavailable', retryable: true });
    const queued = await service.ingest({
      requestId: 'req_warning_cleanup',
      agentId: 'opencode',
      threadId: 'th_warning_cleanup',
      extractor: 'host',
      chunks: [],
      candidates: [{ kind: 'observation', content: { content: 'warning cleanup' } }],
    });
    const extractionId = queued.data.extraction.id;
    const item = (await local.outbox.list())[0]!;
    await service.finalizeReplayedOutbox(item, 'retry');
    let view = await service.getExtraction(extractionId);
    expect(view?.warnings).toContain('replay_dependency_pending');

    fake.setFailure(null);
    const summary = await new OutboxReplayer({
      outbox: local.outbox,
      client: (service as any).client,
      onSettled: (itemValue, data) => service.applyReplayedOutbox(itemValue, data),
      onComplete: (itemValue, outcome) => service.finalizeReplayedOutbox(itemValue, outcome),
    }).replayOnce();
    expect(summary).toMatchObject({ settled: 1, remaining: 0 });
    view = await service.getExtraction(extractionId);
    expect(view).toMatchObject({ status: 'completed' });
    expect(view?.warnings).not.toContain('replay_dependency_pending');
    expect(view?.warnings).not.toContain('replay_dead_dependency');
  });

  it('failed 终态不会被其他 outbox 成功升级为 completed', async () => {
    const { service, fake, local } = await setup();
    fake.setFailure({ status: 503, code: 'capability_unavailable', retryable: true });
    const queued = await service.ingest({
      requestId: 'req_terminal_failed',
      agentId: 'opencode',
      threadId: 'th_terminal_failed',
      extractor: 'host',
      chunks: [],
      candidates: [{ kind: 'observation', content: { content: 'terminal failed' } }],
    });
    const extractionId = queued.data.extraction.id;
    const first = (await local.outbox.list())[0]!;
    await local.outbox.completeReplay(first.id, { outcome: 'dead', error: 'retention_expired' });
    await service.finalizeReplayedOutbox(first, 'dead');
    expect((await service.getExtraction(extractionId))?.status).toBe('failed');

    await local.outbox.enqueue({
      id: 'ob_terminal_failed_other',
      requestId: 'req_terminal_failed_other',
      endpoint: '/write',
      body: first.body,
      createdAt: Date.now(),
      ...(first.meta ? { meta: first.meta } : {}),
    });
    fake.setFailure(null);
    const summary = await new OutboxReplayer({
      outbox: local.outbox,
      client: (service as any).client,
      onSettled: (item, data) => service.applyReplayedOutbox(item, data),
      onComplete: (item, outcome) => service.finalizeReplayedOutbox(item, outcome),
    }).replayOnce();
    expect(summary).toMatchObject({ settled: 1, remaining: 0 });
    expect((await service.getExtraction(extractionId))?.status).toBe('failed');
  });

  it('completed 终态不会被旧 retry 回退为 pending/failed', async () => {
    const { service, fake, local } = await setup();
    fake.setFailure({ status: 503, code: 'capability_unavailable', retryable: true });
    const queued = await service.ingest({
      requestId: 'req_terminal_completed',
      agentId: 'opencode',
      threadId: 'th_terminal_completed',
      extractor: 'host',
      chunks: [],
      candidates: [{ kind: 'observation', content: { content: 'terminal completed' } }],
    });
    const extractionId = queued.data.extraction.id;
    const item = (await local.outbox.list())[0]!;
    fake.setFailure(null);
    const summary = await new OutboxReplayer({
      outbox: local.outbox,
      client: (service as any).client,
      onSettled: (itemValue, data) => service.applyReplayedOutbox(itemValue, data),
      onComplete: (itemValue, outcome) => service.finalizeReplayedOutbox(itemValue, outcome),
    }).replayOnce();
    expect(summary).toMatchObject({ settled: 1, remaining: 0 });
    expect((await service.getExtraction(extractionId))?.status).toBe('completed');

    await service.finalizeReplayedOutbox(item, 'retry');
    const view = await service.getExtraction(extractionId);
    expect(view).toMatchObject({ status: 'completed' });
    expect(view?.warnings).not.toContain('replay_dependency_pending');
  });

  it('pending record + 永久 Detail 失败，record replay 成功后 extraction 仍 failed', async () => {
    const { service, client, fake, local } = await setup();
    jest.spyOn(client, 'detailWrite').mockImplementationOnce(async (body: any) => ({
      ok: true,
      requestId: 'req_permanent_detail_first',
      capabilityVersion: 1,
      status: 200,
      degraded: false,
      warnings: [],
      data: {
        results: [{
          clientItemId: body.items[0].clientItemId,
          status: 'failed',
          domain: 'agent:opencode',
          detailKind: 'raw_chunk',
          code: 'validation_failed',
          retryable: false,
        }],
        created: 0,
        duplicates: 0,
        failed: 1,
        partial: true,
      },
    } as any));
    jest.spyOn(client, 'write').mockImplementationOnce(async (body: any) => {
      const [first, second] = body.items;
      fake.nodes.push({
        id: 'rec-permanent-detail-first',
        type: 'episode',
        kind: 'observation',
        domain: 'agent:opencode',
        ownerType: 'agent',
        ownerId: 'opencode',
        contentHash: 'permanent-detail-first',
        content: first.content,
        provenance: {},
      });
      return {
        ok: true,
        requestId: body.requestId,
        capabilityVersion: 1,
        status: 200,
        degraded: false,
        warnings: [],
        data: {
          results: [
            {
              clientItemId: first.clientItemId,
              status: 'created',
              id: 'rec-permanent-detail-first',
              type: 'episode',
              kind: 'observation',
              domain: 'agent:opencode',
            },
            {
              clientItemId: second.clientItemId,
              status: 'failed',
              kind: 'observation',
              domain: 'agent:opencode',
              code: 'capability_unavailable',
              retryable: true,
            },
          ],
          created: 1,
          duplicates: 0,
          failed: 1,
          partial: true,
        },
      } as any;
    });
    const queued = await service.ingest({
      requestId: 'req_permanent_detail_first',
      agentId: 'opencode',
      threadId: 'th_permanent_detail',
      extractor: 'host',
      chunks: [{ role: 'user', text: '永久 Detail 失败证据', messageId: 'm_permanent_detail' }],
      candidates: [
        { kind: 'observation', content: { content: '永久 Detail 失败 A' }, sourceMessageIds: ['m_permanent_detail'] },
        { kind: 'observation', content: { content: '永久 Detail 失败 B' }, sourceMessageIds: ['m_permanent_detail'] },
      ],
    });
    const extractionId = queued.data.extraction.id;
    expect(queued.status).toBe(202);
    expect(queued.data.extraction.status).toBe('pending');
    expect(queued.data.warnings).toContain('detail_write_failed:validation_failed');

    fake.setFailure(null);
    const summary = await new OutboxReplayer({
      outbox: local.outbox,
      client,
      onSettled: (item, data) => service.applyReplayedOutbox(item, data),
      onComplete: (item, outcome) => service.finalizeReplayedOutbox(item, outcome),
    }).replayOnce();
    expect(summary).toMatchObject({ settled: 1, remaining: 0 });
    const view = await service.getExtraction(extractionId);
    expect(view).toMatchObject({ status: 'failed', degraded: true });
    expect(view?.warnings).toContain('detail_write_failed:validation_failed');
    expect(view?.records.map((record) => record.id)).toContain(fake.nodes[0]!.id);
  });

  it('finalize cache 写失败持久化 needsFinalize，重启后恢复 failed', async () => {
    const { home, service, fake, local } = await setup();
    fake.setFailure({ status: 503, code: 'capability_unavailable', retryable: true });
    const queued = await service.ingest({
      requestId: 'req_finalize_cache_failure',
      agentId: 'opencode',
      threadId: 'th_finalize_cache_failure',
      extractor: 'host',
      chunks: [],
      candidates: [{ kind: 'observation', content: { content: 'finalize cache failure' } }],
    });
    const extractionId = queued.data.extraction.id;
    const item = (await local.outbox.list())[0]!;
    jest.spyOn(local.cache, 'set').mockRejectedValueOnce(new Error('EIO'));
    await service.finalizeReplayedOutbox(item, 'dead');
    expect(service.lastErrorView?.code).toBe('finalize_failed');
    const marked = await local.outbox.get(item.id) ?? await local.outbox.getDead(item.id);
    expect(marked?.meta?.needsFinalize).toBe(true);
    expect((await service.getExtraction(extractionId))?.status).toBe('pending');
    jest.restoreAllMocks();
    service.stop();

    const restartedLocal = new SidecarLocalLayer({ root: join(home, 'memory-runtime') });
    await restartedLocal.init();
    const restartedClient = new CapabilityClient({
      baseUrl: fake.baseUrl,
      token: 'cap-token',
      retries: 0,
      retryDelayMs: 0,
    });
    const restarted = new IngestService({
      config: defaultSidecarConfig(),
      local: restartedLocal,
      client: restartedClient,
      identity: { cloudId: 'cl_test', profileId: 'default', hostId: 'h_test' },
      policy: defaultSidecarPolicy(),
    });
    await restarted.init();
    expect((await restarted.getExtraction(extractionId))?.status).toBe('failed');
    const recovered = await restartedLocal.outbox.get(item.id)
      ?? await restartedLocal.outbox.getDead(item.id);
    expect(recovered?.meta?.needsFinalize).not.toBe(true);
  });

  it('putStagingChunk 依赖淘汰等待终态落盘，立即读取即 failed', async () => {
    const { service, fake, local } = await setup(defaultSidecarPolicy(), { stagingBytes: 4 });
    fake.setFailure({ status: 503, code: 'capability_unavailable', retryable: true });
    const queued = await service.ingest({
      requestId: 'req_put_staging_wait_finalize',
      agentId: 'opencode',
      threadId: 'th_put_staging_wait_finalize',
      extractor: 'host',
      chunks: [{ role: 'user', text: 'AAAA', messageId: 'm_put_staging_wait' }],
      candidates: [{
        kind: 'observation',
        content: { content: 'put staging wait finalize' },
        sourceMessageIds: ['m_put_staging_wait'],
      }],
    });
    const extractionId = queued.data.extraction.id;
    const originalSet = local.cache.set.bind(local.cache);
    jest.spyOn(local.cache, 'set').mockImplementation(async (...args: any[]) => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return (originalSet as any)(...args);
    });
    const text = 'BBBBBB';
    await local.putStagingChunk('cl_test', {
      schema: 1,
      id: 'rc_put_staging_wait_new',
      threadId: 'th_put_staging_wait_finalize',
      agentId: 'opencode',
      hostId: 'h_test',
      role: 'user',
      text,
      mime: 'text/plain',
      at: Date.now(),
      contentHash: sha256Hex(text),
      redaction: { applied: false, rules: [] },
      expiresAt: Date.now() + 60_000,
    });
    jest.restoreAllMocks();
    expect((await service.getExtraction(extractionId))?.status).toBe('failed');
  });

  it('finalize cache 失败后 successful settle 删除 active，重启仍能 completed', async () => {
    const { home, service, client, fake, local } = await setup();
    fake.setFailure({ status: 503, code: 'capability_unavailable', retryable: true });
    const queued = await service.ingest({
      requestId: 'req_finalize_after_settle',
      agentId: 'opencode',
      threadId: 'th_finalize_after_settle',
      extractor: 'host',
      chunks: [],
      candidates: [{ kind: 'observation', content: { content: 'finalize after settle' } }],
    });
    const extractionId = queued.data.extraction.id;
    fake.setFailure(null);
    jest.spyOn(local.cache, 'set').mockRejectedValueOnce(new Error('EIO'));

    const summary = await new OutboxReplayer({
      outbox: local.outbox,
      client,
      onSettled: (item, data) => service.applyReplayedOutbox(item, data),
      onComplete: (item, outcome) => service.finalizeReplayedOutbox(item, outcome),
    }).replayOnce();
    expect(summary).toMatchObject({ settled: 1, remaining: 0 });
    expect(await local.outbox.stats()).toMatchObject({ items: 0 });
    const pending = await local.outbox.listNeedsFinalize();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.outcome).toBe('settled');
    expect((await service.getExtraction(extractionId))?.status).toBe('pending');
    jest.restoreAllMocks();
    service.stop();

    const restartedLocal = new SidecarLocalLayer({ root: join(home, 'memory-runtime') });
    await restartedLocal.init();
    const restartedClient = new CapabilityClient({
      baseUrl: fake.baseUrl,
      token: 'cap-token',
      retries: 0,
      retryDelayMs: 0,
    });
    const restarted = new IngestService({
      config: defaultSidecarConfig(),
      local: restartedLocal,
      client: restartedClient,
      identity: { cloudId: 'cl_test', profileId: 'default', hostId: 'h_test' },
      policy: defaultSidecarPolicy(),
    });
    await restarted.init();
    expect((await restarted.getExtraction(extractionId))?.status).toBe('completed');
    expect(await restartedLocal.outbox.listNeedsFinalize()).toHaveLength(0);
  });

  it('finalize 连续 3 次失败后 exhausted 可见、无 timer，重启可恢复', async () => {
    const { home, service, fake, local } = await setup();
    fake.setFailure({ status: 503, code: 'capability_unavailable', retryable: true });
    const queued = await service.ingest({
      requestId: 'req_finalize_exhausted',
      agentId: 'opencode',
      threadId: 'th_finalize_exhausted',
      extractor: 'host',
      chunks: [],
      candidates: [{ kind: 'observation', content: { content: 'finalize exhausted' } }],
    });
    const extractionId = queued.data.extraction.id;
    const item = (await local.outbox.list())[0]!;
    jest.spyOn(local.cache, 'set').mockRejectedValue(new Error('EIO'));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await service.finalizeReplayedOutbox(item, 'dead');
    }
    const status = service.reconciliationStatus();
    expect(status).toMatchObject({
      pending: 1,
      exhausted: 1,
      timerActive: false,
      stopped: false,
    });
    expect(service.lastErrorView?.code).toBe('finalize_exhausted');
    expect(service.stats()).toMatchObject({
      degraded: true,
      finalizePending: 1,
      finalizeExhausted: 1,
    });
    expect(await local.outbox.listNeedsFinalize()).toHaveLength(1);
    jest.restoreAllMocks();
    service.stop();

    const restartedLocal = new SidecarLocalLayer({ root: join(home, 'memory-runtime') });
    await restartedLocal.init();
    const restartedClient = new CapabilityClient({
      baseUrl: fake.baseUrl,
      token: 'cap-token',
      retries: 0,
      retryDelayMs: 0,
    });
    const restarted = new IngestService({
      config: defaultSidecarConfig(),
      local: restartedLocal,
      client: restartedClient,
      identity: { cloudId: 'cl_test', profileId: 'default', hostId: 'h_test' },
      policy: defaultSidecarPolicy(),
    });
    await restarted.init();
    expect((await restarted.getExtraction(extractionId))?.status).toBe('failed');
    expect(await restartedLocal.outbox.listNeedsFinalize()).toHaveLength(0);
    expect(restarted.reconciliationStatus()).toMatchObject({ pending: 0, exhausted: 0 });
  });

  it('retryable Detail 失败（detail_confirmation_failed/http_401）后续成功不得锁死 failed', async () => {
    for (const code of ['detail_confirmation_failed', 'http_401']) {
      const { service, client, fake, local } = await setup();
      jest.spyOn(client, 'detailWrite').mockImplementationOnce(async (body: any) => ({
        ok: true,
        requestId: `req_retryable_${code}`,
        capabilityVersion: 1,
        status: 200,
        degraded: false,
        warnings: [],
        data: {
          results: [{
            clientItemId: body.items[0].clientItemId,
            status: 'failed',
            domain: 'agent:opencode',
            detailKind: 'raw_chunk',
            code,
            retryable: true,
          }],
          created: 0,
          duplicates: 0,
          failed: 1,
          partial: true,
        },
      } as any));
      jest.spyOn(client, 'write').mockImplementationOnce(async (body: any) => {
        const [first, second] = body.items;
        fake.nodes.push({
          id: `rec-retryable-${code}`,
          type: 'episode',
          kind: 'observation',
          domain: 'agent:opencode',
          ownerType: 'agent',
          ownerId: 'opencode',
          contentHash: `retryable-${code}`,
          content: first.content,
          provenance: {},
        });
        return {
          ok: true,
          requestId: body.requestId,
          capabilityVersion: 1,
          status: 200,
          degraded: false,
          warnings: [],
          data: {
            results: [
              {
                clientItemId: first.clientItemId,
                status: 'created',
                id: `rec-retryable-${code}`,
                type: 'episode',
                kind: 'observation',
                domain: 'agent:opencode',
              },
              {
                clientItemId: second.clientItemId,
                status: 'failed',
                kind: 'observation',
                domain: 'agent:opencode',
                code: 'capability_unavailable',
                retryable: true,
              },
            ],
            created: 1,
            duplicates: 0,
            failed: 1,
            partial: true,
          },
        } as any;
      });
      const queued = await service.ingest({
        requestId: `req_retryable_${code}`,
        agentId: 'opencode',
        threadId: `th_retryable_${code}`,
        extractor: 'host',
        chunks: [{ role: 'user', text: `retryable ${code}`, messageId: `m_retryable_${code}` }],
        candidates: [
          { kind: 'observation', content: { content: `retryable ${code} A` }, sourceMessageIds: [`m_retryable_${code}`] },
          { kind: 'observation', content: { content: `retryable ${code} B` }, sourceMessageIds: [`m_retryable_${code}`] },
        ],
      });
      const extractionId = queued.data.extraction.id;
      expect(queued.status).toBe(202);
      expect(queued.data.extraction.status).toBe('pending');
      fake.setFailure(null);

      const summary = await new OutboxReplayer({
        outbox: local.outbox,
        client,
        onSettled: (item, data) => service.applyReplayedOutbox(item, data),
        onComplete: (item, outcome) => service.finalizeReplayedOutbox(item, outcome),
      }).replayOnce();
      expect(summary.remaining).toBe(0);
      expect((await service.getExtraction(extractionId))?.status).toBe('completed');
    }
  });

  it('finalize 恢复成功后清理 lastError/degraded/timer', async () => {
    const { service, fake, local } = await setup();
    fake.setFailure({ status: 503, code: 'capability_unavailable', retryable: true });
    await service.ingest({
      requestId: 'req_finalize_recovery_state',
      agentId: 'opencode',
      threadId: 'th_finalize_recovery_state',
      extractor: 'host',
      chunks: [],
      candidates: [{ kind: 'observation', content: { content: 'finalize recovery state' } }],
    });
    const item = (await local.outbox.list())[0]!;
    await local.outbox.completeReplay(item.id, { outcome: 'dead', error: 'retention_expired' });
    jest.spyOn(local.cache, 'set').mockRejectedValueOnce(new Error('EIO'));
    await service.finalizeReplayedOutbox(await local.outbox.getDead(item.id) ?? item, 'dead');
    expect(service.lastErrorView?.code).toBe('finalize_failed');
    expect(service.reconciliationStatus().timerActive).toBe(true);
    jest.restoreAllMocks();

    await service.reconcileReplayFinalizations();
    expect(service.lastErrorView).toBeNull();
    expect(service.reconciliationStatus()).toMatchObject({
      pending: 0,
      exhausted: 0,
      timerActive: false,
    });
    expect(service.stats()).toMatchObject({ degraded: false });
  });

  it('stop 清除 finalize timer 且不再产生收口写入', async () => {
    const { service, fake, local } = await setup();
    fake.setFailure({ status: 503, code: 'capability_unavailable', retryable: true });
    const queued = await service.ingest({
      requestId: 'req_finalize_stop',
      agentId: 'opencode',
      threadId: 'th_finalize_stop',
      extractor: 'host',
      chunks: [],
      candidates: [{ kind: 'observation', content: { content: 'finalize stop' } }],
    });
    const extractionId = queued.data.extraction.id;
    const item = (await local.outbox.list())[0]!;
    jest.spyOn(local.cache, 'set').mockRejectedValueOnce(new Error('EIO'));
    await service.finalizeReplayedOutbox(item, 'dead');
    expect(service.reconciliationStatus().timerActive).toBe(true);
    service.stop();
    expect(service.reconciliationStatus()).toMatchObject({
      timerActive: false,
      stopped: true,
    });
    jest.restoreAllMocks();
    const markersBefore = await local.outbox.listNeedsFinalize();
    expect(markersBefore).toHaveLength(1);
    await service.finalizeReplayedOutbox(item, 'settled');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await local.outbox.listNeedsFinalize()).toHaveLength(1);
    expect((await service.getExtraction(extractionId))?.status).toBe('pending');
  });

  it('SettlementRuntime.stop 先 flush replayer，pending success 收口后重启仍 completed', async () => {
    const { home, client, fake, local } = await setup();
    const runtime = new SettlementRuntime({
      config: defaultSidecarConfig(),
      local,
      client,
      identity: { cloudId: 'cl_test', profileId: 'default', hostId: 'h_test' },
      policy: defaultSidecarPolicy(),
      autoStartReplayer: false,
    });
    await runtime.init();
    fake.setFailure({ status: 503, code: 'capability_unavailable', retryable: true });
    const queued = await runtime.handleIngest({
      requestId: 'req_runtime_stop_flush',
      agentId: 'opencode',
      threadId: 'th_runtime_stop_flush',
      extractor: 'host',
      chunks: [],
      candidates: [{ kind: 'observation', content: { content: 'runtime stop flush' } }],
    });
    const extractionId = queued.data.extraction.id;
    fake.setFailure(null);

    await runtime.stop();
    expect((await runtime.ingest.getExtraction(extractionId))?.status).toBe('completed');
    expect(await local.outbox.listNeedsFinalize()).toHaveLength(0);

    const restartedLocal = new SidecarLocalLayer({ root: join(home, 'memory-runtime') });
    await restartedLocal.init();
    const restartedClient = new CapabilityClient({
      baseUrl: fake.baseUrl,
      token: 'cap-token',
      retries: 0,
      retryDelayMs: 0,
    });
    const restarted = new IngestService({
      config: defaultSidecarConfig(),
      local: restartedLocal,
      client: restartedClient,
      identity: { cloudId: 'cl_test', profileId: 'default', hostId: 'h_test' },
      policy: defaultSidecarPolicy(),
    });
    await restarted.init();
    expect((await restarted.getExtraction(extractionId))?.status).toBe('completed');
  });

  it('stop 发生在 finalize cache 写入前时保留 marker，重启可恢复', async () => {
    const { home, service, fake, local } = await setup();
    fake.setFailure({ status: 503, code: 'capability_unavailable', retryable: true });
    const queued = await service.ingest({
      requestId: 'req_stop_race_finalize',
      agentId: 'opencode',
      threadId: 'th_stop_race_finalize',
      extractor: 'host',
      chunks: [],
      candidates: [{ kind: 'observation', content: { content: 'stop race finalize' } }],
    });
    const extractionId = queued.data.extraction.id;
    const item = (await local.outbox.list())[0]!;
    const originalGet = local.cache.get.bind(local.cache);
    let markReading!: () => void;
    const reading = new Promise<void>((resolve) => { markReading = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    jest.spyOn(local.cache, 'get').mockImplementationOnce(async (...args: any[]) => {
      markReading();
      await gate;
      return (originalGet as any)(...args);
    });
    const finalize = service.finalizeReplayedOutbox(item, 'dead');
    await reading;
    service.stop();
    release();
    await finalize;

    expect(await local.outbox.listNeedsFinalize()).toHaveLength(1);
    expect((await service.getExtraction(extractionId))?.status).toBe('pending');
    jest.restoreAllMocks();

    const restartedLocal = new SidecarLocalLayer({ root: join(home, 'memory-runtime') });
    await restartedLocal.init();
    const restartedClient = new CapabilityClient({
      baseUrl: fake.baseUrl,
      token: 'cap-token',
      retries: 0,
      retryDelayMs: 0,
    });
    const restarted = new IngestService({
      config: defaultSidecarConfig(),
      local: restartedLocal,
      client: restartedClient,
      identity: { cloudId: 'cl_test', profileId: 'default', hostId: 'h_test' },
      policy: defaultSidecarPolicy(),
    });
    await restarted.init();
    expect((await restarted.getExtraction(extractionId))?.status).toBe('failed');
    expect(await restartedLocal.outbox.listNeedsFinalize()).toHaveLength(0);
  });

  it('stop 后 cleanup/dead 转移仍先持久 marker，重启可收口', async () => {
    let clock = Date.UTC(2026, 0, 1);
    const { home, service, fake, local } = await setup(defaultSidecarPolicy(), {
      now: () => clock,
      extractionTtlMs: 40 * 24 * 60 * 60 * 1000,
    });
    fake.setFailure({ status: 503, code: 'capability_unavailable', retryable: true });
    const queued = await service.ingest({
      requestId: 'req_stop_cleanup_marker',
      agentId: 'opencode',
      threadId: 'th_stop_cleanup_marker',
      extractor: 'host',
      chunks: [],
      candidates: [{ kind: 'observation', content: { content: 'stop cleanup marker' } }],
    });
    const extractionId = queued.data.extraction.id;
    service.stop();
    clock += 31 * 24 * 60 * 60 * 1000;
    await local.cleanup(clock);
    expect(await local.outbox.deadCount()).toBe(1);
    expect(await local.outbox.listNeedsFinalize()).toHaveLength(1);

    const restartedLocal = new SidecarLocalLayer({
      root: join(home, 'memory-runtime'),
      now: () => clock,
    });
    await restartedLocal.init();
    const restartedClient = new CapabilityClient({
      baseUrl: fake.baseUrl,
      token: 'cap-token',
      retries: 0,
      retryDelayMs: 0,
    });
    const restarted = new IngestService({
      config: defaultSidecarConfig(),
      local: restartedLocal,
      client: restartedClient,
      identity: { cloudId: 'cl_test', profileId: 'default', hostId: 'h_test' },
      policy: defaultSidecarPolicy(),
      now: () => clock,
      extractionTtlMs: 40 * 24 * 60 * 60 * 1000,
    });
    await restarted.init();
    expect((await restarted.getExtraction(extractionId))?.status).toBe('failed');
  });

  it('marker 清理失败时保留 marker/timer/error，修复后才清状态', async () => {
    const { home, service, fake, local } = await setup();
    fake.setFailure({ status: 503, code: 'capability_unavailable', retryable: true });
    await service.ingest({
      requestId: 'req_marker_cleanup_failure',
      agentId: 'opencode',
      threadId: 'th_marker_cleanup_failure',
      extractor: 'host',
      chunks: [],
      candidates: [{ kind: 'observation', content: { content: 'marker cleanup failure' } }],
    });
    const item = (await local.outbox.list())[0]!;
    jest.spyOn(local.cache, 'set').mockRejectedValueOnce(new Error('EIO'));
    await service.finalizeReplayedOutbox(item, 'dead');
    jest.restoreAllMocks();
    service.stop();

    const restartedLocal = new SidecarLocalLayer({ root: join(home, 'memory-runtime') });
    await restartedLocal.init();
    const restartedClient = new CapabilityClient({
      baseUrl: fake.baseUrl,
      token: 'cap-token',
      retries: 0,
      retryDelayMs: 0,
    });
    const restarted = new IngestService({
      config: defaultSidecarConfig(),
      local: restartedLocal,
      client: restartedClient,
      identity: { cloudId: 'cl_test', profileId: 'default', hostId: 'h_test' },
      policy: defaultSidecarPolicy(),
    });
    const clearSpy = jest.spyOn(restartedLocal.outbox, 'clearFinalizeMarker')
      .mockResolvedValue(false);
    await restarted.reconcileReplayFinalizations();
    expect(restarted.lastErrorView?.code).toBe('finalize_cleanup_failed');
    expect(restarted.reconciliationStatus()).toMatchObject({ pending: 1, timerActive: true });
    expect(await restartedLocal.outbox.listNeedsFinalize()).toHaveLength(1);

    clearSpy.mockRestore();
    await restarted.reconcileReplayFinalizations();
    expect(restarted.lastErrorView).toBeNull();
    expect(restarted.reconciliationStatus()).toMatchObject({
      pending: 0,
      exhausted: 0,
      timerActive: false,
    });
    expect(await restartedLocal.outbox.listNeedsFinalize()).toHaveLength(0);
  });

  it('legacy warning 兼容：http_5xx 视为暂时、validation 仍永久', async () => {
    for (const warning of ['detail_write_failed:http_501', 'detail_write_failed:http_505', 'detail_write_failed:http_520']) {
      const { service, fake, local } = await setup();
      fake.setFailure({ status: 503, code: 'capability_unavailable', retryable: true });
      const queued = await service.ingest({
        requestId: `req_legacy_${warning.split(':')[1]}`,
        agentId: 'opencode',
        threadId: `th_legacy_${warning.split(':')[1]}`,
        extractor: 'host',
        chunks: [],
        candidates: [{ kind: 'observation', content: { content: `legacy ${warning}` } }],
      });
      const extractionId = queued.data.extraction.id;
      const cacheKey = `extraction:v1:${extractionId}`;
      const stored = await local.cache.get<any>(cacheKey);
      delete stored.detailFailures;
      stored.warnings = [...stored.warnings, warning];
      await local.cache.set(cacheKey, stored, { ttlMs: 60_000 });
      fake.setFailure(null);
      const summary = await new OutboxReplayer({
        outbox: local.outbox,
        client: (service as any).client,
        onSettled: (item, data) => service.applyReplayedOutbox(item, data),
        onComplete: (item, outcome) => service.finalizeReplayedOutbox(item, outcome),
      }).replayOnce();
      expect(summary.remaining).toBe(0);
      expect((await service.getExtraction(extractionId))?.status).toBe('completed');
    }

    const { service, fake, local } = await setup();
    fake.setFailure({ status: 503, code: 'capability_unavailable', retryable: true });
    const queued = await service.ingest({
      requestId: 'req_legacy_validation',
      agentId: 'opencode',
      threadId: 'th_legacy_validation',
      extractor: 'host',
      chunks: [],
      candidates: [{ kind: 'observation', content: { content: 'legacy validation' } }],
    });
    const extractionId = queued.data.extraction.id;
    const cacheKey = `extraction:v1:${extractionId}`;
    const stored = await local.cache.get<any>(cacheKey);
    delete stored.detailFailures;
    stored.warnings = [...stored.warnings, 'detail_write_failed:validation_failed'];
    await local.cache.set(cacheKey, stored, { ttlMs: 60_000 });
    fake.setFailure(null);
    await new OutboxReplayer({
      outbox: local.outbox,
      client: (service as any).client,
      onSettled: (item, data) => service.applyReplayedOutbox(item, data),
      onComplete: (item, outcome) => service.finalizeReplayedOutbox(item, outcome),
    }).replayOnce();
    expect((await service.getExtraction(extractionId))?.status).toBe('failed');
  });

  it('多个 marker 独立预算：一个 exhausted 不压制另一个的重试 timer', async () => {
    const { service, fake, local } = await setup();
    fake.setFailure({ status: 503, code: 'capability_unavailable', retryable: true });
    const first = await service.ingest({
      requestId: 'req_multi_marker_first',
      agentId: 'opencode',
      threadId: 'th_multi_marker_first',
      extractor: 'host',
      chunks: [],
      candidates: [{ kind: 'observation', content: { content: 'multi marker first' } }],
    });
    const second = await service.ingest({
      requestId: 'req_multi_marker_second',
      agentId: 'opencode',
      threadId: 'th_multi_marker_second',
      extractor: 'host',
      chunks: [],
      candidates: [{ kind: 'observation', content: { content: 'multi marker second' } }],
    });
    const items = await local.outbox.list();
    const firstItem = items.find((item) => item.meta?.extractionIds?.includes(first.data.extraction.id))!;
    const secondItem = items.find((item) => item.meta?.extractionIds?.includes(second.data.extraction.id))!;
    const firstKey = `extraction:v1:${first.data.extraction.id}`;
    const secondKey = `extraction:v1:${second.data.extraction.id}`;
    const realSet = local.cache.set.bind(local.cache);
    let failFirst = true;
    let failSecondOnce = true;
    jest.spyOn(local.cache, 'set').mockImplementation(async (...args: any[]) => {
      const key = args[0];
      if (key === firstKey && failFirst) throw new Error('EIO-first');
      if (key === secondKey && failSecondOnce) {
        failSecondOnce = false;
        throw new Error('EIO-second');
      }
      return (realSet as any)(...args);
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await service.finalizeReplayedOutbox(firstItem, 'dead');
    }
    await service.finalizeReplayedOutbox(secondItem, 'dead');
    expect(service.reconciliationStatus()).toMatchObject({
      pending: 2,
      exhausted: 1,
      timerActive: true,
    });

    failFirst = false;
    jest.restoreAllMocks();
    await service.reconcileReplayFinalizations();
    expect(service.reconciliationStatus()).toMatchObject({
      pending: 0,
      exhausted: 0,
      timerActive: false,
    });
    expect(await local.outbox.listNeedsFinalize()).toHaveLength(0);
  });

  it('init 不覆盖 finalize_exhausted，恢复后清理 degraded 与 lastError', async () => {
    const { home, service, fake, local } = await setup();
    fake.setFailure({ status: 503, code: 'capability_unavailable', retryable: true });
    const queued = await service.ingest({
      requestId: 'req_init_priority_exhausted',
      agentId: 'opencode',
      threadId: 'th_init_priority_exhausted',
      extractor: 'host',
      chunks: [],
      candidates: [{ kind: 'observation', content: { content: 'init priority exhausted' } }],
    });
    const extractionId = queued.data.extraction.id;
    const item = (await local.outbox.list())[0]!;
    await local.outbox.completeReplay(item.id, { outcome: 'dead', error: 'retention_expired' });
    const deadItem = (await local.outbox.getDead(item.id))!;
    jest.spyOn(local.cache, 'set').mockRejectedValue(new Error('EIO'));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await service.finalizeReplayedOutbox(deadItem, 'dead');
    }
    expect(service.lastErrorView?.code).toBe('finalize_exhausted');
    service.stop();

    const restartedLocal = new SidecarLocalLayer({ root: join(home, 'memory-runtime') });
    await restartedLocal.init();
    const restartedClient = new CapabilityClient({
      baseUrl: fake.baseUrl,
      token: 'cap-token',
      retries: 0,
      retryDelayMs: 0,
    });
    const restarted = new IngestService({
      config: defaultSidecarConfig(),
      local: restartedLocal,
      client: restartedClient,
      identity: { cloudId: 'cl_test', profileId: 'default', hostId: 'h_test' },
      policy: defaultSidecarPolicy(),
    });
    const failingSet = jest.spyOn(restartedLocal.cache, 'set').mockRejectedValue(new Error('EIO'));
    await restarted.init();
    expect(restarted.lastErrorView?.code).toBe('finalize_exhausted');
    failingSet.mockRestore();
    await restarted.reconcileReplayFinalizations();
    expect((await restarted.getExtraction(extractionId))?.status).toBe('failed');
    expect(restarted.lastErrorView).toBeNull();
    expect(restarted.stats()).toMatchObject({ degraded: false, finalizePending: 0, finalizeExhausted: 0 });
  });

  it('Detail outbox 满时显式 503，不把失败吞成已完成', async () => {
    const { service, fake, local } = await setup(defaultSidecarPolicy(), { maxOutboxItems: 1 });
    await local.outbox.enqueue({
      id: 'ob_existing_capacity',
      requestId: 'req_existing_capacity',
      endpoint: '/write',
      body: { items: [] },
    });
    fake.setDetailFailure({ status: 503, code: 'capability_unavailable', retryable: true });

    await expect(service.ingest({ requestId: 'req_detail_full', ...preferenceRequest() }))
      .rejects.toMatchObject({ code: 'outbox_full', status: 503 });
    expect(fake.writeRequests).toHaveLength(1);
    expect((await local.outbox.stats()).items).toBe(1);
  });

  it('drain 后晚到 write 成功：409、不写 Detail/outbox，staging 保留', async () => {
    const gate = new LifecycleGate();
    const { service, client, local } = await setup(defaultSidecarPolicy(), { lifecycle: gate });
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    jest.spyOn(client, 'write').mockImplementation((async (payload: any) => {
      markStarted();
      await hold;
      const items = Array.isArray(payload?.items) ? payload.items : [];
      return {
        data: {
          results: items.map((item: any) => ({
            clientItemId: item.clientItemId,
            status: 'created',
            id: `mem_${item.clientItemId}`,
            kind: item.kind,
            domain: item.domain,
          })),
          created: items.length,
        },
        warnings: [],
        degraded: false,
      };
    }) as any);
    const detailWrite = jest.spyOn(client, 'detailWrite');

    const pending = service.ingest({
      requestId: 'req_late_write_success',
      ...preferenceRequest(),
    });
    await started;
    gate.beginDrain('test');
    gate.finishDrain();
    release();

    await expect(pending).rejects.toMatchObject({ code: 'mode_mismatch', status: 409 });
    expect(detailWrite).not.toHaveBeenCalled();
    expect((await local.outbox.stats()).items).toBe(0);
    expect(await local.store.countStagingChunks()).toBe(1);
    const extractions = await local.cache.list<any>('extraction:v1:');
    expect(extractions.filter((entry) => entry.value?.status === 'completed')).toHaveLength(0);
    jest.restoreAllMocks();
  });

  it('drain 发生在 finalize cache 写入前：不写缓存，保留 marker，恢复后收口', async () => {
    const gate = new LifecycleGate();
    const { service, fake, local } = await setup(defaultSidecarPolicy(), { lifecycle: gate });
    fake.setFailure({ status: 503, code: 'capability_unavailable', retryable: true });
    const queued = await service.ingest({
      requestId: 'req_drain_finalize',
      agentId: 'opencode',
      threadId: 'th_drain_finalize',
      extractor: 'host',
      chunks: [],
      candidates: [{ kind: 'observation', content: { content: 'drain finalize' } }],
    });
    const extractionId = queued.data.extraction.id;
    const item = (await local.outbox.list())[0]!;
    const originalGet = local.cache.get.bind(local.cache);
    let markReading!: () => void;
    const reading = new Promise<void>((resolve) => { markReading = resolve; });
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    jest.spyOn(local.cache, 'get').mockImplementationOnce(async (...args: any[]) => {
      markReading();
      await hold;
      return (originalGet as any)(...args);
    });

    const finalize = service.finalizeReplayedOutbox(item, 'dead');
    await reading;
    gate.beginDrain('test');
    gate.finishDrain();
    release();
    await finalize;

    expect(await local.outbox.listNeedsFinalize()).toHaveLength(1);
    expect((await service.getExtraction(extractionId))?.status).toBe('pending');
    jest.restoreAllMocks();

    gate.resume();
    await service.reconcileReplayFinalizations();
    expect((await service.getExtraction(extractionId))?.status).toBe('failed');
    expect(await local.outbox.listNeedsFinalize()).toHaveLength(0);
  });

  it('staging 先过期时依赖 Detail 显式 dead，不静默确认', async () => {
    const gate = new LifecycleGate();
    const { service, client, local } = await setup(defaultSidecarPolicy(), { lifecycle: gate });
    const now = Date.now();
    await local.cache.set('extraction:v1:ext_expired_detail', {
      version: 1,
      id: 'ext_expired_detail',
      status: 'pending',
      extractor: 'host',
      records: [],
      detailIds: [],
      warnings: [],
      degraded: false,
      expiresAt: now + 86_400_000,
      createdAt: now,
      agentId: 'opencode',
      stagingChunkIds: ['chunk_missing'],
      rawChunkIds: ['chunk_missing'],
      messageIds: [],
      outboxIds: [],
    }, { ttlMs: 86_400_000 });
    await local.outbox.enqueue({
      id: 'ob_detail_expired',
      requestId: 'req_detail_expired',
      endpoint: '/detail',
      body: {
        requestId: 'req_detail_expired',
        actor: { type: 'agent', agentId: 'opencode' },
        op: 'write',
        items: [{
          clientItemId: 'det_expired',
          domain: 'agent:opencode',
          detailKind: 'raw_chunk',
          threadId: 'th_1',
          recordIds: ['mem_1'],
          role: 'user',
          text: 'expired detail',
          mime: 'text/plain',
          contentHash: 'sha256:abc',
          redaction: { applied: false, rules: [] },
          retentionClass: 'conversation',
          expiresAt: now + 86_400_000,
          provenance: {
            source: 'runtime',
            extractor: 'host',
            agentId: 'opencode',
            messageIds: [],
            confirmation: 'none',
          },
        }],
      },
      meta: {
        kind: 'detail',
        stagingChunkIds: ['chunk_missing'],
        extractionIds: ['ext_expired_detail'],
      },
    });
    const post = jest.fn(async () => ({
      data: {
        results: [{ clientItemId: 'det_expired', status: 'created', id: 'detail_expired' }],
        created: 1,
      },
    }));
    const detailGet = jest.spyOn(client, 'detailGet');
    const replayer = new OutboxReplayer({
      outbox: local.outbox,
      client: { post } as any,
      lifecycle: gate,
      now: Date.now,
      onSettled: (item, data) => service.applyReplayedOutbox(item, data),
      onComplete: (item, outcome) => service.finalizeReplayedOutbox(item, outcome),
    });

    expect(await replayer.replayOnce()).toMatchObject({ settled: 0, dead: 1, remaining: 0 });
    expect(detailGet).not.toHaveBeenCalled();
    const dead = await local.outbox.listDead();
    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatchObject({ id: 'ob_detail_expired', error: 'retention_expired' });
    expect((await service.getExtraction('ext_expired_detail'))?.status).toBe('failed');
    expect(await local.outbox.listNeedsFinalize()).toHaveLength(0);
    jest.restoreAllMocks();
  });
});
