// 选择性同步（T2：供给端强制）与变更可观测性。
//
// 覆盖验收 2 / 3：
// - 对端只订阅 A 分区 → 只收到 A 分区事件；未授权分区不进 offer；
// - 快照路径同样被裁剪（空时钟 + 未授权分区绕不过授权）；
// - 对端未声明订阅时行为与改动前一致（全量）；
// - sync-completed.appliedEventIds 与实际应用集合一致、events-applied 触发。

import { describe, it, expect } from '@jest/globals';
import { GraphStore } from '../../src/core/GraphStore.js';
import { EventLog, type EventSigner } from '../../src/eventlog/EventLog.js';
import { MemoryStorage } from '../../src/storage/MemoryStorage.js';
import { SyncManager, type SyncPeer, type SyncResult } from '../../src/sync/syncmgr/SyncManager.js';
import { applyRemoteEvent } from '../../src/sync/apply.js';
import { ConfigNamespacePolicy, type NamespaceGrantPolicy } from '../../src/sync/namespacePolicy.js';
import type { Event } from '../../src/types/event.js';
import { SecureChannelSyncTransport } from '../../src/sync/protocol.js';
import { SecureChannelImpl } from '../../src/p2p/secure/SecureChannelImpl.js';
import { InMemoryHub } from '../../src/p2p/transport/InMemoryTransport.js';
import type { PeerId } from '../../src/p2p/P2PNetwork.js';
import type { Node } from '../../src/types/index.js';

interface TestDevice {
  deviceId: string;
  storage: MemoryStorage;
  eventLog: EventLog;
  store: GraphStore;
  syncManager: SyncManager;
  publicKey: Uint8Array;
  peerId: PeerId;
}

interface DeviceOptions {
  subscriptionNamespaces?: string[];
  namespacePolicy?: NamespaceGrantPolicy;
  snapshotThreshold?: number;
}

async function createDevice(deviceId: string, options: DeviceOptions = {}): Promise<TestDevice> {
  const keyPair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
  const signer: EventSigner = { deviceId, privateKey: keyPair.privateKey };

  const storage = new MemoryStorage();
  const eventLog = new EventLog(storage, deviceId, { signer });
  const store = new GraphStore({ storage, author: deviceId, eventLog });
  const syncManager = new SyncManager({
    eventLog,
    storage,
    deviceId,
    ...(options.subscriptionNamespaces ? { subscriptionNamespaces: options.subscriptionNamespaces } : {}),
    ...(options.namespacePolicy ? { namespacePolicy: options.namespacePolicy } : {}),
    ...(options.snapshotThreshold !== undefined ? { snapshotThreshold: options.snapshotThreshold } : {}),
  });
  const peerId: PeerId = { multihash: publicKey, pubKey: publicKey, id: deviceId };

  return { deviceId, storage, eventLog, store, syncManager, publicKey, peerId };
}

function peerOf(device: TestDevice): SyncPeer {
  return { deviceId: device.deviceId, publicKey: device.publicKey };
}

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

async function namespacesOn(device: TestDevice): Promise<string[]> {
  const nodes = await device.store.listNodes();
  return nodes.map((n: Node) => n.namespace ?? 'default').sort();
}

