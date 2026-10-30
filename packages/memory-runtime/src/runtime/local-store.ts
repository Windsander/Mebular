// Runtime 本地存储（contract §2.3.1 / §2.3.5 / §2.9）
//
// staging chunk 与 RecallTrace 只存在于本机 sidecar 数据目录（`<home>/memory-runtime/`）：
//   - staging/chunks.jsonl（已接收、未成功写入 capability 的 chunk；不是权威）
//   - traces.jsonl
// 不进 GraphStore、不 append EventLog、不参与同步；成功沉降后由调用方删除。
//
// 写入策略：JSONL 追加（O_APPEND）+ fsync；文件 0600、目录 0700。
// 崩溃恢复：加载时丢弃损坏行；若文件末尾没有换行（可能是半行），
// 先原子重写为完整 JSONL，再允许后续追加，避免半行粘连下一条记录。
// 清理/删除/反馈更新使用临时文件 + rename 原子替换。

import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ulid } from 'ulid';
import type { RawChunk, RecallTrace } from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export type RuntimeLocalStoreErrorCode =
  | 'invalid_raw_chunk'
  | 'content_hash_mismatch'
  | 'invalid_trace'
  | 'storage_failed';

export class RuntimeLocalStoreError extends Error {
  readonly code: RuntimeLocalStoreErrorCode;

  constructor(message: string, code: RuntimeLocalStoreErrorCode) {
    super(message);
    this.name = 'RuntimeLocalStoreError';
    this.code = code;
  }
}

export interface RuntimeLocalStoreOptions {
  /** 本地过程数据根目录（sidecar 固定 `<home>/memory-runtime`） */
  root: string;
  /** staging chunk 保留小时数（用于清理；单条 expiresAt 仍由调用方设置） */
  stagingHours?: number;
  /** staging 总字节上限；超过时先淘汰最旧 chunk。 */
  stagingMaxBytes?: number;
  /** RecallTrace 保留天数 */
  traceRetentionDays?: number;
  /** RecallTrace 环形上限 */
  traceMaxEntries?: number;
  now?: () => number;
}

export interface RawChunkWriteResult {
  chunk: RawChunk;
  duplicate: boolean;
}

export interface RawChunkFilter {
  cloudId?: string;
  agentId?: string;
  threadId?: string;
  includeExpired?: boolean;
}

export interface RecallTraceFilter {
  agentId?: string;
  threadId?: string;
  limit?: number;
  includeExpired?: boolean;
}

export interface RuntimeLocalCleanupResult {
  stagingChunks: number;
  traces: number;
}

export interface RuntimeLocalStoreStats {
  stagingChunks: number;
  traces: number;
  stagingPath: string;
  tracesPath: string;
}

