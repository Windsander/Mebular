// 共享 Runtime 更新检查（Phase 5b1）：固定来源、只读、无遥测。
//
// 范围：
//   - 只查询官方 npm registry 的固定 stable 通道
//     `https://registry.npmjs.org/@mebular/core/latest`；
//     不接受调用方传入 URL/registry/版本作为“源”。`fetchImpl` 只用于离线测试。
//   - 只读 registry 元数据中的 `version`，不下载 tarball、不安装、不改 current/
//     provider/service，也不启动/停止 daemon。
//   - 状态/锁与 App/Plugin 两个入口共享：
//       `<cloudRoot>/runtime/update-state.json`（原子写、0600、非敏感字段）
//       `<cloudRoot>/runtime/update.lock`（wx + PID 存活 + 陈旧回收）
//   - 24h TTL；失败有独立 TTL 防抖。失败不推进 `lastCheckedAt`，只写
//     `lastAttemptAt/lastAttemptOk/failureReason`，避免把失败污染成“成功”。
//
// 稳定 JSON 语义：
//   - `status`：本次调用层面发生了什么（update_available / up_to_date / skipped /
//     current_missing / throttled / busy / offline / registry_unreachable /
//     http_error / timeout / invalid_response / prerelease_ignored / lock_error /
//     cloud_unavailable / unexpected_error）。
//   - `decision`：版本比较结论（update_available / up_to_date / skipped /
//     current_missing / unknown）。fresh 结果的 status 与 decision 相同；throttled
//     时 status 是 throttled，decision 是缓存比较结论。
//   - `ok:true` 表示得到了可消费的答复（包含 no-update、throttled、busy、
//     current_missing）；`ok:false` 只用于 registry/传输/lock/上下文失败。
//     CLI 因此对 `ok:true` 退出 0，对 `ok:false` 退出 2；启动检查应只读取 JSON，
//     不因退出码阻塞入口。
//   - 失败时 `available:false`，避免离线/HTTP 失败触发更新提示；缓存的
//     `latestVersion` 仅用于诊断。

import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { cloudError, pidAlive, resolveCloudRoot } from './profiles.mjs';
import { readRuntimeCurrent } from './runtime-current.mjs';

export const RUNTIME_UPDATE_FILE = 'update-state.json';
export const RUNTIME_UPDATE_LOCK_FILE = 'update.lock';
export const RUNTIME_UPDATE_VERSION = 1;

export const RUNTIME_UPDATE_SOURCE_URL = 'https://registry.npmjs.org/@mebular/core/latest';
export const RUNTIME_UPDATE_SOURCE = Object.freeze({
  kind: 'npm',
  package: '@mebular/core',
  channel: 'stable',
  registry: 'https://registry.npmjs.org',
  url: RUNTIME_UPDATE_SOURCE_URL,
});

export const RUNTIME_UPDATE_TTL_MS = 24 * 60 * 60 * 1000;
export const RUNTIME_UPDATE_FAILURE_TTL_MS = 5 * 60 * 1000;
export const RUNTIME_UPDATE_TIMEOUT_MS = 5000;
export const RUNTIME_UPDATE_LOCK_STALE_MS = 30 * 1000;
export const RUNTIME_UPDATE_LOCK_ATTEMPTS = 3;
export const RUNTIME_UPDATE_LOCK_RETRY_MS = 20;
export const RUNTIME_UPDATE_STATE_WRITE_WARNING = 'update_state_write_failed';

const MAX_VERSION_LENGTH = 128;
const NUMERIC_IDENTIFIER = '0|[1-9]\\d*';
const PRERELEASE_IDENTIFIER = `(?:${NUMERIC_IDENTIFIER}|\\d*[A-Za-z-][0-9A-Za-z-]*)`;
const SEMVER_PATTERN = new RegExp(
  `^(${NUMERIC_IDENTIFIER})\\.(${NUMERIC_IDENTIFIER})\\.(${NUMERIC_IDENTIFIER})`
  + `(?:-(${PRERELEASE_IDENTIFIER}(?:\\.${PRERELEASE_IDENTIFIER})*))?`
  + `(?:\\+([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?$`,
);
const REASON_RE = /^[a-z0-9][a-z0-9_.:-]{0,79}$/;

const FETCH_FAILURE_MESSAGES = Object.freeze({
  offline: '无法连接 npm registry（离线）；本次跳过更新检查',
  registry_unreachable: 'npm registry 不可达；本次跳过更新检查',
  http_error: 'npm registry 返回异常状态；本次跳过更新检查',
  timeout: '更新检查超时；本次跳过更新检查',
  invalid_response: 'npm registry 返回的版本信息无效；本次跳过更新检查',
  prerelease_ignored: 'npm registry 的 latest 为非稳定版本；已忽略，不当作 stable 更新',
});

export function runtimeUpdateDir(root) {
  return join(root, 'runtime');
}

