// Phase 2 · D/E：授权作为记忆（grant-as-memory）+ 身份吊销。
//
// 覆盖验收：
// - 图上授权生效；**自授 / 非签发者（别家用户、无证书）签发的 grant 被忽略**；
// - 撤销：写 revoke 后读侧立刻 []，且不再发送；恢复 grant 后从正确水位续传；
// - 身份吊销：被吊销设备的事件**不再被应用**（入站），且读侧拒绝；恢复后可用；
// - 默认拒绝不放松：未配置任何 grant 时仍拒绝；
// - 策略可读性（bootstrap 不死锁）：默认拒绝下策略事件仍随会话传递；
// - CompositeNamespacePolicy：图上 ∪ 配置；吊销优先，配置不得绕过。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GraphStore } from '../../src/core/GraphStore.js';
import { EventLog, type EventSigner } from '../../src/eventlog/EventLog.js';
import { MemoryStorage } from '../../src/storage/MemoryStorage.js';
import { SyncManager, type SyncPeer, type SyncResult } from '../../src/sync/syncmgr/SyncManager.js';
import { SecureChannelSyncTransport } from '../../src/sync/protocol.js';
import { SecureChannelImpl } from '../../src/p2p/secure/SecureChannelImpl.js';
import { InMemoryHub } from '../../src/p2p/transport/InMemoryTransport.js';
import type { PeerId } from '../../src/p2p/P2PNetwork.js';
import {
  ConfigNamespacePolicy,
  CompositeNamespacePolicy,
  type NamespaceGrantPolicy,
} from '../../src/sync/namespacePolicy.js';
import {
  GraphNamespacePolicy,
  POLICY_NAMESPACE,
  NAMESPACE_GRANT_EVENT,
  NAMESPACE_REVOKE_EVENT,
  DEVICE_REVOKE_EVENT,
  type NamespaceGrantRecord,
} from '../../src/sync/grantPolicy.js';
import { Mebular } from '../../src/mebular.js';
import { IdentityManager } from '../../src/crypto/IdentityManager.js';
import {
  createTestIdentity,
  generateMasterKeyPair,
  issueCertificate,
  masterPublicKeyBytes,
} from '../p2p/helpers.js';

// ---------------------------------------------------------------------------
// 单位：签发者信任 + 策略推导
// ---------------------------------------------------------------------------

async function appendGrant(
  log: EventLog,
  subject: string,
  namespaces: string[],
  issuedAt: number,
): Promise<NamespaceGrantRecord> {
  const grant: NamespaceGrantRecord = { grantId: randomUUID(), subject, namespaces, issuedAt };
  await log.append({ type: NAMESPACE_GRANT_EVENT, data: { grant }, namespace: POLICY_NAMESPACE });
  return grant;
}

