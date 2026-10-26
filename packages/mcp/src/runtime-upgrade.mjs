// 共享 Runtime 受控升级（Phase 5a/5b2）：显式 `runtime upgrade --to <version>`。
//
// 复用 4a installer 的下载/校验/备份/原子换入与 provider 注册；本模块负责：
//   1. 跨入口升级互斥：`<cloudRoot>/runtime/upgrade.lock`（wx + PID + 超时 + 陈旧回收 +
//      token 释放）。一个入口升级时另一个直接返回稳定 `busy`，不写 current/provider/service。
//   2. 共享非敏感升级状态：`<cloudRoot>/runtime/upgrade-state.json`（upgrading/from/to/
//      startedAt/finishedAt/reason/available/entry；原子写、0600、损坏回退为空）。
//   3. 记录升级前 current/provider/service 快照；
//   4. 安装新版本（installer 成功后写 current）；
//   5. 若 mebular-serve 已注册，更新 manifest 并重启（不启动第二个 daemon）；
//   6. 任何后置失败都把 current/provider/service 回滚到升级前，旧 runtime 始终保留。
//
// 入口（App/Plugin）拥有 child 时，只应重启自己的 supervise；本 CLI/共享路径不杀外部
// daemon，也不自动 ensure 新版本。升级成功后同时把共享 update-state 标记为已应用到目标版本，
// 避免两个入口继续提示同一版本。

import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pidAlive, resolveCloudRoot } from './profiles.mjs';
import { installRuntime } from './runtime-installer.mjs';
import { assertRuntimeVersion } from './runtime-layout.mjs';
import {
  clearRuntimeCurrent,
  publicRuntimeCurrent,
  readRuntimeCurrent,
  writeRuntimeCurrent,
} from './runtime-current.mjs';
import { readRuntimeProviders, writeRuntimeProviders } from './runtime-providers.mjs';
import {
  installRuntimeService,
  runtimeServiceStatus,
} from './runtime-service.mjs';
import {
  compareSemver,
  parseSemver,
  readRuntimeUpdateState,
  writeRuntimeUpdateState,
} from './runtime-update.mjs';

export const RUNTIME_UPGRADE_FILE = 'upgrade-state.json';
export const RUNTIME_UPGRADE_LOCK_FILE = 'upgrade.lock';
export const RUNTIME_UPGRADE_VERSION = 1;
export const RUNTIME_UPGRADE_LOCK_STALE_MS = 30 * 60 * 1000;
export const RUNTIME_UPGRADE_LOCK_ATTEMPTS = 2;
export const RUNTIME_UPGRADE_LOCK_RETRY_MS = 50;
export const RUNTIME_UPGRADE_STATE_WRITE_WARNING = 'upgrade_state_write_failed';
export const RUNTIME_UPGRADE_ENTRIES = Object.freeze(['app', 'plugin', 'cli']);

const MAX_VERSION_LENGTH = 128;
const REASON_RE = /^[a-z0-9][a-z0-9_.:-]{0,79}$/;

export function runtimeUpgradeDir(root) {
  return join(root, 'runtime');
}

export function runtimeUpgradeStatePath(root) {
  return join(root, 'runtime', RUNTIME_UPGRADE_FILE);
}

export function runtimeUpgradeLockPath(root) {
  return join(root, 'runtime', RUNTIME_UPGRADE_LOCK_FILE);
}

function failure(fields = {}) {
  return {
    ok: false,
    action: 'upgrade',
    command: 'upgrade',
    reason: fields.reason ?? 'upgrade_failed',
    message: fields.message ?? 'runtime 升级失败',
    ...fields,
  };
}

