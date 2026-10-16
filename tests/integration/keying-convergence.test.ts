// P1·B2 · N2 判别性集成：同设备**第二键再拨**的收敛与对抗。
//
// 现实触发（daemon×daemon）：join 上车把邀请方地址双键写入地址簿（deviceId + 派生 hex，
// F-C12-1），mDNS 通告的恰是派生 hex → lanAutoDial 以 hex 键对同一对端再拨一次；
// 拨号侧连接键因此出现多形态（libp2p id / deviceId / 派生 hex），被拨侧恒派生 hex。
//
// 本夹具在 InMemory 传输上构造同一双设备的两条连接（拨号键不同形态）——
// InMemoryHub 会把拨号键规范成注册 peerId，故这里手动建链并驱动两侧认证
// （与 GraphSync 集成测试的敌意对端驱动方式一致），以复现真实键形态。
//
// 红→绿锚点（N1+N2 前）：第二连接出现后，B 的亲签事件零落 A（nudge 落旧 entry 静默丢弃
// + 全局会话队列被旧 responder 占住）；修复后：旧连接显式退役、同步在新连接上保持。
// 对抗锚点：第二次认证失败（异主证书）→ 旧连接必须继续正常服务（影子会话不得覆盖）。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { P2PNode, type PeerId } from '../../src/p2p/P2PNetwork.js';
import { InMemoryHub, InMemoryConnection } from '../../src/p2p/transport/InMemoryTransport.js';
import { GraphStore } from '../../src/core/GraphStore.js';
import { EventLog } from '../../src/eventlog/EventLog.js';
import { MemoryStorage } from '../../src/storage/MemoryStorage.js';
import { SyncManager } from '../../src/sync/syncmgr/SyncManager.js';
import {
  AuthenticationHandshake,
  type DeviceCertificate,
} from '../../src/p2p/handshake/AuthenticationHandshake.js';
import {
  createTestIdentity,
  generateMasterKeyPair,
  issueCertificate,
  masterPublicKeyBytes,
  type TestIdentity,
} from '../p2p/helpers.js';
import { grant } from '../helpers/namespace.js';
import { useHeavyTimeout } from '../helpers/timeouts.js';

useHeavyTimeout();

interface SyncDevice {
  deviceId: string;
  identity: TestIdentity;
  node: P2PNode;
  store: GraphStore;
  sync: SyncManager;
}

async function createDevice(
  hub: InMemoryHub,
  deviceId: string,
  master: CryptoKeyPair,
  masterPub: Uint8Array,
): Promise<SyncDevice> {
  const identity = await createTestIdentity(deviceId);
  await issueCertificate(master.privateKey, identity);
  const node = new P2PNode({
    identity: {
      deviceId,
      devicePublicKey: identity.identity.devicePublicKey,
      devicePrivateKey: identity.identity.devicePrivateKey,
      certificate: identity.identity.certificate as DeviceCertificate,
    },
    userMasterPublicKey: masterPub,
    provider: hub,
    lan: { enabled: false },
  });
  const storage = new MemoryStorage();
  const eventLog = new EventLog(storage, deviceId, {
    signer: { deviceId, privateKey: identity.identity.devicePrivateKey },
  });
  const store = new GraphStore({ storage, author: deviceId, eventLog });
  const sync = new SyncManager({
    eventLog,
    storage,
    deviceId,
    namespacePolicy: grant(),
    pushOnWrite: true,
    pushOnWriteThrottleMs: 20,
  });
  sync.attachToNode(node);
  return { deviceId, identity, node, store, sync };
}

function rawPeerId(id: string): PeerId {
  return { id, multihash: new Uint8Array(), pubKey: new Uint8Array() };
}

/**
 * 构造一条「拨号侧本地键 ≠ 规范键」的连接对：
 * - bEnd：B 侧连接对象，peerId = 拨号键（任意形态）；
 * - aEnd：A 侧连接对象，peerId = 握手派生键（被拨侧恒规范形态）。
 */
