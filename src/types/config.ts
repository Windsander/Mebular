// 配置类型

export interface Config {
  vectorClock?: VectorClockConfig;
  storage?: StorageConfig;
  encryption?: EncryptionConfig;
  sync?: SyncConfig;
}

export interface VectorClockConfig {
  initialClock?: Record<string, number>;
  clockId?: string;
}

export interface StorageConfig {
  type: 'memory' | 'persistent' | string;
  path?: string;
  memory?: boolean;
}

export interface EncryptionConfig {
  keyDerivationAlgorithm?: string;
  signatureAlgorithm?: string;
  encryptionAlgorithm?: string;
}

export interface SyncConfig {
  maxBatchSize?: number;
  batchTimeoutMs?: number;
  retryPolicy?: {
    maxRetries?: number;
    initialDelayMs?: number;
  };
  /**
   * 本机订阅的 namespace 集合：空数组 / 未配置 = 全部（保持现状语义）。
   * 只影响「组织维度」下的同步范围，不改变一致性模型。
   */
  namespaces?: string[];
  /**
   * 对端授权策略（配置驱动，**默认拒绝**）：peerDeviceId → 允许接收的
   * namespace 白名单。未列出的对端拿不到任何分区，必须显式写入才能同步；
   * 空数组 = 明确不允许。该接缝为将来「授权来自图上的 grant 记忆」预留
   * 实现位（本期不实现）。
   */
  peerNamespacePolicy?: Record<string, string[]>;
  /** 本地写入后向订阅对端即时推送（默认关闭，保持既有行为；常驻入口默认开启） */
  pushOnWrite?: boolean;
  /** push-on-write 节流窗口（ms，默认 50）：连续写入合并为一次推送/nudge */
  pushOnWriteThrottleMs?: number;
  /**
   * 周期 anti-entropy（C）：core/库默认关闭；常驻入口（serve/MCP）默认开启。
   * `intervalMs` 缺省 10 分钟（建议 5–15 分钟），`jitterRatio` 缺省 0.2（±20%）。
   */
  antiEntropy?: { enabled?: boolean; intervalMs?: number; jitterRatio?: number };
}
