// Memory Runtime sidecar 本地层：staging / Trace / cache / detail cache / outbox。
//
// 这些都是本机过程数据，可重建、非权威；删除不影响已沉降到忆云的记忆。
// staging/Trace 复用现有 RuntimeLocalStore，但 root 固定为 `<home>/memory-runtime`，
// 不再使用 MCP daemon 的 `<home>/runtime`。
//
// outbox 是有界重试队列：一项 = 一个 capability 写请求 + 幂等键；
// 满时停止接收新写（outbox_full），不丢已有项。cache 是通用有界 TTL 缓存。

import { createHash, randomUUID } from 'node:crypto';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  RuntimeLocalStore,
  type RuntimeLocalCleanupResult,
} from '../runtime/local-store.js';
import { ensurePrivateDir, readJsonFile, writeJsonAtomic } from './atomic-json.js';
import type { SidecarPaths } from './config.js';
import { redactText } from './text.js';
import type { RawChunk } from '../runtime/types.js';

const OUTBOX_ITEM_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
export const OUTBOX_MAX_QUEUE_MS = 30 * DAY_MS;
export const OUTBOX_DEAD_RETENTION_DAYS = 30;
export const OUTBOX_REPLAY_LEASE_MS = 60_000;
export const LOCAL_MAINTENANCE_INTERVAL_MS = 60_000;
const SENSITIVE_FIELD_RE = /^(?:authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password|passwd|credential|private[-_]?key)$/i;

export type LocalLayerErrorCode =
  | 'outbox_full'
  | 'storage_full'
  | 'invalid_outbox_item'
  | 'invalid_cache_key';

export class LocalLayerError extends Error {
  readonly code: LocalLayerErrorCode;

  constructor(code: LocalLayerErrorCode, message: string) {
    super(message);
    this.name = 'LocalLayerError';
    this.code = code;
  }
}

export interface OutboxItem {
  version: 1;
  id: string;
  requestId: string;
  endpoint: string;
  method: 'GET' | 'POST';
  body: unknown;
  createdAt: number;
  attempts: number;
  lastAttemptAt: number | null;
  lastError: string | null;
  /** 指数退避后的下次可尝试时间；缺省表示立即可尝试。 */
  nextAttemptAt?: number;
  /** 操作级截止时间；缺省为 createdAt + 30 天。 */
  expiresAt?: number;
  /** 有界重放租约；仅用于 cleanup/in-flight 协调，不延长操作 deadline。 */
  replayLeaseUntil?: number;
  /** 当前 replay attempt 的唯一 owner；旧 attempt 不得续租或完成新 attempt。 */
  replayLeaseOwner?: string;
  /** 取得租约时使用的时长；后续续租不得退回到更短的默认值。 */
  replayLeaseMs?: number;
  /**
   * 已由 capability 确认提交、但本地后续对账未完成的记录/详情。
   * 用于 partial/dead 时如实披露，绝不因本地 staging 缺失而隐去已提交对象。
   */
  committed?: OutboxCommitted;
  /**
   * 本地重放元数据（不发给 capability）：
   * 成功后清理对应 staging chunk / detail cache。
   */
  meta?: {
    kind?: 'detail' | 'record' | 'object';
    stagingChunkIds?: string[];
    detailIds?: string[];
    domain?: string;
    /** 该 outbox 操作所属的抽取任务；重放成功清理时不得把它当作他人 pending 证据。 */
    extractionIds?: string[];
    /** dead/expiry 收口失败时持久化，供重启或后台有界重试。 */
    needsFinalize?: boolean;
    finalizeOutcome?: OutboxReplayCompletion;
    /** record clientItemId → 实际支撑它的 staging/message 证据。 */
    evidence?: Record<string, { stagingChunkIds: string[]; messageIds: string[] }>;
  };
}

export interface OutboxCommittedObject {
  id: string;
  clientItemId?: string;
  status?: string;
  domain?: string;
  kind?: string;
}

export interface OutboxCommitted {
  records?: OutboxCommittedObject[];
  details?: OutboxCommittedObject[];
  objects?: OutboxCommittedObject[];
}

export interface OutboxEnqueueInput {
  id?: string;
  requestId?: string;
  endpoint: string;
  method?: 'GET' | 'POST';
  body: unknown;
  createdAt?: number;
  expiresAt?: number;
  meta?: OutboxItem['meta'];
}

export interface OutboxEnqueueResult {
  item: OutboxItem;
  duplicate: boolean;
}

export interface OutboxStats {
  items: number;
  bytes: number;
  oldestAt: number | null;
}

export interface OutboxCleanupResult {
  expired: number;
  deadRemoved: number;
}

export type OutboxReplayLeaseResult =
  | { state: 'acquired'; item: OutboxItem }
  | { state: 'leased' | 'expired' };

export type OutboxReplayCompletion = 'settled' | 'retry' | 'dead' | 'skipped';

export interface CacheEntry<T = unknown> {
  key: string;
  value: T;
  createdAt: number;
  lastAccessAt?: number;
  expiresAt: number;
}

export interface CacheStats {
  entries: number;
  bytes: number;
  oldestAt?: number | null;
}

export interface LocalMaintenanceStatus {
  running: boolean;
  intervalMs: number;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastError: { code: string; at: number } | null;
  lastResult: {
    stagingChunks: number;
    traces: number;
    cacheRemoved: number;
    detailCacheRemoved: number;
    outboxExpired: number;
    deadRemoved: number;
    bytes: number;
    oldestAgeMs: number | null;
  } | null;
}

export interface SidecarLocalLayerOptions {
  root: string;
  /** staging chunk 保留小时数（默认 24）。 */
  stagingHours?: number;
  /** staging 总字节上限（默认 256 MiB）。 */
  stagingBytes?: number;
  traceRetentionDays?: number;
  traceMaxEntries?: number;
  maxOutboxItems?: number;
  maxOutboxBytes?: number;
  /** 通用缓存（幂等/抽取任务）上限。 */
  maxCacheEntries?: number;
  maxCacheBytes?: number;
  /** 详情只读缓存保留天数（默认 30）。 */
  detailCacheDays?: number;
  /** 详情只读缓存总字节上限（默认 256 MiB）。 */
  detailCacheBytes?: number;
  /** 详情只读缓存条目上限（默认 5000）。 */
  detailCacheMaxEntries?: number;
  now?: () => number;
}

export interface SidecarLocalLayerStats {
  stagingChunks: number;
  stagingBytes: number;
  stagingOldestAt: number | null;
  traces: number;
  traceBytes: number;
  traceOldestAt: number | null;
  cacheEntries: number;
  cacheBytes: number;
  cacheOldestAt: number | null;
  detailCacheEntries: number;
  detailCacheBytes: number;
  detailCacheOldestAt: number | null;
  outboxItems: number;
  outboxBytes: number;
  outboxOldestAt: number | null;
  deadLetter: number;
  deadLetterBytes: number;
  deadLetterOldestAt: number | null;
}

