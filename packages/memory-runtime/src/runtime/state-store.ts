// Runtime 本地状态存储（contract §2.3.4 / §2.6 / §2.9）
//
// 本文件承载两类「只在本机」的 Runtime 状态：
//   - 通用 JSON 状态：requestId 幂等记录、抽取任务（extractions）等；
//   - ContextCheckpoint 本地文件：<root>/<cloudId>/<agentId>/<threadId>.json。
//
// 所有写入都是「临时文件 + fsync + rename」原子替换，文件 0600、目录 0700；
// 不进入 GraphStore / EventLog / 同步。

import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ContextCheckpoint } from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700).catch(() => undefined);
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await ensureDir(dirname(path));
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
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
    throw error;
  }
}

export async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    // 损坏的本地状态不应拖垮 Runtime：按不存在处理（调用方可重新生成）。
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}

/** 通用原子 JSON 状态文件（单进程串行化）。 */
export class RuntimeStateStore {
  readonly root: string;
  private tail: Promise<void> = Promise.resolve();

  constructor(root: string) {
    this.root = root;
  }

  async init(): Promise<void> {
    await ensureDir(this.root);
  }

  private pathOf(name: string): string {
    return join(this.root, `${safeSegment(name)}.json`);
  }

  async read<T>(name: string, fallback: T): Promise<T> {
    await this.init();
    const value = await this.exclusive(() => readJsonFile<T>(this.pathOf(name)));
    return value ?? fallback;
  }

  async write(name: string, value: unknown): Promise<void> {
    await this.init();
    await this.exclusive(() => writeJsonAtomic(this.pathOf(name), value));
  }

  async remove(name: string): Promise<void> {
    await this.init();
    await this.exclusive(async () => {
      await rm(this.pathOf(name), { force: true });
    });
  }

  /** 列出状态文件名（去掉 .json）；用于统计本地 self 等对象。 */
  async listNames(prefix = ''): Promise<string[]> {
    await this.init();
    return this.exclusive(async () => {
      const entries = await readdir(this.root, { withFileTypes: true }).catch(() => []);
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => entry.name.slice(0, -'.json'.length))
        .filter((name) => name.startsWith(prefix));
    });
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation, operation);
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }
}

export interface RuntimeCheckpointStoreOptions {
  /** 通常 `<home>/runtime/checkpoints` */
  root: string;
  /** 过期清理保留天数（仅用于统计/清理；单条 expiresAt 仍是权威） */
  retentionDays?: number;
  now?: () => number;
}

export interface StoredLocalCheckpoint {
  cloudId: string;
  checkpoint: ContextCheckpoint;
}

/**
 * ContextCheckpoint 本地存储。
 * 读取键 `(cloudId, agentId, threadId)`；同一 Agent 相同 threadId 才可见。
 */
export class RuntimeCheckpointStore {
  readonly root: string;
  private readonly retentionDays: number;
  private readonly now: () => number;
  private tail: Promise<void> = Promise.resolve();

  constructor(options: RuntimeCheckpointStoreOptions) {
    this.root = options.root;
    this.retentionDays = Math.max(0, options.retentionDays ?? 30);
    this.now = options.now ?? Date.now;
  }

  async init(): Promise<void> {
    await ensureDir(this.root);
    await this.cleanup();
  }

  pathFor(cloudId: string, agentId: string, threadId: string): string {
    return join(this.root, safeSegment(cloudId), safeSegment(agentId), `${safeSegment(threadId)}.json`);
  }

  async get(cloudId: string, agentId: string, threadId: string): Promise<ContextCheckpoint | null> {
    return this.exclusive(async () => {
      const path = this.pathFor(cloudId, agentId, threadId);
      const stored = await readJsonFile<ContextCheckpoint>(path);
      if (!isCheckpoint(stored)) return null;
      if (stored.expiresAt <= this.now()) {
        await rm(path, { force: true });
        return null;
      }
      return stored;
    });
  }

