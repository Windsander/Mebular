// M1–M3：订阅 = 成员资格（持久签名成员记录 + 裁剪链 + 显式拒绝）。
//
// 锚点：
//  ① 成员 ∧ 授权 → 参与同步；
//  ② 非成员声明订阅 → **显式拒绝**（sync-completed.membershipRejected，不静默）；
//  ③ 成员但无授权 → 数据不流动（默认拒绝不变）；
//  ④ 注销后 → 新事件不再到达（旧数据保留，清理属 2b）；
//  ⑤ 伪造/非主密钥链成员记录 → 忽略；
//  ⑥ 成员记录**不改变**授权/吊销（独立轴）；同键最新胜出（R-c）；顺序无关/幂等。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mebular } from '../../src/mebular.js';
import { IdentityManager } from '../../src/crypto/IdentityManager.js';
import { InMemoryHub } from '../../src/p2p/transport/InMemoryTransport.js';
import { EventLog } from '../../src/eventlog/EventLog.js';
import { MemoryStorage } from '../../src/storage/MemoryStorage.js';
import type { SyncResult } from '../../src/sync/syncmgr/SyncManager.js';
import {
  GraphNamespacePolicy,
  derivePolicyState,
  POLICY_NAMESPACE,
  NAMESPACE_MEMBERSHIP_EVENT,
} from '../../src/sync/grantPolicy.js';
import { createTestIdentity, generateMasterKeyPair, issueCertificate, masterPublicKeyBytes } from '../p2p/helpers.js';

type Entry = Parameters<typeof derivePolicyState>[0][number];
let seq = 0;
const entry = (kind: Entry['kind'], author: string, extra: Partial<Entry>): Entry => {
  seq += 1;
  return { kind, author, seq, logical: seq, id: `${kind}-${seq}`, ...extra } as Entry;
};
const member = (author: string, m: string, ns: string, active: boolean): Entry =>
  entry('membership', author, { membership: { member: m, namespace: ns, active, issuedAt: seq } });
const grant = (author: string, subject: string, ns: string): Entry =>
  entry('grant', author, { id: `g-${seq}`, grant: { grantId: `g-${seq}`, subject, namespaces: [ns], issuedAt: seq } });
const devRevoke = (author: string, subject: string): Entry =>
  entry('device', author, { device: { subject, issuedAt: seq } });

describe('M1 纯函数：成员资格推导（确定、顺序无关、独立于授权）', () => {
  it('① 采纳 active 成员；分区进入「已启用成员资格」', () => {
    const entries = [member('root', 'device-B', 'nsA', true)];
    const s = derivePolicyState(entries);
    expect([...(s.members.get('nsA') ?? [])]).toEqual(['device-B']);
    expect(s.membershipNamespaces.has('nsA')).toBe(true);
  });

  it('⑥ 同键取 R-c 最新（注销覆盖在册；顺序无关）', () => {
    const entries = [member('root', 'device-B', 'nsA', true), member('root', 'device-B', 'nsA', false)];
    const a = derivePolicyState(entries);
    expect([...(a.members.get('nsA') ?? [])]).toEqual([]);
    expect(a.membershipNamespaces.has('nsA')).toBe(true); // 仍有记录 → 已启用
    expect([...(derivePolicyState([...entries].reverse()).members.get('nsA') ?? [])]).toEqual([]);
  });

  it('R-b：被吊销签发者/成员的记录不采纳', () => {
    const entries = [
      member('bad', 'device-B', 'nsA', true),
      devRevoke('root', 'bad'),
      member('root', 'device-C', 'nsA', true),
      devRevoke('root', 'device-C'),
    ];
    const s = derivePolicyState(entries);
    expect(s.membershipNamespaces.has('nsA')).toBe(false);
    expect(s.members.get('nsA')).toBeUndefined();
  });

  it('⑥ 成员记录不改变 authorized/revoked（独立轴）', () => {
    const base = [grant('root', 'device-B', 'nsA'), devRevoke('root', 'device-D')];
    const withMembers = [...base, member('root', 'device-B', 'nsA', true), member('root', 'device-D', 'nsA', true)];
    const a = derivePolicyState(base);
    const b = derivePolicyState(withMembers);
    expect([...b.authorized.keys()].sort()).toEqual([...a.authorized.keys()].sort());
    expect([...b.revoked].sort()).toEqual([...a.revoked].sort());
  });
});

