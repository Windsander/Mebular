// Compact / SelfRecord / ContextCheckpoint 编排（W4c）。
//
// 全部持久对象经 MCP capability `/internal-object` 写入，再由 MCP/core 同步到忆云：
// - compact：只生成确定性 heuristic 摘要，不改源记录；capability 计算并把 stale；
// - self_record：始终写 `agent:<agentId>`，按 revision 取最大；
// - context_checkpoint：始终写 `task:<threadId>` 或 `default`，revision/lease 由 capability 执行。
//
// sidecar 本地只保存可重建缓存与有界 outbox，不保存权威 checkpoint/self/compact。
// capability 暂不可用时写入 outbox 并返回 202 pending；绝不谎称 committed。
//
// 本模块不 import @mebular/core，不打开 GraphStore/EventLog。

import { CapabilityClientError, type CapabilityClient } from './capability-client.js';
import { canonicalJson, sha256Hex } from './candidates.js';
import type { SidecarConfig } from './config.js';
import {
  agentDomain,
  checkWriteDomain,
  isTaskDomain,
  isValidAgentId,
  isValidThreadId,
  normalizeDomain,
  policyForAgent,
  policyAllows,
  threadIdOfDomain,
  type SidecarPolicy,
} from './domains.js';
import { SidecarSettlementError } from './errors.js';
import { LocalLayerError, type OutboxItem, type OutboxReplayCompletion, type SidecarLocalLayer } from './local-layer.js';
import type { SidecarInferenceProvider } from './inference-provider.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_COMPACT_SOURCES = 200;
const MAX_CAPABILITY_LIMIT = 50;
// 指定 sourceIds 时需要按页扫描域内记录直到找齐；上限防止病态域拖垮请求。
const MAX_COMPACT_SCAN = 1000;
const MAX_SUMMARY_CHARS = 64 * 1024;
const MAX_STATE_BYTES = 256 * 1024;
const MAX_CHECKPOINT_REFERENCE_IDS = 200;
const CHECKPOINT_CONTENT_MODES = new Set(['structured', 'summary_only']);
const DEFAULT_COMPACT_LIMIT = 20;
const RECORD_TYPES = ['fact', 'preference', 'episode', 'observation', 'skill', 'entity'];

export interface ObjectHttpResult<T = unknown> {
  status: 200 | 202;
  data: T;
  warnings: string[];
  degraded: boolean;
}

export interface CompactView {
  id: string;
  type: 'compact';
  kind: 'compact';
  domain: string;
  namespace?: string;
  ownerType?: string;
  ownerId?: string;
  internal: boolean;
  summary: string;
  sourceIds: string[];
  sourceHashes: string[];
  strategy: 'summary' | 'dedupe';
  tokenCount: number | null;
  stale: boolean;
  provenance?: Record<string, unknown>;
  createdAt?: number | null;
  updatedAt?: number | null;
  [key: string]: unknown;
}

export interface CheckpointView {
  id?: string | null;
  type?: 'context_checkpoint';
  kind?: 'context_checkpoint';
  domain: string;
  namespace?: string;
  ownerType?: string;
  ownerId?: string;
  internal?: boolean;
  agentId: string;
  threadId: string;
  revision: number | null;
  schema?: 1 | 2;
  contentMode?: 'structured' | 'summary_only' | null;
  structured?: boolean;
  legacy?: boolean;
  degraded?: boolean;
  state?: Record<string, unknown>;
  summary?: string | null;
  recordIds?: string[];
  detailIds?: string[];
  lease?: { hostId?: string; until?: number } | null;
  updatedBy?: Record<string, unknown> | null;
  expiresAt?: number;
  pending?: boolean;
  queuedAt?: number;
  outboxId?: string;
  requestId?: string;
  source?: 'cloud' | 'cache';
  stale?: boolean;
  provenance?: Record<string, unknown>;
  createdAt?: number | null;
  updatedAt?: number | null;
  [key: string]: unknown;
}

export interface SelfRecordView {
  id?: string | null;
  type?: 'self_record';
  kind?: 'self_record';
  domain: string;
  namespace?: string;
  ownerType?: string;
  ownerId?: string;
  internal?: boolean;
  agentId: string;
  revision: number | null;
  content: Record<string, unknown>;
  record?: Record<string, unknown>;
  pending?: boolean;
  queuedAt?: number;
  outboxId?: string;
  requestId?: string;
  source?: 'cloud' | 'cache';
  stale?: boolean;
  provenance?: Record<string, unknown>;
  createdAt?: number | null;
  updatedAt?: number | null;
  [key: string]: unknown;
}

export interface ObjectStatsSnapshot {
  /** 已确认写入/复用的 compact 数（本 sidecar 生命周期）。 */
  compacts: number;
  /** 已确认写入的 checkpoint 数。 */
  checkpoints: number;
  /** 已确认写入的 SelfRecord 数。 */
  selfRecords: number;
  /** 进入 outbox 的对象写请求数。 */
  queued: number;
  /** 永久失败的对象写请求数。 */
  failed: number;
  degraded: boolean;
  lastError: { code: string; message: string; at: number } | null;
}

export interface SidecarObjectsApi {
  handleCompact(request: unknown): Promise<ObjectHttpResult>;
  getCompact(id: string): Promise<ObjectHttpResult>;
  putCheckpoint(threadId: string, request: unknown): Promise<ObjectHttpResult>;
  getCheckpoint(threadId: string, options?: { agentId?: string | null; sync?: string | null; domain?: string | null }): Promise<ObjectHttpResult>;
  deleteCheckpoint(threadId: string, options?: { agentId?: string | null; sync?: string | null; domain?: string | null }): Promise<ObjectHttpResult>;
  putSelf(agentId: string, request: unknown): Promise<ObjectHttpResult>;
  getSelf(agentId: string): Promise<ObjectHttpResult>;
}

export interface MemoryObjectServiceOptions {
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
  now?: () => number;
}

interface SourceRecord {
  id: string;
  domain: string;
  kind: string;
  content: Record<string, unknown>;
  text: string;
  updatedAt: number | null;
}

interface LoadedSources {
  records: SourceRecord[];
  sourceIds: string[];
  sourceHashes: string[];
  warnings: string[];
  degraded: boolean;
  /** capability 不可达但宿主已给出 sourceIds：只排队恢复元数据，不生成占位摘要。 */
  deferred: boolean;
}

interface ActorContext {
  actor: Record<string, unknown>;
  agentId: string | null;
  agentName?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringArray(value: unknown, field: string, maxItems = MAX_COMPACT_SOURCES): string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) {
    throw new SidecarSettlementError('invalid_request', `${field} 必须是字符串数组`, {
      status: 400,
      details: { field },
    });
  }
  if (value.length > maxItems) {
    throw new SidecarSettlementError('payload_too_large', `${field} 最多 ${maxItems} 项`, {
      status: 413,
      details: { field, maxItems },
    });
  }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > 128) {
      throw new SidecarSettlementError('invalid_request', `${field} 含非法条目`, {
        status: 400,
        details: { field },
      });
    }
    out.push(entry);
  }
  return out;
}

function rejectSyncFields(value: Record<string, unknown>): void {
  const checkpoint = isObject(value.checkpoint) ? value.checkpoint : null;
  const self = isObject(value.self) ? value.self : null;
  if (value.sync !== undefined
    || value['checkpoint.sync'] !== undefined
    || value['self.sync'] !== undefined
    || checkpoint?.sync !== undefined
    || self?.sync !== undefined) {
    throw new SidecarSettlementError(
      'legacy_sync_unsupported',
      '不再支持 sync / checkpoint.sync / self.sync',
      { status: 400, details: { field: 'sync' } },
    );
  }
}

function rejectQuerySync(sync: string | null | undefined): void {
  if (sync !== undefined && sync !== null && sync !== '') {
    throw new SidecarSettlementError(
      'legacy_sync_unsupported',
      '不再支持 sync / checkpoint.sync / self.sync',
      { status: 400, details: { field: 'sync' } },
    );
  }
}

function requireObjectBody(value: unknown): Record<string, unknown> {
  if (!isObject(value)) {
    throw new SidecarSettlementError('invalid_request', '请求体必须是 JSON 对象', { status: 400 });
  }
  return value;
}

function requireAgentId(value: unknown, field = 'agentId'): string {
  if (!isValidAgentId(value)) {
    throw new SidecarSettlementError('invalid_agent_id', `${field} 格式非法`, {
      status: 400,
      details: { field },
    });
  }
  return value;
}

function requireThreadId(value: unknown, field = 'threadId'): string {
  if (!isValidThreadId(value)) {
    throw new SidecarSettlementError('invalid_thread_id', `${field} 格式非法`, {
      status: 400,
      details: { field },
    });
  }
  return value;
}

function requireDomain(value: unknown): string {
  const domain = normalizeDomain(value);
  if (!domain) {
    throw new SidecarSettlementError('domain_invalid', 'domain/namespace 非法', {
      status: 400,
      details: { field: 'domain' },
    });
  }
  return domain;
}

function checkpointStateTask(state: Record<string, unknown>): Record<string, unknown> | null {
  return isObject(state.task) ? state.task : null;
}

function checkpointTaskKey(state: Record<string, unknown>): string | null {
  const task = checkpointStateTask(state);
  return typeof task?.key === 'string' ? task.key : null;
}

function checkpointFleetTaskId(state: Record<string, unknown>, body: Record<string, unknown>): string | null {
  const task = checkpointStateTask(state);
  if (typeof task?.fleetTaskId === 'string' && task.fleetTaskId.length > 0) return task.fleetTaskId;
  if (typeof body.fleetTaskId === 'string' && body.fleetTaskId.length > 0) return body.fleetTaskId;
  if (typeof body.taskId === 'string' && body.taskId.length > 0) return body.taskId;
  return null;
}

