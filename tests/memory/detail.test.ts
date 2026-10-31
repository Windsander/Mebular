// C1：域内详情的 core 数据模型测试（默认配额/保留、过期维护、删除不触碰记录）。
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mebular, MemoryService, IdentityManager } from '@mebular/core';
import {
  DETAIL_QUOTA,
  DETAIL_RETENTION_DAYS,
  DEFAULT_DETAIL_QUOTA_LIMITS,
  MAX_DETAIL_TEXT_BYTES,
} from '@mebular/core';

let home: string;
let app: Mebular;
let service: MemoryService;
let masterKeys: { userMasterKey: Uint8Array; userMasterPrivateKey: CryptoKey };

const DAY = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'memory-detail-core-'));
  const master = await new IdentityManager().generateUserMasterKey();
  masterKeys = { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey };
  app = new Mebular({
    storagePath: join(home, 'store.jsonl'),
    deviceId: 'device-detail-core',
    encryption: masterKeys,
    sync: { autoSync: false },
  });
  await app.initialize();
  service = new MemoryService(app);
});

afterAll(async () => {
  await app?.shutdown().catch(() => undefined);
  if (home) await rm(home, { recursive: true, force: true });
});

async function makeRecord(domain: string, marker: string) {
  const [stored] = await service.write([{
    type: 'observation',
    content: marker,
    metadata: { namespace: domain },
  }]);
  return stored!.id;
}

function detailInput(domain: string, recordIds: string[], text: string, extra: Record<string, unknown> = {}) {
  return {
    domain,
    detailKind: 'raw_chunk' as const,
    role: 'user' as const,
    text,
    recordIds,
    provenance: { source: 'runtime', writerType: 'system', writerId: 'system', at: Date.now() },
    ...extra,
  };
}

