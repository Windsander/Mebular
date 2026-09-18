// C1：引导签发者上图化（`policy_issuer_declare`）——去中心化 bootstrap 的回归锚点。
//
// 生效引导集合 = 图上被采纳声明 ∪ 本地配置 policyIssuers；声明无条件采纳（不做 R-a），
// 但受 R-b 约束（签发者或主体被吊销 → 不采纳）。见 src/sync/POLICY-INVARIANTS.md 与 SEALING.md §3。

import { describe, it, expect, beforeEach } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mebular } from '../../src/mebular.js';
import { EventLog } from '../../src/eventlog/EventLog.js';
import { MemoryStorage } from '../../src/storage/MemoryStorage.js';
import {
  GraphNamespacePolicy,
  derivePolicyState,
  POLICY_NAMESPACE,
  NAMESPACE_GRANT_EVENT,
  DEVICE_REVOKE_EVENT,
  POLICY_ISSUER_DECLARE_EVENT,
  type NamespaceGrantRecord,
} from '../../src/sync/grantPolicy.js';
import {
  createTestIdentity,
  generateMasterKeyPair,
  issueCertificate,
  masterPublicKeyBytes,
} from '../p2p/helpers.js';

type Entry = Parameters<typeof derivePolicyState>[0][number];

let seq = 0;
function entry(kind: Entry['kind'], author: string, extra: Partial<Entry>): Entry {
  seq += 1;
  return { kind, author, seq, logical: seq, id: `${kind}-${seq}`, ...extra } as Entry;
}
const declare = (author: string, subject: string): Entry =>
  entry('issuer', author, { issuer: { subject, issuedAt: seq } });
const grant = (author: string, subject: string, namespaces: string[], grantId = randomUUID()): Entry =>
  entry('grant', author, { id: grantId, grant: { grantId, subject, namespaces, issuedAt: seq } });
const deviceRevoke = (author: string, subject: string): Entry =>
  entry('device', author, { device: { subject, issuedAt: seq } });
const nsRevoke = (author: string, id: string): Entry => entry('revoke', author, { revoke: { grantId: id, issuedAt: seq } });

const sortedNames = (s: Set<string>): string[] => [...s].sort();
const key = (state: ReturnType<typeof derivePolicyState>) => ({
  authorized: [...state.authorized.keys()].sort().map((k) => [k, [...state.authorized.get(k)!].sort()]),
  revoked: [...state.revoked].sort(),
  issuers: sortedNames(state.issuers),
});

