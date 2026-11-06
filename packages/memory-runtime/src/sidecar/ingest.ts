// 记忆沉降：ingest → 本地 staging（非权威）→ 候选 → capability `/write`
// → capability `/detail` → 忆云。
//
// 0.3 范围：
// - 请求/chunk/candidate 校验与大小/数量限制；
// - requestId / Idempotency-Key 幂等；chunk 内容 hash 与 (threadId,messageId) 去重；
// - 沉浸式总是按域采集：chunk 先写 `<home>/memory-runtime/staging`，成功沉降后删除；
// - 宿主候选直接写；无候选时确定性 heuristic；全非法 422；
// - 域路由与 provenance；禁止跨 Agent 写入；
// - 记录写入成功后按目标 domain 写 DetailRecord；同一文本多域按域复制；
// - 详情写入失败进有界 outbox；staging 只保留到 TTL；没有可链接记录时不写详情；
// - capability 暂不可用时记录进 outbox，成功即删；不做第二权威。
//
// 不实现 checkpoint 读取；不 import @mebular/core，不打开 GraphStore/EventLog，
// 所有持久记忆与详情只经 capability client 写入。

import { randomUUID } from 'node:crypto';
import {
  CapabilityClient,
  CapabilityClientError,
  type CapabilityDetailRecord,
  type CapabilityDetailWriteItem,
} from './capability-client.js';
import type { SidecarConfig } from './config.js';
import {
  agentDomain,
  isValidAgentId,
  isValidThreadId,
  normalizeDomain,
  type SidecarPolicy,
} from './domains.js';
import {
  canonicalJson,
  clientItemIdFor,
  normalizeCandidate,
  routeCandidate,
  sha256Hex,
  toWriteItem,
  validateCandidates,
  type CandidateInput,
  type CapabilityWriteItem,
  type RoutedCandidate,
} from './candidates.js';
import { SidecarSettlementError } from './errors.js';
import { heuristicCandidates } from './heuristic.js';
import type { LifecycleGate } from './lifecycle-gate.js';
import {
  LocalLayerError,
  type OutboxCommitted,
  type OutboxFinalizeMarker,
  type OutboxItem,
  type OutboxReplayCompletion,
  type SidecarLocalLayer,
} from './local-layer.js';
import type {
  InferenceExtractionResult,
  InferenceSourceSelection,
  SidecarInferenceProvider,
} from './inference-provider.js';
import { redactText } from './text.js';
import type {
  DetailRetentionClass,
  RawChunk,
  RuntimeDetailKind,
} from '../runtime/types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
export const MAX_INGEST_CHUNKS = 100;
export const MAX_DETAIL_ITEMS_PER_WRITE = 100;
/** 与 core `MAX_DETAIL_RECORD_IDS` 一致；超限显式失败，绝不截断。 */
export const MAX_DETAIL_RECORD_IDS = 200;
export const IDEMPOTENCY_TTL_MS = DAY_MS;
export const EXTRACTION_TTL_MS = DAY_MS;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{1,200}$/;
const EXTRACTION_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const RAW_CHUNK_ID_RE = /^rc_[A-Za-z0-9]{8,}$/;
const ROLES = ['user', 'assistant', 'system', 'tool'] as const;
const MIMES = ['text/plain', 'text/markdown', 'application/json'] as const;
const EXTRACTORS = ['auto', 'heuristic', 'local', 'host', 'api'] as const;
const DETAIL_KINDS = ['raw_chunk', 'message', 'tool_output', 'document_slice'] as const;
const SENSITIVE_FIELD_RE = /^(?:authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password|passwd|credential|private[-_]?key)$/i;
const SAFE_REDACTION_RULE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const DETAIL_RETENTION_DAYS: Record<Exclude<DetailRetentionClass, 'pinned'>, number> = {
  conversation: 30,
  tool_output: 7,
  document_slice: 90,
};

export type IngestExtractor = (typeof EXTRACTORS)[number];
export type IngestExtractorKind = 'heuristic' | 'local' | 'api' | 'host';

export interface IngestChunkInput {
  id?: string;
  role?: (typeof ROLES)[number];
  detailKind?: RuntimeDetailKind;
  /** pinned 只能走 user/system 治理；普通 ingest 不允许借此延长保留。 */
  retentionClass?: DetailRetentionClass;
  text: string;
  mime?: (typeof MIMES)[number];
  at?: number;
  messageId?: string;
  turn?: number;
  chunkIndex?: number;
  contentHash?: string;
  redaction?: { applied: boolean; rules: string[] };
  expiresAt?: number;
}

export interface IngestRequest {
  requestId?: string;
  agentId: string;
  agentName?: string;
  /** 旧适配器兼容别名；只能与顶层 agentId 一致。 */
  actor?: { type?: string; agentId?: string };
  threadId?: string;
  domain?: string;
  /** @deprecated 不再控制行为；出现时只记 legacy_capture_ignored。 */
  capture?: unknown;
  extractor?: IngestExtractor;
  allowRemote?: boolean;
  chunks?: IngestChunkInput[];
  candidates?: unknown[];
  [key: string]: unknown;
}

export interface IngestRecordView {
  id: string;
  /** 内部证据映射键；不是 Detail ID，也不是前向图引用。 */
  clientItemId?: string;
  type?: string;
  kind: string;
  domain: string;
  status?: string;
  duplicate?: boolean;
  /** 本次写入替代的旧事实 id（记录级修正）。 */
  superseded?: string[];
}

export interface IngestDetailView {
  /** 成功写入/复用的 DetailRecord id。 */
  ids: string[];
  written: number;
  duplicates: number;
  /** 已进入 outbox 等待重试的详情条数。 */
  queued: number;
  failed: number;
}

export interface IngestExtractionView {
  id: string;
  status: 'pending' | 'completed' | 'failed';
  extractor: IngestExtractorKind;
  model?: string;
  records: IngestRecordView[];
  detailIds: string[];
  warnings: string[];
  degraded: boolean;
  expiresAt?: number;
}

export interface IngestResult {
  accepted: { chunks: number; records: number };
  /** 本地 staging chunk id；不是权威，只用于排障。 */
  stagingChunkIds: string[];
  /** @deprecated 兼容别名；等于 stagingChunkIds。 */
  rawChunkIds: string[];
  /** 已确认写入的 DetailRecord id。 */
  detailIds: string[];
  detail: IngestDetailView;
  records: IngestRecordView[];
  extraction: IngestExtractionView;
  queued: boolean;
  duplicate: boolean;
  degraded: boolean;
  warnings: string[];
}

export interface IngestHttpResult {
  status: 200 | 202;
  data: IngestResult;
  warnings: string[];
  degraded: boolean;
}

export interface IngestExtractionResult {
  extraction: IngestExtractionView;
  queued: boolean;
  degraded: boolean;
  warnings: string[];
}

export interface IngestErrorView {
  code: string;
  message: string;
  at: number;
}

export interface IngestStatsSnapshot {
  ingested: number;
  settled: number;
  failed: number;
  queued: number;
  degraded: boolean;
  lastError: IngestErrorView | null;
  finalizePending: number;
  finalizeExhausted: number;
}

export interface OutboxReplaySummary {
  settled: number;
  retried: number;
  dead: number;
  remaining: number;
  errors: IngestErrorView[];
}

export interface IngestServiceOptions {
  config: SidecarConfig;
  local: SidecarLocalLayer;
  client: CapabilityClient | null;
  identity: {
    cloudId: string | null;
    profileId: string | null;
    hostId: string | null;
    userId?: string | null;
  };
  policy?: SidecarPolicy | null;
  inference?: SidecarInferenceProvider | null;
  lifecycle?: LifecycleGate | null;
  now?: () => number;
  idempotencyTtlMs?: number;
  extractionTtlMs?: number;
}

interface StoredExtraction {
  version: 1;
  id: string;
  status: 'pending' | 'completed' | 'failed';
  extractor: IngestExtractorKind;
  model?: string;
  records: IngestRecordView[];
  detailIds: string[];
  warnings: string[];
  /** 结构化 Detail 失败；retryable=false 才阻止 extraction completed。 */
  detailFailures?: Array<{ code: string; retryable: boolean }>;
  degraded: boolean;
  expiresAt: number;
  createdAt: number;
  agentId: string;
  agentName?: string;
  threadId?: string;
  domain?: string;
  stagingChunkIds: string[];
  /** @deprecated 旧字段兼容；等于 stagingChunkIds。 */
  rawChunkIds: string[];
  messageIds: string[];
  /** 属于该 extraction 的 outbox 依赖；用于双向重放与终态收口。 */
  outboxIds?: string[];
}

interface IdempotencyEntry {
  version: 1;
  at: number;
  bodyHash: string;
  status: 200 | 202;
  data: IngestResult;
}

interface SettlementOutcome {
  records: IngestRecordView[];
  queued: boolean;
  failed: number;
  degraded: boolean;
  warnings: string[];
  status: 'completed' | 'pending' | 'failed';
}

interface DetailSettlementOutcome {
  ids: string[];
  written: number;
  duplicates: number;
  queued: number;
  failed: number;
  warnings: string[];
  queuedRequestIds: string[];
  failures: Array<{ code: string; retryable: boolean }>;
}

interface CandidateEvidence {
  stagingChunkIds: string[];
  messageIds: string[];
}

interface CandidateContext {
  agentId: string;
  agentName?: string;
  threadId: string | null;
  messageIds: string[];
  stagingChunkIds: string[];
  /** 本次沉降的稳定 extraction id；无 staging 的 candidate-only ingest 也用它关联 outbox。 */
  extractionId?: string;
  extractor: IngestExtractorKind;
  model: string | null;
  source: 'runtime' | 'host';
  evidenceByClientItemId?: Map<string, CandidateEvidence>;
}

interface FactIdentity {
  subject: string;
  predicate: string;
  object: string;
}

/** 候选/记录的统一同键三元组（preference 兼容 entity/preferenceType/value 形状）。 */
function factIdentityOf(content: unknown, kind: string): FactIdentity | null {
  if (!isObject(content) || (kind !== 'fact' && kind !== 'preference')) return null;
  const subject = typeof content.subject === 'string'
    ? content.subject
    : typeof content.entity === 'string' ? content.entity : null;
  const predicate = typeof content.predicate === 'string'
    ? content.predicate
    : typeof content.preferenceType === 'string' ? content.preferenceType : null;
  const object = typeof content.object === 'string'
    ? content.object
    : typeof content.value === 'string' ? content.value : null;
  if (subject === null || predicate === null || object === null) return null;
  return { subject, predicate, object };
}

function factIdentityOfRecord(record: Record<string, unknown>): FactIdentity | null {
  const kind = typeof record.kind === 'string' ? record.kind : (record.type === 'fact' ? 'fact' : '');
  if (kind !== 'fact' && kind !== 'preference' && record.type !== 'fact') return null;
  return factIdentityOf(record.content, kind === 'preference' ? 'preference' : 'fact');
}

/** fact 是否仍为当前事实；缺失/0/null 视为开放窗口。 */
function recordIsCurrent(record: Record<string, unknown>, now: number): boolean {
  if (record.deletedAt !== undefined && record.deletedAt !== null) return false;
  const validFrom = typeof record.validFrom === 'number' ? record.validFrom : null;
  if (validFrom !== null && validFrom > now) return false;
  const validTo = typeof record.validTo === 'number' ? record.validTo : null;
  return validTo === null || validTo === 0 || validTo > now;
}

/**
 * 本地预筛：明显由其他 Agent / user / system 写入的旧记录不自动附加 supersedes，
 * 避免 capability 因权限拒绝整个新事实写入；最终权限仍由 capability 强制。
 * provenance 缺失时交给 capability 判定。
 */
function mayAutoSupersede(record: Record<string, unknown>, agentId: string): boolean {
  const provenance = isObject(record.provenance) ? record.provenance : {};
  const writerType = typeof provenance.writerType === 'string' ? provenance.writerType : null;
  const writerId = typeof provenance.writerId === 'string' ? provenance.writerId : null;
  if (writerType === 'user' || writerType === 'system') return false;
  if (writerType === 'agent' && writerId !== null && writerId !== agentId) return false;
  return true;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** ingest 的统一最小化边界：候选、staging、模型输入与 outbox 共用相同脱敏规则。 */
function minimizeValue(value: unknown, key?: string): unknown {
  if (typeof value === 'string') {
    if (key && SENSITIVE_FIELD_RE.test(key)) return '[redacted]';
    return redactText(value).text;
  }
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => minimizeValue(entry));
  const out: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
    if (entryValue !== undefined) out[entryKey] = minimizeValue(entryValue, entryKey);
  }
  return out;
}

function safeRedactionRules(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((rule): rule is string =>
    typeof rule === 'string' && SAFE_REDACTION_RULE_RE.test(rule)))].slice(0, 64);
}

/** 幂等哈希、staging、模型和 capability/outbox 必须使用同一份规范化输入。 */
function normalizeIngestRequest(input: Record<string, unknown>): Record<string, unknown> {
  const normalized = minimizeValue(input) as Record<string, unknown>;
  if (Array.isArray(normalized.chunks)) {
    normalized.chunks = normalized.chunks.map((value) => {
      if (!isObject(value) || !isObject(value.redaction)) return value;
      return {
        ...value,
        redaction: {
          ...value.redaction,
          rules: safeRedactionRules(value.redaction.rules),
        },
      };
    });
  }
  return normalized;
}

function safeErrorMessage(error: unknown): string {
  return redactText(String((error as Error)?.message ?? error ?? 'sidecar 内部错误')).text.slice(0, 512);
}

function candidateEvidenceKey(candidate: {
  kind: string;
  content: Record<string, unknown>;
  domainHint?: string | null;
  validFrom?: number;
  validTo?: number;
}): string {
  return [
    candidate.kind,
    candidate.domainHint ?? '',
    canonicalJson(candidate.content),
    candidate.validFrom ?? '',
    candidate.validTo ?? '',
  ].join('\u0000');
}

function stringEvidence(value: unknown, max = 100): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0))]
    .slice(0, max);
}

function invalid(message: string, details?: unknown): never {
  throw new SidecarSettlementError('invalid_request', message, { status: 400, details });
}

function requireObject(value: unknown, name: string): Record<string, unknown> {
  if (!isObject(value)) invalid(`${name} 必须是对象`);
  return value;
}

function enumValue<T extends string>(value: unknown, values: readonly T[], name: string, fallback: T): T {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'string' && (values as readonly string[]).includes(value)) return value as T;
  throw new SidecarSettlementError('invalid_request', `${name} 不是合法取值`, {
    status: 400,
    details: { field: name },
  });
}

function optionalText(value: unknown, field: string, maxChars: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxChars) {
    throw new SidecarSettlementError('invalid_request', `${field} 必须是 1–${maxChars} 字符的字符串`, {
      status: 400,
      details: { field },
    });
  }
  return value;
}

function optionalPositiveNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new SidecarSettlementError('invalid_request', `${field} 必须是非负有限数字`, {
      status: 400,
      details: { field },
    });
  }
  return value;
}

