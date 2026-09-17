// Fleet 本地配额（M1）：**每设备对自己发出的量本地记账**，超额本地拒绝或排队。
//
// 禁中心化：无注册服务、无全局账本、无跨端对账；不同设备的配额互不影响（见 DESIGN.md §4）。

/** 准入判定。 */
export type QuotaDecision = 'accepted' | 'queued' | 'rejected';

/** 每设备快照。 */
export interface QuotaSnapshot {
  device: string;
  used: number;
  queued: number;
  rejected: number;
}

/** 构造选项。 */
export interface LocalQuotaOptions {
  /** 每设备（对**自己发出**）的上限 */
  limitPerDevice: number;
  /** 超额策略：`queue` 进本地队列；`reject` 直接拒绝。默认 `queue`。 */
  onOverflow?: 'queue' | 'reject';
}

function assertAmount(amount: number): void {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error(`quota amount 必须为正整数：${amount}`);
  }
}

/** 每设备本地配额账本（确定性、纯本地）。 */
export class LocalQuota {
  private readonly limit: number;
  private readonly overflow: 'queue' | 'reject';
  private readonly usedMap = new Map<string, number>();
  private readonly queuedMap = new Map<string, number>();
  private readonly rejectedMap = new Map<string, number>();

  constructor(options: LocalQuotaOptions) {
    if (!Number.isInteger(options.limitPerDevice) || options.limitPerDevice <= 0) {
      throw new Error(`limitPerDevice 必须为正整数：${options.limitPerDevice}`);
    }
    this.limit = options.limitPerDevice;
    this.overflow = options.onOverflow ?? 'queue';
  }

  private static bump(map: Map<string, number>, key: string, amount: number): void {
    map.set(key, (map.get(key) ?? 0) + amount);
  }

  /** 请求发出 `amount` 单位：返回本机判定（`accepted` / `queued` / `rejected`）。 */
  decide(device: string, amount = 1): QuotaDecision {
    assertAmount(amount);
    const used = this.usedMap.get(device) ?? 0;
    if (used + amount <= this.limit) {
      LocalQuota.bump(this.usedMap, device, amount);
      return 'accepted';
    }
    if (this.overflow === 'reject') {
      LocalQuota.bump(this.rejectedMap, device, amount);
      return 'rejected';
    }
    LocalQuota.bump(this.queuedMap, device, amount);
    return 'queued';
  }

  /** 容量释放（如队列/在途被消费）：从 `used` 扣减（不为负）。 */
  release(device: string, amount = 1): void {
    assertAmount(amount);
    const used = this.usedMap.get(device) ?? 0;
    this.usedMap.set(device, Math.max(0, used - amount));
  }

  /**
   * 把本地队列里的量搬迁到 `used`（容量允许时）；返回搬迁成功的量。
   * 仅本地排队消化，无跨端协调。
   */
  drainQueue(device: string, capacity = this.limit): number {
    if (!Number.isInteger(capacity) || capacity < 0) throw new Error(`capacity 非法：${capacity}`);
    const queued = this.queuedMap.get(device) ?? 0;
    const used = this.usedMap.get(device) ?? 0;
    const room = Math.max(0, capacity - used);
    const moved = Math.min(queued, room);
    if (moved > 0) {
      this.queuedMap.set(device, queued - moved);
      this.usedMap.set(device, used + moved);
    }
    return moved;
  }

  used(device: string): number {
    return this.usedMap.get(device) ?? 0;
  }

  queued(device: string): number {
    return this.queuedMap.get(device) ?? 0;
  }

  rejected(device: string): number {
    return this.rejectedMap.get(device) ?? 0;
  }

  /** 每设备快照（按 device 字典序，确定性）。 */
  snapshot(): QuotaSnapshot[] {
    const devices = new Set<string>([...this.usedMap.keys(), ...this.queuedMap.keys(), ...this.rejectedMap.keys()]);
    return [...devices].sort().map((device) => ({
      device,
      used: this.usedMap.get(device) ?? 0,
      queued: this.queuedMap.get(device) ?? 0,
      rejected: this.rejectedMap.get(device) ?? 0,
    }));
  }
}