interface StoredRawChunk {
  cloudId: string;
  chunk: RawChunk;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function newRawChunkId(): string {
  return `rc_${ulid()}`;
}

export function newRecallTraceId(): string {
  return `tr_${ulid()}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readRawLine(value: unknown): StoredRawChunk | null {
  if (!isRecord(value) || typeof value.cloudId !== 'string' || !isRecord(value.chunk)) return null;
  const chunk = value.chunk;
  if (typeof chunk.id !== 'string' || typeof chunk.agentId !== 'string'
    || typeof chunk.threadId !== 'string' || typeof chunk.contentHash !== 'string'
    || typeof chunk.text !== 'string' || typeof chunk.expiresAt !== 'number') {
    return null;
  }
  return value as unknown as StoredRawChunk;
}

function readTraceLine(value: unknown): RecallTrace | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.cloudId !== 'string'
    || typeof value.agentId !== 'string' || typeof value.at !== 'number') {
    return null;
  }
  return value as unknown as RecallTrace;
}

export class RuntimeLocalStore {
  readonly root: string;
  readonly stagingPath: string;
  readonly tracesPath: string;

  private readonly stagingHours: number;
  private readonly stagingMaxBytes: number;
  private readonly traceRetentionDays: number;
  private readonly traceMaxEntries: number;
  private readonly now: () => number;

  private staging: StoredRawChunk[] = [];
  private traces: RecallTrace[] = [];
  private stagingLoaded = false;
  private tracesLoaded = false;
  private lastCleanupAt = 0;

  /** 进程内串行化，避免并发 append/重写互相覆盖。 */
  private tail: Promise<void> = Promise.resolve();

  constructor(options: RuntimeLocalStoreOptions) {
    this.root = options.root;
    this.stagingPath = join(this.root, 'staging', 'chunks.jsonl');
    this.tracesPath = join(this.root, 'traces.jsonl');
    this.stagingHours = Math.max(0.001, options.stagingHours ?? 24);
    this.stagingMaxBytes = Math.max(1, Math.floor(options.stagingMaxBytes ?? 268_435_456));
    this.traceRetentionDays = Math.max(0, options.traceRetentionDays ?? 7);
    this.traceMaxEntries = Math.max(1, Math.floor(options.traceMaxEntries ?? 2000));
    this.now = options.now ?? Date.now;
  }

  /** 启动时调用：加载本地对象并执行一次过期清理。 */
  async init(): Promise<void> {
    await ensureDir(this.root);
    await this.exclusive(async () => {
      await this.ensureStagingLoaded();
      await this.ensureTracesLoaded();
      await this.prune(this.now());
    });
  }

  /** 显式清理（sidecar 启动时 + 每日一次）。 */
  async cleanup(now = this.now()): Promise<RuntimeLocalCleanupResult> {
    return this.exclusive(async () => {
      await this.ensureStagingLoaded();
      await this.ensureTracesLoaded();
      return this.prune(now);
    });
  }

  /** 距上次启动/清理超过一天时执行一次；未到期返回 null。 */
  async cleanupIfDue(now = this.now()): Promise<RuntimeLocalCleanupResult | null> {
    if (now - this.lastCleanupAt < DAY_MS) return null;
    return this.cleanup(now);
  }

  async stats(): Promise<RuntimeLocalStoreStats> {
    return this.exclusive(async () => {
      await this.ensureStagingLoaded();
      await this.ensureTracesLoaded();
      const now = this.now();
      return {
        stagingChunks: this.staging.filter((entry) => this.stagingAlive(entry.chunk, now)).length,
        traces: this.traces.filter((trace) => this.traceAlive(trace, now)).length,
        stagingPath: this.stagingPath,
        tracesPath: this.tracesPath,
      };
    });
  }

  // ---------- StagingChunk ----------

  /**
   * 写入本地 staging chunk。
   * 幂等键：`(cloudId, agentId, threadId, contentHash, chunkIndex)`。
   * 同键同文本返回已有记录 `duplicate=true`；同键不同文本拒绝 `content_hash_mismatch`。
   * staging 不是权威；超过总字节上限时淘汰最旧 chunk。
   */
  async putStagingChunk(cloudId: string, chunk: RawChunk): Promise<RawChunkWriteResult> {
    if (typeof cloudId !== 'string' || cloudId.length === 0) {
      throw new RuntimeLocalStoreError('cloudId 不能为空', 'invalid_raw_chunk');
    }
    this.validateRawChunk(chunk);

    return this.exclusive(async () => {
      await this.ensureStagingLoaded();
      const now = this.now();
      const expiredDirty = this.pruneStaging(now);
      const key = rawKey(cloudId, chunk);

      const existing = this.staging.find((entry) => rawKey(entry.cloudId, entry.chunk) === key);
      if (existing) {
        if (existing.chunk.text !== chunk.text || existing.chunk.contentHash !== chunk.contentHash) {
          throw new RuntimeLocalStoreError(
            '相同幂等键但内容哈希/文本不一致',
            'content_hash_mismatch',
          );
        }
        if (expiredDirty) await this.writeStagingAtomic();
        return { chunk: existing.chunk, duplicate: true };
      }

      const record: StoredRawChunk = { cloudId, chunk };
      this.staging.push(record);
      const quotaDirty = this.enforceStagingQuota();
      if (expiredDirty || quotaDirty) await this.writeStagingAtomic();
      else await this.appendLine(this.stagingPath, record);
      return { chunk, duplicate: false };
    });
  }

  async getStagingChunk(id: string): Promise<RawChunk | null> {
    return this.exclusive(async () => {
      await this.ensureStagingLoaded();
      const found = this.staging.find((entry) => entry.chunk.id === id);
      if (!found || !this.stagingAlive(found.chunk, this.now())) return null;
      return found.chunk;
    });
  }

  async listStagingChunks(filter: RawChunkFilter = {}): Promise<RawChunk[]> {
    return this.exclusive(async () => {
      await this.ensureStagingLoaded();
      const now = this.now();
      return this.staging
        .filter(({ cloudId, chunk }) => {
          if (!filter.includeExpired && !this.stagingAlive(chunk, now)) return false;
          if (filter.cloudId !== undefined && cloudId !== filter.cloudId) return false;
          if (filter.agentId !== undefined && chunk.agentId !== filter.agentId) return false;
          if (filter.threadId !== undefined && chunk.threadId !== filter.threadId) return false;
          return true;
        })
        .map((entry) => entry.chunk);
    });
  }

  async countStagingChunks(filter: RawChunkFilter = {}): Promise<number> {
    return (await this.listStagingChunks(filter)).length;
  }

  async deleteStagingChunk(id: string): Promise<boolean> {
    return this.deleteStagingChunks([id]).then((count) => count > 0);
  }

  /** 成功沉降后批量清理 staging；返回删除数量。 */
  async deleteStagingChunks(ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const target = new Set(ids);
    return this.exclusive(async () => {
      await this.ensureStagingLoaded();
      const before = this.staging.length;
      this.staging = this.staging.filter((entry) => !target.has(entry.chunk.id));
      const removed = before - this.staging.length;
      if (removed > 0) await this.writeStagingAtomic();
      return removed;
    });
  }


  // ---------- RecallTrace ----------

  /** RecallTrace 不去重；同一 id 重复写入视为错误。 */
  async putTrace(trace: RecallTrace): Promise<RecallTrace> {
    this.validateTrace(trace);
    const normalized: RecallTrace = {
      ...trace,
      queryPreview: typeof trace.queryPreview === 'string'
        ? trace.queryPreview.slice(0, 200)
        : '',
      namespaces: Array.isArray(trace.namespaces) ? [...trace.namespaces] : [],
      hits: Array.isArray(trace.hits) ? trace.hits.map((hit) => ({ ...hit })) : [],
      model: { ...trace.model },
    };

    return this.exclusive(async () => {
      await this.ensureTracesLoaded();
      const now = this.now();
      if (this.traces.some((entry) => entry.id === normalized.id)) {
        throw new RuntimeLocalStoreError(`trace 已存在：${normalized.id}`, 'invalid_trace');
      }
      let dirty = this.pruneTraces(now);
      const next = [...this.traces, normalized];
      if (next.length > this.traceMaxEntries) {
        next.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
        this.traces = next.slice(-this.traceMaxEntries);
        dirty = true;
      } else {
        this.traces = next;
      }
      if (dirty) await this.writeTracesAtomic();
      else await this.appendLine(this.tracesPath, normalized);
      return normalized;
    });
  }

  async getTrace(id: string): Promise<RecallTrace | null> {
    return this.exclusive(async () => {
      await this.ensureTracesLoaded();
      return this.traces.find((trace) => trace.id === id) ?? null;
    });
  }

  /** `/expand` 用 recallId 找回 10 分钟内的 trace；同一 recallId 取最新一条。 */
  async getTraceByRecallId(recallId: string): Promise<RecallTrace | null> {
    return this.exclusive(async () => {
      await this.ensureTracesLoaded();
      let found: RecallTrace | null = null;
      for (const trace of this.traces) {
        if (trace.recallId !== recallId) continue;
        if (!found || trace.at > found.at) found = trace;
      }
      return found;
    });
  }

  async listTraces(filter: RecallTraceFilter = {}): Promise<RecallTrace[]> {
    return this.exclusive(async () => {
      await this.ensureTracesLoaded();
      const now = this.now();
      const matches = this.traces
        .filter((trace) => {
          if (!filter.includeExpired && !this.traceAlive(trace, now)) return false;
          if (filter.agentId !== undefined && trace.agentId !== filter.agentId) return false;
          if (filter.threadId !== undefined && trace.threadId !== filter.threadId) return false;
          return true;
        })
        .sort((a, b) => b.at - a.at);
      return filter.limit !== undefined ? matches.slice(0, filter.limit) : matches;
    });
  }

  async updateTraceFeedback(
    id: string,
    feedback: NonNullable<RecallTrace['feedback']>,
  ): Promise<RecallTrace | null> {
    return this.exclusive(async () => {
      await this.ensureTracesLoaded();
      const index = this.traces.findIndex((trace) => trace.id === id);
      if (index < 0) return null;
      const updated: RecallTrace = {
        ...this.traces[index]!,
        feedback: { ...feedback },
      };
      this.traces[index] = updated;
      await this.writeTracesAtomic();
      return updated;
    });
  }

  async deleteTrace(id: string): Promise<boolean> {
    return this.exclusive(async () => {
      await this.ensureTracesLoaded();
      const index = this.traces.findIndex((trace) => trace.id === id);
      if (index < 0) return false;
      this.traces.splice(index, 1);
      await this.writeTracesAtomic();
      return true;
    });
  }

  // ---------- 内部 ----------

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation, operation);
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  private validateRawChunk(chunk: RawChunk): void {
    if (!chunk || typeof chunk !== 'object') {
      throw new RuntimeLocalStoreError('RawChunk 必须是对象', 'invalid_raw_chunk');
    }
    if (typeof chunk.id !== 'string' || chunk.id.length === 0) {
      throw new RuntimeLocalStoreError('RawChunk.id 不能为空', 'invalid_raw_chunk');
    }
    if (typeof chunk.text !== 'string') {
      throw new RuntimeLocalStoreError('RawChunk.text 必须是字符串', 'invalid_raw_chunk');
    }
    if (typeof chunk.contentHash !== 'string' || chunk.contentHash.length === 0) {
      throw new RuntimeLocalStoreError('RawChunk.contentHash 不能为空', 'invalid_raw_chunk');
    }
    if (typeof chunk.at !== 'number' || !Number.isFinite(chunk.at)) {
      throw new RuntimeLocalStoreError('RawChunk.at 必须是有限数字', 'invalid_raw_chunk');
    }
    if (typeof chunk.expiresAt !== 'number' || !Number.isFinite(chunk.expiresAt)) {
      throw new RuntimeLocalStoreError('RawChunk.expiresAt 必须是有限数字', 'invalid_raw_chunk');
    }
  }

  private validateTrace(trace: RecallTrace): void {
    if (!trace || typeof trace !== 'object' || typeof trace.id !== 'string' || trace.id.length === 0) {
      throw new RuntimeLocalStoreError('RecallTrace.id 不能为空', 'invalid_trace');
    }
    if (typeof trace.cloudId !== 'string' || typeof trace.agentId !== 'string'
      || typeof trace.at !== 'number') {
      throw new RuntimeLocalStoreError('RecallTrace 缺少 cloudId/agentId/at', 'invalid_trace');
    }
  }

  private stagingAlive(chunk: RawChunk, now: number): boolean {
    return chunk.expiresAt > now && chunk.at >= now - this.stagingHours * 60 * 60 * 1000;
  }

  private traceAlive(trace: RecallTrace, now: number): boolean {
    return trace.at >= now - this.traceRetentionDays * DAY_MS;
  }

  private pruneStaging(now: number): boolean {
    const before = this.staging.length;
    this.staging = this.staging.filter((entry) => this.stagingAlive(entry.chunk, now));
    return this.staging.length !== before;
  }

  /**
   * staging 总字节上限（默认 256 MiB）。只淘汰最旧 chunk，不淘汰 trace；
   * staging 不是权威，超限宁可丢本地副本。
   */
  private enforceStagingQuota(): boolean {
    let total = this.staging.reduce((sum, entry) => sum + Buffer.byteLength(entry.chunk.text, 'utf8'), 0);
    if (total <= this.stagingMaxBytes) return false;
    const sorted = [...this.staging].sort((a, b) => a.chunk.at - b.chunk.at || a.chunk.id.localeCompare(b.chunk.id));
    const keep = new Set<StoredRawChunk>(this.staging);
    for (const entry of sorted) {
      if (total <= this.stagingMaxBytes) break;
      keep.delete(entry);
      total -= Buffer.byteLength(entry.chunk.text, 'utf8');
    }
    this.staging = this.staging.filter((entry) => keep.has(entry));
    return true;
  }

  private pruneTraces(now: number): boolean {
    const before = this.traces.length;
    this.traces = this.traces.filter((trace) => this.traceAlive(trace, now));
    if (this.traces.length > this.traceMaxEntries) {
      this.traces.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
      this.traces = this.traces.slice(-this.traceMaxEntries);
    }
    return this.traces.length !== before;
  }

  private async prune(now: number): Promise<RuntimeLocalCleanupResult> {
    const stagingDirty = this.pruneStaging(now);
    const traceDirty = this.pruneTraces(now);
    if (stagingDirty) await this.writeStagingAtomic();
    if (traceDirty) await this.writeTracesAtomic();
    this.lastCleanupAt = now;
    return {
      stagingChunks: this.staging.length,
      traces: this.traces.length,
    };
  }

  private async ensureStagingLoaded(): Promise<void> {
    if (this.stagingLoaded) return;
    const { values, dirty } = await readJsonl(this.stagingPath, readRawLine);
    this.staging = values;
    this.stagingLoaded = true;
    if (dirty) await this.writeStagingAtomic();
  }

  private async ensureTracesLoaded(): Promise<void> {
    if (this.tracesLoaded) return;
    const { values, dirty } = await readJsonl(this.tracesPath, readTraceLine);
    this.traces = values;
    this.tracesLoaded = true;
    if (dirty) await this.writeTracesAtomic();
  }

  private async writeStagingAtomic(): Promise<void> {
    await writeJsonlAtomic(this.stagingPath, this.staging);
  }

  private async writeTracesAtomic(): Promise<void> {
    await writeJsonlAtomic(this.tracesPath, this.traces);
  }

  private async appendLine(path: string, value: unknown): Promise<void> {
    await ensureDir(dirname(path));
    const handle = await open(path, 'a', 0o600);
    try {
      await handle.write(`${JSON.stringify(value)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(path, 0o600).catch(() => undefined);
  }
}

function rawKey(cloudId: string, chunk: RawChunk): string {
  return [cloudId, chunk.agentId, chunk.threadId, chunk.contentHash, chunk.chunkIndex ?? -1].join('\u0000');
}

async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700).catch(() => undefined);
}