function optionalNonNegativeInt(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new SidecarSettlementError('invalid_request', `${field} 必须是非负整数`, {
      status: 400,
      details: { field },
    });
  }
  return value;
}

function optionalBoolean(value: unknown, field: string): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') {
    throw new SidecarSettlementError('invalid_request', `${field} 必须是布尔值`, { status: 400 });
  }
  return value;
}

function nowView(at: number, code: string, message: string): IngestErrorView {
  return { code, message, at };
}

function appendWarnings(target: string[], values: readonly string[]): void {
  for (const value of values) {
    if (value.length > 0 && !target.includes(value)) target.push(value);
  }
}

function errorView(error: unknown, at: number): IngestErrorView {
  if (error instanceof SidecarSettlementError) {
    return nowView(at, error.code, safeErrorMessage(error));
  }
  if (error instanceof CapabilityClientError) {
    return nowView(at, error.code, safeErrorMessage(error));
  }
  if (error instanceof LocalLayerError) {
    return nowView(at, error.code, safeErrorMessage(error));
  }
  return nowView(at, 'internal', safeErrorMessage(error));
}

function retryableCapabilityError(error: unknown): boolean {
  if (error instanceof CapabilityClientError) {
    // 撤销/模式不一致是生命周期信号：保留既有 queued 项，但绝不新建 outbox。
    if (error.code === 'capability_disabled' || error.code === 'mode_mismatch') return false;
    if (error.retryable) return true;
    // token 轮换/网络可能在恢复后成功；保留在 outbox 中等待重放。
    if (error.status === 401 || error.status === 0) return true;
    if (error.status === 429 || error.status >= 500) return true;
    return false;
  }
  // 非 capability 的未知网络错误按暂时失败处理，不丢已接收数据。
  return true;
}

export class IngestService {
  readonly config: SidecarConfig;
  readonly local: SidecarLocalLayer;
  readonly identity: IngestServiceOptions['identity'];

  private readonly client: CapabilityClient | null;
  private readonly models: SidecarInferenceProvider | null;
  private readonly lifecycle: LifecycleGate | null;
  private policy: SidecarPolicy | null;
  private readonly now: () => number;
  private readonly idempotencyTtlMs: number;
  private readonly extractionTtlMs: number;
  private tail: Promise<void> = Promise.resolve();

  private ingested = 0;
  private settled = 0;
  private failed = 0;
  private queued = 0;
  private degraded = false;
  private lastError: IngestErrorView | null = null;
  private finalizeRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private finalizePending = 0;
  private finalizeExhausted = 0;
  private stopped = false;
  private stopGeneration = 0;

  constructor(options: IngestServiceOptions) {
    this.config = options.config;
    this.local = options.local;
    this.client = options.client;
    this.models = options.inference ?? null;
    this.lifecycle = options.lifecycle ?? null;
    this.identity = options.identity;
    this.policy = options.policy ?? null;
    this.now = options.now ?? Date.now;
    this.idempotencyTtlMs = options.idempotencyTtlMs ?? IDEMPOTENCY_TTL_MS;
    this.extractionTtlMs = options.extractionTtlMs ?? EXTRACTION_TTL_MS;
    // putStagingChunk 已在 ingest chain 内；只能使用 unlocked 变体避免 self-chain 死锁。
    this.local.setStagingDependencyHandler((ids) => this.expireStagingDependenciesUnlocked(ids));
    this.local.setMaintenanceDependencyHandler((ids) => this.expireStagingDependencies(ids));
    this.local.setDeadLetterHandler((item) => this.finalizeReplayedOutbox(item, 'dead'));
    this.local.setStagingDeadLetterHandler((item) => this.finalizeReplayedItemDirect(item, 'dead'));
  }

  get isDegraded(): boolean {
    return this.degraded;
  }

  get lastErrorView(): IngestErrorView | null {
    return this.lastError ? { ...this.lastError } : null;
  }

  stats(): IngestStatsSnapshot {
    return {
      ingested: this.ingested,
      settled: this.settled,
      failed: this.failed,
      queued: this.queued,
      degraded: this.degraded,
      lastError: this.lastError ? { ...this.lastError } : null,
      finalizePending: this.finalizePending,
      finalizeExhausted: this.finalizeExhausted,
    };
  }

  reconciliationStatus(): {
    pending: number;
    exhausted: number;
    timerActive: boolean;
    stopped: boolean;
    lastError: IngestErrorView | null;
  } {
    return {
      pending: this.finalizePending,
      exhausted: this.finalizeExhausted,
      timerActive: this.finalizeRetryTimer !== null,
      stopped: this.stopped,
      lastError: this.lastError ? { ...this.lastError } : null,
    };
  }

  /** 停止后台收口定时器；停止后不再调度或执行新的收口写入。 */
  stop(): void {
    this.stopped = true;
    this.stopGeneration += 1;
    this.clearFinalizeRetryTimer();
  }

  private clearFinalizeRetryTimer(): void {
    if (!this.finalizeRetryTimer) return;
    clearTimeout(this.finalizeRetryTimer);
    this.finalizeRetryTimer = null;
  }

  /** 启动后调用：已有 outbox 视为仍需重放的降级状态。 */
  async init(): Promise<void> {
    this.stopped = false;
    await this.reconcileReplayFinalizations().catch(() => 0);
    const outbox = await this.local.outbox.stats();
    if (outbox.items > 0) {
      this.degraded = true;
      const specificFinalizeError = this.lastError?.code === 'finalize_failed'
        || this.lastError?.code === 'finalize_exhausted'
        || this.lastError?.code === 'finalize_cleanup_failed';
      if (!specificFinalizeError) {
        this.lastError = nowView(this.now(), 'outbox_pending', '存在待重放的沉降请求');
      }
    }
  }

  /** policy.json 热加载后更新本地写域约束。 */
  setPolicy(policy: SidecarPolicy | null): void {
    this.policy = policy;
  }

  noteSettled(count: number): void {
    if (count > 0) this.settled += count;
  }

  noteQueued(error: unknown): void {
    this.queued += 1;
    this.degraded = true;
    this.lastError = errorView(error, this.now());
  }

  noteFailed(error: unknown): void {
    this.failed += 1;
    this.degraded = true;
    this.lastError = errorView(error, this.now());
  }

  noteSettlementError(error: unknown): void {
    this.degraded = true;
    this.lastError = errorView(error, this.now());
  }

  /**
   * capability 成功返回后再次校验生命周期：drain 期间晚到的 200 仍是“含糊成功”，
   * 不得提交 Detail/记录/outbox，且本次禁用不得报告 clean。
   */
  private assertLifecycleAfterSuccess(operation: string): void {
    if (!this.lifecycle || this.lifecycle.acceptsWork()) return;
    this.lifecycle.noteAmbiguousSuccess(operation);
    throw new SidecarSettlementError(
      'mode_mismatch',
      'Memory Runtime 已休眠：晚到的成功不再提交',
      { status: 409, retryable: false, details: { operation, phase: this.lifecycle.currentPhase } },
    );
  }

  applyReplaySummary(summary: OutboxReplaySummary): void {
    this.settled += Math.max(0, summary.settled);
    if (summary.errors.length > 0) {
      this.degraded = true;
      this.lastError = { ...summary.errors[summary.errors.length - 1]! };
    } else if (summary.remaining === 0) {
      this.degraded = false;
      this.lastError = null;
    }
    if (summary.dead > 0) this.failed += summary.dead;
  }

  // ------------------------------------------------------------------
  // ingest
  // ------------------------------------------------------------------

  async ingest(
    request: unknown,
    options: { idempotencyKey?: string | null } = {},
  ): Promise<IngestHttpResult> {
    this.lifecycle?.assertAccepting('ingest');
    return this.chain(() => this.ingestLocked(request, options));
  }

  private async ingestLocked(
    request: unknown,
    options: { idempotencyKey?: string | null },
  ): Promise<IngestHttpResult> {
    const input = normalizeIngestRequest(requireObject(request, 'ingest 请求'));
    const idempotencyKey = this.idempotencyKeyOf(options.idempotencyKey, input.requestId);
    const bodyHash = sha256Hex(canonicalJson(input));
    const idempotencyCacheKey = idempotencyKey ? this.idempotencyCacheKey(idempotencyKey) : null;

    if (idempotencyCacheKey) {
      const cached = await this.local.cache.get<IdempotencyEntry>(idempotencyCacheKey);
      if (cached && cached.version === 1) {
        if (cached.bodyHash !== bodyHash) {
          throw new SidecarSettlementError('idempotency_conflict', '同一 Idempotency-Key 对应了不同请求体', {
            status: 409,
          });
        }
        const data: IngestResult = {
          ...cached.data,
          duplicate: true,
          degraded: cached.data.degraded || this.degraded,
          warnings: [...cached.data.warnings],
        };
        return { status: cached.status, data, warnings: data.warnings, degraded: data.degraded };
      }
    }

    const agentId = this.agentIdOf(input);
    const agentName = optionalText(input.agentName, 'agentName', 128);
    const explicitThreadId = this.threadIdOf(input.threadId);
    const extractor = enumValue(input.extractor, EXTRACTORS, 'extractor', 'auto');
    const allowRemote = optionalBoolean(input.allowRemote, 'allowRemote');
    const requestDomain = this.domainOf(input.domain);
    const warnings: string[] = [];
    if (input.capture !== undefined || input.rawCapture !== undefined) {
      // 旧宿主可能仍发送 capture；忽略，绝不再控制采集行为。
      appendWarnings(warnings, ['legacy_capture_ignored']);
    }

    const chunks = this.buildChunks(input.chunks, { agentId });
    const threadId = explicitThreadId ?? this.deriveThreadId(agentId, chunks);

    const rawCandidates = minimizeValue(input.candidates);
    const explicitEvidence = this.explicitEvidence(rawCandidates, chunks);
    const candidateCheck = validateCandidates(rawCandidates);
    warnings.push(...candidateCheck.warnings);
    if (Array.isArray(rawCandidates) && rawCandidates.length > 0 && candidateCheck.candidates.length === 0) {
      throw new SidecarSettlementError('validation_failed', '候选记录全部非法', {
        status: 422,
        details: { warnings: [...warnings] },
      });
    }

    const routedHost = candidateCheck.candidates.map((candidate) => routeCandidate(candidate, {
      agentId,
      threadId: explicitThreadId,
      requestDomain,
      policy: this.policy,
    }));
    for (const candidate of routedHost) warnings.push(...candidate.warnings);

    this.ingested += 1;
    const extractionId = `ext_${randomUUID().replace(/-/g, '')}`;

    // 宿主明确要求 host 抽取但没有候选（或配置来源就是 host）：
    // 不偷偷换模型，返回 pending。
    const hostPending = routedHost.length === 0 && (
      extractor === 'host'
      || (extractor === 'auto' && this.config.model.source === 'host')
    );
    if (hostPending) {
      this.lifecycle?.assertAccepting('ingest.staging');
      const stagingChunkIds = await this.stageChunks({
        agentId,
        threadId,
        chunks,
        warnings,
      });
      await this.assertStagingComplete(chunks, stagingChunkIds, true);
      const extraction = await this.saveExtraction({
        id: extractionId,
        status: 'pending',
        extractor: 'host',
        records: [],
        detailIds: [],
        warnings,
        degraded: false,
        agentId,
        ...(agentName ? { agentName } : {}),
        ...(explicitThreadId ? { threadId: explicitThreadId } : {}),
        ...(requestDomain ? { domain: requestDomain } : {}),
        stagingChunkIds,
        messageIds: this.messageIdsOf(chunks),
      });
      const data: IngestResult = {
        accepted: { chunks: chunks.length, records: 0 },
        stagingChunkIds,
        rawChunkIds: stagingChunkIds,
        detailIds: [],
        detail: { ids: [], written: 0, duplicates: 0, queued: 0, failed: 0 },
        records: [],
        extraction: this.extractionView(extraction),
        queued: false,
        duplicate: false,
        degraded: false,
        warnings: [...warnings],
      };
      await this.rememberIdempotent(idempotencyCacheKey ?? '', bodyHash, 202, data);
      return { status: 202, data, warnings: data.warnings, degraded: false };
    }

    // 先写本地 staging，确保模型失败/超时不会丢原始材料；staging 不是权威。
    this.lifecycle?.assertAccepting('ingest.staging');
    const stagingChunkIds = await this.stageChunks({
      agentId,
      threadId,
      chunks,
      warnings,
    });
    await this.assertStagingComplete(chunks, stagingChunkIds, false);

    let routed: RoutedCandidate[] = routedHost;
    let evidenceByClientItemId = this.evidenceForRouted(
      routedHost,
      chunks,
      explicitEvidence,
      agentId,
    );
    let resolvedExtractor: IngestExtractorKind = 'host';
    let model: string | null = routedHost.length > 0 ? 'host-provided' : null;
    let degraded = false;
    let modelSucceeded = false;

    if (routedHost.length > 0) {
      this.models?.noteHostCandidates();
    } else if (extractor !== 'heuristic') {
      this.lifecycle?.assertAccepting('ingest.model');
      const selection = await this.selectExtractionSource(extractor, allowRemote);
      appendWarnings(warnings, selection.warnings);
      degraded = selection.degraded;

      if (selection.source === 'local' || selection.source === 'api') {
        let outcome: InferenceExtractionResult;
        try {
          outcome = this.models
            ? await this.models.extractCandidates({
              source: selection.source,
              chunks: chunks.map((chunk) => ({
                text: chunk.text,
                ...(chunk.role ? { role: chunk.role } : {}),
                ...(chunk.messageId ? { messageId: chunk.messageId } : {}),
                ...(typeof chunk.at === 'number' ? { at: chunk.at } : {}),
              })),
              domain: requestDomain ?? agentDomain(agentId),
              agentId,
              ...(explicitThreadId ? { threadId: explicitThreadId } : {}),
              allowRemote,
            })
            : {
              ok: false,
              candidates: [],
              extractor: selection.source,
              degraded: true,
              reason: 'model_unavailable',
              warnings: ['model_unavailable'],
              latencyMs: 0,
            };
        } catch {
          // 模型层异常不能让 ingest 失败，也不能丢 staging。
          outcome = {
            ok: false,
            candidates: [],
            extractor: selection.source,
            degraded: true,
            reason: 'model_unavailable',
            warnings: ['model_unavailable'],
            latencyMs: 0,
          };
        }

        if (outcome.ok) {
          const modelCandidates = minimizeValue(outcome.candidates);
          const modelEvidence = this.explicitEvidence(modelCandidates, chunks);
          const checked = validateCandidates(modelCandidates);
          appendWarnings(warnings, checked.warnings);
          if (outcome.candidates.length > 0 && checked.candidates.length === 0) {
            // 模型输出不可信：全部非法时回退 heuristic，绝不把原始形状写图。
            appendWarnings(warnings, ['model_invalid_candidates', 'model_unavailable']);
            degraded = true;
            this.models?.noteFailure(selection.source, 'model_invalid_candidates', [
              'model_invalid_candidates',
              'model_unavailable',
            ]);
          } else {
            routed = checked.candidates.map((candidate) => routeCandidate(candidate, {
              agentId,
              threadId: explicitThreadId,
              requestDomain,
              policy: this.policy,
            }));
            evidenceByClientItemId = this.evidenceForRouted(routed, chunks, modelEvidence, agentId);
            for (const candidate of routed) appendWarnings(warnings, candidate.warnings);
            resolvedExtractor = selection.source;
            model = outcome.model ?? null;
            degraded = outcome.degraded;
            modelSucceeded = true;
            if (routed.length === 0) appendWarnings(warnings, ['no_extractable_memory']);
            this.models?.clearFailure(selection.source);
          }
        } else {
          degraded = true;
          appendWarnings(warnings, outcome.warnings);
          if (outcome.reason) appendWarnings(warnings, [outcome.reason]);
          this.models?.noteFailure(
            selection.source,
            outcome.reason ?? 'model_unavailable',
            outcome.warnings.length > 0 ? outcome.warnings : ['model_unavailable'],
          );
        }
      }
    }

    if (!modelSucceeded && routed.length === 0) {
      const heuristicInputs: CandidateInput[] = [];
      const heuristicEvidence = new Map<string, CandidateEvidence>();
      const heuristicKeys = new Set<string>();
      for (const chunk of chunks) {
        const heuristic = heuristicCandidates([{
          role: chunk.role,
          text: chunk.text,
          at: chunk.at,
          threadId,
        }]);
        for (const candidate of heuristic.candidates) {
          const input: CandidateInput = {
            kind: candidate.kind,
            content: candidate.content,
            domainHint: null,
            tags: candidate.tags ?? [],
            relatedTo: [],
            confirmation: candidate.confirmation,
          };
          const key = candidateEvidenceKey(input);
          if (!heuristicKeys.has(key)) {
            heuristicKeys.add(key);
            heuristicInputs.push(input);
          }
          const previous = heuristicEvidence.get(key) ?? { stagingChunkIds: [], messageIds: [] };
          previous.stagingChunkIds = [...new Set([...previous.stagingChunkIds, chunk.id])];
          previous.messageIds = [...new Set([
            ...previous.messageIds,
            ...(chunk.messageId ? [chunk.messageId] : []),
          ])];
          heuristicEvidence.set(key, previous);
        }
      }
      routed = heuristicInputs.map((candidate) => routeCandidate(candidate, {
        agentId,
        threadId: explicitThreadId,
        requestDomain,
        policy: this.policy,
      }));
      evidenceByClientItemId = this.evidenceForRouted(routed, chunks, heuristicEvidence, agentId);
      if (routed.length === 0) appendWarnings(warnings, ['no_extractable_memory']);
      for (const candidate of routed) appendWarnings(warnings, candidate.warnings);
      resolvedExtractor = 'heuristic';
      model = null;
    }

    const context: CandidateContext = {
      agentId,
      ...(agentName ? { agentName } : {}),
      threadId: explicitThreadId,
      messageIds: this.messageIdsOf(chunks),
      stagingChunkIds,
      extractionId,
      extractor: resolvedExtractor,
      model,
      source: resolvedExtractor === 'host' ? 'host' : 'runtime',
      evidenceByClientItemId,
    };

    const outcome = await this.settle(routed, context);
    warnings.push(...outcome.warnings);

    // 记录成功后才写详情：详情必须链接同域记录；没有记录只保留 staging 到 TTL。
    this.lifecycle?.assertAccepting('ingest.detail');
    const detailOutcome = await this.settleDetails({
      chunks,
      records: outcome.records,
      threadId,
      context,
      warnings,
      extractionIds: [extractionId],
    });
    // 记录/详情可能已在 drain 前提交；晚到成功只能 409，绝不再清理 staging 或写 completed。
    this.assertLifecycleAfterSuccess('ingest.detail.settled');
    if (outcome.records.length > 0 && !outcome.queued && outcome.failed === 0
      && detailOutcome.queued === 0 && detailOutcome.failed === 0 && stagingChunkIds.length > 0) {
      await this.clearStaging(stagingChunkIds, warnings);
    } else if (outcome.records.length === 0 && !outcome.queued
      && detailOutcome.queued === 0 && stagingChunkIds.length > 0) {
      // 抽取已结束且没有可关联记录： staging 不再保留无用途正文。
      await this.clearStaging(stagingChunkIds, warnings);
    }

    const queued = outcome.queued || detailOutcome.queued > 0;
    const extractionStatus = queued
      ? 'pending'
      : outcome.status === 'failed' || detailOutcome.failed > 0
        ? 'failed'
        : outcome.records.length > 0
          ? 'completed'
          : routed.length > 0 ? 'failed' : 'completed';

    const extraction = await this.saveExtraction({
      id: extractionId,
      status: extractionStatus,
      extractor: resolvedExtractor,
      ...(model ? { model } : {}),
      records: outcome.records,
      detailIds: detailOutcome.ids,
      warnings: [...warnings],
      degraded: degraded || outcome.degraded,
      ...(detailOutcome.failures.length > 0 ? { detailFailures: detailOutcome.failures } : {}),
      agentId,
      ...(agentName ? { agentName } : {}),
      ...(explicitThreadId ? { threadId: explicitThreadId } : {}),
      ...(requestDomain ? { domain: requestDomain } : {}),
      stagingChunkIds,
      messageIds: this.messageIdsOf(chunks),
    });
    await this.linkExtractionToOutbox(stagingChunkIds, extraction.id);

    const resultDegraded = degraded || outcome.degraded || detailOutcome.queued > 0
      || detailOutcome.failed > 0 || this.degraded;
    const data: IngestResult = {
      accepted: { chunks: chunks.length, records: outcome.records.length },
      stagingChunkIds,
      rawChunkIds: stagingChunkIds,
      detailIds: detailOutcome.ids,
      detail: {
        ids: detailOutcome.ids,
        written: detailOutcome.written,
        duplicates: detailOutcome.duplicates,
        queued: detailOutcome.queued,
        failed: detailOutcome.failed,
      },
      records: outcome.records,
      extraction: this.extractionView(extraction),
      queued,
      duplicate: false,
      degraded: resultDegraded,
      warnings: [...warnings],
    };
    const status: 200 | 202 = queued ? 202 : 200;
    await this.rememberIdempotent(idempotencyCacheKey ?? '', bodyHash, status, data);
    return { status, data, warnings: data.warnings, degraded: resultDegraded };
  }

