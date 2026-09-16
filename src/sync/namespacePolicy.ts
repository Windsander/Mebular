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
