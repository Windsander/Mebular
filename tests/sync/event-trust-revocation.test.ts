// 吊销作用域锚点（作者级，T2 信任模型 v2）。
//
// 语义：`device_revoke` **只作用于被吊销设备本人**——
//   - 读侧：`getSubscriptions(target)` 不含该域（策略层，grant-policy 覆盖）；
//   - 入站：`event.author === target` 的事件不应用/不入库/不 ack（本文件覆盖）；
//   - **不连坐**：证书链中含被吊销设备（根机/中间设备）时，其下级与新成员的事件
//     仍按自身证书链验签、按自身作者状态隔离（本文件覆盖）。
//
// 与 cert-chain.test.ts 的区别：那里是纯密码学的链验签；这里走真实同步会话
// （A→B 直连 + B→C 中继），并断言「踢根机/中间设备」后的实际传播行为。

import { describe, it, expect } from '@jest/globals';
import { IdentityManager } from '../../src/crypto/IdentityManager.js';
import { EventLog } from '../../src/eventlog/EventLog.js';
import { GraphStore } from '../../src/core/GraphStore.js';
import { MemoryStorage } from '../../src/storage/MemoryStorage.js';
import { SyncManager, type SyncPeer, type SyncResult } from '../../src/sync/syncmgr/SyncManager.js';
import { SecureChannelSyncTransport } from '../../src/sync/protocol.js';
import { SecureChannelImpl } from '../../src/p2p/secure/SecureChannelImpl.js';
import { InMemoryHub } from '../../src/p2p/transport/InMemoryTransport.js';
import {
  DEVICE_REVOKE_EVENT,
  GraphNamespacePolicy,
  POLICY_NAMESPACE,
} from '../../src/sync/grantPolicy.js';
import type { NamespaceSubscriptionPolicy } from '../../src/sync/namespacePolicy.js';
import { DEFAULT_NAMESPACE } from '../../src/core/namespace.js';

interface Dev {
  deviceId: string;
  publicKey: Uint8Array;
  privateKey: CryptoKey;
  storage: MemoryStorage;
  eventLog: EventLog;
  store: GraphStore;
  syncManager: SyncManager;
  policy: NamespaceSubscriptionPolicy;
}

function policy(_granted: string[], revoked: string[]): NamespaceSubscriptionPolicy {
  return {
    // 没有订阅记录：对端订阅回退 hello（本文件只验证作者级入站隔离）。
    getNamespaceSubscriptions: async () => ({ active: false, subscribers: [] }),
    getBlockedDevices: async () => new Set(revoked),
  };
}

async function makeDeviceWithPolicy(
  im: IdentityManager,
  deviceId: string,
  masterPub: Uint8Array,
  makePolicy: (eventLog: EventLog) => NamespaceSubscriptionPolicy,
): Promise<Dev> {
  const key = im.getDeviceKey(deviceId)!;
  const storage = new MemoryStorage();
  const eventLog = new EventLog(storage, deviceId, {
    signer: {
      deviceId,
      privateKey: key.privateKey,
      certificate: key.certificate!,
      ...(key.certificateChain !== undefined ? { certificateChain: key.certificateChain } : {}),
    },
  });
  const store = new GraphStore({ storage, author: deviceId, eventLog });
  const subscriptionPolicy = makePolicy(eventLog);
  const syncManager = new SyncManager({
    eventLog,
    storage,
    deviceId,
    userMasterPublicKey: masterPub,
    subscriptionPolicy,
  });
  return {
    deviceId,
    publicKey: key.publicKey,
    privateKey: key.privateKey,
    storage,
    eventLog,
    store,
    syncManager,
    policy: subscriptionPolicy,
  };
}

async function makeDevice(
  im: IdentityManager,
  deviceId: string,
  masterPub: Uint8Array,
  revoked: string[],
): Promise<Dev> {
  return makeDeviceWithPolicy(im, deviceId, masterPub, () => policy([DEFAULT_NAMESPACE], revoked));
}

/** 在目标设备的本地事件图里写入一条真实的 `device_revoke`（由 author 签发）。 */
async function seedDeviceRevoke(
  im: IdentityManager,
  target: Dev,
  authorDeviceId: string,
  subject: string,
): Promise<void> {
  const key = im.getDeviceKey(authorDeviceId)!;
  const authorLog = await EventLog.restore(target.storage, authorDeviceId, {
    signer: {
      deviceId: authorDeviceId,
      privateKey: key.privateKey,
      certificate: key.certificate!,
      ...(key.certificateChain !== undefined ? { certificateChain: key.certificateChain } : {}),
    },
  });
  await authorLog.append({
    type: DEVICE_REVOKE_EVENT,
    data: { deviceRevoke: { subject, issuedAt: 1 } },
    namespace: POLICY_NAMESPACE,
  });
}

function peerOf(d: Dev): SyncPeer {
  return { deviceId: d.deviceId, publicKey: d.publicKey };
}

async function runSync(initiator: Dev, responder: Dev): Promise<[SyncResult, SyncResult]> {
  const hub = new InMemoryHub();
  const [connA, connB] = hub.createLinkedPair(
    { multihash: initiator.publicKey, pubKey: initiator.publicKey, id: initiator.deviceId },
    { multihash: responder.publicKey, pubKey: responder.publicKey, id: responder.deviceId },
  );
  const chA = new SecureChannelImpl(connA);
  const chB = new SecureChannelImpl(connB);
  await Promise.all([chA.start(), chB.start()]);
  return Promise.all([
    initiator.syncManager.syncWithDevice(new SecureChannelSyncTransport(chA), peerOf(responder)),
    responder.syncManager.acceptSync(new SecureChannelSyncTransport(chB), peerOf(initiator)),
  ]);
}

