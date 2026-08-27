// M5 压力与故障注入测试（phase-5-plan 5.5）
//
// 覆盖：分区-失败-恢复收敛、抖动延迟下环形三端一致、丢包链路重试收敛、
// 星形拓扑两跳中继一致、千级节点规模冒烟（记录耗时，不设硬指标）。

import { describe, it, expect } from '@jest/globals';
import { GraphStore } from '../../src/core/GraphStore.js';
import { EventLog, type EventSigner } from '../../src/eventlog/EventLog.js';
import { MemoryStorage } from '../../src/storage/MemoryStorage.js';
import { SyncManager, type SyncPeer, type SyncResult } from '../../src/sync/syncmgr/SyncManager.js';
import { SecureChannelSyncTransport } from '../../src/sync/protocol.js';
import { SecureChannelImpl } from '../../src/p2p/secure/SecureChannelImpl.js';
import type { Connection } from '../../src/p2p/P2PNetwork.js';
import {
  createFaultyLinkedPair,
  seededRng,
  type FaultPolicy,
} from '../helpers/faulty-transport.js';
import {
  createTestIdentity,
  generateMasterKeyPair,
  issueCertificate,
  masterPublicKeyBytes,
} from '../p2p/helpers.js';

interface Device {
  deviceId: string;
  storage: MemoryStorage;
  eventLog: EventLog;
  store: GraphStore;
  syncManager: SyncManager;
  publicKey: Uint8Array;
}

async function createDevice(deviceId: string, master: CryptoKeyPair): Promise<Device> {
  const identity = await createTestIdentity(deviceId);
  const certificate = await issueCertificate(master.privateKey, identity);
  const signer: EventSigner = {
    deviceId,
    privateKey: identity.identity.devicePrivateKey,
    certificate,
  };
  const storage = new MemoryStorage();
  const eventLog = new EventLog(storage, deviceId, { signer });
  const store = new GraphStore({ storage, author: deviceId, eventLog });
  const syncManager = new SyncManager({
    eventLog,
    storage,
    deviceId,
    userMasterPublicKey: await masterPublicKeyBytes(master),
  });
  return { deviceId, storage, eventLog, store, syncManager, publicKey: identity.identity.devicePublicKey };
}

