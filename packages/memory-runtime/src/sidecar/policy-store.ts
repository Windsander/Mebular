// 本机记忆介入策略统计（0.4.0 Phase 4 基础）。
//
// 只保存可复用的聚合计数，不保存 query、正文、trace 或 token：
// - 固定 `<dataDir>/policy/state.json`，目录 0700、文件 0600；
// - 同目录临时文件 + fsync + rename 原子写；
// - write-behind：内存立即生效，250ms / 25 条批量落盘，stop 时 flush；
//   进程被强杀时最多丢失一个窗口的统计，不影响召回；
// - 进程内串行化，避免并发决策/结果互相覆盖；
// - 超过 TTL 的域统计丢弃；最多保留 maxDomains 个域；
// - 文件损坏时 fail-open 为空统计，绝不影响召回主流程。
//
// 统计按 (agentId, domain) 分桶。域样本 < 20 时向全局池化收缩；达到 20
// 后使用本域样本，并按 useless/missed 小幅调整下一轮阈值（±0.03，clamp）。
//
// W6：adaptive 只对 `planner=heuristic` 生效。model/shadow/off 的决策与 outcome
// 仍可写 trace，也可写入本文件的 `diagnostic` 计数，但绝不进入 `tuneEntry()`；
// 桶维度保持 (agentId, domain)，不增加 host/source。

import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { ensurePrivateDir, readJsonFile, writeJsonAtomic } from './atomic-json.js';
import type { InterventionAction, RecallOutcomeKind } from '../runtime/types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DOMAIN_MIN_SAMPLES = 20;
const DEFAULT_MAX_DOMAINS = 100;
const TUNE_EVERY_DECISIONS = 50;
const TUNE_INTERVAL_MS = 7 * DAY_MS;
const THRESHOLD_STEP = 0.03;
const THRESHOLD_MIN = 0.45;
const THRESHOLD_MAX = 0.80;
const USELESS_RATE_HIGH = 0.35;
const MISSED_RATE_HIGH = 0.20;
/** 写后（write-behind）：内存立即生效，最多延迟一个窗口落盘。 */
const FLUSH_DELAY_MS = 250;
const FLUSH_BATCH_SIZE = 25;

export interface PolicyCounts {
  spoken: number;
  silent: number;
  accepted: number;
  ignored: number;
  reasked: number;
  corrected: number;
  dismissed: number;
  missed: number;
  too_shallow: number;
  too_deep: number;
}

interface PolicyDomainEntry {
  agentId: string;
  domain: string;
  /** 参与 adaptive 调参的 heuristic 计数。 */
  counts: PolicyCounts;
  /** 非 heuristic（model/shadow/off）的诊断计数；不参与 tuneEntry。 */
  diagnostic: PolicyCounts;
  /** 相对 config.minConfidence 的调整量；只在样本足够后累积。 */
  thresholdOffset: number;
  updatedAt: number;
  tunedAt: number;
  decisionsSinceTune: number;
}

interface PolicyState {
  /** v2：W6 拆分 adaptive/diagnostic；旧 v1 计数可能混入 model/shadow，读取时整体 reset。 */
  version: 2;
  updatedAt: number;
  global: PolicyCounts;
  /** 非 heuristic 诊断计数；与 adaptive 分开，避免污染阈值学习。 */
  diagnostic: PolicyCounts;
  domains: Record<string, PolicyDomainEntry>;
}

export interface PolicyStoreOptions {
  path: string;
  ttlDays?: number;
  maxDomains?: number;
  now?: () => number;
}

export interface EffectivePolicyStats {
  /** 域样本数（spoken+silent）。 */
  domainSamples: number;
  samples: number;
  spoken: number;
  silent: number;
  accepted: number;
  ignored: number;
  reasked: number;
  corrected: number;
  dismissed: number;
  missed: number;
  too_shallow: number;
  too_deep: number;
  uselessRate: number;
  missedRate: number;
  acceptRate: number;
  /** domain：样本足够，直接用本域；global：向全局池化。 */
  source: 'domain' | 'global';
}

export interface PolicyDecisionInput {
  agentId: string;
  domain: string;
  action: InterventionAction;
  /**
   * 是否参与 adaptive 调参。缺省 true 保持旧调用语义；
   * model/shadow/off 必须显式传 false（只记 diagnostic）。
   */
  adaptive?: boolean;
}

export interface PolicyOutcomeInput {
  agentId: string;
  domain: string;
  kind: RecallOutcomeKind;
  /** 是否参与 adaptive 调参；缺省 true。 */
  adaptive?: boolean;
}

