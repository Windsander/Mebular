// syncedByPeer 已确认集合持久化回归测试（phase-6-plan 6.4）
//
// 验收：持久化-重启-续传——重启后首帧不再携带对端早已确认的冗余事件；
// 状态文件损坏诚实报错，不静默重置；无配置路径维持纯内存行为。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GraphStore } from '../../src/core/GraphStore.js';
import { EventLog, type EventSigner } from '../../src/eventlog/EventLog.js';
import { MemoryStore } from '../../src/memory/MemoryStore.js';
import { MemoryStorage } from '../../src/storage/MemoryStorage.js';
import { SyncManager, type SyncPeer } from '../../src/sync/syncmgr/SyncManager.js';
import { SecureChannelSyncTransport } from '../../src/sync/protocol.js';
import { SecureChannelImpl } from '../../src/p2p/secure/SecureChannelImpl.js';
import { InMemoryHub } from '../../src/p2p/transport/InMemoryTransport.js';
import {
  createTestIdentity,
  generateMasterKeyPair,
  issueCertificate,
  masterPublicKeyBytes,
} from '../p2p/helpers.js';

interface End {
  deviceId: string;
  storage: MemoryStorage;
  eventLog: EventLog;
  memory: MemoryStore;
  publicKey: Uint8Array;
}

async function createEnd(deviceId: string, master: CryptoKeyPair): Promise<End> {
  const identity = await createTestIdentity(deviceId);
  const certificate = await issueCertificate(master.privateKey, identity);
  const signer: EventSigner = {
    deviceId,
    privateKey: identity.identity.devicePrivateKey,
    certificate,
  };
  const storage = new MemoryStorage();
  const eventLog = new EventLog(storage, deviceId, { signer });
  const memory = new MemoryStore(new GraphStore({ storage, author: deviceId, eventLog }));
  return { deviceId, storage, eventLog, memory, publicKey: identity.identity.devicePublicKey };
}

function peerOf(end: End): SyncPeer {
  return { deviceId: end.deviceId, publicKey: end.publicKey };
}

async function syncPair(a: SyncManager, b: SyncManager, endA: End, endB: End) {
  const hub = new InMemoryHub();
  const peerA = { multihash: endA.publicKey, pubKey: endA.publicKey, id: endA.deviceId };
  const peerB = { multihash: endB.publicKey, pubKey: endB.publicKey, id: endB.deviceId };
  const [connA, connB] = hub.createLinkedPair(peerA, peerB);
  const channelA = new SecureChannelImpl(connA);
  const channelB = new SecureChannelImpl(connB);
  await Promise.all([channelA.start(), channelB.start()]);
  return Promise.all([
    a.syncWithDevice(new SecureChannelSyncTransport(channelA), peerOf(endB)),
    b.acceptSync(new SecureChannelSyncTransport(channelB), peerOf(endA)),
  ]);
}

