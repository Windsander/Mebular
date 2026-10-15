// 守护层自动签发（订阅驱动授权）测试：规则链 + 红线 + 竞态恢复语义 + 门面集成 + kill-switch。
//
// 锚点（批准版提案 ④）：
//  ① 在册无授权 → 幂等签发（第二轮零新增）；
//  ②【红线】被吊销 → 永不签发；含「membership 在册 → device_revoke → 评估 → 无 grant」；
//  ③ 竞态恢复序：grant 之后落 device_revoke → 重新吊销（derive 级固定语义）；
//  ④ 非信任链记录不进快照 → 不触发签发；
//  ⑤ 无订阅声明 → 不签；self → 不签；签发资格不足 → 不签；已授权 → 跳过；多供给端 → 各自签发互不妨碍；
//  ⑥ 门面集成：订阅 → 自动放行 → 数据到位；屏蔽 → 订阅 → 仍被拒；kill-switch 关 → 默认拒绝。

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
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
  NAMESPACE_GRANT_EVENT,
} from '../../src/sync/grantPolicy.js';
import { evaluateAutoGrants, type AutoGrantSnapshot } from '../../src/sync/autoGrant.js';
import { createTestIdentity, generateMasterKeyPair, issueCertificate, masterPublicKeyBytes } from '../p2p/helpers.js';

jest.setTimeout(30_000);

// ---------- derive 级小助手（与 membership.test.ts 同形） ----------
type Entry = Parameters<typeof derivePolicyState>[0][number];
let seq = 0;
const entry = (kind: Entry['kind'], author: string, extra: Partial<Entry>): Entry => {
  seq += 1;
  return { kind, author, seq, logical: seq, id: `${kind}-${seq}`, ...extra } as Entry;
};
const memberE = (author: string, m: string, ns: string, active: boolean): Entry =>
  entry('membership', author, { membership: { member: m, namespace: ns, active, issuedAt: seq } });
const grantE = (author: string, subject: string, ns: string, id?: string): Entry =>
  entry('grant', author, { id: id ?? `g-${seq}`, grant: { grantId: id ?? `g-${seq}`, subject, namespaces: [ns], issuedAt: seq } });
const devRevokeE = (author: string, subject: string): Entry =>
  entry('device', author, { device: { subject, issuedAt: seq } });

// ---------- 纯函数夹具 ----------
const snap = (over: Partial<AutoGrantSnapshot> = {}): AutoGrantSnapshot => ({
  authorized: new Map(),
  revoked: new Set(),
  issuers: new Set(['device-A']),
  members: new Map([['nsA', new Set(['device-B'])]]),
  ...over,
});
const grantSpy = () => {
  const calls: Array<{ subject: string; namespaces: string[]; note: string }> = [];
  return { calls, grant: async (input: { subject: string; namespaces: string[]; note: string }) => { calls.push(input); } };
};

