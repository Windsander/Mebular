// G：保存即生效（自动重启 + 生效校验 + 回滚兜底）
//
// 产品语义（用户拍板）：保存成功的定义 = **「已生效」或「已回滚 + 明确报错」**，
// 不再存在「已配但未启动」的中间态。
//
// 流程：
//   1) 控制台保存（POST /admin/api/config）命中 `requiresRestart:true` 项
//      → 写 <home>/config.json（.bak 备份）→ 写 pending 记录 → 分离启动本模块的 supervisor → 触发重启
//   2) 新实例启动成功后（server.mjs）读取 pending → 用自身运行时计算 effective → 写 result(status='applied', verify[])
//   3) supervisor 等待新实例健康：健康 = 结束；**不健康 = 还原 .bak + 再重启 + 写 result(status='rolled-back', reason)**
//
// 全部外部交互（健康探针 / 重启通道 / 时钟）可注入，便于 hermetic 测试；零 core 依赖。

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG_SCHEMA_BY_PATH } from './config-schema.mjs';

export const APPLY_RESULT_FILE = 'config-apply.result.json';
export const APPLY_PENDING_FILE = 'config-apply.pending.json';
export const JOIN_ERROR_FILE = 'join.error.json';

/** 命中即「可能把控制台自己锁在门外」的路径：保存前必须二次确认。 */
export const SELF_LOCK_PATHS = ['mcp.http.auth', 'mcp.http.host', 'mcp.http.tls'];

/** 自动重启的防抖窗口（同进程内多次保存合并为一次重启）。 */
export const RESTART_DEBOUNCE_MS = 800;
/** supervisor 等待新实例健康的上限。 */
export const APPLY_HEALTH_TIMEOUT_MS = 60_000;

export const SERVE_READY_FILE = 'serve-ready.json';

export const applyResultPath = (home) => join(home, APPLY_RESULT_FILE);
export const serveReadyPath = (home) => join(home, SERVE_READY_FILE);

/** 新实例「已监听 HTTP」标记（在 listen 成功后写；比心跳更精确——心跳在进程启动早期就写）。 */
export const writeServeReady = (home, { pid = process.pid, now = Date.now() } = {}) =>
  writeJsonAtomic(serveReadyPath(home), { pid, ts: now });
export const applyPendingPath = (home) => join(home, APPLY_PENDING_FILE);
export const joinErrorPath = (home) => join(home, JOIN_ERROR_FILE);

