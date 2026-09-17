// 同步线协议（phase-3-plan 3.2 / spec-003）
//
// 消息走 SecureChannel，JSON 帧，一帧一条消息。
// 会话的帧序固定（与方向无关，避免死锁）：
//
//   发起方          响应方
//     │  sync-hello   │   （各自携带本地向量时钟；发起方的 hello 带 direction）
//     │  sync-offer → │   发起方按响应方时钟计算的缺失集（pull 时为空）
//     │  ← sync-ack   │   响应方确认已应用的事件 ID
//     │  ← sync-offer │   响应方按发起方时钟计算的缺失集（push 时为空）
//     │  sync-ack →   │
//     │  sync-done →  │   各自携带最终向量时钟
//     │  ← sync-done  │
//
// 任一方发现验签失败或协议违例时发送 sync-error 并中止会话。

import type { Event } from '../types/event.js';
import type { Node, Edge } from '../types/index.js';
import type { NamespaceClocks } from '../core/namespace.js';
import type { SecureChannel } from '../p2p/secure/SecureChannelImpl.js';
import { ErrorCodes, SyncError } from '../errors.js';

export type SyncDirection = 'push' | 'pull' | 'bidirectional';

/**
 * 初始同步快照（G4）：大图下用「物化状态 + 水位」替代全量事件重放。
 * 仅用于**空分区水位**的新对端；应用后分区水位推进，后续走增量事件。
 *
 * 信任边界：快照只在已认证（用户证书验签）的对端会话上使用；
 * 接收方直接采纳物化节点/边（不再逐事件验签）——这是 fast-start 的
 * 明确取舍：换取初始同步不再重放全部事件流。事件历史不随快照转移。
 */
export interface SyncSnapshot {
  nodes: Node[];
  edges: Edge[];
  /**
   * 每个被允许分区的合并时钟（分区水位）：接收方据此推进自己的分区水位，
   * 使发送方不会因「快照未带事件」而重发已覆盖分区。**只含被允许的分区**，
   * 绝不用本机累积时钟把未发送的分区标记为已同步。
   */
  namespaceClocks: NamespaceClocks;
  /** 本快照覆盖的 namespace（裁剪后的组织维度标记） */
  namespaces: string[];
}

export type SyncMessage =
  | {
      type: 'sync-hello';
      direction?: SyncDirection;
      /**
       * 订阅声明（必填、无歧义）：
       * - `true` = 参与全部分区（含将来新增），此时 `namespaces` 被忽略；
       * - `false` = 只订阅 `namespaces` 中的显式清单（`[]` = 不订阅任何分区）。
       */
      subscribeAll: boolean;
      /** 显式订阅清单；subscribeAll=true 时忽略（但仍须为字符串数组） */
      namespaces: string[];
      /** 本机收到的每个分区的合并向量时钟（分区水位，供对端做缺失判定） */
      namespaceClocks: NamespaceClocks;
    }
  | { type: 'sync-offer'; events: Event[]; snapshot?: SyncSnapshot }
  | {
      type: 'sync-ack';
      appliedEventIds: string[];
      /**
       * 接收方**已应用**发送方本次 offer 中的快照（F4）。发送方据此才用快照的
       * 分区水位推进 `peerWatermarks`；缺失/false 一律不推进（禁止乐观推进）。
       */
      snapshotApplied?: boolean;
    }
  | { type: 'sync-done'; finalVectorClock: Record<string, number> }
  /**
   * 反向推送提示（H）：**无业务载荷**的「请现在发起一次会话」。由响应方角色
   * （不能自行发起会话的一方）在现有信道上发送；发起方收到后发起一次会话。
   * 会话进行中收到的 nudge 直接丢弃（那一轮本就会同步）。
   */
  | { type: 'sync-nudge' }
  | { type: 'sync-error'; message: string };

/** 分区水位形状的共享校验（hello 与快照同一套规则） */
function assertNamespaceClocksShape(
  clocks: unknown,
  label: string,
  violation: (detail: string) => never,
): void {
  if (clocks === null || typeof clocks !== 'object' || Array.isArray(clocks)) {
    violation(`${label} 必须为对象`);
  }
  for (const [ns, clock] of Object.entries(clocks as Record<string, unknown>)) {
    if (clock === null || typeof clock !== 'object' || Array.isArray(clock)) {
      violation(`${label}.${ns} 必须为对象`);
    }
    for (const [author, value] of Object.entries(clock as Record<string, unknown>)) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        violation(`${label}.${ns}.${author} 必须为非负有限数`);
      }
    }
  }
}

/**
 * 校验 hello 的订阅声明与分区水位：**必填且类型正确**，否则视为协议违例。
 * 缺失/类型错不再被解释为「不过滤」——配合默认拒绝，订阅声明必须无歧义。
 */
export function assertValidHello(hello: Extract<SyncMessage, { type: 'sync-hello' }>): void {
  const violation = (detail: string): never => {
    throw new SyncError(
      `Protocol violation: sync-hello ${detail}`,
      ErrorCodes.SYNC_PROTOCOL_VIOLATION,
    );
  };
  if (typeof hello.subscribeAll !== 'boolean') {
    violation('subscribeAll 必须为 boolean');
  }
  if (!Array.isArray(hello.namespaces) || hello.namespaces.some((ns) => typeof ns !== 'string')) {
    violation('namespaces 必须为字符串数组');
  }
  assertNamespaceClocksShape(hello.namespaceClocks, 'namespaceClocks', violation);
}