  // ------------------------------------------------------------------
  // extraction follow-up（host 候选回填）
  // ------------------------------------------------------------------

  async getExtraction(id: string): Promise<IngestExtractionView | null> {
    if (!EXTRACTION_ID_RE.test(id)) return null;
    const stored = await this.loadExtraction(id);
    return stored ? this.extractionView(stored) : null;
  }

  async completeExtraction(id: string, candidates: unknown): Promise<IngestExtractionResult> {
    this.lifecycle?.assertAccepting('ingest.extraction');
    return this.chain(async () => {
      if (!EXTRACTION_ID_RE.test(id)) {
        throw new SidecarSettlementError('not_found', '抽取任务不存在或已过期', { status: 404 });
      }
      const extraction = await this.loadExtraction(id);
      if (!extraction) {
        throw new SidecarSettlementError('not_found', '抽取任务不存在或已过期', { status: 404 });
      }
      if ((extraction.status === 'completed' && extraction.records.length > 0)
        || extraction.status === 'failed') {
        return {
          extraction: this.extractionView(extraction),
          queued: false,
          degraded: this.degraded || extraction.status === 'failed',
          warnings: [...extraction.warnings],
        };
      }
      const staged = await this.stagedChunksFor(extraction.stagingChunkIds);
      if (staged.length === 0 || staged.length !== new Set(extraction.stagingChunkIds).size) {
        const failed = await this.failExtraction(extraction, 'retention_expired');
        return {
          extraction: this.extractionView(failed),
          queued: false,
          degraded: true,
          warnings: [...failed.warnings],
        };
      }
      const safeCandidates = minimizeValue(candidates);
      const explicitEvidence = this.explicitEvidence(safeCandidates, staged);
      const checked = validateCandidates(safeCandidates);
      if (checked.candidates.length === 0) {
        throw new SidecarSettlementError('validation_failed', '候选记录全部非法', {
          status: 422,
          details: { warnings: checked.warnings },
        });
      }
      const warnings = [...checked.warnings];
      const routed = checked.candidates.map((candidate) => routeCandidate(candidate, {
        agentId: extraction.agentId,
        threadId: extraction.threadId ?? null,
        requestDomain: extraction.domain ?? null,
        policy: this.policy,
      }));
      for (const candidate of routed) warnings.push(...candidate.warnings);
      this.models?.noteHostCandidates();
      const evidenceByClientItemId = this.evidenceForRouted(
        routed,
        staged,
        explicitEvidence,
        extraction.agentId,
      );

      const outcome = await this.settle(routed, {
        agentId: extraction.agentId,
        ...(extraction.agentName ? { agentName: extraction.agentName } : {}),
        threadId: extraction.threadId ?? null,
        messageIds: extraction.messageIds,
        stagingChunkIds: extraction.stagingChunkIds,
        extractionId: extraction.id,
        extractor: 'host',
        model: 'host-provided',
        source: 'host',
        evidenceByClientItemId,
      });
      warnings.push(...outcome.warnings);

      const detailOutcome = await this.settleDetails({
        chunks: staged,
        records: outcome.records,
        threadId: extraction.threadId ?? this.deriveThreadId(extraction.agentId, staged),
        context: {
          agentId: extraction.agentId,
          ...(extraction.agentName ? { agentName: extraction.agentName } : {}),
          threadId: extraction.threadId ?? null,
          messageIds: extraction.messageIds,
          stagingChunkIds: extraction.stagingChunkIds,
          extractor: 'host',
          model: 'host-provided',
          source: 'host',
          evidenceByClientItemId,
        },
        warnings,
        extractionIds: [extraction.id],
      });
      this.assertLifecycleAfterSuccess('ingest.extraction.detail.settled');
      if (outcome.records.length > 0 && !outcome.queued && outcome.failed === 0
        && detailOutcome.queued === 0 && detailOutcome.failed === 0 && extraction.stagingChunkIds.length > 0) {
        await this.clearStaging(extraction.stagingChunkIds, warnings, {
          excludeExtractionIds: [extraction.id],
        });
      } else if (outcome.records.length === 0 && !outcome.queued
        && detailOutcome.queued === 0 && extraction.stagingChunkIds.length > 0) {
        await this.clearStaging(extraction.stagingChunkIds, warnings, {
          excludeExtractionIds: [extraction.id],
        });
      }
      const queued = outcome.queued || detailOutcome.queued > 0;
      const updated = await this.saveExtraction({
        ...extraction,
        status: queued ? 'pending' : outcome.status === 'failed' || detailOutcome.failed > 0 ? 'failed' : 'completed',
        extractor: 'host',
        model: 'host-provided',
        records: outcome.records,
        detailIds: detailOutcome.ids.length > 0 ? detailOutcome.ids : extraction.detailIds,
        warnings,
        detailFailures: [...(extraction.detailFailures ?? []), ...detailOutcome.failures],
        degraded: outcome.degraded || detailOutcome.queued > 0 || detailOutcome.failed > 0,
      });
      await this.linkExtractionToOutbox(extraction.stagingChunkIds, updated.id);
      return {
        extraction: this.extractionView(updated),
        queued,
        degraded: outcome.degraded || this.degraded || queued || detailOutcome.failed > 0,
        warnings,
      };
    });
  }

  // ------------------------------------------------------------------
  // internals
  // ------------------------------------------------------------------

