// 跨进程配置文件写锁。
//
// 配置 writer 必须在读取 → 修改 → rename/rollback 全程持有 `<config>.write-lock`。
// 锁文件包含 pid/at/owner：owner 用于 release 只删自己的锁。
// 锁内容通过临时文件 + link 原子创建，避免空/半截 JSON。
// 活 PID 的锁永不过期（等价于“持有者必须显式 release”）；只有死 PID，
// 或无法解析且文件已超过 staleMs，才允许接管。

import { randomBytes } from 'node:crypto';
import { link, readFile, stat, unlink, writeFile } from 'node:fs/promises';

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

  const snapshot = async () => {
    let raw = null;
    let mtimeMs = null;
    try {
      const [text, info] = await Promise.all([readFile(lockPath, 'utf-8'), stat(lockPath)]);
      raw = text;
      mtimeMs = info.mtimeMs;
    } catch {
      return { exists: false, raw: null, parsed: null, mtimeMs: null };
    }
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    return { exists: true, raw, parsed, mtimeMs };
  };

  for (;;) {
    const tmp = `${lockPath}.${owner}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify({
        pid: process.pid,
        at: Date.now(),
        owner,
      }), { mode: 0o600 });
      try {
        await link(tmp, lockPath);
      } finally {
        await unlink(tmp).catch(() => undefined);
      }
      return async () => {
        // release 只删除自己的锁；已被 stale 接管或替换的锁不得误删。
        const current = await snapshot();
        if (current.parsed?.owner === owner) await unlink(lockPath).catch(() => undefined);
      };
    } catch (error) {
      await unlink(tmp).catch(() => undefined);
      if (error?.code !== 'EEXIST') throw error;

      const held = await snapshot();
      const now = Date.now();
      let stale = false;
      if (held.exists && held.parsed && Number.isInteger(held.parsed.pid)) {
        // 活 PID 永不过期；只有持有进程已退出才可接管。
        stale = !pidAlive(held.parsed.pid);
      } else {
        // 空/半截/损坏锁：无法证明持有者存活，只有超过 staleMs 才接管。
        stale = !held.exists
          || (typeof held.mtimeMs === 'number' && now - held.mtimeMs > staleMs);
      }
      if (stale) {
        // 重新读取确认仍是同一个锁，再接管，避免删除刚创建的新锁。
        const confirmed = await snapshot();
        if (confirmed.exists === held.exists
          && confirmed.raw === held.raw
          && confirmed.mtimeMs === held.mtimeMs) {
          await unlink(lockPath).catch(() => undefined);
          continue;
        }
      }
      if (Date.now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}