describe('选择性同步（供给端强制）', () => {
  it('对端只订阅 A 分区：只收到 A，未授权 B 分区不进 offer', async () => {
    const a = await createDevice('device-A');
    const b = await createDevice('device-B', { subscriptionNamespaces: ['nsA'] });

    await a.store.createNode('fact', { text: 'a1' }, [], { namespace: 'nsA' });
    await a.store.createNode('fact', { text: 'a2' }, [], { namespace: 'nsA' });
    await a.store.createNode('fact', { text: 'b1' }, [], { namespace: 'nsB' });

    const [resultA, resultB] = await runSync(a, b);

    expect(resultA.sentEvents).toBe(2);
    expect(resultB.receivedEvents).toBe(2);
    expect(await namespacesOn(b)).toEqual(['nsA', 'nsA']);
    expect(await namespacesOn(a)).toEqual(['nsA', 'nsA', 'nsB']);
  });

  it('数据持有者授权策略：未授权分区不进 offer（即便对端未声明）', async () => {
    const policy = new ConfigNamespacePolicy({ 'device-B': ['nsA'] });
    const a = await createDevice('device-A', { namespacePolicy: policy });
    const b = await createDevice('device-B');

    await a.store.createNode('fact', { text: 'a1' }, [], { namespace: 'nsA' });
    await a.store.createNode('fact', { text: 'b1' }, [], { namespace: 'nsB' });

    const [resultA] = await runSync(a, b);

    expect(resultA.sentEvents).toBe(1);
    expect(await namespacesOn(b)).toEqual(['nsA']);
    expect(await namespacesOn(a)).toEqual(['nsA', 'nsB']);
  });

  it('快照路径同样裁剪：空时钟 + 未授权分区绕不过授权', async () => {
    const policy = new ConfigNamespacePolicy({ 'device-B': ['nsA'] });
    const a = await createDevice('device-A', { namespacePolicy: policy, snapshotThreshold: 1 });
    const b = await createDevice('device-B');

    for (let i = 0; i < 3; i++) {
      await a.store.createNode('fact', { text: `a${i}` }, [], { namespace: 'nsA' });
    }
    for (let i = 0; i < 3; i++) {
      await a.store.createNode('fact', { text: `b${i}` }, [], { namespace: 'nsB' });
    }

    const [resultA, resultB] = await runSync(a, b);

    // 走物化快照，且只包含被授权的 nsA
    expect(resultA.snapshotSent).toBe(3);
    expect(resultA.sentEvents).toBe(0);
    expect(resultB.snapshotApplied).toBe(3);
    expect(await namespacesOn(b)).toEqual(['nsA', 'nsA', 'nsA']);
  });

  it('对端未声明订阅（旧版本）：行为与改动前一致（全量同步）', async () => {
    const a = await createDevice('device-A');
    const b = await createDevice('device-B');

    await a.store.createNode('fact', { text: 'a1' }, [], { namespace: 'nsA' });
    await a.store.createNode('fact', { text: 'b1' }, [], { namespace: 'nsB' });

    const [resultA, resultB] = await runSync(a, b);

    expect(resultA.sentEvents).toBe(2);
    expect(resultB.receivedEvents).toBe(2);
    expect(await namespacesOn(b)).toEqual(['nsA', 'nsB']);
  });

  it('授权策略为空白名单：明确不允许任何分区（不进 offer）', async () => {
    const policy = new ConfigNamespacePolicy({ 'device-B': [] });
    const a = await createDevice('device-A', { namespacePolicy: policy });
    const b = await createDevice('device-B');

    await a.store.createNode('fact', { text: 'a1' }, [], { namespace: 'nsA' });
    await a.store.createNode('fact', { text: 'b1' }, [], { namespace: 'nsB' });

    const [resultA] = await runSync(a, b);

    expect(resultA.sentEvents).toBe(0);
    expect(await namespacesOn(b)).toEqual([]);
  });

  it('本机订阅：数据持有者只供自己订阅的分区', async () => {
    const a = await createDevice('device-A', { subscriptionNamespaces: ['nsA'] });
    const b = await createDevice('device-B');

    await a.store.createNode('fact', { text: 'a1' }, [], { namespace: 'nsA' });
    await a.store.createNode('fact', { text: 'b1' }, [], { namespace: 'nsB' });

    const [resultA] = await runSync(a, b);

    expect(resultA.sentEvents).toBe(1);
    expect(await namespacesOn(b)).toEqual(['nsA']);
  });
});

describe('变更可观测性', () => {
  it('sync-completed.appliedEventIds 与实际应用集合一致', async () => {
    const a = await createDevice('device-A');
    const b = await createDevice('device-B');

    const n1 = await a.store.createNode('fact', { text: 'a1' });
    const n2 = await a.store.createNode('fact', { text: 'a2' });
    const sentIds = (await a.eventLog.listEvents()).map((e) => e.id).sort();

    const [, resultB] = await runSync(a, b);

    expect([...(resultB.appliedEventIds ?? [])].sort()).toEqual(sentIds);
    expect((await b.store.listNodes()).map((n) => n.id).sort()).toEqual([n1.id, n2.id].sort());
  });

  it('events-applied 触发，并能区分 namespace', async () => {
    const a = await createDevice('device-A');
    const b = await createDevice('device-B', { subscriptionNamespaces: ['nsA'] });

    await a.store.createNode('fact', { text: 'a1' }, [], { namespace: 'nsA' });
    await a.store.createNode('fact', { text: 'b1' }, [], { namespace: 'nsB' });

    const applied = new Promise<{ eventIds: string[]; namespaces: string[] }>((resolve) =>
      b.syncManager.once('events-applied', (payload) => resolve(payload as never)),
    );

    const [, resultB] = await runSync(a, b);

    const payload = await applied;
    expect(payload.eventIds).toHaveLength(1);
    expect(payload.namespaces).toEqual(['nsA']);
    expect(resultB.appliedEventIds).toHaveLength(1);
  });

  it('远端删除事件在目标缺失时按事件 namespace 落墓碑', async () => {
    const storage = new MemoryStorage();
    const deletion: Event = {
      id: 'e-del',
      type: 'node_deleted',
      timestamp: 1,
      vectorClock: { 'device-A': 1 },
      data: { nodeId: 'gone', deletionTime: 2 },
      author: 'device-A',
      signature: '',
      namespace: 'nsA',
    };
    const result = await applyRemoteEvent(storage, deletion);
    expect(result.status).toBe('applied');
    expect((await storage.getNode('gone'))?.namespace).toBe('nsA');
  });

  it('快照路径不产生 appliedEventIds / events-applied', async () => {
    const a = await createDevice('device-A', { snapshotThreshold: 1 });
    const b = await createDevice('device-B');

    let appliedFired = false;
    b.syncManager.on('events-applied', () => { appliedFired = true; });

    for (let i = 0; i < 6; i++) {
      await a.store.createNode('fact', { text: `a${i}` });
    }

    const [, resultB] = await runSync(a, b);

    expect(resultB.snapshotApplied).toBe(6);
    expect(resultB.appliedEventIds ?? []).toHaveLength(0);
    expect(appliedFired).toBe(false);
  });
});
