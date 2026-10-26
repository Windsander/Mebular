// E2-B · App 壳忆云编排（**不 import electron**，可被 node/jest 直接加载与单测）
//
// 只做进程/服务生命周期 + 状态机接线：档案注册表/切换引擎复用 packages/mcp/src（E2-A1），
// App 不复制业务逻辑。红线：
//   - 切换不复制、不合并、不删除任何忆云目录；只停旧守护/起新守护/改 current。
//   - 端口 200 必须核对 /healthz instance（homeKey）；不匹配 = 另一张忆云，不得 reused/继续。
//   - 失败回滚旧守护；崩溃由 switch.intent.json 恢复；两者都不健康只诊断，不删档案/intent。
//   - service 所有权统一走 runtime-service：current 可用时禁止回退 App descriptor 覆盖共享 service。

import { readFileSync, existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  APP_VERSION,
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
  const src = join(dirname(cliBin), '..', 'src');
  const profiles = await import(pathToFileURL(join(src, 'profiles.mjs')).href);
  const switchModule = await import(pathToFileURL(join(src, 'cloud-switch.mjs')).href);
  let runtime = null;
  try {
    runtime = await import(pathToFileURL(join(src, 'runtime-service.mjs')).href);
  } catch {
    // 自定义安装/旧布局：保留 legacy service 兜底；调用方会用 current 文件做 fail-safe。
    runtime = null;
  }
  return {
    profiles,
    switch: switchModule,
    runtime,
  };
}

function hasRuntimeCurrent(root) {
  return typeof root === 'string' && root.length > 0
    && existsSync(join(root, 'runtime', 'current.json'));
}

/** App/CLI fallback 来源：只记录 owner/provider，不下载、不安装 runtime。 */
export function appFallbackProvider({ cliBin, execPath = process.execPath, version = APP_VERSION } = {}) {
  return {
    path: cliBin,
    kind: 'app',
    owner: 'app',
    version,
    runtimePath: null,
    execPath,
    electron: true,
  };
}

/** legacy（无 runtime-service）时仍保持 App 既有 descriptor 行为，并记录 owner=app。 */
export function legacyServiceDescriptor({
  root,
  home,
  http = null,
  cliBin,
  execPath = process.execPath,
} = {}) {
  const port = Number(http?.port);
  const listenArgs = Number.isInteger(port) && port > 0 ? ['--port', String(port)] : [];
  return {
    kind: CLOUD_SERVICE_KIND,
    args: [cliBin, 'serve', ...listenArgs],
    heartbeatDir: home,
    workingDir: home,
    execPath,
    env: {
      MEBULAR_HOME: home,
      ...(typeof root === 'string' && root.length > 0 ? { MEBULAR_CLOUD_ROOT: root } : {}),
      ELECTRON_RUN_AS_NODE: '1',
      MEBULAR_RUNTIME_PROVIDER: 'app',
      MEBULAR_RUNTIME_OWNER: 'app',
      MEBULAR_RUNTIME_VERSION: APP_VERSION,
      ...(cliBin ? { MEBULAR_RUNTIME_PATH: cliBin } : {}),
    },
    runtime: {
      version: APP_VERSION,
      runtimePath: null,
      cliPath: cliBin,
      provider: 'app',
      owner: 'app',
      execPath,
      electron: true,
      cloudRoot: typeof root === 'string' && root.length > 0 ? root : null,
      home,
    },
  };
}

/**
 * 云切换统一 service 操作层：
 *   - runtime-service 可用：current 优先；无 current 才用 App fallback（记录 owner）；
 *   - runtime-service 不可用且 current 存在：blocked（绝不回退 App descriptor 覆盖共享 service）；
 *   - 两者都没有：legacy descriptor 兜底（自定义安装/旧测试），仍记录 owner=app。
 */