/** 创建 sidecar 本地目录（全部 0700）。 */
export async function ensureSidecarDirectories(paths: SidecarPaths): Promise<void> {
  await Promise.all([
    ensurePrivateDir(paths.dataDir),
    ensurePrivateDir(paths.stagingDir),
    ensurePrivateDir(paths.cacheDir),
    ensurePrivateDir(paths.detailCacheDir),
    ensurePrivateDir(paths.outboxDir),
    ensurePrivateDir(paths.outboxDeadDir),
    ensurePrivateDir(paths.logsDir),
    ensurePrivateDir(paths.tmpDir),
    ensurePrivateDir(paths.modelsDir),
  ]);
}

function itemBytes(item: unknown): number {
  return Buffer.byteLength(JSON.stringify(item), 'utf8');
}

/**
 * outbox 的最后持久化边界：保留重放所需结构，但脱敏所有字符串并覆盖显式机密字段。
 * 认证材料本应只在 Authorization 头中；若调用方误放进 body，也绝不落盘。
 */
function minimizeOutboxValue(value: unknown, key?: string): unknown {
  if (typeof value === 'string') {
    if (key && SENSITIVE_FIELD_RE.test(key)) return '[redacted]';
    return redactText(value).text;
  }
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => minimizeOutboxValue(entry));
  const out: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
    if (entryValue !== undefined) out[entryKey] = minimizeOutboxValue(entryValue, entryKey);
  }
  return out;
}

function mergeCommitted(
  existing: OutboxCommitted | undefined,
  update: OutboxCommitted | undefined,
): OutboxCommitted | undefined {
  if (!update) return existing;
  const mergeList = (
    current: OutboxCommittedObject[] | undefined,
    next: OutboxCommittedObject[] | undefined,
  ): OutboxCommittedObject[] | undefined => {
    if (!next || next.length === 0) return current;
    const merged = new Map<string, OutboxCommittedObject>();
    for (const entry of current ?? []) merged.set(`${entry.kind ?? ''}\u0000${entry.id}`, { ...entry });
    for (const entry of next) {
      const key = `${entry.kind ?? ''}\u0000${entry.id}`;
      merged.set(key, { ...merged.get(key), ...entry });
    }
    return [...merged.values()];
  };
  return {
    ...(existing?.records || update.records ? { records: mergeList(existing?.records, update.records) } : {}),
    ...(existing?.details || update.details ? { details: mergeList(existing?.details, update.details) } : {}),
    ...(existing?.objects || update.objects ? { objects: mergeList(existing?.objects, update.objects) } : {}),
  };
}

function isOutboxItem(value: unknown): value is OutboxItem {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Partial<OutboxItem>;
  return item.version === 1
    && typeof item.id === 'string'
    && typeof item.requestId === 'string'
    && typeof item.endpoint === 'string'
    && (item.method === 'GET' || item.method === 'POST')
    && typeof item.createdAt === 'number'
    && typeof item.attempts === 'number';
}

export class BoundedOutbox {
  readonly root: string;
  readonly deadRoot: string;
  readonly maxItems: number;
  readonly maxBytes: number;

  private readonly now: () => number;
  private tail: Promise<void> = Promise.resolve();

  constructor({
    root,
    deadRoot,
    maxItems = 1000,
    maxBytes = 16_777_216,
    now = Date.now,
  }: {
    root: string;
    deadRoot: string;
    maxItems?: number;
    maxBytes?: number;
    now?: () => number;
  }) {
    this.root = root;
    this.deadRoot = deadRoot;
    this.maxItems = Math.max(1, Math.floor(maxItems));
    this.maxBytes = Math.max(1, Math.floor(maxBytes));
    this.now = now;
  }

  async init(): Promise<void> {
    await ensurePrivateDir(this.root);
    await ensurePrivateDir(this.deadRoot);
  }

  private pathFor(id: string): string {
    if (!OUTBOX_ITEM_RE.test(id)) {
      throw new LocalLayerError('invalid_outbox_item', 'outbox id 格式非法');
    }
    return join(this.root, `${id}.json`);
  }

  private deadPathFor(id: string): string {
    if (!OUTBOX_ITEM_RE.test(id)) {
      throw new LocalLayerError('invalid_outbox_item', 'outbox id 格式非法');
    }
    return join(this.deadRoot, `${id}.json`);
  }

  private deadlineOf(item: OutboxItem): number {
    const createdDeadline = item.createdAt + OUTBOX_MAX_QUEUE_MS;
    return typeof item.expiresAt === 'number' && item.expiresAt > 0
      ? Math.min(createdDeadline, item.expiresAt)
      : createdDeadline;
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation, operation);
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async readItems(limit?: number): Promise<OutboxItem[]> {
    const entries = await readdir(this.root, { withFileTypes: true }).catch(() => []);
    const items: OutboxItem[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const item = await readJsonFile<OutboxItem>(join(this.root, entry.name));
      if (isOutboxItem(item)) items.push(item);
    }
    items.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    return limit !== undefined ? items.slice(0, Math.max(0, limit)) : items;
  }

  private async statsUnlocked(): Promise<OutboxStats> {
    const items = await this.readItems();
    let bytes = 0;
    let oldestAt: number | null = null;
    for (const item of items) {
      bytes += itemBytes(item);
      if (oldestAt === null || item.createdAt < oldestAt) oldestAt = item.createdAt;
    }
    return { items: items.length, bytes, oldestAt };
  }

  async enqueue(input: OutboxEnqueueInput): Promise<OutboxEnqueueResult> {
    return this.exclusive(async () => {
      await this.init();
      const id = input.id ?? input.requestId ?? `ob_${randomUUID()}`;
      if (!OUTBOX_ITEM_RE.test(id)) {
        throw new LocalLayerError('invalid_outbox_item', 'outbox id 格式非法');
      }
      const path = this.pathFor(id);
      const existing = await readJsonFile<OutboxItem>(path);
      if (isOutboxItem(existing)) {
        if (this.deadlineOf(existing) > this.now()) return { item: existing, duplicate: true };
        await this.deadLetterUnlocked(existing, 'retention_expired');
      }

      const createdAt = input.createdAt ?? this.now();
      const item: OutboxItem = {
        version: 1,
        id,
        requestId: input.requestId ?? id,
        endpoint: input.endpoint.startsWith('/') ? input.endpoint : `/${input.endpoint}`,
        method: input.method ?? 'POST',
        body: minimizeOutboxValue(input.body),
        createdAt,
        expiresAt: Math.min(
          createdAt + OUTBOX_MAX_QUEUE_MS,
          typeof input.expiresAt === 'number' && input.expiresAt > 0
            ? input.expiresAt
            : Number.POSITIVE_INFINITY,
        ),
        attempts: 0,
        lastAttemptAt: null,
        lastError: null,
        ...(input.meta ? { meta: minimizeOutboxValue(input.meta) as OutboxItem['meta'] } : {}),
      };

      let bytes: number;
      try {
        bytes = itemBytes(item);
      } catch {
        throw new LocalLayerError('invalid_outbox_item', 'outbox 请求体不可序列化');
      }

      const stats = await this.statsUnlocked();
      if (stats.items + 1 > this.maxItems || stats.bytes + bytes > this.maxBytes) {
        throw new LocalLayerError('outbox_full', 'outbox 已满，停止接收新写');
      }

      try {
        await writeJsonAtomic(path, item);
      } catch (error) {
        throw new LocalLayerError(
          'storage_full',
          `outbox 写入失败（${(error as NodeJS.ErrnoException)?.code ?? 'storage_error'}）`,
        );
      }
      return { item, duplicate: false };
    });
  }

