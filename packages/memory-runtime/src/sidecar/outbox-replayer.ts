// Outbox 重放：capability 暂不可用时的有界重试。
//
// 规则（contract v2 §5.2、sidecar §6.5）：
// - 一项 = 一个 capability 写请求 + 幂等键；成功立即删除；
// - 启动时 + 定时重放；指数退避到上限，尊重永久失败（移动到 dead/）；
// - outbox 不是第二权威，不保存无限历史。
//
// 本模块不 import @mebular/core，不打开图/事件日志。

import { CapabilityClient, CapabilityClientError } from './capability-client.js';
import type { IngestErrorView, OutboxReplaySummary } from './ingest.js';
import type { BoundedOutbox, OutboxItem } from './local-layer.js';

const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 60_000;

export interface OutboxReplayerOptions {
  outbox: BoundedOutbox;
  client: CapabilityClient | null;
  intervalMs?: number;
  maxPerRun?: number;
  now?: () => number;
  onSummary?: (summary: OutboxReplaySummary) => void;
  /** 成功写回后的对象缓存/计数回填；失败不影响已提交的图写入。 */
  onSettled?: (item: OutboxItem, data: unknown) => void | Promise<void>;
}

interface ItemOutcome {
  outcome: 'settled' | 'retry' | 'dead' | 'skipped';
  count?: number;
  error?: IngestErrorView;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function errorView(error: unknown, at: number): IngestErrorView {
  if (error instanceof CapabilityClientError) {
    return { code: error.code, message: error.message, at };
  }
  return { code: 'internal', message: (error as Error)?.message ?? 'outbox 重放失败', at };
}

function retryable(error: unknown): boolean {
  if (error instanceof CapabilityClientError) {
    if (error.retryable) return true;
    // token 轮换后可能恢复；保留在 outbox 等待下一次重放。
    if (error.status === 401 || error.status === 0) return true;
    return error.status === 429 || error.status >= 500;
  }
  return true;
}

function settledCount(data: unknown): number {
  if (!isObject(data)) return 0;
  const results = Array.isArray(data.results) ? data.results : [];
  if (results.length === 0) {
    return typeof data.created === 'number' && Number.isFinite(data.created)
      ? Math.max(0, Math.floor(data.created))
      : 0;
  }
  return results.filter((result) => isObject(result)
    && (result.status === 'created' || result.status === 'duplicate')).length;
}

export class OutboxReplayer {
  readonly outbox: BoundedOutbox;
  readonly intervalMs: number;
  readonly maxPerRun: number;

  private readonly client: CapabilityClient | null;
  private readonly now: () => number;
  private readonly onSummary?: (summary: OutboxReplaySummary) => void;
  private readonly onSettled?: (item: OutboxItem, data: unknown) => void | Promise<void>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<OutboxReplaySummary> | null = null;

  constructor(options: OutboxReplayerOptions) {
    this.outbox = options.outbox;
    this.client = options.client;
    this.intervalMs = Math.max(100, Math.floor(options.intervalMs ?? 5000));
    this.maxPerRun = Math.max(1, Math.floor(options.maxPerRun ?? 20));
    this.now = options.now ?? Date.now;
    this.onSummary = options.onSummary;
    this.onSettled = options.onSettled;
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.replayOnce().catch(() => undefined);
    }, this.intervalMs);
    this.timer.unref?.();
  }

  /** 停止定时器；可选在退出前尝试一次有界 flush。 */
  async stop({ flushMs = 2000 }: { flushMs?: number } = {}): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (flushMs <= 0) return;
    const flush = this.replayOnce();
    await Promise.race([
      flush,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, flushMs);
        timer.unref?.();
      }),
    ]);
  }

  replayOnce(): Promise<OutboxReplaySummary> {
    if (this.inFlight) return this.inFlight;
    const run = this.replayUnlocked().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = run;
    return run;
  }

  private async replayUnlocked(): Promise<OutboxReplaySummary> {
    const errors: IngestErrorView[] = [];
    let settled = 0;
    let retried = 0;
    let dead = 0;

    if (!this.client) {
      const stats = await this.outbox.stats();
      return { settled, retried, dead, remaining: stats.items, errors };
    }

    const now = this.now();
    const items = (await this.outbox.list())
      .filter((item) => typeof item.nextAttemptAt !== 'number' || item.nextAttemptAt <= now)
      .slice(0, this.maxPerRun);
    for (const item of items) {
      const result = await this.replayItem(item);
      if (result.outcome === 'settled') {
        settled += result.count ?? 0;
      } else if (result.outcome === 'dead') {
        dead += 1;
      } else if (result.outcome === 'retry') {
        retried += 1;
      } else {
        continue;
      }
      if (result.error) errors.push(result.error);
    }

    const stats = await this.outbox.stats();
    const summary: OutboxReplaySummary = {
      settled,
      retried,
      dead,
      remaining: stats.items,
      errors,
    };
    this.onSummary?.(summary);
    return summary;
  }

  private async replayItem(item: OutboxItem): Promise<ItemOutcome> {
    try {
      const envelope = await this.client!.post(item.endpoint, item.body, {
        idempotencyKey: item.requestId,
        retries: 0,
      });
      try {
        await this.onSettled?.(item, envelope.data);
      } catch {
        // 回填缓存/计数失败不影响已提交的 capability 写入。
      }
      await this.outbox.remove(item.id);
      return { outcome: 'settled', count: settledCount(envelope.data) };
    } catch (error) {
      const view = errorView(error, this.now());
      if (retryable(error)) {
        const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(6, item.attempts));
        await this.outbox.recordAttempt(item.id, { error: view.code, retryDelayMs: delay });
        return {
          outcome: 'retry',
          error: { ...view, code: view.code === 'internal' ? 'capability_unavailable' : view.code },
        };
      }
      await this.outbox.deadLetter(item.id, view.code);
      return { outcome: 'dead', error: view };
    }
  }
}