describe('C1 纯函数：图上声明引导签发者', () => {
  it('① 仅图声明（无本地配置）→ 自动采纳：声明者上位后其 grant 生效', () => {
    const entries = [declare('root', 'root'), grant('root', 'device-B', ['nsA'])];
    const state = derivePolicyState(entries); // 无 policyIssuers 配置
    expect(sortedNames(state.issuers)).toEqual(['root']);
    expect(state.authorized.get('device-B')).toEqual(['nsA']);
  });

  it('⑧ 声明与配置并集：配置 bootstrap 与图上声明都生效', () => {
    const entries = [grant('cfg', 'device-C', ['nsA']), declare('root', 'root'), grant('root', 'device-B', ['nsB'])];
    const state = derivePolicyState(entries, { policyIssuers: ['cfg'] });
    expect(sortedNames(state.issuers)).toEqual(['cfg', 'root']);
    expect(state.authorized.get('device-C')).toEqual(['nsA']);
    expect(state.authorized.get('device-B')).toEqual(['nsB']);
  });

  it('② 声明了被吊销设备 → 不生效（R-b 优先级：吊销设备不得成为签发者）', () => {
    const entries = [
      declare('root', 'root'),
      deviceRevoke('root', 'bad'), // bad 被吊销
      declare('root', 'bad'), // 声明被吊销设备 → 不采纳
      grant('bad', 'device-B', ['nsA']), // bad 的 grant 也不生效
    ];
    const state = derivePolicyState(entries);
    expect(state.issuers.has('bad')).toBe(false);
    expect(state.authorized.get('device-B')).toBeUndefined();
  });

  it('②b 被吊销签发者的声明不生效（R-b 含历史）', () => {
    const entries = [declare('bad', 'bad'), deviceRevoke('root', 'bad'), declare('root', 'root'), grant('root', 'device-B', ['nsA'])];
    const state = derivePolicyState(entries);
    // bad 被吊销 → 其声明不采纳；root 声明生效
    expect(state.issuers.has('bad')).toBe(false);
    expect(sortedNames(state.issuers)).toEqual(['root']);
  });

  it('⑤ 声明与 R-d 撤销交互：声明不复活被撤销的 grant；新 grantId 才恢复', () => {
    const g = grant('root', 'device-B', ['nsA']);
    const entries = [declare('root', 'root'), g, nsRevoke('root', g.grant!.grantId), declare('root', 'root')];
    const state = derivePolicyState(entries);
    expect(state.authorized.get('device-B')).toBeUndefined();
  });

  it('顺序无关 + 幂等（含声明）', () => {
    const entries = [declare('root', 'root'), grant('root', 'device-B', ['nsA']), declare('other', 'root')];
    const a = key(derivePolicyState(entries));
    const b = key(derivePolicyState([...entries].reverse()));
    expect(b).toEqual(a);
    expect(key(derivePolicyState(entries))).toEqual(a);
  });

  it('空配置删声明 → 授权单调不增（声明只可能增加签发者）', () => {
    const withDecl = [declare('root', 'root'), grant('root', 'device-B', ['nsA'])];
    const without = withDecl.filter((e) => e.kind !== 'issuer');
    const full = derivePolicyState(withDecl);
    const stripped = derivePolicyState(without);
    expect(full.authorized.get('device-B')).toEqual(['nsA']);
    expect(stripped.authorized.size).toBeLessThanOrEqual(full.authorized.size);
    expect(stripped.authorized.get('device-B')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 集成：GraphNamespacePolicy（信任过滤 + 伪造忽略）
// ---------------------------------------------------------------------------

async function trustedLog(storage: MemoryStorage, master: CryptoKeyPair, deviceId: string): Promise<EventLog> {
  const identity = await createTestIdentity(deviceId);
  await issueCertificate(master.privateKey, identity);
  return new EventLog(storage, deviceId, {
    signer: { deviceId, privateKey: identity.identity.devicePrivateKey, certificate: identity.identity.certificate },
  });
}
async function appendDeclare(log: EventLog, subject: string): Promise<void> {
  await log.append({ type: POLICY_ISSUER_DECLARE_EVENT, data: { policyIssuer: { subject, issuedAt: Date.now() } }, namespace: POLICY_NAMESPACE });
}
async function appendGrant(log: EventLog, subject: string, namespaces: string[]): Promise<NamespaceGrantRecord> {
  const record: NamespaceGrantRecord = { grantId: randomUUID(), subject, namespaces, issuedAt: Date.now() };
  await log.append({ type: NAMESPACE_GRANT_EVENT, data: { grant: record }, namespace: POLICY_NAMESPACE });
  return record;
}

describe('C1 集成：图上声明 + 信任过滤', () => {
  let master: CryptoKeyPair;
  let masterPub: Uint8Array;
  let storage: MemoryStorage;

  beforeEach(async () => {
    master = await generateMasterKeyPair();
    masterPub = await masterPublicKeyBytes(master);
    storage = new MemoryStorage();
  });

  it('① 仅图声明（无本地 policyIssuers）→ 采纳其 grant', async () => {
    const root = await trustedLog(storage, master, 'root');
    await appendDeclare(root, 'root');
    await appendGrant(root, 'device-B', ['nsA']);
    const policy = new GraphNamespacePolicy({ eventLog: new EventLog(storage, 'reader'), userMasterPublicKey: masterPub });
    expect(await policy.getPolicyIssuers()).toEqual(['root']);
    expect(await policy.getAuthorizedNamespaces('device-B')).toEqual(['nsA']);
  });

  it('③ 配置回退：无声明时，本地 policyIssuers 仍生效（兼容）', async () => {
    const root = await trustedLog(storage, master, 'root');
    await appendGrant(root, 'device-B', ['nsA']);
    const policy = new GraphNamespacePolicy({ eventLog: new EventLog(storage, 'reader'), userMasterPublicKey: masterPub, policyIssuers: ['root'] });
    expect(await policy.getAuthorizedNamespaces('device-B')).toEqual(['nsA']);
  });

  it('③b 图上声明与配置并集（集成）', async () => {
    const cfg = await trustedLog(storage, master, 'cfg');
    const root = await trustedLog(storage, master, 'root');
    await appendGrant(cfg, 'device-C', ['nsA']);
    await appendDeclare(root, 'root');
    await appendGrant(root, 'device-B', ['nsB']);
    const policy = new GraphNamespacePolicy({ eventLog: new EventLog(storage, 'reader'), userMasterPublicKey: masterPub, policyIssuers: ['cfg'] });
    expect(await policy.getPolicyIssuers()).toEqual(['cfg', 'root']);
    expect(await policy.getAuthorizedNamespaces('device-C')).toEqual(['nsA']);
    expect(await policy.getAuthorizedNamespaces('device-B')).toEqual(['nsB']);
  });

  it('④ 非主密钥链签名的声明/伪造 → 忽略', async () => {
    // 别家用户主密钥签的声明/授权
    const outsiderMaster = await generateMasterKeyPair();
    const outsider = await trustedLog(storage, outsiderMaster, 'outsider');
    await appendDeclare(outsider, 'outsider');
    await appendGrant(outsider, 'device-X', ['nsA']);
    // 无证书设备
    const noCertId = await createTestIdentity('nocert');
    const noCert = new EventLog(storage, 'nocert', { signer: { deviceId: 'nocert', privateKey: noCertId.identity.devicePrivateKey } });
    await appendDeclare(noCert, 'nocert');

    const policy = new GraphNamespacePolicy({ eventLog: new EventLog(storage, 'reader'), userMasterPublicKey: masterPub });
    expect(await policy.getPolicyIssuers()).toEqual([]);
    expect(await policy.getAuthorizedNamespaces('device-X')).toEqual([]);
  });

  it('② 声明了被吊销设备：其声明与 grant 均不生效', async () => {
    const root = await trustedLog(storage, master, 'root');
    await appendDeclare(root, 'bad');
    await root.append({ type: DEVICE_REVOKE_EVENT, data: { deviceRevoke: { subject: 'bad', issuedAt: Date.now() } }, namespace: POLICY_NAMESPACE });
    const bad = await trustedLog(storage, master, 'bad');
    await appendGrant(bad, 'device-B', ['nsA']);
    const policy = new GraphNamespacePolicy({ eventLog: new EventLog(storage, 'reader'), userMasterPublicKey: masterPub });
    expect(await policy.getPolicyIssuers()).toEqual([]);
    expect(await policy.getAuthorizedNamespaces('device-B')).toEqual([]);
  });

  it('Mebular 门面：declarePolicyIssuer → getPolicyIssuers 生效（无本地配置）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'c1-facade-'));
    try {
      const pair = await Mebular.generateUserMasterKey('c1-user');
      const m = new Mebular({
        storagePath: join(dir, 'store.jsonl'),
        deviceId: 'root',
        encryption: { userMasterKey: pair.publicKey, userMasterPrivateKey: pair.privateKey },
      });
      await m.initialize();
      expect(await m.getPolicyIssuers()).toEqual([]);
      await m.declarePolicyIssuer({ subject: 'root' });
      expect(await m.getPolicyIssuers()).toEqual(['root']);
      await m.shutdown();
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});