describe('autoGrant 纯函数：规则链（顺序即防线）', () => {
  it('① 在册无授权 → 签发；第二轮 → 零新增（幂等）', async () => {
    const { calls, grant } = grantSpy();
    const first = await evaluateAutoGrants({ snapshot: snap(), self: 'device-A', grant });
    expect(first.candidates).toBe(1);
    expect(first.issued).toEqual([{ subject: 'device-B', namespace: 'nsA' }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.note).toBe('auto-grant: subscription-driven');
    // 第二轮：对端已持生效 grant → 幂等跳过
    const second = await evaluateAutoGrants({
      snapshot: snap({ authorized: new Map([['device-B', ['nsA']]]) }),
      self: 'device-A',
      grant,
    });
    expect(second.issued).toEqual([]);
    expect(second.skipped.alreadyAuthorized).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it('②【红线】被吊销成员 → 永不签发（快照前置排除）', async () => {
    const { calls, grant } = grantSpy();
    const res = await evaluateAutoGrants({
      snapshot: snap({ revoked: new Set(['device-B']) }),
      self: 'device-A',
      grant,
    });
    expect(res.issued).toEqual([]);
    expect(res.skipped.revoked).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it('②b【红线加固】签发前再查吊销：confirmNotRevoked 否决 → 放弃签发（竞态窗口语义）', async () => {
    const { calls, grant } = grantSpy();
    const res = await evaluateAutoGrants({
      snapshot: snap(), // 快照内未吊销
      self: 'device-A',
      confirmNotRevoked: async () => false, // 签发前一刻刚被吊销
      grant,
    });
    expect(res.issued).toEqual([]);
    expect(res.skipped.revoked).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it('⑤a 无订阅声明（不在册）→ 不签', async () => {
    const { calls, grant } = grantSpy();
    const res = await evaluateAutoGrants({ snapshot: snap({ members: new Map() }), self: 'device-A', grant });
    expect(res.candidates).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('⑤b self 在册 → 跳过（rejoin 准入语义本轮冻结）', async () => {
    const { calls, grant } = grantSpy();
    const res = await evaluateAutoGrants({
      snapshot: snap({ members: new Map([['nsA', new Set(['device-A'])]]) }),
      self: 'device-A',
      grant,
    });
    expect(res.issued).toEqual([]);
    expect(res.skipped.self).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it('⑤c 签发资格不足（非 bootstrap 且未获授权该域）→ 不签（不写死记录）', async () => {
    const { calls, grant } = grantSpy();
    const res = await evaluateAutoGrants({
      snapshot: snap({ issuers: new Set() }), // self 不在 bootstrap
      self: 'device-A',
      grant,
    });
    expect(res.issued).toEqual([]);
    expect(res.skipped.issuerNotQualified).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it('⑤d 签发资格：self 已被授权该域（非 bootstrap）→ 签（R-a 转授）', async () => {
    const { calls, grant } = grantSpy();
    const res = await evaluateAutoGrants({
      snapshot: snap({ issuers: new Set(), authorized: new Map([['device-A', ['nsA']]]) }),
      self: 'device-A',
      grant,
    });
    expect(res.issued).toEqual([{ subject: 'device-B', namespace: 'nsA' }]);
  });

  it('⑤e 已授权成员 → 跳过', async () => {
    const { calls, grant } = grantSpy();
    const res = await evaluateAutoGrants({
      snapshot: snap({ authorized: new Map([['device-B', ['nsA']]]) }),
      self: 'device-A',
      grant,
    });
    expect(res.skipped.alreadyAuthorized).toBe(1);
    expect(calls).toHaveLength(0);
  });
});

describe('autoGrant derive 级：竞态恢复与多供给端语义固定', () => {
  it('③ 竞态恢复序：grant 之后落 device_revoke → 重新吊销（恢复路径）', () => {
    const opts = { policyIssuers: ['root'] }; // R-a：root 为 bootstrap，grant 才可被采纳
    const s = derivePolicyState([grantE('root', 'device-B', 'nsA'), devRevokeE('root', 'device-B')], opts);
    expect(s.revoked.has('device-B')).toBe(true);          // 后到的吊销生效
    expect(s.authorized.get('device-B') ?? []).toEqual([]); // 读侧仍默认拒绝
  });

  it('③b R-d 恢复序（红线之所以存在）：revoke 之后落 grant → 吊销被清除', () => {
    const opts = { policyIssuers: ['root'] };
    const s = derivePolicyState([devRevokeE('root', 'device-B'), grantE('root', 'device-B', 'nsA')], opts);
    expect(s.revoked.has('device-B')).toBe(false); // 被采纳 grant 清除吊销 → 自动签发必须先查吊销
    expect(s.authorized.get('device-B')).toEqual(['nsA']);
  });

  it('⑤f 多供给端各签一条（不同 grantId）→ 推导正常、互不妨碍', () => {
    const opts = { policyIssuers: ['root'] };
    const s = derivePolicyState([
      memberE('root', 'device-B', 'nsA', true),
      grantE('root', 'device-B', 'nsA', 'g-from-A'),
      grantE('root', 'device-B', 'nsA', 'g-from-C'),
    ], opts);
    expect(s.authorized.get('device-B')).toEqual(['nsA']); // 去重后同一白名单
  });
});

describe('④ 非信任链记录不进快照 → 不触发签发', () => {
  it('别家用户主密钥签的成员记录：GraphNamespacePolicy 忽略 → 评估零候选', async () => {
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
    const { calls, grant } = grantSpy();
    const res = await evaluateAutoGrants({ snapshot: await policy.snapshot(), self: 'device-A', grant });
    expect(res.candidates).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

// ---------- 门面集成（双实例 InMemory 同步） ----------
describe('autoGrant 门面集成：订阅 → 自动放行 → 数据到位；红线；kill-switch', () => {
  let dir: string;
  let masterKeys: { userMasterKey: Uint8Array; userMasterPrivateKey: CryptoKey };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mebular-autogrant-'));
    const master = await new IdentityManager().generateUserMasterKey();
    masterKeys = { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey };
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 });
  });

  // policyIssuers 双端一致配置（R-a：A 的 grant 在两端推导中都可被采纳）
  function makeFacade(deviceId: string, hub: InMemoryHub, sync: Record<string, unknown> = {}): Mebular {
    return new Mebular({
      storagePath: join(dir, `${deviceId}.jsonl`),
      deviceId,
      encryption: masterKeys,
      network: { enabled: true, provider: hub },
      sync: { autoSync: true, policyIssuers: ['device-A'], ...sync },
    });
  }
  async function syncBetween(a: Mebular, b: Mebular): Promise<[SyncResult, SyncResult]> {
    // 已认证的现存会话会让 connectToPeer 早退（不触发新同步会话）；先断开保证每次都有新会话。
    await b.node!.disconnectPeer(a.node!.peerId).catch(() => undefined);
    const aSynced = new Promise<SyncResult>((resolve) => a.sync.once('sync-completed', resolve));
    const bSynced = new Promise<SyncResult>((resolve) => b.sync.once('sync-completed', resolve));
    await b.node!.connectToPeer(a.node!.peerId);
    return Promise.all([aSynced, bSynced]);
  }
  const namespacesOf = async (m: Mebular): Promise<string[]> => (await m.graph.listNodes()).map((n) => n.namespace ?? '');
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  it('② 订阅（在册）→ 评估签发 → 下一同步数据到位；note 标记可查', async () => {
    const hub = new InMemoryHub();
    const a = makeFacade('device-A', hub);
    const b = makeFacade('device-B', hub, { namespaces: ['nsA'] });
    await a.initialize();
    await b.initialize();
    await a.graph.createNode('fact', { text: 'a' }, [], { namespace: 'nsA' });
    // B 声明订阅（订阅=成员资格，M1）→ 同步到 A
    await b.declareNamespaceMembership({ member: 'device-B', namespace: 'nsA' });
    await syncBetween(a, b);
    expect(await namespacesOf(b)).toEqual([]); // 尚无授权 → 默认拒绝
    // A 守护评估 → 自动签发
    const evalRes = await a.evaluateAutoGrantsOnce();
    expect(evalRes?.issued).toEqual([{ subject: 'device-B', namespace: 'nsA' }]);
    // 签发于 A 图上的记录带 note 标记
    const policyEvents = await a.eventLog.listEvents({ namespace: POLICY_NAMESPACE });
    const autoGrant = policyEvents.find((e) => e.type === NAMESPACE_GRANT_EVENT);
    expect((autoGrant?.data as { grant?: { note?: string } } | undefined)?.grant?.note).toBe('auto-grant: subscription-driven');
    // 再评 → 幂等零新增
    expect((await a.evaluateAutoGrantsOnce())?.issued).toEqual([]);
    // 下一同步 → 数据到位
    await syncBetween(a, b);
    expect(await namespacesOf(b)).toEqual(['nsA']);
    await a.shutdown();
    await b.shutdown();
  });

  it('①【红线·第一优先】屏蔽 → 订阅 → 仍被拒（不签发、吊销保持、读侧仍 []）', async () => {
    const hub = new InMemoryHub();
    const a = makeFacade('device-A', hub);
    const b = makeFacade('device-B', hub, { namespaces: ['nsA'] });
    await a.initialize();
    await b.initialize();
    await a.graph.createNode('fact', { text: 'a' }, [], { namespace: 'nsA' });
    // A 屏蔽 B（设备级吊销）
    await a.revokeDevice({ subject: 'device-B', note: 'block' });
    // B 订阅（自己签名的 membership 落图）→ 同步到 A
    await b.declareNamespaceMembership({ member: 'device-B', namespace: 'nsA' });
    await syncBetween(a, b);
    // A 守护评估 → 不得签发（红线）；吊销状态保持
    const evalRes = await a.evaluateAutoGrantsOnce();
    expect(evalRes?.issued).toEqual([]);
    const policyEvents = await a.eventLog.listEvents({ namespace: POLICY_NAMESPACE });
    expect(policyEvents.some((e) => e.type === NAMESPACE_GRANT_EVENT)).toBe(false);
    expect(await a.getRevokedDevices()).toContain('device-B');
    // 再同步 → B 仍拿不到数据（读侧 []）
    await syncBetween(a, b);
    expect(await namespacesOf(b)).toEqual([]);
    await a.shutdown();
    await b.shutdown();
  });

  it('③ 事件触发接线：enabled=true 时同步会话结束 → 去抖后自动签发（无需手调）', async () => {
    const hub = new InMemoryHub();
    const a = makeFacade('device-A', hub, { autoGrant: { enabled: true, intervalMs: 600_000 } }); // 隔离事件路径
    const b = makeFacade('device-B', hub, { namespaces: ['nsA'] });
    await a.initialize();
    await b.initialize();
    await b.declareNamespaceMembership({ member: 'device-B', namespace: 'nsA' });
    await syncBetween(a, b);
    await sleep(2600); // 事件去抖 2s + 余量
    const policyEvents = await a.eventLog.listEvents({ namespace: POLICY_NAMESPACE });
    expect(policyEvents.some((e) => e.type === NAMESPACE_GRANT_EVENT)).toBe(true);
    await a.shutdown();
    await b.shutdown();
  });

  it('⑥ kill-switch：enabled=false → 守护不评估（默认拒绝不变）', async () => {
    const hub = new InMemoryHub();
    const a = makeFacade('device-A', hub, { autoGrant: { enabled: false } });
    const b = makeFacade('device-B', hub, { namespaces: ['nsA'] });
    await a.initialize();
    await b.initialize();
    await b.declareNamespaceMembership({ member: 'device-B', namespace: 'nsA' });
    await syncBetween(a, b);
    await sleep(2600); // 等过事件去抖窗口：不得有任何自动签发
    const policyEvents = await a.eventLog.listEvents({ namespace: POLICY_NAMESPACE });
    expect(policyEvents.some((e) => e.type === NAMESPACE_GRANT_EVENT)).toBe(false);
    expect(await namespacesOf(b)).toEqual([]);
    await a.shutdown();
    await b.shutdown();
  });
});
