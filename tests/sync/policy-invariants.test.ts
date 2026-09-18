// 随机化不变量 harness（`derivePolicyState`）。
//
// 固定种子、可复现。对每组随机事件序列断言：
//  1) 排列不变性：同一批事件不同输入顺序 → authorized/revoked 完全一致
//  2) 幂等：重复推导结果相同
//  3) 结构不变量：authorized ∩ revoked = ∅；每个被授权设备至少是某条 grant 的主体
//  4) **扰动不变性（oracle-free，本 harness 的独立检查）**：
//     a) R-b on grants/device_revoke：删掉输出 `revoked` 里设备的**全部**记录后重跑，
//        `authorized`/`revoked` 必须不变；
//     b) R-b on revokes：删掉**被吊销签发者发出的 `namespace_revoke`** 后重跑，必须不变。
//     二者只用「输入记录 + 输出 revoked」，不读取实现内部变量，故为真正独立。
//
// 收敛性：`derivePolicyState` 是有界不动点。`converged=false` 时落入 fail-closed 回退：
// 不采纳任何 revoke（grant 撤销轴**偏宽松**，牺牲撤销及时性）且排除各轮出现过的吊销设备
// 及其闭包（设备吊销轴**保守**）。回退不是不动点，故扰动检查在**回退路径**上可能不成立；
// 本 harness 对收敛结果做严格不变性断言，对未收敛结果只记录残差并断言其上界。

import { describe, it, expect } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { derivePolicyState } from '../../src/sync/grantPolicy.js';

type Entries = Parameters<typeof derivePolicyState>[0];
type Entry = Entries[number];

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
const SCENARIOS = 300;

interface Scenario {
  entries: Entries;
  bootstrap: string[];
}

/** 生成一组随机策略事件（确定序：logical = 生成序；作者内 seq 单调） */
function buildScenario(rng: () => number): Scenario {
  const pick = <T>(arr: T[]): T => arr[Math.floor(rng() * arr.length)]!;
  const entries: Entries = [];
  const grantIds: string[] = [];
  let seq = 0;
  const push = (entry: Omit<Entry, 'seq' | 'logical'>) => {
    entries.push({ ...entry, seq: ++seq, logical: entries.length } as Entry);
  };
  const n = 6 + Math.floor(rng() * 10); // 6..15 条
  for (let i = 0; i < n; i++) {
    const author = pick(DEVICES);
    const roll = rng();
    if (roll < 0.4) {
      const grantId = randomUUID();
      grantIds.push(grantId);
      const namespaces = rng() < 0.3 ? [pick(NAMESPACES), pick(NAMESPACES)] : [pick(NAMESPACES)];
      push({ kind: 'grant', author, id: grantId, grant: { grantId, subject: pick(DEVICES), namespaces, issuedAt: i } });
    } else if (roll < 0.64) {
      push({
        kind: 'revoke',
        author,
        id: `rev-${i}`,
        revoke: { grantId: grantIds.length > 0 && rng() < 0.8 ? pick(grantIds) : randomUUID(), issuedAt: i },
      });
    } else if (roll < 0.82) {
      push({ kind: 'device', author, id: `dev-${i}`, device: { subject: pick(DEVICES), issuedAt: i } });
    } else if (roll < 0.92) {
      // C1：图上引导签发者声明
      push({ kind: 'issuer', author, id: `iss-${i}`, issuer: { subject: pick(DEVICES), issuedAt: i } });
    } else {
      // M1：成员资格（在册/注销）
      push({
        kind: 'membership',
        author,
        id: `mem-${i}`,
        membership: { member: pick(DEVICES), namespace: pick(NAMESPACES), active: rng() < 0.7, issuedAt: i },
      });
    }
  }
  // 注入互吊销/链式结构以提高未收敛（fail-closed）触发率
  if (rng() < 0.5) {
    const [a, b] = [pick(DEVICES), pick(DEVICES)];
    if (a !== b) {
      push({ kind: 'device', author: a, id: `cyc-a-${seq}`, device: { subject: b, issuedAt: n } });
      push({ kind: 'device', author: b, id: `cyc-b-${seq}`, device: { subject: a, issuedAt: n + 1 } });
    }
  }
  const bootstrap: string[] = DEVICES.filter(() => rng() < 0.35);
  if (bootstrap.length === 0) bootstrap.push(pick(DEVICES));
  return { entries, bootstrap };
}