function validateCheckpointState(
  state: Record<string, unknown>,
  threadId: string,
): { contentMode: 'structured' | 'summary_only'; fleetTaskId: string | null } {  if (state.schema !== 2) {
    throw new SidecarSettlementError('invalid_request', 'checkpoint state.schema 必须为 2', {
      status: 400,
      details: { field: 'state.schema' },
    });
  }
  const contentMode = typeof state.contentMode === 'string' && CHECKPOINT_CONTENT_MODES.has(state.contentMode)
    ? state.contentMode as 'structured' | 'summary_only'
    : null;
  if (!contentMode) {
    throw new SidecarSettlementError('invalid_request', 'checkpoint state.contentMode 必须是 structured | summary_only', {
      status: 400,
      details: { field: 'state.contentMode' },
    });
  }
  const task = checkpointStateTask(state);
  if (!task) {
    throw new SidecarSettlementError('invalid_request', 'checkpoint state.task 必须是对象', {
      status: 400,
      details: { field: 'state.task' },
    });
  }
  if (typeof task.key !== 'string' || task.key.length === 0) {
    throw new SidecarSettlementError('invalid_request', 'checkpoint state.task.key 必须是非空字符串', {
      status: 400,
      details: { field: 'state.task.key' },
    });
  }
  if (task.threadId !== threadId) {
    throw new SidecarSettlementError('domain_mismatch', 'state.task.threadId 必须等于路径 threadId', {
      status: 400,
      details: { field: 'state.task.threadId', threadId },
    });
  }
  return { contentMode, fleetTaskId: checkpointFleetTaskId(state, {}) };
}

function confirmationOf(value: unknown): 'explicit' | 'policy' | 'none' {
  return value === 'explicit' || value === 'policy' ? value : 'none';
}

function retryableCapabilityError(error: unknown): boolean {
  if (!(error instanceof CapabilityClientError)) return false;
  // 409 revision_mismatch / checkpoint_lease_held 是业务冲突，必须给宿主明确结果，
  // 不能进 outbox 变成“稍后自动覆盖”。
  if (error.status >= 400 && error.status < 500) {
    return error.status === 401 || error.status === 408 || error.status === 429;
  }
  return error.status === 0 || error.status >= 500 || error.retryable;
}