  async list(limit?: number): Promise<OutboxItem[]> {
    return this.exclusive(() => this.readItems(limit));
  }

  async get(id: string): Promise<OutboxItem | null> {
    return this.exclusive(async () => {
      const item = await readJsonFile<OutboxItem>(this.pathFor(id));
      return isOutboxItem(item) ? item : null;
    });
  }

  async getDead(id: string): Promise<OutboxItem | null> {
    return this.exclusive(async () => {
      const item = await readJsonFile<OutboxItem>(this.deadPathFor(id));
      return isOutboxItem(item) ? item : null;
    });
  }

  /** 只读 dead 项，用于 extraction 依赖终态收口与诊断。 */
  async listDead(): Promise<OutboxItem[]> {
    return this.exclusive(() => this.readDeadItems());
  }

  private async readDeadItems(): Promise<OutboxItem[]> {
    const entries = await readdir(this.deadRoot, { withFileTypes: true }).catch(() => []);
    const items: OutboxItem[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const item = await readJsonFile<OutboxItem>(join(this.deadRoot, entry.name));
      if (isOutboxItem(item)) items.push(item);
    }
    items.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    return items;
  }

  async remove(id: string): Promise<boolean> {
    return this.exclusive(async () => {
      const path = this.pathFor(id);
      const item = await readJsonFile<OutboxItem>(path);
      if (!isOutboxItem(item)) return false;
      await rm(path, { force: true });
      return true;
    });
  }

  /**
   * 持久化已确认提交对象。若清理已把活动项移入 dead，则合并写入 dead，
   * 保证 partial/dead 仍能披露已提交 ID/对象；绝不复活活动项。
   */
  async markCommitted(
    id: string,
    committed: OutboxCommitted,
    { owner }: { owner?: string } = {},
  ): Promise<boolean> {
    if (!committed || Object.keys(committed).length === 0) return false;
    return this.exclusive(async () => {
      const activePath = this.pathFor(id);
      const active = await readJsonFile<OutboxItem>(activePath);
      if (isOutboxItem(active)) {
        if (owner !== undefined && active.replayLeaseOwner !== owner) return false;
        const updated: OutboxItem = {
          ...active,
          committed: mergeCommitted(active.committed, committed),
        };
        await writeJsonAtomic(activePath, updated);
        return true;
      }
      const deadPath = this.deadPathFor(id);
      const dead = await readJsonFile<OutboxItem>(deadPath);
      if (!isOutboxItem(dead)) return false;
      if (owner !== undefined && dead.replayLeaseOwner !== owner) return false;
      const updated: OutboxItem = {
        ...dead,
        committed: mergeCommitted(dead.committed, committed),
      };
      await writeJsonAtomic(deadPath, updated);
      return true;
    });
  }

  /** 标记/清除该 outbox 的 extraction 收口待办；dead 已落盘时必须仍可持久化。 */
  async markNeedsFinalize(
    id: string,
    needs: boolean,
    {
      outcome = 'dead',
      owner,
    }: { outcome?: OutboxReplayCompletion; owner?: string } = {},
  ): Promise<boolean> {
    return this.exclusive(async () => {
      const activePath = this.pathFor(id);
      const active = await readJsonFile<OutboxItem>(activePath);
      if (isOutboxItem(active)) {
        if (owner !== undefined && active.replayLeaseOwner !== owner) return false;
        const meta = { ...(active.meta ?? {}) };
        if (needs) {
          meta.needsFinalize = true;
          meta.finalizeOutcome = outcome;
        } else {
          delete meta.needsFinalize;
          delete meta.finalizeOutcome;
        }
        await writeJsonAtomic(activePath, { ...active, meta });
        return true;
      }
      const deadPath = this.deadPathFor(id);
      const dead = await readJsonFile<OutboxItem>(deadPath);
      if (!isOutboxItem(dead)) return false;
      if (owner !== undefined && dead.replayLeaseOwner !== owner) return false;
      const meta = { ...(dead.meta ?? {}) };
      if (needs) {
        meta.needsFinalize = true;
        meta.finalizeOutcome = outcome;
      } else {
        delete meta.needsFinalize;
        delete meta.finalizeOutcome;
      }
      await writeJsonAtomic(deadPath, { ...dead, meta });
      return true;
    });
  }

  /** 重启/后台重试读取所有待收口项。 */
  async listNeedsFinalize(): Promise<Array<{ item: OutboxItem; outcome: OutboxReplayCompletion }>> {
    return this.exclusive(async () => {
      const items = [...await this.readItems(), ...await this.readDeadItems()];
      return items
        .filter((item) => item.meta?.needsFinalize === true)
        .map((item) => ({
          item,
          outcome: item.meta?.finalizeOutcome ?? 'dead',
        }));
    });
  }

  /** 把活动 outbox 项关联到所属 extraction；重放清理时用其排除自身 pending 证据。 */
  async linkExtraction(id: string, extractionId: string): Promise<boolean> {
    return this.exclusive(async () => {
      const path = this.pathFor(id);
      const item = await readJsonFile<OutboxItem>(path);
      if (!isOutboxItem(item)) return false;
      const extractionIds = [...new Set([...(item.meta?.extractionIds ?? []), extractionId])];
      const updated: OutboxItem = {
        ...item,
        meta: { ...(item.meta ?? {}), extractionIds },
      };
      await writeJsonAtomic(path, updated);
      return true;
    });
  }