async function readJsonl<T>(
  path: string,
  parse: (value: unknown) => T | null,
): Promise<{ values: T[]; dirty: boolean }> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { values: [], dirty: false };
    throw error;
  }
  if (text.length === 0) return { values: [], dirty: false };

  // 没有结尾换行说明最后一行可能是半行（崩溃中断）；即使能解析也先重写。
  let dirty = !text.endsWith('\n');
  const values: T[] = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim() === '') {
      if (index !== lines.length - 1) dirty = true;
      continue;
    }
    try {
      const parsed = parse(JSON.parse(line) as unknown);
      if (parsed === null) dirty = true;
      else values.push(parsed);
    } catch {
      dirty = true;
    }
  }
  return { values, dirty };
}

async function writeJsonlAtomic(path: string, values: readonly unknown[]): Promise<void> {
  await ensureDir(dirname(path));
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const body = values.length > 0 ? `${values.map((value) => JSON.stringify(value)).join('\n')}\n` : '';
  try {
    await writeFile(tmp, body, { encoding: 'utf8', mode: 0o600 });
    await chmod(tmp, 0o600).catch(() => undefined);
    const handle = await open(tmp, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw new RuntimeLocalStoreError(
      `本地 Runtime 写入失败：${path}（${String((error as Error)?.message ?? error)}）`,
      'storage_failed',
    );
  }
}
