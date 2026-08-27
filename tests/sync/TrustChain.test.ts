// 信任链验签测试（Phase 5.1，收口 D9）
//
// 场景：A 签发事件 → A↔B 直连同步（快路径）→ B↔C 同步时 A 的事件被中继。
// C 只认得直连对端 B 的公钥，必须经事件的 authorCertificate 证书链
// （设备证书 → 用户主密钥）验证 A 的签名；伪造与错链一律拒绝。

import { describe, it, expect } from '@jest/globals';
import { GraphStore } from '../../src/core/GraphStore.js';
import { EventLog, type EventSigner, computeEventId } from '../../src/eventlog/EventLog.js';
import { MemoryStorage } from '../../src/storage/MemoryStorage.js';
import { SyncManager, type SyncPeer, type SyncResult } from '../../src/sync/syncmgr/SyncManager.js';
import { SecureChannelSyncTransport } from '../../src/sync/protocol.js';
import { SecureChannelImpl } from '../../src/p2p/secure/SecureChannelImpl.js';
import { InMemoryHub } from '../../src/p2p/transport/InMemoryTransport.js';
import type { Event } from '../../src/types/event.js';
import type { DeviceCertificate } from '../../src/p2p/handshake/AuthenticationHandshake.js';
import {
  createTestIdentity,
  generateMasterKeyPair,
  issueCertificate,
  masterPublicKeyBytes,
} from '../p2p/helpers.js';

interface TrustDevice {
  deviceId: string;
  storage: MemoryStorage;
  eventLog: EventLog;
  store: GraphStore;
  syncManager: SyncManager;
  publicKey: Uint8Array;
  privateKey: CryptoKey;
  certificate: DeviceCertificate;
}

/** 造一台带主密钥证书的设备；withMasterKey=false 时不配置信任链验签能力 */
async function createTrustDevice(
  deviceId: string,
  master: CryptoKeyPair,
  options: { withMasterKey?: boolean } = {},
): Promise<TrustDevice> {
  const testIdentity = await createTestIdentity(deviceId);
  const certificate = await issueCertificate(master.privateKey, testIdentity);
  const signer: EventSigner = {
    deviceId,
    privateKey: testIdentity.identity.devicePrivateKey,
    certificate,
  };
  const storage = new MemoryStorage();
  const eventLog = new EventLog(storage, deviceId, { signer });
  const store = new GraphStore({ storage, author: deviceId, eventLog });
  const syncManager = new SyncManager({
    eventLog,
    storage,
    deviceId,
    userMasterPublicKey:
      options.withMasterKey === false ? undefined : await masterPublicKeyBytes(master),
  });
  return {
    deviceId,
    storage,
    eventLog,
    store,
    syncManager,
    publicKey: testIdentity.identity.devicePublicKey,
    privateKey: testIdentity.identity.devicePrivateKey,
    certificate,
  };
}

function peerOf(device: TrustDevice): SyncPeer {
  return { deviceId: device.deviceId, publicKey: device.publicKey };
}

async function runSync(
  initiator: TrustDevice,
  responder: TrustDevice,
): Promise<[SyncResult, SyncResult]> {
  const hub = new InMemoryHub();
  const peerIdA = { multihash: initiator.publicKey, pubKey: initiator.publicKey, id: initiator.deviceId };
  const peerIdB = { multihash: responder.publicKey, pubKey: responder.publicKey, id: responder.deviceId };
  const [connA, connB] = hub.createLinkedPair(peerIdA, peerIdB);
  const channelA = new SecureChannelImpl(connA);
  const channelB = new SecureChannelImpl(connB);
  await Promise.all([channelA.start(), channelB.start()]);
  return Promise.all([
    initiator.syncManager.syncWithDevice(new SecureChannelSyncTransport(channelA), peerOf(responder)),
    responder.syncManager.acceptSync(new SecureChannelSyncTransport(channelB), peerOf(initiator)),
  ]);
}

describe('事件证书链字段', () => {
  it('携带证书的签名者产生的事件带 authorCertificate，且内容寻址 ID 语义不变', async () => {
    const master = await generateMasterKeyPair();
    const a = await createTrustDevice('device-A', master);

    await a.store.createNode('fact', { text: 'chain' });
    const events = await a.eventLog.listEvents();
    expect(events).toHaveLength(1);
    const event = events[0]!;

    // 证书链字段随事件携带
    expect(event.authorCertificate).toEqual(a.certificate);
    // ID 与签名仍只绑定固定字段集：剥掉 id/signature/证书后重算 ID 不变
    const { id: _id, signature: _sig, authorCertificate: _cert, ...unsigned } = event;
    expect(await computeEventId(unsigned)).toBe(event.id);
    // 用设备公钥验签通过（内部同样重算 ID）
    expect(await EventLog.verifyEvent(event, a.publicKey)).toBe(true);
  });

  it('未携带证书的签名者保持 Phase 3 事件形态', async () => {
    const keyPair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const storage = new MemoryStorage();
    const eventLog = new EventLog(storage, 'device-plain', {
      signer: { deviceId: 'device-plain', privateKey: keyPair.privateKey },
    });
    const store = new GraphStore({ storage, author: 'device-plain', eventLog });
    await store.createNode('fact', { text: 'plain' });
    const events = await eventLog.listEvents();
    expect(events[0]!.authorCertificate).toBeUndefined();
  });
});