  /** 续租当前 replay；只延长租约，验证 owner 且租约未过期，绝不复用默认短租。 */
  async renewReplayLease(
    id: string,
    {
      owner,
      now = this.now(),
      leaseMs,
    }: { owner?: string; now?: number; leaseMs?: number } = {},
  ): Promise<boolean> {
    return this.exclusive(async () => {
      const path = this.pathFor(id);
      const item = await readJsonFile<OutboxItem>(path);
      if (!isOutboxItem(item)) return false;
      if (!owner || item.replayLeaseOwner !== owner) return false;
      if (typeof item.replayLeaseUntil !== 'number' || item.replayLeaseUntil <= now) return false;
      const effectiveLeaseMs = Math.max(
        1,
        Math.floor(leaseMs ?? item.replayLeaseMs ?? OUTBOX_REPLAY_LEASE_MS),
      );
      const until = now + effectiveLeaseMs;
      const updated: OutboxItem = {
        ...item,
        replayLeaseUntil: Math.max(until, typeof item.replayLeaseUntil === 'number' ? item.replayLeaseUntil : 0),
        replayLeaseMs: Math.max(effectiveLeaseMs, item.replayLeaseMs ?? 0),
      };
      await writeJsonAtomic(path, updated);
      return true;
    });
  }

  /**
   * 在 outbox 锁内计算仍被 in-flight lease 持有的 staging，并执行调用方的
   * staging 物理清理。lease 获取与清理因此线性化：要么清理先看到 lease，
   * 要么清理完成后才允许新的 replay 取得 lease。
   */
  async withLeasedStagingProtected<T>(
    now: number,
    operation: (protectedStagingIds: ReadonlySet<string>) => Promise<T> | T,
  ): Promise<T> {
    return this.exclusive(async () => {
      await this.init();
      const protectedStagingIds = new Set<string>();
      for (const item of await this.readItems()) {
        if (typeof item.replayLeaseUntil !== 'number' || item.replayLeaseUntil <= now) continue;
        for (const id of item.meta?.stagingChunkIds ?? []) protectedStagingIds.add(id);
      }
      return operation(protectedStagingIds);
    });
  }

  /**
   * 在 outbox 锁内使过期/依赖已删除的证据对应活动项显式 dead（跳过 leased/in-flight），
   * 并返回受 lease 保护的 staging；调用方随后在同一锁内执行 staging 清理。
   */
  async cleanupDependencies<T>(
    now: number,
    expiredStagingIds: readonly string[],
    operation: (protectedStagingIds: ReadonlySet<string>) => Promise<T> | T,
    onDead?: (item: OutboxItem) => void | Promise<void>,
  ): Promise<{ expired: number; result: T }> {
    const deadItems: OutboxItem[] = [];
    const outcome = await this.exclusive(async () => {
      await this.init();
      const expiredEvidence = new Set(expiredStagingIds);
      let expired = 0;
      const protectedStagingIds = new Set<string>();
      for (const item of await this.readItems()) {
        if (typeof item.replayLeaseUntil === 'number' && item.replayLeaseUntil > now) {
          for (const id of item.meta?.stagingChunkIds ?? []) protectedStagingIds.add(id);
          continue;
        }
        const needsExpiredEvidence = (item.meta?.stagingChunkIds ?? [])
          .some((id) => expiredEvidence.has(id));
        if (needsExpiredEvidence || this.deadlineOf(item) <= now) {
          if (await this.deadLetterUnlocked(item, 'retention_expired')) {
            expired += 1;
            deadItems.push(item);
          }
        }
      }
      const result = await operation(protectedStagingIds);
      return { expired, result };
    });
    for (const item of deadItems) await onDead?.(item);
    return outcome;
  }

  private async deadLetterUnlocked(item: OutboxItem, errorCode: string): Promise<boolean> {
    const path = this.pathFor(item.id);
    const dead: OutboxItem & { deadAt: number; error: string } = {
      ...item,
      body: minimizeOutboxValue(item.body),
      deadAt: this.now(),
      error: redactText(errorCode).text.slice(0, 128),
    };
    await writeJsonAtomic(this.deadPathFor(item.id), dead);
    await rm(path, { force: true });
    return true;
  }

  /** 永久失败（400/403/422）移入 dead/，保留审计但不无限重试。 */
  async deadLetter(id: string, errorCode: string): Promise<boolean> {
    return this.exclusive(async () => {
      await this.init();
      const item = await readJsonFile<OutboxItem>(this.pathFor(id));
      if (!isOutboxItem(item)) return false;
      if (typeof item.replayLeaseUntil === 'number' && item.replayLeaseUntil > this.now()) return false;
      return this.deadLetterUnlocked(item, errorCode);
    });
  }

  /** 记录一次失败尝试；retryDelayMs 为 0 时立即允许下一次重放。 */
  async recordAttempt(id: string, { error, retryDelayMs = 0 }: { error: string; retryDelayMs?: number }): Promise<OutboxItem | null> {
    return this.exclusive(async () => {
      const path = this.pathFor(id);
      const item = await readJsonFile<OutboxItem>(path);
      if (!isOutboxItem(item)) return null;
      const now = this.now();
      const updated: OutboxItem = {
        ...item,
        attempts: item.attempts + 1,
        lastAttemptAt: now,
        lastError: error,
        nextAttemptAt: now + Math.max(0, Math.floor(retryDelayMs)),
      };
      await writeJsonAtomic(path, updated);
      return updated;
    });
  }

  /** 在发送前原子取得有界 replay lease；过期项绝不发送。 */
  async acquireReplayLease(
    id: string,
    { now = this.now(), leaseMs = OUTBOX_REPLAY_LEASE_MS }: { now?: number; leaseMs?: number } = {},
  ): Promise<OutboxReplayLeaseResult> {
    return this.exclusive(async () => {
      const item = await readJsonFile<OutboxItem>(this.pathFor(id));
      if (!isOutboxItem(item)) return { state: 'expired' };
      if (this.deadlineOf(item) <= now) {
        await this.deadLetterUnlocked(item, 'retention_expired');
        return { state: 'expired' };
      }
      if (typeof item.replayLeaseUntil === 'number' && item.replayLeaseUntil > now) {
        return { state: 'leased' };
      }
      const effectiveLeaseMs = Math.max(1, Math.floor(leaseMs));
      const updated: OutboxItem = {
        ...item,
        replayLeaseUntil: now + effectiveLeaseMs,
        replayLeaseOwner: randomUUID(),
        replayLeaseMs: effectiveLeaseMs,
      };
      await writeJsonAtomic(this.pathFor(id), updated);
      return { state: 'acquired', item: updated };
    });
  }