/** adaptive 阈值的读取结果；shadow 阶段可读取建议但不应用。 */
export interface AdaptiveThresholdResult {
  /** 实际用于本次决策的阈值。 */
  threshold: number;
  /** 若应用 adaptive offset 会得到的阈值。 */
  recommended: number;
  /** 本域累计 offset。 */
  offset: number;
  /** threshold 是否真的包含 adaptive offset。 */
  applied: boolean;
}

function emptyCounts(): PolicyCounts {
  return {
    spoken: 0,
    silent: 0,
    accepted: 0,
    ignored: 0,
    reasked: 0,
    corrected: 0,
    dismissed: 0,
    missed: 0,
    too_shallow: 0,
    too_deep: 0,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function counterOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function countsOf(value: unknown): PolicyCounts {
  const raw = isObject(value) ? value : {};
  return {
    spoken: counterOf(raw.spoken),
    silent: counterOf(raw.silent),
    accepted: counterOf(raw.accepted),
    ignored: counterOf(raw.ignored),
    reasked: counterOf(raw.reasked),
    corrected: counterOf(raw.corrected),
    dismissed: counterOf(raw.dismissed),
    missed: counterOf(raw.missed),
    too_shallow: counterOf(raw.too_shallow),
    too_deep: counterOf(raw.too_deep),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function domainKey(agentId: string, domain: string): string {
  return `${agentId}\u0000${domain}`;
}

function outcomeKey(kind: RecallOutcomeKind): keyof PolicyCounts {
  return kind;
}

function emptyState(now: number): PolicyState {
  return {
    version: 2,
    updatedAt: now,
    global: emptyCounts(),
    diagnostic: emptyCounts(),
    domains: {},
  };
}

/**
 * W6 canary 分桶：只由 (agentId, domain) 决定，不含 host/source。
 * 返回 [0, 1) 的稳定值；同一桶在重启、换宿主或换 source 后不变。
 */
export function adaptiveCanaryBucket(agentId: string, domain: string): number {
  const digest = createHash('sha256')
    .update(`${agentId}\u0000${domain}`, 'utf8')
    .digest();
  return digest.readUInt32BE(0) / 0x1_0000_0000;
}

/** canary 命中：bucket < ratio；ratio<=0 永不命中，ratio>=1 全量命中。 */
export function adaptiveCanaryHit(agentId: string, domain: string, ratio: number): boolean {
  if (!Number.isFinite(ratio) || ratio <= 0) return false;
  if (ratio >= 1) return true;
  return adaptiveCanaryBucket(agentId, domain) < ratio;
}

/**
 * 域样本 < 20 时把缺口按全局比例补齐；>= 20 时直接用域样本。
 * 这是 Beta/Laplace 平滑的确定性简化，不引入随机或模型。
 */
function effectiveOf(global: PolicyCounts, domain: PolicyCounts): EffectivePolicyStats {
  const domainSamples = domain.spoken + domain.silent;
  const globalSamples = global.spoken + global.silent;
  const source: EffectivePolicyStats['source'] = domainSamples >= DOMAIN_MIN_SAMPLES ? 'domain' : 'global';
  const deficit = source === 'domain' ? 0 : Math.max(0, DOMAIN_MIN_SAMPLES - domainSamples);
  // spoken 侧结果按 global.spoken 归一，silent 侧 missed 按 global.silent 归一；
  // 决策本身的先验仍按 globalSamples（spoken/silent 占比）。
  const globalRate = (key: keyof PolicyCounts): number => {
    if (key === 'spoken' || key === 'silent') {
      return globalSamples > 0 ? global[key] / globalSamples : 0;
    }
    if (key === 'missed') {
      return global.silent > 0 ? global[key] / global.silent : 0;
    }
    return global.spoken > 0 ? global[key] / global.spoken : 0;
  };
  const merged = (key: keyof PolicyCounts): number => (
    domain[key] + deficit * globalRate(key)
  );

  const spoken = merged('spoken');
  const silent = merged('silent');
  const useless = merged('reasked') + merged('corrected') + merged('dismissed');
  return {
    domainSamples,
    samples: spoken + silent,
    spoken,
    silent,
    accepted: merged('accepted'),
    ignored: merged('ignored'),
    reasked: merged('reasked'),
    corrected: merged('corrected'),
    dismissed: merged('dismissed'),
    missed: merged('missed'),
    too_shallow: merged('too_shallow'),
    too_deep: merged('too_deep'),
    uselessRate: spoken > 0 ? useless / spoken : 0,
    missedRate: silent > 0 ? merged('missed') / silent : 0,
    acceptRate: spoken > 0 ? merged('accepted') / spoken : 0,
    source,
  };
}

function entryOf(state: PolicyState, agentId: string, domain: string, now: number): PolicyDomainEntry {
  const key = domainKey(agentId, domain);
  const existing = state.domains[key];
  if (existing) return existing;
  const created: PolicyDomainEntry = {
    agentId,
    domain,
    counts: emptyCounts(),
    diagnostic: emptyCounts(),
    thresholdOffset: 0,
    updatedAt: now,
    tunedAt: now,
    decisionsSinceTune: 0,
  };
  state.domains[key] = created;
  return created;
}

export interface PolicyStoreErrorView {
  code: string;
  at: number;
}

/** 本机介入策略统计存储。所有读写都串行化，失败向上抛出由调用方 fail-open。 */
export class PolicyStore {
  readonly path: string;
  readonly ttlDays: number;
  readonly maxDomains: number;

  private readonly now: () => number;
  private state: PolicyState;
  private loaded = false;
  private tail: Promise<void> = Promise.resolve();
  private dirty = false;
  private pendingChanges = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelayMs = FLUSH_DELAY_MS;
  private closed = false;
  private degraded = false;
  private lastErrorState: PolicyStoreErrorView | null = null;

  constructor(options: PolicyStoreOptions) {
    this.path = options.path;
    this.ttlDays = Math.max(1, Math.floor(options.ttlDays ?? 30));
    this.maxDomains = Math.max(1, Math.floor(options.maxDomains ?? DEFAULT_MAX_DOMAINS));
    this.now = options.now ?? Date.now;
    this.state = emptyState(this.now());
  }

  async init(): Promise<void> {
    try {
      await ensurePrivateDir(dirname(this.path));
      await this.load();
    } catch (error) {
      this.markFailure(error);
      throw error;
    }
  }

  /** 只读：最近一次策略统计读写是否失败。 */
  get isDegraded(): boolean {
    return this.degraded;
  }

  /** 只读：最近一次失败；只保留稳定 code 与时间，不含路径/正文/token。 */
  get lastError(): PolicyStoreErrorView | null {
    return this.lastErrorState ? { ...this.lastErrorState } : null;
  }

  /** 读取状态；文件缺失/损坏时 fail-open 为空统计。 */
  async load(): Promise<void> {
    return this.exclusive(async () => {
      try {
        this.state = await this.readState();
        this.loaded = true;
        this.markHealthy();
      } catch (error) {
        this.markFailure(error);
        throw error;
      }
    });
  }

  async snapshot(): Promise<{
    version: 2;
    updatedAt: number;
    global: PolicyCounts;
    diagnostic: PolicyCounts;
    domains: Array<{
      agentId: string;
      domain: string;
      counts: PolicyCounts;
      diagnostic: PolicyCounts;
      thresholdOffset: number;
      updatedAt: number;
    }>;
  }> {
    return this.exclusive(async () => {
      await this.ensureLoaded();
      this.state = stateAfterTtl(this.state, this.now(), this.ttlDays);
      return {
        version: 2,
        updatedAt: this.state.updatedAt,
        global: { ...this.state.global },
        diagnostic: { ...this.state.diagnostic },
        domains: Object.values(this.state.domains).map((entry) => ({
          agentId: entry.agentId,
          domain: entry.domain,
          counts: { ...entry.counts },
          diagnostic: { ...entry.diagnostic },
          thresholdOffset: entry.thresholdOffset,
          updatedAt: entry.updatedAt,
        })),
      };
    });
  }

  async recordDecision({ agentId, domain, action, adaptive = true }: PolicyDecisionInput): Promise<void> {
    return this.exclusive(async () => {
      await this.ensureLoaded();
      const now = this.now();
      const state = stateAfterTtl(this.state, now, this.ttlDays);
      const key: keyof PolicyCounts = action === 'speak' ? 'spoken' : 'silent';
      const entry = entryOf(state, agentId, domain, now);
      if (adaptive) {
        // 只有 heuristic 决策进入 adaptive 计数，并驱动 50 次/每周调权。
        state.global[key] += 1;
        entry.counts[key] += 1;
        entry.decisionsSinceTune += 1;
        tuneEntry(state, entry, now);
      } else {
        // model/shadow/off：保留诊断计数，但不参与 tuneEntry。
        state.diagnostic[key] += 1;
        entry.diagnostic[key] += 1;
      }
      entry.updatedAt = now;
      state.updatedAt = now;
      this.state = trimDomains(state, this.maxDomains);
      this.markDirty();
    });
  }

  async recordOutcome({ agentId, domain, kind, adaptive = true }: PolicyOutcomeInput): Promise<void> {
    return this.exclusive(async () => {
      await this.ensureLoaded();
      const now = this.now();
      const state = stateAfterTtl(this.state, now, this.ttlDays);
      const key = outcomeKey(kind);
      const entry = entryOf(state, agentId, domain, now);
      if (adaptive) {
        state.global[key] += 1;
        entry.counts[key] += 1;
      } else {
        state.diagnostic[key] += 1;
        entry.diagnostic[key] += 1;
      }
      entry.updatedAt = now;
      state.updatedAt = now;
      this.state = trimDomains(state, this.maxDomains);
      this.markDirty();
    });
  }

  async effectiveStats(agentId: string, domain: string): Promise<EffectivePolicyStats> {
    return this.exclusive(async () => {
      await this.ensureLoaded();
      const state = stateAfterTtl(this.state, this.now(), this.ttlDays);
      const entry = state.domains[domainKey(agentId, domain)];
      return effectiveOf(state.global, entry?.counts ?? emptyCounts());
    });
  }

  /**
   * 本次决策使用的阈值：config.minConfidence + 本域自适应 offset，
   * clamp 到 [0.45, 0.80]，避免学成过度沉默或过度话痨。
   * W6：只有 heuristic 决策可以调用；model/shadow 不得读取。
   */
  async thresholdFor(agentId: string, domain: string, baseThreshold: number): Promise<number> {
    const result = await this.adaptiveThresholdFor(agentId, domain, baseThreshold, { apply: true });
    return result.threshold;
  }

  /**
   * W6：读取 adaptive 建议；`apply=false` 用于 shadow 阶段（只观察不生效）。
   * `recommended` 始终是 base+offset 的 clamp 值，便于 canary 对比。
   */
  async adaptiveThresholdFor(
    agentId: string,
    domain: string,
    baseThreshold: number,
    options: { apply: boolean },
  ): Promise<AdaptiveThresholdResult> {
    return this.exclusive(async () => {
      await this.ensureLoaded();
      const state = stateAfterTtl(this.state, this.now(), this.ttlDays);
      const entry = state.domains[domainKey(agentId, domain)];
      const base = Number.isFinite(baseThreshold) ? baseThreshold : 0.55;
      const offset = entry ? entry.thresholdOffset : 0;
      const recommended = clamp(base + offset, THRESHOLD_MIN, THRESHOLD_MAX);
      return {
        threshold: options.apply ? recommended : clamp(base, THRESHOLD_MIN, THRESHOLD_MAX),
        recommended,
        offset,
        applied: options.apply && offset !== 0,
      };
    });
  }

  /** 清空本机策略统计；返回删除的域条目数。reset 是显式运维动作，直接落盘。 */
  async reset(): Promise<number> {
    return this.exclusive(async () => {
      await this.ensureLoaded();
      const removed = Object.keys(this.state.domains).length;
      const now = this.now();
      this.state = emptyState(now);
      this.cancelFlush();
      this.dirty = false;
      this.pendingChanges = 0;
      try {
        await this.persist();
        this.markHealthy();
      } catch (error) {
        this.markFailure(error);
        throw error;
      }
      return removed;
    });
  }

  /** 立即把 write-behind 缓冲落盘；失败时保留 dirty，等待下次重试。 */
  async flush(): Promise<void> {
    return this.exclusive(async () => {
      this.cancelFlush();
      if (!this.dirty) return;
      try {
        await this.persist();
        this.dirty = false;
        this.pendingChanges = 0;
        this.retryDelayMs = FLUSH_DELAY_MS;
        this.markHealthy();
      } catch (error) {
        this.markFailure(error);
        throw error;
      }
    });
  }

  /** stop 时调用：停止定时器并做最后一次 flush。 */
  async close(): Promise<void> {
    this.closed = true;
    this.cancelFlush();
    await this.flush();
  }

  private markDirty(): void {
    this.dirty = true;
    this.pendingChanges += 1;
    if (this.closed) return;
    if (this.pendingChanges >= FLUSH_BATCH_SIZE) {
      this.scheduleFlush(0);
      return;
    }
    this.scheduleFlush(FLUSH_DELAY_MS);
  }

  private scheduleFlush(delayMs: number): void {
    if (this.flushTimer) {
      if (delayMs > 0) return;
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush().catch(() => {
        // 落盘失败不能影响召回；保留 dirty，按指数退避重试。
        if (this.closed) return;
        const delay = this.retryDelayMs;
        this.retryDelayMs = Math.min(30_000, this.retryDelayMs * 2);
        this.scheduleFlush(delay);
      });
    }, delayMs);
    this.flushTimer.unref?.();
  }

  private cancelFlush(): void {
    if (!this.flushTimer) return;
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation, operation);
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    try {
      this.state = await this.readState();
      this.loaded = true;
    } catch (error) {
      this.markFailure(error);
      throw error;
    }
  }

  private markHealthy(): void {
    this.degraded = false;
    this.lastErrorState = null;
  }

  private markFailure(error: unknown): void {
    this.degraded = true;
    const code = isObject(error) && typeof error.code === 'string' && error.code.length > 0
      ? error.code.slice(0, 64)
      : 'policy_storage_failed';
    this.lastErrorState = { code, at: this.now() };
  }

  private async readState(): Promise<PolicyState> {
    const raw = await readJsonFile<Record<string, unknown>>(this.path);
    // W6 迁移：v1 的 global 可能混入 model/shadow 决策，不能继续用于 adaptive；
    // 0.4.0 未发布，直接 reset 旧计数最安全。未知版本同样 fail-open 为空。
    if (!raw || raw.version !== 2) return emptyState(this.now());
    const state: PolicyState = {
      version: 2,
      updatedAt: counterOf(raw.updatedAt) || this.now(),
      global: countsOf(raw.global),
      diagnostic: countsOf(raw.diagnostic),
      domains: {},
    };
    const domains = isObject(raw.domains) ? raw.domains : {};
    for (const [key, value] of Object.entries(domains)) {
      if (!isObject(value)) continue;
      const agentId = typeof value.agentId === 'string' ? value.agentId : '';
      const domain = typeof value.domain === 'string' ? value.domain : '';
      if (agentId.length === 0 || domain.length === 0) continue;
      if (key !== domainKey(agentId, domain)) continue;
      state.domains[key] = {
        agentId,
        domain,
        counts: countsOf(value.counts),
        diagnostic: countsOf(value.diagnostic),
        thresholdOffset: clamp(
          typeof value.thresholdOffset === 'number' && Number.isFinite(value.thresholdOffset)
            ? value.thresholdOffset
            : 0,
          -0.3,
          0.3,
        ),
        updatedAt: counterOf(value.updatedAt) || this.now(),
        tunedAt: counterOf(value.tunedAt) || this.now(),
        decisionsSinceTune: counterOf(value.decisionsSinceTune),
      };
    }
    return stateAfterTtl(state, this.now(), this.ttlDays);
  }

  private async persist(): Promise<void> {
    await writeJsonAtomic(this.path, this.state);
  }
}

function stateAfterTtl(state: PolicyState, now: number, ttlDays: number): PolicyState {
  const cutoff = now - Math.max(1, ttlDays) * DAY_MS;
  const domains: Record<string, PolicyDomainEntry> = {};
  for (const [key, entry] of Object.entries(state.domains)) {
    if (entry.updatedAt >= cutoff) domains[key] = entry;
  }
  return { ...state, domains };
}

function trimDomains(state: PolicyState, maxDomains: number): PolicyState {
  const entries = Object.entries(state.domains);
  if (entries.length <= maxDomains) return state;
  entries.sort((a, b) => a[1].updatedAt - b[1].updatedAt || a[0].localeCompare(b[0]));
  const domains: Record<string, PolicyDomainEntry> = {};
  for (const [key, entry] of entries.slice(entries.length - maxDomains)) domains[key] = entry;
  return { ...state, domains };
}

/** 每 50 次决策或每周调一次；只有样本足够的域才单独调阈值。 */
function tuneEntry(state: PolicyState, entry: PolicyDomainEntry, now: number): void {
  const dueByCount = entry.decisionsSinceTune >= TUNE_EVERY_DECISIONS;
  const dueByTime = now - entry.tunedAt >= TUNE_INTERVAL_MS;
  if (!dueByCount && !dueByTime) return;
  const stats = effectiveOf(state.global, entry.counts);
  if (stats.source === 'domain') {
    if (stats.uselessRate > USELESS_RATE_HIGH) {
      entry.thresholdOffset = roundOffset(entry.thresholdOffset + THRESHOLD_STEP);
    }
    if (stats.missedRate > MISSED_RATE_HIGH) {
      entry.thresholdOffset = roundOffset(entry.thresholdOffset - THRESHOLD_STEP);
    }
  }
  entry.tunedAt = now;
  entry.decisionsSinceTune = 0;
}

/** offset 只保留 4 位，避免 ±0.03 浮点漂移污染 trace/持久化。 */
function roundOffset(value: number): number {
  return Number(clamp(value, -0.3, 0.3).toFixed(4));
}