export function runtimeUpdateStatePath(root) {
  return join(root, 'runtime', RUNTIME_UPDATE_FILE);
}

export function runtimeUpdateLockPath(root) {
  return join(root, 'runtime', RUNTIME_UPDATE_LOCK_FILE);
}

/** 宽松 semver 解析（支持 prerelease/build；数字部分保留字符串以避免大数精度问题）。 */
export function parseSemver(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text.length === 0 || text.length > MAX_VERSION_LENGTH) return null;
  const match = SEMVER_PATTERN.exec(text);
  if (!match) return null;
  return {
    raw: text,
    major: match[1],
    minor: match[2],
    patch: match[3],
    prerelease: match[4] ? match[4].split('.') : [],
    build: match[5] ? match[5].split('.') : [],
  };
}

function compareNumericIdentifiers(left, right) {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * 严格 semver 优先级比较（忽略 build metadata；prerelease 按 semver §11 排序）。
 * 非法输入抛 `unsupported_version`；调用方在读 current/latest 时已先校验。
 */
export function compareSemver(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) {
    throw cloudError('unsupported_version', `无法比较版本：${String(left)} / ${String(right)}`);
  }
  for (const key of ['major', 'minor', 'patch']) {
    const compared = compareNumericIdentifiers(a[key], b[key]);
    if (compared !== 0) return compared;
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;

  const length = Math.min(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftId = a.prerelease[index];
    const rightId = b.prerelease[index];
    const leftNumeric = /^\d+$/.test(leftId);
    const rightNumeric = /^\d+$/.test(rightId);
    if (leftNumeric && rightNumeric) {
      const compared = compareNumericIdentifiers(leftId, rightId);
      if (compared !== 0) return compared;
      continue;
    }
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    if (leftId !== rightId) return leftId < rightId ? -1 : 1;
  }
  if (a.prerelease.length === b.prerelease.length) return 0;
  return a.prerelease.length < b.prerelease.length ? -1 : 1;
}

/** stable 版本：合法 semver 且没有 prerelease 标识；build metadata 不影响稳定性。 */
export function isStableSemver(value) {
  const parsed = parseSemver(value);
  return parsed !== null && parsed.prerelease.length === 0;
}

function maybeVersion(value) {
  const parsed = parseSemver(typeof value === 'string' ? value : '');
  return parsed ? parsed.raw : null;
}

function assertStableVersion(value) {
  const version = maybeVersion(value);
  if (version === null || !isStableSemver(version)) {
    throw cloudError('unsupported_version', `不是 stable semver：${String(value).slice(0, MAX_VERSION_LENGTH)}`);
  }
  return version;
}

function isIsoTime(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function safeReason(value) {
  return typeof value === 'string' && REASON_RE.test(value) ? value : null;
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

function ageMs(iso, nowMs) {
  if (!isIsoTime(iso)) return null;
  return nowMs - Date.parse(iso);
}

function addIso(iso, ms) {
  if (!isIsoTime(iso)) return null;
  return new Date(Date.parse(iso) + ms).toISOString();
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export function emptyRuntimeUpdateState() {
  return {
    v: RUNTIME_UPDATE_VERSION,
    lastCheckedAt: null,
    lastAttemptAt: null,
    lastAttemptOk: null,
    latest: null,
    current: null,
    runningVersion: null,
    available: false,
    skippedVersion: null,
    promptedVersion: null,
    promptedAt: null,
    reason: null,
    failureReason: null,
    source: RUNTIME_UPDATE_SOURCE_URL,
    updatedAt: null,
  };
}

/**
 * 结构规范化（只保留白名单字段，避免 state 变成秘密/任意字段仓库）。
 * 读取时任何非法字段会让整份 state 回退为空；写入时严格抛错。
 */
export function normalizeRuntimeUpdateState(input, { now = new Date().toISOString() } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw cloudError('RUNTIME_UPDATE_STATE_INVALID', 'update-state 必须是对象');
  }
  if (input.v !== undefined && input.v !== RUNTIME_UPDATE_VERSION) {
    throw cloudError('RUNTIME_UPDATE_STATE_INVALID', `update-state 版本必须是 v${RUNTIME_UPDATE_VERSION}`);
  }
  const timeField = (name) => {
    const value = input[name];
    if (value === undefined || value === null) return null;
    if (!isIsoTime(value)) {
      throw cloudError('RUNTIME_UPDATE_STATE_INVALID', `update-state.${name} 必须是 ISO 时间或 null`);
    }
    return value;
  };
  const versionField = (name, { stable = false } = {}) => {
    const value = input[name];
    if (value === undefined || value === null) return null;
    const version = maybeVersion(value);
    if (version === null || (stable && !isStableSemver(version))) {
      throw cloudError('RUNTIME_UPDATE_STATE_INVALID', `update-state.${name} 不是合法版本`);
    }
    return version;
  };
  if (input.lastAttemptOk !== undefined && input.lastAttemptOk !== null && typeof input.lastAttemptOk !== 'boolean') {
    throw cloudError('RUNTIME_UPDATE_STATE_INVALID', 'update-state.lastAttemptOk 必须是布尔或 null');
  }
  if (input.available !== undefined && typeof input.available !== 'boolean') {
    throw cloudError('RUNTIME_UPDATE_STATE_INVALID', 'update-state.available 必须是布尔');
  }
  return {
    v: RUNTIME_UPDATE_VERSION,
    lastCheckedAt: timeField('lastCheckedAt'),
    lastAttemptAt: timeField('lastAttemptAt'),
    lastAttemptOk: typeof input.lastAttemptOk === 'boolean' ? input.lastAttemptOk : null,
    latest: versionField('latest', { stable: true }),
    current: versionField('current'),
    runningVersion: versionField('runningVersion'),
    available: input.available === true,
    skippedVersion: versionField('skippedVersion', { stable: true }),
    promptedVersion: versionField('promptedVersion', { stable: true }),
    promptedAt: timeField('promptedAt'),
    reason: safeReason(input.reason),
    failureReason: safeReason(input.failureReason),
    // 来源始终归一为固定官方 URL；文件里出现别的来源也不采用。
    source: RUNTIME_UPDATE_SOURCE_URL,
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

/** 读取 state（永不抛错）：missing/invalid 都回退为空 + warning，不阻塞入口。 */
export async function readRuntimeUpdateState(root) {
  const base = {
    state: emptyRuntimeUpdateState(),
    source: 'missing',
    warnings: [],
    path: null,
  };
  if (typeof root !== 'string' || root.length === 0) {
    return { ...base, source: 'unavailable', warnings: ['cloudRoot 不可用'] };
  }
  const path = runtimeUpdateStatePath(root);
  const raw = await readJsonFile(path);
  if (!raw.ok) {
    if (raw.missing) return { ...base, path };
    return {
      ...base,
      source: 'invalid',
      path,
      warnings: [`update-state 无法解析：${raw.error?.code ?? raw.error?.message ?? raw.error}`],
    };
  }
  try {
    return {
      state: normalizeRuntimeUpdateState(raw.value),
      source: 'main',
      warnings: [],
      path,
    };
  } catch (error) {
    return {
      ...base,
      source: 'invalid',
      path,
      warnings: [`update-state 无效：${error?.message ?? error}`],
    };
  }
}

/** 原子写 state：tmp → rename，0600；失败只抛给调用方，由 check 转成 warning。 */
export async function writeRuntimeUpdateState(root, input, { now = new Date().toISOString() } = {}) {
  if (typeof root !== 'string' || root.length === 0) {
    throw cloudError('CLOUD_UNAVAILABLE', '缺少 cloudRoot，无法写 update-state');
  }
  const state = normalizeRuntimeUpdateState({
    ...input,
    v: input?.v ?? RUNTIME_UPDATE_VERSION,
    source: RUNTIME_UPDATE_SOURCE_URL,
    updatedAt: input?.updatedAt ?? now,
  }, { now });
  const dir = runtimeUpdateDir(root);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = runtimeUpdateStatePath(root);
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

/** 只读公开摘要（所有字段本身即非敏感；保留旧 state 兼容）。 */
export function publicRuntimeUpdateState(state) {
  if (!state || typeof state !== 'object') return emptyRuntimeUpdateState();
  return {
    v: state.v ?? RUNTIME_UPDATE_VERSION,
    lastCheckedAt: state.lastCheckedAt ?? null,
    lastAttemptAt: state.lastAttemptAt ?? null,
    lastAttemptOk: state.lastAttemptOk ?? null,
    latest: state.latest ?? null,
    current: state.current ?? null,
    runningVersion: state.runningVersion ?? null,
    available: state.available === true,
    skippedVersion: state.skippedVersion ?? null,
    promptedVersion: state.promptedVersion ?? null,
    promptedAt: state.promptedAt ?? null,
    reason: state.reason ?? null,
    failureReason: state.failureReason ?? null,
    source: RUNTIME_UPDATE_SOURCE_URL,
    updatedAt: state.updatedAt ?? null,
  };
}

async function readLock(path) {
  try {
    return JSON.parse(await readFile(path, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * 跨入口检查互斥：wx 创建；持有者 PID 存活且未超时才 busy。
 * 有界重试（默认 3 次 × 20ms），绝不无限等待；陈旧/损坏锁直接回收。
 */
export async function acquireRuntimeUpdateLock(root, options = {}) {
  const {
    now = () => new Date(),
    pidAliveFn = pidAlive,
    staleMs = RUNTIME_UPDATE_LOCK_STALE_MS,
    attempts = RUNTIME_UPDATE_LOCK_ATTEMPTS,
    retryMs = RUNTIME_UPDATE_LOCK_RETRY_MS,
    token = randomUUID(),
  } = options;
  if (typeof root !== 'string' || root.length === 0) {
    return { ok: false, reason: 'lock_error', message: '缺少 cloudRoot，无法获取 update.lock', holder: null };
  }
  const path = runtimeUpdateLockPath(root);
  const nowMs = () => clockDate(now).getTime();
  try {
    await mkdir(runtimeUpdateDir(root), { recursive: true, mode: 0o700 });
  } catch (error) {
    return {
      ok: false,
      reason: 'lock_error',
      message: `无法创建 runtime 目录：${error?.code ?? error?.message ?? error}`,
      holder: null,
    };
  }

  let staleRecovered = false;
  let holder = null;
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
    const startedAt = new Date(nowMs()).toISOString();
    const payload = {
      v: 1,
      pid: process.pid,
      token,
      startedAt,
      command: 'check-update',
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
            const held = await readLock(path);
            if (!held || held.token !== token) return false;
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
          message: `无法创建 update.lock：${error?.code ?? error?.message ?? error}`,
          holder: null,
        };
      }
    }

    const held = await readLock(path);
    const holderPid = Number(held?.pid);
    const heldAt = Date.parse(held?.startedAt ?? '');
    const holderAge = Number.isFinite(heldAt) ? Math.max(0, nowMs() - heldAt) : null;
    const alive = Number.isInteger(holderPid) && holderPid > 0
      ? pidAliveFn(holderPid) !== false
      : false;
    holder = {
      pid: Number.isInteger(holderPid) && holderPid > 0 ? holderPid : null,
      startedAt: isIsoTime(held?.startedAt) ? held.startedAt : null,
      ageMs: holderAge,
    };
    const stale = holder.pid === null
      || !alive
      || (holderAge !== null && holderAge > staleMs);
    if (stale) {
      await rm(path, { force: true }).catch(() => undefined);
      staleRecovered = true;
      continue;
    }
    if (attempt < Math.max(1, attempts) - 1) {
      await delay(retryMs);
      continue;
    }
  }

  return {
    ok: false,
    reason: 'busy',
    path,
    holder,
    staleRecovered,
    message: holder?.pid
      ? `另一个入口正在检查 runtime 更新（pid ${holder.pid}）；本次不重复请求`
      : '另一个入口正在检查 runtime 更新；本次不重复请求',
  };
}

/** 5b2 的「跳过此版本」入口：只写 skippedVersion，不触发网络检查。 */
export async function setRuntimeUpdateSkippedVersion(root, version, { now = new Date().toISOString() } = {}) {
  if (typeof root !== 'string' || root.length === 0) {
    throw cloudError('CLOUD_UNAVAILABLE', '缺少 cloudRoot，无法写 update-state');
  }
  const skippedVersion = version === null || version === undefined ? null : assertStableVersion(version);
  const current = await readRuntimeUpdateState(root);
  // 跳过当前 latest 时同步把 available 置 false，让直接读 state 的另一入口也不会再提示；
  // 取消跳过（null）不动 available，交给下一次 check 重新计算。
  const skippingLatest = skippedVersion !== null
    && current.state.latest !== null
    && compareSemver(skippedVersion, current.state.latest) === 0;
  const state = await writeRuntimeUpdateState(root, {
    ...current.state,
    skippedVersion,
    // 「跳过」本身也是用户已看过该版本提示的显式动作；另一入口不应再自动弹同一版本。
    ...(skippedVersion === null
      ? {}
      : { promptedVersion: skippedVersion, promptedAt: now }),
    ...(skippingLatest ? { available: false, reason: 'skipped' } : {}),
    updatedAt: now,
  }, { now });
  return { state, source: current.source, warnings: current.warnings, path: runtimeUpdateStatePath(root) };
}

/**
 * 跨入口已提示去重：记录最近一次真正展示过更新提示的 latestVersion。
 * 只写非敏感版本/时间；不改变 available/skippedVersion，也不触发检查/安装。
 * 传 null 清除；损坏 state 在读取时已回退为空，写入原子覆盖。
 */
export async function setRuntimeUpdatePromptedVersion(root, version, { now = new Date().toISOString() } = {}) {
  if (typeof root !== 'string' || root.length === 0) {
    throw cloudError('CLOUD_UNAVAILABLE', '缺少 cloudRoot，无法写 update-state');
  }
  const promptedVersion = version === null || version === undefined ? null : assertStableVersion(version);
  const current = await readRuntimeUpdateState(root);
  const state = await writeRuntimeUpdateState(root, {
    ...current.state,
    promptedVersion,
    promptedAt: promptedVersion === null ? null : now,
    updatedAt: now,
  }, { now });
  return { state, source: current.source, warnings: current.warnings, path: runtimeUpdateStatePath(root) };
}

function mapFetchError(error, signal) {
  if (signal?.aborted === true || error?.name === 'AbortError' || error?.name === 'TimeoutError') {
    return 'timeout';
  }
  const code = error?.cause?.code ?? error?.code ?? '';
  if (['ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH'].includes(code)) return 'offline';
  if ([
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
    'UND_ERR_SOCKET',
  ].includes(code)) {
    return 'registry_unreachable';
  }
  return 'registry_unreachable';
}

/**
 * 固定 URL 的只读查询。返回 `{ok, reason, version?, httpStatus?}`，永不抛错。
 * 版本必须是 stable semver；prerelease 显式标记为 `prerelease_ignored`。
 */
async function fetchLatestRuntimeVersion({ fetchImpl, timeoutMs }) {
  if (typeof fetchImpl !== 'function') {
    return { ok: false, reason: 'registry_unreachable', httpStatus: null };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  timer.unref?.();
  try {
    let response;
    try {
      response = await fetchImpl(RUNTIME_UPDATE_SOURCE_URL, {
        method: 'GET',
        redirect: 'error',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
    } catch (error) {
      return { ok: false, reason: mapFetchError(error, controller.signal), httpStatus: null };
    }
    const status = Number(response?.status);
    if (!response || response.ok !== true) {
      return {
        ok: false,
        reason: 'http_error',
        httpStatus: Number.isInteger(status) && status > 0 ? status : null,
      };
    }
    let body;
    try {
      body = typeof response.json === 'function' ? await response.json() : null;
    } catch {
      if (controller.signal.aborted) {
        return { ok: false, reason: 'timeout', httpStatus: status || null };
      }
      return { ok: false, reason: 'invalid_response', httpStatus: status || null };
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { ok: false, reason: 'invalid_response', httpStatus: status || null };
    }
    if (body.name !== undefined && body.name !== RUNTIME_UPDATE_SOURCE.package) {
      return { ok: false, reason: 'invalid_response', httpStatus: status || null };
    }
    const version = typeof body.version === 'string' ? body.version.trim() : '';
    const parsed = parseSemver(version);
    if (!parsed) {
      return { ok: false, reason: 'invalid_response', httpStatus: status || null };
    }
    if (parsed.prerelease.length > 0) {
      return { ok: false, reason: 'prerelease_ignored', httpStatus: status || null };
    }
    return { ok: true, reason: null, version: parsed.raw, httpStatus: status || null };
  } finally {
    clearTimeout(timer);
  }
}

function decide(latest, currentVersion, skippedVersion) {
  if (!currentVersion) {
    return { decision: 'current_missing', available: false, skipped: false };
  }
  if (!latest) {
    return { decision: 'unknown', available: false, skipped: false };
  }
  if (skippedVersion !== null && compareSemver(skippedVersion, latest) === 0) {
    return { decision: 'skipped', available: false, skipped: true };
  }
  if (compareSemver(latest, currentVersion) > 0) {
    return { decision: 'update_available', available: true, skipped: false };
  }
  return { decision: 'up_to_date', available: false, skipped: false };
}

function messageForDecision(decision, latest, currentVersion) {
  if (decision === 'update_available') return `发现共享 runtime 新版本 ${latest}（当前 ${currentVersion}）；仅提示，不自动安装`;
  if (decision === 'skipped') return `版本 ${latest} 已被用户跳过`;
  if (decision === 'current_missing') return '未找到 runtime/current.json，无法判断更新；不会自动升级';
  return '共享 runtime 已是最新（stable 通道）';
}

/**
 * 检查共享 runtime 更新。
 *
 * 选项均为内部/测试注入，其中 `fetchImpl` 不是“源”覆盖：请求 URL 固定为
 * `RUNTIME_UPDATE_SOURCE_URL`。任何 `url/registry/source` 选项都会被忽略。
 *
 * 返回稳定 JSON；不抛错、不安装、不下载、不动 daemon/current/provider/service。
 */
export async function checkRuntimeUpdate(options = {}) {
  const {
    root: explicitRoot,
    env = process.env,
    userHome = homedir(),
    force = false,
    skipVersion: skipOption,
    ttlMs = RUNTIME_UPDATE_TTL_MS,
    failureTtlMs = RUNTIME_UPDATE_FAILURE_TTL_MS,
    timeoutMs = RUNTIME_UPDATE_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
    now = () => new Date(),
    pidAliveFn = pidAlive,
    lockStaleMs = RUNTIME_UPDATE_LOCK_STALE_MS,
    lockAttempts = RUNTIME_UPDATE_LOCK_ATTEMPTS,
    lockRetryMs = RUNTIME_UPDATE_LOCK_RETRY_MS,
    runningVersion: runningOption,
    detectRunningVersion = null,
    writeStateFn = writeRuntimeUpdateState,
    entry = null,
  } = options;

  const clock = () => clockDate(now);
  const startedAt = clock().toISOString();

  let root = explicitRoot;
  let context = null;
  if (typeof root !== 'string' || root.length === 0) {
    context = resolveCloudRoot({ env, userHome });
    if (!context.available) {
      return {
        ok: false,
        action: 'check-update',
        command: 'check-update',
        status: 'cloud_unavailable',
        reason: 'cloud_unavailable',
        message: `runtime 上下文不可用（${context.reason ?? 'cloud_unavailable'}）`,
        cloudReason: context.reason ?? 'cloud_unavailable',
        available: false,
        skipped: false,
        decision: null,
        cached: false,
        stale: true,
        throttled: false,
        busy: false,
        force: force === true,
        entry: typeof entry === 'string' ? entry : null,
        root: context.root ?? null,
        cloudRoot: context.root ?? null,
        source: RUNTIME_UPDATE_SOURCE,
        currentVersion: null,
        runningVersion: maybeVersion(runningOption),
        latestVersion: null,
        skippedVersion: null,
        currentSource: 'unavailable',
        currentUsable: false,
        lastCheckedAt: null,
        lastAttemptAt: null,
        lastAttemptOk: null,
        nextCheckAt: null,
        httpStatus: null,
        failureReason: null,
        lock: null,
        warnings: [],
        checkedAt: startedAt,
      };
    }
    root = context.root;
  }
  root = resolve(root);

  const currentState = await readRuntimeCurrent(root, { userHome });
  const stateRead = await readRuntimeUpdateState(root);
  const stored = stateRead.state;
  const warnings = [...stateRead.warnings, ...currentState.warnings];
  const currentVersion = currentState.current?.version ?? null;
  const explicitRunning = maybeVersion(runningOption);
  const skippedVersion = skipOption !== undefined
    ? maybeVersion(skipOption)
    : stored.skippedVersion;

  const makeResult = (fields = {}) => {
    const status = fields.status ?? null;
    const decision = fields.decision !== undefined ? fields.decision : status;
    const currentVersionValue = fields.currentVersion !== undefined ? fields.currentVersion : currentVersion;
    const currentSourceValue = fields.currentSource !== undefined ? fields.currentSource : currentState.source;
    const currentUsableValue = fields.currentUsable !== undefined ? fields.currentUsable : currentState.usable === true;
    const extraWarnings = Array.isArray(fields.warnings) ? fields.warnings : [];
    const latestVersionValue = fields.latestVersion !== undefined ? fields.latestVersion : null;
    const promptedVersionValue = fields.promptedVersion !== undefined
      ? fields.promptedVersion
      : stored.promptedVersion;
    const promptedValue = fields.prompted !== undefined
      ? fields.prompted === true
      : (latestVersionValue !== null && promptedVersionValue === latestVersionValue);
    return {
      ok: fields.ok !== undefined ? fields.ok === true : true,
      action: 'check-update',
      command: 'check-update',
      status,
      reason: fields.reason ?? null,
      message: fields.message ?? null,
      available: fields.available === true,
      skipped: fields.skipped === true,
      prompted: promptedValue,
      decision,
      cached: fields.cached === true,
      stale: fields.stale === true,
      throttled: status === 'throttled',
      busy: status === 'busy',
      force: force === true,
      entry: typeof entry === 'string' ? entry : null,
      root,
      cloudRoot: root,
      source: RUNTIME_UPDATE_SOURCE,
      currentVersion: currentVersionValue,
      runningVersion: fields.runningVersion !== undefined
        ? fields.runningVersion
        : (explicitRunning ?? stored.runningVersion),
      latestVersion: latestVersionValue,
      skippedVersion: fields.skippedVersion !== undefined ? fields.skippedVersion : skippedVersion,
      promptedVersion: promptedVersionValue,
      promptedAt: fields.promptedAt !== undefined ? fields.promptedAt : stored.promptedAt,
      currentSource: currentSourceValue,
      currentUsable: currentUsableValue,
      lastCheckedAt: fields.lastCheckedAt !== undefined ? fields.lastCheckedAt : stored.lastCheckedAt,
      lastAttemptAt: fields.lastAttemptAt !== undefined ? fields.lastAttemptAt : stored.lastAttemptAt,
      lastAttemptOk: fields.lastAttemptOk !== undefined ? fields.lastAttemptOk : stored.lastAttemptOk,
      nextCheckAt: fields.nextCheckAt !== undefined ? fields.nextCheckAt : null,
      httpStatus: fields.httpStatus ?? null,
      failureReason: fields.failureReason ?? null,
      lock: fields.lock ?? null,
      warnings: extraWarnings.length > 0 ? [...warnings, ...extraWarnings] : [...warnings],
      checkedAt: clock().toISOString(),
    };
  };

  const persist = async (state, at) => {
    try {
      await writeStateFn(root, state, { now: at });
      return null;
    } catch {
      return RUNTIME_UPDATE_STATE_WRITE_WARNING;
    }
  };

  const cachedResult = (state, { reason, stale, runningVersion }) => {
    const comparison = decide(state.latest, currentVersion, skippedVersion);
    return makeResult({
      status: 'throttled',
      reason,
      decision: comparison.decision,
      available: reason === null && comparison.available,
      skipped: comparison.skipped,
      cached: true,
      stale,
      currentVersion,
      currentSource: currentState.source,
      currentUsable: currentState.usable === true,
      runningVersion,
      latestVersion: state.latest,
      skippedVersion,
      lastCheckedAt: state.lastCheckedAt,
      lastAttemptAt: state.lastAttemptAt,
      lastAttemptOk: state.lastAttemptOk,
      nextCheckAt: addIso(state.lastCheckedAt, ttlMs),
      failureReason: state.failureReason,
      message: reason === 'failure_backoff'
        ? `更新检查处于失败防抖（${state.failureReason ?? 'unknown'}）；本次不重复请求`
        : messageForDecision(comparison.decision, state.latest, currentVersion),
    });
  };

  const nowMs = clock().getTime();
  const successAge = ageMs(stored.lastCheckedAt, nowMs);
  const attemptAge = ageMs(stored.lastAttemptAt, nowMs);
  const successFresh = successAge !== null && successAge < ttlMs;
  const failureBackoff = !force
    && stored.lastAttemptOk === false
    && attemptAge !== null
    && attemptAge < failureTtlMs;

  if (!force) {
    if (failureBackoff) {
      return makeResult({
        status: 'throttled',
        reason: 'failure_backoff',
        decision: null,
        available: false,
        cached: true,
        stale: true,
        latestVersion: stored.latest,
        runningVersion: explicitRunning ?? stored.runningVersion,
        lastCheckedAt: stored.lastCheckedAt,
        lastAttemptAt: stored.lastAttemptAt,
        lastAttemptOk: false,
        failureReason: stored.failureReason,
        nextCheckAt: addIso(stored.lastAttemptAt, failureTtlMs),
        message: `更新检查处于失败防抖（${stored.failureReason ?? 'unknown'}）；本次不重复请求`,
      });
    }
    if (successFresh) {
      return cachedResult(stored, {
        reason: null,
        stale: false,
        runningVersion: explicitRunning ?? stored.runningVersion,
      });
    }
  }

  const lock = await acquireRuntimeUpdateLock(root, {
    now,
    pidAliveFn,
    staleMs: lockStaleMs,
    attempts: lockAttempts,
    retryMs: lockRetryMs,
  });
  if (!lock.ok && lock.reason === 'busy') {
    return makeResult({
      status: 'busy',
      reason: 'busy',
      decision: null,
      available: false,
      cached: stored.lastCheckedAt !== null,
      stale: !successFresh,
      latestVersion: stored.latest,
      runningVersion: explicitRunning ?? stored.runningVersion,
      lastCheckedAt: stored.lastCheckedAt,
      lastAttemptAt: stored.lastAttemptAt,
      lastAttemptOk: stored.lastAttemptOk,
      failureReason: stored.failureReason,
      lock: lock.holder ?? null,
      nextCheckAt: addIso(stored.lastAttemptAt, failureTtlMs),
      message: lock.message ?? '另一个入口正在检查 runtime 更新；本次不重复请求',
    });
  }
  if (!lock.ok) {
    return makeResult({
      ok: false,
      status: 'lock_error',
      reason: 'lock_error',
      decision: null,
      cached: false,
      stale: true,
      latestVersion: stored.latest,
      runningVersion: explicitRunning ?? stored.runningVersion,
      failureReason: 'lock_error',
      warnings: ['update_lock_unavailable'],
      message: lock.message ?? '无法获取 update.lock',
    });
  }

  try {
    // 拿到锁后重读：另一个入口可能刚完成检查并写入了新 state/current。
    const [lockedState, lockedCurrent] = await Promise.all([
      readRuntimeUpdateState(root),
      readRuntimeCurrent(root, { userHome }),
    ]);
    const currentNow = lockedCurrent.current?.version ?? null;
    if (!force) {
      const lockedNowMs = clock().getTime();
      const lockedAttemptAge = ageMs(lockedState.state.lastAttemptAt, lockedNowMs);
      if (lockedState.state.lastAttemptOk === false
        && lockedAttemptAge !== null
        && lockedAttemptAge < failureTtlMs) {
        return makeResult({
          status: 'throttled',
          reason: 'failure_backoff',
          decision: null,
          available: false,
          cached: true,
          stale: true,
          currentVersion: currentNow,
          currentSource: lockedCurrent.source,
          currentUsable: lockedCurrent.usable === true,
          latestVersion: lockedState.state.latest,
          runningVersion: explicitRunning ?? lockedState.state.runningVersion,
          lastCheckedAt: lockedState.state.lastCheckedAt,
          lastAttemptAt: lockedState.state.lastAttemptAt,
          lastAttemptOk: false,
          failureReason: lockedState.state.failureReason,
          nextCheckAt: addIso(lockedState.state.lastAttemptAt, failureTtlMs),
          message: `更新检查处于失败防抖（${lockedState.state.failureReason ?? 'unknown'}）；本次不重复请求`,
        });
      }
      const lockedSuccessAge = ageMs(lockedState.state.lastCheckedAt, lockedNowMs);
      if (lockedSuccessAge !== null && lockedSuccessAge < ttlMs) {
        const comparison = decide(lockedState.state.latest, currentNow, skippedVersion);
        return makeResult({
          status: 'throttled',
          reason: null,
          decision: comparison.decision,
          available: comparison.available,
          skipped: comparison.skipped,
          cached: true,
          stale: false,
          currentVersion: currentNow,
          currentSource: lockedCurrent.source,
          currentUsable: lockedCurrent.usable === true,
          latestVersion: lockedState.state.latest,
          runningVersion: explicitRunning ?? lockedState.state.runningVersion,
          lastCheckedAt: lockedState.state.lastCheckedAt,
          lastAttemptAt: lockedState.state.lastAttemptAt,
          lastAttemptOk: lockedState.state.lastAttemptOk,
          nextCheckAt: addIso(lockedState.state.lastCheckedAt, ttlMs),
          message: messageForDecision(comparison.decision, lockedState.state.latest, currentNow),
        });
      }
    }

    let detectedRunning = null;
    if (explicitRunning === null && typeof detectRunningVersion === 'function') {
      try {
        detectedRunning = maybeVersion(await detectRunningVersion({ root, env, userHome }));
      } catch {
        detectedRunning = null;
      }
    }
    const runningVersion = explicitRunning ?? detectedRunning ?? lockedState.state.runningVersion ?? null;

    const fetched = await fetchLatestRuntimeVersion({ fetchImpl, timeoutMs });
    const attemptAt = clock().toISOString();

    if (!fetched.ok) {
      const failureReason = fetched.reason;
      const stateWriteWarning = await persist({
        ...lockedState.state,
        lastAttemptAt: attemptAt,
        lastAttemptOk: false,
        failureReason,
        reason: failureReason,
        current: currentNow,
        runningVersion,
        updatedAt: attemptAt,
      }, attemptAt);
      return makeResult({
        ok: false,
        status: failureReason,
        reason: failureReason,
        decision: null,
        available: false,
        cached: false,
        stale: true,
        currentVersion: currentNow,
        currentSource: lockedCurrent.source,
        currentUsable: lockedCurrent.usable === true,
        latestVersion: lockedState.state.latest,
        runningVersion,
        lastCheckedAt: lockedState.state.lastCheckedAt,
        lastAttemptAt: attemptAt,
        lastAttemptOk: false,
        failureReason,
        httpStatus: fetched.httpStatus ?? null,
        nextCheckAt: addIso(attemptAt, failureTtlMs),
        warnings: stateWriteWarning ? [stateWriteWarning] : [],
        message: FETCH_FAILURE_MESSAGES[failureReason] ?? '更新检查失败；本次跳过',
      });
    }

    const latest = fetched.version;
    const comparison = decide(latest, currentNow, skippedVersion);
    const stateWriteWarning = await persist({
      ...lockedState.state,
      lastCheckedAt: attemptAt,
      lastAttemptAt: attemptAt,
      lastAttemptOk: true,
      failureReason: null,
      latest,
      current: currentNow,
      runningVersion,
      available: comparison.available,
      skippedVersion: skippedVersion ?? null,
      reason: comparison.decision === 'skipped' || comparison.decision === 'current_missing'
        ? comparison.decision
        : null,
      updatedAt: attemptAt,
    }, attemptAt);

    return makeResult({
      ok: true,
      status: comparison.decision,
      reason: comparison.decision === 'skipped' || comparison.decision === 'current_missing'
        ? comparison.decision
        : null,
      decision: comparison.decision,
      available: comparison.available,
      skipped: comparison.skipped,
      cached: false,
      stale: false,
      currentVersion: currentNow,
      currentSource: lockedCurrent.source,
      currentUsable: lockedCurrent.usable === true,
      latestVersion: latest,
      runningVersion,
      skippedVersion,
      lastCheckedAt: attemptAt,
      lastAttemptAt: attemptAt,
      lastAttemptOk: true,
      failureReason: null,
      httpStatus: fetched.httpStatus ?? null,
      nextCheckAt: addIso(attemptAt, ttlMs),
      warnings: stateWriteWarning ? [stateWriteWarning] : [],
      message: messageForDecision(comparison.decision, latest, currentNow),
    });
  } catch (error) {
    return makeResult({
      ok: false,
      status: 'unexpected_error',
      reason: 'unexpected_error',
      decision: null,
      available: false,
      cached: false,
      stale: true,
      latestVersion: stored.latest,
      runningVersion: explicitRunning ?? stored.runningVersion,
      failureReason: 'unexpected_error',
      warnings: [`更新检查异常：${error?.code ?? error?.message ?? error}`],
      message: '更新检查异常；本次跳过，不阻塞入口',
    });
  } finally {
    await lock.release?.();
  }
}

/** CLI 退出码：可消费答复（含 throttled/busy/current_missing）为 0，失败为 2。 */
export function runtimeUpdateExitCode(result) {
  return result?.ok === true ? 0 : 2;
}
