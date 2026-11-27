// 0.4.0 W5：介入 planner 的进程内独立队列。
//
// 契约（W0-A §6.5，冻结）：
// - 只包住 `planIntervention()` / host plan 校验；
//   不包 ingest、checkpoint、self、extraction、query plan。
// - concurrency=1、maxQueue=8、priority=high、drop-oldest；
// - 队列满时丢弃最旧的排队项并返回 `overflow`，调用方立即 heuristic；
// - 排队/执行超过绝对 deadline 时返回 `timeout`，不取消已经开始的调用；
// - 指标 queued/running/completed/timeout/overflow 只读暴露给 `/status.policy.planner`。

export const INTERVENTION_QUEUE_CONCURRENCY = 1;
export const INTERVENTION_QUEUE_MAX = 8;
export const INTERVENTION_QUEUE_PRIORITY = 'high' as const;

export interface InterventionPlannerQueueMetrics {
  /** 只读诊断；不是可调参数。 */
  concurrency: number;
  maxQueue: number;
  priority: typeof INTERVENTION_QUEUE_PRIORITY;
  queued: number;
  running: number;
  completed: number;
  timeout: number;
  overflow: number;
}

export type InterventionQueueResult<T> =
  | { status: 'completed'; value: T }
  | { status: 'timeout' }
  | { status: 'overflow' }
  | { status: 'failed'; error: unknown };

export interface InterventionQueueOptions {
  concurrency?: number;
  maxQueue?: number;
  now?: () => number;
}

interface QueueEntry {
  task: () => Promise<unknown>;
  deadlineAt?: number;
  /** 排队阶段必须在该时间前开始；缺省等于 deadlineAt。 */
  startBy?: number;
  resolve: (result: InterventionQueueResult<unknown>) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * 单进程优先级队列。没有跨进程/持久化语义；重启即清空。
 *
 * `enqueue()` 永不 reject：超时、丢弃和任务异常都归一成稳定状态，
 * 保证 `/context` 只会在 heuristic 与模型结果之间选择，不会因队列泄漏挂起。
 */
export class InterventionPlannerQueue {
  private readonly concurrency: number;
  private readonly maxQueue: number;
  private readonly now: () => number;
  private readonly pending: QueueEntry[] = [];
  private running = 0;
  private completed = 0;
  private timedOut = 0;
  private overflowed = 0;

  constructor(options: InterventionQueueOptions = {}) {
    this.concurrency = Math.max(1, Math.floor(options.concurrency ?? INTERVENTION_QUEUE_CONCURRENCY));
    this.maxQueue = Math.max(0, Math.floor(options.maxQueue ?? INTERVENTION_QUEUE_MAX));
    this.now = options.now ?? Date.now;
  }

  enqueue<T>(
    task: () => Promise<T>,
    options: { deadlineAt?: number; reserveMs?: number } = {},
  ): Promise<InterventionQueueResult<T>> {
    return new Promise<InterventionQueueResult<T>>((resolve) => {
      const startBy = options.deadlineAt === undefined
        ? undefined
        : options.deadlineAt - Math.max(0, options.reserveMs ?? 0);
      const entry: QueueEntry = {
        task: task as () => Promise<unknown>,
        ...(options.deadlineAt !== undefined ? { deadlineAt: options.deadlineAt } : {}),
        ...(startBy !== undefined ? { startBy } : {}),
        resolve: resolve as (result: InterventionQueueResult<unknown>) => void,
        timer: null,
      };
      entry.timer = this.armDeadline(entry, entry.startBy);
      // drop-oldest：队列已满时丢弃最旧的排队项，接受新请求。
      while (this.pending.length >= this.maxQueue && this.pending.length > 0) {
        const dropped = this.pending.shift();
        if (!dropped) break;
        this.clearTimer(dropped.timer);
        dropped.timer = null;
        this.overflowed += 1;
        dropped.resolve({ status: 'overflow' });
      }
      this.pending.push(entry);
      this.drain();
    });
  }

  metrics(): InterventionPlannerQueueMetrics {
    return {
      concurrency: this.concurrency,
      maxQueue: this.maxQueue,
      priority: INTERVENTION_QUEUE_PRIORITY,
      queued: this.pending.length,
      running: this.running,
      completed: this.completed,
      timeout: this.timedOut,
      overflow: this.overflowed,
    };
  }

  private drain(): void {
    while (this.running < this.concurrency && this.pending.length > 0) {
      const entry = this.pending.shift();
      if (!entry) return;
      this.clearTimer(entry.timer);
      entry.timer = null;
      if (this.expired(entry)) {
        this.timedOut += 1;
        entry.resolve({ status: 'timeout' });
        continue;
      }
      this.running += 1;
      void this.execute(entry);
    }
  }

  private async execute(entry: QueueEntry): Promise<void> {
    let settled = false;
    const settle = (result: InterventionQueueResult<unknown>): void => {
      if (settled) return;
      settled = true;
      entry.resolve(result);
    };
    const timer = this.armDeadline(entry, entry.deadlineAt, () => {
      this.timedOut += 1;
      settle({ status: 'timeout' });
    });
    try {
      const value = await entry.task();
      this.clearTimer(timer);
      this.completed += 1;
      settle({ status: 'completed', value });
    } catch (error) {
      this.clearTimer(timer);
      this.completed += 1;
      settle({ status: 'failed', error });
    } finally {
      this.running = Math.max(0, this.running - 1);
      this.drain();
    }
  }

  private armDeadline(
    entry: QueueEntry,
    timeoutAt: number | undefined,
    onExpire?: () => void,
  ): ReturnType<typeof setTimeout> | null {
    if (timeoutAt === undefined) return null;
    const remaining = timeoutAt - this.now();
    const timer = setTimeout(() => {
      if (onExpire) {
        onExpire();
        return;
      }
      const index = this.pending.indexOf(entry);
      if (index < 0) return;
      this.pending.splice(index, 1);
      this.timedOut += 1;
      entry.resolve({ status: 'timeout' });
    }, Math.max(0, remaining));
    (timer as unknown as { unref?: () => void }).unref?.();
    return timer;
  }

  private expired(entry: QueueEntry): boolean {
    return entry.startBy !== undefined && entry.startBy <= this.now();
  }

  private clearTimer(timer: ReturnType<typeof setTimeout> | null): void {
    if (timer) clearTimeout(timer);
  }
}