  /** 按同一 deadline 完成 replay；验证 owner，retry/dead 还要求租约未过期。 */
  async completeReplay(
    id: string,
    {
      outcome,
      owner,
      now = this.now(),
      error = 'partial_failure',
      retryDelayMs = 0,
    }: {
      outcome: OutboxReplayCompletion;
      owner?: string;
      now?: number;
      error?: string;
      retryDelayMs?: number;
    },
  ): Promise<OutboxReplayCompletion> {
    return this.exclusive(async () => {
      const item = await readJsonFile<OutboxItem>(this.pathFor(id));
      if (!isOutboxItem(item)) {
        // 清理可能已把同一逻辑操作移入 dead；成功确认仍必须消除该过期 dead，
        // 避免 committed + dead 双态。partial/retry 不得复活已 dead 的项。
        const dead = await readJsonFile<OutboxItem>(this.deadPathFor(id));
        if (owner !== undefined && dead?.replayLeaseOwner !== undefined
          && dead.replayLeaseOwner !== owner) {
          return 'skipped';
        }
        if (outcome === 'settled') {
          await rm(this.deadPathFor(id), { force: true });
          return 'settled';
        }
        return isOutboxItem(dead) ? 'dead' : outcome;
      }
      if (owner !== undefined) {
        if (item.replayLeaseOwner !== owner) return 'skipped';
        if (outcome !== 'settled'
          && (typeof item.replayLeaseUntil !== 'number' || item.replayLeaseUntil <= now)) {
          return 'skipped';
        }
      }
      if (outcome === 'settled') {
        await rm(this.pathFor(id), { force: true });
        await rm(this.deadPathFor(id), { force: true });
        return 'settled';
      }
      if (outcome === 'dead' || this.deadlineOf(item) <= now) {
        await this.deadLetterUnlocked(item, this.deadlineOf(item) <= now ? 'retention_expired' : error);
        return 'dead';
      }
      const updated: OutboxItem = {
        ...item,
        attempts: item.attempts + 1,
        lastAttemptAt: now,
        lastError: redactText(error).text.slice(0, 128),
        nextAttemptAt: now + Math.max(0, Math.floor(retryDelayMs)),
        replayLeaseUntil: 0,
        replayLeaseOwner: undefined,
      };
      await writeJsonAtomic(this.pathFor(id), updated);
      return 'retry';
    });
  }

  /** 清理超过保留期的 dead letter；返回删除数量。 */
  async cleanupDead(now = this.now(), retentionDays = OUTBOX_DEAD_RETENTION_DAYS): Promise<number> {
    return this.exclusive(async () => {
      await this.init();
      return this.cleanupDeadUnlocked(now, retentionDays);
    });
  }

  /** D2：活动项最长排队 30 天（或更早操作 deadline），dead 再保留 30 天。 */
  async cleanup(now = this.now(), retentionDays = OUTBOX_DEAD_RETENTION_DAYS): Promise<OutboxCleanupResult> {
    return this.exclusive(async () => {
      await this.init();
      let expired = 0;
      for (const item of await this.readItems()) {
        if (this.deadlineOf(item) > now) continue;
        if (typeof item.replayLeaseUntil === 'number' && item.replayLeaseUntil > now) continue;
        if (await this.deadLetterUnlocked(item, 'retention_expired')) expired += 1;
      }
      const deadRemoved = await this.cleanupDeadUnlocked(now, retentionDays);
      return { expired, deadRemoved };
    });
  }

  private async cleanupDeadUnlocked(now: number, retentionDays: number): Promise<number> {
    const entries = await readdir(this.deadRoot, { withFileTypes: true }).catch(() => []);
    const cutoff = now - Math.max(0, retentionDays) * DAY_MS;
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const path = join(this.deadRoot, entry.name);
      const item = await readJsonFile<OutboxItem & { deadAt?: number }>(path);
      const deadAt = typeof item?.deadAt === 'number' ? item.deadAt : null;
      if (deadAt === null || deadAt <= cutoff) {
        await rm(path, { force: true });
        removed += 1;
      }
    }
    return removed;
  }

  async stats(): Promise<OutboxStats> {
    return this.exclusive(() => this.statsUnlocked());
  }

  async deadStats(): Promise<OutboxStats> {
    return this.exclusive(async () => {
      const entries = await readdir(this.deadRoot, { withFileTypes: true }).catch(() => []);
      let bytes = 0;
      let oldestAt: number | null = null;
      let items = 0;
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const item = await readJsonFile<OutboxItem & { deadAt?: number }>(join(this.deadRoot, entry.name));
        if (!item) continue;
        items += 1;
        bytes += itemBytes(item);
        const at = typeof item.deadAt === 'number' ? item.deadAt : item.createdAt;
        if (oldestAt === null || at < oldestAt) oldestAt = at;
      }
      return { items, bytes, oldestAt };
    });
  }

  async deadCount(): Promise<number> {
    return (await this.deadStats()).items;
  }
}

export class JsonCache {
  readonly root: string;
  readonly maxEntries: number;
  readonly maxBytes: number;

  private readonly now: () => number;
  private tail: Promise<void> = Promise.resolve();

  constructor({
    root,
    maxEntries = 5000,
    maxBytes = 67_108_864,
    now = Date.now,
  }: {
    root: string;
    maxEntries?: number;
    maxBytes?: number;
    now?: () => number;
  }) {
    this.root = root;
    this.maxEntries = Math.max(1, Math.floor(maxEntries));
    this.maxBytes = Math.max(1, Math.floor(maxBytes));
    this.now = now;
  }

  async init(): Promise<void> {
    await ensurePrivateDir(this.root);
  }