/** master → X（一级，主密钥直签）→ A（二级，X 委派）；B/C 主密钥直签。 */
async function setup(): Promise<{ im: IdentityManager; masterPub: Uint8Array }> {
  const im = new IdentityManager();
  await im.generateUserMasterKey();
  const masterPub = im.getUserMasterPublicKey()!;
  await im.generateDeviceKey('device-X', 'X');
  await im.issueDeviceCertificate('device-X');
  await im.generateDeviceKey('device-A', 'A');
  await im.issueDelegatedDeviceCertificate('device-A', 'device-X');
  await im.generateDeviceKey('device-B', 'B');
  await im.issueDeviceCertificate('device-B');
  await im.generateDeviceKey('device-C', 'C');
  await im.issueDeviceCertificate('device-C');
  return { im, masterPub };
}

describe('F-1 事件信任路径的吊销作用域（作者级）', () => {
  it('对照：X 未被吊销时，C 经中继接受 A 的委派链事件', async () => {
    const { im, masterPub } = await setup();
    const a = await makeDevice(im, 'device-A', masterPub, []);
    const b = await makeDevice(im, 'device-B', masterPub, []);
    const c = await makeDevice(im, 'device-C', masterPub, []);
    expect(im.getDeviceKey('device-A')!.certificateChain?.length).toBe(2); // [A, X]

    const node = await a.store.createNode('fact', { text: 'relayed-control' });
    await runSync(a, b); // A→B 直连（快路径）
    const [, resC] = await runSync(b, c); // B→C 中继（授权链路径）
    expect(resC.receivedEvents).toBe(1);
    expect((await c.store.getNode(node.id))?.content).toEqual({ text: 'relayed-control' });
  });

  it('踢根机/中间设备 X：其余设备同步与 X 的下级/新成员加入均不受影响', async () => {
    const { im, masterPub } = await setup();
    // 新成员 D：由 A 委派签发，链 [D, A, X]（X 是中间设备）
    await im.generateDeviceKey('device-D', 'D');
    await im.issueDelegatedDeviceCertificate('device-D', 'device-A');

    const a = await makeDevice(im, 'device-A', masterPub, []);
    const b = await makeDevice(im, 'device-B', masterPub, []);
    // C 用真实策略推导：B（可信签发者）签发 device_revoke(X) → revoked = {X}
    const c = await makeDeviceWithPolicy(
      im,
      'device-C',
      masterPub,
      (eventLog) => new GraphNamespacePolicy({
        eventLog,
        userMasterPublicKey: masterPub,
      }),
    );
    const d = await makeDevice(im, 'device-D', masterPub, []);
    await seedDeviceRevoke(im, c, 'device-B', 'device-X');
    expect([...(await c.policy.getBlockedDevices!())]).toEqual(['device-X']);

    const nodeA = await a.store.createNode('fact', { text: 'x-child' });
    const nodeB = await b.store.createNode('fact', { text: 'sibling' });
    const nodeD = await d.store.createNode('fact', { text: 'new-member' });

    await runSync(a, b); // A→B 直连
    await runSync(d, b); // D→B 直连（链 [D,A,X]）
    const [, resC] = await runSync(b, c); // B→C 中继：A/B/D 三条事件

    expect(resC.receivedEvents).toBe(3);
    expect((await c.store.getNode(nodeA.id))?.content).toEqual({ text: 'x-child' });
    expect((await c.store.getNode(nodeB.id))?.content).toEqual({ text: 'sibling' });
    expect((await c.store.getNode(nodeD.id))?.content).toEqual({ text: 'new-member' });
  });

  it('作者级隔离：被吊销作者 A 的中继事件不应用/不入库/不 ack，且不中止会话', async () => {
    const { im, masterPub } = await setup();
    const a = await makeDevice(im, 'device-A', masterPub, []);
    const b = await makeDevice(im, 'device-B', masterPub, []);
    const c = await makeDevice(im, 'device-C', masterPub, ['device-A']);

    const node = await a.store.createNode('fact', { text: 'revoked-author-relayed' });
    await runSync(a, b);
    const [, resC] = await runSync(b, c);

    expect(resC.receivedEvents).toBe(0);
    expect(resC.appliedEventIds).toEqual([]);
    expect(await c.store.getNode(node.id)).toBeNull();
    expect(await c.eventLog.listEvents()).toHaveLength(0);
  });

  it('作者级隔离：直连快路径同样按作者隔离（不应用/不入库/不 ack）', async () => {
    const { im, masterPub } = await setup();
    const a = await makeDevice(im, 'device-A', masterPub, []);
    const c = await makeDevice(im, 'device-C', masterPub, ['device-A']);

    const node = await a.store.createNode('fact', { text: 'revoked-author-direct' });
    const [, resC] = await runSync(a, c);

    expect(resC.receivedEvents).toBe(0);
    expect(resC.appliedEventIds).toEqual([]);
    expect(await c.store.getNode(node.id)).toBeNull();
    expect(await c.eventLog.listEvents()).toHaveLength(0);
  });
});
