// W4a 沉降：ingest 幂等、Raw 去重、capture、heuristic、域路由、outbox。
//
// 使用 fake capability server；不启动真实 MCP/core。

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
    capture: 'local',
    chunks: [{ role: 'user', text: '我喜欢深色主题', messageId: 'm1', chunkIndex: 0 }],
    ...overrides,
  };
}

describe('IngestService settlements', () => {
  it('requestId 幂等：重复请求返回同一结果且不重复写', async () => {
    const { service, fake, local } = await setup();
    const request = { requestId: 'req_idem_1', ...preferenceRequest() };

    const first = await service.ingest(request);
    const second = await service.ingest(request);

    expect(first.status).toBe(200);
    expect(first.data.duplicate).toBe(false);
    expect(first.data.accepted).toMatchObject({ chunks: 1, records: 1 });
    expect(first.data.rawChunkIds).toHaveLength(1);
    expect(first.data.records[0]).toMatchObject({ domain: 'user', status: 'created' });
    expect(second.data.duplicate).toBe(true);
    expect(second.data.records[0]!.id).toBe(first.data.records[0]!.id);
    expect(second.data.rawChunkIds).toEqual(first.data.rawChunkIds);
    expect(fake.writeRequests).toHaveLength(1);
    expect(await local.store.countRawChunks({ cloudId: 'cl_test', agentId: 'opencode', threadId: 'th_1' })).toBe(1);

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

  it('同一 (threadId,messageId) / 内容 hash 的 Raw 去重且复用 ID', async () => {
    const { service, fake, local } = await setup();
    const first = await service.ingest({ requestId: 'req_raw_1', ...preferenceRequest() });
    const second = await service.ingest({ requestId: 'req_raw_2', ...preferenceRequest() });

    expect(second.data.rawChunkIds).toEqual(first.data.rawChunkIds);
    expect(second.data.records[0]).toMatchObject({ status: 'duplicate', duplicate: true });
    expect(await local.store.countRawChunks({ cloudId: 'cl_test', agentId: 'opencode', threadId: 'th_1' })).toBe(1);
    expect(fake.writeRequests).toHaveLength(2);
    expect(fake.nodes).toHaveLength(1);
  });

  it('capture=off 不落 Raw，但仍沉降候选', async () => {
    const { service, local, fake } = await setup();
    const result = await service.ingest(preferenceRequest({ capture: 'off' }));

    expect(result.data.rawChunkIds).toEqual([]);
    expect(await local.store.countRawChunks()).toBe(0);
    expect(result.data.records).toHaveLength(1);
    expect(fake.writeRequests).toHaveLength(1);
  });

  it('capture=local 写入 <home>/memory-runtime/raw/chunks.jsonl（0600）', async () => {
    const { service, home, local } = await setup();
    await service.ingest(preferenceRequest({ capture: 'local' }));

    const rawPath = join(home, 'memory-runtime', 'raw', 'chunks.jsonl');
    expect((await stat(rawPath)).mode & 0o777).toBe(0o600);
    expect((await local.stats()).rawChunks).toBe(1);
  });

  it('宿主候选：user / agent:self / default / task 域与 provenance', async () => {
    const { service, fake } = await setup();
    const result = await service.ingest({
      requestId: 'req_host_domains',
      agentId: 'opencode',
      agentName: 'OpenCode',
      threadId: 'th_task_1',
      extractor: 'host',
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
    expect(items[1].provenance.confirmation).toBe('none');
    expect(fake.nodes.find((node) => node.domain === 'user')?.provenance.agentId).toBe('opencode');
  });

  it('heuristic 只从 user chunk 提取明确偏好/事实/决策/任务，不臆造', async () => {
    const { service, fake } = await setup();
    const result = await service.ingest({
      requestId: 'req_heuristic',
      agentId: 'opencode',
      threadId: 'th_h1',
      capture: 'off',
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
      capture: 'off',
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
    const result = await service.ingest({ requestId: 'req_policy', ...preferenceRequest({ capture: 'off' }) });

    const items = fake.writeRequests[0]!.body.items as any[];
    expect(items[0].domain).toBe('agent:opencode');
    expect(items[0].provenance.confirmation).toBe('none');
    expect(result.data.warnings).toContain('user_domain_not_allowed_downgraded');
    expect(result.data.records[0]).toMatchObject({ domain: 'agent:opencode' });
  });

  it('全非法候选返回 422，且不写 Raw/不调用 capability', async () => {
    const { service, fake, local } = await setup();
    await expect(service.ingest({
      requestId: 'req_invalid',
      agentId: 'opencode',
      capture: 'local',
      chunks: [{ role: 'user', text: '我喜欢深色主题', messageId: 'm1' }],
      candidates: [
        { kind: 'bogus', content: { content: 'x' } },
        { kind: 'fact', content: {} },
      ],
    })).rejects.toMatchObject({ code: 'validation_failed', status: 422 });

    expect(fake.writeRequests).toHaveLength(0);
    expect(await local.store.countRawChunks()).toBe(0);
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
    expect(await local.store.countRawChunks()).toBe(0);
  });

  it('extractor=host 无候选返回 pending；回填候选后沉降且重复回填不重复写', async () => {
    const { service, fake } = await setup();
    const pending = await service.ingest({
      requestId: 'req_host_pending',
      agentId: 'opencode',
      threadId: 'th_pending',
      capture: 'local',
      extractor: 'host',
      chunks: [{ role: 'user', text: '我喜欢深色主题', messageId: 'mp1' }],
    });

    expect(pending.status).toBe(202);
    expect(pending.data.queued).toBe(false);
    expect(pending.data.extraction).toMatchObject({ status: 'pending', extractor: 'host' });
    expect(pending.data.accepted.records).toBe(0);
    expect(pending.data.rawChunkIds).toHaveLength(1);
    expect(fake.writeRequests).toHaveLength(0);

    const candidates = [{
      kind: 'preference',
      content: { entity: 'user', preferenceType: 'theme', value: 'dark' },
    }];
    const completed = await service.completeExtraction(pending.data.extraction.id, candidates);
    expect(completed.queued).toBe(false);
    expect(completed.extraction).toMatchObject({ status: 'completed', extractor: 'host', model: 'host-provided' });
    expect(completed.extraction.records).toHaveLength(1);
    expect(fake.writeRequests).toHaveLength(1);

    const again = await service.completeExtraction(pending.data.extraction.id, candidates);
    expect(again.extraction.records[0]!.id).toBe(completed.extraction.records[0]!.id);
    expect(fake.writeRequests).toHaveLength(1);
  });

  it('capability 失败进入有界 outbox，恢复后重放成功并清理', async () => {
    const { service, fake, local, client } = await setup();
    fake.setFailure({ status: 503, code: 'capability_unavailable', retryable: true });

    const queued = await service.ingest({
      requestId: 'req_outbox',
      ...preferenceRequest({ capture: 'local' }),
    });
    expect(queued.status).toBe(202);
    expect(queued.data).toMatchObject({ queued: true, degraded: true });
    expect(queued.data.rawChunkIds).toHaveLength(1);
    expect(queued.data.extraction.status).toBe('pending');
    expect(await local.outbox.stats()).toMatchObject({ items: 1 });
    expect(queued.data.warnings).toEqual(expect.arrayContaining(['capability_unavailable', 'queued_outbox']));
    expect(service.stats()).toMatchObject({
      ingested: 1,
      settled: 0,
      queued: 1,
      degraded: true,
      lastError: { code: 'capability_unavailable' },
    });

    const duplicate = await service.ingest({
      requestId: 'req_outbox',
      ...preferenceRequest({ capture: 'local' }),
    });
    expect(duplicate.data.duplicate).toBe(true);
    expect(await local.outbox.stats()).toMatchObject({ items: 1 });

    fake.setFailure(null);
    const replayer = new OutboxReplayer({ outbox: local.outbox, client });
    const summary = await replayer.replayOnce();
    expect(summary).toMatchObject({ settled: 1, retried: 0, dead: 0, remaining: 0, errors: [] });
    service.applyReplaySummary(summary);
    expect(await local.outbox.stats()).toMatchObject({ items: 0 });
    expect(fake.writeRequests).toHaveLength(2);
    expect(service.stats()).toMatchObject({ settled: 1, degraded: false, lastError: null });

    const replayAgain = await replayer.replayOnce();
    expect(replayAgain).toMatchObject({ settled: 0, remaining: 0 });
    expect(fake.writeRequests).toHaveLength(2);
  });

  it('不可重试的 capability 错误不进 outbox，记录 failed/lastError 并保留 Raw', async () => {
    const { service, fake, local } = await setup();
    fake.setFailure({ status: 422, code: 'validation_failed', retryable: false });

    const result = await service.ingest({ requestId: 'req_perm_fail', ...preferenceRequest({ capture: 'local' }) });

    expect(result.status).toBe(200);
    expect(result.data).toMatchObject({ queued: false, degraded: true });
    expect(result.data.extraction.status).toBe('failed');
    expect(result.data.records).toEqual([]);
    expect(await local.outbox.stats()).toMatchObject({ items: 0 });
    expect(await local.store.countRawChunks({ cloudId: 'cl_test', agentId: 'opencode', threadId: 'th_1' })).toBe(1);
    expect(service.stats()).toMatchObject({
      failed: 1,
      degraded: true,
      lastError: { code: 'validation_failed' },
    });
    expect(fake.writeRequests).toHaveLength(1);
  });
});