function isIsoTime(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function clockDate(now) {
  let value;
  try {
    value = typeof now === 'function' ? now() : now;
  } catch {
    value = null;
  }
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value);
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return new Date(value);
  return new Date();
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function maybeVersion(value) {
  const parsed = parseSemver(typeof value === 'string' ? value : '');
  return parsed ? parsed.raw : null;
}

function safeReason(value) {
  return typeof value === 'string' && REASON_RE.test(value) ? value : null;
}

function normalizeEntry(value) {
  if (value === undefined || value === null || value === '') return null;
  return RUNTIME_UPGRADE_ENTRIES.includes(value) ? value : null;
}

/** 目标是否比当前新；任一缺失/非法时按“仍有更新”处理（保守，不清掉提示）。 */
function targetIsNewer(target, fromVersion) {
  if (!fromVersion) return true;
  try {
    return compareSemver(target, fromVersion) > 0;
  } catch {
    return true;
  }
}

export function emptyRuntimeUpgradeState() {
  return {
    v: RUNTIME_UPGRADE_VERSION,
    upgrading: false,
    fromVersion: null,
    toVersion: null,
    startedAt: null,
    finishedAt: null,
    reason: null,
    available: false,
    entry: null,
    updatedAt: null,
  };
}

/**
 * 结构规范化（只保留白名单字段，避免 state 变成秘密/任意字段仓库）。
 * 读取时任何非法字段会让整份 state 回退为空；写入时严格抛错。
 */
export function normalizeRuntimeUpgradeState(input, { now = new Date().toISOString() } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('upgrade-state 必须是对象');
  }
  if (input.v !== undefined && input.v !== RUNTIME_UPGRADE_VERSION) {
    throw new Error(`upgrade-state 版本必须是 v${RUNTIME_UPGRADE_VERSION}`);
  }
  if (input.upgrading !== undefined && typeof input.upgrading !== 'boolean') {
    throw new Error('upgrade-state.upgrading 必须是布尔');
  }
  if (input.available !== undefined && typeof input.available !== 'boolean') {
    throw new Error('upgrade-state.available 必须是布尔');
  }
  const timeField = (name) => {
    const value = input[name];
    if (value === undefined || value === null) return null;
    if (!isIsoTime(value)) throw new Error(`upgrade-state.${name} 必须是 ISO 时间或 null`);
    return value;
  };
  const versionField = (name) => {
    const value = input[name];
    if (value === undefined || value === null) return null;
    const version = maybeVersion(value);
    if (version === null || version.length > MAX_VERSION_LENGTH) {
      throw new Error(`upgrade-state.${name} 不是合法版本`);
    }
    return version;
  };
  const entry = input.entry === undefined || input.entry === null ? null : normalizeEntry(input.entry);
  if (input.entry !== undefined && input.entry !== null && entry === null) {
    throw new Error('upgrade-state.entry 非法');
  }
  const reason = input.reason === undefined || input.reason === null ? null : safeReason(input.reason);
  if (input.reason !== undefined && input.reason !== null && reason === null) {
    throw new Error('upgrade-state.reason 非法');
  }
  return {
    v: RUNTIME_UPGRADE_VERSION,
    upgrading: input.upgrading === true,
    fromVersion: versionField('fromVersion'),
    toVersion: versionField('toVersion'),
    startedAt: timeField('startedAt'),
    finishedAt: timeField('finishedAt'),
    reason,
    available: input.available === true,
    entry,
    updatedAt: isIsoTime(input.updatedAt) ? input.updatedAt : now,
  };
}

async function readJsonFile(path) {
  try {
    return { ok: true, value: JSON.parse(await readFile(path, 'utf-8')) };
  } catch (error) {
    return { ok: false, missing: error?.code === 'ENOENT', error };
  }
}

/** 读取升级状态（永不抛错）：missing/invalid 都回退为空 + warning，不阻塞入口。 */
export async function readRuntimeUpgradeState(root) {
  const base = {
    state: emptyRuntimeUpgradeState(),
    source: 'missing',
    warnings: [],
    path: null,
  };
  if (typeof root !== 'string' || root.length === 0) {
    return { ...base, source: 'unavailable', warnings: ['cloudRoot 不可用'] };
  }
  const path = runtimeUpgradeStatePath(root);
  const raw = await readJsonFile(path);
  if (!raw.ok) {
    if (raw.missing) return { ...base, path };
    return {
      ...base,
      source: 'invalid',
      path,
      warnings: [`upgrade-state 无法解析：${raw.error?.code ?? raw.error?.message ?? raw.error}`],
    };
  }
  try {
    return {
      state: normalizeRuntimeUpgradeState(raw.value),
      source: 'main',
      warnings: [],
      path,
    };
  } catch (error) {
    return {
      ...base,
      source: 'invalid',
      path,
      warnings: [`upgrade-state 无效：${error?.message ?? error}`],
    };
  }
}

