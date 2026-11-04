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
import {
  OUTBOX_REPLAY_LEASE_MS,
  type BoundedOutbox,
  type OutboxItem,
  type OutboxReplayCompletion,
} from './local-layer.js';

const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 60_000;
const REPLAY_LEASE_MARGIN_MS = 5_000;

export interface OutboxReplayerOptions {
  outbox: BoundedOutbox;
  client: CapabilityClient | null;
  intervalMs?: number;
  maxPerRun?: number;
  now?: () => number;
  onSummary?: (summary: OutboxReplaySummary) => void;
  /** 成功写回后的对象缓存/计数回填；返回 false 表示仍需重试（部分成功）。 */
  onSettled?: (item: OutboxItem, data: unknown) => void | boolean | Promise<void | boolean>;
  /** 一次 replay 尝试最终以 retry/dead 结束时通知；成功由 onSettled 自行收口。 */
  onComplete?: (item: OutboxItem, outcome: OutboxReplayCompletion) => void | Promise<void>;
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
  private readonly onSettled?: (item: OutboxItem, data: unknown) => void | boolean | Promise<void | boolean>;
  private readonly onComplete?: (item: OutboxItem, outcome: OutboxReplayCompletion) => void | Promise<void>;
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
    this.onComplete = options.onComplete;
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

  private leaseMs(): number {
    const timeoutMs = typeof (this.client as { timeoutMs?: unknown } | null)?.timeoutMs === 'number'
      ? (this.client as unknown as { timeoutMs: number }).timeoutMs
      : 0;
    return Math.max(OUTBOX_REPLAY_LEASE_MS, Math.max(0, timeoutMs) + REPLAY_LEASE_MARGIN_MS);
  }

  private async notifyComplete(id: string, outcome: OutboxReplayCompletion): Promise<void> {
    if (!this.onComplete || outcome === 'settled' || outcome === 'skipped') return;
    const item = await this.outbox.get(id) ?? await this.outbox.getDead(id);
    if (!item) return;
    await this.onComplete(item, outcome);
  }

  private async replayItem(item: OutboxItem): Promise<ItemOutcome> {
    const leaseMs = this.leaseMs();
    const lease = await this.outbox.acquireReplayLease(item.id, { now: this.now(), leaseMs });
    if (lease.state !== 'acquired') {
      if (lease.state === 'expired') {
        await this.notifyComplete(item.id, 'dead');
        return {
          outcome: 'dead',
          error: { code: 'retention_expired', message: 'outbox 操作已超过截止时间', at: this.now() },
        };
      }
      return { outcome: 'skipped' };
    }
    const leased = lease.item;
    const owner = leased.replayLeaseOwner;
    try {
      const envelope = await this.client!.post(leased.endpoint, leased.body, {
        idempotencyKey: leased.requestId,
        retries: 0,
      });
      // 响应已确认：把 lease 续到覆盖本地回读/详情写入阶段；owner 不符/已过期则拒绝。
      await this.outbox.renewReplayLease(leased.id, {
        owner,
        now: this.now(),
        leaseMs,
      });
      // 权威回读/必需项确认失败不能吞掉；交由同一 retry/dead/deadline 路径处理。
      const keepForRetry = (await this.onSettled?.(leased, envelope.data)) === false;
      if (keepForRetry) {
        const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(6, leased.attempts));
        const completion = await this.outbox.completeReplay(leased.id, {
          outcome: 'retry',
          owner,
          now: this.now(),
          error: 'partial_failure',
          retryDelayMs: delay,
        });
        await this.notifyComplete(leased.id, completion);
        return { outcome: completion === 'skipped' ? 'skipped' : completion };
      }
      // HTTP/capability 已确认且本地必需项对账完成；即使响应在 deadline 后到达，
      // 也只能按 committed 移除活动项，不能再由 cleanup 写成 dead。
      const completion = await this.outbox.completeReplay(leased.id, {
        outcome: 'settled',
        owner,
        now: this.now(),
      });
      await this.notifyComplete(leased.id, completion);
      if (completion === 'skipped') return { outcome: 'skipped' };
      return { outcome: 'settled', count: settledCount(envelope.data) };
    } catch (error) {
      const view = errorView(error, this.now());
      const canRetry = retryable(error);
      const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(6, leased.attempts));
      const completion = await this.outbox.completeReplay(leased.id, {
        outcome: canRetry ? 'retry' : 'dead',
        owner,
        now: this.now(),
        error: view.code,
        retryDelayMs: delay,
      });
      await this.notifyComplete(leased.id, completion);
      if (completion === 'retry') {
        return {
          outcome: 'retry',
          error: { ...view, code: view.code === 'internal' ? 'capability_unavailable' : view.code },
        };
      }
      if (completion === 'skipped') return { outcome: 'skipped' };
      return { outcome: 'dead', error: view };
    }
  }
}
