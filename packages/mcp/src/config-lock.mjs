// 跨进程配置文件写锁。
//
// 配置 writer 必须在读取 → 修改 → rename/rollback 全程持有 `<config>.write-lock`。
// 锁文件包含 pid/at/owner：owner 用于 release 只删自己的锁。
// 锁内容优先通过临时文件 + link 原子创建；不支持硬链接的文件系统回退到 open('wx')。
// 持锁进程会周期性续租 mtime；活 PID 的锁在超过 staleMs 未续租后也可被接管（防 PID 复用）。
// 无法解析的锁只有在 mtime 超过 staleMs 后才可接管；读锁/stat 的非 ENOENT 瞬态错误一律按 busy 处理。

import { randomBytes } from 'node:crypto';
import { link, open, readFile, stat, unlink, utimes, writeFile } from 'node:fs/promises';

export const CONFIG_LOCK_STALE_MS = 30_000;
const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS', 'EACCES', 'EINVAL', 'EMLINK']);

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
  linkImpl = link,
  openImpl = open,
  now = Date.now,
} = {}) {
  const lockPath = `${configFile}.write-lock`;
  const configured = Number(process.env.MEBULAR_CONFIG_LOCK_TIMEOUT_MS ?? '');
  const effectiveTimeout = Number.isFinite(timeoutMs) && timeoutMs !== null
    ? Math.max(0, timeoutMs)
    : (Number.isFinite(configured) && configured >= 0 ? configured : 5000);
  const deadline = now() + effectiveTimeout;
  const owner = randomBytes(12).toString('hex');

  const snapshot = async () => {
    let raw;
    try {
      raw = await readFile(lockPath, 'utf-8');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return { exists: false, unreadable: false, raw: null, parsed: null, mtimeMs: null };
      }
      // EACCES/EMFILE 等瞬态错误：不能当作锁不存在，更不能 unlink。
      return {
        exists: true,
        unreadable: true,
        error: error?.code ?? 'read_failed',
        raw: null,
        parsed: null,
        mtimeMs: null,
      };
    }
    let info;
    try {
      info = await stat(lockPath);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return { exists: false, unreadable: false, raw: null, parsed: null, mtimeMs: null };
      }
      return {
        exists: true,
        unreadable: true,
        error: error?.code ?? 'stat_failed',
        raw,
        parsed: null,
        mtimeMs: null,
      };
    }
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    return { exists: true, unreadable: false, raw, parsed, mtimeMs: info.mtimeMs };
  };

  const startHeartbeat = () => {
    const period = Math.max(1, Math.min(Math.max(10, Math.floor(staleMs / 3)), Math.max(1, staleMs - 1)));
    const timer = setInterval(() => {
      void (async () => {
        const current = await snapshot();
        if (current.unreadable || current.parsed?.owner !== owner) return;
        const at = new Date(now());
        await utimes(lockPath, at, at).catch(() => undefined);
      })();
    }, period);
    timer.unref?.();
    return timer;
  };

  const createOnce = async () => {
    const payload = JSON.stringify({ pid: process.pid, at: now(), owner });
    const tmp = `${lockPath}.${owner}.tmp`;
    try {
      await writeFile(tmp, payload, { mode: 0o600 });
      try {
        await linkImpl(tmp, lockPath);
      } catch (error) {
        if (LINK_UNSUPPORTED.has(error?.code)) {
          // 文件系统不支持硬链接：回退到 O_EXCL 原子创建；写入失败必须清理半截锁。
          const handle = await openImpl(lockPath, 'wx', 0o600);
          try {
            await handle.writeFile(payload, 'utf-8');
          } catch (writeError) {
            await handle.close().catch(() => undefined);
            await unlink(lockPath).catch(() => undefined);
            throw writeError;
          }
          await handle.close().catch(() => undefined);
        } else {
          throw error;
        }
      }
    } finally {
      await unlink(tmp).catch(() => undefined);
    }
  };

  for (;;) {
    try {
      await createOnce();
      const heartbeat = startHeartbeat();
      return async () => {
        clearInterval(heartbeat);
        // release 只删除自己的锁；已被 stale 接管或替换的锁不得误删。
        const current = await snapshot();
        if (!current.unreadable && current.parsed?.owner === owner) {
          await unlink(lockPath).catch(() => undefined);
        }
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;

      const held = await snapshot();
      let stale = false;
      if (held.unreadable) {
        stale = false;
      } else if (held.exists && held.parsed && Number.isInteger(held.parsed.pid)) {
        // 活 PID 也可能来自复用的旧进程：只有死 PID 或超时未续租才可接管。
        stale = !pidAlive(held.parsed.pid)
          || (typeof held.mtimeMs === 'number' && now() - held.mtimeMs > staleMs);
      } else {
        stale = !held.exists
          || (typeof held.mtimeMs === 'number' && now() - held.mtimeMs > staleMs);
      }
      if (stale) {
        // 重新读取确认仍是同一个锁，再接管，避免删除刚创建的新锁。
        const confirmed = await snapshot();
        if (!confirmed.unreadable
          && confirmed.exists === held.exists
          && confirmed.raw === held.raw
          && confirmed.mtimeMs === held.mtimeMs) {
          await unlink(lockPath).catch(() => undefined);
          continue;
        }
      }
      if (now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}