function linkedPair(a: SyncDevice, b: SyncDevice, dialKey: PeerId) {
  const bEnd = new InMemoryConnection(b.node.peerId, dialKey, `memory://${a.node.peerId.id}`);
  const aEnd = new InMemoryConnection(a.node.peerId, b.node.peerId, `memory://${b.node.peerId.id}`);
  bEnd.link(aEnd);
  aEnd.link(bEnd);
  return { bEnd, aEnd };
}

/** B 主动拨 A（手动驱动两侧：A 走被动接入路径，B 走主动认证路径） */
async function redialWithKey(
  a: SyncDevice,
  b: SyncDevice,
  dialKey: PeerId,
  aEnd: InMemoryConnection,
  bEnd: InMemoryConnection,
  bHandshake?: AuthenticationHandshake,
): Promise<void> {
  b.node.getConnectionManager().setConnection(dialKey, bEnd);
  await Promise.all([
    (a.node as unknown as { handleIncomingConnection: (c: unknown) => Promise<void> }).handleIncomingConnection(aEnd),
    bHandshake ? bHandshake.initiateAuth(bEnd).catch(() => null) : b.node.authenticatePeer(bEnd),
  ]);
}

async function waitUntil(check: () => Promise<boolean> | boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error('waitUntil timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const privates = (node: P2PNode) =>
  node as unknown as {
    activePeerConnections: Map<string, InMemoryConnection>;
    channelOwner: Map<string, InMemoryConnection>;
  };

describe('P1 N2 · 第二键再拨的收敛（同设备单活连接）', () => {
  let hub: InMemoryHub;
  let master: CryptoKeyPair;
  let masterPub: Uint8Array;
  let a: SyncDevice;
  let b: SyncDevice;

  beforeEach(async () => {
    hub = new InMemoryHub();
    master = await generateMasterKeyPair();
    masterPub = await masterPublicKeyBytes(master);
    a = await createDevice(hub, 'device-A', master, masterPub);
    b = await createDevice(hub, 'device-B', master, masterPub);
    await a.node.start();
    await b.node.start();
  });

  afterEach(async () => {
    for (const d of [a, b]) {
      if (d?.node.isRunning()) await d.node.stop();
    }
  });

  async function connectFirst(dialKeyId: string) {
    const settled = Promise.all([
      new Promise((resolve) => a.sync.once('sync-completed', resolve)),
      new Promise((resolve) => b.sync.once('sync-completed', resolve)),
    ]);
    const { aEnd, bEnd } = linkedPair(a, b, rawPeerId(dialKeyId));
    await redialWithKey(a, b, rawPeerId(dialKeyId), aEnd, bEnd);
    await settled;
    return { aEnd, bEnd };
  }

  it('第二键（派生 hex 形态）再拨：旧连接退役，B 的亲签写入在新连接上落到 A', async () => {
    // 连接①：拨号键 = 模拟 libp2p id（非规范形态）
    const c1 = await connectFirst('12D3KooWSimulatedFirstDialKey');

    // 基线：B 写 → A 收到（响应方 nudge 路径可用）
    const n1 = await b.store.createNode('fact', { text: 'before-redial' });
    await waitUntil(async () => (await a.store.getNode(n1.id)) !== null);

    // 连接②：拨号键 = B 侧对 A 的派生 hex（真实 mDNS 自动再拨的键形态 = A 的规范 peerId）
    const dialKey2 = a.node.peerId;
    const settled2 = Promise.all([
      new Promise((resolve) => a.sync.once('sync-completed', resolve)),
      new Promise((resolve) => b.sync.once('sync-completed', resolve)),
    ]);
    const c2 = linkedPair(a, b, dialKey2);
    await redialWithKey(a, b, dialKey2, c2.aEnd, c2.bEnd);

    // 收敛：旧连接被显式退役（两侧），规范键下只剩新连接
    await waitUntil(() => c1.aEnd.state === 'closed' && c1.bEnd.state === 'closed');
    await waitUntil(() => {
      const aActive = privates(a.node).activePeerConnections;
      const bActive = privates(b.node).activePeerConnections;
      return (
        aActive.size === 1 &&
        aActive.get(b.node.peerId.id) === c2.aEnd &&
        bActive.size === 1 &&
        bActive.get(a.node.peerId.id) === c2.bEnd
      );
    });
    // B 侧连接表：旧的拨号键表项已被退役清理，只剩新键
    const bConns = b.node.getConnectionManager().getConnections();
    expect(bConns).toHaveLength(1);
    expect(bConns[0]).toBe(c2.bEnd);

    await settled2;

    // 核心断言（缺陷方向）：收敛后 B 的亲签事件必须继续落 A
    const n2 = await b.store.createNode('fact', { text: 'after-redial-from-B' });
    await waitUntil(async () => (await a.store.getNode(n2.id)) !== null);
    expect((await a.store.getNode(n2.id))?.content).toEqual({ text: 'after-redial-from-B' });

    // 反向也保持
    const n3 = await a.store.createNode('fact', { text: 'after-redial-from-A' });
    await waitUntil(async () => (await b.store.getNode(n3.id)) !== null);

    // N3 计数口径：正常收敛后不再有 nudge 被静默丢弃；退役旧连接产生可观测的 stale 信号
    const aCounters = a.sync.getDropCounters();
    expect(aCounters.nudgeDroppedStaleEntry).toBe(0);
    expect(aCounters.identityFailures).toBe(0);
    expect(aCounters.staleEntrySignals).toBeGreaterThanOrEqual(1);
  });

  it('对抗：第二次认证失败（异主证书）→ 旧连接继续正常服务；影子会话不覆盖', async () => {
    const c1 = await connectFirst('12D3KooWSimulatedFirstDialKey');
    const n1 = await b.store.createNode('fact', { text: 'baseline' });
    await waitUntil(async () => (await a.store.getNode(n1.id)) !== null);

    // 冒名者：deviceId 同名 'device-B'，但证书由另一个用户主密钥签发 → A 侧验签必败
    const rogueMaster = await generateMasterKeyPair();
    const rogueIdentity = await createTestIdentity('device-B');
    await issueCertificate(rogueMaster.privateKey, rogueIdentity);
    const rogueHandshake = new AuthenticationHandshake();
    rogueHandshake.setIdentity({
      deviceId: rogueIdentity.identity.deviceId,
      devicePublicKey: rogueIdentity.identity.devicePublicKey,
      devicePrivateKey: rogueIdentity.identity.devicePrivateKey,
      certificate: rogueIdentity.identity.certificate as DeviceCertificate,
    });
    rogueHandshake.setUserMasterPublicKey(await masterPublicKeyBytes(rogueMaster));
    await rogueHandshake.start();

    const rogue = linkedPair(a, b, rawPeerId('rogue-dial-key'));
    let aAuthFailed = false;
    a.node.getHandshake().on('auth-failed', () => {
      aAuthFailed = true;
    });
    await redialWithKey(a, b, rawPeerId('rogue-dial-key'), rogue.aEnd, rogue.bEnd, rogueHandshake);
    expect(aAuthFailed).toBe(true);
    expect(rogue.aEnd.state).toBe('closed');

    // 影子会话不覆盖：A 对真 B 的会话仍是 authenticated（I5/恢复逻辑）
    const sessionForB = a.node
      .getHandshake()
      .getSession({ id: b.node.peerId.id, multihash: new Uint8Array(), pubKey: new Uint8Array() });
    expect(sessionForB?.state).toBe('authenticated');

    // 旧连接继续正常服务（双向）
    const n2 = await b.store.createNode('fact', { text: 'after-rogue-from-B' });
    await waitUntil(async () => (await a.store.getNode(n2.id)) !== null);
    const n3 = await a.store.createNode('fact', { text: 'after-rogue-from-A' });
    await waitUntil(async () => (await b.store.getNode(n3.id)) !== null);

    // 旧连接的 manager 登记/活动键未被冒名连接篡改
    expect(privates(a.node).activePeerConnections.get(b.node.peerId.id)).toBe(c1.aEnd);
    expect(a.node.getConnectionManager().getConnections()).toHaveLength(1);
  });
});