  private pathFor(key: string): string {
    if (typeof key !== 'string' || key.length === 0) {
      throw new LocalLayerError('invalid_cache_key', 'cache key 不能为空');
    }
    const hash = createHash('sha256').update(key, 'utf8').digest('hex');
    return join(this.root, `${hash}.json`);
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation, operation);
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async readEntriesUnlocked(): Promise<Array<CacheEntry & { path: string; bytes: number }>> {
    const entries = await readdir(this.root, { withFileTypes: true }).catch(() => []);
    const out: Array<CacheEntry & { path: string; bytes: number }> = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const path = join(this.root, entry.name);
      const record = await readJsonFile<CacheEntry>(path);
      if (!record || typeof record.key !== 'string' || typeof record.createdAt !== 'number') continue;
      out.push({ ...record, path, bytes: itemBytes(record) });
    }
    out.sort((a, b) => (a.lastAccessAt ?? a.createdAt) - (b.lastAccessAt ?? b.createdAt)
      || a.createdAt - b.createdAt || a.key.localeCompare(b.key));
    return out;
  }

  async getEntry<T>(key: string): Promise<CacheEntry<T> | null> {
    return this.exclusive(async () => {
      const path = this.pathFor(key);
      const record = await readJsonFile<CacheEntry<T>>(path);
      if (!record || record.key !== key) return null;
      const expiresAt = typeof record.expiresAt === 'number' ? record.expiresAt : 0;
      const now = this.now();
      if (expiresAt > 0 && expiresAt <= now) {
        await rm(path, { force: true });
        return null;
      }
      if (record.lastAccessAt !== now) {
        const touched = { ...record, lastAccessAt: now };
        await writeJsonAtomic(path, touched).catch(() => undefined);
        return touched;
      }
      return record;
    });
  }

  async get<T>(key: string): Promise<T | null> {
    const entry = await this.getEntry<T>(key);
    return entry ? entry.value : null;
  }

  async set<T>(
    key: string,
    value: T,
    { ttlMs = 0 }: { ttlMs?: number } = {},
  ): Promise<CacheEntry<T>> {
    return this.exclusive(async () => {
      await this.init();
      const path = this.pathFor(key);
      const now = this.now();
      const entry: CacheEntry<T> = {
        key,
        value,
        createdAt: now,
        lastAccessAt: now,
        expiresAt: Number.isFinite(ttlMs) && ttlMs > 0 ? now + Math.floor(ttlMs) : 0,
      };
      let bytes: number;
      try {
        bytes = itemBytes(entry);
      } catch {
        throw new LocalLayerError('invalid_cache_key', 'cache 值不可序列化');
      }
      if (bytes > this.maxBytes) {
        throw new LocalLayerError('storage_full', 'cache 条目超过单条上限');
      }

      const existing = await this.readEntriesUnlocked();
      const existingBytes = existing
        .filter((record) => record.key === key)
        .reduce((sum, record) => sum + record.bytes, 0);
      const existingCount = existing.filter((record) => record.key === key).length;
      let count = existing.length - existingCount;
      let totalBytes = existing.reduce((sum, record) => sum + record.bytes, 0) - existingBytes;

      for (const record of existing) {
        if (record.key === key) continue;
        if (count + 1 <= this.maxEntries && totalBytes + bytes <= this.maxBytes) break;
        await rm(record.path, { force: true });
        count -= 1;
        totalBytes -= record.bytes;
      }

      await writeJsonAtomic(path, entry);
      return entry;
    });
  }

  async delete(key: string): Promise<boolean> {
    return this.exclusive(async () => {
      const path = this.pathFor(key);
      const record = await readJsonFile<CacheEntry>(path);
      if (!record || record.key !== key) return false;
      await rm(path, { force: true });
      return true;
    });
  }

  async clear(): Promise<number> {
    return this.exclusive(async () => {
      const entries = await readdir(this.root, { withFileTypes: true }).catch(() => []);
      let removed = 0;
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        await rm(join(this.root, entry.name), { force: true });
        removed += 1;
      }
      return removed;
    });
  }

  /** 内部维护/恢复读取；不暴露文件路径。 */
  async list<T = unknown>(keyPrefix?: string): Promise<Array<CacheEntry<T>>> {
    return this.exclusive(async () => {
      const now = this.now();
      const entries = await this.readEntriesUnlocked();
      const out: Array<CacheEntry<T>> = [];
      for (const entry of entries) {
        if (keyPrefix && !entry.key.startsWith(keyPrefix)) continue;
        if (entry.expiresAt > 0 && entry.expiresAt <= now) {
          await rm(entry.path, { force: true });
          continue;
        }
        out.push({
          key: entry.key,
          value: entry.value as T,
          createdAt: entry.createdAt,
          ...(typeof entry.lastAccessAt === 'number' ? { lastAccessAt: entry.lastAccessAt } : {}),
          expiresAt: entry.expiresAt,
        });
      }
      return out;
    });
  }

  /** TTL + LRU 条数/字节容量清理；返回实际物理删除数。 */
  async cleanup(now = this.now()): Promise<number> {
    return this.exclusive(async () => {
      await this.init();
      const entries = await this.readEntriesUnlocked();
      let removed = 0;
      const live: typeof entries = [];
      for (const entry of entries) {
        if (entry.expiresAt > 0 && entry.expiresAt <= now) {
          await rm(entry.path, { force: true });
          removed += 1;
        } else {
          live.push(entry);
        }
      }
      let bytes = live.reduce((sum, entry) => sum + entry.bytes, 0);
      while (live.length > this.maxEntries || bytes > this.maxBytes) {
        const oldest = live.shift();
        if (!oldest) break;
        await rm(oldest.path, { force: true });
        bytes -= oldest.bytes;
        removed += 1;
      }
      return removed;
    });
  }

  async stats(): Promise<CacheStats> {
    return this.exclusive(async () => {
      const entries = await this.readEntriesUnlocked();
      const ages = entries.map((entry) => entry.createdAt);
      return {
        entries: entries.length,
        bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
        oldestAt: ages.length > 0 ? Math.min(...ages) : null,
      };
    });
  }
}

/** sidecar 本地层门面：统一初始化/统计 staging、Trace、cache、detail cache、outbox。 */
export class SidecarLocalLayer {
  readonly root: string;
  readonly store: RuntimeLocalStore;
  readonly outbox: BoundedOutbox;
  readonly cache: JsonCache;
  readonly detailCache: JsonCache;

  private readonly now: () => number;
  private readonly stagingHours: number;
  private readonly detailCacheTtlMs: number;
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null;
  private maintenanceInFlight: Promise<LocalMaintenanceStatus['lastResult']> | null = null;
  private maintenanceIntervalMs = LOCAL_MAINTENANCE_INTERVAL_MS;
  private maintenanceLastAttemptAt: number | null = null;
  private maintenanceLastSuccessAt: number | null = null;
  private maintenanceLastError: LocalMaintenanceStatus['lastError'] = null;
  private maintenanceLastResult: LocalMaintenanceStatus['lastResult'] = null;
  private lastCleanupAt = 0;
  private stagingDependencyHandler?: (ids: readonly string[]) => void | Promise<void>;
  private maintenanceDependencyHandler?: (ids: readonly string[]) => void | Promise<void>;
  private deadLetterHandler?: (item: OutboxItem) => void | Promise<void>;
  private stagingDeadLetterHandler?: (item: OutboxItem) => void | Promise<void>;

  constructor(options: SidecarLocalLayerOptions) {
    this.root = options.root;
    this.now = options.now ?? Date.now;
    this.stagingHours = Math.max(0.001, options.stagingHours ?? 24);
    this.detailCacheTtlMs = Math.max(0, options.detailCacheDays ?? 30) * DAY_MS;
    this.store = new RuntimeLocalStore({
      root: options.root,
      stagingHours: options.stagingHours,
      stagingMaxBytes: options.stagingBytes,
      traceRetentionDays: options.traceRetentionDays,
      traceMaxEntries: options.traceMaxEntries,
      now: options.now,
    });
    this.outbox = new BoundedOutbox({
      root: join(options.root, 'outbox'),
      deadRoot: join(options.root, 'outbox', 'dead'),
      maxItems: options.maxOutboxItems,
      maxBytes: options.maxOutboxBytes,
      now: options.now,
    });
    this.cache = new JsonCache({
      root: join(options.root, 'cache'),
      maxEntries: options.maxCacheEntries,
      maxBytes: options.maxCacheBytes,
      now: options.now,
    });
    this.detailCache = new JsonCache({
      root: join(options.root, 'cache', 'details'),
      maxEntries: options.detailCacheMaxEntries,
      maxBytes: options.detailCacheBytes,
      now: options.now,
    });
  }