describe('M1–M3 门面：裁剪链 与 显式拒绝', () => {
  let dir: string;
  let masterKeys: { userMasterKey: Uint8Array; userMasterPrivateKey: CryptoKey };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mebular-membership-'));
    const master = await new IdentityManager().generateUserMasterKey();
    masterKeys = { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey };
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 });
  });

  function makeFacade(deviceId: string, hub: InMemoryHub, sync: Record<string, unknown> = {}): Mebular {
    return new Mebular({
      storagePath: join(dir, `${deviceId}.jsonl`),
      deviceId,
      encryption: masterKeys,
      network: { enabled: true, provider: hub },
      sync: { autoSync: true, ...sync },
    });
  }
  async function syncBetween(a: Mebular, b: Mebular): Promise<[SyncResult, SyncResult]> {
    const aSynced = new Promise<SyncResult>((resolve) => a.sync.once('sync-completed', resolve));
    const bSynced = new Promise<SyncResult>((resolve) => b.sync.once('sync-completed', resolve));
    await b.node!.connectToPeer(a.node!.peerId);
    return Promise.all([aSynced, bSynced]);
  }
  const namespacesOf = async (m: Mebular): Promise<string[]> => (await m.graph.listNodes()).map((n) => n.namespace ?? '');

  it('① 成员 ∧ 授权 → 参与同步', async () => {
    const hub = new InMemoryHub();
    const a = makeFacade('device-A', hub, { peerNamespacePolicy: { 'device-B': ['nsA'] } });
    const b = makeFacade('device-B', hub, { namespaces: ['nsA'] });
    await a.initialize();
    await b.initialize();
    await a.declareNamespaceMembership({ member: 'device-B', namespace: 'nsA' });
    await a.graph.createNode('fact', { text: 'a' }, [], { namespace: 'nsA' });
    await syncBetween(a, b);
    expect(await namespacesOf(b)).toEqual(['nsA']);
    await a.shutdown();
    await b.shutdown();
  });

  it('② 非成员声明订阅 → 显式拒绝（membershipRejected，不静默）', async () => {
    const hub = new InMemoryHub();
    const a = makeFacade('device-A', hub, { peerNamespacePolicy: { 'device-B': ['nsA'] } });
    const b = makeFacade('device-B', hub, { namespaces: ['nsA'] });
    await a.initialize();
    await b.initialize();
    // nsA 已启用成员资格，但成员是 device-C（不含 device-B）；A 仍授权 B
    await a.declareNamespaceMembership({ member: 'device-C', namespace: 'nsA' });
    await a.graph.createNode('fact', { text: 'a' }, [], { namespace: 'nsA' });
    const [aResult] = await syncBetween(a, b);
    expect(aResult.membershipRejected).toEqual(['nsA']);
    expect(await b.graph.listNodes()).toEqual([]);
    await a.shutdown();
    await b.shutdown();
  });

  it('③ 成员但无授权 → 数据不流动（默认拒绝不变）', async () => {
    const hub = new InMemoryHub();
    // A 未授权 B（无 peerNamespacePolicy / grant），但声明 B 为成员
    const a = makeFacade('device-A', hub);
    const b = makeFacade('device-B', hub, { namespaces: ['nsA'] });
    await a.initialize();
    await b.initialize();
    await a.declareNamespaceMembership({ member: 'device-B', namespace: 'nsA' });
    await a.graph.createNode('fact', { text: 'a' }, [], { namespace: 'nsA' });
    await syncBetween(a, b);
    expect(await b.graph.listNodes()).toEqual([]);
    await a.shutdown();
    await b.shutdown();
  });

  it('④ 注销后 → 新事件不再到达（旧数据保留，清理属 2b）', async () => {
    const hub = new InMemoryHub();
    const optsA = { peerNamespacePolicy: { 'device-B': ['nsA'] } };
    const a = makeFacade('device-A', hub, optsA);
    const b = makeFacade('device-B', hub, { namespaces: ['nsA'] });
    await a.initialize();
    await b.initialize();
    await a.declareNamespaceMembership({ member: 'device-B', namespace: 'nsA' });
    await a.graph.createNode('fact', { text: 'one' }, [], { namespace: 'nsA' });
    await syncBetween(a, b);
    expect(await namespacesOf(b)).toEqual(['nsA']);
    await a.shutdown();
    await b.shutdown();

    // 重开同一存储（持久），注销成员后再加新事件 → B 不再收到新事件
    const a2 = makeFacade('device-A', hub, optsA);
    const b2 = makeFacade('device-B', hub, { namespaces: ['nsA'] });
    await a2.initialize();
    await b2.initialize();
    await a2.declareNamespaceMembership({ member: 'device-B', namespace: 'nsA', active: false });
    await a2.graph.createNode('fact', { text: 'two' }, [], { namespace: 'nsA' });
    await syncBetween(a2, b2);
    expect((await b2.graph.listNodes()).length).toBe(1); // 旧 'one' 保留，'two' 未到达
    await a2.shutdown();
    await b2.shutdown();
  });

  it('M4/2b 铺路：getNamespaceMembership / getNamespaceMembers（∩ 授权）', async () => {
    const hub = new InMemoryHub();
    const a = makeFacade('device-A', hub, { peerNamespacePolicy: { 'device-B': ['nsA'] } });
    await a.initialize();
    expect((await a.getNamespaceMembership('nsA')).active).toBe(false); // 未启用
    await a.declareNamespaceMembership({ member: 'device-B', namespace: 'nsA' });
    expect(await a.getNamespaceMembership('nsA')).toEqual({ active: true, members: ['device-B'] });
    // B 被授权 → 生效成员含 B
    expect(await a.getNamespaceMembers('nsA')).toEqual(['device-B']);
    await a.shutdown();
  });
});

describe('⑤ 集成：伪造/非主密钥链成员记录被忽略', () => {
  it('别家用户主密钥签的成员记录 → GraphNamespacePolicy 忽略', async () => {
    const storage = new MemoryStorage();
    const master = await generateMasterKeyPair();
    const masterPub = await masterPublicKeyBytes(master);
    const outsiderMaster = await generateMasterKeyPair();
    const outsiderId = await createTestIdentity('outsider');
    await issueCertificate(outsiderMaster.privateKey, outsiderId);
    const outsider = new EventLog(storage, 'outsider', {
      signer: { deviceId: 'outsider', privateKey: outsiderId.identity.devicePrivateKey, certificate: outsiderId.identity.certificate },
    });
    await outsider.append({
      type: NAMESPACE_MEMBERSHIP_EVENT,
      data: { membership: { member: 'device-X', namespace: 'nsA', active: true, issuedAt: Date.now() } },
      namespace: POLICY_NAMESPACE,
    });
    const policy = new GraphNamespacePolicy({ eventLog: new EventLog(storage, 'reader'), userMasterPublicKey: masterPub });
    expect(await policy.getNamespaceMembership('nsA')).toEqual({ active: false, members: [] });
  });
});
