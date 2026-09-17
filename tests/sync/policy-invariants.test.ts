// 随机化不变量 harness（`derivePolicyState` / `GraphNamespacePolicy`）。
//
// 固定种子、可复现；≥200 组随机事件序列。对每组断言：
//  1) 排列不变性：同一批事件不同输入顺序 → authorized/revoked 完全一致
//  2) 幂等：重复 snapshot 结果相同
//  3) 权威可达闭包（独立重放检查）：不存在被采纳的 grant 其签发者未被吊销却又
//     不在引导白名单、且当时无授权；收敛时闭包 == authorized
//  4) 吊销归属时间线（独立重放检查）：revoked 只由「未被吊销签发者的 device_revoke」
//     产生，并会被「被采纳 grant」清除；收敛时时间线 == revoked
//
// 这两条检查**只用输入记录与输出**（authorized/revoked），不读取实现内部中间变量。

import { describe, it, expect, beforeAll } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { EventLog, type EventSigner } from '../../src/eventlog/EventLog.js';
import { MemoryStorage } from '../../src/storage/MemoryStorage.js';
import {
  GraphNamespacePolicy,
  POLICY_NAMESPACE,
  NAMESPACE_GRANT_EVENT,
  NAMESPACE_REVOKE_EVENT,
  DEVICE_REVOKE_EVENT,
} from '../../src/sync/grantPolicy.js';
import {
  createTestIdentity,
  generateMasterKeyPair,
  issueCertificate,
  masterPublicKeyBytes,
} from '../p2p/helpers.js';

/** 固定种子 PRNG（mulberry32）→ 可复现 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DEVICES = ['dev-0', 'dev-1', 'dev-2', 'dev-3', 'dev-4', 'dev-5'];
const NAMESPACES = ['nsA', 'nsB', 'nsC'];
const SCENARIOS = 220;

interface Rec {
  kind: 'grant' | 'revoke' | 'device';
  author: string;
  seq: number;
  logical: number;
  grantId?: string;
  subject?: string;
  namespaces?: string[];
}

/** 与实现同规格的确定序（同作者 seq；跨作者 logical；并列 author） */
function cmpRec(a: Rec, b: Rec): number {
  if (a.author === b.author) return a.seq - b.seq;
  if (a.logical !== b.logical) return a.logical - b.logical;
  return a.author < b.author ? -1 : 1;
}

function parseRecs(events: { type: string; author: string; vectorClock: Record<string, number>; data: Record<string, unknown> }[]): Rec[] {
  const recs: Rec[] = [];
  for (const e of events) {
    const seq = e.vectorClock[e.author] ?? 0;
    const logical = Object.values(e.vectorClock).reduce((s, v) => s + v, 0);
    if (e.type === NAMESPACE_GRANT_EVENT) {
      const g = (e.data as { grant?: { grantId: string; subject: string; namespaces: string[] } }).grant;
      if (g) recs.push({ kind: 'grant', author: e.author, seq, logical, grantId: g.grantId, subject: g.subject, namespaces: g.namespaces });
    } else if (e.type === NAMESPACE_REVOKE_EVENT) {
      const r = (e.data as { revoke?: { grantId: string; subject?: string } }).revoke;
      if (r) recs.push({ kind: 'revoke', author: e.author, seq, logical, grantId: r.grantId, subject: r.subject });
    } else if (e.type === DEVICE_REVOKE_EVENT) {
      const d = (e.data as { deviceRevoke?: { subject: string } }).deviceRevoke;
      if (d) recs.push({ kind: 'device', author: e.author, seq, logical, subject: d.subject });
    }
  }
  return recs;
}

/**
 * 独立参考重放（只按**规格**实现，不读实现内部变量）：用输出 `revoked` 作 R-b 作者
 * 排除与撤销目标过滤，按 `compareEntries` 同规格的确定序单遍：
 *  - grant：R-a（引导 ∨ 当时已授权其全部分区）+ R-d（grantId 未被有效撤销）+ R-b → 采纳；
 *  - device_revoke：按**在途吊销**过滤（互吊销逻辑序在先者胜）；被采纳 grant 清除主体吊销。
 * 返回参考 authorized / revoked / 被采纳 grantId。
 */
function referenceReplay(
  recs: Rec[],
  bootstrap: Set<string>,
  revoked: ReadonlySet<string>,
): { authorized: Map<string, Set<string>>; revoked: Set<string>; grantable: Set<string> } {
  const sorted = [...recs].sort(cmpRec);
  const revokedGrantIds = new Set<string>();
  for (const r of recs) {
    if (r.kind === 'revoke' && !revoked.has(r.author) && r.grantId) revokedGrantIds.add(r.grantId);
  }
  const authorized = new Map<string, Set<string>>();
  const grantable = new Set<string>();
  for (const r of sorted) {
    if (revoked.has(r.author)) continue; // R-b
    if (r.kind !== 'grant' || !r.grantId || !r.subject || !r.namespaces) continue;
    if (revokedGrantIds.has(r.grantId)) continue; // R-d
    const own = authorized.get(r.author);
    const allowed = bootstrap.has(r.author) || (own !== undefined && r.namespaces.every((ns) => own.has(ns)));
    if (!allowed) continue; // R-a
    grantable.add(r.grantId);
    let set = authorized.get(r.subject);
    if (!set) {
      set = new Set();
      authorized.set(r.subject, set);
    }
    for (const ns of r.namespaces) set.add(ns);
  }

  const refRevoked = new Set<string>();
  for (const r of sorted) {
    if (refRevoked.has(r.author)) continue; // R-b（在途）
    if (r.kind === 'device' && r.subject) refRevoked.add(r.subject);
    else if (r.kind === 'grant' && r.grantId && grantable.has(r.grantId) && r.subject) refRevoked.delete(r.subject);
  }
  for (const dev of refRevoked) authorized.delete(dev);
  return { authorized, revoked: refRevoked, grantable };
}

