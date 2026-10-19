// E2-B · App 壳忆云编排（**不 import electron**，可被 node/jest 直接加载与单测）
//
// 只做进程/服务生命周期 + 状态机接线：档案注册表/切换引擎复用 packages/mcp/src（E2-A1），
// App 不复制业务逻辑。红线：
//   - 切换不复制、不合并、不删除任何忆云目录；只停旧守护/起新守护/改 current。
//   - 端口 200 必须核对 /healthz instance（homeKey）；不匹配 = 另一张忆云，不得 reused/继续。
//   - 失败回滚旧守护；崩溃由 switch.intent.json 恢复；两者都不健康只诊断，不删档案/intent。

import { readFileSync, existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  homeKey,
  probeHealthDetail,
  resolveHttp,
  waitForDaemonDetail,
} from './daemon.mjs';

export const CLOUD_ROOT_ENV = 'MEBULAR_CLOUD_ROOT';
export const CLOUD_PREFS_FILE = 'clouds.desktop.json';
export const CLOUD_SERVICE_KIND = 'mebular-serve';
const PROFILE_ID_RE = /^[a-z0-9_]+$/;

export function cloudError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

export const defaultPidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const defaultKillPid = (pid, signal = 'SIGTERM') => {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
};

/** 防误杀：lock PID 至少要是 node/mebular/Electron 且不是明显无关进程（ps 不可用则信任 lock）。 */
export async function defaultLooksLikeMebularServe(pid) {
  if (process.platform === 'win32') return true;
  try {
    const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf-8' }).trim();
    return command.length === 0 || /mebular|serve|electron|node/i.test(command);
  } catch {
    return true;
  }
}

/** 从 CLI 入口解析同仓库的 E2-A1 模块（开发态/打包 extraResources 同构）。 */
export async function loadCloudModules(cliBin) {
  const src = join(cliBin, '..', '..', 'src');
  return {
    profiles: await import(pathToFileURL(join(src, 'profiles.mjs')).href),
    switch: await import(pathToFileURL(join(src, 'cloud-switch.mjs')).href),
  };
}

/** 某个 home 的 HTTP 监听配置（每次现读 config.json；运行时 home 切换后自然生效）。 */
export function httpForHome(home, env = process.env) {
  let config = {};
  try {
    config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf-8'));
  } catch {
    config = {};
  }
  return resolveHttp(config, env);
}

export function readHomeLock(home) {
  try {
    return JSON.parse(readFileSync(join(home, 'lock'), 'utf-8'));
  } catch {
    return null;
  }
}