/** 原子写升级状态：tmp → rename，0600。 */
export async function writeRuntimeUpgradeState(root, input, { now = new Date().toISOString() } = {}) {
  if (typeof root !== 'string' || root.length === 0) {
    throw new Error('缺少 cloudRoot，无法写 upgrade-state');
  }
  const state = normalizeRuntimeUpgradeState({
    ...input,
    v: input?.v ?? RUNTIME_UPGRADE_VERSION,
    updatedAt: input?.updatedAt ?? now,
  }, { now });
  const dir = runtimeUpgradeDir(root);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = runtimeUpgradeStatePath(root);
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await chmod(tmp, 0o600).catch(() => undefined);
    await rename(tmp, path);
    await chmod(path, 0o600).catch(() => undefined);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
  return state;
}

/** 只读公开摘要（所有字段本身即非敏感）。 */
export function publicRuntimeUpgradeState(state) {
  if (!state || typeof state !== 'object') return emptyRuntimeUpgradeState();
  return {
    v: state.v ?? RUNTIME_UPGRADE_VERSION,
    upgrading: state.upgrading === true,
    fromVersion: state.fromVersion ?? null,
    toVersion: state.toVersion ?? null,
    startedAt: state.startedAt ?? null,
    finishedAt: state.finishedAt ?? null,
    reason: state.reason ?? null,
    available: state.available === true,
    entry: state.entry ?? null,
    updatedAt: state.updatedAt ?? null,
  };
}

/** 读取原始锁（损坏/缺失 → null）；只用于诊断，不作为互斥判定。 */
export async function readRuntimeUpgradeLock(root) {
  if (typeof root !== 'string' || root.length === 0) return null;
  const raw = await readJsonFile(runtimeUpgradeLockPath(root));
  return raw.ok ? raw.value : null;
}

function lockHolder(payload) {
  const pid = Number(payload?.pid);
  return {
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    startedAt: isIsoTime(payload?.startedAt) ? payload.startedAt : null,
    entry: normalizeEntry(payload?.entry),
    toVersion: maybeVersion(payload?.toVersion),
  };
}

/**
 * 非破坏性检查升级锁：PID 存活且未超时才 busy。
 * 损坏 / 无 PID / PID 不存活 / 超时 → `busy:false, stale:true`（调用方自行决定是否回收）。
 */
export async function inspectRuntimeUpgradeLock(root, options = {}) {
  const {
    now = () => new Date(),
    pidAliveFn = pidAlive,
    staleMs = RUNTIME_UPGRADE_LOCK_STALE_MS,
  } = options;
  const base = { busy: false, stale: true, path: null, holder: null, payload: null };
  if (typeof root !== 'string' || root.length === 0) return base;
  const path = runtimeUpgradeLockPath(root);
  const raw = await readJsonFile(path);
  if (!raw.ok) return { ...base, path };
  const payload = raw.value && typeof raw.value === 'object' && !Array.isArray(raw.value) ? raw.value : null;
  const holder = lockHolder(payload);
  const heldAt = Date.parse(payload?.startedAt ?? '');
  const ageMs = Number.isFinite(heldAt) ? Math.max(0, clockDate(now).getTime() - heldAt) : null;
  const alive = holder.pid !== null ? pidAliveFn(holder.pid) !== false : false;
  const stale = holder.pid === null
    || !alive
    || (ageMs !== null && ageMs > staleMs);
  return {
    busy: !stale,
    stale,
    path,
    holder: { ...holder, ageMs },
    payload,
  };
}

/**
 * 跨入口升级互斥：wx 创建；持有者 PID 存活且未超时才 busy。
 * 有界重试（默认 2 次 × 50ms），绝不无限等待；陈旧/损坏锁直接回收。
 */