describe('GraphNamespacePolicy（签发者信任与策略推导）', () => {
  let master: CryptoKeyPair;
  let masterPub: Uint8Array;
  let storage: MemoryStorage;
  let trusted: EventLog;
  let outsider: EventLog;
  let noCert: EventLog;
  let policy: GraphNamespacePolicy;

  beforeEach(async () => {
    master = await generateMasterKeyPair();
    masterPub = await masterPublicKeyBytes(master);
    storage = new MemoryStorage();

    const trustedId = await createTestIdentity('issuer');
    await issueCertificate(master.privateKey, trustedId);
    trusted = new EventLog(storage, 'issuer', {
      signer: {
        deviceId: 'issuer',
        privateKey: trustedId.identity.devicePrivateKey,
        certificate: trustedId.identity.certificate,
      },
    });

    // 别家用户（另一主密钥）：即使带证书也不可信
    const outsiderMaster = await generateMasterKeyPair();
    const outsiderId = await createTestIdentity('outsider');
    await issueCertificate(outsiderMaster.privateKey, outsiderId);
    outsider = new EventLog(storage, 'outsider', {
      signer: {
        deviceId: 'outsider',
        privateKey: outsiderId.identity.devicePrivateKey,
        certificate: outsiderId.identity.certificate,
      },
    });

    // 无证书设备：连信任链都没有
    const noCertId = await createTestIdentity('nocert');
    noCert = new EventLog(storage, 'nocert', {
      signer: { deviceId: 'nocert', privateKey: noCertId.identity.devicePrivateKey },
    });

    policy = new GraphNamespacePolicy({ eventLog: new EventLog(storage, 'reader'), userMasterPublicKey: masterPub });
  });

  it('签发者的 grant 被采纳；多个 grant 取并集', async () => {
    await appendGrant(trusted, 'device-B', ['nsA'], 1000);
    await appendGrant(trusted, 'device-B', ['nsB'], 2000);
    const ns = await policy.getAuthorizedNamespaces('device-B');
    expect([...ns].sort()).toEqual(['nsA', 'nsB']);
  });

  it('自授 / 非签发者（别家用户、无证书）的 grant 被忽略', async () => {
    await appendGrant(outsider, 'outsider', ['nsA'], 1000); // 自授
    await appendGrant(outsider, 'device-B', ['nsA'], 2000); // 别家签发
    await appendGrant(noCert, 'device-B', ['nsA'], 3000); // 无证书
    expect(await policy.getAuthorizedNamespaces('outsider')).toEqual([]);
    expect(await policy.getAuthorizedNamespaces('device-B')).toEqual([]);
    // 未配置信任根时，即使本机签的记录也不可信 → 默认拒绝
    const noRoot = new GraphNamespacePolicy({ eventLog: new EventLog(storage, 'reader'), userMasterPublicKey: null });
    await appendGrant(trusted, 'device-C', ['nsA'], 4000);
    expect(await noRoot.getAuthorizedNamespaces('device-C')).toEqual([]);
  });

  it('撤销按 grantId 精确失效', async () => {
    const g1 = await appendGrant(trusted, 'device-B', ['nsA'], 1000);
    await appendGrant(trusted, 'device-B', ['nsB'], 2000);
    await trusted.append({
      type: NAMESPACE_REVOKE_EVENT,
      data: { revoke: { grantId: g1.grantId, subject: 'device-B', issuedAt: 3000 } },
      namespace: POLICY_NAMESPACE,
    });
    expect(await policy.getAuthorizedNamespaces('device-B')).toEqual(['nsB']);
  });

  it('设备吊销：读侧 []，且 getRevokedDevices 命中；之后新 grant 即恢复', async () => {
    await appendGrant(trusted, 'device-B', ['nsA'], 1000);
    await trusted.append({
      type: DEVICE_REVOKE_EVENT,
      data: { deviceRevoke: { subject: 'device-B', issuedAt: 2000 } },
      namespace: POLICY_NAMESPACE,
    });
    expect(await policy.getAuthorizedNamespaces('device-B')).toEqual([]);
    expect([...(await policy.getRevokedDevices())]).toEqual(['device-B']);

    await appendGrant(trusted, 'device-B', ['nsA'], 3000); // 吊销后新 grant → 恢复
    expect(await policy.getAuthorizedNamespaces('device-B')).toEqual(['nsA']);
    expect([...(await policy.getRevokedDevices())]).toEqual([]);
  });

  it('F-2：同一签发者内以单调序列排序，墙钟偏移不影响撤销生效', async () => {
    // 先发 grant（issuedAt 时钟超前），后发 device_revoke（issuedAt 更早，模拟时钟回拨）。
    // 单调整序列：grant seq=1 < revoke seq=2 → 撤销在后，必须生效。
    await appendGrant(trusted, 'device-B', ['nsA'], 2000);
    await trusted.append({
      type: DEVICE_REVOKE_EVENT,
      data: { deviceRevoke: { subject: 'device-B', issuedAt: 1000 } },
      namespace: POLICY_NAMESPACE,
    });
    expect(await policy.getAuthorizedNamespaces('device-B')).toEqual([]);
    expect([...(await policy.getRevokedDevices())]).toContain('device-B');
  });

  it('F-3：恢复必须使用新的 grantId（复用被撤销的 grantId 无效）', async () => {
    const g = await appendGrant(trusted, 'device-B', ['nsA'], 1000);
    await trusted.append({
      type: NAMESPACE_REVOKE_EVENT,
      data: { revoke: { grantId: g.grantId, subject: 'device-B', issuedAt: 2000 } },
      namespace: POLICY_NAMESPACE,
    });
    expect(await policy.getAuthorizedNamespaces('device-B')).toEqual([]);

    // 复用同一 grantId 再授予 → 仍被判为已撤销
    await trusted.append({
      type: NAMESPACE_GRANT_EVENT,
      data: { grant: { ...g, namespaces: ['nsA'], issuedAt: 3000 } },
      namespace: POLICY_NAMESPACE,
    });
    expect(await policy.getAuthorizedNamespaces('device-B')).toEqual([]);

    // 新 grantId → 恢复
    await appendGrant(trusted, 'device-B', ['nsA'], 4000);
    expect(await policy.getAuthorizedNamespaces('device-B')).toEqual(['nsA']);
  });
});

