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
import type { SecureChannel } from '../p2p/secure/SecureChannelImpl.js';
import { ErrorCodes, SyncError } from '../errors.js';

export type SyncDirection = 'push' | 'pull' | 'bidirectional';

/**
 * 初始同步快照（G4）：大图下用「物化状态 + 时钟」替代全量事件重放。
 * 仅用于**空时钟**的新对端；应用后时钟推进，后续走增量事件。
 *
 * 信任边界：快照只在已认证（用户证书验签）的对端会话上使用；
 * 接收方直接采纳物化节点/边（不再逐事件验签）——这是 fast-start 的
 * 明确取舍：换取初始同步不再重放全部事件流。事件历史不随快照转移。
 */
export interface SyncSnapshot {
  nodes: Node[];
  edges: Edge[];
  clock: Record<string, number>;
  /** 本快照覆盖的 namespace（裁剪后的组织维度标记；缺失视为 'default'） */
  namespaces?: string[];
}

export type SyncMessage =
  | {
      type: 'sync-hello';
      vectorClock: Record<string, number>;
      direction?: SyncDirection;
      /**
       * 本机订阅的 namespace（可选）：请求方声明「我只订阅这些分区」，
       * 供数据持有者裁剪 offer。未声明（旧版本）= 不过滤，行为保持现状。
       */
      namespaces?: string[];
    }
  | { type: 'sync-offer'; events: Event[]; snapshot?: SyncSnapshot }
  | { type: 'sync-ack'; appliedEventIds: string[] }
  | { type: 'sync-done'; finalVectorClock: Record<string, number> }
  | { type: 'sync-error'; message: string };

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