export async function acquireRuntimeUpgradeLock(root, options = {}) {
  const {
    now = () => new Date(),
    pidAliveFn = pidAlive,
    staleMs = RUNTIME_UPGRADE_LOCK_STALE_MS,
    attempts = RUNTIME_UPGRADE_LOCK_ATTEMPTS,
    retryMs = RUNTIME_UPGRADE_LOCK_RETRY_MS,
    token = randomUUID(),
    entry = null,
    fromVersion = null,
    toVersion = null,
  } = options;
  if (typeof root !== 'string' || root.length === 0) {
    return { ok: false, reason: 'lock_error', message: '缺少 cloudRoot，无法获取 upgrade.lock', holder: null };
  }
  const path = runtimeUpgradeLockPath(root);
  try {
    await mkdir(runtimeUpgradeDir(root), { recursive: true, mode: 0o700 });
  } catch (error) {
    return {
      ok: false,
      reason: 'lock_error',
      message: `无法创建 runtime 目录：${error?.code ?? error?.message ?? error}`,
      holder: null,
    };
  }

  let staleRecovered = false;
  let inspected = null;
  let attempt = 0;
  let limit = Math.max(1, attempts);
  // 回收陈旧锁后允许额外一次创建机会，避免“最后一次尝试刚好遇到陈旧锁”时误报 busy。
  while (attempt < limit) {
    const startedAt = clockDate(now).toISOString();
    const payload = {
      v: 1,
      pid: process.pid,
      token,
      startedAt,
      command: 'upgrade',
      entry: normalizeEntry(entry),
      fromVersion: maybeVersion(fromVersion),
      toVersion: maybeVersion(toVersion),
    };
    try {
      await writeFile(path, `${JSON.stringify(payload)}\n`, { mode: 0o600, flag: 'wx' });
      return {
        ok: true,
        path,
        token,
        pid: process.pid,
        startedAt,
        staleRecovered,
        holder: null,
        release: async () => {
          try {
            const held = await readJsonFile(path);
            if (!held.ok || held.value?.token !== token) return false;
            await rm(path, { force: true });
            return true;
          } catch {
            return false;
          }
        },
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        return {
          ok: false,
          reason: 'lock_error',
          message: `无法创建 upgrade.lock：${error?.code ?? error?.message ?? error}`,
          holder: null,
        };
      }
    }

    inspected = await inspectRuntimeUpgradeLock(root, { now, pidAliveFn, staleMs });
    if (inspected.stale) {
      await rm(path, { force: true }).catch(() => undefined);
      staleRecovered = true;
      limit += 1;
      attempt += 1;
      continue;
    }
    attempt += 1;
    if (attempt < limit) {
      await delay(retryMs);
      continue;
    }
  }

  const holder = inspected?.holder ?? null;
  return {
    ok: false,
    reason: 'busy',
    path,
    holder,
    staleRecovered,
    message: holder?.pid
      ? `另一个入口正在升级共享 runtime（pid ${holder.pid}）；本次不重复执行`
      : '另一个入口正在升级共享 runtime；本次不重复执行',
  };
}

function sourceFromManifestRuntime(runtime, { current = null } = {}) {
  if (!runtime || typeof runtime.cliPath !== 'string' || runtime.cliPath.length === 0) return null;
  return {
    ok: true,
    source: runtime.provider ?? 'shared',
    provider: runtime.provider ?? 'shared',
    owner: runtime.owner ?? runtime.provider ?? 'shared',
    version: runtime.version ?? null,
    runtimePath: runtime.runtimePath ?? null,
    cliPath: runtime.cliPath,
    execPath: runtime.execPath ?? process.execPath,
    electron: runtime.electron === true,
    current,
    currentSource: 'rollback',
    warnings: [],
  };
}

async function snapshotProviders(root) {
  try {
    return (await readRuntimeProviders(root)).registry.providers.map((entry) => ({ ...entry }));
  } catch {
    return null;
  }
}

async function restoreRuntimePointers({
  root,
  previousCurrent,
  previousProviders,
}) {
  const notes = [];
  if (previousProviders !== null) {
    try {
      await writeRuntimeProviders(root, { v: 1, providers: previousProviders });
    } catch {
      notes.push('previous_provider_restore_failed');
    }
  }
  try {
    if (previousCurrent !== null) {
      await writeRuntimeCurrent(root, previousCurrent);
    } else {
      await clearRuntimeCurrent(root);
    }
  } catch {
    notes.push('previous_current_restore_failed');
  }
  return notes;
}

/** 升级成功后把共享 update-state 标记为已应用到目标版本；失败只返回 warning。 */
async function markUpdateStateApplied(root, target, { now }) {
  try {
    const currentState = await readRuntimeUpdateState(root);
    await writeRuntimeUpdateState(root, {
      ...currentState.state,
      latest: currentState.state.latest ?? target,
      current: target,
      available: false,
      reason: null,
      failureReason: null,
      updatedAt: now,
    }, { now });
    return null;
  } catch {
    return 'update_state_write_failed';
  }
}