/**
 * 校验快照的实体列表与分区水位：**必填且类型正确**，否则视为协议违例。
 * 与 `assertValidHello` 同级；协议已声明这些字段必填，且无 legacy 对端，
 * 因此缺失/类型错宁可响亮失败，也不容忍半成品快照。
 */
export function assertValidSnapshot(snapshot: SyncSnapshot): void {
  const violation = (detail: string): never => {
    throw new SyncError(
      `Protocol violation: sync-offer snapshot ${detail}`,
      ErrorCodes.SYNC_PROTOCOL_VIOLATION,
    );
  };
  if (!Array.isArray(snapshot.nodes)) {
    violation('nodes 必须为数组');
  }
  if (!Array.isArray(snapshot.edges)) {
    violation('edges 必须为数组');
  }
  if (!Array.isArray(snapshot.namespaces) || snapshot.namespaces.some((ns) => typeof ns !== 'string')) {
    violation('namespaces 必须为字符串数组');
  }
  // 轻量元素级校验（R4）：每项须为含字符串 id 的对象——`applySnapshot` 会按
  // id 去重/比较，缺 id 的项无法安全应用。不做逐字段全验。
  snapshot.nodes.forEach((node, index) => {
    const record = node as { id?: unknown } | null;
    if (record === null || typeof record !== 'object' || typeof record.id !== 'string') {
      violation(`nodes[${index}] 必须为含字符串 id 的对象`);
    }
  });
  snapshot.edges.forEach((edge, index) => {
    const record = edge as { id?: unknown } | null;
    if (record === null || typeof record !== 'object' || typeof record.id !== 'string') {
      violation(`edges[${index}] 必须为含字符串 id 的对象`);
    }
  });
  assertNamespaceClocksShape(snapshot.namespaceClocks, 'namespaceClocks', violation);
}

/**
 * 校验 sync-nudge：**无业务载荷**，除 `type` 外出现任何字段即协议违例
 * （防止把 nudge 误用为数据通道）。与 hello/ack 同级严格。
 */
export function assertValidNudge(nudge: Extract<SyncMessage, { type: 'sync-nudge' }>): void {
  const extra = Object.keys(nudge).filter((key) => key !== 'type');
  if (extra.length > 0) {
    throw new SyncError(
      `Protocol violation: sync-nudge 不得携带业务载荷（${extra.join(', ')}）`,
      ErrorCodes.SYNC_PROTOCOL_VIOLATION,
    );
  }
}

/** 校验 sync-ack：`appliedEventIds` 必为字符串数组；`snapshotApplied` 若出现必为 boolean */
export function assertValidAck(ack: Extract<SyncMessage, { type: 'sync-ack' }>): void {
  const violation = (detail: string): never => {
    throw new SyncError(
      `Protocol violation: sync-ack ${detail}`,
      ErrorCodes.SYNC_PROTOCOL_VIOLATION,
    );
  };
  if (!Array.isArray(ack.appliedEventIds) || ack.appliedEventIds.some((id) => typeof id !== 'string')) {
    violation('appliedEventIds 必须为字符串数组');
  }
  if (ack.snapshotApplied !== undefined && typeof ack.snapshotApplied !== 'boolean') {
    violation('snapshotApplied 必须为 boolean');
  }
}

/** 同步消息的传输抽象：SecureChannel 之上的一层薄封装，便于测试替换 */
export interface SyncTransport {
  send(message: SyncMessage): Promise<void>;
  receive(): AsyncIterable<SyncMessage>;
  close(): Promise<void>;
}

/** 在加密信道上承载 JSON 帧的同步传输 */
export class SecureChannelSyncTransport implements SyncTransport {
  private channel: SecureChannel;

  constructor(channel: SecureChannel) {
    this.channel = channel;
  }

  async send(message: SyncMessage): Promise<void> {
    await this.channel.send(new TextEncoder().encode(JSON.stringify(message)));
  }

  async *receive(): AsyncIterable<SyncMessage> {
    for await (const frame of this.channel.receive()) {
      yield JSON.parse(new TextDecoder().decode(frame)) as SyncMessage;
    }
  }

  async close(): Promise<void> {
    await this.channel.close();
  }
}

/**
 * 协议辅助：从消息迭代器取下一条特定类型的消息，带超时与错误帧处理。
 * `timeoutMs` 省略时不设超时（供常驻会话监听等待首个 hello；连接关闭时
 * 迭代器自然结束并抛 SYNC_CONNECTION_FAILED，不会留下悬挂的 `.next()`）。
 */
export async function nextSyncMessage<T extends SyncMessage['type']>(
  iterator: AsyncIterator<SyncMessage>,
  expected: T,
  timeoutMs?: number,
): Promise<Extract<SyncMessage, { type: T }>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const next = iterator.next();
    const result = timeoutMs === undefined
      ? await next
      : await Promise.race([
          next,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Sync timeout waiting for ${expected}`)), timeoutMs);
          }),
        ]);
    if (result.done) {
      throw new SyncError(`Sync channel closed while waiting for ${expected}`, ErrorCodes.SYNC_CONNECTION_FAILED);
    }
    const message = result.value;
    if (message.type === 'sync-error') {
      throw new SyncError(`Remote sync error: ${message.message}`, ErrorCodes.SYNC_REMOTE_ERROR);
    }
    if (message.type !== expected) {
      throw new SyncError(`Protocol violation: expected ${expected}, got ${message.type}`, ErrorCodes.SYNC_PROTOCOL_VIOLATION);
    }
    return message as Extract<SyncMessage, { type: T }>;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
