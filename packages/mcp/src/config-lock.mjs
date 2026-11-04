// 跨进程配置文件写锁。
//
// 配置 writer 必须在读取 → 修改 → rename/rollback 全程持有 `<config>.write-lock`。
// 锁文件包含 pid/at/owner：owner 用于 release 只删自己的锁；死 PID 或超时锁可安全接管。

import { randomBytes } from 'node:crypto';
import { open, readFile, unlink } from 'node:fs/promises';

export const CONFIG_LOCK_STALE_MS = 30_000;

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export async function acquireConfigFileLock(configFile, {
  timeoutMs = null,
  staleMs = CONFIG_LOCK_STALE_MS,
} = {}) {
  const lockPath = `${configFile}.write-lock`;
  const configured = Number(process.env.MEBULAR_CONFIG_LOCK_TIMEOUT_MS ?? '');
  const effectiveTimeout = Number.isFinite(timeoutMs) && timeoutMs !== null
    ? Math.max(0, timeoutMs)
    : (Number.isFinite(configured) && configured >= 0 ? configured : 5000);
  const deadline = Date.now() + effectiveTimeout;
  const owner = randomBytes(12).toString('hex');
  const readLock = async () => {
    try {
      return JSON.parse(await readFile(lockPath, 'utf-8'));
    } catch {
      return null;
    }
  };

  for (;;) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({
        pid: process.pid,
        at: Date.now(),
        owner,
      }), 'utf-8').catch(() => undefined);
      return async () => {
        await handle.close().catch(() => undefined);
        // release 只删除自己的锁；已被 stale 接管或替换的锁不得误删。
        const current = await readLock();
        if (current?.owner === owner) await unlink(lockPath).catch(() => undefined);
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const held = await readLock();
      const now = Date.now();
      const stale = !held
        || !Number.isInteger(held.pid)
        || !pidAlive(held.pid)
        || typeof held.at !== 'number'
        || now - held.at > staleMs;
      if (stale) {
        // 重新读取确认仍是同一个陈旧锁，再接管，避免删除刚创建的新锁。
        const confirmed = await readLock();
        if (confirmed
          && confirmed.pid === held?.pid
          && confirmed.at === held?.at
          && confirmed.owner === held?.owner) {
          await unlink(lockPath).catch(() => undefined);
          continue;
        }
      }
      if (Date.now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}
