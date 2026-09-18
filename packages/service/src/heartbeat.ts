// 进程心跳（D4）：常驻组件周期性写 `<configDir>/service.heartbeat`，供 `service status` 与 doctor 判定
// 「是否在跑且新鲜」。原子写、0600（权限语义同现约定；Windows 走 ACL，由 doctor 说明差异）。

import fs from 'node:fs';
import path from 'node:path';

export interface Heartbeat {
  pid: number;
  /** epoch ms */
  ts: number;
  role: string;
  sha: string;
}

export const HEARTBEAT_FILE = 'service.heartbeat';
export const HEARTBEAT_DEFAULT_MAX_AGE_MS = 15_000;

export const heartbeatPath = (dir: string): string => path.join(dir, HEARTBEAT_FILE);

export function writeHeartbeat(
  dir: string,
  input: { role: string; sha: string; pid?: number; now?: number },
): Heartbeat {
  const record: Heartbeat = {
    pid: input.pid ?? process.pid,
    ts: input.now ?? Date.now(),
    role: input.role,
    sha: input.sha,
  };
  fs.mkdirSync(dir, { recursive: true });
  const target = heartbeatPath(dir);
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    // Windows 无 POSIX mode；由 ACL 兜底。
  }
  fs.renameSync(tmp, target);
  return record;
}

export function readHeartbeat(dir: string): Heartbeat | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(heartbeatPath(dir), 'utf-8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const rec = parsed as Record<string, unknown>;
    if (typeof rec.pid !== 'number' || typeof rec.ts !== 'number') return null;
    return { pid: rec.pid, ts: rec.ts, role: String(rec.role ?? ''), sha: String(rec.sha ?? '') };
  } catch {
    return null;
  }
}

export function heartbeatAgeMs(dir: string, now: number = Date.now()): number | null {
  const hb = readHeartbeat(dir);
  return hb === null ? null : Math.max(0, now - hb.ts);
}

export function isHeartbeatFresh(
  dir: string,
  maxAgeMs: number = HEARTBEAT_DEFAULT_MAX_AGE_MS,
  now: number = Date.now(),
): boolean {
  const age = heartbeatAgeMs(dir, now);
  return age !== null && age <= maxAgeMs;
}

/**
 * 常驻进程心跳：立即写一次，之后每 `intervalMs` 刷新；返回停止函数（只停刷新，不删文件——
 * 进程死亡后文件停留在最后 ts，`status`/doctor 据此报告「陈旧」）。
 */
export function startHeartbeat(
  dir: string,
  input: { role: string; sha: string; intervalMs?: number; pid?: number },
): () => void {
  const intervalMs = input.intervalMs ?? 5_000;
  const beat = (): void => {
    try {
      writeHeartbeat(dir, { role: input.role, sha: input.sha, ...(input.pid !== undefined ? { pid: input.pid } : {}) });
    } catch {
      // 心跳失败不应让服务崩溃。
    }
  };
  beat();
  const timer = setInterval(beat, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