async function readJson(path) {
  try {
    const value = JSON.parse(await readFile(path, 'utf-8'));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

async function writeJsonAtomic(path, value) {
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf-8');
  await rename(tmp, path);
}

export const readApplyResult = (home) => readJson(applyResultPath(home));
export const readApplyPending = (home) => readJson(applyPendingPath(home));
export const writeApplyResult = (home, record) => writeJsonAtomic(applyResultPath(home), record);
export const writeApplyPending = (home, record) => writeJsonAtomic(applyPendingPath(home), record);
export const clearApplyPending = (home) => rm(applyPendingPath(home), { force: true }).catch(() => undefined);

/**
 * 本部署声明「可热生效」的配置路径（`MEBULAR_CONFIG_HOT_PATHS=a,b`）：
 * 适用于运营方自带 reload 机制的部署——保存这些路径不触发重启，也不进待重启横幅。
 * 默认空（守护只在启动时读一次 config.json）。
 */
export function hotPaths(env = process.env) {
  return String(env.MEBULAR_CONFIG_HOT_PATHS ?? '').split(',').map((x) => x.trim()).filter((x) => x.length > 0);
}

/** 本次改动的 path 里：哪些需重启、哪些即时生效、哪些是自锁项（hot 路径视为即时）。 */
export function classifyChanges(paths, hot = []) {
  const hotSet = new Set(hot);
  const restart = paths.filter((p) => !hotSet.has(p) && CONFIG_SCHEMA_BY_PATH.get(p)?.requiresRestart === true);
  const immediate = paths.filter((p) => hotSet.has(p) || CONFIG_SCHEMA_BY_PATH.get(p)?.requiresRestart !== true);
  const selfLock = paths.filter((p) => SELF_LOCK_PATHS.includes(p) && !hotSet.has(p));
  return { restart, immediate, selfLock };
}

// ---------------------------------------------------------------- 健康探针

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readServeReady(home) {
  const record = await readJson(serveReadyPath(home));
  return record && typeof record.ts === 'number' && typeof record.pid === 'number' ? record : null;
}

async function tcpOpen(port, host = '127.0.0.1', timeoutMs = 500) {
  const net = await import('node:net');
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/**
 * 新实例是否已起来：
 *   1) `<home>/serve-ready.json` 由新实例在 **HTTP 监听成功后** 写入（pid != oldPid 且 ts >= 本次尝试）
 *   2) 已知端口时 TCP 可连（兜底）
 * 不用 service.heartbeat：它在进程启动早期就写，无法区分「起来了」与「listen 前崩了」。
 */
export async function probeHealthy({ home, port, oldPid, since }) {
  // serve-ready 是**必要条件**（新实例在 join 装配完成后才写；半启动/启动失败一律不算健康）
  const ready = await readServeReady(home);
  if (!(ready && ready.pid !== oldPid && ready.ts >= since - 5_000)) return false;
  if (typeof port === 'number' && port > 0 && Number.isFinite(port)) return tcpOpen(port);
  return true;
}

/** 轮询直到健康或超时；返回 {healthy, waitedMs}。 */
export async function waitHealthy({ home, port, oldPid, since, timeoutMs = APPLY_HEALTH_TIMEOUT_MS, pollMs = 600, now = Date.now, probe = probeHealthy }) {
  const deadline = since + timeoutMs;
  for (;;) {
    if (await probe({ home, port, oldPid, since, now: now() })) return { healthy: true, waitedMs: now() - since };
    if (now() >= deadline) return { healthy: false, waitedMs: now() - since };
    await sleep(pollMs);
  }
}

// ---------------------------------------------------------------- 重启通道

/**
 * 执行重启命令。生产：@mebular/service 的平台计划（launchd/systemd/计划任务）。
 * 测试钩子：`MEBULAR_RESTART_CMD`（shell 命令；verify:config 用它把子进程杀掉再拉起）。
 * 返回 {executed, commands, mode}。
 */
export async function runRestart({ home, kind, spawnImpl = spawn, env = process.env }) {
  if (typeof env.MEBULAR_RESTART_CMD === 'string' && env.MEBULAR_RESTART_CMD.trim().length > 0) {
    const child = spawnImpl(env.MEBULAR_RESTART_CMD, { shell: true, env, detached: true, stdio: 'ignore' });
    child.unref?.();
    return { executed: true, mode: 'cmd', commands: [env.MEBULAR_RESTART_CMD] };
  }
  if (!kind) return { executed: false, mode: 'foreground', commands: [] };
  const mod = await import('@mebular/service');
  const plan = mod.restartPlanFor({ kind, args: [], heartbeatDir: home, env: { MEBULAR_HOME: home } }, { home });
  if (!plan.registered) return { executed: false, mode: 'foreground', commands: [] };
  for (const [cmd, ...args] of plan.commands) {
    const child = spawnImpl(cmd, args, { detached: true, stdio: 'ignore', env });
    child.unref?.();
  }
  return { executed: true, mode: 'service', commands: plan.commands };
}

/** 分离启动 supervisor（先于重启触发；须能在守护被杀后存活）。 */
export function spawnSupervisor({ supervisorPath, args, env = process.env, spawnImpl = spawn, execPath = process.execPath }) {
  const child = spawnImpl(execPath, [supervisorPath, ...args], { detached: true, stdio: 'ignore', env });
  child.unref?.();
  return child;
}

// ---------------------------------------------------------------- supervisor 主逻辑

/** 读启动失败根因（server.mjs 在 joinService 起不来时落盘）。 */
export const readJoinError = (home) => readJson(joinErrorPath(home));

/** 还原备份（config.json ← config.json.bak）。返回是否真的还原了。 */
export async function restoreBackup({ configFile, backupFile = `${configFile}.bak`, copyFileImpl = copyFile }) {
  if (!existsSync(backupFile)) return false;
  await copyFileImpl(backupFile, configFile);
  return true;
}

/**
 * supervisor：等新实例健康；不健康 → 还原 .bak + 再重启 + 记录。
 * 可注入 health/restart/now 以便测试。
 */
export async function runApplySupervisor({
  home,
  configFile,
  backupFile = configFile ? `${configFile}.bak` : null,
  oldPid,
  port,
  fields = [],
  since = Date.now(),
  timeoutMs = APPLY_HEALTH_TIMEOUT_MS,
  health = waitHealthy,
  restart = runRestart,
  kind = process.env.MEBULAR_SERVICE_KIND,
  log = () => {},
  verify,
} = {}) {
  const now = () => Date.now();
  const pending = (await readApplyPending(home)) ?? { fields, at: new Date(since).toISOString(), attempts: 1 };
  const attempts = Number(pending.attempts ?? 1);
  log(`apply: 等待新实例健康（fields=${fields.join(',')} timeout=${timeoutMs}ms）`);
  const outcome = await health({ home, port, oldPid, since, timeoutMs, now });
  if (outcome.healthy) {
    log('apply: 新实例健康');
    // 新实例（server.mjs）通常已写 applied+verify；若尚未写（竞态）则在此补一条
    const existing = await readApplyResult(home);
    if (!existing || existing.attempt !== pending.attempt) {
      const record = {
        status: 'applied',
        attempt: pending.attempt ?? null,
        at: new Date(now()).toISOString(),
        fields,
        waitedMs: outcome.waitedMs,
        ...(typeof verify === 'function' ? { verify: await verify() } : {}),
      };
      await writeApplyResult(home, record);
    }
    await clearApplyPending(home);
    return { status: 'applied', waitedMs: outcome.waitedMs, fields };
  }

  // 失败：回滚兜底
  const joinError = await readJoinError(home);
  const reason = joinError?.message
    ? String(joinError.message)
    : `新实例在 ${timeoutMs}ms 内未健康（心跳/端口无响应）`;
  log(`apply: 新实例未健康（${reason}）→ 回滚`);
  // 打标记：回滚实例启动时不得写 applied（否则会短暂谎报「已生效」）
  await writeApplyPending(home, { ...pending, rollingBack: true, reason }).catch(() => undefined);
  const restored = backupFile ? await restoreBackup({ configFile, backupFile }) : false;
  if (restored) {
    await restart({ home, kind, env: process.env });
    const after = await health({ home, port, oldPid, since: now(), timeoutMs, now });
    const record = {
      status: after.healthy ? 'rolled-back' : 'rollback-failed',
      attempt: pending.attempt ?? null,
      at: new Date(now()).toISOString(),
      fields,
      reason,
      restored,
      backup: backupFile,
      rolledBackHealthy: after.healthy,
      retries: attempts,
    };
    await writeApplyResult(home, record);
    await clearApplyPending(home);
    return record;
  }
  const record = {
    status: 'failed',
    attempt: pending.attempt ?? null,
    at: new Date(now()).toISOString(),
    fields,
    reason,
    restored: false,
  };
  await writeApplyResult(home, record);
  await clearApplyPending(home);
  return record;
}