  private chain<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation, operation);
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  /** outbox 重放成功后的本地清理/缓存回填。返回 false 表示仍需重试。 */
  async applyReplayedOutbox(item: OutboxItem, data: unknown): Promise<boolean> {
    // drain/resume 竞态：晚到的 capability 成功不得提交 Detail/记录或删除 pending。
    if (this.lifecycle && !this.lifecycle.acceptsWork()) {
      this.lifecycle.noteAmbiguousSuccess('replay.apply_late_success');
      return false;
    }
    if (item.endpoint !== '/detail') {
      if (item.meta?.kind === 'record') {
        return this.applyReplayedRecord(item, data);
      }
      return true;
    }
    if (!this.client) return false;
    // 依赖 staging 的 Detail 重放在证据过期时必须显式 dead，不得静默确认。
    const requiredStaging = item.meta?.stagingChunkIds ?? [];
    if (requiredStaging.length > 0) {
      const staged = await this.stagedChunksFor(requiredStaging);
      if (staged.length !== new Set(requiredStaging).size) {
        throw new CapabilityClientError('retention_expired', '重放所需 staging 已缺失', {
          status: 410,
          retryable: false,
        });
      }
    }
    const body: Record<string, unknown> = isObject(item.body) ? item.body : {};
    const items = (Array.isArray(body.items) ? body.items.filter(isObject) : []) as unknown as CapabilityDetailWriteItem[];
    if (items.length === 0) return false;
    const bodyActor = isObject(body.actor) ? body.actor : {};
    if (bodyActor.type !== 'agent' || typeof bodyActor.agentId !== 'string') return false;
    const actor = {
      type: 'agent' as const,
      agentId: bodyActor.agentId,
      ...(typeof bodyActor.displayName === 'string' ? { displayName: bodyActor.displayName } : {}),
    };
    const payload: Record<string, unknown> = isObject(data) ? data : {};
    const declaredFailed = typeof payload.failed === 'number' && payload.failed > 0;
    const results = Array.isArray(payload.results) ? payload.results : [];
    const resultByClientItemId = new Map<string, Record<string, unknown>>();
    for (const result of results) {
      if (!isObject(result) || typeof result.clientItemId !== 'string') continue;
      resultByClientItemId.set(result.clientItemId, result);
    }
    let allOk = !declaredFailed;
    const committedDetails: Array<{
      id: string;
      clientItemId?: string;
      status?: string;
      domain?: string;
      kind?: string;
    }> = [];
    try {
      for (const detailItem of items) {
        if (this.lifecycle && !this.lifecycle.acceptsWork()) {
          this.lifecycle.noteAmbiguousSuccess('replay.detail.commit_after_drain');
          return false;
        }
        const result = resultByClientItemId.get(detailItem.clientItemId);
        if (!result) {
          allOk = false;
          continue;
        }
        const status = typeof result.status === 'string' ? result.status : 'failed';
        const id = typeof result.id === 'string' ? result.id : '';
        if ((status !== 'created' && status !== 'duplicate') || id.length === 0) {
          allOk = false;
          continue;
        }
        await this.renewReplayLease(item).catch(() => false);
        const authoritative = await this.confirmDetail(id, detailItem, actor);
        committedDetails.push({
          id,
          clientItemId: detailItem.clientItemId,
          status,
          ...(authoritative.domain ? { domain: authoritative.domain } : {}),
          ...(authoritative.detailKind ?? detailItem.detailKind
            ? { kind: authoritative.detailKind ?? detailItem.detailKind }
            : {}),
        });
        // created/duplicate 都用权威回读更新本地 cache（duplicate 已合并 recordIds）。
        await this.cacheDetail(id, result, items, authoritative);
      }
    } catch (error) {
      if (committedDetails.length > 0) {
        await this.local.outbox.markCommitted(item.id, { details: committedDetails }, {
          owner: item.replayLeaseOwner,
        }).catch(() => false);
      }
      throw error;
    }
    if (committedDetails.length > 0) {
      await this.local.outbox.markCommitted(item.id, { details: committedDetails }, {
        owner: item.replayLeaseOwner,
      }).catch(() => false);
    }
    if (!allOk) {
      await this.finalizeReplayedOutbox(item, 'retry');
      return false;
    }
    await this.finalizeReplayedOutbox(item, 'settled');
    if (item.meta?.stagingChunkIds && item.meta.stagingChunkIds.length > 0) {
      try {
        await this.clearStagingAfterReplay(item.meta.stagingChunkIds, item.id, {
          excludeExtractionIds: item.meta.extractionIds ?? [],
        });
      } catch {
        // 清理失败只保留 staging 到 TTL，不影响已沉降详情。
      }
    }
    return true;
  }

  private async applyReplayedRecord(item: OutboxItem, data: unknown): Promise<boolean> {
    if (this.lifecycle && !this.lifecycle.acceptsWork()) {
      this.lifecycle.noteAmbiguousSuccess('replay.record.late_success');
      return false;
    }
    const payload: Record<string, unknown> = isObject(data) ? data : {};
    const declaredFailed = typeof payload.failed === 'number' && payload.failed > 0;
    const results = Array.isArray(payload.results) ? payload.results : [];
    const bodyItems = isObject(item.body) && Array.isArray(item.body.items) ? item.body.items : [];
    const expectedRecords = bodyItems.length;
    if (expectedRecords === 0) return false;
    const expectedClientItemIds = new Set(bodyItems
      .filter(isObject)
      .map((entry) => entry.clientItemId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0));
    const records: IngestRecordView[] = [];
    for (const [resultIndex, result] of results.entries()) {
      if (!isObject(result)) continue;
      const status = typeof result.status === 'string' ? result.status : 'failed';
      if (status !== 'created' && status !== 'duplicate') continue;
      if (typeof result.id !== 'string' || typeof result.domain !== 'string') continue;
      const bodyItem = bodyItems[resultIndex];
      const clientItemId = typeof result.clientItemId === 'string'
        ? result.clientItemId
        : isObject(bodyItem) && typeof bodyItem.clientItemId === 'string'
          ? bodyItem.clientItemId
          : null;
      // 批次外成功不能顶替缺失项，也不能获得本批证据关联。
      if (clientItemId === null || !expectedClientItemIds.has(clientItemId)) continue;
      records.push({
        id: result.id,
        clientItemId,
        kind: typeof result.kind === 'string' ? result.kind : 'observation',
        domain: result.domain,
        status,
      });
    }
    if (records.length === 0) return false;
    // capability 已成功确认的记录先持久化披露；即使后续 staging/detail 对账失败，
    // dead/partial 也不会丢掉已提交的 record IDs/对象。
    await this.local.outbox.markCommitted(item.id, {
      records: records.map((record) => ({
        id: record.id,
        ...(record.clientItemId ? { clientItemId: record.clientItemId } : {}),
        ...(record.status ? { status: record.status } : {}),
        ...(record.domain ? { domain: record.domain } : {}),
        ...(record.kind ? { kind: record.kind } : {}),
      })),
    }, { owner: item.replayLeaseOwner }).catch(() => false);
    const confirmedClientItemIds = new Set(records.map((record) => record.clientItemId));
    const allRecordsConfirmed = expectedClientItemIds.size > 0
      && [...expectedClientItemIds].every((id) => confirmedClientItemIds.has(id));
    const stagingChunkIds = item.meta?.stagingChunkIds ?? [];
    const chunks = await this.stagedChunksFor(stagingChunkIds);
    if (chunks.length !== new Set(stagingChunkIds).size) {
      await this.local.outbox.completeReplay(item.id, {
        outcome: 'dead',
        owner: item.replayLeaseOwner,
        now: this.now(),
        error: 'retention_expired',
      });
      await this.finalizeReplayedOutbox(item, 'dead');
      throw new CapabilityClientError('retention_expired', '重放所需 staging 已缺失', {
        status: 410,
        retryable: false,
      });
    }
    const body: Record<string, unknown> = isObject(item.body) ? item.body : {};
    const actor: Record<string, unknown> = isObject(body.actor) ? body.actor : {};
    const items = Array.isArray(body.items) ? body.items.filter(isObject) : [];
    const first = items[0] ?? {};
    const provenance: Record<string, unknown> = isObject(first.provenance) ? first.provenance : {};
    const agentId = typeof actor.agentId === 'string' ? actor.agentId : 'runtime';
    const threadId = typeof provenance.threadId === 'string' ? provenance.threadId : null;
    const warnings: string[] = [];
    const evidenceByClientItemId = new Map<string, CandidateEvidence>(
      Object.entries(item.meta?.evidence ?? {}).map(([key, value]) => [key, {
        stagingChunkIds: [...value.stagingChunkIds],
        messageIds: [...value.messageIds],
      }]),
    );
    const detailOutcome = await this.settleDetails({
      chunks,
      records,
      threadId: threadId ?? this.deriveThreadId(agentId, chunks),
      context: {
        agentId,
        ...(typeof actor.displayName === 'string' ? { agentName: actor.displayName } : {}),
        threadId,
        messageIds: this.messageIdsOf(chunks),
        stagingChunkIds,
        extractor: provenance.extractor === 'local' || provenance.extractor === 'host'
          || provenance.extractor === 'api' ? provenance.extractor : 'heuristic',
        model: typeof provenance.model === 'string' ? provenance.model : null,
        source: provenance.source === 'host' ? 'host' : 'runtime',
        evidenceByClientItemId,
      },
      warnings,
      extractionIds: item.meta?.extractionIds ?? [],
      touchLease: () => this.renewReplayLease(item).then(() => undefined),
    });
    if (detailOutcome.ids.length > 0) {
      await this.local.outbox.markCommitted(item.id, {
        details: detailOutcome.ids.map((id) => ({ id, status: 'created', kind: 'detail_record' })),
      }, { owner: item.replayLeaseOwner }).catch(() => false);
    }
    const settled = allRecordsConfirmed && !declaredFailed
      && detailOutcome.queued === 0 && detailOutcome.failed === 0;
    if (settled) {
      await this.finalizeReplayedOutbox(item, 'settled');
      await this.clearStagingAfterReplay(stagingChunkIds, item.id, {
        excludeExtractionIds: item.meta?.extractionIds ?? [],
      }).catch(() => 0);
    } else {
      await this.finalizeReplayedOutbox(item, 'retry');
    }
    return settled;
  }

  /**
   * 修正检测：同域、同 subject/predicate、不同 object 的新事实，若旧键只有一个当前值，
   * 则把旧记录作为被替代候选；多值（可能是多个合法事实）不自动替代。
   *
   * 只通过 capability `/query` 读取旧记录，不直接访问 core/fleet，也不在本地建第二套索引。
   */
  private async resolveSupersedes(
    candidates: RoutedCandidate[],
    context: CandidateContext,
    warnings: string[],
  ): Promise<Map<number, string[]>> {
    const result = new Map<number, string[]>();
    const client = this.client;
    if (!client || candidates.length === 0) return result;

    interface Group {
      domain: string;
      identity: FactIdentity;
      indexes: number[];
      objects: Set<string>;
      candidateValidFrom: number;
    }
    const groups = new Map<string, Group>();
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index]!;
      const identity = factIdentityOf(candidate.content, candidate.kind);
      if (!identity) continue;
      const key = `${candidate.domain}\u0000${identity.subject}\u0000${identity.predicate}`;
      const group = groups.get(key) ?? {
        domain: candidate.domain,
        identity,
        indexes: [],
        objects: new Set<string>(),
        candidateValidFrom: candidate.validFrom ?? this.now(),
      };
      group.indexes.push(index);
      group.objects.add(identity.object);
      groups.set(key, group);
    }

    const now = this.now();
    for (const group of groups.values()) {
      if (group.objects.size > 1) {
        // 同一批候选出现多个 object：可能是多个合法事实，不自动择一替代。
        appendWarnings(warnings, ['supersede_ambiguous_candidates']);
        continue;
      }
      const candidateObject = group.identity.object;
      const query = `${group.identity.subject} ${group.identity.predicate}`.trim().slice(0, 2000);
      if (query.length === 0) continue;
      let records: Record<string, unknown>[];
      try {
        const response = await client.query<Record<string, unknown>>({
          actor: { type: 'agent', agentId: context.agentId },
          query,
          types: ['fact', 'preference'],
          domains: [group.domain],
          filters: { entity: group.identity.subject },
          limit: 50,
          offset: 0,
          includeHistory: false,
        });
        records = Array.isArray(response.data?.records)
          ? response.data.records.filter(isObject)
          : [];
      } catch {
        appendWarnings(warnings, ['supersede_lookup_failed']);
        continue;
      }

      const active: Array<{ id: string; object: string }> = [];
      for (const record of records) {
        if (typeof record.id !== 'string' || record.id.length === 0) continue;
        if (typeof record.domain === 'string' && record.domain !== group.domain) continue;
        if (!recordIsCurrent(record, now)) continue;
        if (!mayAutoSupersede(record, context.agentId)) continue;
        const recordValidFrom = typeof record.validFrom === 'number' ? record.validFrom : 0;
        // 后写的旧时间事实（回填）不能反向替代更晚的当前值。
        if (group.candidateValidFrom < recordValidFrom) continue;
        const identity = factIdentityOfRecord(record);
        if (!identity) continue;
        if (identity.subject !== group.identity.subject || identity.predicate !== group.identity.predicate) continue;
        active.push({ id: record.id, object: identity.object });
      }
      if (active.length === 0) continue;

      const objects = new Set(active.map((entry) => entry.object));
      let targets: string[] = [];
      if (objects.size === 1 && !objects.has(candidateObject)) {
        // 唯一旧值 → 新值视为明确修正。
        targets = active.map((entry) => entry.id);
      } else if (objects.has(candidateObject)) {
        // 新值已存在（写入重试）：只关闭唯一一个不同的旧值。
        const others = [...objects].filter((object) => object !== candidateObject);
        if (others.length === 1) {
          targets = active
            .filter((entry) => entry.object === others[0])
            .map((entry) => entry.id);
        } else if (others.length > 1) {
          appendWarnings(warnings, ['supersede_ambiguous_existing_values']);
        }
      } else {
        // 同键已有多个不同当前值：不自动选边。
        appendWarnings(warnings, ['supersede_ambiguous_existing_values']);
      }
      const uniqueTargets = [...new Set(targets)].slice(0, 16);
      if (uniqueTargets.length === 0) continue;
      for (const index of group.indexes) result.set(index, uniqueTargets);
      appendWarnings(warnings, ['supersede_detected']);
    }
    return result;
  }

  private cloudKey(): string {
    return this.identity.cloudId ?? 'cl_local';
  }

  private async selectExtractionSource(
    extractor: IngestExtractor,
    allowRemote: boolean,
  ): Promise<InferenceSourceSelection> {
    if (!this.models) {
      if (extractor === 'local' || extractor === 'api') {
        return {
          source: 'heuristic',
          warnings: ['model_unavailable'],
          degraded: true,
          reason: 'model_unavailable',
        };
      }
      return { source: 'heuristic', warnings: [], degraded: false };
    }
    return this.models.selectExtractionSource(extractor, allowRemote);
  }

  private idempotencyCacheKey(key: string): string {
    return `ingest:v1:${this.cloudKey()}:${key}`;
  }

  private idempotencyKeyOf(header: string | null | undefined, bodyRequestId: unknown): string | null {
    const candidate = typeof header === 'string' && header.length > 0 ? header : bodyRequestId;
    if (candidate === undefined || candidate === null || candidate === '') return null;
    if (typeof candidate !== 'string' || !IDEMPOTENCY_KEY_RE.test(candidate)) {
      throw new SidecarSettlementError('invalid_request', 'requestId/Idempotency-Key 格式非法', {
        status: 400,
        details: { field: 'requestId' },
      });
    }
    return candidate;
  }

  private agentIdOf(input: Record<string, unknown>): string {
    if (!isValidAgentId(input.agentId)) {
      throw new SidecarSettlementError('invalid_request', 'agentId 格式非法', {
        status: 400,
        details: { field: 'agentId' },
      });
    }
    if (input.actor !== undefined) {
      if (!isObject(input.actor) || input.actor.type !== 'agent') invalid('actor 只支持 {type:"agent", agentId}');
      if (input.actor.agentId !== input.agentId) invalid('actor.agentId 与顶层 agentId 不一致');
    }
    return input.agentId;
  }

  private threadIdOf(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    if (!isValidThreadId(value)) {
      throw new SidecarSettlementError('invalid_request', 'threadId 格式非法', {
        status: 400,
        details: { field: 'threadId' },
      });
    }
    return value;
  }

  private domainOf(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    const domain = normalizeDomain(value);
    if (domain === null) {
      throw new SidecarSettlementError('domain_invalid', 'domain 非法', {
        status: 400,
        details: { field: 'domain' },
      });
    }
    return domain;
  }

  private deriveThreadId(agentId: string, chunks: RawChunk[]): string {
    const seed = chunks.length > 0
      ? chunks.map((chunk) => `${chunk.messageId ?? ''}:${chunk.contentHash}:${chunk.chunkIndex ?? 0}`).join('\u0000')
      : `empty:${this.now()}`;
    return `th_${sha256Hex(`${agentId}\u0000${seed}`).slice(0, 24)}`;
  }

  private messageIdsOf(chunks: RawChunk[]): string[] {
    return [...new Set(chunks
      .map((chunk) => chunk.messageId)
      .filter((value): value is string => typeof value === 'string' && value.length > 0))].slice(0, 64);
  }

  private explicitEvidence(rawCandidates: unknown, chunks: RawChunk[]): Map<string, CandidateEvidence> {
    const result = new Map<string, CandidateEvidence>();
    if (!Array.isArray(rawCandidates)) return result;
    const chunkIds = new Set(chunks.map((chunk) => chunk.id));
    // provenance 的 64 条展示上限不能截断 100 个 chunk 的证据校验。
    const messageIds = new Set(chunks
      .map((chunk) => chunk.messageId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0));
    for (const raw of rawCandidates) {
      if (!isObject(raw)) continue;
      let normalized: ReturnType<typeof normalizeCandidate>;
      try {
        normalized = normalizeCandidate(raw);
      } catch {
        continue;
      }
      const provenance = isObject(raw.provenance) ? raw.provenance : {};
      const evidence = isObject(raw.evidence) ? raw.evidence : {};
      const hasExplicit = raw.sourceChunkIds !== undefined || raw.sourceMessageIds !== undefined
        || raw.stagingChunkIds !== undefined || raw.messageIds !== undefined
        || provenance.sourceChunkIds !== undefined || provenance.sourceMessageIds !== undefined
        || provenance.stagingChunkIds !== undefined || provenance.messageIds !== undefined
        || Object.keys(evidence).length > 0;
      if (!hasExplicit) continue;
      const requestedChunks = stringEvidence(
        raw.sourceChunkIds ?? raw.stagingChunkIds ?? evidence.stagingChunkIds ?? evidence.chunkIds
          ?? provenance.sourceChunkIds ?? provenance.stagingChunkIds,
      ).filter((id) => chunkIds.has(id));
      const requestedMessages = stringEvidence(
        raw.sourceMessageIds ?? raw.messageIds ?? evidence.messageIds
          ?? provenance.sourceMessageIds ?? provenance.messageIds,
      ).filter((id) => messageIds.has(id));
      const key = candidateEvidenceKey(normalized);
      const previous = result.get(key) ?? { stagingChunkIds: [], messageIds: [] };
      result.set(key, {
        stagingChunkIds: [...new Set([...previous.stagingChunkIds, ...requestedChunks])],
        messageIds: [...new Set([...previous.messageIds, ...requestedMessages])],
      });
    }
    return result;
  }

  private inferredEvidence(candidate: RoutedCandidate, chunks: RawChunk[]): CandidateEvidence {
    if (chunks.length === 1) {
      const chunk = chunks[0]!;
      return {
        stagingChunkIds: [chunk.id],
        messageIds: chunk.messageId ? [chunk.messageId] : [],
      };
    }
    const content = candidate.content;
    const primary = candidate.kind === 'fact'
      ? content.object
      : candidate.kind === 'preference'
        ? content.value
        : candidate.kind === 'observation' || candidate.kind === 'episode'
          ? content.content
          : candidate.kind === 'entity' || candidate.kind === 'skill'
            ? content.name
            : undefined;
    if (typeof primary !== 'string' || primary.trim().length < 2) {
      return { stagingChunkIds: [], messageIds: [] };
    }
    const needle = primary.trim();
    const supporting = chunks.filter((chunk) => chunk.text.includes(needle));
    return {
      stagingChunkIds: supporting.map((chunk) => chunk.id),
      messageIds: this.messageIdsOf(supporting),
    };
  }

  private evidenceForRouted(
    routed: RoutedCandidate[],
    chunks: RawChunk[],
    explicit: Map<string, CandidateEvidence>,
    agentId: string,
  ): Map<string, CandidateEvidence> {
    const result = new Map<string, CandidateEvidence>();
    for (const candidate of routed) {
      const explicitMatch = explicit.get(candidateEvidenceKey(candidate));
      const inferred = explicitMatch ?? this.inferredEvidence(candidate, chunks);
      const existing = result.get(clientItemIdFor(candidate, agentId));
      if (!existing) {
        result.set(clientItemIdFor(candidate, agentId), {
          stagingChunkIds: [...inferred.stagingChunkIds],
          messageIds: [...inferred.messageIds],
        });
      } else {
        existing.stagingChunkIds = [...new Set([...existing.stagingChunkIds, ...inferred.stagingChunkIds])];
        existing.messageIds = [...new Set([...existing.messageIds, ...inferred.messageIds])];
      }
    }
    return result;
  }

  private buildChunks(raw: unknown, context: { agentId: string }): RawChunk[] {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) invalid('chunks 必须是数组', { field: 'chunks' });
    if (raw.length > MAX_INGEST_CHUNKS) {
      throw new SidecarSettlementError('payload_too_large', `chunks 不能超过 ${MAX_INGEST_CHUNKS} 条`, {
        status: 413,
      });
    }

    const chunks: RawChunk[] = [];
    for (const [index, value] of raw.entries()) {
      const input = requireObject(value, `chunks[${index}]`);
      if (typeof input.text !== 'string' || input.text.trim().length === 0) {
        invalid(`chunks[${index}].text 必须是非空字符串`, { field: `chunks[${index}].text` });
      }
      const originalText = input.text;
      if (Buffer.byteLength(originalText, 'utf8') > this.config.limits.maxChunkBytes) {
        throw new SidecarSettlementError('payload_too_large', `chunks[${index}] 超过 maxChunkBytes`, {
          status: 413,
          details: { maxChunkBytes: this.config.limits.maxChunkBytes },
        });
      }
      const role = enumValue(input.role, ROLES, `chunks[${index}].role`, 'user');
      const requestedKind = enumValue(
        input.detailKind,
        DETAIL_KINDS,
        `chunks[${index}].detailKind`,
        role === 'tool' ? 'tool_output' : 'raw_chunk',
      );
      if (role === 'tool' && requestedKind === 'document_slice') {
        invalid(`chunks[${index}] 不能同时是 tool role 与 document_slice`, {
          field: `chunks[${index}].detailKind`,
        });
      }
      // 与 capability/core 的 role↔detailKind 校验保持一致：在写任何记录前拒绝矛盾组合，
      // 避免先提交 MemoryRecord 后才永久 422。
      if (requestedKind === 'tool_output' && role !== 'tool') {
        invalid(`chunks[${index}] 的 tool_output 只能用于 tool role`, {
          field: `chunks[${index}].detailKind`,
        });
      }
      const detailKind: RuntimeDetailKind = role === 'tool' ? 'tool_output' : requestedKind;
      const retentionClass: DetailRetentionClass = detailKind === 'tool_output'
        ? 'tool_output'
        : detailKind === 'document_slice' ? 'document_slice' : 'conversation';
      if (input.retentionClass !== undefined && input.retentionClass !== retentionClass) {
        invalid(`chunks[${index}].retentionClass 必须由 role/detailKind 决定，且普通 ingest 不允许 pinned`, {
          field: `chunks[${index}].retentionClass`,
        });
      }
      const mime = enumValue(input.mime, MIMES, `chunks[${index}].mime`, 'text/plain');
      const at = optionalPositiveNumber(input.at, `chunks[${index}].at`) ?? this.now();
      // 调用方 hash 仍校验其输入文本；之后只保留/发送脱敏文本及其新 hash。
      this.contentHashOf(input.contentHash, sha256Hex(originalText), index);
      const redacted = redactText(originalText);
      const text = redacted.text;
      const contentHash = sha256Hex(text);
      const priorRedaction = isObject(input.redaction) && typeof input.redaction.applied === 'boolean'
        ? {
          applied: input.redaction.applied,
          rules: safeRedactionRules(input.redaction.rules),
        }
        : { applied: false, rules: [] as string[] };
      const rules = [...priorRedaction.rules];
      if (redacted.redacted && !rules.includes('builtin_secret')) rules.push('builtin_secret');
      const redaction = { applied: priorRedaction.applied || redacted.redacted, rules };
      const rawMessageId = optionalText(input.messageId, `chunks[${index}].messageId`, 200);
      const messageId = rawMessageId === undefined ? undefined : redactText(rawMessageId).text;
      const turn = optionalNonNegativeInt(input.turn, `chunks[${index}].turn`);
      const chunkIndex = optionalNonNegativeInt(input.chunkIndex, `chunks[${index}].chunkIndex`);
      const id = typeof input.id === 'string' && RAW_CHUNK_ID_RE.test(input.id)
        ? input.id
        : `rc_${sha256Hex([
          context.agentId,
          contentHash,
          chunkIndex ?? -1,
          messageId ?? '',
        ].join('\u0000')).slice(0, 32)}`;
      const expiresAt = optionalPositiveNumber(input.expiresAt, `chunks[${index}].expiresAt`)
        ?? nowPlusHours(this.now(), this.config.detail.stagingHours);

      chunks.push({
        schema: 1,
        id,
        // 真实 threadId 在 stageChunks 前由 deriveThreadId 提供；此处占位，
        // stageChunks 会按最终 threadId 重写。
        threadId: '',
        agentId: context.agentId,
        hostId: this.identity.hostId ?? 'h_local',
        role,
        detailKind,
        retentionClass,
        text,
        mime,
        at,
        ...(messageId !== undefined ? { messageId } : {}),
        ...(turn !== undefined ? { turn } : {}),
        ...(chunkIndex !== undefined ? { chunkIndex } : {}),
        contentHash,
        redaction,
        expiresAt,
      });
    }
    return chunks;
  }

  private contentHashOf(value: unknown, actual: string, index: number): string {
    if (value === undefined || value === null) return actual;
    if (typeof value !== 'string') invalid(`chunks[${index}].contentHash 必须是字符串`);
    const normalized = value.startsWith('sha256:') ? value.slice('sha256:'.length) : value;
    if (!/^[a-f0-9]{64}$/i.test(normalized)) invalid(`chunks[${index}].contentHash 必须是 sha256`);
    if (normalized.toLowerCase() !== actual) {
      throw new SidecarSettlementError('content_hash_mismatch', `chunks[${index}] 的 contentHash 与文本不一致`, {
        status: 400,
      });
    }
    return actual;
  }

  /**
   * 写本地 staging（非权威）。同 thread/message/contentHash 复用已有 id；
   * 写失败只 warning，不阻断记录沉降；成功沉降后由调用方删除。
   */
  private async stageChunks({
    agentId,
    threadId,
    chunks,
    warnings,
  }: {
    agentId: string;
    threadId: string;
    chunks: RawChunk[];
    warnings: string[];
  }): Promise<string[]> {
    if (chunks.length === 0) return [];
    const cloudId = this.cloudKey();
    const existing = await this.local.store.listStagingChunks({ cloudId, agentId, threadId });
    const byMessage = new Map<string, RawChunk>();
    for (const chunk of existing) {
      if (typeof chunk.messageId === 'string' && chunk.messageId.length > 0) {
        byMessage.set(`${chunk.messageId}\u0000${chunk.chunkIndex ?? -1}`, chunk);
      }
    }

    const ids: string[] = [];
    for (const source of chunks) {
      this.lifecycle?.assertAccepting('ingest.staging.chunk');
      const chunk: RawChunk = { ...source, threadId };
      if (chunk.messageId) {
        const previous = byMessage.get(`${chunk.messageId}\u0000${chunk.chunkIndex ?? -1}`);
        if (previous && previous.contentHash === chunk.contentHash) {
          ids.push(previous.id);
          continue;
        }
      }
      try {
        const stored = await this.local.putStagingChunk(cloudId, chunk);
        if (this.lifecycle && !this.lifecycle.acceptsWork()) {
          // 写盘期间 drain 开始：只撤销本次新建的 chunk；duplicate 指向既有 staging，必须保留。
          if (!stored.duplicate) await this.local.clearStaging([stored.chunk.id]).catch(() => 0);
          this.lifecycle.assertAccepting('ingest.staging.chunk.settled');
        }
        ids.push(stored.chunk.id);
        if (stored.duplicate) appendWarnings(warnings, ['duplicate_staging_chunk']);
      } catch (error) {
        if (error instanceof SidecarSettlementError) throw error;
        if ((error as { code?: string })?.code === 'content_hash_mismatch') {
          throw new SidecarSettlementError('content_hash_mismatch', '相同内容哈希对应了不同文本', {
            status: 400,
          });
        }
        throw new SidecarSettlementError('staging_write_failed', '所需 staging 未能持久化', {
          status: 503,
          retryable: true,
        });
      }
    }
    return ids;
  }

  private async assertStagingComplete(
    chunks: RawChunk[],
    stagingChunkIds: string[],
    requireEvidence: boolean,
  ): Promise<void> {
    const persisted = await this.stagedChunksFor(stagingChunkIds);
    if (persisted.length !== chunks.length || persisted.length !== stagingChunkIds.length
      || (requireEvidence && chunks.length === 0)) {
      throw new SidecarSettlementError('staging_write_failed', 'pending 所需的 staging 未完整持久化', {
        status: 503,
        retryable: true,
      });
    }
  }

  private async stagedChunksFor(ids: readonly string[]): Promise<RawChunk[]> {
    const chunks: RawChunk[] = [];
    for (const id of ids.slice(0, MAX_INGEST_CHUNKS)) {
      const chunk = await this.local.store.getStagingChunk(id);
      if (chunk) chunks.push(chunk);
    }
    return chunks.sort((a, b) => a.at - b.at || (a.chunkIndex ?? 0) - (b.chunkIndex ?? 0));
  }

  /** 续租必须沿用取得时的 lease 时长与 owner，禁止回落到 60s 默认值。 */
  private renewReplayLease(item: OutboxItem): Promise<boolean> {
    return this.local.outbox.renewReplayLease(item.id, {
      owner: item.replayLeaseOwner,
      leaseMs: item.replayLeaseMs,
      now: this.now(),
    });
  }

  /** 重放结果收口入口：与 completeExtraction 共享 chain，避免 pending/completed 读改写竞态。 */
  async finalizeReplayedOutbox(
    item: OutboxItem,
    outcome: OutboxReplayCompletion = 'settled',
  ): Promise<void> {
    await this.chain(() => this.finalizeReplayedItem(item, outcome));
  }

  /** 已在 ingest chain 内（如 putStagingChunk 依赖淘汰）时直接收口，不能再进入 chain。 */
  private finalizeReplayedItemDirect(
    item: OutboxItem,
    outcome: OutboxReplayCompletion,
  ): Promise<void> {
    return this.finalizeReplayedItem(item, outcome);
  }

  private async finalizeReplayedItem(
    item: OutboxItem,
    outcome: OutboxReplayCompletion,
  ): Promise<void> {
    const generation = this.stopGeneration;
    if (this.stopped || (this.lifecycle && !this.lifecycle.acceptsWork())) {
      const marker = await this.local.outbox.markNeedsFinalize(item.id, true, {
        outcome,
        owner: item.replayLeaseOwner,
        item,
      }).catch(() => null);
      this.failed += 1;
      this.degraded = true;
      if (!this.lastError || isFinalizeError(this.lastError.code)) {
        this.lastError = nowView(
          this.now(),
          marker?.exhausted ? 'finalize_exhausted' : 'finalize_failed',
          '进程停止时保留待收口 marker',
        );
      }
      await this.refreshFinalizeState();
      return;
    }
    let cleanupFailed = false;
    try {
      await this.finalizeReplayedExtractionsUnlocked(item, outcome, generation);
      const cleared = await this.local.outbox.clearFinalizeMarker(item.id, {
        owner: item.replayLeaseOwner,
      });
      if (!cleared) {
        cleanupFailed = true;
        throw new Error('finalize_marker_cleanup_failed');
      }
      await this.refreshFinalizeState();
    } catch {
      const marker = await this.local.outbox.markNeedsFinalize(item.id, true, {
        outcome,
        owner: item.replayLeaseOwner,
        item,
      }).catch(() => null);
      this.degraded = true;
      this.failed += 1;
      this.lastError = nowView(
        this.now(),
        cleanupFailed
          ? 'finalize_cleanup_failed'
          : marker?.exhausted ? 'finalize_exhausted' : 'finalize_failed',
        cleanupFailed
          ? 'extraction 已收口但 marker 清理失败，保留重试'
          : marker?.exhausted
            ? 'extraction 收口多次失败，等待重启或维护扫描'
            : 'extraction 收口失败，等待重试',
      );
      await this.refreshFinalizeState();
    }
  }

  /** 每次失败/成功都重新扫描 marker，独立计算 pending/exhausted 与 timer。 */
  private async refreshFinalizeState(): Promise<void> {
    const pending = await this.local.outbox.listNeedsFinalize().catch(() => null);
    if (!pending) return;
    this.finalizePending = pending.length;
    this.finalizeExhausted = pending.filter((entry) => entry.exhausted).length;
    if (pending.length === 0) {
      this.clearFinalizeRetryTimer();
      if (this.lastError && isFinalizeError(this.lastError.code)) this.lastError = null;
      const outbox = await this.local.outbox.stats().catch(() => null);
      if (outbox?.items === 0 && this.lastError === null) this.degraded = false;
      return;
    }
    this.degraded = true;
    const exhausted = pending.every((entry) => entry.exhausted);
    if (exhausted) {
      this.clearFinalizeRetryTimer();
      if (!this.lastError || this.lastError.code === 'finalize_failed') {
        this.lastError = nowView(this.now(), 'finalize_exhausted', 'extraction 收口多次失败，等待维护扫描');
      }
      return;
    }
    this.scheduleFinalizeRetry(pending);
  }

  /** 重启/后台有界重试：读取持久化的 needsFinalize 项继续收口。 */
  async reconcileReplayFinalizations(): Promise<number> {
    // drain/dormant 期间不重试收口：marker 已持久化，恢复后再执行。
    if (this.stopped || (this.lifecycle && !this.lifecycle.acceptsWork())) return 0;
    const pending = await this.local.outbox.listNeedsFinalize();
    this.finalizePending = pending.length;
    this.finalizeExhausted = pending.filter((entry) => entry.exhausted).length;
    if (pending.length === 0) {
      await this.refreshFinalizeState();
      return 0;
    }
    let finalized = 0;
    for (const entry of pending) {
      await this.finalizeReplayedOutbox(entry.item, entry.outcome);
      finalized += 1;
    }
    await this.refreshFinalizeState();
    return finalized;
  }

  private scheduleFinalizeRetry(pending: readonly OutboxFinalizeMarker[]): void {
    if (this.stopped || this.finalizeRetryTimer) return;
    const retryable = pending.filter((entry) => !entry.exhausted);
    if (retryable.length === 0) return;
    const minAttempts = Math.min(...retryable.map((entry) => entry.attempts));
    const delay = Math.min(5_000, 100 * 2 ** Math.max(0, Math.min(2, minAttempts - 1)));
    const timer = setTimeout(() => {
      this.finalizeRetryTimer = null;
      void this.reconcileReplayFinalizations().catch(() => undefined);
    }, delay);
    timer.unref?.();
    this.finalizeRetryTimer = timer;
  }

  /**
   * 按所有必需 outbox 依赖的真实状态收口 extraction：
   * - 合并 committed records/detailIds/warnings；
   * - 任一依赖 dead/failed 则 failed；
   * - 仍有 retry/活动依赖则 pending，但已完成状态绝不因旧尝试回退为 pending。
   */
  private async finalizeReplayedExtractionsUnlocked(
    item: OutboxItem,
    outcome: OutboxReplayCompletion,
    generation: number,
  ): Promise<void> {
    const extractionIds = item.meta?.extractionIds ?? [];
    if (extractionIds.length === 0) return;
    const [active, dead] = await Promise.all([
      this.local.outbox.list(),
      this.local.outbox.listDead(),
    ]);
    const current = await this.local.outbox.get(item.id)
      ?? await this.local.outbox.getDead(item.id)
      ?? item;
    if (item.replayLeaseOwner !== undefined
      && current.replayLeaseOwner !== item.replayLeaseOwner) {
      return;
    }
    for (const extractionId of extractionIds) {
        const key = this.extractionCacheKey(extractionId);
        const stored = await this.local.cache.get<StoredExtraction>(key);
        if (!stored || stored.expiresAt <= this.now()) continue;

        const dependencyIds = new Set<string>(stored.outboxIds ?? []);
        for (const entry of [...active, ...dead]) {
          if (entry.meta?.extractionIds?.includes(extractionId)) dependencyIds.add(entry.id);
        }
        dependencyIds.add(current.id);

        // active 优先；同 id 的旧 dead 副本不得覆盖新 attempt。当前成功 attempt
        // 即使 cleanup 已留下 dead 副本，也不能被算作失败依赖。
        const activeById = new Map(active.map((entry) => [entry.id, entry]));
        const deadById = new Map(dead.map((entry) => [entry.id, entry]));
        const effective = new Map<string, { item: OutboxItem; dead: boolean; current: boolean }>();
        for (const id of dependencyIds) {
          if (id === current.id) {
            if (outcome === 'settled') {
              effective.set(id, { item: current, dead: false, current: true });
            } else {
              const activeEntry = activeById.get(id);
              if (activeEntry) {
                effective.set(id, { item: activeEntry, dead: false, current: true });
              } else {
                const deadEntry = deadById.get(id);
                if (deadEntry) effective.set(id, { item: deadEntry, dead: true, current: true });
              }
            }
            continue;
          }
          const activeEntry = activeById.get(id);
          if (activeEntry) {
            effective.set(id, { item: activeEntry, dead: false, current: false });
            continue;
          }
          const deadEntry = deadById.get(id);
          if (deadEntry) effective.set(id, { item: deadEntry, dead: true, current: false });
        }

        const sources = new Map<string, OutboxItem>();
        for (const [id, entry] of effective) sources.set(id, entry.item);
        if (item.committed) {
          sources.set(item.id, {
            ...(sources.get(item.id) ?? item),
            committed: mergeCommittedSources(sources.get(item.id)?.committed, item.committed),
          });
        }
        const otherActive = [...effective.values()].filter((entry) =>
          !entry.current && !entry.dead);
        const deadDeps = [...effective.values()].filter((entry) =>
          !(entry.current && outcome === 'settled') && entry.dead);
        const hasDead = deadDeps.length > 0 || outcome === 'dead';
        const hasActive = outcome === 'retry' || otherActive.length > 0;

        const permanentDetailFailure = hasPermanentDetailFailure(stored);
        let status: StoredExtraction['status'];
        if (stored.status === 'completed') status = 'completed';
        else if (stored.status === 'failed') status = 'failed';
        else if (hasDead || permanentDetailFailure) status = 'failed';
        else if (hasActive) status = 'pending';
        else status = 'completed';

        const records = new Map<string, IngestRecordView>();
        for (const record of stored.records) records.set(record.id, { ...record });
        const detailIds = new Set(stored.detailIds);
        const warnings = new Set(stored.warnings);
        for (const source of sources.values()) {
          for (const record of source.committed?.records ?? []) {
            if (typeof record.id !== 'string' || record.id.length === 0) continue;
            const previous = records.get(record.id);
            records.set(record.id, {
              ...(previous ?? {}),
              id: record.id,
              ...(record.clientItemId ? { clientItemId: record.clientItemId } : {}),
              kind: record.kind ?? previous?.kind ?? 'observation',
              domain: record.domain ?? previous?.domain ?? stored.domain ?? '',
              ...(record.status ? { status: record.status } : {}),
              ...(record.status === 'duplicate' ? { duplicate: true } : {}),
            });
          }
          for (const detail of source.committed?.details ?? []) {
            if (typeof detail.id === 'string' && detail.id.length > 0) detailIds.add(detail.id);
          }
        }
        if (status === 'pending') warnings.add('replay_dependency_pending');
        else warnings.delete('replay_dependency_pending');
        if (hasDead) warnings.add('replay_dead_dependency');
        else warnings.delete('replay_dead_dependency');
        const realWarnings = [...warnings].filter((warning) =>
          warning !== 'replay_dependency_pending' && warning !== 'replay_dead_dependency');

        const ttlMs = stored.expiresAt - this.now();
        // stop/drain 后已执行中的 finalize 不得再写/删 cache；留下 marker 供恢复重试。
        if (this.stopped || generation !== this.stopGeneration
          || (this.lifecycle && !this.lifecycle.acceptsWork())) {
          throw new Error('finalize_interrupted_by_stop');
        }
        if (ttlMs <= 0) {
          await this.local.cache.delete(key);
          continue;
        }
        await this.local.cache.set<StoredExtraction>(key, {
          ...stored,
          status,
          records: [...records.values()],
          detailIds: [...detailIds],
          warnings: [...warnings],
          degraded: status !== 'completed' || (stored.degraded && realWarnings.length > 0),
          outboxIds: [...dependencyIds],
        }, { ttlMs });
    }
  }

  /** 把 outbox 项与 extraction store 双向关联；不依赖 staging，candidate-only ingest 也适用。 */
  private async linkExtractionToOutbox(
    stagingChunkIds: readonly string[],
    extractionId: string,
  ): Promise<void> {
    const wanted = new Set(stagingChunkIds);
    const outboxIds = new Set<string>();
    try {
      for (const item of await this.local.outbox.list()) {
        const linkedByMeta = item.meta?.extractionIds?.includes(extractionId) === true;
        const linkedByStaging = wanted.size > 0
          && (item.meta?.stagingChunkIds ?? []).some((id) => wanted.has(id));
        if (!linkedByMeta && !linkedByStaging) continue;
        await this.local.outbox.linkExtraction(item.id, extractionId);
        outboxIds.add(item.id);
      }
      const key = this.extractionCacheKey(extractionId);
      const stored = await this.local.cache.get<StoredExtraction>(key);
      if (!stored) return;
      const merged = [...new Set([...(stored.outboxIds ?? []), ...outboxIds])];
      if (merged.length === (stored.outboxIds ?? []).length) return;
      const ttlMs = stored.expiresAt - this.now();
      if (ttlMs <= 0) return;
      await this.local.cache.set(key, { ...stored, outboxIds: merged }, { ttlMs });
    } catch {
      // 关联失败只影响后续清理时机，不影响已持久化工作。
    }
  }

  /** 仍在活动 outbox/pending extraction 依赖中的 staging 证据。 */
  private async stagingIdsInUse({
    excludeOutboxId,
    excludeExtractionIds = [],
  }: {
    excludeOutboxId?: string;
    excludeExtractionIds?: readonly string[];
  } = {}): Promise<Set<string>> {
    const inUse = new Set<string>();
    for (const entry of await this.local.outbox.list()) {
      if (entry.id === excludeOutboxId) continue;
      for (const id of entry.meta?.stagingChunkIds ?? []) inUse.add(id);
    }
    const excluded = new Set(excludeExtractionIds);
    const extractions = await this.local.cache.list<StoredExtraction>('extraction:v1:');
    for (const { value } of extractions) {
      if (!value || value.status !== 'pending' || excluded.has(value.id)) continue;
      for (const id of value.stagingChunkIds ?? []) inUse.add(id);
    }
    return inUse;
  }

  private async clearStaging(
    ids: readonly string[],
    warnings: string[],
    options: { excludeExtractionIds?: readonly string[] } = {},
  ): Promise<void> {
    try {
      const inUse = await this.stagingIdsInUse({
        ...(options.excludeExtractionIds ? { excludeExtractionIds: options.excludeExtractionIds } : {}),
      });
      const removable = [...new Set(ids.filter((id) => !inUse.has(id)))];
      if (removable.length === 0) return;
      await this.local.clearStaging(removable);
    } catch {
      appendWarnings(warnings, ['staging_cleanup_failed']);
    }
  }

  /** record/detail 共享证据只有在所有活动 outbox/extraction 依赖结束后才能清理。 */
  private async clearStagingAfterReplay(
    ids: readonly string[],
    excludeItemId: string,
    options: { excludeExtractionIds?: readonly string[]; warnings?: string[] } = {},
  ): Promise<void> {
    try {
      const inUse = await this.stagingIdsInUse({
        excludeOutboxId: excludeItemId,
        ...(options.excludeExtractionIds ? { excludeExtractionIds: options.excludeExtractionIds } : {}),
      });
      const removable = [...new Set(ids.filter((id) => !inUse.has(id)))];
      if (removable.length > 0) await this.local.clearStaging(removable);
    } catch {
      if (options.warnings) appendWarnings(options.warnings, ['staging_cleanup_failed']);
    }
  }

  private async confirmDetail(
    id: string,
    item: CapabilityDetailWriteItem,
    actor: { type: 'agent'; agentId: string; displayName?: string },
  ): Promise<CapabilityDetailRecord> {
    const response = await this.client!.detailGet({
      actor,
      id,
      includeText: false,
      maxBytes: 1,
      ...(item.threadId ? { threadId: item.threadId } : {}),
    });
    const detail = isObject(response.data) && isObject(response.data.detail)
      ? response.data.detail as CapabilityDetailRecord
      : null;
    if (!detail) {
      throw new CapabilityClientError('detail_confirmation_failed', 'Detail 写入后权威回读为空', {
        status: 502,
        retryable: true,
      });
    }
    const recordIds = Array.isArray(detail.recordIds) ? detail.recordIds : [];
    const expired = typeof detail.expiresAt === 'number' && detail.expiresAt > 0 && detail.expiresAt <= this.now();
    const available = detail.deletedAt === undefined || detail.deletedAt === null
      ? !expired && (!Array.isArray(detail.availability) || detail.availability.includes('available'))
      : false;
    const expectedHash = item.contentHash ?? `sha256:${sha256Hex(item.text)}`;
    if (detail.domain !== item.domain
      || detail.detailKind !== item.detailKind
      || (typeof detail.contentHash === 'string' && detail.contentHash !== expectedHash)
      || !item.recordIds.every((recordId) => recordIds.includes(recordId))
      || !available) {
      throw new CapabilityClientError('detail_association_mismatch', 'Detail 权威关联与本次证据不一致', {
        status: 409,
        retryable: false,
        details: { id },
      });
    }
    return detail;
  }

  /**
   * 记录写入成功后写 DetailRecord：
   * - 每个目标 domain 一份（同一文本跨域复制，contentHash 相同、ID 不同）；
   * - `recordIds` 只链接同域、已确认写入的记录；没有可链接记录时不写；
   * - 失败项进入 outbox（`/detail`），不丢记录、不把 staging 当权威；
   * - 成功写/复用后缓存只读详情，供离线展开。
   */
  private async settleDetails({
    chunks,
    records,
    threadId,
    context,
    warnings,
    extractionIds = [],
    touchLease,
  }: {
    chunks: RawChunk[];
    records: IngestRecordView[];
    threadId: string;
    context: CandidateContext;
    warnings: string[];
    extractionIds?: readonly string[];
    touchLease?: () => Promise<void>;
  }): Promise<DetailSettlementOutcome> {
    const linked = records.filter((record) => typeof record.id === 'string' && record.id.length > 0);
    if (chunks.length === 0 || linked.length === 0) {
      return {
        ids: [], written: 0, duplicates: 0, queued: 0, failed: 0,
        warnings: [], queuedRequestIds: [], failures: [],
      };
    }
    const byDomain = new Map<string, Map<string, { chunk: RawChunk; recordIds: string[] }>>();
    let unresolved = false;
    for (const record of linked) {
      const domain = record.domain || context.agentId;
      const evidence = record.clientItemId
        ? context.evidenceByClientItemId?.get(record.clientItemId)
        : undefined;
      const fallback = !evidence && chunks.length === 1
        ? {
          stagingChunkIds: [chunks[0]!.id],
          messageIds: chunks[0]!.messageId ? [chunks[0]!.messageId] : [],
        }
        : evidence;
      const chunkIds = new Set(fallback?.stagingChunkIds ?? []);
      const messageIds = new Set(fallback?.messageIds ?? []);
      const supporting = chunks.filter((chunk) => chunkIds.has(chunk.id)
        || (chunk.messageId !== undefined && messageIds.has(chunk.messageId)));
      if (supporting.length === 0) {
        unresolved = true;
        continue;
      }
      const domainChunks = byDomain.get(domain) ?? new Map<string, { chunk: RawChunk; recordIds: string[] }>();
      for (const chunk of supporting) {
        const entry = domainChunks.get(chunk.id) ?? { chunk, recordIds: [] };
        if (!entry.recordIds.includes(record.id)) entry.recordIds.push(record.id);
        domainChunks.set(chunk.id, entry);
      }
      byDomain.set(domain, domainChunks);
    }
    if (unresolved) appendWarnings(warnings, ['detail_evidence_unresolved']);

    const items: CapabilityDetailWriteItem[] = [];
    const detailChunkIds = new Map<string, string>();
    let oversized = 0;
    for (const [domain, domainChunks] of byDomain) {
      for (const { chunk, recordIds } of domainChunks.values()) {
        if (recordIds.length > MAX_DETAIL_RECORD_IDS) {
          // core/capability 的上限是 200；超限必须显式失败，不能静默截断关联。
          oversized += 1;
          appendWarnings(warnings, ['detail_record_ids_exceeded']);
          continue;
        }
        const redacted = redactText(chunk.text);
        const rules = [...chunk.redaction.rules];
        if (redacted.redacted && !rules.includes('builtin_secret')) rules.push('builtin_secret');
        const detailKind = chunk.detailKind ?? (chunk.role === 'tool' ? 'tool_output' : 'raw_chunk');
        const retentionClass = chunk.retentionClass ?? (detailKind === 'tool_output'
          ? 'tool_output'
          : detailKind === 'document_slice' ? 'document_slice' : 'conversation');
        const expiresAt = retentionClass === 'pinned'
          ? 0
          : this.now() + DETAIL_RETENTION_DAYS[retentionClass] * DAY_MS;
        const clientItemId = detailClientItemId(domain, chunk);
        detailChunkIds.set(clientItemId, chunk.id);
        items.push({
          clientItemId,
          domain,
          detailKind,
          ...(threadId ? { threadId } : {}),
          recordIds: [...recordIds],
          role: chunk.role,
          text: redacted.text,
          mime: chunk.mime,
          ...(chunk.messageId ? { messageId: chunk.messageId } : {}),
          ...(typeof chunk.chunkIndex === 'number' ? { chunkIndex: chunk.chunkIndex } : {}),
          ...(typeof chunk.turn === 'number' ? { turn: chunk.turn } : {}),
          contentHash: `sha256:${sha256Hex(redacted.text)}`,
          redaction: { applied: chunk.redaction.applied || redacted.redacted, rules },
          retentionClass,
          expiresAt,
          provenance: {
            source: context.source,
            extractor: context.extractor,
            ...(context.model ? { model: context.model } : {}),
            agentId: context.agentId,
            ...(context.agentName ? { agentName: context.agentName } : {}),
            ...(threadId ? { threadId } : {}),
            messageIds: chunk.messageId ? [chunk.messageId] : [],
            confirmation: domain === 'user' ? 'explicit' : 'none',
            ...(this.identity.hostId ? { hostId: this.identity.hostId } : {}),
            ...(this.identity.userId ? { userId: this.identity.userId } : {}),
          },
        });
      }
    }

    const outcome: DetailSettlementOutcome = {
      ids: [],
      written: 0,
      duplicates: 0,
      queued: 0,
      failed: oversized,
      warnings: [],
      queuedRequestIds: [],
      failures: Array.from({ length: oversized }, () => ({
        code: 'detail_record_ids_exceeded',
        retryable: false,
      })),
    };
    const actor = {
      type: 'agent' as const,
      agentId: context.agentId,
      ...(context.agentName ? { displayName: context.agentName } : {}),
    };

    for (let offset = 0; offset < items.length; offset += MAX_DETAIL_ITEMS_PER_WRITE) {
      const batch = items.slice(offset, offset + MAX_DETAIL_ITEMS_PER_WRITE);
      const batchStagingIds = [...new Set(batch
        .map((item) => detailChunkIds.get(item.clientItemId))
        .filter((id): id is string => typeof id === 'string'))];
      const requestId = this.detailRequestId(batch);
      if (!this.client) {
        await this.enqueueDetail(requestId, actor, batch, batchStagingIds, outcome, batch.length, extractionIds);
        continue;
      }
      try {
        this.lifecycle?.assertAccepting('ingest.detail.request');
        await touchLease?.();
        const response = await this.client.detailWrite(
          { requestId, actor, items: batch },
          { idempotencyKey: requestId },
        );
        this.assertLifecycleAfterSuccess('ingest.detail.write');
        const data: Record<string, unknown> = isObject(response.data) ? response.data : {};
        const evictedIds = new Set<string>();
        if (Array.isArray(data.evicted)) {
          for (const id of data.evicted) {
            if (typeof id === 'string') evictedIds.add(id);
          }
        }
        // 兼容旧 capability 的结构化 warning；新版以 data.evicted 穿过精简 client。
        const capabilityWarnings = response.warnings as unknown as unknown[];
        for (const warning of capabilityWarnings) {
          if (!isObject(warning) || warning.code !== 'detail_quota_evicted' || !Array.isArray(warning.ids)) continue;
          for (const id of warning.ids) {
            if (typeof id === 'string') evictedIds.add(id);
          }
        }
        for (const id of evictedIds) {
          await this.local.invalidateCachedDetail(id).catch(() => false);
        }
        const results = Array.isArray(data.results) ? data.results : [];
        const resultByClientItemId = new Map<string, Record<string, unknown>>();
        for (const result of results) {
          if (!isObject(result) || typeof result.clientItemId !== 'string') continue;
          resultByClientItemId.set(result.clientItemId, result);
        }
        const failedItems: CapabilityDetailWriteItem[] = [];
        for (const item of batch) {
          const result = resultByClientItemId.get(item.clientItemId);
          if (!result) {
            failedItems.push(item);
            outcome.failures.push({ code: 'detail_write_result_missing', retryable: true });
            appendWarnings(outcome.warnings, ['detail_write_result_missing']);
            continue;
          }
          const status = typeof result.status === 'string' ? result.status : 'failed';
          const id = typeof result.id === 'string' ? result.id : '';
          if ((status === 'created' || status === 'duplicate') && id.length > 0) {
            try {
              await touchLease?.();
              const authoritative = await this.confirmDetail(id, item, actor);
              if (!outcome.ids.includes(id)) outcome.ids.push(id);
              if (status === 'created') {
                outcome.written += 1;
              } else {
                outcome.duplicates += 1;
              }
              // created/duplicate 都使用权威回读更新 cache；duplicate 的 recordIds 已合并。
              await this.cacheDetail(id, result, batch, authoritative);
            } catch (error) {
              const code = error instanceof CapabilityClientError ? error.code : 'detail_confirmation_failed';
              const retryable = retryableCapabilityError(error);
              appendWarnings(outcome.warnings, [`detail_write_failed:${code}`]);
              outcome.failures.push({ code, retryable });
              if (retryable) failedItems.push(item);
              else outcome.failed += 1;
            }
            continue;
          }
          const code = typeof result.code === 'string' ? result.code : 'detail_write_failed';
          if (code === 'capability_disabled' || code === 'mode_mismatch') {
            throw new SidecarSettlementError(
              'mode_mismatch',
              'capability 已撤销：详情写入未提交',
              { status: 409, retryable: false, details: { reason: code } },
            );
          }
          const retryable = result.retryable === true || code === 'detail_quota_exceeded'
            || (status !== 'failed' && status !== 'rejected');
          appendWarnings(outcome.warnings, [`detail_write_failed:${code}`]);
          outcome.failures.push({ code, retryable });
          if (retryable) {
            failedItems.push(item);
          } else {
            outcome.failed += 1;
          }
        }
        const declaredFailed = typeof data.failed === 'number' && data.failed > 0 ? data.failed : 0;
        if (declaredFailed > 0 && outcome.failed === 0 && failedItems.length === 0) {
          outcome.failed = declaredFailed;
          outcome.failures.push({ code: 'detail_write_failed', retryable: false });
          appendWarnings(outcome.warnings, ['detail_write_result_inconsistent']);
        }
        if (failedItems.length > 0) {
          // 重放必须复用原完整批次与 requestId；成功项由 capability 去重。
          await this.enqueueDetail(
            requestId, actor, batch, batchStagingIds, outcome, failedItems.length, extractionIds,
          );
        }
      } catch (error) {
        const code = error instanceof CapabilityClientError ? error.code : 'internal';
        if ((error instanceof CapabilityClientError
            && (error.code === 'capability_disabled' || error.code === 'mode_mismatch'))
          || (this.lifecycle && !this.lifecycle.acceptsWork())) {
          // 生命周期撤销不是详情部分失败：记录已提交也不能把禁用写成 200 partial。
          throw new SidecarSettlementError(
            'mode_mismatch',
            'capability 已撤销：详情写入未提交',
            { status: 409, retryable: false, details: { reason: code } },
          );
        }
        const retryable = retryableCapabilityError(error) || code === 'detail_quota_exceeded';
        appendWarnings(outcome.warnings, [`detail_write_failed:${code}`]);
        outcome.failures.push({ code, retryable });
        if (retryable) {
          await this.enqueueDetail(requestId, actor, batch, batchStagingIds, outcome, batch.length, extractionIds);
        } else {
          outcome.failed += batch.length;
        }
      }
    }
    if (outcome.ids.length > 0 && (outcome.queued > 0 || outcome.failed > 0)) {
      appendWarnings(outcome.warnings, ['detail_partial_settlement']);
    }
    appendWarnings(warnings, outcome.warnings);
    return outcome;
  }

  private async cacheDetail(
    id: string,
    result: Record<string, unknown>,
    batch: CapabilityDetailWriteItem[],
    authoritative: CapabilityDetailRecord,
  ): Promise<void> {
    // drain 后晚到的详情成功不得继续写本地 cache。
    if (this.lifecycle && !this.lifecycle.acceptsWork()) return;
    const clientItemId = typeof result.clientItemId === 'string' ? result.clientItemId : null;
    const item = clientItemId ? batch.find((entry) => entry.clientItemId === clientItemId) : undefined;
    if (!item) return;
    const retentionClass = authoritative.retentionClass ?? item.retentionClass ?? 'conversation';
    const expiresAt = typeof authoritative.expiresAt === 'number' ? authoritative.expiresAt : 0;
    await this.local.putCachedDetail(id, {
      detail: {
        id,
        type: 'detail_record',
        kind: 'detail_record',
        detailKind: authoritative.detailKind ?? item.detailKind,
        domain: authoritative.domain ?? item.domain,
        role: authoritative.role ?? item.role ?? null,
        text: item.text,
        recordIds: [...(authoritative.recordIds ?? item.recordIds)],
        threadId: authoritative.threadId ?? item.threadId ?? null,
        messageId: authoritative.messageId ?? item.messageId ?? null,
        chunkIndex: authoritative.chunkIndex ?? item.chunkIndex ?? 0,
        turn: authoritative.turn ?? item.turn ?? null,
        retentionClass,
        contentHash: authoritative.contentHash ?? item.contentHash ?? `sha256:${sha256Hex(item.text)}`,
        redacted: authoritative.redacted ?? item.redaction?.applied === true,
        expiresAt,
        availability: ['available'],
        provenance: authoritative.provenance ?? item.provenance ?? {},
      },
    }, this.config.detail.cacheDays * DAY_MS);
  }

  private async enqueueDetail(
    requestId: string,
    actor: Record<string, unknown>,
    items: CapabilityDetailWriteItem[],
    stagingChunkIds: string[],
    outcome: DetailSettlementOutcome,
    queuedCount = items.length,
    extractionIds: readonly string[] = [],
  ): Promise<void> {
    this.lifecycle?.assertAccepting('ingest.detail.outbox');
    const body = { requestId, actor, op: 'write', items };
    const id = `ob_${sha256Hex(`${requestId}\u0000detail`).slice(0, 40)}`;
    const detailDeadlines = items
      .map((item) => item.expiresAt)
      .filter((value): value is number => typeof value === 'number' && value > 0);
    const operationExpiresAt = detailDeadlines.length > 0 ? Math.min(...detailDeadlines) : undefined;
    try {
      await this.local.outbox.enqueue({
        id,
        requestId,
        endpoint: '/detail',
        method: 'POST',
        body,
        createdAt: this.now(),
        ...(operationExpiresAt !== undefined ? { expiresAt: operationExpiresAt } : {}),
        meta: {
          kind: 'detail',
          ...(items[0]?.domain ? { domain: items[0].domain } : {}),
          stagingChunkIds: [...stagingChunkIds],
          ...(extractionIds.length > 0 ? { extractionIds: [...new Set(extractionIds)] } : {}),
        },
      });
      outcome.queued += queuedCount;
      outcome.queuedRequestIds.push(requestId);
      appendWarnings(outcome.warnings, ['detail_queued', 'queued_outbox']);
      this.noteQueued({ code: 'detail_queued', message: '详情写入失败，已进入 outbox' });
    } catch (error) {
      if (error instanceof LocalLayerError) {
        if (error.code === 'lifecycle_blocked') {
          throw new SidecarSettlementError(
            'mode_mismatch',
            'Memory Runtime 已休眠：详情未入队',
            { status: 409, retryable: false },
          );
        }
        this.noteSettlementError(error);
        throw new SidecarSettlementError(
          error.code === 'outbox_full' ? 'outbox_full' : 'storage_full',
          safeErrorMessage(error),
          { status: 503, retryable: true },
        );
      }
      throw error;
    }
  }

  private async settle(candidates: RoutedCandidate[], context: CandidateContext): Promise<SettlementOutcome> {
    if (candidates.length === 0) {
      return { records: [], queued: false, failed: 0, degraded: false, warnings: [], status: 'completed' };
    }
    this.lifecycle?.assertAccepting('ingest.write');
    const items = candidates.map((candidate) => toWriteItem(candidate, {
      agentId: context.agentId,
      threadId: context.threadId,
      messageIds: context.messageIds,
      provenance: {
        source: context.source,
        extractor: context.extractor,
        model: context.model,
        ...(context.agentName ? { agentName: context.agentName } : {}),
        messageIds: [],
      },
    }));
    const warnings: string[] = [];
    const supersedes = await this.resolveSupersedes(candidates, context, warnings);
    for (const [index, ids] of supersedes) {
      const item = items[index];
      if (item && ids.length > 0) item.supersedes = ids;
    }
    const actor = {
      type: 'agent' as const,
      agentId: context.agentId,
      ...(context.agentName ? { displayName: context.agentName } : {}),
    };
    const requestId = this.writeRequestId(context.agentId, items);

    if (!this.client) {
      await this.enqueueWriteSafe(requestId, actor, items, context);
      this.noteQueued({ code: 'capability_unavailable', message: 'capability API 不可用，已进入 outbox' });
      return {
        records: [],
        queued: true,
        failed: 0,
        degraded: true,
        warnings: [...warnings, 'capability_unavailable', 'queued_outbox'],
        status: 'pending',
      };
    }

    try {
      this.lifecycle?.assertAccepting('ingest.write.request');
      const response = await this.client.write<Record<string, unknown>>(
        { requestId, actor, items },
        { idempotencyKey: requestId },
      );
      this.assertLifecycleAfterSuccess('ingest.write');
      const data = isObject(response.data) ? response.data : {};
      const results = Array.isArray(data.results) ? data.results : [];
      const records: IngestRecordView[] = [];
      const failedRetryable: CapabilityWriteItem[] = [];
      let permanentFailures = 0;
      const resultByClientItemId = new Map<string, Record<string, unknown>>();
      for (const result of results) {
        if (!isObject(result) || typeof result.clientItemId !== 'string') continue;
        resultByClientItemId.set(result.clientItemId, result);
      }
      for (const item of items) {
        const result = resultByClientItemId.get(item.clientItemId);
        if (!result) {
          failedRetryable.push(item);
          warnings.push('candidate_write_result_missing');
          continue;
        }
        const status = typeof result.status === 'string' ? result.status : 'failed';
        const kind = typeof result.kind === 'string' ? result.kind : 'observation';
        const domain = typeof result.domain === 'string' ? result.domain : '';
        if ((status === 'created' || status === 'duplicate')
          && typeof result.id === 'string' && result.id.length > 0) {
          records.push({
            id: result.id,
            clientItemId: item.clientItemId,
            ...(typeof result.type === 'string' ? { type: result.type } : {}),
            kind,
            domain,
            status,
            ...(status === 'duplicate' ? { duplicate: true } : {}),
            ...(Array.isArray(result.superseded)
              ? { superseded: result.superseded.filter((id: unknown) => typeof id === 'string') }
              : {}),
          });
          continue;
        }
        const code = typeof result.code === 'string' ? result.code : 'candidate_write_failed';
        warnings.push(`candidate_write_failed:${code}`);
        if (result.retryable === true || (status !== 'failed' && status !== 'rejected')) {
          failedRetryable.push(item);
        } else {
          permanentFailures += 1;
        }
      }

      const declaredFailed = typeof data.failed === 'number' && data.failed > 0 ? data.failed : 0;
      if (declaredFailed > 0 && failedRetryable.length === 0 && permanentFailures === 0) {
        permanentFailures = declaredFailed;
        warnings.push('candidate_write_result_inconsistent');
      }
      const queued = failedRetryable.length > 0;
      if (queued) {
        const retryRequestId = this.writeRequestId(context.agentId, failedRetryable);
        await this.enqueueWriteSafe(retryRequestId, actor, failedRetryable, context);
        warnings.push('queued_outbox');
        this.noteQueued({ code: 'capability_unavailable', message: '部分候选已进入 outbox' });
      }
      if (permanentFailures > 0) {
        this.noteFailed({ code: 'candidate_write_failed', message: '部分候选永久失败' });
      }
      if (records.length > 0 && (queued || permanentFailures > 0)) warnings.push('partial_settlement');
      this.noteSettled(records.length);
      if (!queued && permanentFailures === 0) await this.markHealthyIfOutboxEmpty();
      return {
        records,
        queued,
        failed: permanentFailures,
        degraded: queued || permanentFailures > 0 || this.degraded,
        warnings,
        status: queued ? 'pending' : permanentFailures > 0 ? 'failed' : records.length > 0 ? 'completed' : 'failed',
      };
    } catch (error) {
      if (this.lifecycle && !this.lifecycle.acceptsWork()) {
        throw new SidecarSettlementError(
          'mode_mismatch',
          'Memory Runtime 已休眠：写入未结算',
          { status: 409, retryable: false, details: { phase: this.lifecycle.currentPhase } },
        );
      }
      if (error instanceof CapabilityClientError
        && (error.code === 'capability_disabled' || error.code === 'mode_mismatch')) {
        throw new SidecarSettlementError(
          'mode_mismatch',
          'capability 已撤销：写入不再入队',
          { status: 409, retryable: false, details: { reason: error.code } },
        );
      }
      if (retryableCapabilityError(error)) {
        await this.enqueueWriteSafe(requestId, actor, items, context);
        this.noteQueued(error);
        return {
          records: [],
          queued: true,
          failed: 0,
          degraded: true,
          warnings: [...warnings, 'capability_unavailable', 'queued_outbox'],
          status: 'pending',
        };
      }
      this.noteFailed(error);
      const code = error instanceof CapabilityClientError ? error.code : 'internal';
      return {
        records: [],
        queued: false,
        failed: Math.max(1, items.length),
        degraded: true,
        warnings: [...warnings, `candidate_write_failed:${code}`],
        status: 'failed',
      };
    }
  }

  private writeRequestId(agentId: string, items: CapabilityWriteItem[]): string {
    const hash = sha256Hex(`${agentId}\u0000${canonicalJson(items)}`).slice(0, 40);
    return `req_${hash}`;
  }

  private detailRequestId(items: CapabilityDetailWriteItem[]): string {
    const hash = sha256Hex(canonicalJson(items)).slice(0, 40);
    return `req_det_${hash}`;
  }

  private async enqueueWrite(
    requestId: string,
    actor: Record<string, unknown>,
    items: CapabilityWriteItem[],
    context: CandidateContext,
  ): Promise<void> {
    this.lifecycle?.assertAccepting('ingest.write.outbox');
    const id = `ob_${sha256Hex(requestId).slice(0, 40)}`;
    const evidence = context.evidenceByClientItemId
      ? Object.fromEntries([...context.evidenceByClientItemId.entries()].map(([key, value]) => [key, {
        stagingChunkIds: [...value.stagingChunkIds],
        messageIds: [...value.messageIds],
      }]))
      : undefined;
    await this.local.outbox.enqueue({
      id,
      requestId,
      endpoint: '/write',
      method: 'POST',
      body: { requestId, actor, items },
      createdAt: this.now(),
      meta: {
        kind: 'record',
        stagingChunkIds: [...context.stagingChunkIds],
        ...(context.extractionId ? { extractionIds: [context.extractionId] } : {}),
        ...(evidence ? { evidence } : {}),
        ...(context.threadId ? { domain: context.threadId } : {}),
      },
    });
  }

  /** outbox 满/磁盘满必须给宿主明确 503，而不是 500。 */
  private async enqueueWriteSafe(
    requestId: string,
    actor: Record<string, unknown>,
    items: CapabilityWriteItem[],
    context: CandidateContext,
  ): Promise<void> {
    try {
      await this.enqueueWrite(requestId, actor, items, context);
    } catch (error) {
      if (error instanceof LocalLayerError) {
        if (error.code === 'lifecycle_blocked') {
          throw new SidecarSettlementError(
            'mode_mismatch',
            'Memory Runtime 已休眠：写入未入队',
            { status: 409, retryable: false },
          );
        }
        throw new SidecarSettlementError(
          error.code === 'outbox_full' ? 'outbox_full' : 'storage_full',
          error.message,
          { status: 503, retryable: true },
        );
      }
      throw error;
    }
  }

  /** 一次成功沉降后，若 outbox 已清空则恢复健康并清除 lastError。 */
  private async markHealthyIfOutboxEmpty(): Promise<void> {
    const stats = await this.local.outbox.stats();
    if (stats.items === 0) {
      this.degraded = false;
      this.lastError = null;
    }
  }

  private async rememberIdempotent(
    cacheKey: string,
    bodyHash: string,
    status: 200 | 202,
    data: IngestResult,
  ): Promise<void> {
    if (!cacheKey) return;
    try {
      await this.local.cache.set<IdempotencyEntry>(cacheKey, {
        version: 1,
        at: this.now(),
        bodyHash,
        status,
        data,
      }, { ttlMs: this.idempotencyTtlMs });
    } catch {
      // 幂等账本失败不影响已接收数据；内容 hash/clientItemId 仍可防重。
    }
  }

  private extractionCacheKey(id: string): string {
    return `extraction:v1:${id}`;
  }

  private async failExtraction(extraction: StoredExtraction, code: string): Promise<StoredExtraction> {
    // drain 后不覆盖 cache；恢复后由 staging 缺失重新显式失败。
    if (this.lifecycle && !this.lifecycle.acceptsWork()) return extraction;
    const warnings = [...extraction.warnings];
    appendWarnings(warnings, [code]);
    const failed: StoredExtraction = {
      ...extraction,
      status: 'failed',
      records: extraction.records.map((record) => ({ ...record })),
      detailIds: [...extraction.detailIds],
      warnings,
      degraded: true,
    };
    const ttlMs = extraction.expiresAt - this.now();
    if (ttlMs <= 0) {
      await this.local.cache.delete(this.extractionCacheKey(extraction.id));
    } else {
      await this.local.cache.set(this.extractionCacheKey(extraction.id), failed, { ttlMs });
    }
    this.noteFailed({ code, message: '抽取依赖的 staging 已过期' });
    return failed;
  }

  /** 外部维护与 completeExtraction 串行，不能在 I/O 中途删除证据或覆盖最终状态。 */
  async expireStagingDependencies(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.chain(() => this.expireStagingDependenciesUnlocked(ids));
  }

  /** ingest chain 内的配额淘汰使用；调用方已经持有顺序保证。 */
  private async expireStagingDependenciesUnlocked(ids: readonly string[]): Promise<void> {
    const expired = new Set(ids);
    const entries = await this.local.cache.list<StoredExtraction>('extraction:v1:');
    for (const entry of entries) {
      const extraction = entry.value;
      if (!extraction || extraction.status !== 'pending') continue;
      if (!extraction.stagingChunkIds.some((id) => expired.has(id))) continue;
      await this.failExtraction(extraction, 'retention_expired');
    }
  }

  private async saveExtraction(input: {
    id?: string;
    status: 'pending' | 'completed' | 'failed';
    extractor: IngestExtractorKind;
    model?: string;
    records: IngestRecordView[];
    detailIds: string[];
    warnings: string[];
    degraded: boolean;
    agentId: string;
    agentName?: string;
    threadId?: string;
    domain?: string;
    stagingChunkIds: string[];
    messageIds: string[];
    outboxIds?: readonly string[];
    detailFailures?: ReadonlyArray<{ code: string; retryable: boolean }>;
  }): Promise<StoredExtraction> {
    // drain 后晚到的 ingest/finalize 流程不得再写 extraction cache。
    this.lifecycle?.assertAccepting('ingest.extraction.save');
    const now = this.now();
    const extraction: StoredExtraction = {
      version: 1,
      id: input.id ?? `ext_${randomUUID().replace(/-/g, '')}`,
      status: input.status,
      extractor: input.extractor,
      ...(input.model ? { model: input.model } : {}),
      records: input.records.map((record) => ({ ...record })),
      detailIds: [...input.detailIds],
      warnings: [...input.warnings],
      ...(input.detailFailures && input.detailFailures.length > 0
        ? { detailFailures: input.detailFailures.map((failure) => ({ ...failure })) }
        : {}),
      degraded: input.degraded,
      expiresAt: now + this.extractionTtlMs,
      createdAt: now,
      agentId: input.agentId,
      ...(input.agentName ? { agentName: input.agentName } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.domain ? { domain: input.domain } : {}),
      stagingChunkIds: [...input.stagingChunkIds],
      rawChunkIds: [...input.stagingChunkIds],
      messageIds: [...input.messageIds],
      ...(input.outboxIds && input.outboxIds.length > 0
        ? { outboxIds: [...new Set(input.outboxIds)] }
        : {}),
    };
    await this.local.cache.set(this.extractionCacheKey(extraction.id), extraction, {
      ttlMs: this.extractionTtlMs,
    });
    return extraction;
  }

  private async loadExtraction(id: string): Promise<StoredExtraction | null> {
    const stored = await this.local.cache.get<StoredExtraction>(this.extractionCacheKey(id));
    if (!stored || stored.version !== 1 || typeof stored.expiresAt !== 'number') return null;
    if (stored.expiresAt <= this.now()) {
      await this.local.cache.delete(this.extractionCacheKey(id));
      return null;
    }
    return stored;
  }

  private extractionView(extraction: StoredExtraction): IngestExtractionView {
    return {
      id: extraction.id,
      status: extraction.status,
      extractor: extraction.extractor,
      ...(extraction.model ? { model: extraction.model } : {}),
      records: extraction.records.map((record) => ({ ...record })),
      detailIds: [...(extraction.detailIds ?? [])],
      warnings: [...extraction.warnings],
      degraded: extraction.degraded,
      expiresAt: extraction.expiresAt,
    };
  }
}