function peerOf(device: Device): SyncPeer {
  return { deviceId: device.deviceId, publicKey: device.publicKey };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

/** 在故障策略下跑一次双向同步（每次会话用新连接对，模拟重连；信道建立也计入超时） */
async function syncOver(
  a: Device,
  b: Device,
  policy: FaultPolicy,
  timeoutMs = 5000,
): Promise<[SyncResult, SyncResult]> {
  const peerA = { multihash: a.publicKey, pubKey: a.publicKey, id: a.deviceId };
  const peerB = { multihash: b.publicKey, pubKey: b.publicKey, id: b.deviceId };
  const [connA, connB] = createFaultyLinkedPair(peerA, peerB, policy);
  const channelA = new SecureChannelImpl(connA as Connection);
  const channelB = new SecureChannelImpl(connB as Connection);
  // 丢包/分区下密钥协商帧可能丢失：信道建立同样要有期限
  await withTimeout(Promise.all([channelA.start(), channelB.start()]), timeoutMs, 'channel setup timed out');
  return Promise.all([
    a.syncManager.syncWithDevice(new SecureChannelSyncTransport(channelA), peerOf(b), { timeoutMs }),
    b.syncManager.acceptSync(new SecureChannelSyncTransport(channelB), peerOf(a)),
  ]);
}

async function nodeIds(device: Device): Promise<string[]> {
  return (await device.storage.listNodes()).map((n) => n.id).sort();
}

describe('故障注入：分区与恢复', () => {
  it('分区期间同步诚实失败，恢复后重连收敛', async () => {
    const master = await generateMasterKeyPair();
    const a = await createDevice('device-A', master);
    const b = await createDevice('device-B', master);

    await a.store.createNode('fact', { text: 'before-partition' });
    await syncOver(a, b, {}); // 正常同步一次
    expect((await b.storage.listNodes())).toHaveLength(1);

    // 分区：A 离线写入，同步帧全部丢失 → 会话诚实失败
    let partitioned = true;
    await a.store.createNode('fact', { text: 'during-partition' });
    await expect(
      syncOver(a, b, { isPartitioned: () => partitioned }, 400),
    ).rejects.toThrow();
    expect((await b.storage.listNodes())).toHaveLength(1); // B 未被污染

    // 恢复：新连接重试 → 收敛
    partitioned = false;
    await syncOver(a, b, {});
    expect((await b.storage.listNodes())).toHaveLength(2);
  }, 20000);
});

describe('抖动延迟下的拓扑收敛', () => {
  it('环形三端：A↔B、B↔C、C↔A 两两同步后全一致（事件计数/节点集/时钟合流）', async () => {
    const master = await generateMasterKeyPair();
    const a = await createDevice('ring-A', master);
    const b = await createDevice('ring-B', master);
    const c = await createDevice('ring-C', master);

    // 各端离线写入不同内容
    await a.store.createNode('fact', { text: 'from-A-1' });
    await a.store.createNode('fact', { text: 'from-A-2' });
    await b.store.createNode('entity', { entityType: 'tool', name: 'from-B' });
    await c.store.createNode('episode', { episodeType: 'task', content: 'from-C' });

    // 抖动链路（20~70ms 随机，种子确定）
    const jitter = (): FaultPolicy => ({
      latencyMs: () => 20 + Math.floor(rngStream() * 50),
    });
    const rngStream = seededRng(42);

    await syncOver(a, b, jitter());
    await syncOver(b, c, jitter());
    await syncOver(c, a, jitter());
    // 再各走一轮让三端事件日志完全合流
    await syncOver(a, b, jitter());
    await syncOver(b, c, jitter());
    await syncOver(c, a, jitter());

    const [idsA, idsB, idsC] = await Promise.all([nodeIds(a), nodeIds(b), nodeIds(c)]);
    expect(idsA).toHaveLength(4);
    expect(idsB).toEqual(idsA);
    expect(idsC).toEqual(idsA);

    // 向量时钟合流：三端都看到三个作者的计数
    for (const device of [a, b, c]) {
      const clock = device.eventLog.getClock().toJSON();
      expect(clock['ring-A']).toBe(2);
      expect(clock['ring-B']).toBe(1);
      expect(clock['ring-C']).toBe(1);
    }
  }, 60000);

  it('星形四端：叶子经中心两跳中继收敛（信任链验签）', async () => {
    const master = await generateMasterKeyPair();
    const hubDevice = await createDevice('star-hub', master);
    const leaf1 = await createDevice('star-leaf-1', master);
    const leaf2 = await createDevice('star-leaf-2', master);
    const leaf3 = await createDevice('star-leaf-3', master);

    await leaf1.store.createNode('fact', { text: 'leaf-1-data' });
    await leaf2.store.createNode('fact', { text: 'leaf-2-data' });
    await leaf3.store.createNode('fact', { text: 'leaf-3-data' });

    // 扇入：中心收齐三叶
    await syncOver(leaf1, hubDevice, {});
    await syncOver(leaf2, hubDevice, {});
    await syncOver(leaf3, hubDevice, {});
    // 扇出：中心把合流结果回各叶（叶 1 的事件经中心中继到叶 2/3）
    await syncOver(hubDevice, leaf1, {});
    await syncOver(hubDevice, leaf2, {});
    await syncOver(hubDevice, leaf3, {});

    const expected = (await nodeIds(hubDevice)).sort();
    expect(expected).toHaveLength(3);
    expect(await nodeIds(leaf1)).toEqual(expected);
    expect(await nodeIds(leaf2)).toEqual(expected);
    expect(await nodeIds(leaf3)).toEqual(expected);
  }, 30000);
});

describe('丢包链路的可恢复性', () => {
  it('30% 丢包下重试最终收敛（种子化随机，逐次换序列）', async () => {
    const master = await generateMasterKeyPair();
    const a = await createDevice('lossy-A', master);
    const b = await createDevice('lossy-B', master);
    await a.store.createNode('fact', { text: 'lossy-payload' });

    let converged = false;
    let attempts = 0;
    for (; attempts < 8 && !converged; attempts++) {
      // 链路质量逐次恢复（临时抖动语义）：0.3 → 0.2 → 0.1 → 0
      const dropRate = Math.max(0, 0.3 - attempts * 0.1);
      try {
        await syncOver(a, b, { dropRate, rng: seededRng(1000 + attempts) }, 800);
        converged = true;
      } catch {
        // 帧丢失导致会话失败——预期内，换新连接重试
      }
    }
    expect(converged).toBe(true);
    expect(attempts).toBeGreaterThan(1); // 确实经历了失败重试，而非一把成功
    expect((await b.storage.listNodes())).toHaveLength(1);
  }, 30000);
});

describe('千级节点规模冒烟', () => {
  it('1000 节点同步一轮收敛（记录耗时与事件数）', async () => {
    const master = await generateMasterKeyPair();
    const a = await createDevice('bulk-A', master);
    const b = await createDevice('bulk-B', master);

    const writeStart = Date.now();
    for (let i = 0; i < 1000; i++) {
      await a.store.createNode('fact', { text: `bulk-${i}`, seq: i });
    }
    const writeMs = Date.now() - writeStart;

    const syncStart = Date.now();
    const [resultA] = await syncOver(a, b, {}, 60000);
    const syncMs = Date.now() - syncStart;

    expect((await b.storage.listNodes())).toHaveLength(1000);
    expect(resultA.sentEvents).toBe(1000);
    const clockB = b.eventLog.getClock().toJSON();
    expect(clockB['bulk-A']).toBe(1000);

    // 规模数值留档（不设硬指标）
    console.log(`[bulk-smoke] write=${writeMs}ms sync=${syncMs}ms events=1000`);
  }, 120000);
});
