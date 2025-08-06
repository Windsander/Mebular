// 图同步端到端集成测试（phase-3-plan 毕业条件 2/4/5）
//
// 两台完整「设备」：P2PNode（真实身份/证书/加密信道）+ GraphStore（事件化）
// + EventLog（签名）+ SyncManager（attachToNode 自动同步）。
// 传输走 InMemoryHub，mDNS 走共享总线——链路语义完整，无网络依赖。

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { P2PNode } from '../../src/p2p/P2PNetwork.js';
import { InMemoryHub } from '../../src/p2p/transport/InMemoryTransport.js';
import type { BonjourService, BonjourServiceInstance } from '../../src/p2p/DeviceDiscovery.js';
import { GraphStore } from '../../src/core/GraphStore.js';
import { EventLog, type EventSigner } from '../../src/eventlog/EventLog.js';
import { MemoryStorage } from '../../src/storage/MemoryStorage.js';
import { JsonFileStorage } from '../../src/storage/JsonFileStorage.js';
import { SyncManager, type SyncResult } from '../../src/sync/syncmgr/SyncManager.js';
import { SecureChannelSyncTransport } from '../../src/sync/protocol.js';
import type { StorageAdapter } from '../../src/storage/StorageAdapter.js';
import {
  createTestIdentity,
  generateMasterKeyPair,
  issueCertificate,
  masterPublicKeyBytes,
  waitFor,
  type TestIdentity,
} from '../p2p/helpers.js';

/** 共享 mDNS 总线（与 P2PNetwork 集成测试同款模拟） */
class MockBonjourBus {
  private services: BonjourService[] = [];
  private finders: Array<(svc: BonjourService) => void> = [];

  createInstance(): BonjourServiceInstance {
    const bus = this;
    return {
      publish(options) {
        const service: BonjourService = {
          name: options.name,
          type: options.type,
          port: options.port,
          txt: options.txt ?? {},
          addresses: ['memory://local'],
        };
        bus.services.push(service);
        for (const finder of [...bus.finders]) {
          finder(service);
        }
      },
      find(_query, callback) {
        bus.finders.push(callback);
        for (const service of bus.services) {
          callback(service);
        }
        return {
          stop: () => {
            bus.finders = bus.finders.filter((f) => f !== callback);
          },
        };
      },
      destroy() {},
    };
  }
}

interface SyncDevice {
  deviceId: string;
  identity: TestIdentity;
  node: P2PNode;
  storage: StorageAdapter;
  eventLog: EventLog;
  store: GraphStore;
  syncManager: SyncManager | null;
}

/**
 * 组装一台设备：身份+证书 → P2PNode；存储+事件日志+图。
 * attach=true 时创建 SyncManager 并挂到节点（认证后自动同步）。
 */
async function createSyncDevice(
  hub: InMemoryHub,
  bus: MockBonjourBus,
  deviceId: string,
  master: CryptoKeyPair,
  options: { storage?: StorageAdapter; attach?: boolean } = {},
): Promise<SyncDevice> {
  const identity = await createTestIdentity(deviceId);
  await issueCertificate(master.privateKey, identity);

  const node = new P2PNode({
    identity: {
      deviceId: identity.identity.deviceId,
      devicePublicKey: identity.identity.devicePublicKey,
      devicePrivateKey: identity.identity.devicePrivateKey,
      certificate: identity.identity.certificate!,
    },
    userMasterPublicKey: await masterPublicKeyBytes(master),
    provider: hub,
    bonjourFactory: () => bus.createInstance(),
  });

  const signer: EventSigner = { deviceId, privateKey: identity.identity.devicePrivateKey };
  const storage = options.storage ?? new MemoryStorage();
  const eventLog = new EventLog(storage, deviceId, { signer });
  const store = new GraphStore({ storage, author: deviceId, eventLog });

  let syncManager: SyncManager | null = null;
  if (options.attach ?? true) {
    syncManager = new SyncManager({ eventLog, storage, deviceId });
    syncManager.attachToNode(node);
  }

  return { deviceId, identity, node, storage, eventLog, store, syncManager };
}

/** 双端都完成一次自动同步（需在连接前调用以装上监听器） */
function awaitAutoSync(a: SyncDevice, b: SyncDevice): Promise<[SyncResult, SyncResult]> {
  const doneA = new Promise<SyncResult>((resolve) => a.syncManager!.once('sync-completed', resolve));
  const doneB = new Promise<SyncResult>((resolve) => b.syncManager!.once('sync-completed', resolve));
  return Promise.all([doneA, doneB]);
}

