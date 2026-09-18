// 2b：退订交接（继任者全量 ack 门禁 + 本地彻底清理）。
//
// 锚点：① 覆盖足→清理成功且 `__policy__` 保留；② 覆盖不足→中止且数据原封不动 + 缺失明细；
// ③ force→成功且 forced:true；④ 中断→续跑完成且无 tombstone；⑤ 清理后成员闸门仍在；
// ⑥ oracle-free：清理不改变 `__policy__`（事件保留、签发者不变）；多端 B/C 数据不丢。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mebular } from '../../src/mebular.js';
import { IdentityManager } from '../../src/crypto/IdentityManager.js';
import { InMemoryHub } from '../../src/p2p/transport/InMemoryTransport.js';
import { POLICY_NAMESPACE, NAMESPACE_HANDOFF_EVENT } from '../../src/sync/grantPolicy.js';

describe('2b 退订交接', () => {
  let dir: string;
  let masterKeys: { userMasterKey: Uint8Array; userMasterPrivateKey: CryptoKey };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mebular-handoff-'));
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
  async function syncBetween(a: Mebular, b: Mebular): Promise<void> {
    const aSynced = new Promise((resolve) => a.sync.once('sync-completed', resolve));
    const bSynced = new Promise((resolve) => b.sync.once('sync-completed', resolve));
    await b.node!.connectToPeer(a.node!.peerId);
    await Promise.all([aSynced, bSynced]);
  }
  const nsEvents = async (m: Mebular): Promise<number> =>
    (await m.eventLog.listEvents({ namespace: 'nsA' })).length;
  const policyIds = async (m: Mebular): Promise<string[]> =>
    (await m.eventLog.listEvents({ namespace: POLICY_NAMESPACE })).map((e) => e.id).sort();

  /** A 三端：A 授权/成员 B、C；A 造 2 条 nsA 事件。 */
  async function setupABC(): Promise<{ hub: InMemoryHub; a: Mebular; b: Mebular; c: Mebular }> {
    const hub = new InMemoryHub();
    const a = makeFacade('device-A', hub, { peerNamespacePolicy: { 'device-B': ['nsA'], 'device-C': ['nsA'] } });
    const b = makeFacade('device-B', hub, { namespaces: ['nsA'] });
    const c = makeFacade('device-C', hub, { namespaces: ['nsA'] });
    await a.initialize();
    await b.initialize();
    await c.initialize();
    for (const m of ['device-A', 'device-B', 'device-C']) {
      await a.declareNamespaceMembership({ member: m, namespace: 'nsA' });
    }
    await a.graph.createNode('fact', { text: 'one' }, [], { namespace: 'nsA' });
    await a.graph.createNode('fact', { text: 'two' }, [], { namespace: 'nsA' });
    return { hub, a, b, c };
  }

  it('① 覆盖足→清理成功、数据消失、__policy__ 保留；B/C 数据不丢', async () => {
    const { a, b, c } = await setupABC();
    await syncBetween(a, b);
    await syncBetween(a, c);
    expect(await nsEvents(a)).toBe(2);
    const policyBefore = await policyIds(a);

    const plan = await a.planNamespaceHandoff({ namespace: 'nsA', successor: 'device-B' });
    expect(plan).toMatchObject({ ok: true, successorIsMember: true, pendingTotal: 0 });

    const result = await a.leaveNamespace({ namespace: 'nsA', successor: 'device-B' });
    expect(result.ok).toBe(true);
    expect(result.forced).toBe(false);
    expect(result.deleted?.events).toBe(2);

    // A：本分区数据彻底消失；只剩 __policy__（无 tombstone）
    const remaining = await a.eventLog.listEvents();
    expect(remaining.every((e) => e.namespace === POLICY_NAMESPACE)).toBe(true);
    expect(existsSync(join(dir, 'device-A.jsonl.handoff.json'))).toBe(false); // 意图已清除
    // __policy__ 保留：旧策略事件全在 + 新增 handoff
    const policyAfter = await policyIds(a);
    for (const id of policyBefore) expect(policyAfter).toContain(id);
    const handoffs = await a.eventLog.listEvents({ namespace: POLICY_NAMESPACE });
    expect(handoffs.some((e) => e.type === NAMESPACE_HANDOFF_EVENT)).toBe(true);

    // B/C 数据不丢（主旨：退订方本地清理，其他订阅者不能丢）
    expect((await b.graph.listNodes()).length).toBe(2);
    expect((await c.graph.listNodes()).length).toBe(2);

    await a.shutdown();
    await b.shutdown();
    await c.shutdown();
  });

  it('② 覆盖不足→中止且数据原封不动 + 报告缺失明细', async () => {
    const { a, b } = await setupABC();
    await syncBetween(a, b); // B 已覆盖
    await a.graph.createNode('fact', { text: 'three' }, [], { namespace: 'nsA' }); // 新增，B 未 ack
    const policyBefore = await policyIds(a);
    const nsBefore = await nsEvents(a);

    const plan = await a.planNamespaceHandoff({ namespace: 'nsA', successor: 'device-B' });
    expect(plan.ok).toBe(false);
    expect(plan.pendingTotal).toBe(1);
    expect(plan.pendingByAuthor).toEqual([{ author: 'device-A', count: 1 }]);

    const result = await a.leaveNamespace({ namespace: 'nsA', successor: 'device-B' });
    expect(result).toMatchObject({ ok: false, aborted: true, reason: 'successor-incomplete' });
    expect(result.missing).toEqual([{ author: 'device-A', count: 1 }]);
    // 原封不动：数据在、无 handoff、无意图
    expect(await nsEvents(a)).toBe(nsBefore);
    expect(await policyIds(a)).toEqual(policyBefore);
    expect(existsSync(join(dir, 'device-A.jsonl.handoff.json'))).toBe(false);

    await a.shutdown();
    await b.shutdown();
  });

  it('③ force→清理成功且交接记录 forced:true（如实记录缺失）', async () => {
    const { a, b } = await setupABC();
    await syncBetween(a, b);
    await a.graph.createNode('fact', { text: 'three' }, [], { namespace: 'nsA' }); // B 未 ack

    const result = await a.leaveNamespace({ namespace: 'nsA', successor: 'device-B', force: true });
    expect(result.ok).toBe(true);
    expect(result.forced).toBe(true);
    expect(await nsEvents(a)).toBe(0);
    const handoff = (await a.eventLog.listEvents({ namespace: POLICY_NAMESPACE })).find(
      (e) => e.type === NAMESPACE_HANDOFF_EVENT,
    );
    const rec = (handoff!.data as { handoff: { forced: boolean; pendingCount: number; missingAuthors?: string[] } }).handoff;
    expect(rec.forced).toBe(true);
    expect(rec.pendingCount).toBe(1);
    expect(rec.missingAuthors).toEqual(['device-A']);
    await a.shutdown();
    await b.shutdown();
  });

  it('④ 中断→续跑完成且无 tombstone', async () => {
    const { a, b } = await setupABC();
    await syncBetween(a, b);

    // 模拟删除中途崩溃：首个 deleteEvent 抛错（意图文件已写、部分数据可能已删）
    const spy = jest.spyOn(a.storage, 'deleteEvent').mockRejectedValueOnce(new Error('simulated crash'));
    await expect(a.leaveNamespace({ namespace: 'nsA', successor: 'device-B' })).rejects.toThrow('simulated crash');
    spy.mockRestore();
    expect(existsSync(join(dir, 'device-A.jsonl.handoff.json'))).toBe(true); // 意图留存
    // 无 tombstone：新增的都是 __policy__（含 handoff）
    expect((await a.eventLog.listEvents({ namespace: 'nsA' })).length).toBeGreaterThan(0);

    // 续跑
    const resumed = await a.leaveNamespace({ namespace: 'nsA', successor: 'device-B' });
    expect(resumed).toMatchObject({ ok: true, resumed: true });
    expect(await nsEvents(a)).toBe(0);
    expect(existsSync(join(dir, 'device-A.jsonl.handoff.json'))).toBe(false);
    // 全程无 tombstone：剩余事件均为 __policy__
    expect((await a.eventLog.listEvents()).every((e) => e.namespace === POLICY_NAMESPACE)).toBe(true);
    await a.shutdown();
    await b.shutdown();
  });

  it('⑤ 清理后成员闸门仍在（legacy-empty 不退化）+ 清理不改变签发者（oracle-free）', async () => {
    const { a, b } = await setupABC();
    await syncBetween(a, b);
    const issuersBefore = (await a.getPolicyIssuers()).sort();

    await a.leaveNamespace({ namespace: 'nsA', successor: 'device-B' });

    // 成员记录仍在 → 该分区仍「已启用成员资格」；A 已注销自己，B/C 仍在册
    const membership = await a.getNamespaceMembership('nsA');
    expect(membership.active).toBe(true);
    expect(membership.members).toContain('device-B');
    expect(membership.members).not.toContain('device-A'); // 退订 = 成员资格退出
    // 未授权的 device-D 仍不是成员（闸门不退化）
    expect(membership.members).not.toContain('device-D');
    // oracle-free：签发者集合不受清理影响
    expect((await a.getPolicyIssuers()).sort()).toEqual(issuersBefore);
    await a.shutdown();
    await b.shutdown();
  });

  it('保留分区保护：__policy__ 不可交接', async () => {
    const { a, b } = await setupABC();
    await expect(a.planNamespaceHandoff({ namespace: POLICY_NAMESPACE, successor: 'device-B' })).rejects.toThrow(/__policy__/);
    await expect(a.leaveNamespace({ namespace: POLICY_NAMESPACE, successor: 'device-B' })).rejects.toThrow(/__policy__/);
    await a.shutdown();
    await b.shutdown();
  });
});