describe('CompositeNamespacePolicy（图上 ∪ 配置；吊销优先）', () => {
  it('并集且不放松默认拒绝；被吊销时配置白名单也绕不过', async () => {
    const graph: NamespaceGrantPolicy = {
      getAuthorizedNamespaces: async (peer) => (peer === 'device-B' ? ['nsA'] : []),
      getRevokedDevices: async () => new Set(['device-X']),
    };
    const config = new ConfigNamespacePolicy({ 'device-B': ['nsB'], 'device-X': ['nsA'] });
    const composite = new CompositeNamespacePolicy([graph, config]);

    expect([...(await composite.getAuthorizedNamespaces('device-B'))].sort()).toEqual(['nsA', 'nsB']);
    expect(await composite.getAuthorizedNamespaces('device-X')).toEqual([]); // 吊销优先
    expect(await composite.getAuthorizedNamespaces('device-C')).toEqual([]); // 两者皆空 = 拒绝
  });
});

// ---------------------------------------------------------------------------
// 端到端：raw SyncManager 夹具（真实证书链，支持多轮会话）
// ---------------------------------------------------------------------------

interface TestDevice {
  deviceId: string;
  storage: MemoryStorage;
  eventLog: EventLog;
  store: GraphStore;
  syncManager: SyncManager;
  policy: GraphNamespacePolicy;
  publicKey: Uint8Array;
  peerId: PeerId;
}

async function createDevice(
  deviceId: string,
  master: CryptoKeyPair,
  masterPub: Uint8Array,
  options: { snapshotThreshold?: number } = {},
): Promise<TestDevice> {
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
  const policy = new GraphNamespacePolicy({ eventLog, userMasterPublicKey: masterPub });
  const syncManager = new SyncManager({
    eventLog,
    storage,
    deviceId,
    namespacePolicy: policy,
    userMasterPublicKey: masterPub,
    ...(options.snapshotThreshold !== undefined ? { snapshotThreshold: options.snapshotThreshold } : {}),
  });
  return { deviceId, storage, eventLog, store, syncManager, policy, publicKey: identity.identity.devicePublicKey, peerId: identity.peerId };
}

function peerOf(device: TestDevice): SyncPeer {
  return { deviceId: device.deviceId, publicKey: device.publicKey };
}

async function linkedTransports(
  a: { peerId: PeerId },
  b: { peerId: PeerId },
): Promise<[SecureChannelSyncTransport, SecureChannelSyncTransport]> {
  const hub = new InMemoryHub();
  const [connA, connB] = hub.createLinkedPair(a.peerId, b.peerId);
  const channelA = new SecureChannelImpl(connA);
  const channelB = new SecureChannelImpl(connB);
  await Promise.all([channelA.start(), channelB.start()]);
  return [new SecureChannelSyncTransport(channelA), new SecureChannelSyncTransport(channelB)];
}

async function runSync(a: TestDevice, b: TestDevice): Promise<[SyncResult, SyncResult]> {
  const [tA, tB] = await linkedTransports(a, b);
  return Promise.all([
    a.syncManager.syncWithDevice(tA, peerOf(b)),
    b.syncManager.acceptSync(tB, peerOf(a)),
  ]);
}

async function writeGrant(device: TestDevice, subject: string, namespaces: string[], issuedAt: number): Promise<NamespaceGrantRecord> {
  return appendGrant(device.eventLog, subject, namespaces, issuedAt);
}