function safeDetails(value: unknown): Record<string, unknown> | undefined {
  if (!isObject(value)) return undefined;
  const allowed = [
    'domain',
    'field',
    'index',
    'id',
    'agentId',
    'threadId',
    'hostId',
    'until',
    'currentRevision',
    'expectedRevision',
    'maxCompactSources',
  ];
  const out: Record<string, unknown> = {};
  for (const key of allowed) {
    const entry = value[key];
    if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean') {
      out[key] = entry;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function errorView(error: unknown, at: number): { code: string; message: string; at: number } {
  if (error instanceof SidecarSettlementError) {
    return { code: error.code, message: error.message, at };
  }
  if (error instanceof CapabilityClientError) {
    return { code: error.code, message: error.message, at };
  }
  return { code: 'internal', message: 'sidecar 内部错误', at };
}

function capabilityError(error: unknown): SidecarSettlementError {
  if (error instanceof SidecarSettlementError) return error;
  if (error instanceof CapabilityClientError) {
    const status = error.status >= 400 && error.status < 600 ? error.status : 503;
    const details = safeDetails(error.details);
    return new SidecarSettlementError(
      error.code || 'capability_error',
      error.message || 'capability 请求失败',
      {
        status,
        retryable: error.retryable,
        ...(details ? { details } : {}),
      },
    );
  }
  return new SidecarSettlementError('internal', 'sidecar 内部错误', { status: 500 });
}

function sourceDomain(record: Record<string, unknown>): string | null {
  return normalizeDomain(record.domain ?? record.namespace);
}

function sourceContent(record: Record<string, unknown>): Record<string, unknown> {
  return isObject(record.content) ? record.content : {};
}

function textOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** 从 capability MemoryRecord 视图提取确定性 gist；不调用模型。 */
export function recordSummaryText(record: Record<string, unknown>): string {
  const content = sourceContent(record);
  const kind = optionalString(record.kind) ?? optionalString(record.type) ?? 'record';
  const explicit = textOf(record.text);
  switch (kind) {
    case 'preference': {
      const entity = textOf(content.entity);
      const preferenceType = textOf(content.preferenceType);
      const value = textOf(content.value);
      if (entity || preferenceType || value) {
        return [entity, preferenceType ? `${preferenceType}=${value ?? ''}` : value].filter(Boolean).join(' ');
      }
      return explicit ?? '';
    }
    case 'fact':
    case 'observation': {
      const subject = textOf(content.subject);
      const predicate = textOf(content.predicate);
      const object = textOf(content.object);
      if (subject && predicate && object) return `${subject} ${predicate} ${object}`;
      return textOf(content.content) ?? explicit ?? '';
    }
    case 'episode':
      return textOf(content.title) ?? textOf(content.summary) ?? textOf(content.content) ?? explicit ?? '';
    case 'skill': {
      const name = textOf(content.name) ?? '';
      const description = textOf(content.description) ?? '';
      return description ? `${name}：${description}` : name || explicit || '';
    }
    case 'entity': {
      const name = textOf(content.name) ?? '';
      const description = textOf(content.description) ?? '';
      return description ? `${name}：${description}` : name || explicit || '';
    }
    default:
      return explicit ?? textOf(content.content) ?? JSON.stringify(content);
  }
}

function clip(value: string, maxChars: number): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length <= maxChars ? compact : `${compact.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function estimateTokens(text: string): number {
  // heuristic：按字符数估算，不调用模型；确定性且与本地模型无关。
  return Math.max(1, Math.ceil([...text].length / 4));
}

/** `expiresAt=0` 表示无自动过期；只过滤显式且已到的过期时间。 */
function checkpointExpiredView(view: Record<string, unknown>, at: number): boolean {
  const expiresAt = typeof view.expiresAt === 'number' ? view.expiresAt : 0;
  return expiresAt > 0 && expiresAt < at;
}

export interface CompactSummaryResult {
  summary: string;
  tokenCount: number;
  hashesById: Map<string, string>;
}

/** 确定性 heuristic 摘要；相同输入总是产生相同 summary/tokenCount/sourceHashes。 */
export function buildCompactSummary(
  records: Array<Record<string, unknown>>,
  strategy: 'summary' | 'dedupe' = 'summary',
): CompactSummaryResult {
  const sorted = [...records].sort((a, b) => String(a.id ?? '').localeCompare(String(b.id ?? '')));
  const hashesById = new Map<string, string>();
  const lines: string[] = [];
  const seen = new Set<string>();
  const kinds = new Map<string, number>();
  for (const record of sorted) {
    const id = optionalString(record.id);
    if (!id) continue;
    const content = sourceContent(record);
    hashesById.set(id, `sha256:${sha256Hex(canonicalJson(content))}`);
    const kind = optionalString(record.kind) ?? optionalString(record.type) ?? 'record';
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    if (Object.keys(content).length === 0) continue;
    const text = clip(recordSummaryText(record), 240);
    if (text.length === 0) continue;
    if (strategy === 'dedupe') {
      const key = text.toLocaleLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
    }
    lines.push(`- [${kind}] ${text}`);
  }
  const kindSummary = [...kinds.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([kind, count]) => `${kind}:${count}`)
    .join(' ');
  const header = `Compact · ${sorted.length} records${kindSummary ? ` · ${kindSummary}` : ''}`;
  const summary = (lines.length > 0 ? `${header}\n${lines.join('\n')}` : header).slice(0, MAX_SUMMARY_CHARS);
  return { summary, tokenCount: estimateTokens(summary), hashesById };
}

function outboxItemId(requestId: string): string {
  return `ob_${sha256Hex(requestId).slice(0, 40)}`;
}

class KeyedSerial {
  private tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(task);
    this.tails.set(key, run);
    return run.finally(() => {
      if (this.tails.get(key) === run) this.tails.delete(key);
    });
  }
}

export class MemoryObjectService implements SidecarObjectsApi {
  readonly config: SidecarConfig;
  readonly local: SidecarLocalLayer;
  readonly identity: MemoryObjectServiceOptions['identity'];

  private readonly client: CapabilityClient | null;
  private readonly models: SidecarInferenceProvider | null;
  private readonly now: () => number;
  private readonly serial = new KeyedSerial();
  private policy: SidecarPolicy;
  private counts = { compacts: 0, checkpoints: 0, selfRecords: 0, queued: 0, failed: 0 };
  private degraded = false;
  private lastError: ObjectStatsSnapshot['lastError'] = null;

  constructor(options: MemoryObjectServiceOptions) {
    this.config = options.config;
    this.local = options.local;
    this.client = options.client;
    this.models = options.inference ?? null;
    this.identity = options.identity;
    this.policy = options.policy ?? { schema: 1, agents: {} };
    this.now = options.now ?? Date.now;
  }

  setPolicy(policy: SidecarPolicy): void {
    this.policy = policy;
  }

  get isDegraded(): boolean {
    return this.degraded || this.counts.queued > 0;
  }

  stats(): ObjectStatsSnapshot {
    return {
      ...this.counts,
      degraded: this.isDegraded,
      lastError: this.lastError,
    };
  }

  /** outbox 重放后同步降级状态；对象服务不直接读图，只跟随 outbox 深度。 */
  applyReplaySummary(summary: { settled: number; remaining: number }): void {
    if (summary.remaining === 0) {
      this.degraded = false;
      this.counts.queued = 0;
      if (summary.settled > 0) this.lastError = null;
      void this.reconcilePendingObjectCaches();
      return;
    }
    this.counts.queued = summary.remaining;
  }

  private async reconcilePendingObjectCaches(): Promise<void> {
    try {
      // 先取 pending 快照，再取 outbox 活动/死信快照：任何快照后新建的 pending
      // 都不会出现在第一份列表里，避免 stats 竞态误删。
      const entries = await this.local.cache.list<{ outboxId?: string; requestId?: string; queuedAt?: number }>('object:v1:pending/');
      const active = await this.local.outbox.list();
      const dead = await this.local.outbox.listDead();
      const activeIds = new Set(active.map((item) => item.id));
      const deadIds = new Set(dead.map((item) => item.id));
      for (const entry of entries) {
        const pending = entry.value ?? {};
        const outboxId = typeof pending.outboxId === 'string' ? pending.outboxId : null;
        const requestId = typeof pending.requestId === 'string' ? pending.requestId : null;
        if (!outboxId && !requestId) continue;
        // 仍在活动队列（包括 skipped/retry）时保留 pending。
        if (outboxId && activeIds.has(outboxId)) continue;
        if (requestId && active.some((item) => item.requestId === requestId)) continue;
        // 只有确认在 dead 中，或已从活动队列消失且不是 skipped 的旧条目才清理。
        if (outboxId && deadIds.has(outboxId)) {
          await this.cacheDelete(entry.key);
          continue;
        }
        if (requestId && dead.some((item) => item.requestId === requestId)) {
          await this.cacheDelete(entry.key);
          continue;
        }
        // 不在 active/dead：只可能是已 settled 或显式 purge；按 queuedAt 旧于
        // 本次快照开始时间才清，避免误伤快照之后的新 pending。
        if (typeof pending.queuedAt === 'number' && pending.queuedAt <= this.now()) {
          await this.cacheDelete(entry.key);
        }
      }
    } catch {
      // 清缓存失败不影响 outbox 终态；下一次重放/维护继续。
    }
  }

  /**
   * outbox 条目终态回调：dead/skipped 后必须清掉 pending 视图，
   * 避免离线 GET 永久显示一个已经不会再重放的 pending。
   */
  async applyReplayComplete(item: OutboxItem, outcome: OutboxReplayCompletion): Promise<void> {
    // skipped 不是终态：条目仍在活动 outbox，不得清 pending。
    if (outcome !== 'dead') return;
    if (item.endpoint !== '/internal-object') return;
    const body = isObject(item.body) ? item.body : null;
    if (!body) return;
    const matches = (pending: { outboxId?: string; requestId?: string } | null): boolean => Boolean(pending)
      && ((typeof pending!.outboxId === 'string' && pending!.outboxId === item.id)
        || (typeof pending!.requestId === 'string' && pending!.requestId === item.requestId));
    if (body.kind === 'context_checkpoint') {
      const agentId = typeof body.agentId === 'string' ? body.agentId : null;
      const threadId = typeof body.threadId === 'string' ? body.threadId : null;
      const domain = typeof body.domain === 'string' ? body.domain : null;
      if (agentId && threadId) {
        const key = this.checkpointPendingCacheKey(agentId, threadId, domain);
        const pending = await this.cacheGet<CheckpointView>(key);
        if (matches(pending)) await this.cacheDelete(key);
      }
      return;
    }
    if (body.kind === 'self_record' && typeof body.agentId === 'string') {
      const key = this.selfPendingCacheKey(body.agentId);
      const pending = await this.cacheGet<SelfRecordView>(key);
      if (matches(pending)) await this.cacheDelete(key);
    }
  }

  /**
   * outbox 补写成功后回填只读缓存与计数。
   * 这里只接受 capability 返回的对象视图，不改变任何权威 revision。
   */
  async applyReplayedItem(item: OutboxItem, data: unknown): Promise<void> {
    if (item.endpoint !== '/internal-object' || !isObject(data) || !isObject(data.object)) return;
    const body = isObject(item.body) ? item.body : null;
    const kind = body?.kind;
    const object = data.object;
    if (kind === 'compact') {
      const view = object as unknown as CompactView;
      if (typeof view.id !== 'string' || view.id.length === 0) return;
      this.counts.compacts += 1;
      await this.cacheSet(this.compactCacheKey(view.id), object);
      return;
    }
    if (kind === 'self_record') {
      const agentId = typeof object.agentId === 'string' ? object.agentId : body?.agentId;
      if (typeof agentId !== 'string' || agentId.length === 0) return;
      const view = this.selfView(object, { source: 'cloud' });
      this.counts.selfRecords += 1;
      await this.cacheSet(this.selfCacheKey(agentId), view);
      await this.cacheDelete(this.selfPendingCacheKey(agentId));
      return;
    }
    if (kind === 'context_checkpoint') {
      const agentId = typeof object.agentId === 'string' ? object.agentId : body?.agentId;
      const threadId = typeof object.threadId === 'string' ? object.threadId : body?.threadId;
      if (typeof agentId !== 'string' || typeof threadId !== 'string') return;
      const view = this.checkpointView(object, { source: 'cloud' });
      this.counts.checkpoints += 1;
      await this.cacheSet(this.checkpointCacheKey(agentId, threadId, view.domain), view);
      await this.cacheDelete(this.checkpointPendingCacheKey(agentId, threadId, view.domain));
    }
  }

  private cacheTtlMs(): number {
    const days = Number.isFinite(this.config.retention.checkpointDays)
      ? Math.max(1, Math.floor(this.config.retention.checkpointDays))
      : 30;
    return days * DAY_MS;
  }

  private async cacheGet<T>(key: string): Promise<T | null> {
    try {
      return await this.local.cache.get<T>(key);
    } catch {
      return null;
    }
  }

  private async cacheSet(key: string, value: unknown): Promise<void> {
    try {
      await this.local.cache.set(key, value, { ttlMs: this.cacheTtlMs() });
    } catch {
      // 缓存失败不影响已确认/已入 outbox 的写入。
    }
  }

  private async cacheDelete(key: string): Promise<void> {
    try {
      await this.local.cache.delete(key);
    } catch {
      // ignore
    }
  }

  private compactCacheKey(id: string): string {
    return `object:v1:compact:${id}`;
  }

  private checkpointCacheKey(agentId: string, threadId: string, domain?: string | null): string {
    return domain && domain.startsWith('task:')
      ? `object:v1:checkpoint:${domain}`
      : `object:v1:checkpoint:${agentId}:${threadId}`;
  }

  private checkpointPendingCacheKey(agentId: string, threadId: string, domain?: string | null): string {
    // 使用 `/` 分隔的独立前缀：threadId 允许 `:`，不能靠 `:pending` 后缀区分。
    return domain && domain.startsWith('task:')
      ? `object:v1:pending/checkpoint/${domain}`
      : `object:v1:pending/checkpoint/${agentId}/${threadId}`;
  }

  private selfCacheKey(agentId: string): string {
    return `object:v1:self:${agentId}`;
  }

  private selfPendingCacheKey(agentId: string): string {
    return `object:v1:pending/self/${agentId}`;
  }

  private noteQueued(error: unknown): void {
    this.degraded = true;
    this.counts.queued += 1;
    this.lastError = errorView(error, this.now());
  }

  private noteFailed(error: unknown): void {
    this.counts.failed += 1;
    this.lastError = errorView(error, this.now());
  }

  private noteReadDegraded(error: unknown): void {
    this.degraded = true;
    this.lastError = errorView(error, this.now());
  }

  private async markHealthyIfOutboxEmpty(): Promise<void> {
    try {
      const stats = await this.local.outbox.stats();
      if (stats.items === 0) {
        this.degraded = false;
        this.counts.queued = 0;
        this.lastError = null;
      }
    } catch {
      // ignore
    }
  }

  private async enqueueObject(requestId: string, body: Record<string, unknown>): Promise<void> {
    const id = outboxItemId(requestId);
    try {
      await this.local.outbox.enqueue({
        id,
        requestId,
        endpoint: '/internal-object',
        method: 'POST',
        body,
        createdAt: this.now(),
        ...(typeof body.expiresAt === 'number' && Number.isFinite(body.expiresAt) && body.expiresAt > 0
          ? { expiresAt: body.expiresAt }
          : {}),
      });
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

  private actorForAgent(agentId: string, agentName?: string | null): ActorContext {
    return {
      actor: {
        type: 'agent',
        agentId,
        ...(agentName ? { displayName: agentName } : {}),
      },
      agentId,
      ...(agentName ? { agentName } : {}),
    };
  }

  private actorForUser(): ActorContext {
    const userId = typeof this.identity.userId === 'string' && /^u_[A-Za-z0-9._:-]{1,128}$/.test(this.identity.userId)
      ? this.identity.userId
      : null;
    return {
      actor: { type: 'user', ...(userId ? { userId } : {}) },
      agentId: null,
    };
  }

  private parseActorAlias(
    body: Record<string, unknown>,
    expectedAgentId: string | null,
  ): { agentId: string | null; agentName: string | null } {
    const bodyAgent = body.agentId === undefined || body.agentId === null
      ? null
      : requireAgentId(body.agentId);
    let aliasAgent: string | null = null;
    let aliasName: string | null = null;
    if (body.actor !== undefined) {
      if (!isObject(body.actor) || body.actor.type !== 'agent') {
        throw new SidecarSettlementError('invalid_request', 'actor 只接受 {type:"agent", agentId}', {
          status: 400,
          details: { field: 'actor' },
        });
      }
      aliasAgent = requireAgentId(body.actor.agentId);
      aliasName = optionalString(body.actor.displayName);
    }
    const effective = bodyAgent ?? aliasAgent;
    if (expectedAgentId !== null) {
      if (effective !== null && effective !== expectedAgentId) {
        throw new SidecarSettlementError('forbidden_scope', 'Agent 不能读写其他 Agent 的对象', {
          status: 403,
          details: { agentId: effective },
        });
      }
      if (aliasAgent !== null && aliasAgent !== expectedAgentId) {
        throw new SidecarSettlementError('forbidden_scope', 'Agent 不能读写其他 Agent 的对象', {
          status: 403,
          details: { agentId: aliasAgent },
        });
      }
      return { agentId: expectedAgentId, agentName: aliasName };
    }
    if (bodyAgent && aliasAgent && bodyAgent !== aliasAgent) {
      throw new SidecarSettlementError('invalid_request', 'actor 与 agentId 不一致', {
        status: 400,
        details: { field: 'actor' },
      });
    }
    return { agentId: effective, agentName: aliasName };
  }

  private assertWrite(
    actor: ActorContext,
    domain: string,
    { threadId, confirmation }: { threadId?: string | null; confirmation?: 'explicit' | 'policy' | 'none' } = {},
  ): void {
    if (!actor.agentId) return;
    const result = checkWriteDomain(this.policy, {
      agentId: actor.agentId,
      threadId: threadId ?? null,
      domain,
      confirmation: confirmation ?? 'none',
    });
    if (result.allowed) return;
    throw new SidecarSettlementError(
      result.code ?? 'domain_write_forbidden',
      result.reason ?? '当前 Agent 不能写入该域',
      {
        status: result.code === 'domain_mismatch' ? 400 : 403,
        details: {
          domain,
          ...(result.allowedDomain ? { allowedDomain: result.allowedDomain } : {}),
        },
      },
    );
  }

  private assertRead(actor: ActorContext, domain: string, threadId?: string | null): void {
    if (!actor.agentId) return;
    const entry = policyForAgent(this.policy, actor.agentId);
    const allowed = isTaskDomain(domain)
      ? policyAllows(entry.readDomains, domain, { threadId: threadId ?? threadIdOfDomain(domain) })
      : policyAllows(entry.readDomains, domain);
    if (!allowed) {
      throw new SidecarSettlementError('forbidden_scope', '当前 Agent 不能读取该域', {
        status: 403,
        details: { domain },
      });
    }
  }

  private async capabilityQueryRecords(
    actor: ActorContext,
    domain: string,
    limit: number,
    wantedIds?: ReadonlySet<string>,
  ): Promise<{ records: Array<Record<string, unknown>>; warnings: string[]; degraded: boolean }> {
    if (!this.client) {
      throw new SidecarSettlementError('capability_unavailable', 'capability API 不可用', {
        status: 503,
        retryable: true,
      });
    }
    const warnings: string[] = [];
    let degraded = false;
    const out: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();
    const target = wantedIds
      ? MAX_COMPACT_SCAN
      : Math.min(MAX_COMPACT_SOURCES, Math.max(1, Math.floor(limit)));
    for (let offset = 0; offset < target; offset += MAX_CAPABILITY_LIMIT) {
      const pageLimit = Math.min(MAX_CAPABILITY_LIMIT, target - offset);
      const response = await this.client.query<Record<string, unknown>>({
        actor: actor.actor,
        domains: [domain],
        types: RECORD_TYPES,
        limit: pageLimit,
        offset,
        includeHistory: false,
        includeArchived: false,
      });
      for (const warning of response.warnings) {
        if (!warnings.includes(warning)) warnings.push(warning);
      }
      if (response.degraded) degraded = true;
      const page = Array.isArray(response.data.records) ? response.data.records : [];
      for (const entry of page) {
        if (!isObject(entry)) continue;
        const id = optionalString(entry.id);
        if (!id || seen.has(id)) continue;
        if (sourceDomain(entry) !== domain) continue;
        seen.add(id);
        out.push(entry);
      }
      if (wantedIds && [...wantedIds].every((id) => seen.has(id))) break;
      if (page.length < pageLimit) break;
    }
    return { records: out, warnings, degraded };
  }

  private async loadCompactSources(
    actor: ActorContext,
    domain: string,
    sourceIds: string[] | null,
    limit: number,
  ): Promise<LoadedSources> {
    const warnings: string[] = [];
    let degraded = false;
    let records: Array<Record<string, unknown>> = [];
    let deferred = false;
    try {
      const fetched = await this.capabilityQueryRecords(
        actor,
        domain,
        sourceIds ? Math.max(sourceIds.length, 1) : limit,
        sourceIds ? new Set(sourceIds) : undefined,
      );
      records = fetched.records;
      warnings.push(...fetched.warnings);
      degraded = fetched.degraded;
    } catch (error) {
      // 没有显式 sourceIds 时离线选择来源必须失败；不得用占位摘要排队。
      if (!sourceIds || !retryableCapabilityError(error)) throw capabilityError(error);
      // capability 不可用但宿主已给出 sourceIds：只持久化恢复元数据，
      // 恢复后由 capability 重新读取来源、生成真实摘要并一次写入。
      warnings.push('capability_unavailable', 'compact_deferred');
      degraded = true;
      deferred = true;
    }

    const byId = new Map<string, SourceRecord>();
    for (const record of records) {
      const id = optionalString(record.id);
      if (!id) continue;
      const recordDomain = sourceDomain(record);
      if (recordDomain !== domain) continue;
      byId.set(id, {
        id,
        domain,
        kind: optionalString(record.kind) ?? optionalString(record.type) ?? 'record',
        content: sourceContent(record),
        text: recordSummaryText(record),
        updatedAt: optionalNumber(record.updatedAt),
      });
    }

    if (sourceIds && deferred && byId.size === 0) {
      return {
        records: [],
        sourceIds: [...sourceIds],
        sourceHashes: [],
        warnings,
        degraded,
        deferred: true,
      };
    }

    if (sourceIds) {
      const missing = sourceIds.filter((id) => !byId.has(id));
      if (missing.length > 0) {
        // 在请求域内找不到全部来源：按契约拒绝跨域 compact；不泄漏源内容。
        throw new SidecarSettlementError(
          'domain_mismatch',
          'compact 来源不存在或不在同一域',
          {
            status: 400,
            details: { domain, sourceIds: missing.slice(0, 20) },
          },
        );
      }
      const ordered = sourceIds.map((id) => byId.get(id)!);
      const hashes = ordered.map((record) => `sha256:${sha256Hex(canonicalJson(record.content))}`);
      return {
        records: ordered,
        sourceIds: [...sourceIds],
        sourceHashes: hashes,
        warnings,
        degraded,
        deferred: false,
      };
    }

    const sorted = [...byId.values()].sort((a, b) => {
      const updated = (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
      return updated !== 0 ? updated : a.id.localeCompare(b.id);
    }).slice(0, limit);
    if (sorted.length === 0) {
      throw new SidecarSettlementError('validation_failed', '没有可压缩的记录', {
        status: 422,
        details: { domain },
      });
    }
    return {
      records: sorted,
      sourceIds: sorted.map((record) => record.id),
      sourceHashes: sorted.map((record) => `sha256:${sha256Hex(canonicalJson(record.content))}`),
      warnings,
      degraded,
      deferred: false,
    };
  }

  private compactRequestId(input: {
    domain: string;
    strategy: 'summary' | 'dedupe';
    sourceIds: string[];
    sourceHashes: string[];
  }): string {
    return `req_${sha256Hex(canonicalJson({
      kind: 'compact',
      domain: input.domain,
      strategy: input.strategy,
      sourceIds: [...input.sourceIds].sort(),
      sourceHashes: input.sourceHashes,
    })).slice(0, 40)}`;
  }

  async handleCompact(request: unknown): Promise<ObjectHttpResult> {
    const body = requireObjectBody(request);
    rejectSyncFields(body);
    const parsedActor = this.parseActorAlias(body, null);
    const actor = parsedActor.agentId
      ? this.actorForAgent(parsedActor.agentId, parsedActor.agentName)
      : this.actorForUser();

    const requestedDomain = body.domain ?? body.namespace;
    if (requestedDomain === undefined || requestedDomain === null) {
      throw new SidecarSettlementError('domain_invalid', 'compact 需要 domain/namespace', {
        status: 400,
        details: { field: 'domain' },
      });
    }
    const domain = requireDomain(requestedDomain);
    if (domain === 'system') {
      throw new SidecarSettlementError('forbidden_scope', 'system 域只允许 admin 维护', {
        status: 403,
        details: { domain },
      });
    }
    if (body.domain !== undefined && body.namespace !== undefined
      && body.domain !== body.namespace
      && requireDomain(body.namespace) !== domain) {
      throw new SidecarSettlementError('domain_mismatch', 'domain 与 namespace 不一致', {
        status: 400,
        details: { domain },
      });
    }
    const threadId = body.threadId === undefined || body.threadId === null
      ? (isTaskDomain(domain) ? threadIdOfDomain(domain) : null)
      : requireThreadId(body.threadId);
    if (isTaskDomain(domain) && threadId !== threadIdOfDomain(domain)) {
      throw new SidecarSettlementError('domain_mismatch', '任务域必须与 threadId 一致', {
        status: 400,
        details: { domain },
      });
    }
    this.assertWrite(actor, domain, {
      threadId,
      confirmation: confirmationOf(body.confirmation),
    });

    const strategy = body.strategy === undefined
      ? 'summary'
      : body.strategy === 'summary' || body.strategy === 'dedupe'
        ? body.strategy
        : (() => {
          throw new SidecarSettlementError('invalid_request', 'strategy 必须是 summary | dedupe', {
            status: 400,
            details: { field: 'strategy' },
          });
        })();
    const limitValue = body.limit === undefined || body.limit === null
      ? DEFAULT_COMPACT_LIMIT
      : body.limit;
    if (typeof limitValue !== 'number' || !Number.isInteger(limitValue) || limitValue < 1) {
      throw new SidecarSettlementError('invalid_request', 'limit 必须是正整数', {
        status: 400,
        details: { field: 'limit' },
      });
    }
    const limit = Math.min(MAX_COMPACT_SOURCES, limitValue);
    if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') {
      throw new SidecarSettlementError('invalid_request', 'dryRun 必须是布尔值', {
        status: 400,
        details: { field: 'dryRun' },
      });
    }
    const sourceIds = stringArray(body.sourceIds, 'sourceIds');
    if (sourceIds && sourceIds.length === 0) {
      throw new SidecarSettlementError('invalid_request', 'sourceIds 不能为空', {
        status: 400,
        details: { field: 'sourceIds' },
      });
    }
    if (sourceIds && new Set(sourceIds).size !== sourceIds.length) {
      throw new SidecarSettlementError('invalid_request', 'sourceIds 不得重复', {
        status: 400,
        details: { field: 'sourceIds' },
      });
    }
    const dryRun = body.dryRun === true;

    return this.serial.run(`compact:${domain}`, async () => {
      const loaded = await this.loadCompactSources(actor, domain, sourceIds, limit);
      const warnings = [...loaded.warnings];
      const effectiveHashes = loaded.sourceHashes;
      let summary = '';
      let tokenCount = 0;
      let summaryExtractor: 'heuristic' | 'local' | 'api' = 'heuristic';
      let summaryModel: string | null = 'heuristic';
      let modelDegraded = false;
      const allowRemote = body.allowRemote === true;

      if (!loaded.deferred) {
        const built = buildCompactSummary(
          loaded.records.map((record) => ({ id: record.id, kind: record.kind, content: record.content })),
          strategy,
        );
        summary = built.summary;
        tokenCount = built.tokenCount;

        // compact 摘要可选模型；失败保留确定性摘要，不丢源记录、不回退到第三方。
        if (strategy === 'summary' && this.models) {
          const selection = await this.models.selectOptionalSource(allowRemote);
          for (const warning of selection.warnings) {
            if (!warnings.includes(warning)) warnings.push(warning);
          }
          modelDegraded = selection.degraded;
          if (selection.source) {
            let outcome;
            try {
              outcome = await this.models.summarize({
                source: selection.source,
                text: built.summary,
                allowRemote,
              });
            } catch {
              outcome = {
                ok: false,
                degraded: true,
                reason: 'model_unavailable',
                warnings: ['model_unavailable'],
                latencyMs: 0,
              };
            }
            if (outcome.ok && outcome.summary) {
              summary = outcome.summary.slice(0, MAX_SUMMARY_CHARS);
              tokenCount = estimateTokens(summary);
              summaryExtractor = selection.source;
              summaryModel = outcome.model ?? selection.source;
              modelDegraded = modelDegraded || outcome.degraded;
              for (const warning of outcome.warnings) {
                if (!warnings.includes(warning)) warnings.push(warning);
              }
              this.models.clearFailure(selection.source);
            } else {
              for (const warning of [...outcome.warnings, outcome.reason ?? 'model_unavailable', 'compact_fallback_heuristic']) {
                if (warning && !warnings.includes(warning)) warnings.push(warning);
              }
              modelDegraded = true;
              this.models.noteFailure(
                selection.source,
                outcome.reason ?? 'model_unavailable',
                outcome.warnings.length > 0 ? outcome.warnings : ['model_unavailable'],
              );
            }
          } else if (selection.degraded) {
            if (!warnings.includes('compact_fallback_heuristic')) warnings.push('compact_fallback_heuristic');
          }
        }
      }

      if (dryRun && loaded.deferred) {
        throw new SidecarSettlementError(
          'capability_unavailable',
          'capability API 不可用，无法解析 compact 来源；未生成占位摘要',
          { status: 503, retryable: true, details: { domain } },
        );
      }

      const base = {
        compactId: null as string | null,
        status: dryRun ? 'dry_run' : 'pending',
        domain,
        namespace: domain,
        sourceIds: loaded.sourceIds,
        sourceHashes: effectiveHashes,
        tokenCount,
        summary,
        stale: false,
        strategy,
        dryRun,
        ...(loaded.deferred ? { deferred: true } : {}),
      };

      if (dryRun) {
        return {
          status: 200 as const,
          data: {
            ...base,
            status: 'dry_run',
            compact: null,
            queued: false,
          },
          warnings,
          degraded: loaded.degraded || modelDegraded,
        };
      }

      const requestId = this.compactRequestId({
        domain,
        strategy,
        sourceIds: loaded.sourceIds,
        sourceHashes: effectiveHashes,
      });
      // deferred 模式只持久化恢复元数据；capability 恢复后重新读取来源、
      // 生成真实摘要与同一来源集的 sourceHashes，绝不提交占位摘要。
      const capabilityBody: Record<string, unknown> = {
        requestId,
        actor: actor.actor,
        kind: 'compact',
        op: 'upsert',
        domain,
        sourceIds: loaded.sourceIds,
        ...(loaded.deferred
          ? { deferredSummary: true }
          : {
            summary,
            ...(effectiveHashes.length === loaded.sourceIds.length ? { sourceHashes: effectiveHashes } : {}),
            tokenCount,
            model: { extractor: summaryExtractor, model: summaryModel, version: '0.3.0' },
          }),
        strategy,
        provenance: {
          source: 'runtime',
          extractor: summaryExtractor,
          model: summaryModel,
          ...(threadId ? { threadId } : {}),
        },
      };

      if (loaded.deferred && !this.client) {
        await this.enqueueObject(requestId, capabilityBody).catch((error) => {
          this.noteFailed(error);
          throw error;
        });
        this.noteQueued(new SidecarSettlementError('capability_unavailable', 'capability API 不可用，已进入 outbox'));
        warnings.push('capability_unavailable', 'queued_outbox');
        return {
          status: 202 as const,
          data: {
            ...base,
            status: 'pending',
            queued: true,
            degraded: true,
          },
          warnings: [...new Set(warnings)],
          degraded: true,
        };
      }

      if (!this.client) {
        throw new SidecarSettlementError(
          'capability_unavailable',
          'capability API 不可用且未给出 sourceIds，无法生成 compact',
          { status: 503, retryable: true, details: { domain } },
        );
      }

      try {
        const response = await this.client.internalObject<Record<string, unknown>>(
          capabilityBody,
          { idempotencyKey: requestId },
        );
        const object = isObject(response.data.object) ? response.data.object as unknown as CompactView : null;
        if (!object) {
          throw new SidecarSettlementError('capability_unavailable', 'compact 写入后未返回对象', {
            status: 503,
            retryable: true,
          });
        }
        this.counts.compacts += 1;
        await this.cacheSet(this.compactCacheKey(object.id), object);
        await this.markHealthyIfOutboxEmpty();
        return {
          status: 200 as const,
          data: {
            ...base,
            compactId: object.id,
            status: 'completed',
            sourceIds: Array.isArray(object.sourceIds) ? object.sourceIds : loaded.sourceIds,
            sourceHashes: Array.isArray(object.sourceHashes) ? object.sourceHashes : effectiveHashes,
            tokenCount: typeof object.tokenCount === 'number' ? object.tokenCount : tokenCount,
            stale: object.stale === true,
            compact: object,
            queued: false,
          },
          warnings: [...warnings, ...response.warnings],
          degraded: response.degraded || loaded.degraded || modelDegraded,
        };
      } catch (error) {
        if (retryableCapabilityError(error)) {
          try {
            await this.enqueueObject(requestId, capabilityBody);
          } catch (queueError) {
            this.noteFailed(queueError);
            throw queueError;
          }
          this.noteQueued(error);
          warnings.push('capability_unavailable', 'queued_outbox');
          return {
            status: 202 as const,
            data: {
              ...base,
              status: 'pending',
              queued: true,
              degraded: true,
            },
            warnings,
            degraded: true,
          };
        }
        this.noteFailed(error);
        throw capabilityError(error);
      }
    });
  }

  async getCompact(id: string): Promise<ObjectHttpResult> {
    if (typeof id !== 'string' || id.length === 0 || id.length > 128) {
      throw new SidecarSettlementError('invalid_request', 'compact id 非法', { status: 400 });
    }
    if (!this.client) {
      this.noteReadDegraded(new SidecarSettlementError('capability_unavailable', 'capability API 不可用'));
      const cached = await this.cacheGet<CompactView>(this.compactCacheKey(id));
      return {
        status: 200,
        data: {
          compact: cached ? { ...cached, stale: true, source: 'cache' } : null,
          source: 'cache',
          degraded: true,
        },
        warnings: cached ? ['capability_unavailable', 'cache_stale'] : ['capability_unavailable'],
        degraded: true,
      };
    }
    try {
      const response = await this.client.internalObject<Record<string, unknown>>({
        actor: this.actorForUser().actor,
        kind: 'compact',
        op: 'get',
        id,
      });
      const object = isObject(response.data.object) ? response.data.object as unknown as CompactView : null;
      if (object) await this.cacheSet(this.compactCacheKey(id), object);
      await this.markHealthyIfOutboxEmpty();
      return {
        status: 200,
        data: { compact: object, source: 'cloud', degraded: response.degraded },
        warnings: response.warnings,
        degraded: response.degraded,
      };
    } catch (error) {
      if (!retryableCapabilityError(error)) throw capabilityError(error);
      this.noteReadDegraded(error);
      const cached = await this.cacheGet<CompactView>(this.compactCacheKey(id));
      return {
        status: 200,
        data: {
          compact: cached ? { ...cached, stale: true, source: 'cache' } : null,
          source: 'cache',
          degraded: true,
        },
        warnings: cached ? ['capability_unavailable', 'cache_stale'] : ['capability_unavailable'],
        degraded: true,
      };
    }
  }

  private checkpointDomain(threadId: string, value: unknown, state: Record<string, unknown>, body: Record<string, unknown>): string {
    if (value === undefined || value === null) {
      const taskKey = checkpointTaskKey(state);
      if (taskKey !== null) return requireDomain(taskKey);
      return threadId === 'default' ? 'default' : `task:${threadId}`;
    }
    const domain = requireDomain(value);
    if (domain === 'default') return domain;
    if (isTaskDomain(domain)) {
      const suffix = threadIdOfDomain(domain);
      const fleetTaskId = checkpointFleetTaskId(state, body);
      if (suffix === threadId || (fleetTaskId !== null && suffix === fleetTaskId)) return domain;
    }
    throw new SidecarSettlementError('domain_mismatch', 'Checkpoint 只能位于 task:<threadId|taskId> 或 default 域', {
      status: 400,
      details: { domain, threadId },
    });
  }

  async putCheckpoint(threadIdRaw: string, request: unknown): Promise<ObjectHttpResult> {
    const threadId = requireThreadId(threadIdRaw);
    const body = requireObjectBody(request);
    rejectSyncFields(body);
    if (body.threadId !== undefined && body.threadId !== null && body.threadId !== threadId) {
      throw new SidecarSettlementError('invalid_request', '请求体 threadId 与路径不一致', {
        status: 400,
        details: { field: 'threadId' },
      });
    }
    const parsedActor = this.parseActorAlias(body, requireAgentId(body.agentId));
    const agentId = parsedActor.agentId!;
    const actor = this.actorForAgent(agentId, parsedActor.agentName);
    const state = body.state === undefined || body.state === null ? {} : body.state;
    if (!isObject(state)) {
      throw new SidecarSettlementError('invalid_request', 'state 必须是对象', {
        status: 400,
        details: { field: 'state' },
      });
    }
    if (Buffer.byteLength(canonicalJson(state), 'utf8') > MAX_STATE_BYTES) {
      throw new SidecarSettlementError('payload_too_large', 'checkpoint state 超过 256 KiB', {
        status: 413,
        details: { field: 'state' },
      });
    }
    const checkpointState = validateCheckpointState(state, threadId);
    const domain = this.checkpointDomain(threadId, body.domain, state, body);
    if (checkpointTaskKey(state) !== domain) {
      throw new SidecarSettlementError('domain_mismatch', 'state.task.key 必须等于 domain', {
        status: 400,
        details: { domain, field: 'state.task.key' },
      });
    }
    this.assertWrite(actor, domain.startsWith('task:') ? `task:${threadId}` : domain, { threadId });

    const expectedRevision = body.expectedRevision === undefined || body.expectedRevision === null
      ? undefined
      : body.expectedRevision;
    if (expectedRevision !== undefined
      && (typeof expectedRevision !== 'number' || !Number.isInteger(expectedRevision) || expectedRevision < 0)) {
      throw new SidecarSettlementError('invalid_request', 'expectedRevision 必须是非负整数', {
        status: 400,
        details: { field: 'expectedRevision' },
      });
    }
    const summary = body.summary === undefined || body.summary === null
      ? null
      : typeof body.summary === 'string'
        ? body.summary
        : (() => {
          throw new SidecarSettlementError('invalid_request', 'summary 必须是字符串', {
            status: 400,
            details: { field: 'summary' },
          });
        })();
    const recordIds = stringArray(body.recordIds, 'recordIds') ?? [];
    const detailIds = stringArray(body.detailIds, 'detailIds', MAX_CHECKPOINT_REFERENCE_IDS) ?? [];
    const expiresAt = body.expiresAt === undefined || body.expiresAt === null ? 0 : body.expiresAt;
    if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt < 0) {
      throw new SidecarSettlementError('invalid_request', 'expiresAt 必须是非负数字', {
        status: 400,
        details: { field: 'expiresAt' },
      });
    }
    const leaseMs = body.leaseMs === undefined || body.leaseMs === null ? undefined : body.leaseMs;
    if (leaseMs !== undefined && (typeof leaseMs !== 'number' || !Number.isFinite(leaseMs) || leaseMs <= 0)) {
      throw new SidecarSettlementError('invalid_request', 'leaseMs 必须是正数', {
        status: 400,
        details: { field: 'leaseMs' },
      });
    }
    if (body.force !== undefined && typeof body.force !== 'boolean') {
      throw new SidecarSettlementError('invalid_request', 'force 必须是布尔值', {
        status: 400,
        details: { field: 'force' },
      });
    }
    const force = body.force === true;
    const checkpointWarnings: string[] = [];
    if (checkpointState.contentMode === 'summary_only' && summary === null) checkpointWarnings.push('summary_unavailable');
    const incomingWarnings = Array.isArray(body.warnings)
      ? body.warnings
      : (typeof body.warning === 'string' ? [body.warning] : []);
    for (const warning of incomingWarnings) {
      if (typeof warning === 'string' && warning.length > 0 && !checkpointWarnings.includes(warning)) {
        checkpointWarnings.push(warning);
      }
    }
    const fleetTaskId = checkpointFleetTaskId(state, body);

    const requestId = typeof body.requestId === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(body.requestId)
      ? body.requestId
      : `req_${sha256Hex(`${agentId}\u0000${threadId}\u0000${this.now()}\u0000${Math.random()}`).slice(0, 40)}`;

    return this.serial.run(`checkpoint:${agentId}:${threadId}`, async () => {
      const capabilityBody: Record<string, unknown> = {
        requestId,
        actor: actor.actor,
        kind: 'context_checkpoint',
        op: 'upsert',
        agentId,
        threadId,
        domain,
        state,
        summary,
        recordIds,
        detailIds,
        expiresAt,
        force,
        ...(checkpointWarnings.length > 0 ? { warnings: checkpointWarnings } : {}),
        ...(fleetTaskId ? { fleetTaskId } : {}),
        ...(expectedRevision !== undefined ? { expectedRevision } : {}),
        ...(leaseMs !== undefined ? { leaseMs } : {}),
        provenance: {
          source: 'runtime',
          extractor: 'heuristic',
          threadId,
        },
      };
      if (!this.client) {
        await this.enqueueCheckpoint(requestId, capabilityBody);
        return this.pendingCheckpoint(agentId, threadId, domain, expiresAt, state, summary, recordIds, detailIds, checkpointWarnings, requestId);
      }
      try {
        const response = await this.client.internalObject<Record<string, unknown>>(
          capabilityBody,
          { idempotencyKey: requestId },
        );
        const object = isObject(response.data.object) ? response.data.object : null;
        if (!object) {
          throw new SidecarSettlementError('capability_unavailable', 'checkpoint 写入后未返回对象', {
            status: 503,
            retryable: true,
          });
        }
        const view = this.checkpointView(object, { source: 'cloud' });
        this.counts.checkpoints += 1;
        await this.cacheSet(this.checkpointCacheKey(agentId, threadId, domain), view);
        await this.cacheDelete(this.checkpointPendingCacheKey(agentId, threadId, domain));
        await this.markHealthyIfOutboxEmpty();
        return {
          status: 200,
          data: { checkpoint: view, source: 'cloud', degraded: response.degraded },
          warnings: [...new Set([...checkpointWarnings, ...response.warnings])],
          degraded: response.degraded || checkpointWarnings.includes('checkpoint_summary_only'),
        };
      } catch (error) {
        if (retryableCapabilityError(error)) {
          await this.enqueueCheckpoint(requestId, capabilityBody);
          return this.pendingCheckpoint(
            agentId, threadId, domain, expiresAt, state, summary, recordIds, detailIds, checkpointWarnings, requestId, error,
          );
        }
        this.noteFailed(error);
        throw capabilityError(error);
      }
    });
  }

  private checkpointView(object: Record<string, unknown>, extra: { source: 'cloud' | 'cache' }): CheckpointView {
    const domain = normalizeDomain(object.domain ?? object.namespace)
      ?? (typeof object.domain === 'string' ? object.domain : 'default');
    const state = isObject(object.state) ? object.state : {};
    const schema = state.schema === 2 ? 2 : 1;
    const contentMode = schema === 2
      ? (state.contentMode === 'summary_only' ? 'summary_only' : 'structured')
      : null;
    return {
      ...object,
      id: typeof object.id === 'string' ? object.id : null,
      type: 'context_checkpoint',
      kind: 'context_checkpoint',
      domain,
      agentId: typeof object.agentId === 'string' ? object.agentId : '',
      threadId: typeof object.threadId === 'string' ? object.threadId : '',
      revision: typeof object.revision === 'number' ? object.revision : null,
      schema,
      contentMode,
      structured: schema === 2 && contentMode === 'structured',
      legacy: schema !== 2,
      degraded: object.degraded === true || contentMode === 'summary_only' || schema !== 2,
      state,
      summary: typeof object.summary === 'string' ? object.summary : null,
      recordIds: Array.isArray(object.recordIds) ? object.recordIds.filter((id): id is string => typeof id === 'string') : [],
      detailIds: Array.isArray(object.detailIds) ? object.detailIds.filter((id): id is string => typeof id === 'string') : [],
      lease: isObject(object.lease) ? object.lease : null,
      updatedBy: isObject(object.updatedBy) ? object.updatedBy : null,
      expiresAt: typeof object.expiresAt === 'number' ? object.expiresAt : 0,
      pending: false,
      stale: false,
      source: extra.source,
    };
  }

  private async enqueueCheckpoint(requestId: string, body: Record<string, unknown>): Promise<void> {
    try {
      await this.enqueueObject(requestId, body);
    } catch (error) {
      this.noteFailed(error);
      throw error;
    }
  }

  private async pendingCheckpoint(
    agentId: string,
    threadId: string,
    domain: string,
    expiresAt: number,
    state: Record<string, unknown>,
    summary: string | null,
    recordIds: string[],
    detailIds: string[],
    checkpointWarnings: string[],
    requestId: string,
    error?: unknown,
  ): Promise<ObjectHttpResult> {
    const queuedAt = this.now();
    const contentMode = state.schema === 2
      ? (state.contentMode === 'summary_only' ? 'summary_only' : 'structured')
      : null;
    const view: CheckpointView = {
      id: null,
      type: 'context_checkpoint',
      kind: 'context_checkpoint',
      domain,
      agentId,
      threadId,
      revision: null,
      schema: state.schema === 2 ? 2 : 1,
      contentMode,
      structured: contentMode === 'structured',
      legacy: state.schema !== 2,
      degraded: contentMode === 'summary_only' || state.schema !== 2,
      state,
      summary,
      recordIds,
      detailIds,
      lease: null,
      updatedBy: null,
      expiresAt,
      pending: true,
      queuedAt,
      outboxId: outboxItemId(requestId),
      requestId,
      source: 'cache',
      stale: true,
    };
    await this.cacheSet(this.checkpointPendingCacheKey(agentId, threadId, domain), view);
    this.noteQueued(error ?? new SidecarSettlementError('capability_unavailable', 'capability API 不可用，已进入 outbox'));
    return {
      status: 202,
      data: {
        checkpoint: view,
        source: 'cache',
        pending: true,
        degraded: true,
      },
      warnings: [...new Set(['capability_unavailable', 'queued_outbox', ...checkpointWarnings])],
      degraded: true,
    };
  }

  async getCheckpoint(
    threadIdRaw: string,
    options: { agentId?: string | null; sync?: string | null; domain?: string | null } = {},
  ): Promise<ObjectHttpResult> {
    rejectQuerySync(options.sync);
    const threadId = requireThreadId(threadIdRaw);
    const agentId = requireAgentId(options.agentId);
    const domain = options.domain === undefined || options.domain === null || options.domain === ''
      ? null
      : requireDomain(options.domain);
    const domains = domain ? [domain] : [...new Set([`task:${threadId}`, 'default'])];
    const keys = domains.map((entry) => this.checkpointCacheKey(agentId, threadId, entry));
    const pendingKeys = domains.map((entry) => this.checkpointPendingCacheKey(agentId, threadId, entry));
    if (!this.client) {
      this.noteReadDegraded(new SidecarSettlementError('capability_unavailable', 'capability API 不可用'));
      return this.cachedCheckpoint(agentId, threadId, keys, pendingKeys);
    }
    try {
      let responseHighWater: number | null = null;
      for (const entry of domains) {
        const response = await this.client.internalObject<Record<string, unknown>>({
          actor: this.actorForAgent(agentId).actor,
          kind: 'context_checkpoint',
          op: 'get',
          agentId,
          threadId,
          domain: entry,
        });
        const responseWater = typeof response.data.highWater === 'number'
          ? response.data.highWater
          : typeof response.data.latestRevision === 'number' ? response.data.latestRevision : null;
        if (responseWater !== null) responseHighWater = Math.max(responseHighWater ?? 0, responseWater);
        const object = isObject(response.data.object) ? response.data.object : null;
        if (!object) continue;
        const view = this.checkpointView(object, { source: 'cloud' });
        await this.cacheSet(this.checkpointCacheKey(agentId, threadId, view.domain), view);
        let pending = await this.firstPendingCheckpoint(
          agentId,
          threadId,
          [this.checkpointPendingCacheKey(agentId, threadId, view.domain)],
        );
        if (pending
          && typeof pending.queuedAt === 'number'
          && typeof view.updatedAt === 'number'
          && view.updatedAt > pending.queuedAt) {
          await this.cacheDelete(this.checkpointPendingCacheKey(agentId, threadId, view.domain));
          pending = null;
        }
        await this.markHealthyIfOutboxEmpty();
        const highWater = typeof response.data.highWater === 'number'
          ? response.data.highWater
          : typeof response.data.latestRevision === 'number' ? response.data.latestRevision : null;
        return {
          status: 200,
          data: {
            checkpoint: view,
            source: 'cloud',
            pending: pending !== null,
            pendingCheckpoint: pending,
            ...(highWater !== null ? { highWater, latestRevision: highWater } : {}),
            degraded: response.degraded === true || pending !== null,
          },
          warnings: [...new Set([
            ...response.warnings,
            ...(pending ? ['checkpoint_pending'] : []),
          ])],
          degraded: response.degraded === true || pending !== null,
        };
      }
      for (const key of keys) await this.cacheDelete(key);
      await this.markHealthyIfOutboxEmpty();
      // capability 可达但没有已提交对象：pending 仍只作为 pending 元数据返回，
      // 绝不能因为 outbox 里有写入就伪造 committed。
      const pending = await this.firstPendingCheckpoint(agentId, threadId, pendingKeys);
      const highWater = typeof responseHighWater === 'number' ? responseHighWater : null;
      return {
        status: 200,
        data: {
          checkpoint: null,
          source: 'cloud',
          ...(highWater !== null ? { highWater, latestRevision: highWater } : {}),
          ...(pending
            ? { pending: true, pendingCheckpoint: pending }
            : { pending: false, pendingCheckpoint: null }),
          degraded: false,
        },
        warnings: pending ? ['checkpoint_pending_only'] : [],
        degraded: false,
      };
    } catch (error) {
      if (!retryableCapabilityError(error)) throw capabilityError(error);
      this.noteReadDegraded(error);
      return this.cachedCheckpoint(agentId, threadId, keys, pendingKeys);
    }
  }

  private async firstPendingCheckpoint(
    agentId: string,
    threadId: string,
    pendingKeys: string[],
  ): Promise<CheckpointView | null> {
    for (const key of pendingKeys) {
      const pending = await this.cacheGet<CheckpointView>(key);
      if (!pending || pending.pending !== true) continue;
      if (checkpointExpiredView(pending, this.now())) continue;
      return {
        ...pending,
        agentId: pending.agentId || agentId,
        threadId: pending.threadId || threadId,
        source: 'cache',
        stale: true,
        pending: true,
      };
    }
    return null;
  }

  private async cachedCheckpoint(
    agentId: string,
    threadId: string,
    keys: string[],
    pendingKeys: string[],
  ): Promise<ObjectHttpResult> {
    const warnings = ['capability_unavailable'];
    let expired = false;
    let committed: CheckpointView | null = null;
    for (const key of keys) {
      const cached = await this.cacheGet<CheckpointView>(key);
      if (!cached) continue;
      // 旧版本可能把 pending 写进 committed key；读取时一律拒绝。
      if (cached.pending === true || (cached.source === 'cache' && cached.stale === true && cached.revision === null)) continue;
      if (checkpointExpiredView(cached, this.now())) {
        expired = true;
        continue;
      }
      committed = {
        ...cached,
        agentId: cached.agentId || agentId,
        threadId: cached.threadId || threadId,
        source: 'cache',
        stale: true,
      };
      break;
    }
    const pending = await this.firstPendingCheckpoint(agentId, threadId, pendingKeys);
    if (expired && !committed) warnings.push('checkpoint_expired');
    if (committed) warnings.push('cache_stale');
    if (pending) warnings.push('checkpoint_pending');
    return {
      status: 200,
      data: {
        checkpoint: committed,
        source: 'cache',
        pending: pending !== null,
        pendingCheckpoint: pending,
        pendingUnavailable: pending === null,
        degraded: true,
      },
      warnings: [...new Set(warnings)],
      degraded: true,
    };
  }

  async deleteCheckpoint(
    threadIdRaw: string,
    options: { agentId?: string | null; sync?: string | null; domain?: string | null } = {},
  ): Promise<ObjectHttpResult> {
    rejectQuerySync(options.sync);
    const threadId = requireThreadId(threadIdRaw);
    const agentId = requireAgentId(options.agentId);
    const domain = options.domain === undefined || options.domain === null || options.domain === ''
      ? null
      : requireDomain(options.domain);
    if (!this.client) {
      throw new SidecarSettlementError('capability_unavailable', 'capability API 不可用，无法确认删除', {
        status: 503,
        retryable: true,
      });
    }
    const client = this.client;
    return this.serial.run(`checkpoint:${agentId}:${threadId}`, async () => {
      try {
        // 删除是治理动作：本地 host token 视为 admin，由 capability 校验 user/system。
        const response = await client.internalObject<Record<string, unknown>>({
          actor: this.actorForUser().actor,
          kind: 'context_checkpoint',
          op: 'delete',
          agentId,
          threadId,
          ...(domain ? { domain } : {}),
        });
        for (const entry of new Set([`task:${threadId}`, 'default', ...(domain ? [domain] : [])])) {
          await this.cacheDelete(this.checkpointCacheKey(agentId, threadId, entry));
          await this.cacheDelete(this.checkpointPendingCacheKey(agentId, threadId, entry));
        }
        await this.cacheDelete(this.checkpointCacheKey(agentId, threadId));
        await this.cacheDelete(this.checkpointPendingCacheKey(agentId, threadId));
        await this.markHealthyIfOutboxEmpty();
        return {
          status: 200,
          data: {
            deleted: response.data.deleted === true,
            checkpoint: null,
            source: 'cloud',
            degraded: response.degraded,
          },
          warnings: response.warnings,
          degraded: response.degraded,
        };
      } catch (error) {
        this.noteFailed(error);
        throw capabilityError(error);
      }
    });
  }

  private selfRecordOf(body: Record<string, unknown>): Record<string, unknown> {
    if (body.record !== undefined) {
      if (!isObject(body.record)) {
        throw new SidecarSettlementError('invalid_request', 'record 必须是对象', {
          status: 400,
          details: { field: 'record' },
        });
      }
      return body.record;
    }
    const record: Record<string, unknown> = {};
    for (const field of ['displayName', 'goals', 'traits', 'preferences', 'capabilities', 'boundaries']) {
      if (body[field] !== undefined) record[field] = body[field];
    }
    return record;
  }

  async putSelf(agentIdRaw: string, request: unknown): Promise<ObjectHttpResult> {
    const agentId = requireAgentId(agentIdRaw);
    const body = requireObjectBody(request);
    rejectSyncFields(body);
    const parsedActor = this.parseActorAlias(body, agentId);
    const actor = this.actorForAgent(agentId, parsedActor.agentName);
    const domain = agentDomain(agentId);
    if (body.domain !== undefined && body.domain !== null && requireDomain(body.domain) !== domain) {
      throw new SidecarSettlementError('domain_mismatch', 'SelfRecord 必须位于 agent:<agentId> 域', {
        status: 400,
        details: { agentId },
      });
    }
    this.assertWrite(actor, domain);
    const expectedRevision = body.expectedRevision === undefined || body.expectedRevision === null
      ? undefined
      : body.expectedRevision;
    if (expectedRevision !== undefined
      && (typeof expectedRevision !== 'number' || !Number.isInteger(expectedRevision) || expectedRevision < 0)) {
      throw new SidecarSettlementError('invalid_request', 'expectedRevision 必须是非负整数', {
        status: 400,
        details: { field: 'expectedRevision' },
      });
    }
    const record = this.selfRecordOf(body);
    const requestId = typeof body.requestId === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(body.requestId)
      ? body.requestId
      : `req_${sha256Hex(`${agentId}\u0000${this.now()}\u0000${Math.random()}`).slice(0, 40)}`;

    return this.serial.run(`self:${agentId}`, async () => {
      const capabilityBody: Record<string, unknown> = {
        requestId,
        actor: actor.actor,
        kind: 'self_record',
        op: 'upsert',
        agentId,
        domain,
        record,
        ...(expectedRevision !== undefined ? { expectedRevision } : {}),
        provenance: { source: 'runtime', extractor: 'heuristic' },
      };
      if (!this.client) {
        try {
          await this.enqueueObject(requestId, capabilityBody);
        } catch (error) {
          this.noteFailed(error);
          throw error;
        }
        return this.pendingSelf(agentId, record, errorFromMissingClient(), requestId);
      }
      try {
        const response = await this.client.internalObject<Record<string, unknown>>(
          capabilityBody,
          { idempotencyKey: requestId },
        );
        const object = isObject(response.data.object) ? response.data.object : null;
        if (!object) {
          throw new SidecarSettlementError('capability_unavailable', 'SelfRecord 写入后未返回对象', {
            status: 503,
            retryable: true,
          });
        }
        const view = this.selfView(object, { source: 'cloud' });
        this.counts.selfRecords += 1;
        await this.cacheSet(this.selfCacheKey(agentId), view);
        await this.cacheDelete(this.selfPendingCacheKey(agentId));
        await this.markHealthyIfOutboxEmpty();
        return {
          status: 200,
          data: { selfRecord: view, self: view, source: 'cloud', degraded: response.degraded },
          warnings: response.warnings,
          degraded: response.degraded,
        };
      } catch (error) {
        if (retryableCapabilityError(error)) {
          try {
            await this.enqueueObject(requestId, capabilityBody);
          } catch (queueError) {
            this.noteFailed(queueError);
            throw queueError;
          }
          return this.pendingSelf(agentId, record, error, requestId);
        }
        this.noteFailed(error);
        throw capabilityError(error);
      }
    });
  }

  private selfView(object: Record<string, unknown>, extra: { source: 'cloud' | 'cache' }): SelfRecordView {
    const domain = normalizeDomain(object.domain ?? object.namespace)
      ?? (typeof object.domain === 'string' ? object.domain : 'default');
    const content = isObject(object.content)
      ? object.content
      : isObject(object.record) ? object.record : {};
    return {
      ...object,
      id: typeof object.id === 'string' ? object.id : null,
      type: 'self_record',
      kind: 'self_record',
      domain,
      agentId: typeof object.agentId === 'string' ? object.agentId : '',
      revision: typeof object.revision === 'number' ? object.revision : null,
      content,
      record: content,
      pending: false,
      stale: false,
      source: extra.source,
    };
  }

  private async pendingSelf(
    agentId: string,
    record: Record<string, unknown>,
    error: unknown,
    requestId: string,
  ): Promise<ObjectHttpResult> {
    const queuedAt = this.now();
    const view: SelfRecordView = {
      id: null,
      type: 'self_record',
      kind: 'self_record',
      domain: agentDomain(agentId),
      agentId,
      revision: null,
      content: record,
      record,
      pending: true,
      queuedAt,
      outboxId: outboxItemId(requestId),
      requestId,
      source: 'cache',
      stale: true,
    };
    await this.cacheSet(this.selfPendingCacheKey(agentId), view);
    this.noteQueued(error);
    return {
      status: 202,
      data: {
        selfRecord: view,
        self: view,
        source: 'cache',
        pending: true,
        degraded: true,
      },
      warnings: ['capability_unavailable', 'queued_outbox'],
      degraded: true,
    };
  }

  async getSelf(agentIdRaw: string): Promise<ObjectHttpResult> {
    const agentId = requireAgentId(agentIdRaw);
    const key = this.selfCacheKey(agentId);
    if (!this.client) {
      this.noteReadDegraded(new SidecarSettlementError('capability_unavailable', 'capability API 不可用'));
      return this.cachedSelf(agentId, key);
    }
    try {
      const response = await this.client.internalObject<Record<string, unknown>>({
        actor: this.actorForAgent(agentId).actor,
        kind: 'self_record',
        op: 'get',
        agentId,
      });
      const object = isObject(response.data.object) ? response.data.object : null;
      const pendingKey = this.selfPendingCacheKey(agentId);
      let pending = await this.cacheGet<SelfRecordView>(pendingKey);
      if (!object) {
        await this.cacheDelete(key);
        await this.markHealthyIfOutboxEmpty();
        return {
          status: 200,
          data: {
            selfRecord: null,
            self: null,
            source: 'cloud',
            pending: pending !== null,
            pendingSelfRecord: pending,
            degraded: response.degraded === true || pending !== null,
          },
          warnings: [...new Set([
            ...response.warnings,
            ...(pending ? ['self_pending'] : []),
          ])],
          degraded: response.degraded === true || pending !== null,
        };
      }
      const view = this.selfView(object, { source: 'cloud' });
      if (pending
        && typeof pending.queuedAt === 'number'
        && typeof view.updatedAt === 'number'
        && view.updatedAt > pending.queuedAt) {
        await this.cacheDelete(pendingKey);
        pending = null;
      }
      await this.cacheSet(key, view);
      await this.markHealthyIfOutboxEmpty();
      return {
        status: 200,
        data: {
          selfRecord: view,
          self: view,
          source: 'cloud',
          pending: pending !== null,
          pendingSelfRecord: pending,
          degraded: response.degraded === true || pending !== null,
        },
        warnings: [...new Set([
          ...response.warnings,
          ...(pending ? ['self_pending'] : []),
        ])],
        degraded: response.degraded === true || pending !== null,
      };
    } catch (error) {
      if (!retryableCapabilityError(error)) throw capabilityError(error);
      this.noteReadDegraded(error);
      return this.cachedSelf(agentId, key);
    }
  }

  private async cachedSelf(agentId: string, key: string): Promise<ObjectHttpResult> {
    const cached = await this.cacheGet<SelfRecordView>(key);
    const pending = await this.cacheGet<SelfRecordView>(this.selfPendingCacheKey(agentId));
    const committed = cached && cached.pending !== true
      ? {
        ...cached,
        agentId: cached.agentId || agentId,
        domain: cached.domain || agentDomain(agentId),
        source: 'cache' as const,
        stale: true,
      }
      : null;
    const pendingView = pending && pending.pending === true
      ? {
        ...pending,
        agentId: pending.agentId || agentId,
        domain: pending.domain || agentDomain(agentId),
        source: 'cache' as const,
        stale: true,
      }
      : null;
    return {
      status: 200,
      data: {
        selfRecord: committed,
        self: committed,
        source: 'cache',
        pending: pendingView !== null,
        pendingSelfRecord: pendingView,
        pendingUnavailable: pendingView === null,
        degraded: true,
      },
      warnings: committed
        ? ['capability_unavailable', 'cache_stale', ...(pendingView ? ['self_pending'] : [])]
        : ['capability_unavailable', ...(pendingView ? ['self_pending'] : [])],
      degraded: true,
    };
  }
}

function errorFromMissingClient(): SidecarSettlementError {
  return new SidecarSettlementError('capability_unavailable', 'capability API 不可用，已进入 outbox', {
    status: 503,
    retryable: true,
  });
}
