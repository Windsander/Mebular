// 2c：重订阅恢复（显式降水位）。
// ① leave→rejoin→历史完整拉回；② 未授权重入→拉不到（显式失败）；③ 未 reset→对端不重发；
// ④ 重复 rejoin 幂等；⑤ 无 tombstone + __policy__ 保留；⑥ oracle-free（签发者不变）。
//
// 注：需要多次同步，而长连对端的重复 connect 不保证开新会话——故每个「阶段」用同一存储
// **重开**门面（持久化水位/事件/标记），确保每阶段都有一次真实会话。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mebular } from '../../src/mebular.js';
import { IdentityManager } from '../../src/crypto/IdentityManager.js';
import { InMemoryHub } from '../../src/p2p/transport/InMemoryTransport.js';
import { POLICY_NAMESPACE } from '../../src/sync/grantPolicy.js';

const A_SYNC = { namespaces: ['nsA'], peerNamespacePolicy: { 'device-B': ['nsA'], 'device-A': ['nsA'] } };
const B_SYNC = { namespaces: ['nsA'], peerNamespacePolicy: { 'device-A': ['nsA'] } };

describe('2c 重订阅恢复', () => {
  let dir: string;
  let masterKeys: { userMasterKey: Uint8Array; userMasterPrivateKey: CryptoKey };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mebular-rejoin-'));
    const master = await new IdentityManager().generateUserMasterKey();
    masterKeys = { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey };
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 });
  });

  const makeFacade = (deviceId: string, hub: InMemoryHub, sync: Record<string, unknown>): Mebular =>
    new Mebular({
      storagePath: join(dir, `${deviceId}.jsonl`),
      deviceId,
      encryption: masterKeys,
      network: { enabled: true, provider: hub },
      sync: { autoSync: true, ...sync },
    });

  async function openPair(hub: InMemoryHub): Promise<{ a: Mebular; b: Mebular }> {
    const a = makeFacade('device-A', hub, A_SYNC);
    const b = makeFacade('device-B', hub, B_SYNC);
    await a.initialize();
    await b.initialize();
    return { a, b };
  }
  async function syncBetween(a: Mebular, b: Mebular): Promise<void> {
    const aSynced = new Promise((resolve) => a.sync.once('sync-completed', resolve));
    const bSynced = new Promise((resolve) => b.sync.once('sync-completed', resolve));
    await b.node!.connectToPeer(a.node!.peerId);
    await Promise.all([aSynced, bSynced]);
  }
  const nsNodes = async (m: Mebular): Promise<string[]> =>
    (await m.graph.listNodes({ namespace: 'nsA' })).map((n) => n.id).sort();
  const policyIds = async (m: Mebular): Promise<string[]> =>
    (await m.eventLog.listEvents({ namespace: POLICY_NAMESPACE })).map((e) => e.id).sort();

  it('① leave→rejoin（reset）→ 历史完整拉回（与对端一致）', async () => {
    const hub = new InMemoryHub();
    let { a, b } = await openPair(hub);
    for (const m of ['device-A', 'device-B']) await a.declareNamespaceMembership({ member: m, namespace: 'nsA' });
    await a.graph.createNode('fact', { text: 'one' }, [], { namespace: 'nsA' });
    await a.graph.createNode('fact', { text: 'two' }, [], { namespace: 'nsA' });
    await syncBetween(a, b);
    expect(await nsNodes(b)).toEqual(await nsNodes(a));

    await a.leaveNamespace({ namespace: 'nsA', successor: 'device-B' });
    expect(await nsNodes(a)).toEqual([]);
    expect(await a.hasRejoinReset('nsA')).toBe(false);
    const rejoin = await a.rejoinNamespace({ namespace: 'nsA' });
    expect(rejoin).toMatchObject({ ok: true, reset: true, member: true, authorized: true });
    await a.shutdown();
    await b.shutdown();

    // 重开（同一存储）：A 的 reset 标记 → hello 空时钟 → B 向下修正并从 0 重发
    ({ a, b } = await openPair(hub));
    await syncBetween(a, b);
    expect(await nsNodes(a)).toEqual(await nsNodes(b));
    expect((await nsNodes(a)).length).toBe(2);
    await a.shutdown();
    await b.shutdown();
  });

  it('② 未授权重入 → 拉不到（显式失败 not-authorized）', async () => {
    const hub = new InMemoryHub();
    const a = makeFacade('device-A', hub, { peerNamespacePolicy: { 'device-B': ['nsA'] } });
    await a.initialize();
    const rejoin = await a.rejoinNamespace({ namespace: 'nsA' });
    expect(rejoin).toMatchObject({ ok: false, authorized: false, reason: 'not-authorized' });
    await a.shutdown();
  });

  it('③ 未 reset 的重入 → 对端不重发；reset 后才重发', async () => {
    const hub = new InMemoryHub();
    let { a, b } = await openPair(hub);
    // B 署名 2 条 → A 收下并 ack（推进 B 对 A 的水位）
    await b.graph.createNode('fact', { text: 'b1' }, [], { namespace: 'nsA' });
    await b.graph.createNode('fact', { text: 'b2' }, [], { namespace: 'nsA' });
    await syncBetween(a, b);
    expect((await nsNodes(a)).length).toBe(2);

    // A 清理 + 只重新声明成员（**不做 reset**）
    await a.declareNamespaceMembership({ member: 'device-A', namespace: 'nsA' });
    await a.declareNamespaceMembership({ member: 'device-B', namespace: 'nsA' });
    await a.leaveNamespace({ namespace: 'nsA', successor: 'device-B' });
    await a.declareNamespaceMembership({ member: 'device-A', namespace: 'nsA', active: true });
    await a.shutdown();
    await b.shutdown();

    ({ a, b } = await openPair(hub));
    await syncBetween(a, b);
    expect((await nsNodes(a)).length).toBe(0); // 对端未重发（水位仍在）
    await a.rejoinNamespace({ namespace: 'nsA' }); // 显式 reset
    await a.shutdown();
    await b.shutdown();

    ({ a, b } = await openPair(hub));
    await syncBetween(a, b);
    expect((await nsNodes(a)).length).toBe(2); // 现在才重发
    await a.shutdown();
    await b.shutdown();
  });

  it('④ 重复 rejoin 幂等；⑤ 无 tombstone + __policy__ 保留', async () => {
    const hub = new InMemoryHub();
    const { a, b } = await openPair(hub);
    for (const m of ['device-A', 'device-B']) await a.declareNamespaceMembership({ member: m, namespace: 'nsA' });
    await a.graph.createNode('fact', { text: 'x' }, [], { namespace: 'nsA' });
    await syncBetween(a, b);
    await a.leaveNamespace({ namespace: 'nsA', successor: 'device-B' });
    const policyBefore = await policyIds(a);

    expect((await a.rejoinNamespace({ namespace: 'nsA' })).ok).toBe(true);
    expect((await a.rejoinNamespace({ namespace: 'nsA' })).ok).toBe(true); // 幂等

    const policyAfter = await policyIds(a);
    for (const id of policyBefore) expect(policyAfter).toContain(id);
    const all = await a.eventLog.listEvents();
    expect(all.some((e) => /tombstone/i.test(e.type) && e.namespace !== POLICY_NAMESPACE)).toBe(false);
    await a.shutdown();
    await b.shutdown();
  });

  it('⑥ oracle-free：rejoin/reset 不改变签发者推导', async () => {
    const hub = new InMemoryHub();
    const { a, b } = await openPair(hub);
    for (const m of ['device-A', 'device-B']) await a.declareNamespaceMembership({ member: m, namespace: 'nsA' });
    await a.graph.createNode('fact', { text: 'x' }, [], { namespace: 'nsA' });
    await syncBetween(a, b);
    await a.leaveNamespace({ namespace: 'nsA', successor: 'device-B' });
    const issuersBefore = (await a.getPolicyIssuers()).sort();
    await a.rejoinNamespace({ namespace: 'nsA' });
    expect((await a.getPolicyIssuers()).sort()).toEqual(issuersBefore);
    await a.shutdown();
    await b.shutdown();
  });
});
