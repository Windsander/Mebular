// SyncManager 测试（phase-3-plan 3.2/3.3/3.4）
//
// 两台「设备」各自持有 MemoryStorage + EventLog(签名) + GraphStore(事件化)
// + SyncManager，传输层用 InMemoryHub 直连 + 真实 SecureChannel（X25519+AES-GCM）。
// 覆盖：双向/推/拉三种模式、幂等重同步、并发冲突收敛、伪造事件拒绝、待同步队列。

import { describe, it, expect } from '@jest/globals';
import { GraphStore } from '../../src/core/GraphStore.js';
import { EventLog, type EventSigner } from '../../src/eventlog/EventLog.js';
import { MemoryStorage } from '../../src/storage/MemoryStorage.js';
import { SyncManager, type SyncPeer, type SyncResult } from '../../src/sync/syncmgr/SyncManager.js';
import { SecureChannelSyncTransport, type SyncMessage } from '../../src/sync/protocol.js';
import { SecureChannelImpl } from '../../src/p2p/secure/SecureChannelImpl.js';
import { InMemoryHub } from '../../src/p2p/transport/InMemoryTransport.js';
import type { PeerId } from '../../src/p2p/P2PNetwork.js';
import type { Event } from '../../src/types/event.js';

interface TestDevice {
  deviceId: string;
  storage: MemoryStorage;
  eventLog: EventLog;
  store: GraphStore;
  syncManager: SyncManager;
  publicKey: Uint8Array;
  peerId: PeerId;
}

async function createDevice(deviceId: string): Promise<TestDevice> {
  const keyPair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
  const signer: EventSigner = { deviceId, privateKey: keyPair.privateKey };

  const storage = new MemoryStorage();
  const eventLog = new EventLog(storage, deviceId, { signer });
  const store = new GraphStore({ storage, author: deviceId, eventLog });
  const syncManager = new SyncManager({ eventLog, storage, deviceId });
  const peerId: PeerId = { multihash: publicKey, pubKey: publicKey, id: deviceId };

  return { deviceId, storage, eventLog, store, syncManager, publicKey, peerId };
}

function peerOf(device: TestDevice): SyncPeer {
  return { deviceId: device.deviceId, publicKey: device.publicKey };
}

/** 造一对加密信道并包成同步传输 */
async function linkedTransports(
  a: TestDevice,
  b: TestDevice,
): Promise<[SecureChannelSyncTransport, SecureChannelSyncTransport]> {
  const hub = new InMemoryHub();
  const [connA, connB] = hub.createLinkedPair(a.peerId, b.peerId);
  const channelA = new SecureChannelImpl(connA);
  const channelB = new SecureChannelImpl(connB);
  await Promise.all([channelA.start(), channelB.start()]);
  return [new SecureChannelSyncTransport(channelA), new SecureChannelSyncTransport(channelB)];
}

/** 发起方 + 响应方并发跑完一次会话 */
async function runSync(
  initiator: TestDevice,
  responder: TestDevice,
  direction: 'push' | 'pull' | 'bidirectional' = 'bidirectional',
): Promise<[SyncResult, SyncResult]> {
  const [tA, tB] = await linkedTransports(initiator, responder);
  return Promise.all([
    initiator.syncManager.syncWithDevice(tA, peerOf(responder), { direction }),
    responder.syncManager.acceptSync(tB, peerOf(initiator)),
  ]);
}

async function nodeIds(device: TestDevice): Promise<string[]> {
  return (await device.store.listNodes()).map((n) => n.id).sort();
}