  async put(cloudId: string, checkpoint: ContextCheckpoint): Promise<ContextCheckpoint> {
    return this.exclusive(async () => {
      const path = this.pathFor(cloudId, checkpoint.agentId, checkpoint.threadId);
      await writeJsonAtomic(path, checkpoint);
      return checkpoint;
    });
  }

  async delete(cloudId: string, agentId: string, threadId: string): Promise<boolean> {
    return this.exclusive(async () => {
      const path = this.pathFor(cloudId, agentId, threadId);
      const exists = (await readJsonFile<ContextCheckpoint>(path)) !== null;
      await rm(path, { force: true });
      return exists;
    });
  }

  async list(cloudId?: string): Promise<StoredLocalCheckpoint[]> {
    return this.exclusive(async () => {
      const out: StoredLocalCheckpoint[] = [];
      const rootEntries = await readdir(this.root, { withFileTypes: true }).catch(() => []);
      for (const cloudEntry of rootEntries) {
        if (!cloudEntry.isDirectory()) continue;
        if (cloudId !== undefined && cloudEntry.name !== safeSegment(cloudId)) continue;
        const cloudDir = join(this.root, cloudEntry.name);
        const agentEntries = await readdir(cloudDir, { withFileTypes: true }).catch(() => []);
        for (const agentEntry of agentEntries) {
          if (!agentEntry.isDirectory()) continue;
          const agentDir = join(cloudDir, agentEntry.name);
          const files = await readdir(agentDir, { withFileTypes: true }).catch(() => []);
          for (const file of files) {
            if (!file.isFile() || !file.name.endsWith('.json')) continue;
            const checkpoint = await readJsonFile<ContextCheckpoint>(join(agentDir, file.name));
            if (!isCheckpoint(checkpoint)) continue;
            if (checkpoint.expiresAt <= this.now()) continue;
            out.push({ cloudId: cloudEntry.name, checkpoint });
          }
        }
      }
      return out;
    });
  }

  /** 清理过期文件；返回清理后仍存活的条数。 */
  async cleanup(): Promise<number> {
    return this.exclusive(async () => {
      const rootEntries = await readdir(this.root, { withFileTypes: true }).catch(() => []);
      let alive = 0;
      const cutoff = this.now() - this.retentionDays * DAY_MS;
      for (const cloudEntry of rootEntries) {
        if (!cloudEntry.isDirectory()) continue;
        const cloudDir = join(this.root, cloudEntry.name);
        const agentEntries = await readdir(cloudDir, { withFileTypes: true }).catch(() => []);
        for (const agentEntry of agentEntries) {
          if (!agentEntry.isDirectory()) continue;
          const agentDir = join(cloudDir, agentEntry.name);
          const files = await readdir(agentDir, { withFileTypes: true }).catch(() => []);
          for (const file of files) {
            if (!file.isFile() || !file.name.endsWith('.json')) continue;
            const path = join(agentDir, file.name);
            const checkpoint = await readJsonFile<ContextCheckpoint>(path);
            const expired = !isCheckpoint(checkpoint)
              || checkpoint.expiresAt <= this.now()
              || checkpoint.lease.until < cutoff;
            if (expired) await rm(path, { force: true });
            else alive += 1;
          }
        }
      }
      return alive;
    });
  }

  async count(cloudId?: string): Promise<number> {
    return (await this.list(cloudId)).length;
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation, operation);
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }
}

function isCheckpoint(value: unknown): value is ContextCheckpoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const checkpoint = value as Partial<ContextCheckpoint>;
  return checkpoint.schema === 1
    && typeof checkpoint.threadId === 'string'
    && typeof checkpoint.agentId === 'string'
    && typeof checkpoint.revision === 'number'
    && typeof checkpoint.expiresAt === 'number'
    && typeof checkpoint.state === 'object'
    && checkpoint.state !== null
    && typeof checkpoint.lease === 'object'
    && checkpoint.lease !== null
    && typeof checkpoint.lease.until === 'number';
}