describe('中继路径信任链验签', () => {
  it('三设备接力：C 经证书链验证 A 的事件并收敛', async () => {
    const master = await generateMasterKeyPair();
    const a = await createTrustDevice('device-A', master);
    const b = await createTrustDevice('device-B', master);
    const c = await createTrustDevice('device-C', master);

    const node = await a.store.createNode('fact', { text: 'relayed-fact' });
    await runSync(a, b); // A↔B 直连：快路径
    expect((await b.store.getNode(node.id))?.content).toEqual({ text: 'relayed-fact' });

    // B↔C：A 的事件经 B 中继到 C；C 用主公钥验证书链
    const [, resultC] = await runSync(b, c);
    expect(resultC.receivedEvents).toBe(1);
    expect((await c.store.getNode(node.id))?.content).toEqual({ text: 'relayed-fact' });

    // C 的日志中该事件仍由 A 签发
    const eventsAtC = await c.eventLog.listEvents();
    expect(eventsAtC.map((e) => e.author)).toEqual(['device-A']);
  });

  it('未配置主公钥时拒绝中继事件（诚实失败而非静默接受）', async () => {
    const master = await generateMasterKeyPair();
    const a = await createTrustDevice('device-A', master);
    const b = await createTrustDevice('device-B', master);
    const c = await createTrustDevice('device-C', master, { withMasterKey: false });

    await a.store.createNode('fact', { text: 'relayed-fact' });
    await runSync(a, b);

    // C 无信任链能力：A 的中继事件必须被拒（C 自身无任何事件入库）
    await expect(runSync(b, c)).rejects.toThrow('Event signature verification failed');
    expect((await c.eventLog.listEvents())).toHaveLength(0);
  });

  it('篡改内容的中继事件被拒绝（ID 与内容绑定）', async () => {
    const master = await generateMasterKeyPair();
    const a = await createTrustDevice('device-A', master);
    const b = await createTrustDevice('device-B', master);
    const c = await createTrustDevice('device-C', master);

    const node = await a.store.createNode('fact', { text: 'honest' });
    await runSync(a, b);

    // B 扮演恶意中继：篡改 A 的事件内容后放进自己的日志存储
    const honest = (await b.eventLog.listEvents())[0]!;
    const forged: Event = { ...honest, data: { ...honest.data, nodeType: 'fact', tampered: true } };
    await b.storage.putEvent(forged);

    await expect(runSync(b, c)).rejects.toThrow('Event signature verification failed');
    expect(await c.store.getNode(node.id)).toBeNull();
  });

  it('证书与 author 不匹配的中继事件被拒绝', async () => {
    const master = await generateMasterKeyPair();
    const a = await createTrustDevice('device-A', master);
    const b = await createTrustDevice('device-B', master);
    const c = await createTrustDevice('device-C', master);

    await a.store.createNode('fact', { text: 'honest' });
    await runSync(a, b);

    // B 把 A 的事件换上 B 自己的证书（deviceId 与 author 不符）
    const honest = (await b.eventLog.listEvents())[0]!;
    const mismatched: Event = { ...honest, authorCertificate: b.certificate };
    await b.storage.putEvent(mismatched);

    await expect(runSync(b, c)).rejects.toThrow('Event signature verification failed');
  });

  it('异主密钥签发的证书被拒绝', async () => {
    const master = await generateMasterKeyPair();
    const evilMaster = await generateMasterKeyPair();
    const a = await createTrustDevice('device-A', master);
    const b = await createTrustDevice('device-B', master);
    const c = await createTrustDevice('device-C', master);

    await a.store.createNode('fact', { text: 'honest' });
    await runSync(a, b);

    // 攻击者用另一把主密钥给 A 的 deviceId 签证书，替换后中继
    const evilIdentity = await createTestIdentity('device-A');
    const evilCert = await issueCertificate(evilMaster.privateKey, evilIdentity);
    const honest = (await b.eventLog.listEvents())[0]!;
    const forged: Event = { ...honest, authorCertificate: evilCert };
    await b.storage.putEvent(forged);

    await expect(runSync(b, c)).rejects.toThrow('Event signature verification failed');
  });
});