export function readActiveLock(root) {
  try {
    return JSON.parse(readFileSync(join(root, 'active.lock'), 'utf-8'));
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

/**
 * 等待旧守护停止：/healthz 不通且 home lock 的 PID 已退出。
 * 只看进程/端口，不看陈旧 heartbeat（陈旧心跳不算故障）。
 */
export async function waitForCloudStopped({
  home,
  http,
  fetchImpl = fetch,
  pid = null,
  pidAlive = defaultPidAlive,
  timeoutMs = 10_000,
  intervalMs = 200,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const health = await probeHealthDetail(fetchImpl, http, { timeoutMs: 800 });
    const lock = readHomeLock(home);
    const lockAlive = (Number.isInteger(pid) && pidAlive(pid))
      || (Boolean(lock?.pid) && pidAlive(lock.pid));
    if (!health.ok && !lockAlive) return true;
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

/** 等待目标守护健康且实例身份匹配。 */
export async function waitForCloudDaemon({
  http,
  fetchImpl = fetch,
  expectedInstance,
  cloudId = null,
  timeoutMs = 20_000,
  intervalMs = 500,
} = {}) {
  const attempts = Math.max(1, Math.ceil(timeoutMs / Math.max(1, intervalMs)));
  return waitForDaemonDetail({
    fetchImpl,
    http,
    attempts,
    intervalMs,
    expectedInstance,
    cloudId,
  });
}

function safeStatus(service, descriptor, serviceHome) {
  if (typeof service?.serviceStatus !== 'function') return null;
  try {
    return service.serviceStatus(descriptor, { home: serviceHome });
  } catch (error) {
    return { registered: false, running: false, autostart: null, error: String(error?.message ?? error) };
  }
}

/**
 * 旧单 home 服务单元 → 新 serviceHome（OS home）归属；保留旧 manifest 的 autostart。
 * 顺序：先确认 legacy 已登记 → 新布局未登记则按 legacy autostart 安装 → 最后清理 legacy 文件。
 * 安装失败时保留 legacy 原样（不回滚删除）。
 */
export async function migrateLegacyService({
  service,
  descriptor,
  home,
  serviceHome = homedir(),
  http = null,
  fetchImpl = fetch,
  pidAlive = defaultPidAlive,
  stopTimeoutMs = 10_000,
} = {}) {
  if (typeof service?.serviceStatus !== 'function' || typeof service?.installService !== 'function') {
    return { migrated: false, available: false, reason: 'service_unavailable' };
  }
  if (resolve(home) === resolve(serviceHome)) {
    return { migrated: false, available: true, reason: 'same_service_home' };
  }
  const statusNew = safeStatus(service, descriptor, serviceHome);
  const statusLegacy = safeStatus(service, descriptor, home);
  if (!statusLegacy?.registered) {
    return {
      migrated: false,
      available: true,
      registered: Boolean(statusNew?.registered),
      running: Boolean(statusNew?.running),
      autostart: statusNew?.autostart ?? null,
    };
  }
  const autostart = statusLegacy.autostart ?? statusNew?.autostart ?? true;
  let installed = false;
  if (!statusNew?.registered) {
    // 先停旧单元并等 lock 释放，再装新单元：避免新进程撞上旧 active.lock（双活窗口）。
    if (typeof service.uninstallService === 'function') {
      service.uninstallService(descriptor, { home });
    }
    if (http && await waitForCloudStopped({ home, http, fetchImpl, pidAlive, timeoutMs: stopTimeoutMs }) === false) {
      throw cloudError('SERVICE_MIGRATION_FAILED', '旧守护服务未能停止（lock/端口仍被占用）：请检查诊断');
    }
    const result = service.installService(descriptor, { home: serviceHome, autostart });
    if (!result?.ok) {
      throw cloudError(
        'SERVICE_MIGRATION_FAILED',
        `旧守护服务迁移失败：${result?.error ?? result?.message ?? 'installService 未成功'}`,
        { result },
      );
    }
    installed = true;
  }
  // 只删 legacy 单元/manifest 文件；不 bootout（若新服务同 label 已运行，bootout 会误杀）。
  const legacyUnit = statusLegacy.unitPath ?? null;
  let legacyManifest = null;
  try {
    legacyManifest = typeof service.manifestPath === 'function'
      ? service.manifestPath(descriptor.kind, home)
      : join(home, '.mebular', 'services', `${descriptor.kind}.json`);
  } catch {
    legacyManifest = null;
  }
  for (const file of [legacyUnit, legacyManifest]) {
    if (typeof file === 'string' && file.length > 0) {
      await rm(file, { force: true }).catch(() => undefined);
    }
  }
  return {
    migrated: true,
    available: true,
    installed,
    registered: true,
    running: Boolean(statusNew?.running || installed),
    autostart,
  };
}

export async function readCloudPrefs(root) {
  try {
    const parsed = JSON.parse(await readFile(join(root, CLOUD_PREFS_FILE), 'utf-8'));
    return parsed && typeof parsed === 'object' && parsed.profiles && typeof parsed.profiles === 'object'
      ? parsed
      : { v: 1, profiles: {} };
  } catch {
    return { v: 1, profiles: {} };
  }
}

export async function writeCloudPreference(root, id, patch) {
  if (!PROFILE_ID_RE.test(String(id ?? ''))) return null;
  const current = await readCloudPrefs(root);
  const next = {
    v: 1,
    profiles: {
      ...current.profiles,
      [id]: { ...(current.profiles[id] ?? {}), ...(patch ?? {}) },
    },
  };
  await mkdir(root, { recursive: true });
  const path = join(root, CLOUD_PREFS_FILE);
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600).catch(() => undefined);
  await rename(tmp, path);
  await chmod(path, 0o600).catch(() => undefined);
  return next.profiles[id];
}

/** 停旧：managed child / 服务单元 / 外部 lock PID；随后等到端口与 lock 都释放。 */
export async function stopCloudDaemon({
  home,
  http,
  service,
  descriptor,
  serviceHome = homedir(),
  managedChild = null,
  oldPid = null,
  fetchImpl = fetch,
  pidAlive = defaultPidAlive,
  killPid = defaultKillPid,
  looksLikeMebular = defaultLooksLikeMebularServe,
  stopTimeoutMs = 10_000,
  intervalMs = 200,
} = {}) {
  let childStopped = false;
  if (managedChild && typeof managedChild.kill === 'function') {
    try {
      managedChild.kill('SIGTERM');
      childStopped = true;
    } catch {
      childStopped = false;
    }
  }

  let serviceStopped = false;
  const statusNew = safeStatus(service, descriptor, serviceHome);
  if (statusNew?.registered && typeof service?.uninstallService === 'function') {
    const result = service.uninstallService(descriptor, { home: serviceHome });
    serviceStopped = Boolean(result?.ok);
  }
  if (resolve(home) !== resolve(serviceHome)) {
    const statusLegacy = safeStatus(service, descriptor, home);
    if (statusLegacy?.registered && typeof service?.uninstallService === 'function') {
      service.uninstallService(descriptor, { home });
      serviceStopped = true;
    }
  }

  const lock = readHomeLock(home);
  const lockPid = Number.isInteger(oldPid) && pidAlive(oldPid) ? oldPid : (lock?.pid ?? null);
  let killedPid = null;
  if (!serviceStopped && !childStopped && Number.isInteger(lockPid) && pidAlive(lockPid)) {
    if (!(await looksLikeMebular(lockPid))) {
      throw cloudError('CLOUD_STOP_REFUSED', `旧守护 PID ${lockPid} 不是 Mebular 进程：拒绝盲目停止`);
    }
    killPid(lockPid, 'SIGTERM');
    killedPid = lockPid;
  }

  const stopped = await waitForCloudStopped({
    home,
    http,
    fetchImpl,
    pid: lockPid,
    pidAlive,
    timeoutMs: stopTimeoutMs,
    intervalMs,
  });
  if (!stopped) {
    if (killedPid !== null && pidAlive(killedPid)) killPid(killedPid, 'SIGKILL');
    const afterKill = await waitForCloudStopped({
      home,
      http,
      fetchImpl,
      pid: killedPid,
      pidAlive,
      timeoutMs: 3_000,
      intervalMs,
    });
    if (!afterKill) {
      throw cloudError('CLOUD_STOP_FAILED', '旧忆云未能停止（端口/锁仍被占用）：请检查诊断');
    }
  }
  return { stopped: true, childStopped, serviceStopped, killedPid };
}

/** 起新：服务托管（保留 autostart）或子进程；healthz 校验由调用方完成。 */
export async function startCloudDaemon({
  root,
  home,
  http,
  cliBin,
  service,
  descriptor,
  serviceHome = homedir(),
  mode = 'child',
  autostart = true,
  spawnFn,
  env = process.env,
} = {}) {
  if (mode === 'service') {
    if (typeof service?.installService !== 'function') {
      throw cloudError('SERVICE_UNAVAILABLE', '服务托管不可用：无法安装忆云守护服务');
    }
    const result = service.installService(descriptor, { home: serviceHome, autostart });
    if (!result?.ok) {
      throw cloudError(
        'SERVICE_START_FAILED',
        `服务安装失败：${result?.error ?? result?.message ?? result?.warning ?? '未知原因'}`,
        { result },
      );
    }
    return { mode: 'service', child: null, result };
  }
  if (typeof spawnFn !== 'function') throw cloudError('SPAWN_UNAVAILABLE', '缺少子进程启动器');
  const listenArgs = Number.isInteger(http?.port) && http.port > 0 ? ['--port', String(http.port)] : [];
  const child = spawnFn(process.execPath, [cliBin, 'serve', ...listenArgs], {
    env: {
      ...env,
      MEBULAR_HOME: home,
      MEBULAR_CLOUD_ROOT: root,
      ELECTRON_RUN_AS_NODE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { mode: 'child', child, result: null };
}

function statusForHome(service, descriptor, serviceHome) {
  return safeStatus(service, descriptor, serviceHome);
}

/** 清掉目标忆云可能残留的服务单元（上次失败切换），避免与 child 抢端口/单活。 */
async function stopTargetLeftovers({ service, descriptor, serviceHome, targetHome }) {
  for (const at of [serviceHome, targetHome]) {
    if (typeof at !== 'string' || at.length === 0) continue;
    const status = statusForHome(service, descriptor, at);
    if (status?.registered && typeof service?.uninstallService === 'function') {
      service.uninstallService(descriptor, { home: at });
    }
  }
}

async function stopLockedPid({
  home,
  http,
  fetchImpl,
  pidAlive,
  killPid,
  looksLikeMebular,
  timeoutMs = 5_000,
}) {
  const lock = readHomeLock(home);
  const pid = Number.isInteger(lock?.pid) && pidAlive(lock.pid) ? lock.pid : null;
  if (pid === null) return false;
  if (!(await looksLikeMebular(pid))) return false;
  killPid(pid, 'SIGTERM');
  if (await waitForCloudStopped({ home, http, fetchImpl, pid, pidAlive, timeoutMs })) return true;
  if (pidAlive(pid)) killPid(pid, 'SIGKILL');
  return waitForCloudStopped({ home, http, fetchImpl, pid, pidAlive, timeoutMs: 3_000 });
}

function mismatchMessage(port) {
  return `端口 ${port} 上是另一张忆云，请先停止它`;
}

/**
 * 切换忆云（App 版 supervisor）：
 *   停旧 → 等旧 lock 消失 → 写 current → 起新 → healthz(instance) 校验 → 失败回滚旧。
 * 返回 { ok, changed, current, previous, profile, home, mode, child, autostart }。
 */
export async function performCloudSwitch({
  root,
  id,
  home,
  cliBin,
  service = {},
  serviceHome = homedir(),
  modules,
  fetchImpl = fetch,
  spawnFn,
  env = process.env,
  managedChild = null,
  pidAlive = defaultPidAlive,
  killPid = defaultKillPid,
  looksLikeMebular = defaultLooksLikeMebularServe,
  probePort = null,
  verifyTimeoutMs = 20_000,
  verifyIntervalMs = 500,
  stopTimeoutMs = 10_000,
} = {}) {
  if (!modules?.profiles || !modules?.switch) throw cloudError('CLOUD_UNAVAILABLE', '忆云模块不可用');
  if (!PROFILE_ID_RE.test(String(id ?? ''))) throw cloudError('PROFILE_NOT_FOUND', `未找到忆云：${id}`);
  const state = await modules.profiles.readRegistry(root);
  const target = state.registry.profiles.find((profile) => profile.id === id) ?? null;
  if (!target) throw cloudError('PROFILE_NOT_FOUND', `未找到忆云：${id}`);
  const previous = state.registry.profiles.find((profile) => profile.id === state.registry.current) ?? null;
  if (state.registry.current === id) {
    return {
      ok: true,
      changed: false,
      current: id,
      previous: null,
      profile: target,
      home,
      mode: null,
      child: null,
    };
  }
  const targetHome = modules.profiles.profileHomeForEntry(root, target);
  if (!existsSync(targetHome)) {
    throw cloudError('PROFILE_HOME_MISSING', `忆云「${target.name}」的目录不存在：${targetHome}`);
  }
  const previousHome = previous ? modules.profiles.profileHomeForEntry(root, previous) : null;
  const oldHttp = httpForHome(home, env);
  const targetHttp = httpForHome(targetHome, env);

  // CL-02：root 单活锁。旧忆云的自己的 lock 允许（马上会停），其它 home 一律拒绝。
  const active = readActiveLock(root);
  if (active && pidAlive(active.pid)) {
    const activeHome = typeof active.home === 'string' ? resolve(active.home) : null;
    if (activeHome !== null && activeHome !== resolve(home)) {
      throw cloudError(
        'CLOUD_ALREADY_ACTIVE',
        activeHome === resolve(targetHome)
          ? `目标忆云「${target.name}」已在运行；请先停止它`
          : `已有另一张忆云守护在运行（pid ${active.pid}，home=${active.home}）；请先停止它`,
        { held: active },
      );
    }
  }

  // CL-05：端口 200 但不是目标 instance = 另一张忆云，不能 reused，也不能继续切换。
  const oldHealth = await probeHealthDetail(fetchImpl, oldHttp, {
    expectedInstance: homeKey(home),
    cloudId: previous?.id ?? null,
  });
  if (oldHealth.reason === 'instance_mismatch') {
    throw cloudError('CLOUD_INSTANCE_MISMATCH', mismatchMessage(oldHttp.port), { instance: oldHealth.instance });
  }
  if (oldHealth.reason === 'instance_missing') {
    throw cloudError(
      'CLOUD_INSTANCE_MISSING',
      `端口 ${oldHttp.port} 上的守护没有 /healthz instance 身份，无法确认是当前忆云`,
    );
  }
  const targetHealth = await probeHealthDetail(fetchImpl, targetHttp, {
    expectedInstance: homeKey(targetHome),
    cloudId: target.id,
  });
  if (targetHealth.reason === 'instance_mismatch') {
    throw cloudError('CLOUD_INSTANCE_MISMATCH', mismatchMessage(targetHttp.port), { instance: targetHealth.instance });
  }
  if (targetHealth.reason === 'instance_missing') {
    throw cloudError(
      'CLOUD_INSTANCE_MISSING',
      `端口 ${targetHttp.port} 上的守护没有 /healthz instance 身份，无法确认是目标忆云`,
    );
  }
  if (targetHealth.ok) {
    throw cloudError('CLOUD_ALREADY_ACTIVE', `忆云「${target.name}」已在运行；请先停止它`);
  }
  if (typeof probePort === 'function' && await probePort(targetHttp)) {
    throw cloudError(
      'CLOUD_PORT_BUSY',
      `端口 ${targetHttp.port} 已被占用但不是 Mebular 守护：请先停止占用该端口的程序`,
    );
  }

  const oldLock = readHomeLock(home);
  const oldLockPid = Number.isInteger(oldLock?.pid) && pidAlive(oldLock.pid) ? oldLock.pid : null;
  const descriptor = {
    kind: CLOUD_SERVICE_KIND,
    args: [cliBin, 'serve', ...(Number.isInteger(oldHttp.port) && oldHttp.port > 0 ? ['--port', String(oldHttp.port)] : [])],
    heartbeatDir: home,
    workingDir: home,
    execPath: process.execPath,
    env: {
      MEBULAR_HOME: home,
      MEBULAR_CLOUD_ROOT: root,
      ELECTRON_RUN_AS_NODE: '1',
    },
  };
  const previousDescriptor = previousHome ? {
    ...descriptor,
    args: [cliBin, 'serve', ...(Number.isInteger(httpForHome(previousHome, env).port) && httpForHome(previousHome, env).port > 0
      ? ['--port', String(httpForHome(previousHome, env).port)]
      : [])],
    heartbeatDir: previousHome,
    workingDir: previousHome,
    env: { MEBULAR_HOME: previousHome, MEBULAR_CLOUD_ROOT: root, ELECTRON_RUN_AS_NODE: '1' },
  } : null;
  const targetDescriptor = {
    kind: CLOUD_SERVICE_KIND,
    args: [cliBin, 'serve', ...(Number.isInteger(targetHttp.port) && targetHttp.port > 0 ? ['--port', String(targetHttp.port)] : [])],
    heartbeatDir: targetHome,
    workingDir: targetHome,
    execPath: process.execPath,
    env: { MEBULAR_HOME: targetHome, MEBULAR_CLOUD_ROOT: root, ELECTRON_RUN_AS_NODE: '1' },
  };

  // 目标残留单元先清掉（不涉及当前忆云）。
  await stopTargetLeftovers({ service, descriptor: targetDescriptor, serviceHome, targetHome });
  const targetLock = readHomeLock(targetHome);
  if (Number.isInteger(targetLock?.pid) && pidAlive(targetLock.pid)) {
    const targetLockHome = typeof targetLock.home === 'string' ? resolve(targetLock.home) : null;
    if (targetLockHome !== null && targetLockHome !== resolve(targetHome)) {
      throw cloudError(
        'CLOUD_ALREADY_ACTIVE',
        `目标端口上的守护属于另一张忆云（pid ${targetLock.pid}，home=${targetLock.home}）；请先停止它`,
      );
    }
    await stopLockedPid({
      home: targetHome,
      http: targetHttp,
      fetchImpl,
      pidAlive,
      killPid,
      looksLikeMebular,
      timeoutMs: Math.min(stopTimeoutMs, 5_000),
    });
  }

  // 旧服务迁移（保留 --no-autostart），再判定托管模式。
  if (previousHome) {
    try {
      await migrateLegacyService({
        service,
        descriptor: previousDescriptor ?? descriptor,
        home: previousHome,
        serviceHome,
        http: httpForHome(previousHome, env),
        fetchImpl,
        pidAlive,
        stopTimeoutMs,
      });
    } catch (error) {
      throw cloudError('SERVICE_MIGRATION_FAILED', `旧忆云服务迁移失败：${error?.message ?? error}`, { cause: error });
    }
  }
  const oldStatus = statusForHome(service, previousDescriptor ?? descriptor, serviceHome);
  const serviceManaged = Boolean(oldStatus?.registered);
  const mode = serviceManaged ? 'service' : 'child';
  const prefs = await readCloudPrefs(root);
  const autostart = oldStatus?.autostart
    ?? prefs.profiles?.[previous?.id ?? '']?.autostart
    ?? true;
  const oldWasLive = Boolean(oldHealth.ok || managedChild || oldLockPid || oldStatus?.running);
  if (previous?.id) {
    await writeCloudPreference(root, previous.id, { mode, autostart });
  }
  await writeCloudPreference(root, target.id, { mode, autostart });

  let activeStart = null;
  const stop = async () => {
    await stopCloudDaemon({
      home,
      http: oldHttp,
      service,
      descriptor: previousDescriptor ?? descriptor,
      serviceHome,
      managedChild,
      oldPid: oldLockPid,
      fetchImpl,
      pidAlive,
      killPid,
      looksLikeMebular,
      stopTimeoutMs,
    });
  };
  const start = async ({ to, toHome, rollback = false }) => {
    if (rollback && to?.id === previous?.id && !oldWasLive) return;
    const targetMode = to?.id === previous?.id ? (prefs.profiles?.[previous?.id]?.mode ?? mode) : mode;
    const targetAutostart = to?.id === previous?.id
      ? (prefs.profiles?.[previous?.id]?.autostart ?? autostart)
      : autostart;
    const started = await startCloudDaemon({
      root,
      home: toHome,
      http: httpForHome(toHome, env),
      cliBin,
      service,
      descriptor: to?.id === previous?.id ? (previousDescriptor ?? descriptor) : targetDescriptor,
      serviceHome,
      mode: targetMode,
      autostart: targetAutostart,
      spawnFn,
      env,
    });
    activeStart = { ...started, home: toHome };
  };
  const verify = async ({ to, home: verifyHome, rollback = false }) => {
    if (rollback && to?.id === previous?.id && !oldWasLive) return true;
    const http = httpForHome(verifyHome, env);
    const result = await waitForCloudDaemon({
      http,
      fetchImpl,
      expectedInstance: homeKey(verifyHome),
      cloudId: to?.id ?? null,
      timeoutMs: verifyTimeoutMs,
      intervalMs: verifyIntervalMs,
    });
    if (result.reason === 'instance_mismatch') {
      throw cloudError('CLOUD_INSTANCE_MISMATCH', mismatchMessage(http.port), { instance: result.instance });
    }
    if (result.reason === 'instance_missing') {
      throw cloudError('CLOUD_INSTANCE_MISSING', `端口 ${http.port} 上的守护没有 /healthz instance 身份，无法确认是目标忆云`);
    }
    if (result.reason === 'cloud_mismatch') {
      throw cloudError('CLOUD_CLOUD_ID_MISMATCH', `/healthz cloudId=${result.cloudId} 与目标「${to?.id}」不一致`);
    }
    return result.ok;
  };
  const abort = async () => {
    // 先停掉本进程刚拉起的半启动目标（child），再清服务单元/lock，避免回滚时双活。
    if (activeStart?.child && typeof activeStart.child.kill === 'function') {
      try { activeStart.child.kill('SIGTERM'); } catch { /* 已退出 */ }
      await waitForCloudStopped({
        home: targetHome,
        http: targetHttp,
        fetchImpl,
        pidAlive,
        timeoutMs: Math.min(stopTimeoutMs, 5_000),
      });
      activeStart = null;
    }
    await stopTargetLeftovers({ service, descriptor: targetDescriptor, serviceHome, targetHome });
    await stopLockedPid({
      home: targetHome,
      http: targetHttp,
      fetchImpl,
      pidAlive,
      killPid,
      looksLikeMebular,
      timeoutMs: 5_000,
    });
  };

  try {
    const result = await modules.switch.switchProfile({
      root,
      id,
      stop,
      start,
      verify,
      abort,
    });
    const started = activeStart ?? { mode, child: null };
    await writeCloudPreference(root, target.id, {
      mode: started.mode,
      autostart,
      lastUsedAt: new Date().toISOString(),
    });
    return {
      ...result,
      mode: started.mode,
      child: started.child ?? null,
      autostart,
    };
  } catch (error) {
    const causeMismatch = error?.cause?.code === 'CLOUD_INSTANCE_MISMATCH' ? error.cause : null;
    const causeMissing = error?.cause?.code === 'CLOUD_INSTANCE_MISSING' ? error.cause : null;
    const normalized = causeMismatch || causeMissing
      ? cloudError(causeMismatch ? 'CLOUD_INSTANCE_MISMATCH' : 'CLOUD_INSTANCE_MISSING', (causeMismatch ?? causeMissing).message, {
        cause: error,
        rollback: error.rollback,
      })
      : error;
    normalized.child = activeStart?.child ?? null;
    normalized.mode = activeStart?.mode ?? mode;
    normalized.home = home;
    throw normalized;
  }
}

/**
 * switch.intent.json 崩溃恢复：
 *   目标健康 = 成功（current=to）；否则停掉半启动目标并回旧；旧也起不来 → 诊断（intent/档案都保留）。
 * 返回 { recovered, status: 'committed'|'rolled_back'|'diagnostics', current, home, mode?, child?, message? }。
 */
export async function recoverSwitchIntent({
  root,
  cliBin,
  service = {},
  serviceHome = homedir(),
  modules,
  fetchImpl = fetch,
  spawnFn,
  env = process.env,
  managedChild = null,
  pidAlive = defaultPidAlive,
  killPid = defaultKillPid,
  looksLikeMebular = defaultLooksLikeMebularServe,
  verifyTimeoutMs = 20_000,
  verifyIntervalMs = 500,
  stopTimeoutMs = 10_000,
} = {}) {
  if (!modules?.profiles || !modules?.switch) return { recovered: false, reason: 'modules_unavailable' };
  const intent = await modules.switch.readSwitchIntent(root);
  if (!intent || typeof intent.from !== 'string' || typeof intent.to !== 'string') {
    return { recovered: false, reason: 'no_intent' };
  }
  const state = await modules.profiles.readRegistry(root);
  const target = state.registry.profiles.find((profile) => profile.id === intent.to) ?? null;
  const previous = state.registry.profiles.find((profile) => profile.id === intent.from) ?? null;
  let targetHome = null;
  let previousHome = null;
  try {
    targetHome = target ? modules.profiles.profileHomeForEntry(root, target) : null;
    previousHome = previous ? modules.profiles.profileHomeForEntry(root, previous) : null;
  } catch (error) {
    return {
      recovered: true,
      status: 'diagnostics',
      current: state.registry.current,
      home: previousHome,
      message: `忆云档案路径异常，无法恢复切换：${error?.message ?? error}`,
      intent,
    };
  }

  if (targetHome) {
    const targetHttp = httpForHome(targetHome, env);
    const targetHealth = await waitForCloudDaemon({
      http: targetHttp,
      fetchImpl,
      expectedInstance: homeKey(targetHome),
      cloudId: intent.to,
      timeoutMs: Math.min(3_000, verifyTimeoutMs),
      intervalMs: 150,
    });
    if (targetHealth.ok) {
      await modules.profiles.setCurrentProfile(root, intent.to);
      await modules.switch.clearSwitchIntent(root);
      const targetStatus = statusForHome(service, {
        kind: CLOUD_SERVICE_KIND,
        args: [cliBin, 'serve'],
        heartbeatDir: targetHome,
        env: { MEBULAR_HOME: targetHome, MEBULAR_CLOUD_ROOT: root },
      }, serviceHome);
      return {
        recovered: true,
        status: 'committed',
        current: intent.to,
        home: targetHome,
        mode: targetStatus?.registered ? 'service' : 'reused',
        child: null,
        profile: target,
      };
    }
    // 目标不健康：先停掉可能半启动的目标，防回滚双活。
    const targetDescriptor = {
      kind: CLOUD_SERVICE_KIND,
      args: [cliBin, 'serve'],
      heartbeatDir: targetHome,
      workingDir: targetHome,
      execPath: process.execPath,
      env: { MEBULAR_HOME: targetHome, MEBULAR_CLOUD_ROOT: root, ELECTRON_RUN_AS_NODE: '1' },
    };
    await stopTargetLeftovers({ service, descriptor: targetDescriptor, serviceHome, targetHome }).catch(() => undefined);
    await stopLockedPid({
      home: targetHome,
      http: targetHttp,
      fetchImpl,
      pidAlive,
      killPid,
      looksLikeMebular,
      timeoutMs: Math.min(stopTimeoutMs, 5_000),
    }).catch(() => undefined);
  }

  let activeChild = null;
  if (previous?.id) {
    try {
      await modules.profiles.setCurrentProfile(root, previous.id);
    } catch {
      // current 已是 from/损坏：下面仍尝试把旧守护拉起来
    }
  }
  if (previousHome) {
    const previousHttp = httpForHome(previousHome, env);
    const previousHealth = await probeHealthDetail(fetchImpl, previousHttp, {
      expectedInstance: homeKey(previousHome),
      cloudId: previous?.id ?? null,
    });
    if (previousHealth.ok) {
      const previousStatus = statusForHome(service, {
        kind: CLOUD_SERVICE_KIND,
        args: [cliBin, 'serve'],
        heartbeatDir: previousHome,
        env: { MEBULAR_HOME: previousHome, MEBULAR_CLOUD_ROOT: root },
      }, serviceHome);
      await modules.switch.clearSwitchIntent(root);
      return {
        recovered: true,
        status: 'rolled_back',
        current: previous.id,
        home: previousHome,
        mode: previousStatus?.registered ? 'service' : 'reused',
        child: managedChild,
        profile: previous,
      };
    }

    const previousDescriptor = {
      kind: CLOUD_SERVICE_KIND,
      args: [cliBin, 'serve'],
      heartbeatDir: previousHome,
      workingDir: previousHome,
      execPath: process.execPath,
      env: { MEBULAR_HOME: previousHome, MEBULAR_CLOUD_ROOT: root, ELECTRON_RUN_AS_NODE: '1' },
    };
    const prefs = await readCloudPrefs(root);
    const pref = prefs.profiles?.[previous.id] ?? {};
    let oldStatus = statusForHome(service, previousDescriptor, serviceHome);
    try {
      const migration = await migrateLegacyService({
        service,
        descriptor: previousDescriptor,
        home: previousHome,
        serviceHome,
        http: previousHttp,
        fetchImpl,
        pidAlive,
        stopTimeoutMs,
      });
      if (migration.registered) oldStatus = { ...(oldStatus ?? {}), registered: true };
    } catch {
      // 迁移失败不阻断 child 兜底
    }
    const mode = oldStatus?.registered ? 'service' : (pref.mode === 'service' && service?.installService ? 'service' : 'child');
    const autostart = oldStatus?.autostart ?? pref.autostart ?? true;
    try {
      const started = await startCloudDaemon({
        root,
        home: previousHome,
        http: previousHttp,
        cliBin,
        service,
        descriptor: previousDescriptor,
        serviceHome,
        mode,
        autostart,
        spawnFn,
        env,
      });
      activeChild = started.child;
      const healthy = await waitForCloudDaemon({
        http: previousHttp,
        fetchImpl,
        expectedInstance: homeKey(previousHome),
        cloudId: previous.id,
        timeoutMs: verifyTimeoutMs,
        intervalMs: verifyIntervalMs,
      });
      if (healthy.ok) {
        await modules.switch.clearSwitchIntent(root);
        return {
          recovered: true,
          status: 'rolled_back',
          current: previous.id,
          home: previousHome,
          mode: started.mode,
          child: started.child,
          profile: previous,
        };
      }
    } catch {
      // 落到诊断
    }
  }

  const message = [
    '忆云切换未完成，且两张忆云都未就绪（诊断）：',
    `  目标：${intent.to}${targetHome ? `（${targetHome}）` : ''}`,
    `  旧忆云：${intent.from}${previousHome ? `（${previousHome}）` : ''}`,
    '已保留 switch.intent.json 与全部忆云档案，未删除任何数据；请检查端口/日志后重试。',
  ].join('\n');
  return {
    recovered: true,
    status: 'diagnostics',
    current: previous?.id ?? state.registry.current,
    home: previousHome,
    mode: null,
    child: activeChild,
    message,
    intent,
  };
}
