// 对端 namespace 授权策略（T2：供给端强制，默认拒绝）
//
// 定义「该对端被授权接收哪些 namespace」的接口。语义是**数据持有者执行的
// 强制边界**，不是订阅方礼让——计算 offer / 快照时据此裁剪。
//
// 默认拒绝：对端**必须**被显式授权才能收到任何分区；未列出 = 返回 `[]`。
// 「未声明 = 不过滤」的旧姿态已取消。该接缝为将来「授权来自图上的 grant
// 记忆」预留实现位：届时只需换一个 NamespaceGrantPolicy 实现，SyncManager
// 的裁剪链不变。注意：本期**不实现** grant-as-memory（见 PLAN 第 4 节）。

import { normalizeNamespaceList } from '../core/namespace.js';

export interface NamespaceGrantPolicy {
  /**
   * 返回该对端被授权接收的 namespace（白名单）：
   * - 未列出该对端 → `[]`（拒绝，默认拒绝）；
   * - `[]` → 明确不允许任何分区；
   * - 非空 → 白名单。
   * 不存在「未声明 = 不过滤」的返回值：授权必须显式。
   */
  getAuthorizedNamespaces(peerDeviceId: string): Promise<string[]>;

  /**
   * 可选（Phase 2 · E）：当前处于**吊销**状态的设备集合。
   * 实现应只采纳签发者可信的吊销记录；缺省（不实现）视为无吊销。
   */
  getRevokedDevices?(): Promise<ReadonlySet<string>>;
}

/** 配置驱动的实现：peerDeviceId → 允许的 namespace 列表；未列出 = 拒绝 */
export class ConfigNamespacePolicy implements NamespaceGrantPolicy {
  private readonly mapping: Record<string, string[]>;

  constructor(mapping: Record<string, string[]> = {}) {
    this.mapping = mapping;
  }

  async getAuthorizedNamespaces(peerDeviceId: string): Promise<string[]> {
    const entry = this.mapping[peerDeviceId];
    return entry === undefined ? [] : normalizeNamespaceList(entry);
  }
}

/**
 * 组合策略（Phase 2 · D）：把「图上授权」与「配置白名单」合成一份生效授权。
 *
 * 组合规则（PLAN 1.1.6，推荐语义）：
 * - **并集**：`生效授权(peer) = 图上 grant ∪ 配置白名单`——两者都是白名单，
 *   配置是 bootstrap 路径（设备还没拿到图上策略时也能工作）；
 * - **不放松默认拒绝**：两者都空 → `[]`；任何一方都不会把「未授权」变成
 *   「不限」（返回值恒为具体白名单，绝不为 null）；
 * - **吊销优先**：任一子策略判定该设备被吊销 → `[]`，配置白名单也不能绕过。
 */
export class CompositeNamespacePolicy implements NamespaceGrantPolicy {
  private readonly policies: NamespaceGrantPolicy[];

  constructor(policies: NamespaceGrantPolicy[]) {
    this.policies = policies;
  }

  async getRevokedDevices(): Promise<ReadonlySet<string>> {
    const revoked = new Set<string>();
    for (const policy of this.policies) {
      if (!policy.getRevokedDevices) continue;
      for (const device of await policy.getRevokedDevices()) revoked.add(device);
    }
    return revoked;
  }

  async getAuthorizedNamespaces(peerDeviceId: string): Promise<string[]> {
    // 吊销优先：被吊销设备在读侧一律 []（配置白名单不得绕过）
    if ((await this.getRevokedDevices()).has(peerDeviceId)) return [];
    const union = new Set<string>();
    for (const policy of this.policies) {
      for (const ns of await policy.getAuthorizedNamespaces(peerDeviceId)) union.add(ns);
    }
    return [...union];
  }
}