async function snapshotOf(device: SyncDevice): Promise<{ nodes: string[]; edges: string[] }> {
  const nodes = (await device.store.listNodes()).map((n) => `${n.id}:${JSON.stringify(n.content)}`).sort();
  const edges = (await device.store.listEdges()).map((e) => `${e.id}:${e.source}->${e.target}`).sort();
  return { nodes, edges };
}

describe('GraphSync Integration', () => {
  jest.setTimeout(20000);

  let hub: InMemoryHub;
  let bus: MockBonjourBus;
  let master: CryptoKeyPair;
  let deviceA: SyncDevice;
  let deviceB: SyncDevice;

  beforeEach(async () => {
    hub = new InMemoryHub();
    bus = new MockBonjourBus();
    master = await generateMasterKeyPair();
  });

  afterEach(async () => {
    for (const device of [deviceA, deviceB]) {
      if (device?.node.isRunning()) {
        await device.node.stop();
      }
    }
  });

  it('离线写入 → 认证连接 → 自动同步 → 双端收敛一致', async () => {
    deviceA = await createSyncDevice(hub, bus, 'device-A', master);
    deviceB = await createSyncDevice(hub, bus, 'device-B', master);

    // 离线期间各自写入（节点未启动，无连接）
    const a1 = await deviceA.store.createNode('fact', { text: 'A 的事实' });
    const a2 = await deviceA.store.createNode('fact', { text: 'A 的另一条' });
    const b1 = await deviceB.store.createNode('fact', { text: 'B 的事实' });
    await deviceB.store.createEdge(b1.id, b1.id, 'self');
    await deviceA.store.addTag(a1.id, 'important');

    // 启动并连接：认证完成触发自动同步
    const synced = awaitAutoSync(deviceA, deviceB);
    await deviceA.node.start();
    await deviceB.node.start();
    await waitFor(() => deviceA.node.getDiscovery()?.getPeer(deviceB.node.peerId) != null);
    await deviceA.node.connectToPeer(deviceB.node.peerId);
    const [resultA, resultB] = await synced;

    // 双端图内容一致
    const snapA = await snapshotOf(deviceA);
    const snapB = await snapshotOf(deviceB);
    expect(snapA).toEqual(snapB);
    expect(snapA.nodes).toHaveLength(3);
    expect(snapA.edges).toHaveLength(1);
    expect((await deviceB.store.getNode(a1.id))?.tags).toEqual(['important']);
    expect((await deviceB.store.getNode(a2.id))?.content).toEqual({ text: 'A 的另一条' });

    // 时钟合流、事件日志一致
    expect(deviceA.eventLog.getClock().toJSON()).toEqual(deviceB.eventLog.getClock().toJSON());
    expect((await deviceA.eventLog.listEvents()).map((e) => e.id).sort())
      .toEqual((await deviceB.eventLog.listEvents()).map((e) => e.id).sort());

    // 无冲突、全部验签通过；同步结果互相印证
    expect(resultA.conflicts).toHaveLength(0);
    expect(resultB.conflicts).toHaveLength(0);
    expect(resultA.sentEvents).toBe(resultB.receivedEvents);
    expect(resultB.sentEvents).toBe(resultA.receivedEvents);
  });

  it('事件日志与待同步队列跨重启存活，重连后续传收敛', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mebular-sync-'));
    try {
      const file = join(dir, 'device-a.jsonl');

      // 第一次「开机」：A 用文件存储，离线写入两条（尚未挂同步管理器）
      const persisted = await JsonFileStorage.open(file);
      deviceA = await createSyncDevice(hub, bus, 'device-A', master, {
        storage: persisted,
        attach: false,
      });
      const n1 = await deviceA.store.createNode('fact', { text: '重启前 1' });
      const n2 = await deviceA.store.createNode('fact', { text: '重启前 2' });
      await persisted.close();

      // 「重启」：重开文件，事件日志从存储恢复时钟
      const reopened = await JsonFileStorage.open(file);
      const signer: EventSigner = {
        deviceId: 'device-A',
        privateKey: deviceA.identity.identity.devicePrivateKey,
      };
      const restoredLog = await EventLog.restore(reopened, 'device-A', { signer });
      // 时钟连续：计数器不回退
      expect(restoredLog.getClock().toJSON()['device-A']).toBe(2);
      // 事件仍在（待同步队列的依据）
      expect(await restoredLog.listEvents()).toHaveLength(2);

      // 重新接线图与同步管理器（模拟进程重启后的重建）
      const store = new GraphStore({ storage: reopened, author: 'device-A', eventLog: restoredLog });
      const syncManager = new SyncManager({
        eventLog: restoredLog,
        storage: reopened,
        deviceId: 'device-A',
      });
      syncManager.attachToNode(deviceA.node);
      deviceA = { ...deviceA, storage: reopened, eventLog: restoredLog, store, syncManager };

      deviceB = await createSyncDevice(hub, bus, 'device-B', master);
      expect(await syncManager.hasPendingEvents('device-B')).toBe(true);

      // 上线连接 → 自动同步把重启前的写入送达 B
      const synced = awaitAutoSync(deviceA, deviceB);
      await deviceA.node.start();
      await deviceB.node.start();
      await waitFor(() => deviceA.node.getDiscovery()?.getPeer(deviceB.node.peerId) != null);
      await deviceA.node.connectToPeer(deviceB.node.peerId);
      await synced;

      expect((await deviceB.store.getNode(n1.id))?.content).toEqual({ text: '重启前 1' });
      expect((await deviceB.store.getNode(n2.id))?.content).toEqual({ text: '重启前 2' });
      expect(await syncManager.hasPendingEvents('device-B')).toBe(false);

      await reopened.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('伪造事件在真实信道上被拒绝且不污染图', async () => {
    deviceA = await createSyncDevice(hub, bus, 'device-A', master);
    deviceB = await createSyncDevice(hub, bus, 'device-B', master);

    // 攻击者（另一个用户的设备私钥）伪造一条冒名 A 的事件
    const attacker = await createSyncDevice(hub, bus, 'device-C', await generateMasterKeyPair(), {
      attach: false,
    });
    const forged = await attacker.eventLog.append({
      type: 'node_created',
      data: { node: { id: 'forged-node', type: 'fact', content: { text: 'evil' } } },
    });
    const forgedEvent = { ...forged, author: 'device-A' };

    // 先让首次自动同步完整落定，确保信道空闲
    const synced = awaitAutoSync(deviceA, deviceB);
    await deviceA.node.start();
    await deviceB.node.start();
    await waitFor(() => deviceA.node.getDiscovery()?.getPeer(deviceB.node.peerId) != null);
    await deviceA.node.connectToPeer(deviceB.node.peerId);
    await synced;

    // 由 A 侧脚本扮演敌意对端：协议帧序正常，但 offer 夹带伪造事件
    const channelToB = await deviceA.node.getChannel(deviceB.node.peerId);
    const channelToA = await deviceB.node.getChannel(deviceA.node.peerId);
    expect(channelToB).not.toBeNull();
    expect(channelToA).not.toBeNull();
    const hostile = new SecureChannelSyncTransport(channelToB!);
    const transportB = new SecureChannelSyncTransport(channelToA!);

    // B 以 SyncManager 响应这个会话；对端公钥按 A 的设备公钥验签
    const responderPromise = deviceB.syncManager!.acceptSync(transportB, {
      deviceId: 'device-A',
      publicKey: deviceA.identity.identity.devicePublicKey,
    });
    // 同步挂上拒绝期望，避免验签失败早于断言注册而被判为未处理拒绝
    const responderExpectation = expect(responderPromise).rejects.toThrow(/signature verification failed/);

    const iterator = hostile.receive()[Symbol.asyncIterator]();
    await hostile.send({ type: 'sync-hello', vectorClock: {}, direction: 'bidirectional' });
    await iterator.next(); // B 的 hello
    await hostile.send({ type: 'sync-offer', events: [forgedEvent] });

    // B 验签失败 → 回 sync-error 并中止会话
    const reply = await iterator.next();
    expect(reply.value.type).toBe('sync-error');
    await responderExpectation;

    // 伪造事件不进入 B 的图与日志
    expect(await deviceB.store.getNode('forged-node')).toBeNull();
    expect(await deviceB.eventLog.getEvent(forgedEvent.id)).toBeNull();
  });
});
