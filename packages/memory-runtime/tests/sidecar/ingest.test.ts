// sidecar 沉降：ingest 幂等、staging、detail 写入/去重/跨域、outbox、无候选。

import { describe, it, expect, afterEach, jest } from '@jest/globals';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CapabilityClient } from '../../src/sidecar/capability-client.js';
import { defaultSidecarConfig } from '../../src/sidecar/config.js';
import { defaultSidecarPolicy } from '../../src/sidecar/domains.js';
import { IngestService } from '../../src/sidecar/ingest.js';
import { SidecarLocalLayer } from '../../src/sidecar/local-layer.js';
import { OutboxReplayer } from '../../src/sidecar/outbox-replayer.js';
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
  options: { maxOutboxItems?: number; stagingBytes?: number; now?: () => number } = {},
): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), 'mebular-memory-runtime-ingest-'));
  const local = new SidecarLocalLayer({
    root: join(home, 'memory-runtime'),
    ...(options.maxOutboxItems !== undefined ? { maxOutboxItems: options.maxOutboxItems } : {}),
    ...(options.stagingBytes !== undefined ? { stagingBytes: options.stagingBytes } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  await local.init();
  const fake = await startFakeCapability();
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
    ...(options.now ? { now: options.now } : {}),
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
    expect(fake.detailRequests).toHaveLength(1);
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
    expect(fake.detailRequests).toHaveLength(2);
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
    expect(fake.detailRequests).toHaveLength(1);
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
    expect(fake.detailRequests).toHaveLength(1);
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
    expect(fake.detailRequests).toHaveLength(1);
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
    const { service, local, home } = await setup(defaultSidecarPolicy(), { now: () => clock });
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

  it('duplicate Detail 不用当前请求的 expiry/recordIds 覆盖权威缓存', async () => {
    const { service, fake, local } = await setup();
    const first = await service.ingest({ requestId: 'req_duplicate_cache_1', ...preferenceRequest() });
    const detailId = first.data.detailIds[0]!;
    const authoritativeExpiresAt = Date.now() + 60_000;
    await local.putCachedDetail(detailId, {
      detail: {
        id: detailId,
        text: 'authoritative cached text',
        recordIds: ['authoritative-record-id'],
        expiresAt: authoritativeExpiresAt,
        availability: ['available'],
      },
    });

    const duplicate = await service.ingest({ requestId: 'req_duplicate_cache_2', ...preferenceRequest() });
    expect(duplicate.data.detailIds).toEqual([detailId]);
    expect(fake.details).toHaveLength(1);
    const cached = await local.getCachedDetail<any>(detailId);
    expect(cached.detail).toMatchObject({
      text: 'authoritative cached text',
      recordIds: ['authoritative-record-id'],
      expiresAt: authoritativeExpiresAt,
    });
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
    const { service, client, fake, local } = await setup(defaultSidecarPolicy(), { now: () => clock });
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
    expect(fake.detailRequests).toHaveLength(1);
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
});