describe('SyncManager', () => {
  it('双向同步：双端离线写入最终收敛一致', async () => {
    const a = await createDevice('device-A');
    const b = await createDevice('device-B');

    const n1 = await a.store.createNode('fact', { text: 'a1' });
    const n2 = await a.store.createNode('fact', { text: 'a2' });
    const n3 = await b.store.createNode('fact', { text: 'b1' });
    await b.store.createEdge(n3.id, n3.id, 'self');

    const [resultA, resultB] = await runSync(a, b);

    expect(resultA.sentEvents).toBe(2);
    expect(resultA.receivedEvents).toBe(2); // B 的 1 节点 + 1 边
    expect(resultB.receivedEvents).toBe(2);

    expect(await nodeIds(a)).toEqual(await nodeIds(b));
    expect(await nodeIds(a)).toEqual([n1.id, n2.id, n3.id].sort());
    expect((await a.store.getNode(n3.id))?.content).toEqual({ text: 'b1' });
    expect(await a.store.listEdges()).toHaveLength(1);

    // 向量时钟合流
    expect(a.eventLog.getClock().toJSON()).toEqual(b.eventLog.getClock().toJSON());
    // 双端事件日志全量一致
    expect((await a.eventLog.listEvents()).map((e) => e.id).sort())
      .toEqual((await b.eventLog.listEvents()).map((e) => e.id).sort());
  });

  it('重同步幂等：第二次会话无新增应用', async () => {
    const a = await createDevice('device-A');
    const b = await createDevice('device-B');
    await a.store.createNode('fact', { text: 'a1' });

    await runSync(a, b);
    const [againA] = await runSync(a, b);

    expect(againA.sentEvents).toBe(0);
    expect(againA.receivedEvents).toBe(0);
    expect(await a.store.listNodes()).toHaveLength(1);
    expect(await b.store.listNodes()).toHaveLength(1);
  });

  it('push 模式：只推不收', async () => {
    const a = await createDevice('device-A');
    const b = await createDevice('device-B');
    const n1 = await a.store.createNode('fact', { text: 'a1' });
    const n2 = await b.store.createNode('fact', { text: 'b1' });

    await runSync(a, b, 'push');

    expect(await b.store.getNode(n1.id)).not.toBeNull(); // B 收到 A 的
    expect(await a.store.getNode(n2.id)).toBeNull();     // A 不收 B 的
  });

  it('pull 模式：只收不推', async () => {
    const a = await createDevice('device-A');
    const b = await createDevice('device-B');
    const n1 = await a.store.createNode('fact', { text: 'a1' });
    const n2 = await b.store.createNode('fact', { text: 'b1' });

    await runSync(a, b, 'pull');

    expect(await a.store.getNode(n2.id)).not.toBeNull(); // A 拉到 B 的
    expect(await b.store.getNode(n1.id)).toBeNull();     // B 不收 A 的
  });

  it('并发更新按确定性规则收敛，双端一致且上报冲突', async () => {
    const a = await createDevice('device-A');
    const b = await createDevice('device-B');

    const node = await a.store.createNode('fact', { text: 'base' });
    await runSync(a, b); // 双端都有 base

    // 离线并发改同一节点
    await a.store.updateNode(node.id, { content: { text: 'edit-A' } });
    await new Promise((r) => setTimeout(r, 5)); // 保证 updatedAt 可分先后
    await b.store.updateNode(node.id, { content: { text: 'edit-B' } });

    const [resultA] = await runSync(a, b);

    // B 的 updatedAt 更晚 → 双端都收敛到 edit-B
    expect((await a.store.getNode(node.id))?.content).toEqual({ text: 'edit-B' });
    expect((await b.store.getNode(node.id))?.content).toEqual({ text: 'edit-B' });
    // A 侧本地落败 → 记录冲突；B 侧远端落败 → 也记录冲突
    expect(resultA.conflicts.length).toBeGreaterThan(0);
    expect(resultA.conflicts[0]!.resolution).toBe('auto');
  });

  it('验签失败的事件中止会话并上报 sync-failed', async () => {
    const a = await createDevice('device-A');
    const b = await createDevice('device-B');

    // 伪造：攻击者签了一个事件，冒充 B 发出
    const attacker = await createDevice('device-C');
    const forged = await attacker.eventLog.append({ type: 'node_created', data: { node: { id: 'evil' } } });
    const forgedEvent: Event = { ...forged, author: 'device-B' };

    const hub = new InMemoryHub();
    const [connA, connB] = hub.createLinkedPair(a.peerId, b.peerId);
    const chA = new SecureChannelImpl(connA);
    const chB = new SecureChannelImpl(connB);
    await Promise.all([chA.start(), chB.start()]);
    const tA = new SecureChannelSyncTransport(chA);
    const tB = new SecureChannelSyncTransport(chB);

    const failed = new Promise<unknown>((resolve) => a.syncManager.once('sync-failed', resolve));

    // B 侧由脚本扮演：走完协议帧序，但 offer 里夹带伪造事件
    const scriptB = (async () => {
      const it = tB.receive()[Symbol.asyncIterator]();
      const helloA = (await it.next()).value as Extract<SyncMessage, { type: 'sync-hello' }>;
      await tB.send({ type: 'sync-hello', vectorClock: {} });
      const offerA = (await it.next()).value as Extract<SyncMessage, { type: 'sync-offer' }>;
      await tB.send({ type: 'sync-ack', appliedEventIds: offerA.events.map((e) => e.id) });
      await tB.send({ type: 'sync-offer', events: [forgedEvent] });
      void helloA;
    })();

    await expect(
      a.syncManager.syncWithDevice(tA, peerOf(b), { direction: 'bidirectional' }),
    ).rejects.toThrow(/signature verification failed/);
    await failed;
    await scriptB;
    // 伪造事件不得进入事件日志与图
    expect(await a.eventLog.getEvent(forgedEvent.id)).toBeNull();
    expect(await a.store.getNode('evil')).toBeNull();
  });

  it('待同步队列：同步前全部待同步，ack 后清空', async () => {
    const a = await createDevice('device-A');
    const b = await createDevice('device-B');
    await a.store.createNode('fact', { text: 'a1' });
    await a.store.createNode('fact', { text: 'a2' });

    expect(await a.syncManager.hasPendingEvents('device-B')).toBe(true);
    expect((await a.syncManager.getPendingEvents('device-B'))).toHaveLength(2);
    expect((await a.syncManager.getSyncStatus()).pendingCount).toBe(2);

    await runSync(a, b);

    expect(await a.syncManager.hasPendingEvents('device-B')).toBe(false);
    const status = await a.syncManager.getSyncStatus();
    expect(status.lastResult?.sentEvents).toBe(2);
    expect(status.lastSyncAt).not.toBeNull();
  });

  it('断线后续传：失败保留待同步队列，重连后收敛', async () => {
    const a = await createDevice('device-A');
    const b = await createDevice('device-B');
    const n1 = await a.store.createNode('fact', { text: 'a1' });

    // 第一次会话：B 侧脚本收到 offer 后直接断线（不回 ack）
    {
      const hub = new InMemoryHub();
      const [connA, connB] = hub.createLinkedPair(a.peerId, b.peerId);
      const chA = new SecureChannelImpl(connA);
      const chB = new SecureChannelImpl(connB);
      await Promise.all([chA.start(), chB.start()]);
      const tA = new SecureChannelSyncTransport(chA);
      const tB = new SecureChannelSyncTransport(chB);

      const scriptB = (async () => {
        const it = tB.receive()[Symbol.asyncIterator]();
        await it.next(); // hello
        await tB.send({ type: 'sync-hello', vectorClock: {} });
        await it.next(); // offer
        await chB.close(); // 不回 ack，模拟断线
      })();

      await expect(
        a.syncManager.syncWithDevice(tA, peerOf(b), { timeoutMs: 500 }),
      ).rejects.toThrow(/timeout|closed/i);
      await scriptB.catch(() => undefined);
      // 未 ack → 队列保留
      expect(await a.syncManager.hasPendingEvents('device-B')).toBe(true);
    }

    // 重连后续传：幂等性保证安全
    await runSync(a, b);
    expect((await b.store.getNode(n1.id))?.content).toEqual({ text: 'a1' });
    expect(await a.syncManager.hasPendingEvents('device-B')).toBe(false);
  });
});