/**
 * 显式升级共享 runtime。
 *
 * 返回稳定 JSON（CLI 直接输出）：`ok/reason/current/previousCurrent/service/upgradeState` 等。
 * `installRuntimeFn` / `serviceStatusFn` / `installServiceFn` / `writeUpgradeStateFn` 可注入，
 * 便于离线测试。
 */
export async function upgradeRuntime(options = {}) {
  const {
    to,
    root: explicitRoot,
    home: explicitHome,
    env = process.env,
    userHome = homedir(),
    installRuntimeFn = installRuntime,
    serviceStatusFn = runtimeServiceStatus,
    installServiceFn = installRuntimeService,
    serviceHome,
    platform = process.platform,
    installOptions = {},
    entry = null,
    now = () => new Date(),
    pidAliveFn = pidAlive,
    lockStaleMs = RUNTIME_UPGRADE_LOCK_STALE_MS,
    lockAttempts = RUNTIME_UPGRADE_LOCK_ATTEMPTS,
    lockRetryMs = RUNTIME_UPGRADE_LOCK_RETRY_MS,
    writeUpgradeStateFn = writeRuntimeUpgradeState,
    markUpdateApplied = true,
  } = options;

  let target;
  try {
    target = assertRuntimeVersion(to);
  } catch (error) {
    return failure({
      reason: error?.code ?? 'unsupported_version',
      message: error?.message ?? String(error),
      to: typeof to === 'string' ? to : null,
      current: null,
      previousCurrent: null,
      runtimeChanged: false,
      serviceChanged: false,
    });
  }

  let root = explicitRoot;
  if (typeof root !== 'string' || root.length === 0) {
    const cloud = resolveCloudRoot({ env, userHome });
    if (!cloud.available) {
      return failure({
        reason: cloud.reason ?? 'cloud_unavailable',
        message: `runtime 上下文不可用（${cloud.reason ?? 'cloud_unavailable'}）`,
        to: target,
        current: null,
        previousCurrent: null,
        runtimeChanged: false,
        serviceChanged: false,
      });
    }
    root = cloud.root;
  }
  root = resolve(root);
  const home = typeof explicitHome === 'string' && explicitHome.length > 0
    ? resolve(explicitHome)
    : root;
  const clockIso = () => clockDate(now).toISOString();

  const beforeState = await readRuntimeCurrent(root, { userHome });
  const fromVersion = beforeState.current?.version ?? null;

  const lock = await acquireRuntimeUpgradeLock(root, {
    now,
    pidAliveFn,
    staleMs: lockStaleMs,
    attempts: lockAttempts,
    retryMs: lockRetryMs,
    entry,
    fromVersion,
    toVersion: target,
  });
  if (!lock.ok) {
    const busy = lock.reason === 'busy';
    return failure({
      reason: busy ? 'busy' : 'lock_error',
      message: lock.message ?? (busy
        ? '另一个入口正在升级共享 runtime；本次不重复执行'
        : '无法获取 upgrade.lock'),
      to: target,
      busy,
      lock: lock.holder ?? null,
      current: publicRuntimeCurrent(beforeState.current),
      previousCurrent: publicRuntimeCurrent(beforeState.current),
      runtimeChanged: false,
      serviceChanged: false,
      ...(busy ? {} : { warnings: ['upgrade_lock_unavailable'] }),
    });
  }

  let state = emptyRuntimeUpgradeState();
  const stateWarnings = [];
  const startedAt = clockIso();
  const writeState = async (patch) => {
    try {
      state = await writeUpgradeStateFn(root, {
        ...state,
        ...patch,
        v: RUNTIME_UPGRADE_VERSION,
        entry: normalizeEntry(entry),
      }, { now: clockIso() });
    } catch {
      if (!stateWarnings.includes(RUNTIME_UPGRADE_STATE_WRITE_WARNING)) {
        stateWarnings.push(RUNTIME_UPGRADE_STATE_WRITE_WARNING);
      }
    }
    return state;
  };
  const finish = async (result, { reason = result?.reason ?? 'upgrade_failed', available } = {}) => {
    const nextAvailable = available !== undefined ? available : targetIsNewer(target, fromVersion);
    const stateReason = reason === null || reason === undefined
      ? null
      : (safeReason(reason) ?? 'upgrade_failed');
    await writeState({
      upgrading: false,
      fromVersion,
      toVersion: target,
      startedAt,
      finishedAt: clockIso(),
      reason: stateReason,
      available: nextAvailable,
    });
    const warnings = [...(result.warnings ?? [])];
    for (const warning of stateWarnings) {
      if (!warnings.includes(warning)) warnings.push(warning);
    }
    return {
      ...result,
      upgradeState: publicRuntimeUpgradeState(state),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  };

  try {
    await writeState({
      upgrading: true,
      fromVersion,
      toVersion: target,
      startedAt,
      finishedAt: null,
      reason: null,
      available: targetIsNewer(target, fromVersion),
    });

    const previousCurrent = beforeState.current;
    const previousProviders = await snapshotProviders(root);

    let serviceBefore;
    try {
      serviceBefore = await serviceStatusFn({
        root,
        home,
        serviceHome,
        userHome,
        platform,
      });
    } catch (error) {
      return finish(failure({
        reason: 'service_unknown',
        message: `无法确认 mebular-serve 状态，拒绝升级：${error?.message ?? error}`,
        to: target,
        current: publicRuntimeCurrent(previousCurrent),
        previousCurrent: publicRuntimeCurrent(previousCurrent),
        runtimeChanged: false,
        serviceChanged: false,
      }));
    }
    if (serviceBefore?.ok === false) {
      return finish(failure({
        reason: serviceBefore.reason ?? 'service_unknown',
        message: serviceBefore.message ?? '无法确认 mebular-serve 状态，拒绝升级',
        to: target,
        current: publicRuntimeCurrent(previousCurrent),
        previousCurrent: publicRuntimeCurrent(previousCurrent),
        runtimeChanged: false,
        serviceChanged: false,
      }));
    }
    if (serviceBefore?.foreign === true) {
      return finish(failure({
        reason: 'service_foreign',
        message: 'mebular-serve 标签被其他 home 的作业占用：拒绝升级/覆盖',
        to: target,
        current: publicRuntimeCurrent(previousCurrent),
        previousCurrent: publicRuntimeCurrent(previousCurrent),
        runtimeChanged: false,
        serviceChanged: false,
      }));
    }

    const installed = await installRuntimeFn({
      ...installOptions,
      version: target,
      root,
      home,
      env,
      userHome,
    });
    if (installed?.ok !== true) {
      const restoreNotes = await restoreRuntimePointers({ root, previousCurrent, previousProviders });
      return finish(failure({
        ...installed,
        ok: false,
        action: 'upgrade',
        command: 'upgrade',
        reason: installed?.reason ?? installed?.code ?? 'install_failed',
        message: installed?.message ?? 'runtime 升级安装失败',
        to: target,
        previousCurrent: publicRuntimeCurrent(previousCurrent),
        current: publicRuntimeCurrent(previousCurrent),
        runtimeChanged: false,
        serviceChanged: false,
        restoreNotes,
      }));
    }

    const afterState = await readRuntimeCurrent(root, { userHome });
    if (afterState.usable !== true || afterState.current?.version !== target) {
      const restoreNotes = await restoreRuntimePointers({ root, previousCurrent, previousProviders });
      return finish(failure({
        reason: 'current_registration_failed',
        message: '运行时安装成功但 current 未指向目标版本；已回滚 current/provider',
        to: target,
        previousCurrent: publicRuntimeCurrent(previousCurrent),
        current: publicRuntimeCurrent(previousCurrent),
        runtimeInstalled: installed.runtimeInstalled === true,
        runtimeChanged: false,
        serviceChanged: false,
        restoreNotes,
        install: installed,
      }));
    }

    const newCurrent = afterState.current;
    if (serviceBefore?.registered !== true) {
      const result = {
        ok: true,
        action: 'upgrade',
        command: 'upgrade',
        reason: null,
        message: `共享 runtime 已升级到 ${target}；未注册 service，未启动/重启任何 daemon`,
        to: target,
        version: target,
        runtimePath: newCurrent.runtimePath,
        cliPath: newCurrent.cliPath,
        previousCurrent: publicRuntimeCurrent(previousCurrent),
        current: publicRuntimeCurrent(newCurrent),
        runtimeChanged: true,
        serviceChanged: false,
        service: serviceBefore,
        serviceUpdated: false,
        daemonStarted: false,
        restartRequired: false,
        backupPath: installed.backupPath ?? null,
        warnings: installed.warnings ?? [],
      };
      const finished = await finish(result, { reason: null, available: false });
      if (markUpdateApplied) {
        const warning = await markUpdateStateApplied(root, target, { now: clockIso() });
        if (warning && !finished.warnings?.includes(warning)) {
          finished.warnings = [...(finished.warnings ?? []), warning];
        }
      }
      return finished;
    }

    const serviceFallback = {
      path: newCurrent.cliPath,
      kind: 'shared',
      owner: 'shared',
      version: newCurrent.version,
      runtimePath: newCurrent.runtimePath,
      execPath: serviceBefore.execPath ?? process.execPath,
      electron: serviceBefore.runtime?.electron === true,
    };
    const serviceResult = await installServiceFn({
      root,
      home,
      serviceHome,
      currentState: afterState,
      fallbackProvider: serviceFallback,
      autostart: serviceBefore.autostart !== false,
      replaceExisting: true,
      platform,
    });

    if (serviceResult?.ok !== true || serviceResult?.running === false) {
      const restoreNotes = await restoreRuntimePointers({ root, previousCurrent, previousProviders });

      let serviceRestored = false;
      if (serviceBefore.registered === true) {
        const previousState = await readRuntimeCurrent(root, { userHome });
        const previousSource = sourceFromManifestRuntime(serviceBefore.runtime ?? {
          version: serviceBefore.version,
          runtimePath: serviceBefore.runtimePath,
          cliPath: serviceBefore.cliPath,
          provider: serviceBefore.provider ?? 'cli',
          owner: serviceBefore.owner ?? 'cli',
          execPath: serviceBefore.execPath,
          electron: false,
        }, {
          current: publicRuntimeCurrent(previousState.current),
        });
        if (previousSource !== null) {
          try {
            const rollbackService = await installServiceFn({
              root,
              home,
              serviceHome,
              currentState: previousState,
              sourceOverride: previousSource,
              autostart: serviceBefore.autostart !== false,
              replaceExisting: true,
              platform,
            });
            serviceRestored = rollbackService?.ok === true && rollbackService?.running !== false;
          } catch {
            serviceRestored = false;
          }
        }
      }

      return finish(failure({
        reason: 'service_upgrade_failed',
        message: `新 runtime 已安装，但 mebular-serve 更新/重启失败：${serviceResult?.message ?? 'unknown'}${serviceRestored ? '；已回滚 service' : '；service 回滚失败，请检查诊断'}`,
        to: target,
        previousCurrent: publicRuntimeCurrent(previousCurrent),
        current: publicRuntimeCurrent(previousCurrent),
        runtimeInstalled: installed.runtimeInstalled === true,
        runtimeChanged: false,
        serviceChanged: false,
        serviceRestored,
        serviceUpdateFailed: true,
        restoreNotes,
        install: installed,
        serviceAttempt: serviceResult,
      }));
    }

    const result = {
      ok: true,
      action: 'upgrade',
      command: 'upgrade',
      reason: null,
      message: `共享 runtime 已升级到 ${target}；mebular-serve 已更新并重启`,
      to: target,
      version: target,
      runtimePath: newCurrent.runtimePath,
      cliPath: newCurrent.cliPath,
      previousCurrent: publicRuntimeCurrent(previousCurrent),
      current: publicRuntimeCurrent(newCurrent),
      runtimeChanged: true,
      serviceChanged: true,
      serviceUpdated: true,
      service: serviceResult,
      daemonStarted: false,
      restartRequired: false,
      backupPath: installed.backupPath ?? null,
      warnings: [...(installed.warnings ?? []), ...(serviceResult.warnings ?? [])],
    };
    const finished = await finish(result, { reason: null, available: false });
    if (markUpdateApplied) {
      const warning = await markUpdateStateApplied(root, target, { now: clockIso() });
      if (warning && !finished.warnings?.includes(warning)) {
        finished.warnings = [...(finished.warnings ?? []), warning];
      }
    }
    return finished;
  } finally {
    await lock.release?.();
  }
}
