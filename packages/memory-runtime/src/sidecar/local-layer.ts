// Memory Runtime sidecar 本地层：Raw / Trace / cache / outbox。
//
// 这些都是本机过程数据，可重建、非权威；删除不影响已沉降到忆云的记忆。
// Raw/Trace 复用现有 RuntimeLocalStore，但 root 固定为 `<home>/memory-runtime`，
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

const OUTBOX_ITEM_RE = /^[A-Za-z0-9._:-]{1,128}$/;

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
}

export interface OutboxEnqueueInput {
  id?: string;
  requestId?: string;
  endpoint: string;
  method?: 'GET' | 'POST';
  body: unknown;
  createdAt?: number;
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

export interface CacheEntry<T = unknown> {
  key: string;
  value: T;
  createdAt: number;
  expiresAt: number;
}

export interface CacheStats {
  entries: number;
  bytes: number;
}

export interface SidecarLocalLayerOptions {
  root: string;
  rawRetentionDays?: number;
  traceRetentionDays?: number;
  traceMaxEntries?: number;
  maxOutboxItems?: number;
  maxOutboxBytes?: number;
  maxCacheEntries?: number;
  maxCacheBytes?: number;
  now?: () => number;
}

export interface SidecarLocalLayerStats {
  rawChunks: number;
  traces: number;
  cacheEntries: number;
  cacheBytes: number;
  outboxItems: number;
  outboxBytes: number;
  deadLetter: number;
}

/** 创建 sidecar 本地目录（全部 0700）。 */
export async function ensureSidecarDirectories(paths: SidecarPaths): Promise<void> {
  await Promise.all([
    ensurePrivateDir(paths.dataDir),
    ensurePrivateDir(paths.rawDir),
    ensurePrivateDir(paths.cacheDir),
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
    return join(this.deadRoot, `${id}.json`);
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
      if (isOutboxItem(existing)) return { item: existing, duplicate: true };

      const item: OutboxItem = {
        version: 1,
        id,
        requestId: input.requestId ?? id,
        endpoint: input.endpoint.startsWith('/') ? input.endpoint : `/${input.endpoint}`,
        method: input.method ?? 'POST',
        body: input.body,
        createdAt: input.createdAt ?? this.now(),
        attempts: 0,
        lastAttemptAt: null,
        lastError: null,
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

  async remove(id: string): Promise<boolean> {
    return this.exclusive(async () => {
      const path = this.pathFor(id);
      const item = await readJsonFile<OutboxItem>(path);
      if (!isOutboxItem(item)) return false;
      await rm(path, { force: true });
      return true;
    });
  }

  /** 永久失败（400/403/422）移入 dead/，保留审计但不无限重试。 */
  async deadLetter(id: string, errorCode: string): Promise<boolean> {
    return this.exclusive(async () => {
      await this.init();
      const path = this.pathFor(id);
      const item = await readJsonFile<OutboxItem>(path);
      if (!isOutboxItem(item)) return false;
      const dead: OutboxItem & { deadAt: number; error: string } = {
        ...item,
        deadAt: this.now(),
        error: errorCode,
      };
      await writeJsonAtomic(this.deadPathFor(id), dead);
      await rm(path, { force: true });
      return true;
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

  /** 清理超过保留期的 dead letter；返回删除数量。 */
  async cleanupDead(now = this.now(), retentionDays = 30): Promise<number> {
    return this.exclusive(async () => {
      await this.init();
      const entries = await readdir(this.deadRoot, { withFileTypes: true }).catch(() => []);
      const cutoff = now - Math.max(0, retentionDays) * 24 * 60 * 60 * 1000;
      let removed = 0;
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const path = join(this.deadRoot, entry.name);
        const item = await readJsonFile<OutboxItem & { deadAt?: number }>(path);
        const deadAt = typeof item?.deadAt === 'number' ? item.deadAt : null;
        if (deadAt === null || deadAt < cutoff) {
          await rm(path, { force: true });
          removed += 1;
        }
      }
      return removed;
    });
  }

  async stats(): Promise<OutboxStats> {
    return this.exclusive(() => this.statsUnlocked());
  }

  async deadCount(): Promise<number> {
    const entries = await readdir(this.deadRoot, { withFileTypes: true }).catch(() => []);
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json')).length;
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
    out.sort((a, b) => a.createdAt - b.createdAt || a.key.localeCompare(b.key));
    return out;
  }

  async getEntry<T>(key: string): Promise<CacheEntry<T> | null> {
    return this.exclusive(async () => {
      const path = this.pathFor(key);
      const record = await readJsonFile<CacheEntry<T>>(path);
      if (!record || record.key !== key) return null;
      const expiresAt = typeof record.expiresAt === 'number' ? record.expiresAt : 0;
      if (expiresAt > 0 && expiresAt <= this.now()) {
        await rm(path, { force: true });
        return null;
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

  async stats(): Promise<CacheStats> {
    return this.exclusive(async () => {
      const entries = await this.readEntriesUnlocked();
      return {
        entries: entries.length,
        bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
      };
    });
  }
}

/** sidecar 本地层门面：统一初始化/统计 Raw、Trace、cache、outbox。 */
export class SidecarLocalLayer {
  readonly root: string;
  readonly store: RuntimeLocalStore;
  readonly outbox: BoundedOutbox;
  readonly cache: JsonCache;

  constructor(options: SidecarLocalLayerOptions) {
    this.root = options.root;
    this.store = new RuntimeLocalStore({
      root: options.root,
      rawRetentionDays: options.rawRetentionDays,
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
  }

  async init(): Promise<void> {
    await ensurePrivateDir(this.root);
    await Promise.all([
      ensurePrivateDir(join(this.root, 'raw')),
      ensurePrivateDir(join(this.root, 'cache')),
      ensurePrivateDir(join(this.root, 'outbox')),
      ensurePrivateDir(join(this.root, 'outbox', 'dead')),
      ensurePrivateDir(join(this.root, 'logs')),
      ensurePrivateDir(join(this.root, 'tmp')),
      ensurePrivateDir(join(this.root, 'models')),
    ]);
    await this.store.init();
    await this.outbox.init();
    await this.cache.init();
  }

  async stats(): Promise<SidecarLocalLayerStats> {
    const [rawStats, cacheStats, outboxStats, deadLetter] = await Promise.all([
      this.store.stats(),
      this.cache.stats(),
      this.outbox.stats(),
      this.outbox.deadCount(),
    ]);
    return {
      rawChunks: rawStats.rawChunks,
      traces: rawStats.traces,
      cacheEntries: cacheStats.entries,
      cacheBytes: cacheStats.bytes,
      outboxItems: outboxStats.items,
      outboxBytes: outboxStats.bytes,
      deadLetter,
    };
  }

  async cleanup(now = Date.now()): Promise<RuntimeLocalCleanupResult> {
    return this.store.cleanup(now);
  }

  /** 本地保留清理：Raw/Trace 由 store 处理，cache/outbox 的 TTL 在读取时处理。 */
  async cleanupIfDue(now = Date.now()): Promise<RuntimeLocalCleanupResult | null> {
    return this.store.cleanupIfDue(now);
  }
}