describe('syncedByPeer 持久化（6.4）', () => {
  let dir: string;
  let master: CryptoKeyPair;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sync-state-'));
    master = await generateMasterKeyPair();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('markEventsSynced 落盘：JSON 形状确定（peers 记录 + 排序 ID）', async () => {
    const statePath = join(dir, 'sub', 'sync-state.json'); // 父目录不存在 → mkdir recursive
    const end = await createEnd('dev-a', master);
    const sm = new SyncManager({
      eventLog: end.eventLog,
      storage: end.storage,
      deviceId: end.deviceId,
      syncStatePath: statePath,
    });

    await sm.markEventsSynced('dev-b', ['evt-2', 'evt-1']);
    const parsed = JSON.parse(await readFile(statePath, 'utf-8')) as {
      version: number;
      peers: Record<string, string[]>;
    };
    expect(parsed.version).toBe(1);
    expect(parsed.peers['dev-b']).toEqual(['evt-1', 'evt-2']); // 排序输出确定

    // 幂等合并：同一对端追加确认
    await sm.markEventsSynced('dev-b', ['evt-3', 'evt-1']);
    const again = JSON.parse(await readFile(statePath, 'utf-8')) as typeof parsed;
    expect(again.peers['dev-b']).toEqual(['evt-1', 'evt-2', 'evt-3']);
  });

  it('重启恢复：新实例懒加载同一状态文件，已确认事件不再算待同步', async () => {
    const statePath = join(dir, 'sync-state.json');
    const end = await createEnd('dev-a', master);
    await end.memory.addFact({ subject: 's', predicate: 'p', object: 'o' });
    const [event] = await end.eventLog.listEvents();

    const first = new SyncManager({
      eventLog: end.eventLog,
      storage: end.storage,
      deviceId: end.deviceId,
      syncStatePath: statePath,
    });
    await first.markEventsSynced('dev-b', [event!.id]);
    expect(await first.getPendingEvents('dev-b')).toHaveLength(0);

    // 模拟重启：同一 eventLog/storage，新 SyncManager 实例读同一状态文件
    const restarted = new SyncManager({
      eventLog: end.eventLog,
      storage: end.storage,
      deviceId: end.deviceId,
      syncStatePath: statePath,
    });
    expect(await restarted.getPendingEvents('dev-b')).toHaveLength(0); // 已确认 → 不冗余
    expect(await restarted.getPendingEvents('dev-c')).toHaveLength(1); // 新对端 → 全量待同步
  });

  it('重启后续传：二轮同步首帧 offer 为 0（sentEvents=0），不重发已确认事件', async () => {
    const statePathA = join(dir, 'a.sync-state.json');
    const endA = await createEnd('dev-a', master);
    const endB = await createEnd('dev-b', master);
    const masterPub = await masterPublicKeyBytes(master);

    const mk = (end: End, path?: string) =>
      new SyncManager({
        eventLog: end.eventLog,
        storage: end.storage,
        deviceId: end.deviceId,
        userMasterPublicKey: masterPub,
        ...(path !== undefined ? { syncStatePath: path } : {}),
      });

    await endA.memory.addFact({ subject: '甲', predicate: '说', object: '你好' });
    const smA1 = mk(endA, statePathA);
    const smB1 = mk(endB);
    const [resultA] = await syncPair(smA1, smB1, endA, endB);
    expect(resultA.sentEvents).toBe(1); // 首轮：1 条事件发给 B

    // A 重启（新实例 + 同一状态文件），B 原样；再同步 → 无冗余
    const smA2 = mk(endA, statePathA);
    const smB2 = mk(endB);
    const [resultA2] = await syncPair(smA2, smB2, endA, endB);
    expect(resultA2.sentEvents).toBe(0);
    expect(resultA2.receivedEvents).toBe(0);
  });

  it('状态文件损坏 / 形状非法 → 诚实 STORAGE_READ_FAILED，不静默重置', async () => {
    const badJson = join(dir, 'bad.json');
    await writeFile(badJson, '{损坏', 'utf-8');
    const end = await createEnd('dev-a', master);
    const sm1 = new SyncManager({
      eventLog: end.eventLog,
      storage: end.storage,
      deviceId: end.deviceId,
      syncStatePath: badJson,
    });
    await expect(sm1.getPendingEvents()).rejects.toThrow('同步状态文件损坏');

    const badShape = join(dir, 'bad-shape.json');
    await writeFile(badShape, JSON.stringify({ version: 1, peers: { 'dev-b': 'oops' } }), 'utf-8');
    const sm2 = new SyncManager({
      eventLog: end.eventLog,
      storage: end.storage,
      deviceId: end.deviceId,
      syncStatePath: badShape,
    });
    await expect(sm2.getPendingEvents()).rejects.toThrow('不是字符串数组');
  });

  it('无 syncStatePath：纯内存行为不变，不落任何文件', async () => {
    const end = await createEnd('dev-a', master);
    const sm = new SyncManager({
      eventLog: end.eventLog,
      storage: end.storage,
      deviceId: end.deviceId,
    });
    await sm.markEventsSynced('dev-b', ['evt-1']);
    expect(await sm.getPendingEvents('dev-b')).toHaveLength(0);
    // 新实例无持久化依据 → 全部待同步（6.4 前行为保留）
    const fresh = new SyncManager({
      eventLog: end.eventLog,
      storage: end.storage,
      deviceId: end.deviceId,
    });
    await end.memory.addFact({ subject: 's', predicate: 'p', object: 'o' });
    expect(await fresh.getPendingEvents('dev-b')).toHaveLength(1);
  });
});
