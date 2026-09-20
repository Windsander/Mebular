// F-1 判别性锚点：**事件信任路径**（SyncManager 中继/多跳）的吊销级联。
//
// 与 cert-chain.test.ts 的区别：那里直接调 `verifyCertificateChain`/`verifyIssuedByUser`；
// 这里走真实同步会话（A→B 直连 + B→C 中继），断言 C 的 SyncManager 拒绝「链中含被吊销节点」的事件。
// 若把 SyncManager.verifyEventTrust 的 `isRevoked` 接线关掉，本文件的锚点必须变红。

import { describe, it, expect } from '@jest/globals';
import { IdentityManager } from '../../src/crypto/IdentityManager.js';
import { EventLog } from '../../src/eventlog/EventLog.js';
import { GraphStore } from '../../src/core/GraphStore.js';
import { MemoryStorage } from '../../src/storage/MemoryStorage.js';
import { SyncManager, type SyncPeer, type SyncResult } from '../../src/sync/syncmgr/SyncManager.js';
import { SecureChannelSyncTransport } from '../../src/sync/protocol.js';
import { SecureChannelImpl } from '../../src/p2p/secure/SecureChannelImpl.js';
import { InMemoryHub } from '../../src/p2p/transport/InMemoryTransport.js';
import type { NamespaceGrantPolicy } from '../../src/sync/namespacePolicy.js';
import { DEFAULT_NAMESPACE } from '../../src/core/namespace.js';

interface Dev {
  deviceId: string;
  publicKey: Uint8Array;
  privateKey: CryptoKey;
  storage: MemoryStorage;
  eventLog: EventLog;
  store: GraphStore;
  syncManager: SyncManager;
}

function policy(granted: string[], revoked: string[]): NamespaceGrantPolicy {
  return {
    getAuthorizedNamespaces: async () => [...granted],
    getRevokedDevices: async () => new Set(revoked),
  };
}

async function makeDevice(im: IdentityManager, deviceId: string, masterPub: Uint8Array, revoked: string[]): Promise<Dev> {
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
  const syncManager = new SyncManager({
    eventLog,
    storage,
    deviceId,
    userMasterPublicKey: masterPub,
    namespacePolicy: policy([DEFAULT_NAMESPACE], revoked),
  });
  return { deviceId, publicKey: key.publicKey, privateKey: key.privateKey, storage, eventLog, store, syncManager };
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

/** master → X（一级，主密钥直签）→ A（二级，X 委派）。 */
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

describe('F-1 事件信任路径的吊销级联（SyncManager 中继）', () => {
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

  it('锚点：X 被 device_revoke（吊销集合含 X）→ C 拒绝链中含 X 的中继事件', async () => {
    const { im, masterPub } = await setup();
    const a = await makeDevice(im, 'device-A', masterPub, []);
    const b = await makeDevice(im, 'device-B', masterPub, []);
    const c = await makeDevice(im, 'device-C', masterPub, ['device-X']); // ← 事件信任层的吊销谓词

    const node = await a.store.createNode('fact', { text: 'relayed-revoked' });
    await runSync(a, b);
    // C 的 SyncManager 必须在事件信任路径拒绝（而非仅证书链单测）
    await expect(runSync(b, c)).rejects.toThrow('Event signature verification failed');
    expect(await c.store.getNode(node.id)).toBeNull();
    expect(await c.eventLog.listEvents()).toHaveLength(0);
  });

  it('锚点判别性：吊销的是链中**签发者** X（A 自身未被吊销）', async () => {
    const { im, masterPub } = await setup();
    const a = await makeDevice(im, 'device-A', masterPub, []);
    const b = await makeDevice(im, 'device-B', masterPub, []);
    // 只吊销 A（叶）应拒；只吊销 X（中间签发者）也应拒 —— 后者是级联的关键判别
    const cLeafRevoked = await makeDevice(im, 'device-C', masterPub, ['device-A']);
    const cIssuerRevoked = await makeDevice(im, 'device-C', masterPub, ['device-X']);
    await a.store.createNode('fact', { text: 'relayed-discriminate' });
    await runSync(a, b);
    await expect(runSync(b, cLeafRevoked)).rejects.toThrow('Event signature verification failed');
    await expect(runSync(b, cIssuerRevoked)).rejects.toThrow('Event signature verification failed');
  });
});