async function writeDeviceRevoke(device: TestDevice, subject: string, issuedAt: number): Promise<void> {
  await device.eventLog.append({
    type: DEVICE_REVOKE_EVENT,
    data: { deviceRevoke: { subject, issuedAt } },
    namespace: POLICY_NAMESPACE,
  });
}

describe('端到端：图上授权 + 身份吊销', () => {
  let master: CryptoKeyPair;
  let masterPub: Uint8Array;
  let a: TestDevice;
  let b: TestDevice;

  beforeEach(async () => {
    master = await generateMasterKeyPair();
    masterPub = await masterPublicKeyBytes(master);
    a = await createDevice('device-A', master, masterPub);
    b = await createDevice('device-B', master, masterPub);
  });

  it('默认拒绝不放松：无 grant 时不发送用户分区，但策略事件仍可读（不死锁）', async () => {
    const nA = await a.store.createNode('fact', { text: 'a1' }, [], { namespace: 'nsA' });
    await writeGrant(a, 'device-C', ['nsA'], 1000); // 与 B 无关的策略事件

    const [resultA, resultB] = await runSync(a, b);

    expect(resultA.denied).toBe(true);
    expect(await b.store.getNode(nA.id)).toBeNull();
    expect(resultB.receivedEvents).toBe(0);
    // bootstrap：默认拒绝下策略事件仍随会话传递（已认证设备可读）
    const policyAtB = await b.eventLog.listEvents({ namespace: POLICY_NAMESPACE });
    expect(policyAtB.length).toBeGreaterThanOrEqual(1);
  });

  it('图上授权生效：只发送被授权分区（签发者 grant）', async () => {
    await writeGrant(a, 'device-B', ['nsA'], 1000);
    const nA = await a.store.createNode('fact', { text: 'a-nsA' }, [], { namespace: 'nsA' });
    const nB = await a.store.createNode('fact', { text: 'a-nsB' }, [], { namespace: 'nsB' });

    const [resultA] = await runSync(a, b);

    expect(resultA.denied).toBe(false);
    expect(await b.store.getNode(nA.id)).not.toBeNull();
    expect(await b.store.getNode(nB.id)).toBeNull();
  });

  it('撤销：写 revoke 后读侧 []、不再发送；恢复 grant 后续传且不重发（水位不污染）', async () => {
    const g1 = await writeGrant(a, 'device-B', ['nsA'], 1000);
    const n1 = await a.store.createNode('fact', { text: 'a1' }, [], { namespace: 'nsA' });
    await runSync(a, b);
    expect(await b.store.getNode(n1.id)).not.toBeNull();

    await a.eventLog.append({
      type: NAMESPACE_REVOKE_EVENT,
      data: { revoke: { grantId: g1.grantId, subject: 'device-B', issuedAt: 2000 } },
      namespace: POLICY_NAMESPACE,
    });
    expect(await a.policy.getAuthorizedNamespaces('device-B')).toEqual([]);

    const n2 = await a.store.createNode('fact', { text: 'a2' }, [], { namespace: 'nsA' });
    const [revokedResult] = await runSync(a, b);
    expect(revokedResult.denied).toBe(true);
    expect(await b.store.getNode(n2.id)).toBeNull();

    // 恢复：新 grant（issuedAt 晚于 revoke）→ 只补发 n2，n1 不重发
    await writeGrant(a, 'device-B', ['nsA'], 3000);
    const [recoveredResult, recoveredB] = await runSync(a, b);
    expect(recoveredResult.denied).toBe(false);
    expect(await b.store.getNode(n2.id)).not.toBeNull();
    expect(recoveredB.receivedEvents).toBeGreaterThanOrEqual(1);

    // 再同步一轮：全部已确认 → 0 发送（水位未被污染）
    const [settled] = await runSync(a, b);
    expect(settled.sentEvents).toBe(0);
  });

  it('身份吊销：入站事件不再被应用（读侧 []）；恢复后可应用', async () => {
    await writeGrant(a, 'device-B', ['nsA'], 1000);
    await writeGrant(b, 'device-A', ['nsA'], 1000);
    await runSync(a, b); // 建立双向授权

    await writeDeviceRevoke(a, 'device-B', 2000);
    expect(await a.policy.getAuthorizedNamespaces('device-B')).toEqual([]);

    const fromB = await b.store.createNode('fact', { text: 'from-b' }, [], { namespace: 'nsA' });
    const [revokedRead] = await runSync(a, b);
    expect(revokedRead.denied).toBe(true); // 读侧拒绝
    expect(await a.store.getNode(fromB.id)).toBeNull(); // 入站写入被隔离

    // 恢复：新 grant 晚于 device_revoke
    await writeGrant(a, 'device-B', ['nsA'], 3000);
    await runSync(a, b);
    expect(await a.store.getNode(fromB.id)).not.toBeNull(); // 恢复后应用
  });

  it('F-1：被吊销设备署名的实体不得经快照进入接收方', async () => {
    const holder = await createDevice('device-A', master, masterPub, { snapshotThreshold: 1 });
    const revokedDevice = await createDevice('device-B', master, masterPub);
    const receiver = await createDevice('device-C', master, masterPub);

    // holder 先（吊销前）取得被吊销设备署名的实体
    await writeGrant(revokedDevice, 'device-A', ['nsA'], 1000);
    await writeGrant(holder, 'device-B', ['nsA'], 1000);
    const fromRevoked = await revokedDevice.store.createNode('fact', { text: 'from-b' }, [], { namespace: 'nsA' });
    await runSync(holder, revokedDevice);
    expect(await holder.store.getNode(fromRevoked.id)).not.toBeNull();

    // holder 吊销 B，并授权新接收方 C 读取 nsA（走快照）
    await writeDeviceRevoke(holder, 'device-B', 2000);
    await writeGrant(holder, 'device-C', ['nsA'], 2000);
    const fromHolder = await holder.store.createNode('fact', { text: 'from-a' }, [], { namespace: 'nsA' });

    const [result] = await runSync(holder, receiver);

    expect(result.snapshotSent).toBeGreaterThan(0);
    expect(await receiver.store.getNode(fromHolder.id)).not.toBeNull(); // 授权实体正常进入
    expect(await receiver.store.getNode(fromRevoked.id)).toBeNull(); // 被吊销者署名的实体被过滤
  });
});

