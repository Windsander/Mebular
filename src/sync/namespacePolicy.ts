// 对端 namespace 授权策略（T2：供给端强制）
//
// 定义「该对端被授权接收哪些 namespace」的接口。语义是**数据持有者执行的
// 强制边界**，不是订阅方礼让——计算 offer / 快照时据此裁剪。
//
// 本期用配置驱动实现；该接缝为将来「授权来自图上的 grant 记忆」预留实现位：
// 届时只需换一个 NamespaceGrantPolicy 实现，SyncManager 的裁剪链不变。
// 注意：本期**不实现** grant-as-memory（见 PLAN 第 2 节）。

export interface NamespaceGrantPolicy {
  /**
   * 返回该对端被授权接收的 namespace：
   * - `null`：未声明授权（旧配置 / 旧对端）→ 不过滤，保持现状；
   * - 数组：白名单（空数组 = 明确不允许任何分区）。
   */
  getAuthorizedNamespaces(peerDeviceId: string): Promise<string[] | null>;
}

/** 配置驱动的实现：peerDeviceId → 允许的 namespace 列表 */
export class ConfigNamespacePolicy implements NamespaceGrantPolicy {
  private readonly mapping: Record<string, string[]>;

  constructor(mapping: Record<string, string[]> = {}) {
    this.mapping = mapping;
  }

  async getAuthorizedNamespaces(peerDeviceId: string): Promise<string[] | null> {
    const entry = this.mapping[peerDeviceId];
    return entry === undefined ? null : [...entry];
  }
}