function isFinalizeError(code: string): boolean {
  return code === 'finalize_failed'
    || code === 'finalize_exhausted'
    || code === 'finalize_cleanup_failed';
}

function hasPermanentDetailFailure(stored: StoredExtraction): boolean {
  const structuredPermanent = Array.isArray(stored.detailFailures)
    && stored.detailFailures.some((failure) => failure.retryable === false);
  if (structuredPermanent) return true;
  const temporaryCodes = new Set([
    'capability_unavailable',
    'timeout',
    'network_error',
    'http_401',
    'http_408',
    'http_429',
    'capability_token_invalid',
    'detail_confirmation_failed',
    'detail_quota_exceeded',
    'outbox_full',
    'storage_full',
    'internal',
  ]);
  for (const warning of stored.warnings) {
    if (warning === 'detail_record_ids_exceeded') return true;
    const match = /^detail_write_failed:(.+)$/.exec(warning);
    if (!match) continue;
    const code = match[1]!;
    if (temporaryCodes.has(code) || /^http_5\d\d$/.test(code)) continue;
    return true;
  }
  return false;
}

function mergeCommittedSources(
  existing: OutboxCommitted | undefined,
  update: OutboxCommitted | undefined,
): OutboxCommitted | undefined {
  if (!existing) return update;
  if (!update) return existing;
  const merge = (
    current: NonNullable<OutboxCommitted['records']> | undefined,
    next: NonNullable<OutboxCommitted['records']> | undefined,
  ) => {
    const merged = new Map<string, NonNullable<OutboxCommitted['records']>[number]>();
    for (const entry of current ?? []) merged.set(entry.id, { ...entry });
    for (const entry of next ?? []) merged.set(entry.id, { ...merged.get(entry.id), ...entry });
    return [...merged.values()];
  };
  return {
    ...(existing.records || update.records ? { records: merge(existing.records, update.records) } : {}),
    ...(existing.details || update.details ? { details: merge(existing.details, update.details) } : {}),
    ...(existing.objects || update.objects ? { objects: merge(existing.objects, update.objects) } : {}),
  };
}

function nowPlusHours(now: number, hours: number): number {
  return now + Math.max(0, hours) * HOUR_MS;
}

function detailClientItemId(domain: string, chunk: RawChunk): string {
  const hash = sha256Hex([
    domain,
    chunk.contentHash,
    chunk.chunkIndex ?? -1,
    chunk.messageId ?? '',
  ].join('\u0000')).slice(0, 40);
  return `det_${hash}`;
}