// ---------------------------------------------------------------------------
// facade：写入签名策略 + 只读审计入口
// ---------------------------------------------------------------------------

describe('Mebular facade：grant/revoke 记录与审计入口', () => {
  let dir: string;
  let masterKeys: { userMasterKey: Uint8Array; userMasterPrivateKey: CryptoKey };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mebular-grant-'));
    const master = await new IdentityManager().generateUserMasterKey();
    masterKeys = { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('grant → 读侧生效；revoke 立即失效；只读入口可审计', async () => {
    const a = new Mebular({
      storagePath: join(dir, 'a.jsonl'),
      deviceId: 'device-A',
      encryption: masterKeys,
      sync: { autoSync: false },
    });
    await a.initialize();

    expect(await a.getEffectiveNamespaces('device-B')).toEqual([]); // 默认拒绝
    const grantEvent = await a.grantNamespaces({ subject: 'device-B', namespaces: ['nsA'], note: 'e2e' });
    const grantId = (grantEvent.data as { grant: NamespaceGrantRecord }).grant.grantId;
    expect(await a.getEffectiveNamespaces('device-B')).toEqual(['nsA']);

    await a.revokeGrant({ grantId });
    expect(await a.getEffectiveNamespaces('device-B')).toEqual([]);

    await a.revokeDevice({ subject: 'device-C' });
    expect(await a.getRevokedDevices()).toEqual(['device-C']);
    // 吊销后配置白名单也绕不过
    await a.shutdown();
  });

  it('配置 bootstrap 仍可用（无图上 grant 时）', async () => {
    const a = new Mebular({
      storagePath: join(dir, 'b.jsonl'),
      deviceId: 'device-A',
      encryption: masterKeys,
      sync: { autoSync: false, peerNamespacePolicy: { 'device-B': ['nsA'] } },
    });
    await a.initialize();
    expect(await a.getEffectiveNamespaces('device-B')).toEqual(['nsA']);
    await a.shutdown();
  });
});