  async init(): Promise<void> {
    await ensurePrivateDir(this.root);
    await Promise.all([
      ensurePrivateDir(join(this.root, 'staging')),
      ensurePrivateDir(join(this.root, 'cache')),
      ensurePrivateDir(join(this.root, 'cache', 'details')),
      ensurePrivateDir(join(this.root, 'outbox')),
      ensurePrivateDir(join(this.root, 'outbox', 'dead')),
      ensurePrivateDir(join(this.root, 'logs')),
      ensurePrivateDir(join(this.root, 'tmp')),
      ensurePrivateDir(join(this.root, 'models')),
    ]);
    await this.store.load();
    await this.outbox.init();
    await this.cache.init();
    await this.detailCache.init();
    // Settlement 的启动维护统一先通知 ingest/outbox 依赖，再物理清理。
    // 这里不得提前 prune staging，否则 pending extraction 会失去失败通知。
  }

  async stats(): Promise<SidecarLocalLayerStats> {
    const [stagingStats, cacheStats, detailCacheStats, outboxStats, deadStats] = await Promise.all([
      this.store.stats(),
      this.cache.stats(),
      this.detailCache.stats(),
      this.outbox.stats(),
      this.outbox.deadStats(),
    ]);
    return {
      stagingChunks: stagingStats.stagingChunks,
      stagingBytes: stagingStats.stagingBytes,
      stagingOldestAt: stagingStats.stagingOldestAt,
      traces: stagingStats.traces,
      traceBytes: stagingStats.traceBytes,
      traceOldestAt: stagingStats.traceOldestAt,
      cacheEntries: cacheStats.entries,
      cacheBytes: cacheStats.bytes,
      cacheOldestAt: cacheStats.oldestAt ?? null,
      detailCacheEntries: detailCacheStats.entries,
      detailCacheBytes: detailCacheStats.bytes,
      detailCacheOldestAt: detailCacheStats.oldestAt ?? null,
      outboxItems: outboxStats.items,
      outboxBytes: outboxStats.bytes,
      outboxOldestAt: outboxStats.oldestAt,
      deadLetter: deadStats.items,
      deadLetterBytes: deadStats.bytes,
      deadLetterOldestAt: deadStats.oldestAt,
    };
  }

  setStagingDependencyHandler(handler: (ids: readonly string[]) => void | Promise<void>): void {
    this.stagingDependencyHandler = handler;
  }

  setMaintenanceDependencyHandler(handler: (ids: readonly string[]) => void | Promise<void>): void {
    this.maintenanceDependencyHandler = handler;
  }

  setDeadLetterHandler(handler: (item: OutboxItem) => void | Promise<void>): void {
    this.deadLetterHandler = handler;
  }

  setStagingDeadLetterHandler(handler: (item: OutboxItem) => void | Promise<void>): void {
    this.stagingDeadLetterHandler = handler;
  }

  private async notifyStagingDeadLetters(items: readonly OutboxItem[]): Promise<void> {
    const handler = this.stagingDeadLetterHandler;
    if (!handler || items.length === 0) return;
    for (const item of items) await handler(item);
  }

  private async notifyDeadLetters(
    items: readonly OutboxItem[],
    { wait = true }: { wait?: boolean } = {},
  ): Promise<void> {
    const handler = this.deadLetterHandler;
    if (!handler || items.length === 0) return;
    const run = Promise.all(items.map((item) =>
      Promise.resolve(handler(item)))).then(() => undefined);
    if (wait) {
      await run;
    } else {
      void run;
    }
  }

  /** staging 写入后核对容量/TTL 淘汰，依赖已消失证据的重放必须显式 dead。 */
  async putStagingChunk(cloudId: string, chunk: RawChunk) {
    const before = await this.store.listStagingChunks({ includeExpired: true });
    // 配额淘汰同样不得删除 in-flight replay 依赖；与 lease 获取共用 outbox 锁。
    const result = await this.outbox.withLeasedStagingProtected(
      this.now(),
      (protectedStagingIds) => this.store.putStagingChunk(cloudId, chunk, {
        keepIds: protectedStagingIds,
      }),
    );
    const after = new Set((await this.store.listStagingChunks({ includeExpired: true }))
      .map((entry) => entry.id));
    const removed = before.map((entry) => entry.id).filter((id) => !after.has(id));
    await this.failStagingDependents(removed);
    await this.stagingDependencyHandler?.(removed);
    return result;
  }

  private async failStagingDependents(ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const expired = new Set(ids);
    let failed = 0;
    const deadItems: OutboxItem[] = [];
    for (const item of await this.outbox.list()) {
      const needed = item.meta?.stagingChunkIds ?? [];
      if (!needed.some((id) => expired.has(id))) continue;
      if (await this.outbox.deadLetter(item.id, 'retention_expired')) {
        failed += 1;
        deadItems.push(item);
      }
    }
    // putStagingChunk 在 ingest chain 内，使用不重新进入 chain 的直接收口并等待落盘。
    await this.notifyStagingDeadLetters(deadItems);
    return failed;
  }

  private expiredStagingIds(chunks: RawChunk[], now: number): string[] {
    const ageCutoff = now - this.stagingHours * 60 * 60 * 1000;
    return chunks.filter((chunk) => chunk.expiresAt <= now || chunk.at < ageCutoff)
      .map((chunk) => chunk.id);
  }

  async cleanup(now = this.now()): Promise<RuntimeLocalCleanupResult> {
    const staged = await this.store.listStagingChunks({ includeExpired: true });
    const expiredIds = this.expiredStagingIds(staged, now);
    await this.stagingDependencyHandler?.(expiredIds);
    const { result } = await this.outbox.cleanupDependencies(
      now,
      expiredIds,
      (protectedStagingIds) => this.store.cleanup(now, protectedStagingIds),
      (item) => this.notifyDeadLetters([item]),
    );
    this.lastCleanupAt = now;
    return result;
  }

  async cleanupIfDue(now = this.now()): Promise<RuntimeLocalCleanupResult | null> {
    if (now - this.lastCleanupAt < DAY_MS) return null;
    return this.cleanup(now);
  }