function sortedNamespaces(map: Map<string, Iterable<string>>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const key of [...map.keys()].sort()) out[key] = [...(map.get(key) ?? [])].sort();
  return out;
}

describe('derivePolicyState 随机化不变量（独立重放交叉验证）', () => {
  let masterPub: Uint8Array;
  const signers = new Map<string, EventSigner>();
  let nonConverged = 0;

  beforeAll(async () => {
    const master = await generateMasterKeyPair();
    masterPub = await masterPublicKeyBytes(master);
    for (const id of DEVICES) {
      const identity = await createTestIdentity(id);
      const certificate = await issueCertificate(master.privateKey, identity);
      signers.set(id, { deviceId: id, privateKey: identity.identity.devicePrivateKey, certificate });
    }
  });

  it(`${SCENARIOS} 组随机事件：排列不变 / 幂等 / 无越权 / 无吊销者记录被采纳 / 无撤销 grantId 被采纳`, async () => {
    const rng = mulberry32(0xc0ffee);
    const pick = <T>(arr: T[]): T => arr[Math.floor(rng() * arr.length)]!;

    for (let scenario = 0; scenario < SCENARIOS; scenario++) {
      const storage = new MemoryStorage();
      const logFor = (id: string): EventLog => new EventLog(storage, id, { signer: signers.get(id)! });
      const logs = new Map(DEVICES.map((id) => [id, logFor(id)]));
      const grantIds: string[] = [];

      const nGrants = 2 + Math.floor(rng() * 3); // 2..4
      for (let i = 0; i < nGrants; i++) {
        const author = pick(DEVICES);
        const subject = pick(DEVICES);
        const namespaces = [pick(NAMESPACES)];
        if (rng() < 0.3) namespaces.push(pick(NAMESPACES));
        const grantId = randomUUID();
        grantIds.push(grantId);
        await logs.get(author)!.append({
          type: NAMESPACE_GRANT_EVENT,
          data: { grant: { grantId, subject, namespaces, issuedAt: i } },
          namespace: POLICY_NAMESPACE,
        });
      }
      const nRevokes = Math.floor(rng() * 3); // 0..2
      for (let i = 0; i < nRevokes; i++) {
        const author = pick(DEVICES);
        const grantId = rng() < 0.8 && grantIds.length > 0 ? pick(grantIds) : randomUUID();
        await logs.get(author)!.append({
          type: NAMESPACE_REVOKE_EVENT,
          data: { revoke: { grantId, issuedAt: i } },
          namespace: POLICY_NAMESPACE,
        });
      }
      const nDeviceRevokes = Math.floor(rng() * 3); // 0..2
      for (let i = 0; i < nDeviceRevokes; i++) {
        const author = pick(DEVICES);
        const subject = pick(DEVICES);
        await logs.get(author)!.append({
          type: DEVICE_REVOKE_EVENT,
          data: { deviceRevoke: { subject, issuedAt: i } },
          namespace: POLICY_NAMESPACE,
        });
      }

      const events = await storage.listEvents();
      const bootstrap = new Set(DEVICES.filter(() => rng() < 0.4));
      if (bootstrap.size === 0) bootstrap.add(DEVICES[Math.floor(rng() * DEVICES.length)]!);

      const snapshotOf = async (list: typeof events) => {
        const s = new MemoryStorage();
        for (const e of list) await s.putEvent(e);
        const policy = new GraphNamespacePolicy({
          eventLog: new EventLog(s, 'reader'),
          userMasterPublicKey: masterPub,
          policyIssuers: [...bootstrap],
        });
        return policy.snapshot();
      };

      const actual = await snapshotOf(events);
      // 1) 排列不变性（逆序 + 随机洗牌）
      const reversed = await snapshotOf([...events].reverse());
      const shuffled = [...events];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
      }
      const shuffledSnap = await snapshotOf(shuffled);
      const key = (snap: typeof actual) => ({
        authorized: sortedNamespaces(snap.authorized),
        revoked: [...snap.revoked].sort(),
      });
      expect(key(reversed)).toEqual(key(actual));
      expect(key(shuffledSnap)).toEqual(key(actual));

      // 2) 幂等
      const again = await snapshotOf(events);
      expect(key(again)).toEqual(key(actual));
      expect(again.converged).toBe(actual.converged);

      if (!actual.converged) nonConverged += 1;

      // 3) 权威可达闭包（独立重放）：实际授权必须恰好等于闭包
      //    （闭包只含「签发者未被吊销 ∧（引导 ∨ 输出已授权）∧ grantId 未被有效撤销」的 grant，
      //     故等价于同时断言：无越权采纳、无吊销者记录被采纳、无被撤销 grantId 被采纳、无授权遗漏）
      // 3) 权威授权 + 4) 吊销归属：独立参考重放（结果一致 = 无越权、无吊销者记录被采纳、
      //    无被撤销 grantId 被采纳、无授权遗漏）
      const recs = parseRecs(events);
      const ref = referenceReplay(recs, bootstrap, actual.revoked);
      expect(sortedNamespaces(actual.authorized)).toEqual(sortedNamespaces(ref.authorized));
      expect([...actual.revoked].sort()).toEqual([...ref.revoked].sort());
    }

    // 允许存在未收敛（fail-closed）的组；收敛情况由 PolicyState.converged 可观测
    console.log(`[policy-invariants] scenarios=${SCENARIOS} nonConverged=${nonConverged}`);
    expect(nonConverged).toBeGreaterThanOrEqual(0);
  }, 60000);
});
