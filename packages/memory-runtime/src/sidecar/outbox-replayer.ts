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
import type { LifecycleGate } from './lifecycle-gate.js';
import { redactText } from './text.js';
import {
  OUTBOX_REPLAY_LEASE_MS,
  type BoundedOutbox,
  type OutboxFailureView,
  type OutboxItem,
  type OutboxReplayCompletion,
} from './local-layer.js';

const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 60_000;
const REPLAY_LEASE_MARGIN_MS = 5_000;
/** 租约冲突只能协作重试有限次；超过后必须显式 dead，不能永久占位。 */
const MAX_LEASE_CONFLICT_ATTEMPTS = 6;

const DIAGNOSTIC_DETAIL_KEYS = [
  'agentId',
  'threadId',
  'domain',
  'hostId',
  'until',
  'currentRevision',
  'expectedRevision',
  'operation',
  'phase',
] as const;

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
  /** 跨 WP 门闩：drain 后晚到的响应只能 skipped，不得写 outbox/staging/cache。 */
  lifecycle?: LifecycleGate | null;
}

interface ItemOutcome {
  outcome: 'settled' | 'retry' | 'dead' | 'skipped';
  count?: number;
  error?: ReplayErrorView;
}

/** 重放诊断在基础 IngestErrorView 上保留冲突字段；不写入正文。 */
interface ReplayErrorView extends IngestErrorView {
  status?: number;
  retryable?: boolean;
  disposition?: 'conflict' | 'retryable' | 'permanent' | 'ambiguous';
  stage?: string;
  details?: Record<string, string | number | boolean>;
  possibleCommit?: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function diagnosticDetails(value: unknown): Record<string, string | number | boolean> | undefined {
  if (!isObject(value)) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const key of DIAGNOSTIC_DETAIL_KEYS) {
    const entry = value[key];
    if (typeof entry === 'string') {
      const redacted = redactText(entry).text
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .slice(0, 128);
      if (redacted.length > 0) out[key] = redacted;
    } else if (typeof entry === 'number' && Number.isFinite(entry)) {
      out[key] = entry;
    } else if (typeof entry === 'boolean') {
      out[key] = entry;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function errorCodeOf(error: unknown): string {
  if (error instanceof CapabilityClientError) return error.code;
  return typeof (error as { code?: unknown })?.code === 'string'
    ? (error as { code: string }).code
    : 'internal';
}

function dispositionOf(code: string, status: number, retryableValue: boolean): ReplayErrorView['disposition'] {
  if (code === 'revision_mismatch' || code === 'checkpoint_lease_held'
    || code === 'idempotency_conflict' || code === 'mode_mismatch') return 'conflict';
  if (code === 'timeout' || code === 'network_error' || code === 'partial_failure') return 'ambiguous';
  if (retryableValue || status === 0 || status === 401 || status === 408 || status === 429 || status >= 500) {
    return 'retryable';
  }
  return 'permanent';
}

function errorView(error: unknown, at: number, stage = 'replay'): ReplayErrorView {
  if (error instanceof CapabilityClientError) {
    const details = diagnosticDetails(error.details);
    return {
      code: error.code,
      message: redactText(error.message).text.slice(0, 512),
      at,
      status: error.status,
      retryable: error.retryable,
      disposition: dispositionOf(error.code, error.status, error.retryable),
      stage,
      ...(details ? { details } : {}),
      ...(error.code === 'timeout' || error.code === 'network_error'
        ? { possibleCommit: true }
        : {}),
    };
  }
  const code = errorCodeOf(error);
  const status = typeof (error as { status?: unknown })?.status === 'number'
    ? (error as { status: number }).status
    : 0;
  const retryableValue = (error as { retryable?: unknown })?.retryable === true;
  const details = diagnosticDetails((error as { details?: unknown })?.details);
  return {
    code,
    message: redactText((error as Error)?.message ?? 'outbox 重放失败').text.slice(0, 512),
    at,
    ...(status > 0 ? { status } : {}),
    retryable: retryableValue,
    disposition: dispositionOf(code, status, retryableValue),
    stage,
    ...(details ? { details } : {}),
  };
}

function failureOf(view: ReplayErrorView): OutboxFailureView {
  return {
    code: view.code,
    message: view.message,
    at: view.at,
    ...(view.status !== undefined ? { status: view.status } : {}),
    ...(view.retryable !== undefined ? { retryable: view.retryable } : {}),
    ...(view.disposition ? { disposition: view.disposition } : {}),
    ...(view.stage ? { stage: view.stage } : {}),
    ...(view.details ? { details: view.details } : {}),
    ...(view.possibleCommit ? { possibleCommit: true } : {}),
  };
}

function retryable(error: unknown): boolean {
  if (error instanceof CapabilityClientError) {
    // queued replay 的 revision 冲突绝不自动 rebase 到新 revision；必须显式 dead。
    if (error.code === 'revision_mismatch' || error.code === 'idempotency_conflict') return false;
    // 租约冲突允许协作重试，但由 replayItem 的有限次数约束收口。
    if (error.code === 'checkpoint_lease_held') return true;
    if (error.retryable) return true;
    // token 轮换后可能恢复；保留在 outbox 等待下一次重放。
    if (error.status === 401 || error.status === 0) return true;
    return error.status === 429 || error.status >= 500;
  }
  return true;
}

function leaseConflictExhausted(view: ReplayErrorView, attempts: number, now: number): boolean {
  if (view.code !== 'checkpoint_lease_held') return false;
  if (attempts >= MAX_LEASE_CONFLICT_ATTEMPTS) return true;
  const until = typeof view.details?.until === 'number' ? view.details.until : null;
  // 租约已过期仍冲突，再给一次协作重试；之后不再无限等待。
  return until !== null && until <= now && attempts >= 2;
}

function revoked(error: unknown): boolean {
  return error instanceof CapabilityClientError
    && (error.code === 'capability_disabled' || error.code === 'mode_mismatch');
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
  private readonly lifecycle: LifecycleGate | null;
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
    this.lifecycle = options.lifecycle ?? null;
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
    const errors: ReplayErrorView[] = [];
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
          error: {
            code: 'retention_expired',
            message: 'outbox 操作已超过截止时间',
            at: this.now(),
            disposition: 'permanent',
            stage: 'replay',
          },
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
      // 响应在 drain 后才到达：capability 可能已提交，但本地不得再当作新提交，
      // 也不得续租/删除 pending；本次禁用必须保持 incomplete。
      if (this.lifecycle && !this.lifecycle.acceptsWork()) {
        this.lifecycle.noteAmbiguousSuccess('replay_late_success');
        return { outcome: 'skipped' };
      }
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
        const partialFailure: ReplayErrorView = {
          code: 'partial_failure',
          message: '部分写入未完成；可能已有对象提交，需要权威回读对账',
          at: this.now(),
          disposition: 'ambiguous',
          stage: 'settle',
          possibleCommit: true,
        };
        const completion = await this.outbox.completeReplay(leased.id, {
          outcome: 'retry',
          owner,
          now: this.now(),
          error: 'partial_failure',
          retryDelayMs: delay,
          failure: failureOf(partialFailure),
        });
        await this.notifyComplete(leased.id, completion);
        return { outcome: completion === 'skipped' ? 'skipped' : completion, error: partialFailure };
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
      if (revoked(error)) {
        // 撤销后晚到的失败/晚到的成功都不得改写 pending：不重试、不死信、不删除。
        return { outcome: 'skipped' };
      }
      if (this.lifecycle && !this.lifecycle.acceptsWork()) {
        // drain 后晚到的失败/超时同样只能 skipped：不 recordAttempt、不写 dead。
        return { outcome: 'skipped' };
      }
      const view = errorView(error, this.now(), 'replay');
      const conflictExhausted = leaseConflictExhausted(view, leased.attempts, this.now());
      const canRetry = !conflictExhausted
        && view.disposition !== 'permanent'
        && (error instanceof CapabilityClientError
          ? retryable(error)
          : view.retryable !== false && view.disposition !== 'conflict');
      const until = typeof view.details?.until === 'number' ? view.details.until : null;
      const leaseWait = view.code === 'checkpoint_lease_held' && until !== null
        ? Math.max(0, until - this.now() + 100)
        : 0;
      const delay = Math.min(
        RETRY_MAX_MS,
        Math.max(leaseWait, RETRY_BASE_MS * 2 ** Math.min(6, leased.attempts)),
      );
      const completion = await this.outbox.completeReplay(leased.id, {
        outcome: canRetry ? 'retry' : 'dead',
        owner,
        now: this.now(),
        error: view.code,
        retryDelayMs: delay,
        failure: failureOf(view),
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
