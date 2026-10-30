// 记忆沉降：ingest → 本地 Raw（可选）→ 候选 → capability `/write` → 忆云。
//
// W4a 范围：
// - 请求/chunk/candidate 校验与大小/数量限制；
// - requestId / Idempotency-Key 幂等；chunk 内容 hash 与 (threadId,messageId) 去重；
// - capture=local 写 `<home>/memory-runtime/raw`，capture=off 不落盘；
// - 宿主候选直接写；无候选时确定性 heuristic；全非法 422；
// - 域路由与 provenance；禁止跨 Agent 写入；
// - capability 暂不可用时进有界 outbox，成功即删；不做第二权威。
//
// 不实现 recall/context/compact/self/checkpoint；不 import @mebular/core，
// 不打开 GraphStore/EventLog，所有持久记忆只经 capability client 写入。

import { randomUUID } from 'node:crypto';
import { CapabilityClient, CapabilityClientError } from './capability-client.js';
import type { SidecarConfig } from './config.js';
import {
  isValidAgentId,
  isValidThreadId,
  normalizeDomain,
  type SidecarPolicy,
} from './domains.js';
import {
  canonicalJson,
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
import { LocalLayerError, type SidecarLocalLayer } from './local-layer.js';
import type { RawChunk } from '../runtime/types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_INGEST_CHUNKS = 100;
export const IDEMPOTENCY_TTL_MS = DAY_MS;
export const EXTRACTION_TTL_MS = DAY_MS;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{1,200}$/;
const EXTRACTION_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const RAW_CHUNK_ID_RE = /^rc_[A-Za-z0-9]{8,}$/;
const ROLES = ['user', 'assistant', 'system', 'tool'] as const;
const MIMES = ['text/plain', 'text/markdown', 'application/json'] as const;
const CAPTURES = ['off', 'local'] as const;
const EXTRACTORS = ['auto', 'heuristic', 'local', 'host', 'api'] as const;

export type IngestCapture = (typeof CAPTURES)[number];
export type IngestExtractor = (typeof EXTRACTORS)[number];

export interface IngestChunkInput {
  id?: string;
  role?: (typeof ROLES)[number];
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
  capture?: IngestCapture;
  extractor?: IngestExtractor;
  allowRemote?: boolean;
  chunks?: IngestChunkInput[];
  candidates?: unknown[];
  [key: string]: unknown;
}

export interface IngestRecordView {
  id: string;
  type?: string;
  kind: string;
  domain: string;
  status?: string;
  duplicate?: boolean;
}

export interface IngestExtractionView {
  id: string;
  status: 'pending' | 'completed' | 'failed';
  extractor: 'heuristic' | 'host';
  model?: string;
  records: IngestRecordView[];
  warnings: string[];
  degraded: boolean;
  expiresAt?: number;
}

export interface IngestResult {
  accepted: { chunks: number; records: number };
  rawChunkIds: string[];
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
  now?: () => number;
  idempotencyTtlMs?: number;
  extractionTtlMs?: number;
}

interface StoredExtraction {
  version: 1;
  id: string;
  status: 'pending' | 'completed' | 'failed';
  extractor: 'heuristic' | 'host';
  model?: string;
  records: IngestRecordView[];
  warnings: string[];
  degraded: boolean;
  expiresAt: number;
  createdAt: number;
  agentId: string;
  agentName?: string;
  threadId?: string;
  domain?: string;
  capture: IngestCapture;
  rawChunkIds: string[];
  messageIds: string[];
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
  degraded: boolean;
  warnings: string[];
  status: 'completed' | 'pending' | 'failed';
}

interface CandidateContext {
  agentId: string;
  agentName?: string;
  threadId: string | null;
  messageIds: string[];
  rawChunkIds: string[];
  extractor: 'heuristic' | 'host';
  model: string | null;
  source: 'runtime' | 'host';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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

function errorView(error: unknown, at: number): IngestErrorView {
  if (error instanceof SidecarSettlementError) {
    return nowView(at, error.code, error.message);
  }
  if (error instanceof CapabilityClientError) {
    return nowView(at, error.code, error.message);
  }
  if (error instanceof LocalLayerError) {
    return nowView(at, error.code, error.message);
  }
  return nowView(at, 'internal', (error as Error)?.message ?? 'sidecar 内部错误');
}

function retryableCapabilityError(error: unknown): boolean {
  if (error instanceof CapabilityClientError) {
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

  constructor(options: IngestServiceOptions) {
    this.config = options.config;
    this.local = options.local;
    this.client = options.client;
    this.identity = options.identity;
    this.policy = options.policy ?? null;
    this.now = options.now ?? Date.now;
    this.idempotencyTtlMs = options.idempotencyTtlMs ?? IDEMPOTENCY_TTL_MS;
    this.extractionTtlMs = options.extractionTtlMs ?? EXTRACTION_TTL_MS;
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
    };
  }

  /** 启动后调用：已有 outbox 视为仍需重放的降级状态。 */
  async init(): Promise<void> {
    const outbox = await this.local.outbox.stats();
    if (outbox.items > 0) {
      this.degraded = true;
      this.lastError = nowView(this.now(), 'outbox_pending', '存在待重放的沉降请求');
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
    return this.chain(() => this.ingestLocked(request, options));
  }

  private async ingestLocked(
    request: unknown,
    options: { idempotencyKey?: string | null },
  ): Promise<IngestHttpResult> {
    const input = requireObject(request, 'ingest 请求');
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
    const capture = enumValue(input.capture, CAPTURES, 'capture', this.config.capture);
    const extractor = enumValue(input.extractor, EXTRACTORS, 'extractor', 'auto');
    optionalBoolean(input.allowRemote, 'allowRemote');
    const requestDomain = this.domainOf(input.domain);
    const warnings: string[] = [];

    const chunks = this.buildChunks(input.chunks, { agentId, capture });
    const threadId = explicitThreadId ?? this.deriveThreadId(agentId, chunks);

    const rawCandidates = input.candidates;
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

    // 宿主明确要求 host 抽取但没有候选：不偷偷换模型，返回 pending。
    if (routedHost.length === 0 && extractor === 'host') {
      const rawChunkIds = await this.captureRaw({
        agentId,
        threadId,
        capture,
        chunks,
        warnings,
      });
      const extraction = await this.saveExtraction({
        status: 'pending',
        extractor: 'host',
        records: [],
        warnings,
        degraded: false,
        agentId,
        ...(agentName ? { agentName } : {}),
        ...(explicitThreadId ? { threadId: explicitThreadId } : {}),
        ...(requestDomain ? { domain: requestDomain } : {}),
        capture,
        rawChunkIds,
        messageIds: this.messageIdsOf(chunks),
      });
      const data: IngestResult = {
        accepted: { chunks: chunks.length, records: 0 },
        rawChunkIds,
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

    let routed: RoutedCandidate[] = routedHost;
    let resolvedExtractor: 'heuristic' | 'host' = 'host';
    let model: string | null = 'host-provided';
    let degraded = false;

    if (routed.length === 0) {
      if (extractor === 'local' || extractor === 'api') {
        // W4a 不实现模型层：失败只回退 heuristic，不自动换供应商。
        warnings.push('model_unavailable');
        degraded = true;
      }
      const heuristic = heuristicCandidates(chunks.map((chunk) => ({
        role: chunk.role,
        text: chunk.text,
        at: chunk.at,
        threadId,
      })));
      warnings.push(...heuristic.warnings);
      const heuristicInputs: CandidateInput[] = heuristic.candidates.map((candidate) => ({
        kind: candidate.kind,
        content: candidate.content,
        domainHint: null,
        tags: candidate.tags ?? [],
        relatedTo: [],
        confirmation: candidate.confirmation,
      }));
      routed = heuristicInputs.map((candidate) => routeCandidate(candidate, {
        agentId,
        threadId: explicitThreadId,
        requestDomain,
        policy: this.policy,
      }));
      for (const candidate of routed) warnings.push(...candidate.warnings);
      resolvedExtractor = 'heuristic';
      model = null;
    }

    const rawChunkIds = await this.captureRaw({
      agentId,
      threadId,
      capture,
      chunks,
      warnings,
    });

    const context: CandidateContext = {
      agentId,
      ...(agentName ? { agentName } : {}),
      threadId: explicitThreadId,
      messageIds: this.messageIdsOf(chunks),
      rawChunkIds,
      extractor: resolvedExtractor,
      model,
      source: resolvedExtractor === 'host' ? 'host' : 'runtime',
    };

    const outcome = await this.settle(routed, context);
    warnings.push(...outcome.warnings);
    const extractionStatus = outcome.queued
      ? 'pending'
      : outcome.records.length > 0
        ? 'completed'
        : routed.length > 0 ? 'failed' : 'completed';

    const extraction = await this.saveExtraction({
      status: extractionStatus,
      extractor: resolvedExtractor,
      ...(model ? { model } : {}),
      records: outcome.records,
      warnings: [...warnings],
      degraded: degraded || outcome.degraded,
      agentId,
      ...(agentName ? { agentName } : {}),
      ...(explicitThreadId ? { threadId: explicitThreadId } : {}),
      ...(requestDomain ? { domain: requestDomain } : {}),
      capture,
      rawChunkIds,
      messageIds: this.messageIdsOf(chunks),
    });

    const resultDegraded = degraded || outcome.degraded || this.degraded;
    const data: IngestResult = {
      accepted: { chunks: chunks.length, records: outcome.records.length },
      rawChunkIds,
      records: outcome.records,
      extraction: this.extractionView(extraction),
      queued: outcome.queued,
      duplicate: false,
      degraded: resultDegraded,
      warnings: [...warnings],
    };
    const status: 200 | 202 = outcome.queued ? 202 : 200;
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
    return this.chain(async () => {
      if (!EXTRACTION_ID_RE.test(id)) {
        throw new SidecarSettlementError('not_found', '抽取任务不存在或已过期', { status: 404 });
      }
      const extraction = await this.loadExtraction(id);
      if (!extraction) {
        throw new SidecarSettlementError('not_found', '抽取任务不存在或已过期', { status: 404 });
      }
      if (extraction.status === 'completed' && extraction.records.length > 0) {
        return {
          extraction: this.extractionView(extraction),
          queued: false,
          degraded: this.degraded,
          warnings: [...extraction.warnings],
        };
      }
      const checked = validateCandidates(candidates);
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

      const outcome = await this.settle(routed, {
        agentId: extraction.agentId,
        ...(extraction.agentName ? { agentName: extraction.agentName } : {}),
        threadId: extraction.threadId ?? null,
        messageIds: extraction.messageIds,
        rawChunkIds: extraction.rawChunkIds,
        extractor: 'host',
        model: 'host-provided',
        source: 'host',
      });
      warnings.push(...outcome.warnings);
      const updated = await this.saveExtraction({
        ...extraction,
        status: outcome.queued ? 'pending' : outcome.records.length > 0 ? 'completed' : 'failed',
        extractor: 'host',
        model: 'host-provided',
        records: outcome.records,
        warnings,
        degraded: outcome.degraded,
      });
      return {
        extraction: this.extractionView(updated),
        queued: outcome.queued,
        degraded: outcome.degraded || this.degraded,
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

  private cloudKey(): string {
    return this.identity.cloudId ?? 'cl_local';
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

  private buildChunks(raw: unknown, context: { agentId: string; capture: IngestCapture }): RawChunk[] {
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
      const text = input.text;
      if (Buffer.byteLength(text, 'utf8') > this.config.limits.maxChunkBytes) {
        throw new SidecarSettlementError('payload_too_large', `chunks[${index}] 超过 maxChunkBytes`, {
          status: 413,
          details: { maxChunkBytes: this.config.limits.maxChunkBytes },
        });
      }
      const role = enumValue(input.role, ROLES, `chunks[${index}].role`, 'user');
      const mime = enumValue(input.mime, MIMES, `chunks[${index}].mime`, 'text/plain');
      const at = optionalPositiveNumber(input.at, `chunks[${index}].at`) ?? this.now();
      const actualHash = sha256Hex(text);
      const contentHash = this.contentHashOf(input.contentHash, actualHash, index);
      const id = typeof input.id === 'string' && RAW_CHUNK_ID_RE.test(input.id)
        ? input.id
        : `rc_${randomUUID().replace(/-/g, '')}`;
      const redaction = isObject(input.redaction) && typeof input.redaction.applied === 'boolean'
        ? {
          applied: input.redaction.applied,
          rules: Array.isArray(input.redaction.rules)
            ? input.redaction.rules.filter((rule): rule is string => typeof rule === 'string')
            : [],
        }
        : { applied: false, rules: [] };
      const messageId = optionalText(input.messageId, `chunks[${index}].messageId`, 200);
      const turn = optionalNonNegativeInt(input.turn, `chunks[${index}].turn`);
      const chunkIndex = optionalNonNegativeInt(input.chunkIndex, `chunks[${index}].chunkIndex`);
      const expiresAt = optionalPositiveNumber(input.expiresAt, `chunks[${index}].expiresAt`)
        ?? nowPlus(this.now(), this.config.retention.rawDays);

      chunks.push({
        schema: 1,
        id,
        // 真实 threadId 在 captureRaw/route 前由 deriveThreadId 提供；此处占位，
        // captureRaw 会按最终 threadId 重写。
        threadId: '',
        agentId: context.agentId,
        hostId: this.identity.hostId ?? 'h_local',
        role,
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

  private async captureRaw({
    agentId,
    threadId,
    capture,
    chunks,
    warnings,
  }: {
    agentId: string;
    threadId: string;
    capture: IngestCapture;
    chunks: RawChunk[];
    warnings: string[];
  }): Promise<string[]> {
    if (capture !== 'local' || chunks.length === 0) return [];
    const cloudId = this.cloudKey();
    const existing = await this.local.store.listRawChunks({ cloudId, agentId, threadId });
    const byMessage = new Map<string, RawChunk>();
    for (const chunk of existing) {
      if (typeof chunk.messageId === 'string' && chunk.messageId.length > 0) {
        byMessage.set(`${chunk.messageId}\u0000${chunk.chunkIndex ?? -1}`, chunk);
      }
    }

    const ids: string[] = [];
    for (const source of chunks) {
      const chunk: RawChunk = { ...source, threadId };
      if (chunk.messageId) {
        const previous = byMessage.get(`${chunk.messageId}\u0000${chunk.chunkIndex ?? -1}`);
        if (previous && previous.contentHash === chunk.contentHash) {
          ids.push(previous.id);
          continue;
        }
      }
      try {
        const stored = await this.local.store.putRawChunk(cloudId, chunk);
        ids.push(stored.chunk.id);
        if (stored.duplicate) warnings.push('duplicate_raw_chunk');
      } catch (error) {
        if ((error as { code?: string })?.code === 'content_hash_mismatch') {
          throw new SidecarSettlementError('content_hash_mismatch', '相同内容哈希对应了不同文本', {
            status: 400,
          });
        }
        warnings.push('raw_capture_failed');
        break;
      }
    }
    return ids;
  }

  private async settle(candidates: RoutedCandidate[], context: CandidateContext): Promise<SettlementOutcome> {
    if (candidates.length === 0) {
      return { records: [], queued: false, degraded: false, warnings: [], status: 'completed' };
    }
    const items = candidates.map((candidate) => toWriteItem(candidate, {
      agentId: context.agentId,
      threadId: context.threadId,
      messageIds: context.messageIds,
      rawChunkIds: context.rawChunkIds,
      provenance: {
        source: context.source,
        extractor: context.extractor,
        model: context.model,
        ...(context.agentName ? { agentName: context.agentName } : {}),
        messageIds: [],
        rawChunkIds: [],
      },
    }));
    const actor = {
      type: 'agent' as const,
      agentId: context.agentId,
      ...(context.agentName ? { displayName: context.agentName } : {}),
    };
    const requestId = this.writeRequestId(context.agentId, items);

    if (!this.client) {
      await this.enqueueWriteSafe(requestId, actor, items);
      this.noteQueued({ code: 'capability_unavailable', message: 'capability API 不可用，已进入 outbox' });
      return {
        records: [],
        queued: true,
        degraded: true,
        warnings: ['capability_unavailable', 'queued_outbox'],
        status: 'pending',
      };
    }

    try {
      const response = await this.client.write<Record<string, unknown>>(
        { requestId, actor, items },
        { idempotencyKey: requestId },
      );
      const data = isObject(response.data) ? response.data : {};
      const results = Array.isArray(data.results) ? data.results : [];
      const records: IngestRecordView[] = [];
      const warnings: string[] = [];
      const failedRetryable: CapabilityWriteItem[] = [];
      for (const result of results) {
        if (!isObject(result)) continue;
        const status = typeof result.status === 'string' ? result.status : 'failed';
        const kind = typeof result.kind === 'string' ? result.kind : 'observation';
        const domain = typeof result.domain === 'string' ? result.domain : '';
        if (status === 'created' || status === 'duplicate') {
          records.push({
            ...(typeof result.id === 'string' ? { id: result.id } : { id: '' }),
            ...(typeof result.type === 'string' ? { type: result.type } : {}),
            kind,
            domain,
            status,
            ...(status === 'duplicate' ? { duplicate: true } : {}),
          });
          continue;
        }
        const code = typeof result.code === 'string' ? result.code : 'candidate_write_failed';
        warnings.push(`candidate_write_failed:${code}`);
        const clientItemId = typeof result.clientItemId === 'string' ? result.clientItemId : null;
        if (clientItemId && result.retryable === true) {
          const item = items.find((entry) => entry.clientItemId === clientItemId);
          if (item) failedRetryable.push(item);
        }
      }

      const queued = failedRetryable.length > 0;
      if (queued) {
        const retryRequestId = this.writeRequestId(context.agentId, failedRetryable);
        await this.enqueueWriteSafe(retryRequestId, actor, failedRetryable);
        warnings.push('queued_outbox');
        this.noteQueued({ code: 'capability_unavailable', message: '部分候选已进入 outbox' });
      }
      this.noteSettled(records.length);
      if (!queued) await this.markHealthyIfOutboxEmpty();
      return {
        records,
        queued,
        degraded: queued || this.degraded,
        warnings,
        status: queued ? 'pending' : records.length > 0 ? 'completed' : 'failed',
      };
    } catch (error) {
      if (retryableCapabilityError(error)) {
        await this.enqueueWriteSafe(requestId, actor, items);
        this.noteQueued(error);
        return {
          records: [],
          queued: true,
          degraded: true,
          warnings: ['capability_unavailable', 'queued_outbox'],
          status: 'pending',
        };
      }
      this.noteFailed(error);
      const code = error instanceof CapabilityClientError ? error.code : 'internal';
      return {
        records: [],
        queued: false,
        degraded: true,
        warnings: [`candidate_write_failed:${code}`],
        status: 'failed',
      };
    }
  }

  private writeRequestId(agentId: string, items: CapabilityWriteItem[]): string {
    const hash = sha256Hex(`${agentId}\u0000${canonicalJson(items)}`).slice(0, 40);
    return `req_${hash}`;
  }

  private async enqueueWrite(
    requestId: string,
    actor: Record<string, unknown>,
    items: CapabilityWriteItem[],
  ): Promise<void> {
    const id = `ob_${sha256Hex(requestId).slice(0, 40)}`;
    await this.local.outbox.enqueue({
      id,
      requestId,
      endpoint: '/write',
      method: 'POST',
      body: { requestId, actor, items },
      createdAt: this.now(),
    });
  }

  /** outbox 满/磁盘满必须给宿主明确 503，而不是 500。 */
  private async enqueueWriteSafe(
    requestId: string,
    actor: Record<string, unknown>,
    items: CapabilityWriteItem[],
  ): Promise<void> {
    try {
      await this.enqueueWrite(requestId, actor, items);
    } catch (error) {
      if (error instanceof LocalLayerError) {
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

  private async saveExtraction(input: {
    id?: string;
    status: 'pending' | 'completed' | 'failed';
    extractor: 'heuristic' | 'host';
    model?: string;
    records: IngestRecordView[];
    warnings: string[];
    degraded: boolean;
    agentId: string;
    agentName?: string;
    threadId?: string;
    domain?: string;
    capture: IngestCapture;
    rawChunkIds: string[];
    messageIds: string[];
  }): Promise<StoredExtraction> {
    const now = this.now();
    const extraction: StoredExtraction = {
      version: 1,
      id: input.id ?? `ext_${randomUUID().replace(/-/g, '')}`,
      status: input.status,
      extractor: input.extractor,
      ...(input.model ? { model: input.model } : {}),
      records: input.records.map((record) => ({ ...record })),
      warnings: [...input.warnings],
      degraded: input.degraded,
      expiresAt: now + this.extractionTtlMs,
      createdAt: now,
      agentId: input.agentId,
      ...(input.agentName ? { agentName: input.agentName } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.domain ? { domain: input.domain } : {}),
      capture: input.capture,
      rawChunkIds: [...input.rawChunkIds],
      messageIds: [...input.messageIds],
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
      warnings: [...extraction.warnings],
      degraded: extraction.degraded,
      expiresAt: extraction.expiresAt,
    };
  }
}

function nowPlus(now: number, days: number): number {
  return now + Math.max(0, days) * DAY_MS;
}
