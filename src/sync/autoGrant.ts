// 守护层自动签发（订阅驱动授权，产品拍板路径「守护按规则自动执行同一签发链路」的评估器）。
//
// 模型：进网=授权；订阅自主（权利+义务）；唯一否定=屏蔽。
// 本模块对「图上在册（订阅=成员资格，M1）∧ 未吊销 ∧ 无生效授权」的成员**幂等签发** grant——
// 与人工批准共用同一签发链路（`Mebular.grantNamespaces`），策略推导/不变量/存储/同步热路径
// 决策**一律不碰**（本模块是纯函数，只消费快照 + 回调）。
//
// 【红线】R-d 恢复语义：被采纳的 grant 会**清除其主体的吊销状态**（grantPolicy.ts R-d）。
// 故「未吊销」是规则链的**硬前置**：被吊销设备永不自动签发，且签发前对 subject 再查一次
// 吊销（`confirmNotRevoked`，把「读快照 → 落记录」之间的竞态窗口压到最小）。
// 恢复信任只走重新邀请兑换（applyJoinGrant 路径）。

import type { PolicyState } from './grantPolicy.js';

/** 评估器消费的快照视图（`PolicyState` 的结构子集，便于 hermetic 测试）。 */
export type AutoGrantSnapshot = Pick<PolicyState, 'authorized' | 'revoked' | 'issuers' | 'members'>;

export interface AutoGrantIssue {
  subject: string;
  namespace: string;
}

export interface AutoGrantSkipCounts {
  /** 本机（rejoin 准入语义本轮冻结，不为 self 自动签发） */
  self: number;
  /** 【红线】被吊销设备 */
  revoked: number;
  /** 已有生效 grant（幂等跳过） */
  alreadyAuthorized: number;
  /** 本机无该域签发资格（R-a 本地同规则预检：非 bootstrap 且未获授权） */
  issuerNotQualified: number;
}

export interface AutoGrantEvaluation {
  /** 候选（在册成员 × 域）总数 */
  candidates: number;
  issued: AutoGrantIssue[];
  skipped: AutoGrantSkipCounts;
}

export interface EvaluateAutoGrantsOptions {
  /** 策略快照（`GraphNamespacePolicy.snapshot()`；图上在册 ⇒ 已过 verifyIssuedByUser 信任链） */
  snapshot: AutoGrantSnapshot;
  /** 本机设备 ID（签发者） */
  self: string;
  /**
   * 【红线加固】签发前对 subject 再查一次（新鲜）吊销状态；返回 true = 未被吊销、可签。
   * 缺省不提供时只做快照内检查（测试可注入以固定竞态语义）。
   */
  confirmNotRevoked?: (subject: string) => Promise<boolean>;
  /** 既有签发链路（与人工批准同一函数）；每次调用签一个域。 */
  grant: (input: { subject: string; namespaces: string[]; note: string }) => Promise<unknown>;
  /** 审计标记（admin 视图可见/可过滤）；缺省 'auto-grant: subscription-driven' */
  note?: string;
}

/**
 * 单轮评估（纯函数、单发调用方负责单飞）。规则链（顺序即防线）：
 *   ① 对端可信 —— 图上在册 ⇒ 已过信任链（snapshot 只采纳链到用户主密钥的记录），天然满足；
 *   ②【红线】未吊销 —— snapshot.revoked 前置排除；签发前 confirmNotRevoked 再查一次；
 *   ③ 已声明订阅 —— 即「在册」（members 只含 active=true 最新记录；本函数只在成员集上迭代）；
 *   ④ 无生效 grant —— authorized 命中即跳过（幂等）；
 *   ⑤ 跳过本机 —— rejoin 准入语义本轮冻结（不含 self）；
 *   ⑥ 签发资格 —— R-a 本地同规则预检：self ∈ issuers（bootstrap）∨ self 已被授权该域；
 *      不满足则不签（不往图上写不会被采纳的死记录；采纳侧 fail-closed 兜底）。
 */
export async function evaluateAutoGrants(opts: EvaluateAutoGrantsOptions): Promise<AutoGrantEvaluation> {
  const { snapshot, self } = opts;
  const note = opts.note ?? 'auto-grant: subscription-driven';
  const result: AutoGrantEvaluation = {
    candidates: 0,
    issued: [],
    skipped: { self: 0, revoked: 0, alreadyAuthorized: 0, issuerNotQualified: 0 },
  };
  const selfAuthorized = snapshot.authorized.get(self) ?? [];
  for (const [namespace, members] of snapshot.members) {
    for (const member of members) {
      result.candidates += 1;
      if (member === self) {
        result.skipped.self += 1;
        continue;
      }
      if (snapshot.revoked.has(member)) {
        result.skipped.revoked += 1;
        continue;
      }
      const granted = snapshot.authorized.get(member) ?? [];
      if (granted.includes(namespace)) {
        result.skipped.alreadyAuthorized += 1;
        continue;
      }
      if (!snapshot.issuers.has(self) && !selfAuthorized.includes(namespace)) {
        result.skipped.issuerNotQualified += 1;
        continue;
      }
      // 红线加固：签发前再查一次（新鲜）吊销状态——若刚被吊销则放弃本次签发。
      if (opts.confirmNotRevoked !== undefined && !(await opts.confirmNotRevoked(member))) {
        result.skipped.revoked += 1;
        continue;
      }
      await opts.grant({ subject: member, namespaces: [namespace], note });
      result.issued.push({ subject: member, namespace });
    }
  }
  return result;
}
