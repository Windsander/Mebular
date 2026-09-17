// H · 双向 push 的帧路由与 nudge 校验（PeerFrames）。
//
// 覆盖反向用例：nudge 风暴控制（会话中忽略 / 非法 nudge 拒绝）、读取路由、
// 连接关闭唤醒。

import { describe, it, expect } from '@jest/globals';
import { PeerFrames } from '../../src/sync/syncmgr/PeerFrames.js';
import { assertValidNudge, type SyncMessage } from '../../src/sync/protocol.js';

/** 可控的假 iterator：测试可推入消息、异步等待者 */
function fakeIterator(): {
  push: (message: SyncMessage) => void;
  close: () => void;
  iterator: AsyncIterator<SyncMessage>;
} {
  const queue: SyncMessage[] = [];
  const waiters: Array<(result: IteratorResult<SyncMessage>) => void> = [];
  return {
    push: (message) => {
      const waiter = waiters.shift();
      if (waiter) waiter({ value: message, done: false });
      else queue.push(message);
    },
    close: () => {
      for (const waiter of waiters.splice(0)) waiter({ value: undefined as never, done: true });
    },
    iterator: {
      next: () =>
        queue.length > 0
          ? Promise.resolve({ value: queue.shift()!, done: false })
          : new Promise((resolve) => waiters.push(resolve)),
    },
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('assertValidNudge', () => {
  it('无载荷的 nudge 通过；携带业务载荷 → 协议违例', () => {
    expect(() => assertValidNudge({ type: 'sync-nudge' })).not.toThrow();
    expect(() => assertValidNudge({ type: 'sync-nudge', events: [] } as never)).toThrow(/sync-nudge/);
    expect(() => assertValidNudge({ type: 'sync-nudge', note: 'x' } as never)).toThrow(/sync-nudge/);
  });
});

describe('PeerFrames', () => {
  it('空闲时收到 nudge → onNudge；非 nudge 帧进入 reader', async () => {
    const it0 = fakeIterator();
    let nudges = 0;
    const frames = new PeerFrames(it0.iterator, { onNudge: () => { nudges += 1; } });

    it0.push({ type: 'sync-nudge' });
    await tick();
    expect(nudges).toBe(1);

    const hello: SyncMessage = { type: 'sync-hello', subscribeAll: true, namespaces: [], namespaceClocks: {} };
    it0.push(hello);
    const reader = frames.reader();
    const first = await reader.next();
    expect(first).toEqual({ value: hello, done: false });
  });

  it('会话进行中收到的 nudge 被忽略（不风暴）', async () => {
    const it0 = fakeIterator();
    let nudges = 0;
    const frames = new PeerFrames(it0.iterator, { onNudge: () => { nudges += 1; } });

    frames.setSessionActive(true);
    it0.push({ type: 'sync-nudge' });
    it0.push({ type: 'sync-nudge' });
    await tick();
    expect(nudges).toBe(0);

    frames.setSessionActive(false);
    it0.push({ type: 'sync-nudge' });
    await tick();
    expect(nudges).toBe(1);
  });

  it('非法 nudge → onInvalidNudge，且不触发会话', async () => {
    const it0 = fakeIterator();
    let nudges = 0;
    const errors: unknown[] = [];
    new PeerFrames(it0.iterator, {
      onNudge: () => { nudges += 1; },
      onInvalidNudge: (error) => errors.push(error),
    });

    it0.push({ type: 'sync-nudge', events: [] } as never);
    await tick();
    expect(nudges).toBe(0);
    expect(errors).toHaveLength(1);
  });

  it('连接关闭：reader 结束、onClosed 回调', async () => {
    const it0 = fakeIterator();
    let closed = 0;
    const frames = new PeerFrames(it0.iterator, { onNudge: () => {}, onClosed: () => { closed += 1; } });

    const reader = frames.reader();
    it0.close();
    const result = await reader.next();
    expect(result.done).toBe(true);
    expect(frames.isClosed).toBe(true);
    expect(closed).toBe(1);
  });

  it('无等待者时非 nudge 帧进入缓冲，随后 reader 读取', async () => {
    const it0 = fakeIterator();
    const frames = new PeerFrames(it0.iterator, { onNudge: () => {} });

    const hello: SyncMessage = { type: 'sync-hello', subscribeAll: true, namespaces: [], namespaceClocks: {} };
    it0.push(hello);
    await tick(); // pump 先于 reader 处理 → 无等待者，进入缓冲

    const result = await frames.reader().next();
    expect(result).toEqual({ value: hello, done: false });
  });

  it('底层迭代器异常：reader 以 Error 拒绝，onClosed 仍回调一次', async () => {
    let rejectNext: ((error: unknown) => void) | null = null;
    const failing: AsyncIterator<SyncMessage> = {
      next: () => new Promise((_resolve, reject) => { rejectNext = reject; }),
    };
    let closed = 0;
    const frames = new PeerFrames(failing, { onNudge: () => {}, onClosed: () => { closed += 1; } });

    await tick();
    (rejectNext as ((error: unknown) => void) | null)?.(new Error('transport reset'));
    await tick();

    expect(frames.isClosed).toBe(true);
    expect(closed).toBe(1);
    await expect(frames.reader().next()).rejects.toThrow('transport reset');
  });

  it('非 Error 抛出值规范化为 Error；已关闭且无等待者时读取返回 done', async () => {
    let rejectNext: ((error: unknown) => void) | null = null;
    const failing: AsyncIterator<SyncMessage> = {
      next: () => new Promise((_resolve, reject) => { rejectNext = reject; }),
    };
    const frames = new PeerFrames(failing, { onNudge: () => {} });
    await tick();
    (rejectNext as ((error: unknown) => void) | null)?.('string failure');
    await tick();

    const rejection = await frames.reader().next().catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toContain('string failure');

    // 正常关闭后（无等待者/无缓冲）再次读取 → 立即 done
    const it0 = fakeIterator();
    const frames2 = new PeerFrames(it0.iterator, { onNudge: () => {} });
    it0.close();
    await tick();
    const result = await frames2.reader().next();
    expect(result.done).toBe(true);
  });
});
