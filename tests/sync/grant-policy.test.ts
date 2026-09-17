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

/** 造一个链到给定主密钥的可信签发设备（同一用户的多台设备） */
async function makeTrustedLog(
  storage: MemoryStorage,
  master: CryptoKeyPair,
  deviceId: string,
  options: { restore?: boolean } = {},
): Promise<EventLog> {
  const identity = await createTestIdentity(deviceId);
  await issueCertificate(master.privateKey, identity);
  const signer = {
    deviceId,
    privateKey: identity.identity.devicePrivateKey,
    certificate: identity.identity.certificate,
  };
  // restore：合并存储中已有事件的时钟 → 之后 append 的事件在逻辑序上因果在后
  return options.restore
    ? EventLog.restore(storage, deviceId, { signer })
    : new EventLog(storage, deviceId, { signer });
}

async function appendDeviceRevoke(
  log: EventLog,
  subject: string,
  issuedAt: number,
): Promise<void> {
  await log.append({
    type: DEVICE_REVOKE_EVENT,
    data: { deviceRevoke: { subject, issuedAt } },
    namespace: POLICY_NAMESPACE,
  });
}

describe('GraphNamespacePolicy（签发者信任与策略推导）', () => {
  let master: CryptoKeyPair;
  let masterPub: Uint8Array;
  let storage: MemoryStorage;
  let trusted: EventLog;
  let trusted2: EventLog;
  let deviceX: EventLog;
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

    trusted2 = await makeTrustedLog(storage, master, 'issuer2');
    deviceX = await makeTrustedLog(storage, master, 'device-X');

    // 引导期签发者：issuer（可为任意 namespace 签发）
    policy = new GraphNamespacePolicy({
      eventLog: new EventLog(storage, 'reader'),
      userMasterPublicKey: masterPub,
      policyIssuers: ['issuer'],
    });
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

  it('【洞1 red→green】未授权设备自授提权：grant(自己, nsX) 不得生效', async () => {
    // device-X 是可信设备（证书链到主密钥），但未被授权任何分区、也不在引导白名单。
    await appendGrant(deviceX, 'device-X', ['nsX'], 1000);
    expect(await policy.getAuthorizedNamespaces('device-X')).toEqual([]);
  });

  it('【洞2 red→green】被吊销签发者的记录不再被采纳（含其历史 grant）', async () => {
    await appendGrant(trusted, 'device-B', ['nsA'], 1000); // issuer 授 B
    await trusted2.append({
      type: DEVICE_REVOKE_EVENT,
      data: { deviceRevoke: { subject: 'issuer', issuedAt: 2000 } },
      namespace: POLICY_NAMESPACE,
    });
    // issuer 已被吊销 → 其历史 grant 失效
    expect(await policy.getAuthorizedNamespaces('device-B')).toEqual([]);
    expect([...(await policy.getRevokedDevices())]).toContain('issuer');
  });

  // ---- 多签发者与授权委托（R-a / R-b / R-c） ----

  const policyWith = (issuers: string[]): GraphNamespacePolicy =>
    new GraphNamespacePolicy({
      eventLog: new EventLog(storage, 'reader'),
      userMasterPublicKey: masterPub,
      policyIssuers: issuers,
    });

  it('R-a 授权转授：已获授权的非引导设备可把权限转授出去（多签发者）', async () => {
    await appendGrant(trusted, 'device-X', ['nsX'], 1000); // 引导签发者授 device-X
    const xLog = await makeTrustedLog(storage, master, 'device-X', { restore: true }); // 因果在 issuer 之后
    await appendGrant(xLog, 'device-B', ['nsX'], 2000); // device-X 转授
    expect(await policyWith(['issuer']).getAuthorizedNamespaces('device-B')).toEqual(['nsX']);
  });

  it('R-a 引导白名单：白名单设备可为未被授权的 namespace 授权', async () => {
    await appendGrant(deviceX, 'device-B', ['nsY'], 1000);
    expect(await policyWith(['device-X']).getAuthorizedNamespaces('device-B')).toEqual(['nsY']);
  });

  it('R-a 越权转授：只能给出自己已有的 namespace', async () => {
    await appendGrant(trusted, 'device-X', ['nsX'], 1000);
    const xLog = await makeTrustedLog(storage, master, 'device-X', { restore: true });
    await appendGrant(xLog, 'device-B', ['nsX'], 2000); // 合法
    await appendGrant(xLog, 'device-B', ['nsY'], 3000); // 越权（device-X 没有 nsY）
    expect(await policyWith(['issuer']).getAuthorizedNamespaces('device-B')).toEqual(['nsX']);
  });

  it('R-b 吊销连坐：被吊销签发者的 device_revoke 不再生效，也不能自复活', async () => {
    await appendDeviceRevoke(trusted2, 'device-X', 1000); // 引导 issuer2 吊销 device-X
    const xLog = await makeTrustedLog(storage, master, 'device-X', { restore: true }); // 因果在后
    await appendDeviceRevoke(xLog, 'device-B', 2000); // device-X 已吊销 → 无效
    await appendGrant(xLog, 'device-X', ['nsX'], 3000); // 自复活 → 无效
    const p = policyWith(['issuer', 'issuer2']);
    expect([...(await p.getRevokedDevices())].sort()).toEqual(['device-X']); // B 未被连带吊销
    expect(await p.getAuthorizedNamespaces('device-X')).toEqual([]);
  });

  it('R-b 互吊销：逻辑序在先者胜，结果确定且与写入顺序无关', async () => {
    const build = async (order: 'ab' | 'ba'): Promise<string[]> => {
      const s = new MemoryStorage();
      const aLog = await makeTrustedLog(s, master, 'issuer');
      const bLog = await makeTrustedLog(s, master, 'issuer2');
      const revoke = (log: EventLog, subject: string) => appendDeviceRevoke(log, subject, 1);
      if (order === 'ab') {
        await revoke(aLog, 'issuer2');
        await revoke(bLog, 'issuer');
      } else {
        await revoke(bLog, 'issuer');
        await revoke(aLog, 'issuer2');
      }
      const p = new GraphNamespacePolicy({
        eventLog: new EventLog(s, 'reader'),
        userMasterPublicKey: masterPub,
        policyIssuers: ['issuer', 'issuer2'],
      });
      return [...(await p.getRevokedDevices())].sort();
    };
    const ab = await build('ab');
    const ba = await build('ba');
    expect(ab).toEqual(ba); // 与写入顺序无关
    // ('issuer' < 'issuer2') 逻辑时间相同 → author 兜底：issuer 先处理 → issuer2 被吊销，
    // 而 issuer2 对 issuer 的吊销记录因其本人已吊销而不被采纳。
    expect(ab).toEqual(['issuer2']);
  });

  it('R-c 时钟偏移：跨签发者按逻辑时间定序，不看墙钟', async () => {
    // issuer 授 device-B（issuedAt 9999）；issuer2 吊销 device-B（issuedAt 1）但**因果在后**
    await appendGrant(trusted, 'device-B', ['nsX'], 9999);
    const bLog = await makeTrustedLog(storage, master, 'issuer2', { restore: true });
    await appendDeviceRevoke(bLog, 'device-B', 1);
    const p = policyWith(['issuer', 'issuer2']);
    // 若按墙钟：revoke(1) 排在 grant(9999) 之前 → 不吊销；按逻辑序：revoke 在后 → 吊销
    expect(await p.getAuthorizedNamespaces('device-B')).toEqual([]);
    expect([...(await p.getRevokedDevices())]).toContain('device-B');
  });

  it('F-A：被 namespace_revoke 撤销过的 grantId 不能用来清除吊销状态', async () => {
    const g1 = await appendGrant(trusted, 'device-D', ['nsA'], 1000); // g1
    await trusted.append({
      type: NAMESPACE_REVOKE_EVENT,
      data: { revoke: { grantId: g1.grantId, subject: 'device-D', issuedAt: 2000 } },
      namespace: POLICY_NAMESPACE,
    });
    await appendDeviceRevoke(trusted, 'device-D', 3000); // 吊销 D
    // 复用已被撤销的 g1 为 D 再授予
    await trusted.append({
      type: NAMESPACE_GRANT_EVENT,
      data: { grant: { ...g1, namespaces: ['nsA'], issuedAt: 4000 } },
      namespace: POLICY_NAMESPACE,
    });
    const p = policyWith(['issuer']);
    // D 必须仍在吊销集合里（当前实现会把它错误清除）
    expect([...(await p.getRevokedDevices())]).toContain('device-D');
    expect(await p.getAuthorizedNamespaces('device-D')).toEqual([]);

    // R-b 仍生效：D 发出的 device_revoke 不被采纳
    const dLog = await makeTrustedLog(storage, master, 'device-D', { restore: true });
    await appendDeviceRevoke(dLog, 'device-E', 5000);
    expect([...(await p.getRevokedDevices())]).not.toContain('device-E');
  });

  it('F-A 正例：全新 grantId 的有效授权仍可正常恢复被吊销设备', async () => {
    await appendGrant(trusted, 'device-D', ['nsA'], 1000);
    await appendDeviceRevoke(trusted, 'device-D', 2000);
    expect([...(await policyWith(['issuer']).getRevokedDevices())]).toContain('device-D');

    await appendGrant(trusted, 'device-D', ['nsA'], 3000); // 全新 grantId
    const p = policyWith(['issuer']);
    expect([...(await p.getRevokedDevices())]).not.toContain('device-D');
    expect(await p.getAuthorizedNamespaces('device-D')).toEqual(['nsA']);
  });

  it('F-B：被吊销签发者发出的 namespace_revoke 不得生效（R-b）', async () => {
    const g = await appendGrant(trusted, 'device-B', ['nsA'], 1000); // 有效授权
    await appendDeviceRevoke(trusted, 'device-D', 2000); // 吊销 D
    const dLog = await makeTrustedLog(storage, master, 'device-D', { restore: true });
    await dLog.append({
      type: NAMESPACE_REVOKE_EVENT,
      data: { revoke: { grantId: g.grantId, subject: 'device-B', issuedAt: 3000 } },
      namespace: POLICY_NAMESPACE,
    });
    // D 已被吊销 → 它发出的 revoke 不采纳：B 的授权仍在
    expect(await policyWith(['issuer']).getAuthorizedNamespaces('device-B')).toEqual(['nsA']);
  });

  it('F-B 正例：有效签发者的 namespace_revoke 仍生效', async () => {
    const g = await appendGrant(trusted, 'device-B', ['nsA'], 1000);
    await trusted.append({
      type: NAMESPACE_REVOKE_EVENT,
      data: { revoke: { grantId: g.grantId, subject: 'device-B', issuedAt: 2000 } },
      namespace: POLICY_NAMESPACE,
    });
    expect(await policyWith(['issuer']).getAuthorizedNamespaces('device-B')).toEqual([]);
  });

  it('F-B 确定性：条目顺序打乱不影响结果（含被吊销者的 revoke）；重复读稳定', async () => {
    // 用同一批（签名/向量时钟固定）事件，按不同顺序写入两个存储
    const src = new MemoryStorage();
    const issuerLog = await makeTrustedLog(src, master, 'issuer');
    const issuer2Log = await makeTrustedLog(src, master, 'issuer2');
    const g = await appendGrant(issuerLog, 'device-B', ['nsA'], 1000);
    await appendDeviceRevoke(issuerLog, 'device-D', 2000);
    const dLog = await makeTrustedLog(src, master, 'device-D', { restore: true });
    await dLog.append({
      type: NAMESPACE_REVOKE_EVENT,
      data: { revoke: { grantId: g.grantId, subject: 'device-B', issuedAt: 3000 } },
      namespace: POLICY_NAMESPACE,
    });
    await appendDeviceRevoke(issuer2Log, 'device-E', 4000);
    const events = await src.listEvents();

    const build = async (list: typeof events): Promise<GraphNamespacePolicy> => {
      const s = new MemoryStorage();
      for (const e of list) await s.putEvent(e);
      return new GraphNamespacePolicy({
        eventLog: new EventLog(s, 'reader'),
        userMasterPublicKey: masterPub,
        policyIssuers: ['issuer', 'issuer2'],
      });
    };
    const p1 = await build(events);
    const p2 = await build([...events].reverse());
    const snap = async (p: GraphNamespacePolicy) => ({
      b: await p.getAuthorizedNamespaces('device-B'),
      revoked: [...(await p.getRevokedDevices())].sort(),
    });
    const r1 = await snap(p1);
    expect(await snap(p2)).toEqual(r1); // 顺序无关
    expect(await snap(p1)).toEqual(r1); // 重复读稳定（不动点不振荡）
    // 被吊销者 D 的 revoke 不生效：B 仍授权
    expect(r1.b).toEqual(['nsA']);
  });

  it('强级联确认：A 被吊销 → B 失去授权 → B 转授给 C 的那条也不生效（R-a 已足够）', async () => {
    await appendGrant(trusted, 'device-B', ['nsX'], 1000); // A=issuer 授 B
    const bLog = await makeTrustedLog(storage, master, 'device-B', { restore: true }); // 因果在后
    await appendGrant(bLog, 'device-C', ['nsX'], 2000); // B 转授 C
    expect(await policyWith(['issuer']).getAuthorizedNamespaces('device-C')).toEqual(['nsX']);

    await appendDeviceRevoke(trusted2, 'issuer', 3000); // A 被 issuer2 吊销
    const p = policyWith(['issuer', 'issuer2']);
    expect(await p.getAuthorizedNamespaces('device-B')).toEqual([]);
    expect(await p.getAuthorizedNamespaces('device-C')).toEqual([]); // 级联生效
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

/** 端到端夹具里所有设备都可作引导签发者（这些用例关注吊销/水位/快照，不关注越权边界） */
const E2E_POLICY_ISSUERS = ['device-A', 'device-B', 'device-C', 'device-D'];

async function createDevice(
  deviceId: string,
  master: CryptoKeyPair,
  masterPub: Uint8Array,
  options: { snapshotThreshold?: number; policyIssuers?: string[] } = {},
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
  const policy = new GraphNamespacePolicy({
    eventLog,
    userMasterPublicKey: masterPub,
    policyIssuers: options.policyIssuers ?? E2E_POLICY_ISSUERS,
  });
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
      // 引导期签发者：本机（device-A）可签发
      sync: { autoSync: false, policyIssuers: ['device-A'] },
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
