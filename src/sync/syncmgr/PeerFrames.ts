// 每连接单一消费者的帧路由（H · 双向 push）
//
// 背景：SecureChannel 的 `receive()` 是**单一队列**（多个 iterator 会互相抢帧），
// 因此一个连接同一时刻只允许一个读取者。常驻同步需要在没有会话时也能读取
// out-of-band 的 `sync-nudge`，会话时又要读取会话帧——两者必须共享同一个读取者。
//
// 本类持有唯一的底层 iterator：
// - 非 nudge 帧进入内部缓冲，供会话以 `reader()`（AsyncIterator<SyncMessage>）读取，
//   与 `nextSyncMessage` 完全兼容；
// - `sync-nudge` 在**空闲**时触发 onNudge；**会话进行中**直接丢弃（那一轮本就会同步）；
// - 非法 nudge 丢弃并回调 onInvalidNudge（不因此中止会话）；
// - 连接关闭时唤醒所有等待者并回调 onClosed。

import { assertValidNudge, type SyncMessage } from '../protocol.js';

export interface PeerFramesHandlers {
  /** 空闲时收到合法 nudge */
  onNudge: () => void;
  /** 收到非法 nudge（协议违例），供上层可观测/上报 */
  onInvalidNudge?: (error: unknown) => void;
  /** 底层连接关闭 */
  onClosed?: () => void;
}

export class PeerFrames {
  private readonly buffered: SyncMessage[] = [];
  private readonly waiters: Array<(result: IteratorResult<SyncMessage>) => void> = [];
  private closed = false;
  private sessionActive = false;
  private failure: Error | null = null;

  constructor(
    iterator: AsyncIterator<SyncMessage>,
    private readonly handlers: PeerFramesHandlers,
  ) {
    void this.pump(iterator);
  }

  private async pump(iterator: AsyncIterator<SyncMessage>): Promise<void> {
    try {
      for (;;) {
        const result = await iterator.next();
        if (result.done) break;
        const message = result.value;
        if (message.type === 'sync-nudge') {
          if (this.sessionActive) continue; // 会话进行中忽略
          try {
            assertValidNudge(message);
          } catch (error) {
            this.handlers.onInvalidNudge?.(error);
            continue;
          }
          this.handlers.onNudge();
          continue;
        }
        this.push(message);
      }
    } catch (error) {
      this.failure = error instanceof Error ? error : new Error(String(error));
    } finally {
      this.closed = true;
      for (const waiter of this.waiters.splice(0)) {
        waiter({ value: undefined as never, done: true });
      }
      this.handlers.onClosed?.();
    }
  }

  private push(message: SyncMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: message, done: false });
    else this.buffered.push(message);
  }

  /** 会话读取器：与 nextSyncMessage(iterator, ...) 兼容 */
  reader(): AsyncIterator<SyncMessage> {
    return { next: () => this.readerNext() };
  }

  private readerNext(): Promise<IteratorResult<SyncMessage>> {
    if (this.buffered.length > 0) {
      return Promise.resolve({ value: this.buffered.shift()!, done: false });
    }
    if (this.failure) return Promise.reject(this.failure);
    if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** 标记会话是否进行中（进行中时 nudge 被丢弃） */
  setSessionActive(active: boolean): void {
    this.sessionActive = active;
  }

  get isClosed(): boolean {
    return this.closed;
  }
}