  /** 全量本地维护：staging/trace/cache/outbox/dead；每趟有界且幂等。 */
  runMaintenance(options: {
    now?: number;
    beforeStagingCleanup?: (ids: readonly string[]) => void | Promise<void>;
  } = {}): Promise<LocalMaintenanceStatus['lastResult']> {
    if (this.maintenanceInFlight) return this.maintenanceInFlight;
    const at = options.now ?? this.now();
    this.maintenanceLastAttemptAt = at;
    const run = (async () => {
      try {
        const staged = await this.store.listStagingChunks({ includeExpired: true });
        const expiredIds = this.expiredStagingIds(staged, at);
        const notify = options.beforeStagingCleanup ?? this.maintenanceDependencyHandler;
        await notify?.(expiredIds);
        const dependencyResult = await this.outbox.cleanupDependencies(
          at,
          expiredIds,
          (protectedStagingIds) => this.store.cleanup(at, protectedStagingIds),
          (item) => this.notifyDeadLetters([item]),
        );
        const storeResult = dependencyResult.result;
        this.lastCleanupAt = at;
        const [cacheRemoved, detailCacheRemoved, outboxResult] = await Promise.all([
          this.cache.cleanup(at),
          this.detailCache.cleanup(at),
          this.outbox.cleanup(at),
        ]);
        const stats = await this.stats();
        const oldestValues = [
          stats.stagingOldestAt,
          stats.traceOldestAt,
          stats.cacheOldestAt,
          stats.detailCacheOldestAt,
          stats.outboxOldestAt,
          stats.deadLetterOldestAt,
        ].filter((value): value is number => typeof value === 'number');
        const oldestAt = oldestValues.length > 0 ? Math.min(...oldestValues) : null;
        const bytes = stats.stagingBytes + stats.traceBytes + stats.cacheBytes
          + stats.detailCacheBytes + stats.outboxBytes + stats.deadLetterBytes;
        this.maintenanceLastResult = {
          stagingChunks: storeResult.stagingChunks,
          traces: storeResult.traces,
          cacheRemoved,
          detailCacheRemoved,
          outboxExpired: dependencyResult.expired + outboxResult.expired,
          deadRemoved: outboxResult.deadRemoved,
          bytes,
          oldestAgeMs: oldestAt === null ? null : Math.max(0, at - oldestAt),
        };
        this.maintenanceLastSuccessAt = at;
        this.maintenanceLastError = null;
        return this.maintenanceLastResult;
      } catch (error) {
        const rawCode = (error as { code?: unknown })?.code;
        const code = typeof rawCode === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(rawCode)
          ? rawCode
          : 'maintenance_failed';
        this.maintenanceLastError = { code, at };
        throw error;
      }
    })().finally(() => {
      this.maintenanceInFlight = null;
    });
    this.maintenanceInFlight = run;
    return run;
  }

  startMaintenance(options: {
    intervalMs?: number;
    setIntervalFn?: typeof setInterval;
    clearIntervalFn?: typeof clearInterval;
    beforeStagingCleanup?: (ids: readonly string[]) => void | Promise<void>;
  } = {}): LocalMaintenanceStatus {
    if (this.maintenanceTimer) return this.maintenanceStatus();
    this.maintenanceIntervalMs = Math.max(10, Math.floor(options.intervalMs ?? LOCAL_MAINTENANCE_INTERVAL_MS));
    const setIntervalFn = options.setIntervalFn ?? setInterval;
    this.maintenanceClearIntervalFn = options.clearIntervalFn ?? clearInterval;
    this.maintenanceTimer = setIntervalFn(() => {
      void this.runMaintenance({ beforeStagingCleanup: options.beforeStagingCleanup }).catch(() => undefined);
    }, this.maintenanceIntervalMs);
    this.maintenanceTimer.unref?.();
    return this.maintenanceStatus();
  }

  private maintenanceClearIntervalFn: typeof clearInterval = clearInterval;

  stopMaintenance(): LocalMaintenanceStatus {
    if (this.maintenanceTimer) {
      this.maintenanceClearIntervalFn(this.maintenanceTimer);
      this.maintenanceTimer = null;
    }
    return this.maintenanceStatus();
  }

  idleMaintenance(): Promise<LocalMaintenanceStatus['lastResult']> {
    return this.maintenanceInFlight ?? Promise.resolve(this.maintenanceLastResult);
  }

  maintenanceStatus(): LocalMaintenanceStatus {
    return {
      running: this.maintenanceTimer !== null,
      intervalMs: this.maintenanceIntervalMs,
      lastAttemptAt: this.maintenanceLastAttemptAt,
      lastSuccessAt: this.maintenanceLastSuccessAt,
      lastError: this.maintenanceLastError ? { ...this.maintenanceLastError } : null,
      lastResult: this.maintenanceLastResult ? { ...this.maintenanceLastResult } : null,
    };
  }

  /** 成功沉降后清理 staging；失败只保留到 TTL，不影响已写入记录。 */
  async clearStaging(ids: readonly string[]): Promise<number> {
    return this.store.deleteStagingChunks(ids);
  }

  // ---------- 详情只读缓存 ----------

  detailCacheKey(id: string): string {
    return `detail:v1:${id}`;
  }

  async getCachedDetail<T = unknown>(id: string): Promise<T | null> {
    const key = this.detailCacheKey(id);
    const cached = await this.detailCache.get<T>(key);
    const detail = (cached as { detail?: {
      expiresAt?: unknown;
      deletedAt?: unknown;
      availability?: unknown;
    } } | null)?.detail;
    const expiresAt = typeof detail?.expiresAt === 'number' ? detail.expiresAt : 0;
    const availability = Array.isArray(detail?.availability) ? detail.availability : [];
    const unavailable = (detail?.deletedAt !== undefined && detail?.deletedAt !== null)
      || (expiresAt > 0 && expiresAt <= this.now())
      || availability.some((value) => value === 'expired' || value === 'deleted' || value === 'quota_evicted');
    if (unavailable) {
      await this.detailCache.delete(key);
      return null;
    }
    return cached;
  }

  async putCachedDetail<T>(id: string, value: T, ttlMs?: number): Promise<void> {
    const detail = (value as { detail?: {
      expiresAt?: unknown;
      deletedAt?: unknown;
      availability?: unknown;
    } })?.detail;
    const expiresAt = typeof detail?.expiresAt === 'number' ? detail.expiresAt : 0;
    const availability = Array.isArray(detail?.availability) ? detail.availability : [];
    if ((detail?.deletedAt !== undefined && detail?.deletedAt !== null)
      || (expiresAt > 0 && expiresAt <= this.now())
      || availability.some((entry) => entry === 'expired' || entry === 'deleted' || entry === 'quota_evicted')) {
      await this.invalidateCachedDetail(id);
      return;
    }
    const retentionTtl = expiresAt > 0 ? Math.max(1, expiresAt - this.now()) : this.detailCacheTtlMs;
    const effectiveTtl = Math.max(1, Math.min(ttlMs ?? this.detailCacheTtlMs, retentionTtl));
    try {
      await this.detailCache.set(this.detailCacheKey(id), value, { ttlMs: effectiveTtl });
    } catch {
      // 缓存失败不影响读取能力；下一次重新向 capability 取。
    }
  }

  async invalidateCachedDetail(id: string): Promise<boolean> {
    return this.detailCache.delete(this.detailCacheKey(id));
  }
}
