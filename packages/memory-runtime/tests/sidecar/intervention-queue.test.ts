// 0.4.0 W5：介入 planner 独立队列。
// - concurrency=1、maxQueue=8、priority=high、drop-oldest；
// - 超时/溢出立即返回稳定状态，不取消底层调用；
// - 指标 queued/running/completed/timeout/overflow 只读。

import { describe, it, expect } from '@jest/globals';
import {
  INTERVENTION_QUEUE_CONCURRENCY,
  INTERVENTION_QUEUE_MAX,
  INTERVENTION_QUEUE_PRIORITY,
  InterventionPlannerQueue,
} from '../../src/sidecar/intervention-queue.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('InterventionPlannerQueue (W5)', () => {
  it('默认 concurrency=1、maxQueue=8、priority=high', () => {
    const queue = new InterventionPlannerQueue();
    expect(queue.metrics()).toMatchObject({
      concurrency: INTERVENTION_QUEUE_CONCURRENCY,
      maxQueue: INTERVENTION_QUEUE_MAX,
      priority: INTERVENTION_QUEUE_PRIORITY,
      queued: 0,
      running: 0,
      completed: 0,
      timeout: 0,
      overflow: 0,
    });
  });

  it('串行执行：第一个完成后才启动第二个', async () => {
    const queue = new InterventionPlannerQueue({ concurrency: 1, maxQueue: 8 });
    const gate = deferred<void>();
    const order: string[] = [];
    const first = queue.enqueue(async () => {
      order.push('first:start');
      await gate.promise;
      order.push('first:end');
      return 1;
    });
    const second = queue.enqueue(async () => {
      order.push('second:start');
      return 2;
    });
    await sleep(10);
    expect(order).toEqual(['first:start']);
    expect(queue.metrics()).toMatchObject({ queued: 1, running: 1 });
    gate.resolve();
    await expect(first).resolves.toEqual({ status: 'completed', value: 1 });
    await expect(second).resolves.toEqual({ status: 'completed', value: 2 });
    expect(order).toEqual(['first:start', 'first:end', 'second:start']);
    expect(queue.metrics()).toMatchObject({ queued: 0, running: 0, completed: 2 });
  });

  it('队列满时 drop-oldest：最旧排队项立即 overflow，新请求保留', async () => {
    const queue = new InterventionPlannerQueue({ concurrency: 1, maxQueue: 2 });
    const gate = deferred<void>();
    const running = queue.enqueue(async () => {
      await gate.promise;
      return 'running';
    });
    const oldest = queue.enqueue(async () => 'oldest');
    const newer = queue.enqueue(async () => 'newer');
    await sleep(5);
    const newest = queue.enqueue(async () => 'newest');

    await expect(oldest).resolves.toEqual({ status: 'overflow' });
    expect(queue.metrics()).toMatchObject({ queued: 2, running: 1, overflow: 1 });

    gate.resolve();
    await expect(running).resolves.toEqual({ status: 'completed', value: 'running' });
    await expect(newer).resolves.toEqual({ status: 'completed', value: 'newer' });
    await expect(newest).resolves.toEqual({ status: 'completed', value: 'newest' });
    expect(queue.metrics()).toMatchObject({
      queued: 0,
      running: 0,
      completed: 3,
      overflow: 1,
      timeout: 0,
    });
  });

  it('排队超过 deadline：返回 timeout，不启动任务', async () => {
    const queue = new InterventionPlannerQueue({ concurrency: 1, maxQueue: 4 });
    const gate = deferred<void>();
    const running = queue.enqueue(async () => {
      await gate.promise;
      return 'running';
    });
    let started = false;
    const expired = queue.enqueue(async () => {
      started = true;
      return 'expired';
    }, { deadlineAt: Date.now() + 20 });

    await expect(expired).resolves.toEqual({ status: 'timeout' });
    expect(started).toBe(false);
    expect(queue.metrics()).toMatchObject({ timeout: 1, completed: 0, queued: 0 });
    gate.resolve();
    await expect(running).resolves.toEqual({ status: 'completed', value: 'running' });
  });

  it('执行超过 deadline：返回 timeout，但底层调用不被取消', async () => {
    const queue = new InterventionPlannerQueue({ concurrency: 1, maxQueue: 2 });
    const gate = deferred<void>();
    let finished = false;
    const task = queue.enqueue(async () => {
      await gate.promise;
      finished = true;
      return 'late';
    }, { deadlineAt: Date.now() + 20 });

    await expect(task).resolves.toEqual({ status: 'timeout' });
    expect(finished).toBe(false);
    expect(queue.metrics()).toMatchObject({ timeout: 1, running: 1, completed: 0 });
    gate.resolve();
    await sleep(5);
    expect(finished).toBe(true);
    expect(queue.metrics()).toMatchObject({ timeout: 1, running: 0, completed: 1 });
  });

  it('任务异常归一为 failed，不挂起队列', async () => {
    const queue = new InterventionPlannerQueue({ concurrency: 1, maxQueue: 2 });
    const failed = queue.enqueue(async () => {
      throw new Error('boom');
    });
    const result = await failed;
    expect(result.status).toBe('failed');
    expect(queue.metrics()).toMatchObject({ completed: 1, running: 0 });
  });
});
