// 每连接单一消费者的帧路由（H · 双向 push）
//
// 背景：SecureChannel 的 `receive()` 是**单一队列**（多个 iterator 会互相抢帧），
// 因此一个连接同一时刻只允许一个读取者。常驻同步需要在没有会话时也能读取
// out-of-band 的 `sync-nudge`，会话时又要读取会话帧——两者必须共享同一个读取者。
//
// 本类持有唯一的底层 iterator：
// - 非 nudge 帧进入内部缓冲，供会话以 `reader()`（AsyncIterator<SyncMessage>）读取，
//   与 `nextSyncMessage` 完全兼容；
// - `sync-nudge` 在**空闲**时触发 onNudge；**会话进行中**合并为一次「会话结束后补发」
//   （绝不能直接丢弃——见下）；
// - 非法 nudge 丢弃并回调 onInvalidNudge（不因此中止会话）；
// - 连接关闭时唤醒所有等待者并回调 onClosed。
//
// **会话中为什么必须补发（F-FLAKE-1 collab 1d-b 根因）**：nudge 是响应方唯一的
// 「我有新写入，请你来拉」信号。若会话开始后才到达（例如对端在本轮 offer 计算完
// 之后才 append），本轮会话不会包含该事件；此时直接丢弃 = 永久丢失唤醒——发起方
// 没有本地 pending 就不会再开会话，响应方也未必还有下一次写入 → 收敛停摆到超时。
// 合并（布尔）保证 nudge 风暴不会放大：一次会话最多补发一次。

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
  /** 会话进行中收到的合法 nudge 合并于此，会话结束（setSessionActive(false)）时补发一次 */
  private nudgePending = false;
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
          try {
            assertValidNudge(message);
          } catch (error) {
            this.handlers.onInvalidNudge?.(error);
            continue;
          }
          if (this.sessionActive) {
            // 会话中：本轮不处理，但**不能丢**——布尔合并成「结束后补发一次」。
            this.nudgePending = true;
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

  /**
   * 标记会话是否进行中。
   * 会话结束（true→false）时，若期间收到过 nudge，则**补发一次** onNudge：
   * 那些 nudge 描述的写入可能晚于本轮 offer 的快照，直接丢弃会造成永久丢唤醒。
   */
  setSessionActive(active: boolean): void {
    const wasActive = this.sessionActive;
    this.sessionActive = active;
    if (wasActive && !active && this.nudgePending && !this.closed) {
      this.nudgePending = false;
      this.handlers.onNudge();
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * 诊断/测试：会话进行中是否收到过待补发的 nudge（会话结束补发后清零）。
   * 用于确定性验证“nudge 确实在会话中抵达”，而不是事后才到。
   */
  get hasPendingNudge(): boolean {
    return this.nudgePending;
  }
}
