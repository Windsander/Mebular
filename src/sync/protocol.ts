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
import type { SecureChannel } from '../p2p/secure/SecureChannelImpl.js';

export type SyncDirection = 'push' | 'pull' | 'bidirectional';

export type SyncMessage =
  | { type: 'sync-hello'; vectorClock: Record<string, number>; direction?: SyncDirection }
  | { type: 'sync-offer'; events: Event[] }
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

/** 协议辅助：从消息迭代器取下一条特定类型的消息，带超时与错误帧处理 */
export async function nextSyncMessage<T extends SyncMessage['type']>(
  iterator: AsyncIterator<SyncMessage>,
  expected: T,
  timeoutMs: number,
): Promise<Extract<SyncMessage, { type: T }>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      iterator.next(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Sync timeout waiting for ${expected}`)), timeoutMs);
      }),
    ]);
    if (result.done) {
      throw new Error(`Sync channel closed while waiting for ${expected}`);
    }
    const message = result.value;
    if (message.type === 'sync-error') {
      throw new Error(`Remote sync error: ${message.message}`);
    }
    if (message.type !== expected) {
      throw new Error(`Protocol violation: expected ${expected}, got ${message.type}`);
    }
    return message as Extract<SyncMessage, { type: T }>;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