export async function createCloudServiceOps({
  root = null,
  cliBin = null,
  service = {},
  runtimeService = null,
  fallbackProvider = null,
} = {}) {
  let runtime = runtimeService;
  let runtimeError = null;
  if (runtime === null && typeof cliBin === 'string' && cliBin.length > 0) {
    try {
      const src = join(dirname(cliBin), '..', 'src');
      runtime = await import(pathToFileURL(join(src, 'runtime-service.mjs')).href);
    } catch (error) {
      runtimeError = error;
    }
  }
  const shared = runtime !== null
    && typeof runtime?.installRuntimeService === 'function'
    && typeof runtime?.runtimeServiceStatus === 'function'
    && typeof runtime?.uninstallRuntimeService === 'function';
  if (!shared && hasRuntimeCurrent(root)) {
    const error = cloudError(
      'RUNTIME_SERVICE_UNAVAILABLE',
      '共享 runtime current 存在，但 runtime-service 不可用：拒绝用 App descriptor 覆盖共享 service',
      { cause: runtimeError },
    );
    return {
      mode: 'blocked',
      error,
      canInstall: false,
      async status() { throw error; },
      async install() { throw error; },
      async uninstall() { throw error; },
      async planRestart() { throw error; },
    };
  }

  const fallback = fallbackProvider ?? appFallbackProvider({ cliBin });
  const descriptorFor = (home, http = null) => legacyServiceDescriptor({
    root,
    home,
    http,
    cliBin,
    execPath: fallback?.execPath ?? process.execPath,
  });

  return {
    mode: shared ? 'shared' : 'legacy',
    runtime,
    error: runtimeError,
    fallbackProvider: fallback,
    canInstall: shared || typeof service?.installService === 'function',
    descriptorFor,
    async status({ home, serviceHome = homedir(), http = null } = {}) {
      if (shared) {
        try {
          return await runtime.runtimeServiceStatus({
            root,
            home,
            serviceHome,
            serviceLib: service,
            fallbackProvider: fallback,
          });
        } catch (error) {
          return { ok: false, registered: false, running: false, autostart: null, unitPath: null, error: String(error?.message ?? error) };
        }
      }
      const status = safeStatus(service, descriptorFor(home, http), serviceHome);
      if (status === null) return null;
      const expectedLabel = typeof service?.defaultLabel === 'function'
        ? service.defaultLabel(CLOUD_SERVICE_KIND, undefined, home)
        : null;
      return { ...status, expectedLabel };
    },
    /**
     * 该 service 是否确实属于 home（不是同一 serviceHome 下另一个 home/cloudRoot）。
     * runtime-service 模式用 manifest runtime.home / label 判定；legacy 模式保持旧行为。
     */
    async ownsService({ home, serviceHome = homedir(), http = null } = {}) {
      const status = await this.status({ home, serviceHome, http });
      if (status?.registered !== true) return false;
      if (!shared) return true;
      if (typeof status.runtime?.home === 'string' && status.runtime.home.length > 0) {
        return resolve(status.runtime.home) === resolve(home);
      }
      const manifestLabel = status.manifestLabel ?? status.label;
      if (typeof manifestLabel === 'string' && typeof status.expectedLabel === 'string') {
        return manifestLabel === status.expectedLabel;
      }
      // 不完整注入（自定义 runtime-service/测试替身）没有 ownership 元数据：保持旧语义信任 registered。
      return true;
    },
    async install({ home, http = null, serviceHome = homedir(), autostart = true } = {}) {
      if (shared) {
        return runtime.installRuntimeService({
          root,
          home,
          serviceHome,
          http,
          fallbackProvider: fallback,
          serviceLib: service,
          autostart,
        });
      }
      if (typeof service?.installService !== 'function') {
        throw cloudError('SERVICE_UNAVAILABLE', '服务托管不可用：无法安装忆云守护服务');
      }
      return service.installService(descriptorFor(home, http), { home: serviceHome, autostart });
    },
    async uninstall({ home, serviceHome = homedir() } = {}) {
      if (shared) {
        return runtime.uninstallRuntimeService({
          root,
          home,
          serviceHome,
          serviceLib: service,
        });
      }
      if (typeof service?.uninstallService !== 'function') return { ok: false, removed: false };
      return service.uninstallService(descriptorFor(home), { home: serviceHome });
    },
    async planRestart({ home, serviceHome = homedir() } = {}) {
      if (shared && typeof runtime.planRuntimeServiceRestart === 'function') {
        return runtime.planRuntimeServiceRestart({
          root,
          home,
          serviceHome,
          serviceLib: service,
          fallbackProvider: fallback,
        });
      }
      if (typeof service?.restartPlanFor !== 'function') {
        return { registered: false, manual: '服务管理不可用：请手动重启' };
      }
      return service.restartPlanFor(descriptorFor(home), { home: serviceHome });
    },
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
  descriptor = null,
  root = null,
  cliBin = null,
  runtimeService = null,
  fallbackProvider = null,
  serviceOps = null,
  home,
  serviceHome = homedir(),
  http = null,
  fetchImpl = fetch,
  pidAlive = defaultPidAlive,
  stopTimeoutMs = 10_000,
} = {}) {
  let ops = serviceOps;
  if (ops === null) {
    ops = await createCloudServiceOps({
      root,
      cliBin: cliBin ?? descriptor?.args?.[0] ?? null,
      service,
      runtimeService,
      fallbackProvider,
    });
  }
  if (ops.mode === 'blocked') {
    return { migrated: false, available: false, reason: 'runtime_service_unavailable', error: ops.error?.message ?? null };
  }
  if (ops.mode === 'legacy' && typeof service?.serviceStatus !== 'function') {
    return { migrated: false, available: false, reason: 'service_unavailable' };
  }
  if (resolve(home) === resolve(serviceHome)) {
    return { migrated: false, available: true, reason: 'same_service_home' };
  }
  const statusNew = await ops.status({ home, serviceHome });
  const newOwned = await ops.ownsService({ home, serviceHome });
  if (statusNew?.registered === true && !newOwned) {
    return {
      migrated: false,
      available: true,
      registered: false,
      running: false,
      autostart: null,
      reason: 'service_conflict',
      runtime: statusNew?.runtime ?? null,
    };
  }
  const statusLegacy = await ops.status({ home, serviceHome: home });
  if (!statusLegacy?.registered) {
    return {
      migrated: false,
      available: true,
      registered: Boolean(newOwned),
      running: Boolean(newOwned && statusNew?.running),
      autostart: statusNew?.autostart ?? null,
      runtime: statusNew?.runtime ?? null,
    };
  }
  const autostart = statusLegacy.autostart ?? statusNew?.autostart ?? true;
  let installed = false;
  let installResult = null;
  if (!newOwned) {
    // 先停旧单元并等 lock 释放，再装新单元：避免新进程撞上旧 active.lock（双活窗口）。
    await ops.uninstall({ home, serviceHome: home });
    if (http && await waitForCloudStopped({ home, http, fetchImpl, pidAlive, timeoutMs: stopTimeoutMs }) === false) {
      throw cloudError('SERVICE_MIGRATION_FAILED', '旧守护服务未能停止（lock/端口仍被占用）：请检查诊断');
    }
    installResult = await ops.install({ home, http, serviceHome, autostart });
    if (installResult?.ok !== true || installResult?.running === false) {
      throw cloudError(
        'SERVICE_MIGRATION_FAILED',
        `旧守护服务迁移失败：${installResult?.error ?? installResult?.message ?? installResult?.reason ?? 'installService 未成功'}`,
        { result: installResult },
      );
    }
    installed = true;
  }
  // 只删 legacy 单元/manifest 文件；不 bootout（若新服务同 label 已运行，bootout 会误杀）。
  const legacyUnit = statusLegacy.unitPath ?? null;
  let legacyManifest = null;
  try {
    legacyManifest = typeof service.manifestPath === 'function'
      ? service.manifestPath(descriptor?.kind ?? CLOUD_SERVICE_KIND, home)
      : join(home, '.mebular', 'services', `${descriptor?.kind ?? CLOUD_SERVICE_KIND}.json`);
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
    running: Boolean((newOwned && statusNew?.running) || installed),
    autostart,
    runtime: installResult?.runtime ?? statusNew?.runtime ?? statusLegacy?.runtime ?? null,
    provider: installResult?.provider ?? statusNew?.provider ?? null,
    owner: installResult?.owner ?? statusNew?.owner ?? null,
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
  root = null,
  cliBin = null,
  home,
  http,
  service,
  descriptor = null,
  runtimeService = null,
  fallbackProvider = null,
  serviceOps = null,
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

  const ops = serviceOps ?? await createCloudServiceOps({
    root,
    cliBin: cliBin ?? descriptor?.args?.[0] ?? null,
    service,
    runtimeService,
    fallbackProvider,
  });
  if (ops.mode === 'blocked') throw ops.error;

  let serviceStopped = false;
  const ownedNew = await ops.ownsService({ home, serviceHome, http });
  if (ownedNew) {
    const result = await ops.uninstall({ home, serviceHome });
    serviceStopped = result?.ok !== false;
  }
  if (resolve(home) !== resolve(serviceHome)) {
    const ownedLegacy = await ops.ownsService({ home, serviceHome: home, http });
    if (ownedLegacy) {
      await ops.uninstall({ home, serviceHome: home });
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
  descriptor = null,
  runtimeService = null,
  fallbackProvider = null,
  serviceOps = null,
  serviceHome = homedir(),
  mode = 'child',
  autostart = true,
  spawnFn,
  env = process.env,
} = {}) {
  if (mode === 'service') {
    const ops = serviceOps ?? await createCloudServiceOps({
      root,
      cliBin: cliBin ?? descriptor?.args?.[0] ?? null,
      service,
      runtimeService,
      fallbackProvider,
      env,
    });
    if (ops.mode === 'blocked') throw ops.error;
    if (ops.canInstall !== true) {
      throw cloudError('SERVICE_UNAVAILABLE', '服务托管不可用：无法安装忆云守护服务');
    }
    const result = await ops.install({ home, http, serviceHome, autostart });
    if (result?.ok !== true || result?.running === false) {
      throw cloudError(
        'SERVICE_START_FAILED',
        `服务安装失败：${result?.error ?? result?.message ?? result?.reason ?? result?.warning ?? '未知原因'}`,
        { result },
      );
    }
    return { mode: 'service', child: null, result, runtime: result.runtime ?? null, provider: result.provider ?? null, owner: result.owner ?? null };
  }
  if (typeof spawnFn !== 'function') throw cloudError('SPAWN_UNAVAILABLE', '缺少子进程启动器');
  const listenArgs = Number.isInteger(http?.port) && http.port > 0 ? ['--port', String(http.port)] : [];
  const child = spawnFn(process.execPath, [cliBin, 'serve', ...listenArgs], {
    env: {
      ...env,
      MEBULAR_HOME: home,
      MEBULAR_CLOUD_ROOT: root,
      ELECTRON_RUN_AS_NODE: '1',
      MEBULAR_RUNTIME_PROVIDER: 'app',
      MEBULAR_RUNTIME_OWNER: 'app',
      ...(cliBin ? { MEBULAR_RUNTIME_PATH: cliBin } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { mode: 'child', child, result: null };
}

/** 清掉目标忆云可能残留的服务单元（上次失败切换），避免与 child 抢端口/单活。 */
export async function stopTargetLeftovers({
  serviceOps = null,
  service = {},
  root = null,
  cliBin = null,
  descriptor = null,
  runtimeService = null,
  fallbackProvider = null,
  serviceHome,
  targetHome,
}) {
  const ops = serviceOps ?? await createCloudServiceOps({
    root,
    cliBin: cliBin ?? descriptor?.args?.[0] ?? null,
    service,
    runtimeService,
    fallbackProvider,
  });
  if (ops.mode === 'blocked') throw ops.error;
  for (const at of [serviceHome, targetHome]) {
    if (typeof at !== 'string' || at.length === 0) continue;
    const status = await ops.status({ home: targetHome, serviceHome: at });
    // targetHome 下的 manifest 是目标忆云自己的 legacy 位置；serviceHome 是共享位置，
    // 必须核对 ownership，绝不删除其他 home/cloudRoot 的 service。
    const owned = at === targetHome && at !== serviceHome
      ? status?.registered === true
      : await ops.ownsService({ home: targetHome, serviceHome: at });
    if (owned) {
      await ops.uninstall({ home: targetHome, serviceHome: at });
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
  runtimeService = null,
  fallbackProvider = null,
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
  const serviceOps = await createCloudServiceOps({
    root,
    cliBin,
    service,
    runtimeService: runtimeService ?? modules.runtime ?? null,
    fallbackProvider,
    env,
  });
  if (serviceOps.mode === 'blocked') throw serviceOps.error;

  // 目标残留单元先清掉（只针对目标 home；不触碰旧/其他 home 的 service）。
  await stopTargetLeftovers({ serviceOps, serviceHome, targetHome });
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
        serviceOps,
        service,
        descriptor: null,
        root,
        cliBin,
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
  const oldStatus = await serviceOps.status({
    home: previousHome ?? home,
    serviceHome,
    http: previousHome ? httpForHome(previousHome, env) : oldHttp,
  });
  const oldOwned = await serviceOps.ownsService({
    home: previousHome ?? home,
    serviceHome,
    http: previousHome ? httpForHome(previousHome, env) : oldHttp,
  });
  const serviceManaged = Boolean(oldOwned);
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
      root,
      cliBin,
      home,
      http: oldHttp,
      service,
      runtimeService: runtimeService ?? modules.runtime ?? null,
      fallbackProvider,
      serviceOps,
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
      runtimeService: runtimeService ?? modules.runtime ?? null,
      fallbackProvider,
      serviceOps,
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
    await stopTargetLeftovers({ serviceOps, serviceHome, targetHome });
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
  runtimeService = null,
  fallbackProvider = null,
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

  const serviceOps = await createCloudServiceOps({
    root,
    cliBin,
    service,
    runtimeService: runtimeService ?? modules.runtime ?? null,
    fallbackProvider,
    env,
  });
  if (serviceOps.mode === 'blocked') {
    return {
      recovered: true,
      status: 'diagnostics',
      current: state.registry.current,
      home: previousHome,
      message: `共享 runtime current 存在但 runtime-service 不可用：拒绝用 App descriptor 覆盖 service（${serviceOps.error?.message ?? 'runtime_service_unavailable'}）`,
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
      const targetStatus = await serviceOps.status({ home: targetHome, serviceHome, http: targetHttp });
      const targetOwned = await serviceOps.ownsService({ home: targetHome, serviceHome, http: targetHttp });
      return {
        recovered: true,
        status: 'committed',
        current: intent.to,
        home: targetHome,
        mode: targetOwned ? 'service' : 'reused',
        child: null,
        profile: target,
        service: targetStatus?.registered ? targetStatus : null,
      };
    }
    // 目标不健康：先停掉可能半启动的目标，防回滚双活。
    await stopTargetLeftovers({ serviceOps, serviceHome, targetHome }).catch(() => undefined);
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
      const previousStatus = await serviceOps.status({ home: previousHome, serviceHome, http: previousHttp });
      const previousOwned = await serviceOps.ownsService({ home: previousHome, serviceHome, http: previousHttp });
      await modules.switch.clearSwitchIntent(root);
      return {
        recovered: true,
        status: 'rolled_back',
        current: previous.id,
        home: previousHome,
        mode: previousOwned ? 'service' : 'reused',
        child: managedChild,
        profile: previous,
        service: previousStatus?.registered ? previousStatus : null,
      };
    }

    const prefs = await readCloudPrefs(root);
    const pref = prefs.profiles?.[previous.id] ?? {};
    let oldStatus = await serviceOps.status({ home: previousHome, serviceHome, http: previousHttp });
    let oldOwned = await serviceOps.ownsService({ home: previousHome, serviceHome, http: previousHttp });
    try {
      const migration = await migrateLegacyService({
        serviceOps,
        service,
        root,
        cliBin,
        home: previousHome,
        serviceHome,
        http: previousHttp,
        fetchImpl,
        pidAlive,
        stopTimeoutMs,
      });
      if (migration.registered) {
        oldStatus = { ...(oldStatus ?? {}), registered: true };
        oldOwned = true;
      }
    } catch {
      // 迁移失败不阻断 child 兜底
    }
    const mode = oldOwned ? 'service' : (pref.mode === 'service' && serviceOps.canInstall ? 'service' : 'child');
    const autostart = oldStatus?.autostart ?? pref.autostart ?? true;
    try {
      const started = await startCloudDaemon({
        root,
        home: previousHome,
        http: previousHttp,
        cliBin,
        service,
        runtimeService: runtimeService ?? modules.runtime ?? null,
        fallbackProvider,
        serviceOps,
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
