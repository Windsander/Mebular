// sidecar 沉降：ingest 幂等、staging、detail 写入/去重/跨域、outbox、无候选。

import { describe, it, expect, afterEach } from '@jest/globals';
import { mkdtemp, rm, stat } from 'node:fs/promises';
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

async function setup(policy = defaultSidecarPolicy()): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), 'mebular-memory-runtime-ingest-'));
  const local = new SidecarLocalLayer({ root: join(home, 'memory-runtime') });
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

  it('没有可链接记录时不写详情，staging 保留到 TTL', async () => {
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
    expect(await local.store.countStagingChunks()).toBe(1);
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

  it('不可重试的记录错误不进 outbox，记录 failed/lastError 并保留 staging 到 TTL', async () => {
    const { service, fake, local } = await setup();
    fake.setFailure({ status: 422, code: 'validation_failed', retryable: false });

    const result = await service.ingest({ requestId: 'req_perm_fail', ...preferenceRequest() });

    expect(result.status).toBe(200);
    expect(result.data).toMatchObject({ queued: false, degraded: true });
    expect(result.data.extraction.status).toBe('failed');
    expect(result.data.records).toEqual([]);
    expect(await local.outbox.stats()).toMatchObject({ items: 0 });
    expect(await local.store.countStagingChunks()).toBe(1);
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
});