function key(state: ReturnType<typeof derivePolicyState>): {
  authorized: Record<string, string[]>;
  revoked: string[];
  issuers: string[];
} {
  const authorized: Record<string, string[]> = {};
  for (const name of [...state.authorized.keys()].sort()) {
    authorized[name] = [...state.authorized.get(name)!].sort();
  }
  return { authorized, revoked: [...state.revoked].sort(), issuers: [...state.issuers].sort() };
}

/** dropDeclares 的授权是 actual 的子集（声明只可能增加签发者 → 只可能增加授权）。 */
function authorizedSubset(
  sub: ReturnType<typeof derivePolicyState>,
  full: ReturnType<typeof derivePolicyState>,
): boolean {
  for (const [subject, nss] of sub.authorized) {
    const superset = full.authorized.get(subject);
    if (!superset || !nss.every((ns) => superset.includes(ns))) return false;
  }
  for (const issuer of sub.issuers) if (!full.issuers.has(issuer)) return false;
  return true;
}

describe('derivePolicyState 随机化不变量（oracle-free 扰动检查）', () => {
  it('空输入 + 缺省选项：默认拒绝（无授权/无吊销）且收敛', () => {
    const state = derivePolicyState([]);
    expect(state.authorized.size).toBe(0);
    expect(state.revoked.size).toBe(0);
    expect(state.converged).toBe(true);
  });

  it(`${SCENARIOS} 组随机事件：排列不变 / 幂等 / 结构不变量 / 扰动不变（R-b）`, () => {
    const rng = mulberry32(0xc0ffee);
    let nonConverged = 0;
    let residualA = 0;
    let residualB = 0;
    let residualC = 0;
    let residualD = 0;
    let sample = '';

    for (let scenario = 0; scenario < SCENARIOS; scenario++) {
      const { entries, bootstrap } = buildScenario(rng);
      const options = { policyIssuers: bootstrap };

      const actual = derivePolicyState(entries, options);
      const actualKey = key(actual);
      if (!actual.converged) {
        nonConverged += 1;
        if (!sample) sample = JSON.stringify({ bootstrap, entries: entries.map((e) => `${e.kind[0]}:${e.author}`) });
      }

      // 1) 排列不变性（逆序 + 随机洗牌）
      expect(key(derivePolicyState([...entries].reverse(), options))).toEqual(actualKey);
      const shuffled = [...entries];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
      }
      expect(key(derivePolicyState(shuffled, options))).toEqual(actualKey);

      // 2) 幂等
      const again = derivePolicyState(entries, options);
      expect(key(again)).toEqual(actualKey);
      expect(again.converged).toBe(actual.converged);

      // 3) 结构不变量（独立于实现，直接从输入/输出即可验证）
      const grantedSubjects = new Set(entries.filter((e) => e.kind === 'grant' && e.grant).map((e) => e.grant!.subject));
      for (const name of actual.authorized.keys()) {
        if (actual.revoked.has(name)) throw new Error(`被吊销设备不应有授权 @scenario ${scenario}：${name}`);
        if (!grantedSubjects.has(name)) throw new Error(`授权设备必须曾是某条 grant 的主体 @scenario ${scenario}：${name}`);
      }
      // C1：生效引导集合 ⊆ 被声明主体 ∪ 配置 bootstrap
      const declaredSubjects = new Set(entries.filter((e) => e.kind === 'issuer' && e.issuer).map((e) => e.issuer!.subject));
      const configured = new Set(bootstrap);
      for (const issuer of actual.issuers) {
        if (!declaredSubjects.has(issuer) && !configured.has(issuer)) {
          throw new Error(`引导签发者必须来自图上声明或配置 @scenario ${scenario}：${issuer}`);
        }
      }
      // M1：成员 ∩ 吊销 = ∅；每个成员都曾是某条成员记录的主体
      const membershipSubjects = new Set(
        entries.filter((e) => e.kind === 'membership' && e.membership).map((e) => e.membership!.member),
      );
      for (const [ns, members] of actual.members) {
        for (const m of members) {
          if (actual.revoked.has(m)) throw new Error(`被吊销设备不应是成员 @scenario ${scenario}：${m}`);
          if (!membershipSubjects.has(m)) throw new Error(`成员必须曾是某条成员记录的主体 @scenario ${scenario}：${m}`);
        }
        if (!actual.membershipNamespaces.has(ns)) throw new Error(`有成员的分区必已启用成员资格 @scenario ${scenario}：${ns}`);
      }

      // 4) 扰动不变性（oracle-free，含未收敛场景）
      //    a) 删掉输出 revoked 里设备的全部记录
      const dropAuthors = derivePolicyState(entries.filter((e) => !actual.revoked.has(e.author)), options);
      //    b) 删掉被吊销签发者发出的 namespace_revoke
      const dropRevokes = derivePolicyState(
        entries.filter((e) => !(e.kind === 'revoke' && actual.revoked.has(e.author))),
        options,
      );
      //    c) C1 声明轴：删掉全部 policy_issuer_declare → 授权单调不增
      const dropDeclares = derivePolicyState(entries.filter((e) => e.kind !== 'issuer'), options);
      for (const [perturbed, name] of [
        [dropAuthors, 'a'] as const,
        [dropRevokes, 'b'] as const,
      ]) {
        const same = JSON.stringify(key(perturbed)) === JSON.stringify(actualKey);
        if (actual.converged && perturbed.converged) {
          // 两个不动点之间：严格不变（独立于实现内部）
          if (!same) throw new Error(`扰动 ${name} 改变了结果 @scenario ${scenario}`);
        } else if (!same) {
          // 回退路径（非不动点）：只记录残差，由 F-2 断言上界
          if (name === 'a') residualA += 1;
          else residualB += 1;
          // eslint-disable-next-line no-console
          console.log(
            `[residual] ${name} @scenario ${scenario} actualConverged=${actual.converged} perturbedConverged=${perturbed.converged} actual=${JSON.stringify(actualKey)} perturbed=${JSON.stringify(key(perturbed))}`,
          );
        }
      }

      //    c) 声明轴单调：删掉全部声明后授权只能不增（含 issuers 子集）。
      const monotone = authorizedSubset(dropDeclares, actual);
      if (actual.converged && dropDeclares.converged) {
        if (!monotone) throw new Error(`扰动 c（声明轴）违反单调性 @scenario ${scenario}`);
      } else if (!monotone) {
        residualC += 1;
        // eslint-disable-next-line no-console
        console.log(
          `[residual] c @scenario ${scenario} actualConverged=${actual.converged} perturbedConverged=${dropDeclares.converged} actual=${JSON.stringify(actualKey)} perturbed=${JSON.stringify(key(dropDeclares))}`,
        );
      }

      //    d) M1 成员轴独立：删掉全部成员记录后 authorized/revoked 必须不变，且成员集合清空。
      const dropMembership = derivePolicyState(entries.filter((e) => e.kind !== 'membership'), options);
      if (dropMembership.members.size !== 0 || dropMembership.membershipNamespaces.size !== 0) {
        throw new Error(`扰动 d：删除全部成员记录后成员集合应为空 @scenario ${scenario}`);
      }
      const independent = JSON.stringify(key(dropMembership)) === JSON.stringify(actualKey);
      if (actual.converged && dropMembership.converged) {
        if (!independent) throw new Error(`扰动 d（成员轴独立）改变了 authorized/revoked @scenario ${scenario}`);
      } else if (!independent) {
        residualD += 1;
        // eslint-disable-next-line no-console
        console.log(
          `[residual] d @scenario ${scenario} actualConverged=${actual.converged} perturbedConverged=${dropMembership.converged}`,
        );
      }
    }

    // eslint-disable-next-line no-console
    console.log(
      `[policy-invariants] scenarios=${SCENARIOS} nonConverged=${nonConverged} residualA=${residualA} residualB=${residualB} residualC=${residualC} residualD=${residualD}`,
    );

    // F-2：未收敛必须被真实探到（非空），但仍是少数，且扰动在回退路径的残差有界。
    expect(nonConverged).toBeGreaterThanOrEqual(1);
    expect(nonConverged).toBeLessThanOrEqual(Math.ceil(SCENARIOS * 0.05));
    expect(residualA).toBeLessThanOrEqual(Math.ceil(SCENARIOS * 0.02));
    expect(residualB).toBeLessThanOrEqual(Math.ceil(SCENARIOS * 0.02));
    expect(residualC).toBeLessThanOrEqual(Math.ceil(SCENARIOS * 0.02));
    expect(residualD).toBeLessThanOrEqual(Math.ceil(SCENARIOS * 0.02));
    if (nonConverged > 0) {
      // eslint-disable-next-line no-console
      console.log(`[policy-invariants] nonConverged sample=${sample}`);
    }
  }, 120000);
});
