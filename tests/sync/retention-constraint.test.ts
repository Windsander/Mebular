// 保留策略约束（PLAN 1.5，本期只落约束与测试，不实现裁剪策略）
//
// 约束：任何将来引入的自动事件裁剪，必须排除「尚未被所有已授权对端 ack 的
// 事件」，否则对端将永久缺失该记忆，直接违背「所有记忆一致」。
// 本测试固化：JsonFileStorage.compact() 不丢事件；未 ack 事件仍在待同步集合。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { JsonFileStorage } from '../../src/storage/JsonFileStorage.js';
import { EventLog, type EventSigner } from '../../src/eventlog/EventLog.js';
import { GraphStore } from '../../src/core/GraphStore.js';
import { SyncManager } from '../../src/sync/syncmgr/SyncManager.js';
import type { Event } from '../../src/types/event.js';

describe('保留策略约束：未 ack 的事件不可被裁剪', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mebular-retention-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('compact 不丢弃事件；未 ack 事件仍可被待同步集合观察到', async () => {
    const file = join(dir, 'store.jsonl');
    const storage = await JsonFileStorage.open(file);
    const keyPair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const signer: EventSigner = { deviceId: 'device-A', privateKey: keyPair.privateKey };
    const eventLog = new EventLog(storage, 'device-A', { signer });
    const store = new GraphStore({ storage, author: 'device-A', eventLog });
    const sync = new SyncManager({ eventLog, storage, deviceId: 'device-A' });

    // 第一个事件：已同步并 ack
    await store.createNode('fact', { text: 'acked' });
    const ackedIds = (await eventLog.listEvents()).map((e) => e.id);
    await sync.markEventsSynced('device-B', ackedIds);

    // 第二个事件：本地新增，尚未被对端 ack
    await store.createNode('fact', { text: 'unacked' });
    const before = (await eventLog.listEvents()).map((e) => e.id).sort();
    expect(before).toHaveLength(2);

    await storage.compact();

    const after = (await eventLog.listEvents()).map((e) => e.id).sort();
    // 硬约束：compact 是「合并操作行」，绝不丢弃事件
    expect(after).toEqual(before);

    // 未 ack 事件仍被 getPendingEvents 观察（未来裁剪必须排除的集合）
    const pending: Event[] = await sync.getPendingEvents();
    expect(pending).toHaveLength(1);
    expect(before).toContain(pending[0]!.id);
    expect(pending[0]!.id).not.toEqual(ackedIds[0]);

    await storage.close();
  });
});
