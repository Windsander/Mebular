// Memory Runtime sidecar 启动锁（`<dataDir>/start.lock`）。
//
// 契约（0.3.0 sidecar §2.2 / §3.4）：
// - 每个 `<home>` + profile 只允许一个 sidecar；
// - 锁文件 0600，内容 `{pid, port, startedAt, cloudId, profileId, command}`；
// - pid 存活 → 不启动第二个；pid 不存在/内容损坏 → 陈旧锁，原子接管；
// - 已有健康实例时由 supervisor/CLI attach，`serve` 自身以退出码 7 报 already_running。
//
// 本模块只处理文件与 pid，不 import 图/事件/同步或 MCP 内部实现。

import { randomUUID } from 'node:crypto';
import { rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ensurePrivateDir, readJsonFile, writeJsonAtomic } from './atomic-json.js';

export const START_LOCK_FILE = 'start.lock';
export const START_LOCK_STALE_MS = 30_000;

export interface StartLockRecord {
  pid: number;
  port: number | null;
  startedAt: number;
  updatedAt: number;
  cloudId: string | null;
  profileId: string | null;
  command: string;
}

export type StartLockErrorCode = 'already_running' | 'lock_conflict';

export class StartLockError extends Error {
  readonly code: StartLockErrorCode;
  readonly holder: StartLockRecord | null;
  readonly exitCode = 7;

  constructor(code: StartLockErrorCode, message: string, holder: StartLockRecord | null = null) {
    super(message);
    this.name = 'StartLockError';
    this.code = code;
    this.holder = holder;
  }
}

export interface StartLockHandle {
  path: string;
  record: StartLockRecord;
}

export function isStartLockPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isRecord(value: unknown): value is StartLockRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<StartLockRecord>;
  return typeof record.pid === 'number'
    && Number.isInteger(record.pid)
    && record.pid > 0
    && typeof record.startedAt === 'number'
    && typeof record.updatedAt === 'number'
    && typeof record.command === 'string';
}

/** 读取锁；缺失/损坏返回 null。 */
export async function readStartLock(path: string): Promise<StartLockRecord | null> {
  const value = await readJsonFile<unknown>(path);
  return isRecord(value) ? value : null;
}

/**
 * 是否陈旧：找不到有效 pid，或 pid 已不存在。
 * pid 仍存活时永不判陈旧（避免把正在启动的 sidecar 误当成残留）。
 */
export function isStartLockStale(
  lock: StartLockRecord | null,
  {
    now = Date.now(),
    pidAlive = isStartLockPidAlive,
  }: { now?: number; pidAlive?: (pid: number) => boolean } = {},
): boolean {
  if (!lock) return true;
  if (now - lock.updatedAt > START_LOCK_STALE_MS && !pidAlive(lock.pid)) return true;
  return !pidAlive(lock.pid);
}

function lockMismatch(
  lock: StartLockRecord,
  expectedCloudId: string | null | undefined,
  expectedProfileId: string | null | undefined,
): boolean {
  if (expectedCloudId && lock.cloudId && expectedCloudId !== lock.cloudId) return true;
  if (expectedProfileId && lock.profileId && expectedProfileId !== lock.profileId) return true;
  return false;
}

/** 原子把陈旧锁移走；移动失败（已被其他进程接管）交给下一轮重读。 */
async function moveAsideStaleLock(path: string): Promise<void> {
  const aside = `${path}.stale-${process.pid}-${randomUUID()}`;
  try {
    await rename(path, aside);
    await unlink(aside).catch(() => undefined);
  } catch {
    // ENOENT：其他进程已经清理；其他错误保留给下一轮重试。
  }
}

export interface AcquireStartLockOptions {
  path: string;
  pid: number;
  startedAt?: number;
  now?: number;
  cloudId?: string | null;
  profileId?: string | null;
  command?: string;
  expectedCloudId?: string | null;
  expectedProfileId?: string | null;
  pidAlive?: (pid: number) => boolean;
}

/** 获取启动锁；已被存活实例持有时抛 StartLockError（exitCode 7）。 */
export async function acquireStartLock({
  path,
  pid,
  startedAt,
  now = Date.now(),
  cloudId = null,
  profileId = null,
  command = 'serve',
  expectedCloudId = null,
  expectedProfileId = null,
  pidAlive = isStartLockPidAlive,
}: AcquireStartLockOptions): Promise<StartLockHandle> {
  const record: StartLockRecord = {
    pid,
    port: null,
    startedAt: startedAt ?? now,
    updatedAt: now,
    cloudId,
    profileId,
    command,
  };
  await ensurePrivateDir(dirname(path));

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await writeFile(path, JSON.stringify(record), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      return { path, record };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }

    const holder = await readStartLock(path);
    if (!holder || isStartLockStale(holder, { now, pidAlive })) {
      await moveAsideStaleLock(path);
      continue;
    }
    if (lockMismatch(holder, expectedCloudId, expectedProfileId)) {
      throw new StartLockError(
        'lock_conflict',
        '已有 sidecar 使用不同的 profile/忆云启动：拒绝接管',
        holder,
      );
    }
    throw new StartLockError('already_running', '已有 Memory Runtime sidecar 实例在运行', holder);
  }

  throw new StartLockError('already_running', '无法获取 Memory Runtime sidecar 启动锁', null);
}

/** 只更新仍属于当前 pid 的锁（端口、身份等启动后信息）。 */
export async function updateStartLock(
  path: string,
  {
    pid,
    now = Date.now(),
    patch,
  }: {
    pid: number;
    now?: number;
    patch: Partial<Pick<StartLockRecord, 'port' | 'cloudId' | 'profileId' | 'command'>>;
  },
): Promise<boolean> {
  const current = await readStartLock(path);
  if (!current || current.pid !== pid) return false;
  const next: StartLockRecord = {
    ...current,
    ...patch,
    updatedAt: now,
  };
  await writeJsonAtomic(path, next);
  return true;
}

/** 只在 pid 匹配时释放锁，避免误删新实例。 */
export async function releaseStartLock(path: string, { pid }: { pid: number }): Promise<boolean> {
  const current = await readStartLock(path);
  if (!current || current.pid !== pid) return false;
  try {
    await unlink(path);
    return true;
  } catch {
    return false;
  }
}

/** 清理陈旧锁（pid 不存在或损坏）；活锁不会被删除。 */
export async function clearStaleStartLock(
  path: string,
  {
    now = Date.now(),
    pidAlive = isStartLockPidAlive,
  }: { now?: number; pidAlive?: (pid: number) => boolean } = {},
): Promise<boolean> {
  const current = await readStartLock(path);
  if (!current) {
    // 损坏文件：无法判断 pid，按陈旧处理。
    try {
      await stat(path);
    } catch {
      return false;
    }
    await moveAsideStaleLock(path);
    return true;
  }
  if (!isStartLockStale(current, { now, pidAlive })) return false;
  await moveAsideStaleLock(path);
  return true;
}
