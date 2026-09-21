// C2 · relay 白名单/预约上限策略（纯函数；供 Libp2pProvider 组装 connectionGater 与 reservations）
//
// 机制在 core、策略在 app：core 只把「谁可以预约中转 / 谁可以被中转 / 预约上限」翻译成
// libp2p 的 ConnectionGater 谓词与 circuitRelay.reservations 选项；app 决定白名单与数值。

export interface RelayPolicyOptions {
  /** 允许预约本机中转的 peerId（缺省 = 全部允许，受上限约束） */
  allowedRelayPeers?: string[];
  /** 明确拒绝的 peerId（优先于 allow 列表） */
  deniedRelayPeers?: string[];
  /** 是否禁止出站经 circuit 连接（默认 false） */
  denyOutboundRelayedConnection?: boolean;
  /** 预约上限（默认 128；0 = 不限） */
  maxReservations?: number;
  /** 单次预约默认时长（ms；缺省交给 libp2p 默认） */
  reservationTtlMs?: number;
  /**
   * C6：动态「是否对外提供中转」谓词（守护内建 relay 角色：不可达时不提供）。
   * 缺省视为 true（静态白名单模式的旧行为）。
   */
  shouldServe?: () => boolean;
  /**
   * C6：动态按 peer 判定谓词（地址簿 paired/config 白名单）。
   * 提供时优先于静态 allowedRelayPeers/deniedRelayPeers。
   */
  isPeerAllowed?: (peerId: string) => boolean;
}

export interface RelayPolicy {
  /** libp2p connectionGater：入站预约是否拒绝 */
  denyInboundRelayReservation(peerId: { toString(): string }): boolean;
  /** libp2p connectionGater：出站经 circuit 的连接是否拒绝 */
  denyOutboundRelayedConnection(peerId: { toString(): string }): boolean;
  /** circuitRelay 服务 reservations 选项（直接传给 libp2p） */
  reservations: Record<string, unknown>;
  /** 判定是否为被拒 peer（诊断用） */
  isDenied(peerId: string): boolean;
  isAllowed(peerId: string): boolean;
}

/**
 * 由策略选项构造 relay gater + reservations。
 * 语义（默认拒绝边界清晰）：
 *  - denied 列表命中 → 拒绝（优先）；
 *  - allowed 列表非空且未命中 → 拒绝（白名单模式）；
 *  - allowed 为空 → 放行（开放模式，仍受 maxReservations 约束）。
 */
export function buildRelayPolicy(options: RelayPolicyOptions = {}): RelayPolicy {
  const denied = new Set(options.deniedRelayPeers ?? []);
  const allowed = new Set(options.allowedRelayPeers ?? []);
  const whitelistMode = allowed.size > 0;
  const isDenied = (peerId: string): boolean => denied.has(peerId);
  const isAllowed = (peerId: string): boolean => !isDenied(peerId) && (!whitelistMode || allowed.has(peerId));

  const reservations: Record<string, unknown> = {
    ...(options.maxReservations !== undefined ? { maxReservations: options.maxReservations } : {}),
    ...(options.reservationTtlMs !== undefined ? { defaultDurationLimit: options.reservationTtlMs } : {}),
  };

  return {
    denyInboundRelayReservation: (peerId) => {
      // C6：动态开关优先——不可达/未启用时一律拒绝预约（等价「不对外提供」）
      if (options.shouldServe && options.shouldServe() !== true) return true;
      if (options.isPeerAllowed) return options.isPeerAllowed(peerId.toString()) !== true;
      return !isAllowed(peerId.toString());
    },
    denyOutboundRelayedConnection: () => options.denyOutboundRelayedConnection === true,
    reservations,
    isDenied,
    isAllowed,
  };
}