describe('DetailRecord core model', () => {
  it('默认限制与契约一致：256 KiB/条、256 MiB/域、1 GiB/云、64 MiB/thread；30/7/90 天', () => {
    expect(MAX_DETAIL_TEXT_BYTES).toBe(256 * 1024);
    expect(DETAIL_QUOTA).toEqual({
      domainBytes: 256 * 1024 * 1024,
      cloudBytes: 1024 * 1024 * 1024,
      threadBytes: 64 * 1024 * 1024,
    });
    expect(DEFAULT_DETAIL_QUOTA_LIMITS).toEqual(DETAIL_QUOTA);
    expect(DETAIL_RETENTION_DAYS).toEqual({
      conversation: 30,
      tool_output: 7,
      document_slice: 90,
    });
  });

  it('默认 expiresAt 按 retentionClass 计算；pinned 为 0（直到删除）', async () => {
    const marker = `core-retention-${Date.now()}`;
    const recordId = await makeRecord('agent:core', marker);
    const now = Date.now();
    const conversation = await service.writeDetails([
      detailInput('agent:core', [recordId], `${marker}-conversation`, { retentionClass: 'conversation' }),
      detailInput('agent:core', [recordId], `${marker}-tool`, { retentionClass: 'tool_output' }),
      detailInput('agent:core', [recordId], `${marker}-doc`, { retentionClass: 'document_slice' }),
      detailInput('agent:core', [recordId], `${marker}-pinned`, { retentionClass: 'pinned' }),
    ]);
    expect(conversation.created).toBe(4);
    const expiries = conversation.results.map((result) => {
      const node = app.graph.getNode(result.id!);
      return node.then((value) => (value?.content as { expiresAt: number }).expiresAt);
    });
    const [conv, tool, doc, pinned] = await Promise.all(expiries);
    expect(conv).toBeGreaterThanOrEqual(now + 30 * DAY - 5_000);
    expect(conv).toBeLessThanOrEqual(now + 30 * DAY + 5_000);
    expect(tool).toBeGreaterThanOrEqual(now + 7 * DAY - 5_000);
    expect(tool).toBeLessThanOrEqual(now + 7 * DAY + 5_000);
    expect(doc).toBeGreaterThanOrEqual(now + 90 * DAY - 5_000);
    expect(doc).toBeLessThanOrEqual(now + 90 * DAY + 5_000);
    expect(pinned).toBe(0);
  });

  it('过期维护只墓碑详情，不删除 MemoryRecord；record detailAvailable 读取时派生', async () => {
    const marker = `core-prune-${Date.now()}`;
    const recordId = await makeRecord('agent:core', marker);
    const recordBefore = await app.graph.getNode(recordId);
    const written = await service.writeDetails([
      detailInput('agent:core', [recordId], marker, { expiresAt: Date.now() - 1_000 }),
    ]);
    const detailId = written.results[0]!.id!;
    expect(await service.detailAvailabilityForRecords([recordId])).toEqual(new Map([[recordId, false]]));
    const pruned = await service.pruneExpiredDetails();
    expect(pruned).toContain(detailId);
    const detail = await app.graph.getNode(detailId);
    expect(detail?.deletedAt).toBeGreaterThan(0);
    expect(detail?.metadata?.deletedReason).toBe('retention_expired');
    const record = await app.graph.getNode(recordId);
    expect(record?.deletedAt).toBeUndefined();
    // 派生标记不落盘：记录本身不被详情写入/过期/墓碑触碰。
    expect(record?.metadata?.detailAvailable).toBeUndefined();
    expect(record?.updatedAt).toBe(recordBefore?.updatedAt);
    expect(await service.detailAvailabilityForRecords([recordId])).toEqual(new Map([[recordId, false]]));
  });

  it('详情写入/删除只派生 detailAvailable，不推进 MemoryRecord.updatedAt', async () => {
    const marker = `core-availability-${Date.now()}`;
    const recordId = await makeRecord('agent:core', marker);
    const before = await app.graph.getNode(recordId);
    expect(await service.detailAvailabilityForRecords([recordId])).toEqual(new Map([[recordId, false]]));

    const written = await service.writeDetails([detailInput('agent:core', [recordId], marker)]);
    const detailId = written.results[0]!.id!;
    expect(await service.detailAvailabilityForRecords([recordId])).toEqual(new Map([[recordId, true]]));
    const afterWrite = await app.graph.getNode(recordId);
    expect(afterWrite?.updatedAt).toBe(before?.updatedAt);
    expect(afterWrite?.metadata?.detailAvailable).toBeUndefined();

    await service.deleteDetails([detailId], { actorType: 'user' });
    expect(await service.detailAvailabilityForRecords([recordId])).toEqual(new Map([[recordId, false]]));
    const afterDelete = await app.graph.getNode(recordId);
    expect(afterDelete?.updatedAt).toBe(before?.updatedAt);
    expect(afterDelete?.metadata?.detailAvailable).toBeUndefined();
  });

  it('单域配额可收紧：先淘汰最旧 tool_output，再淘汰 conversation；pinned 不可淘汰', async () => {
    const marker = `core-quota-${Date.now()}`;
    const domain = `quota-core-${Date.now()}`;
    const recordId = await makeRecord(domain, marker);
    const limits = { detailLimits: { domainBytes: 1_000, cloudBytes: 10_000, threadBytes: 10_000 } };
    const first = await service.writeDetails([
      detailInput(domain, [recordId], 'a'.repeat(600), { retentionClass: 'tool_output' }),
    ], limits);
    const firstId = first.results[0]!.id!;
    const second = await service.writeDetails([
      detailInput(domain, [recordId], 'b'.repeat(600), { retentionClass: 'tool_output' }),
    ], limits);
    expect(second.created).toBe(1);
    expect(second.evicted).toContain(firstId);
    expect((await app.graph.getNode(firstId))?.metadata?.deletedReason).toBe('quota_evicted');

    const secondId = second.results[0]!.id!;
    const third = await service.writeDetails([
      detailInput(domain, [recordId], 'c'.repeat(600), { retentionClass: 'conversation' }),
    ], limits);
    expect(third.created).toBe(1);
    expect(third.evicted).toContain(secondId);

    // 没有 tool_output 时，淘汰最旧 conversation。
    const conversationDomain = `quota-core-conv-${Date.now()}`;
    const conversationRecord = await makeRecord(conversationDomain, marker);
    const conversationFirst = await service.writeDetails([
      detailInput(conversationDomain, [conversationRecord], 'x'.repeat(600), { retentionClass: 'conversation' }),
    ], limits);
    const conversationSecond = await service.writeDetails([
      detailInput(conversationDomain, [conversationRecord], 'y'.repeat(600), { retentionClass: 'conversation' }),
    ], limits);
    expect(conversationSecond.evicted).toContain(conversationFirst.results[0]!.id);

    // pinned 不可淘汰：第二条直接结构化失败。
    const pinnedDomain = `quota-core-pinned-${Date.now()}`;
    const pinnedRecord = await makeRecord(pinnedDomain, marker);
    const pinnedFirst = await service.writeDetails([
      detailInput(pinnedDomain, [pinnedRecord], 'p'.repeat(600), { retentionClass: 'pinned' }),
    ], limits);
    expect(pinnedFirst.created).toBe(1);
    const pinnedFailed = await service.writeDetails([
      detailInput(pinnedDomain, [pinnedRecord], 'q'.repeat(600), { retentionClass: 'pinned' }),
    ], limits);
    expect(pinnedFailed.failed).toBe(1);
    expect(pinnedFailed.results[0]).toMatchObject({
      status: 'failed',
      code: 'detail_quota_exceeded',
    });
  });

  it('thread 与 cloud 配额独立生效；cloud 按域公平淘汰', async () => {
    const marker = `core-quota-scope-${Date.now()}`;
    const domain = `quota-scope-${Date.now()}`;
    const recordId = await makeRecord(domain, marker);
    const threadLimits = { detailLimits: { domainBytes: 10_000, cloudBytes: 10_000, threadBytes: 1_000 } };
    const first = await service.writeDetails([
      detailInput(domain, [recordId], 't'.repeat(600), { retentionClass: 'conversation', threadId: 'th_quota_core' }),
    ], threadLimits);
    const second = await service.writeDetails([
      detailInput(domain, [recordId], 'u'.repeat(600), { retentionClass: 'conversation', threadId: 'th_quota_core' }),
    ], threadLimits);
    expect(second.created).toBe(1);
    expect(second.evicted).toContain(first.results[0]!.id);
    const otherThread = await service.writeDetails([
      detailInput(domain, [recordId], 'v'.repeat(600), { retentionClass: 'conversation', threadId: 'th_quota_other' }),
    ], threadLimits);
    expect(otherThread.created).toBe(1);
    expect(otherThread.evicted).toEqual([]);

    // 清空已有详情，避免前面的测试占用 cloud 配额（记录保留）。
    for (const node of await app.graph.listNodes({ type: 'detail_record' })) {
      if (!node.deletedAt) await service.deleteDetails([node.id], { actorType: 'system' });
    }

    const cloudDomainA = `quota-cloud-a-${Date.now()}`;
    const cloudDomainB = `quota-cloud-b-${Date.now()}`;
    const recordA = await makeRecord(cloudDomainA, marker);
    const recordB = await makeRecord(cloudDomainB, marker);
    const cloudLimits = { detailLimits: { domainBytes: 10_000, cloudBytes: 1_000, threadBytes: 10_000 } };
    const cloudA = await service.writeDetails([
      detailInput(cloudDomainA, [recordA], 'w'.repeat(600), { retentionClass: 'conversation' }),
    ], cloudLimits);
    expect(cloudA.created).toBe(1);
    const cloudB = await service.writeDetails([
      detailInput(cloudDomainB, [recordB], 'y'.repeat(600), { retentionClass: 'conversation' }),
    ], cloudLimits);
    expect(cloudB.created).toBe(1);
    expect(cloudB.evicted).toContain(cloudA.results[0]!.id);
  });
});
