// Memory Runtime sidecar 生命周期适配（MCP daemon 侧）。
//
// 边界（contract v2 §2.3 / §9.3，sidecar §5）：
// - 只做进程 spawn/stop/restart、discovery 读取、health HTTP；
// - 不 import `@mebular/memory-runtime` 的抽取/召回/模型/存储实现；
// - 轻量模式（memoryRuntime.enabled=false）不创建目录/token/进程/端口；
// - 自动启动失败不阻塞 MCP；状态以 failed/degraded 明确呈现；
// - 一个 home/profile 一个实例：已有健康 sidecar attach，不重复启动；
//   profile/home 不匹配时拒绝接管。
//
// 状态文件：`<home>/memory-runtime.json`（sidecar discovery）、
// `<home>/memory-runtime/start.lock`（sidecar 启动锁）。
// 本模块不读取/返回 host token 或 capability token 明文。

import { spawn as defaultSpawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { statSync } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_VERSION } from './version.mjs';

export const MEMORY_RUNTIME_DISCOVERY_FILE = 'memory-runtime.json';
export const MEMORY_RUNTIME_DATA_DIR = 'memory-runtime';
export const MEMORY_RUNTIME_START_LOCK_FILE = 'start.lock';
export const MEMORY_RUNTIME_TOKEN_FILE = 'host-token';
export const MEMORY_RUNTIME_CAPABILITY_TOKEN_FILE = 'capability-token';
export const MEMORY_RUNTIME_DEFAULT_PORT = 7341;
export const MEMORY_RUNTIME_DEFAULT_START_TIMEOUT_MS = 5000;
export const MEMORY_RUNTIME_HEALTH_TIMEOUT_MS = 200;
export const MEMORY_RUNTIME_HEALTH_CHECK_MS = 5000;
export const MEMORY_RUNTIME_RESTART_WINDOW_MS = 5 * 60 * 1000;
export const MEMORY_RUNTIME_MAX_RESTARTS = 3;
export const MEMORY_RUNTIME_RESTART_BACKOFF_MS = 500;
export const MEMORY_RUNTIME_RESTART_BACKOFF_MAX_MS = 30_000;
export const MEMORY_RUNTIME_RESTART_COOLDOWN_MS = 5 * 60 * 1000;
export const MEMORY_RUNTIME_BIN = 'mebular-memory-runtime';

const SIDECAR_KIND = 'mebular-memory-runtime';
const CAPABILITY_API_VERSION = 1;

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, Math.max(0, ms)));

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringOrNull(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export function resolveMemoryRuntimeHome({ home, env = process.env } = {}) {
  const raw = typeof home === 'string' && home.length > 0
    ? home
    : (typeof env?.MEBULAR_HOME === 'string' && env.MEBULAR_HOME.trim().length > 0
      ? env.MEBULAR_HOME
      : join(homedir(), '.mebular'));
  return resolve(raw);
}

export function resolveMemoryRuntimePaths({ home, env = process.env } = {}) {
  const resolvedHome = resolveMemoryRuntimeHome({ home, env });
  const override = typeof env?.MEBULAR_MEMORY_RUNTIME_HOME === 'string'
    && env.MEBULAR_MEMORY_RUNTIME_HOME.trim().length > 0
    ? env.MEBULAR_MEMORY_RUNTIME_HOME
    : null;
  const dataDir = override ? resolve(override) : join(resolvedHome, MEMORY_RUNTIME_DATA_DIR);
  return {
    home: resolvedHome,
    dataDir,
    discoveryPath: join(resolvedHome, MEMORY_RUNTIME_DISCOVERY_FILE),
    lockPath: join(dataDir, MEMORY_RUNTIME_START_LOCK_FILE),
    hostTokenPath: join(dataDir, MEMORY_RUNTIME_TOKEN_FILE),
    capabilityTokenPath: join(dataDir, MEMORY_RUNTIME_CAPABILITY_TOKEN_FILE),
  };
}

async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, 'utf-8'));
  } catch {
    return fallback;
  }
}

function executableExists(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function bundledBinCandidates() {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return [
    join(moduleDir, '..', '..', 'memory-runtime', 'bin', 'mebular-memory-runtime.mjs'),
    join(moduleDir, '..', 'node_modules', '@mebular', 'memory-runtime', 'bin', 'mebular-memory-runtime.mjs'),
    join(moduleDir, '..', '..', '..', '@mebular', 'memory-runtime', 'bin', 'mebular-memory-runtime.mjs'),
  ].map((entry) => resolve(entry));
}

function findOnPath(name, env) {
  const pathValue = typeof env?.PATH === 'string' ? env.PATH : process.env.PATH;
  if (typeof pathValue !== 'string' || pathValue.length === 0) return null;
  const names = process.platform === 'win32' ? [`${name}.cmd`, `${name}.exe`, name] : [name];
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    for (const candidate of names) {
      const full = join(dir, candidate);
      if (executableExists(full)) return full;
    }
  }
  return null;
}

/**
 * 解析 sidecar 可执行文件。
 *
 * 优先级：`memoryRuntime.command` > `MEBULAR_MEMORY_RUNTIME_BIN` > 包内 bin > PATH。
 * 显式配置/环境变量指向不存在文件时直接失败，不静默回退。
 */
export function resolveMemoryRuntimeCommand({ config, env = process.env } = {}) {
  const configured = stringOrNull(config?.memoryRuntime?.command);
  if (configured) {
    const command = resolve(configured);
    return executableExists(command)
      ? { ok: true, command, source: 'config' }
      : { ok: false, command, source: 'config', reason: 'not_installed' };
  }

  const fromEnv = stringOrNull(env?.MEBULAR_MEMORY_RUNTIME_BIN);
  if (fromEnv) {
    const command = resolve(fromEnv);
    return executableExists(command)
      ? { ok: true, command, source: 'env' }
      : { ok: false, command, source: 'env', reason: 'not_installed' };
  }

  for (const candidate of bundledBinCandidates()) {
    if (executableExists(candidate)) {
      return { ok: true, command: candidate, source: 'bundled' };
    }
  }

  const onPath = findOnPath(MEMORY_RUNTIME_BIN, env);
  if (onPath) return { ok: true, command: onPath, source: 'path' };

  return { ok: false, command: null, source: 'missing', reason: 'not_installed' };
}

function commandSpec(command) {
  if (/\.(?:mjs|cjs|js)$/i.test(command)) {
    return { execPath: process.execPath, args: [command] };
  }
  if (process.platform === 'win32' && /\.cmd$/i.test(command)) {
    return { execPath: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', command] };
  }
  return { execPath: command, args: [] };
}

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(value ?? '').trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function compareVersion(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

function mcpVersionCompatible(version, minVersion, maxVersion) {
  const parsed = parseVersion(version);
  const min = parseVersion(minVersion);
  if (!parsed || !min) return false;
  if (compareVersion(parsed, min) < 0) return false;
  const wildcard = /^(\d+)\.(\d+)\.x$/.exec(String(maxVersion ?? '').trim());
  if (wildcard) {
    return parsed.major === Number(wildcard[1]) && parsed.minor <= Number(wildcard[2]);
  }
  const max = parseVersion(maxVersion);
  return max ? compareVersion(parsed, max) <= 0 : false;
}

function discoveryProfileId(discovery) {
  return stringOrNull(discovery?.profileId);
}

function discoveryCloudId(discovery) {
  return stringOrNull(discovery?.cloudId);
}

function publicError(code, message) {
  return code ? { code, message } : null;
}

function makeDisabledStatus({ enabled = false, reason = 'disabled' } = {}) {
  return {
    enabled,
    state: 'stopped',
    available: false,
    degraded: false,
    managed: false,
    attached: false,
    pid: null,
    url: null,
    healthUrl: null,
    runtimeVersion: null,
    apiVersion: null,
    capabilityApiVersion: null,
    commandSource: null,
    installed: enabled ? null : false,
    startedAt: null,
    lastOkAt: null,
    restarts: 0,
    reason,
    error: null,
    lock: null,
  };
}

export function disabledMemoryRuntimeStatus() {
  return makeDisabledStatus();
}

function isSidecarDiscovery(value) {
  return isObject(value)
    && value.schema === 1
    && value.kind === SIDECAR_KIND
    && Number.isInteger(value.pid)
    && value.pid > 0
    && typeof value.host === 'string'
    && Number.isInteger(value.port)
    && typeof value.url === 'string'
    && typeof value.healthUrl === 'string'
    && typeof value.tokenFile === 'string'
    && typeof value.updatedAt === 'number';
}

async function readDiscovery(path) {
  const value = await readJson(path, null);
  return isSidecarDiscovery(value) ? value : null;
}

async function readLock(path) {
  const value = await readJson(path, null);
  if (!isObject(value) || !Number.isInteger(value.pid) || value.pid <= 0) return null;
  return {
    pid: value.pid,
    port: Number.isInteger(value.port) ? value.port : null,
    startedAt: typeof value.startedAt === 'number' ? value.startedAt : 0,
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0,
    cloudId: stringOrNull(value.cloudId),
    profileId: stringOrNull(value.profileId),
    command: typeof value.command === 'string' ? value.command : 'serve',
  };
}

function redact(text, secrets) {
  let out = String(text ?? '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length > 0) out = out.split(secret).join('[redacted]');
  }
  return out.slice(-1000);
}

const PROXY_SECRET_KEYS = new Set([
  'authorization',
  'cookie',
  'token',
  'tokenfile',
  'hosttoken',
  'host_token',
  'capabilitytoken',
  'capability_token',
  'password',
  'secret',
]);

/**
 * 管理面代理只返回 sidecar 的公开视图：递归去掉令牌类字段，并把已知密钥从字符串里抹掉。
 * sidecar 本身不应返回这些字段；这里多做一层，避免未来回归把 host token 带到浏览器。
 */
function scrubProxyValue(value, secrets) {
  if (Array.isArray(value)) return value.map((entry) => scrubProxyValue(entry, secrets));
  if (isObject(value)) {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      if (PROXY_SECRET_KEYS.has(String(key).toLowerCase())) continue;
      out[key] = scrubProxyValue(entry, secrets);
    }
    return out;
  }
  if (typeof value === 'string') {
    let text = value;
    for (const secret of secrets) {
      if (typeof secret === 'string' && secret.length > 0) text = text.split(secret).join('[redacted]');
    }
    return text;
  }
  return value;
}

function proxyErrorMessage(body, fallback) {
  const message = body?.error?.message ?? body?.message;
  return typeof message === 'string' && message.length > 0 ? message : fallback;
}

/**
 * Memory Runtime sidecar supervisor。
 *
 * 仅管理当前 `<home>` 的 sidecar；不启动 MCP daemon、不读写图、不 import sidecar 业务。
 */
export class MemoryRuntimeSupervisor {
  constructor({
    home,
    config = () => ({}),
    env = process.env,
    profileId = () => null,
    cloudId = () => null,
    mcpUrl = () => null,
    getCapabilityToken = null,
    command = null,
    spawnImpl = defaultSpawn,
    fetchImpl = globalThis.fetch,
    now = Date.now,
    startTimeoutMs = null,
    healthTimeoutMs = MEMORY_RUNTIME_HEALTH_TIMEOUT_MS,
    healthCheckIntervalMs = MEMORY_RUNTIME_HEALTH_CHECK_MS,
    healthPollMs = 100,
    restartWindowMs = MEMORY_RUNTIME_RESTART_WINDOW_MS,
    maxRestartsInWindow = MEMORY_RUNTIME_MAX_RESTARTS,
    restartBackoffMs = MEMORY_RUNTIME_RESTART_BACKOFF_MS,
    restartBackoffMaxMs = MEMORY_RUNTIME_RESTART_BACKOFF_MAX_MS,
    restartCooldownMs = MEMORY_RUNTIME_RESTART_COOLDOWN_MS,
    restartOnFailure = true,
  } = {}) {
    this.home = resolveMemoryRuntimeHome({ home, env });
    this.env = env ?? process.env;
    this.paths = resolveMemoryRuntimePaths({ home: this.home, env: this.env });
    this.getConfig = typeof config === 'function' ? config : () => config;
    this.getProfileId = typeof profileId === 'function' ? profileId : () => profileId;
    this.getCloudId = typeof cloudId === 'function' ? cloudId : () => cloudId;
    this.getMcpUrl = typeof mcpUrl === 'function' ? mcpUrl : () => mcpUrl;
    this.getCapabilityToken = getCapabilityToken;
    this.explicitCommand = stringOrNull(command);
    this.spawnImpl = spawnImpl;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.startTimeoutMs = startTimeoutMs
      ?? (typeof this.getConfig()?.memoryRuntime?.startTimeoutMs === 'number'
        ? this.getConfig().memoryRuntime.startTimeoutMs
        : MEMORY_RUNTIME_DEFAULT_START_TIMEOUT_MS);
    this.healthTimeoutMs = healthTimeoutMs;
    this.healthCheckIntervalMs = healthCheckIntervalMs;
    this.healthPollMs = healthPollMs;
    this.restartWindowMs = restartWindowMs;
    this.maxRestartsInWindow = Math.max(0, maxRestartsInWindow);
    this.restartBackoffMs = restartBackoffMs;
    this.restartBackoffMaxMs = restartBackoffMaxMs;
    this.restartCooldownMs = restartCooldownMs;
    this.restartOnFailure = restartOnFailure;

    this.child = null;
    this.childToken = null;
    this.childSecrets = [];
    this.startPromise = null;
    this.restartTimer = null;
    this.cooldownTimer = null;
    this.watchdogTimer = null;
    this.healthFailures = 0;
    this.crashTimes = [];
    this.restarts = 0;
    this.stopping = false;
    this.disposed = false;
    this.readySeen = false;
    this.manualStart = false;
    this.commandSource = null;
    this.installed = null;
    this.lockView = null;
    this.statusState = makeDisabledStatus({
      enabled: this.isEnabled(),
      reason: this.isEnabled() ? null : 'disabled',
    });
  }

  isEnabled() {
    try {
      return this.getConfig()?.memoryRuntime?.enabled === true;
    } catch {
      return false;
    }
  }

  configuredStartTimeout() {
    const configured = this.getConfig()?.memoryRuntime?.startTimeoutMs;
    return Number.isInteger(configured) && configured >= 100
      ? configured
      : Math.max(100, this.startTimeoutMs);
  }

  snapshot() {
    return JSON.parse(JSON.stringify(this.statusState));
  }

  #profileId() {
    try {
      return stringOrNull(this.getProfileId());
    } catch {
      return null;
    }
  }

  #cloudId() {
    try {
      return stringOrNull(this.getCloudId());
    } catch {
      return null;
    }
  }

  #setState(patch) {
    const nextState = patch.state ?? this.statusState.state;
    this.statusState = {
      ...this.statusState,
      ...patch,
      enabled: this.isEnabled(),
      available: nextState === 'ready' || nextState === 'degraded',
    };
    return this.snapshot();
  }

  #degradedError(code = 'sidecar_degraded') {
    return publicError(code, 'Memory Runtime sidecar 处于降级状态');
  }

  #profileMismatch(discovery) {
    const expectedProfile = this.#profileId();
    const actualProfile = discoveryProfileId(discovery);
    if (expectedProfile && actualProfile && expectedProfile !== actualProfile) return true;
    const expectedCloud = this.#cloudId();
    const actualCloud = discoveryCloudId(discovery);
    return Boolean(expectedCloud && actualCloud && expectedCloud !== actualCloud);
  }

  #homeMismatch(discovery) {
    if (typeof discovery?.tokenFile !== 'string' || discovery.tokenFile.length === 0) return false;
    return resolve(dirname(discovery.tokenFile)) !== this.paths.dataDir;
  }

  #versionMismatch(discovery) {
    if (discovery?.capabilityApiVersion !== CAPABILITY_API_VERSION) return true;
    return !mcpVersionCompatible(
      APP_VERSION,
      discovery.minMcpVersion ?? '0.3.0',
      discovery.maxMcpVersion ?? '0.3.x',
    );
  }

  async #fetchHealth(discovery) {
    if (!this.fetchImpl || typeof discovery?.healthUrl !== 'string') return { ok: false };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, this.healthTimeoutMs));
    timer.unref?.();
    try {
      const response = await this.fetchImpl(discovery.healthUrl, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response || response.ok !== true) return { ok: false };
      const body = await response.json().catch(() => ({}));
      return {
        ok: body?.ok !== false && body?.ready !== false,
        degraded: body?.degraded === true || body?.state === 'degraded',
        body,
      };
    } catch {
      return { ok: false };
    } finally {
      clearTimeout(timer);
    }
  }

  async #readLockView() {
    const lock = await readLock(this.paths.lockPath);
    this.lockView = lock === null
      ? null
      : {
        pid: lock.pid,
        port: lock.port,
        cloudId: lock.cloudId,
        profileId: lock.profileId,
        stale: !pidAlive(lock.pid),
      };
    return lock;
  }

  /**
   * 读取 discovery/health 并更新快照。
   * @returns {Promise<boolean>} 是否可接流量（ready 或 degraded）。
   */
  async #refreshDiscovery({ fetchHealth = true } = {}) {
    await this.#readLockView();
    const discovery = await readDiscovery(this.paths.discoveryPath);
    if (!discovery) {
      if (this.child && this.child.exitCode === null) {
        const state = this.readySeen ? 'degraded' : 'starting';
        this.#setState({
          state,
          degraded: this.readySeen,
          managed: true,
          attached: false,
          pid: this.child.pid ?? null,
          url: null,
          healthUrl: null,
          restarts: this.restarts,
          error: this.readySeen ? publicError('discovery_missing', 'sidecar discovery 缺失') : null,
          lock: this.lockView,
        });
        return false;
      }
      if (this.statusState.state !== 'failed') {
        const startingByLock = this.isEnabled()
          && this.lockView !== null
          && this.lockView.stale !== true
          && this.env?.MEBULAR_MEMORY_RUNTIME_DISABLE !== '1';
        this.#setState({
          state: startingByLock ? 'starting' : 'stopped',
          degraded: false,
          managed: false,
          attached: false,
          pid: this.lockView?.pid ?? null,
          url: null,
          healthUrl: null,
          restarts: this.restarts,
          error: null,
          lock: this.lockView,
          reason: !this.isEnabled() || this.env?.MEBULAR_MEMORY_RUNTIME_DISABLE === '1'
            ? 'disabled'
            : this.statusState.reason ?? null,
        });
      } else {
        this.#setState({ restarts: this.restarts, lock: this.lockView });
      }
      return false;
    }

    if (!pidAlive(discovery.pid)) {
      await unlink(this.paths.discoveryPath).catch(() => undefined);
      this.#setState({
        state: 'stopped',
        degraded: false,
        managed: false,
        attached: false,
        pid: null,
        url: null,
        healthUrl: null,
        error: null,
        lock: this.lockView,
      });
      return false;
    }

    const managed = Boolean(this.child && this.child.pid === discovery.pid);
    if (this.#homeMismatch(discovery)) {
      this.#setState({
        state: 'failed',
        degraded: false,
        managed,
        attached: !managed,
        pid: discovery.pid,
        url: discovery.url,
        healthUrl: discovery.healthUrl,
        runtimeVersion: discovery.runtimeVersion ?? null,
        apiVersion: discovery.apiVersion ?? null,
        capabilityApiVersion: discovery.capabilityApiVersion ?? null,
        error: publicError('home_mismatch', '已有 sidecar 使用不同的数据目录：拒绝接管'),
        lock: this.lockView,
      });
      return false;
    }
    if (this.#profileMismatch(discovery)) {
      this.#setState({
        state: 'failed',
        degraded: false,
        managed,
        attached: !managed,
        pid: discovery.pid,
        url: discovery.url,
        healthUrl: discovery.healthUrl,
        runtimeVersion: discovery.runtimeVersion ?? null,
        apiVersion: discovery.apiVersion ?? null,
        capabilityApiVersion: discovery.capabilityApiVersion ?? null,
        error: publicError('profile_mismatch', '已有 sidecar 属于其他 profile/忆云：拒绝接管'),
        lock: this.lockView,
      });
      return false;
    }
    if (this.#versionMismatch(discovery)) {
      this.#setState({
        state: 'failed',
        degraded: false,
        managed,
        attached: !managed,
        pid: discovery.pid,
        url: discovery.url,
        healthUrl: discovery.healthUrl,
        runtimeVersion: discovery.runtimeVersion ?? null,
        apiVersion: discovery.apiVersion ?? null,
        capabilityApiVersion: discovery.capabilityApiVersion ?? null,
        error: publicError('version_incompatible', 'sidecar 版本与 MCP capability 不兼容'),
        lock: this.lockView,
      });
      return false;
    }

    const health = fetchHealth ? await this.#fetchHealth(discovery) : { ok: true };
    if (health.ok) {
      this.readySeen = true;
      const degraded = discovery.degraded === true || health.degraded === true;
      this.#setState({
        state: degraded ? 'degraded' : 'ready',
        degraded,
        managed,
        attached: !managed,
        pid: discovery.pid,
        url: discovery.url,
        healthUrl: discovery.healthUrl,
        runtimeVersion: discovery.runtimeVersion ?? null,
        apiVersion: discovery.apiVersion ?? null,
        capabilityApiVersion: discovery.capabilityApiVersion ?? null,
        startedAt: discovery.startedAt ?? null,
        lastOkAt: this.now(),
        restarts: this.restarts,
        reason: null,
        error: degraded ? this.#degradedError() : null,
        lock: this.lockView,
      });
      return true;
    }

    const starting = managed && !this.readySeen;
    this.#setState({
      state: starting ? 'starting' : 'degraded',
      degraded: !starting,
      managed,
      attached: !managed,
      pid: discovery.pid,
      url: discovery.url,
      healthUrl: discovery.healthUrl,
      runtimeVersion: discovery.runtimeVersion ?? null,
      apiVersion: discovery.apiVersion ?? null,
      capabilityApiVersion: discovery.capabilityApiVersion ?? null,
      startedAt: discovery.startedAt ?? null,
      restarts: this.restarts,
      error: starting ? null : publicError('health_check_failed', 'sidecar 健康检查失败'),
      lock: this.lockView,
    });
    return false;
  }

  async status() {
    if (!this.isEnabled() && !this.statusState.managed && !this.statusState.pid) {
      this.statusState = makeDisabledStatus({ enabled: false, reason: 'disabled' });
    }
    try {
      await this.#refreshDiscovery({ fetchHealth: true });
    } catch {
      this.#setState({ error: publicError('status_failed', '无法读取 sidecar 状态') });
    }
    return this.snapshot();
  }

  /**
   * 只读 sidecar `/status` 的最小视图：模式、版本、模型来源/降级。
   * 不返回 host token、keyRef、endpoint、模型路径或配置正文。
   */
  async readStatus() {
    const result = await this.#proxyHostApi('status');
    if (!result.available) {
      return {
        ok: !result.error,
        enabled: result.enabled,
        available: false,
        disabled: result.disabled === true,
        state: result.state,
        reason: result.reason ?? null,
        error: result.error ?? null,
        mode: null,
        runtimeVersion: null,
        degraded: result.state === 'degraded',
        model: null,
      };
    }
    const data = result.body?.data ?? result.body ?? {};
    const model = isObject(data.model)
      ? {
          configured: typeof data.model.configured === 'string' ? data.model.configured : null,
          active: typeof data.model.active === 'string' ? data.model.active : null,
          degraded: data.model.degraded === true,
          reason: typeof data.model.reason === 'string' ? data.model.reason : null,
          sources: Array.isArray(data.model.sources)
            ? data.model.sources.filter((source) => typeof source === 'string')
            : [],
        }
      : null;
    return {
      ok: result.ok !== false,
      enabled: true,
      available: true,
      disabled: false,
      state: result.state,
      reason: null,
      error: result.ok === false
        ? publicError(
            data?.error?.code ?? result.body?.error?.code ?? 'sidecar_request_failed',
            proxyErrorMessage(data, proxyErrorMessage(result.body, '读取记忆运行时状态失败')),
          )
        : null,
      mode: typeof data.mode === 'string' ? data.mode : null,
      runtimeVersion: typeof data.runtimeVersion === 'string' ? data.runtimeVersion : null,
      degraded: data.degraded === true || result.body?.degraded === true,
      model,
    };
  }

  /**
   * Console 只读代理：服务端读取 host token，浏览器只拿到脱敏后的 sidecar 视图。
   * 轻量模式/未就绪时返回明确状态，不启动进程、不创建 token。
   */
  async readTraces({ limit = 20 } = {}) {
    const requested = Number(limit);
    const safeLimit = Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested), 1), 100) : 20;
    const result = await this.#proxyHostApi(`traces?limit=${safeLimit}`);
    if (!result.available) {
      return {
        ok: !result.error,
        enabled: result.enabled,
        available: false,
        disabled: result.disabled === true,
        state: result.state,
        reason: result.reason ?? null,
        error: result.error ?? null,
        traces: [],
        total: 0,
        degraded: result.state === 'degraded',
        warnings: [],
      };
    }
    const data = result.body?.data ?? result.body ?? {};
    const traces = Array.isArray(data.traces) ? data.traces : [];
    if (!result.ok) {
      return {
        ok: false,
        enabled: true,
        available: true,
        disabled: false,
        state: result.state,
        error: publicError(
          data?.error?.code ?? result.body?.error?.code ?? 'sidecar_request_failed',
          proxyErrorMessage(data, proxyErrorMessage(result.body, '读取召回轨迹失败')),
        ),
        traces: [],
        total: 0,
        degraded: true,
        warnings: [],
      };
    }
    return {
      ok: true,
      enabled: true,
      available: true,
      disabled: false,
      state: result.state,
      degraded: data.degraded === true || result.body?.degraded === true,
      traces,
      total: Number.isInteger(data.total) ? data.total : traces.length,
      warnings: Array.isArray(result.body?.warnings) ? result.body.warnings : [],
    };
  }

  async readTrace(id) {
    const traceId = typeof id === 'string' ? id.trim() : '';
    if (!/^tr_[A-Za-z0-9._:-]{1,128}$/.test(traceId)) {
      return {
        ok: false,
        enabled: this.isEnabled(),
        available: false,
        disabled: !this.isEnabled(),
        state: this.statusState.state,
        trace: null,
        error: publicError('invalid_trace_id', 'trace id 格式非法'),
      };
    }
    const result = await this.#proxyHostApi(`traces/${encodeURIComponent(traceId)}`);
    if (!result.available) {
      return {
        ok: !result.error,
        enabled: result.enabled,
        available: false,
        disabled: result.disabled === true,
        state: result.state,
        reason: result.reason ?? null,
        error: result.error ?? null,
        trace: null,
      };
    }
    const data = result.body?.data ?? result.body ?? null;
    if (!result.ok || !data) {
      return {
        ok: false,
        enabled: true,
        available: true,
        disabled: false,
        state: result.state,
        trace: null,
        error: publicError(
          data?.error?.code ?? result.body?.error?.code ?? (result.statusCode === 404 ? 'trace_not_found' : 'sidecar_request_failed'),
          proxyErrorMessage(data, proxyErrorMessage(result.body, '读取召回轨迹详情失败')),
        ),
      };
    }
    return {
      ok: true,
      enabled: true,
      available: true,
      disabled: false,
      state: result.state,
      trace: data,
      degraded: result.body?.degraded === true,
    };
  }

  async submitRecallFeedback(traceId, feedback) {
    const id = typeof traceId === 'string' ? traceId.trim() : '';
    if (!/^tr_[A-Za-z0-9._:-]{1,128}$/.test(id)) {
      return { statusCode: 400, body: { ok: false, error: 'invalid_trace_id', message: 'trace id 格式非法' } };
    }
    if (!isObject(feedback) || typeof feedback.useful !== 'boolean') {
      return { statusCode: 400, body: { ok: false, error: 'invalid_feedback', message: 'feedback.useful 必须是布尔值' } };
    }
    const body = {
      useful: feedback.useful,
      ...(typeof feedback.reason === 'string' && feedback.reason.length > 0
        ? { reason: feedback.reason.slice(0, 200) }
        : {}),
    };
    const result = await this.#proxyHostApi(`recall/${encodeURIComponent(id)}/feedback`, { method: 'POST', body });
    if (!result.available) {
      return {
        statusCode: result.disabled === true ? 409 : 503,
        body: {
          ok: false,
          error: result.disabled === true ? 'memory_runtime_disabled' : 'sidecar_unavailable',
          enabled: result.enabled,
          state: result.state,
          message: result.disabled === true
            ? '记忆运行时未启用'
            : 'Memory Runtime sidecar 未就绪',
          ...(result.error ? { details: result.error } : {}),
        },
      };
    }
    const data = result.body?.data ?? result.body ?? null;
    if (!result.ok) {
      return {
        statusCode: result.statusCode ?? 502,
        body: {
          ok: false,
          error: data?.error?.code ?? result.body?.error?.code ?? 'feedback_failed',
          message: proxyErrorMessage(data, proxyErrorMessage(result.body, '召回反馈失败')),
        },
      };
    }
    return { statusCode: 200, body: result.body ?? { ok: true, data } };
  }

  async #resolveHostToken(discovery) {
    if (this.child && discovery?.pid === this.child.pid && typeof this.childToken === 'string') {
      return this.childToken;
    }
    const fromEnv = stringOrNull(this.env?.MEBULAR_MEMORY_RUNTIME_TOKEN);
    if (fromEnv) return fromEnv;
    if (typeof discovery?.tokenFile !== 'string' || discovery.tokenFile.length === 0) return null;
    // 只读当前 home 的 sidecar token；discovery 路径不匹配时拒绝读取。
    if (resolve(dirname(discovery.tokenFile)) !== this.paths.dataDir) return null;
    try {
      const token = (await readFile(discovery.tokenFile, 'utf-8')).trim();
      return token.length > 0 ? token : null;
    } catch {
      return null;
    }
  }

  async #proxyHostApi(pathname, { method = 'GET', body = null, timeoutMs = 2500 } = {}) {
    await this.status().catch(() => undefined);
    if (!this.isEnabled()) {
      return {
        enabled: false,
        available: false,
        disabled: true,
        state: 'stopped',
        reason: 'disabled',
        error: null,
      };
    }
    if (!['ready', 'degraded'].includes(this.statusState.state) || typeof this.statusState.url !== 'string') {
      return {
        enabled: true,
        available: false,
        disabled: false,
        state: this.statusState.state,
        reason: this.statusState.reason ?? null,
        error: this.statusState.error ?? publicError('sidecar_unavailable', 'Memory Runtime sidecar 未就绪'),
      };
    }
    const discovery = await readDiscovery(this.paths.discoveryPath);
    if (!discovery) {
      return {
        enabled: true,
        available: false,
        disabled: false,
        state: this.statusState.state,
        reason: null,
        error: publicError('discovery_missing', 'sidecar discovery 缺失'),
      };
    }
    const token = await this.#resolveHostToken(discovery);
    if (!token) {
      return {
        enabled: true,
        available: false,
        disabled: false,
        state: this.statusState.state,
        reason: null,
        error: publicError('host_token_missing', '无法读取 sidecar host token'),
      };
    }
    if (!this.fetchImpl) {
      return {
        enabled: true,
        available: false,
        disabled: false,
        state: this.statusState.state,
        reason: null,
        error: publicError('fetch_unavailable', '当前运行环境不支持 HTTP 代理'),
      };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
    timer.unref?.();
    try {
      const base = discovery.url.replace(/\/+$/, '');
      const url = new URL(`${base}/${String(pathname).replace(/^\/+/, '')}`);
      const headers = {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
      };
      const init = { method, headers, signal: controller.signal };
      if (body !== null && body !== undefined) {
        headers['content-type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      const response = await this.fetchImpl(url.toString(), init);
      const text = await response.text().catch(() => '');
      let parsed = null;
      try {
        parsed = text.length > 0 ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      const scrubbed = scrubProxyValue(parsed, [token, this.childToken]);
      return {
        enabled: true,
        available: true,
        disabled: false,
        state: this.statusState.state,
        statusCode: response.status,
        ok: response.ok === true,
        body: scrubbed,
        ...(parsed === null && text.length > 0 ? { message: redact(text, [token]) } : {}),
      };
    } catch (error) {
      return {
        enabled: true,
        available: false,
        disabled: false,
        state: this.statusState.state,
        reason: null,
        error: publicError(
          error?.name === 'AbortError' ? 'sidecar_timeout' : 'sidecar_unreachable',
          error?.name === 'AbortError' ? 'sidecar 请求超时' : '无法连接 Memory Runtime sidecar',
        ),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  #resolveCommand() {
    if (this.explicitCommand) {
      const command = resolve(this.explicitCommand);
      this.installed = executableExists(command);
      this.commandSource = 'explicit';
      return this.installed
        ? { ok: true, command, source: 'explicit' }
        : { ok: false, command, source: 'explicit', reason: 'not_installed' };
    }
    const resolved = resolveMemoryRuntimeCommand({ config: this.getConfig(), env: this.env });
    this.installed = resolved.ok === true;
    this.commandSource = resolved.source;
    return resolved;
  }

  async #resolveCapabilityToken() {
    if (typeof this.getCapabilityToken === 'function') {
      try {
        const value = await this.getCapabilityToken();
        const token = typeof value === 'string' ? value : value?.token;
        if (typeof token === 'string' && token.length > 0) return token;
      } catch {
        // fall through to env/file
      }
    }
    const fromEnv = stringOrNull(this.env?.MEBULAR_CAPABILITY_TOKEN);
    if (fromEnv) return fromEnv;
    const record = await readJson(this.paths.capabilityTokenPath, null);
    return typeof record?.token === 'string' && record.token.length > 0 ? record.token : null;
  }

  async #waitForDiscovery(deadline) {
    for (;;) {
      if (this.stopping || this.disposed) return false;
      const ready = await this.#refreshDiscovery({ fetchHealth: true });
      if (ready) return true;
      if (this.statusState.error && ['profile_mismatch', 'home_mismatch', 'version_incompatible'].includes(this.statusState.error.code)) {
        return false;
      }
      const lock = await readLock(this.paths.lockPath);
      if (!lock || !pidAlive(lock.pid)) {
        this.lockView = null;
        return false;
      }
      if (this.now() >= deadline) return false;
      await sleep(Math.min(this.healthPollMs, Math.max(1, deadline - this.now())));
    }
  }

  async #waitForReady(deadline, child) {
    while (this.child === child && child.exitCode === null) {
      if (this.stopping || this.disposed) return false;
      const ready = await this.#refreshDiscovery({ fetchHealth: true });
      if (ready && this.statusState.pid === child.pid) return true;
      if (this.statusState.error && ['profile_mismatch', 'home_mismatch', 'version_incompatible'].includes(this.statusState.error.code)) {
        return false;
      }
      if (this.now() >= deadline) return false;
      await sleep(Math.min(this.healthPollMs, Math.max(1, deadline - this.now())));
    }
    return false;
  }

  #clearRestartTimer() {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  #clearCooldownTimer() {
    if (this.cooldownTimer) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }
  }

  #stopWatchdog() {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  #startWatchdog() {
    this.#stopWatchdog();
    if (!this.healthCheckIntervalMs || this.healthCheckIntervalMs <= 0) return;
    this.watchdogTimer = setInterval(() => {
      if (this.disposed || this.stopping) return;
      void (async () => {
        const healthy = await this.#refreshDiscovery({ fetchHealth: true });
        if (healthy) {
          this.healthFailures = 0;
          return;
        }
        if (this.statusState.error?.code !== 'health_check_failed') return;
        this.healthFailures += 1;
        if (this.healthFailures < 3) return;
        this.healthFailures = 0;
        if (this.child && this.child.exitCode === null) {
          this.#setState({ error: publicError('health_check_failed', 'sidecar 连续健康检查失败') });
          this.#killChild('SIGTERM');
        } else {
          this.#setState({
            state: 'degraded',
            degraded: true,
            error: publicError('health_check_failed', 'sidecar 连续健康检查失败'),
          });
        }
      })().catch(() => undefined);
    }, this.healthCheckIntervalMs);
    this.watchdogTimer.unref?.();
  }

  #pruneCrashTimes() {
    const cutoff = this.now() - this.restartWindowMs;
    this.crashTimes = this.crashTimes.filter((at) => at >= cutoff);
  }

  #scheduleRestart() {
    this.#clearRestartTimer();
    if (this.disposed || this.stopping || this.manualStart) return;
    if (!this.restartOnFailure || this.maxRestartsInWindow <= 0) return;
    if (!this.isEnabled()) return;
    this.#pruneCrashTimes();
    if (this.crashTimes.length > this.maxRestartsInWindow) {
      this.#setState({
        state: 'failed',
        degraded: false,
        error: publicError('restart_limit', 'sidecar 崩溃次数超过上限：已暂停自动重启'),
      });
      this.#clearCooldownTimer();
      this.cooldownTimer = setTimeout(() => {
        this.crashTimes = [];
        this.restarts = 0;
        this.#clearCooldownTimer();
      }, Math.max(1000, this.restartCooldownMs));
      this.cooldownTimer.unref?.();
      return;
    }
    const exponent = Math.max(0, this.crashTimes.length - 1);
    const delay = Math.min(this.restartBackoffMs * (2 ** exponent), this.restartBackoffMaxMs);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.disposed || this.stopping || !this.isEnabled()) return;
      void this.#startOnce({ force: false, isRestart: true }).catch(() => undefined);
    }, Math.max(10, delay));
    this.restartTimer.unref?.();
  }

  #killChild(signal) {
    const child = this.child;
    if (!child || child.exitCode !== null) return false;
    try {
      child.kill(signal);
      return true;
    } catch {
      return false;
    }
  }

  async #waitChildExit(child, timeoutMs) {
    if (!child || child.exitCode !== null) return true;
    return new Promise((resolvePromise) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        child.removeListener?.('exit', finish);
        resolvePromise(child.exitCode !== null);
      };
      const timer = setTimeout(finish, Math.max(0, timeoutMs));
      timer.unref?.();
      child.once?.('exit', finish);
      if (child.exitCode !== null) finish();
    });
  }

  #onChildExit(child, code, signal) {
    if (this.child !== child) return;
    this.child = null;
    this.#stopWatchdog();
    if (this.stopping || this.disposed) {
      this.#setState({
        state: 'stopped',
        degraded: false,
        managed: false,
        attached: false,
        pid: null,
        url: null,
        healthUrl: null,
        error: null,
        lock: this.lockView,
      });
      return;
    }

    this.restarts += 1;
    this.crashTimes.push(this.now());
    this.#setState({
      state: 'failed',
      degraded: false,
      managed: false,
      attached: false,
      pid: null,
      url: null,
      healthUrl: null,
      restarts: this.restarts,
      error: publicError(
        'sidecar_crashed',
        `sidecar 已退出（${signal ?? code ?? 'unknown'}）`,
      ),
      lock: this.lockView,
    });
    this.#scheduleRestart();
  }

  async #spawnSidecar({ manual }) {
    const resolved = this.#resolveCommand();
    if (!resolved.ok) {
      this.#setState({
        state: 'not_installed',
        degraded: false,
        installed: false,
        commandSource: resolved.source,
        error: publicError(resolved.reason ?? 'not_installed', '未找到 mebular-memory-runtime 可执行文件'),
      });
      return false;
    }

    if (this.stopping || this.disposed) return false;
    const token = await this.#resolveCapabilityToken();
    if (this.stopping || this.disposed) return false;
    if (!token) {
      this.#setState({
        state: 'failed',
        degraded: false,
        installed: true,
        commandSource: resolved.source,
        error: publicError('capability_token_missing', '找不到 capability token：MCP 未启用或未启动 sidecar'),
      });
      return false;
    }

    const hostToken = stringOrNull(this.env?.MEBULAR_MEMORY_RUNTIME_TOKEN)
      ?? randomBytes(32).toString('base64url');
    this.childSecrets = [token, hostToken];
    const spec = commandSpec(resolved.command);
    const args = [
      ...spec.args,
      'serve',
      ...(manual ? [] : ['--parent-pid', String(process.pid)]),
    ];
    const env = {
      ...process.env,
      ...this.env,
      MEBULAR_HOME: this.paths.home,
      MEBULAR_MEMORY_RUNTIME_HOME: this.paths.dataDir,
      MEBULAR_CAPABILITY_TOKEN: token,
      MEBULAR_MEMORY_RUNTIME_TOKEN: hostToken,
      ...(stringOrNull(this.getMcpUrl()) ? { MEBULAR_MCP_URL: stringOrNull(this.getMcpUrl()) } : {}),
    };

    let child;
    try {
      child = this.spawnImpl(spec.execPath, args, {
        cwd: this.paths.home,
        env,
        detached: manual,
        windowsHide: true,
        stdio: manual ? 'ignore' : ['ignore', 'ignore', 'pipe'],
      });
    } catch (error) {
      this.#setState({
        state: 'failed',
        degraded: false,
        error: publicError('spawn_failed', `sidecar 启动失败（${error?.code ?? 'spawn_failed'}）`),
      });
      return false;
    }

    this.child = child;
    this.childToken = hostToken;
    this.manualStart = manual;
    this.readySeen = false;
    this.healthFailures = 0;
    this.commandSource = resolved.source;
    this.installed = true;
    this.#setState({
      state: 'starting',
      degraded: false,
      managed: true,
      attached: false,
      pid: child.pid ?? null,
      url: null,
      healthUrl: null,
      runtimeVersion: null,
      apiVersion: null,
      capabilityApiVersion: null,
      commandSource: resolved.source,
      installed: true,
      startedAt: this.now(),
      lastOkAt: null,
      restarts: this.restarts,
      reason: null,
      error: null,
    });

    child.once?.('error', (error) => {
      if (this.child !== child) return;
      this.#setState({
        state: 'failed',
        degraded: false,
        error: publicError('spawn_failed', `sidecar 启动失败（${error?.code ?? 'spawn_failed'}）`),
      });
    });
    child.once?.('exit', (code, signal) => this.#onChildExit(child, code, signal));
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        const text = redact(chunk?.toString?.('utf-8') ?? '', this.childSecrets);
        if (text.trim().length > 0) this.lastStderr = text;
      });
    }

    const deadline = this.now() + Math.max(100, this.configuredStartTimeout());
    const ready = await this.#waitForReady(deadline, child);
    if (ready) {
      this.#startWatchdog();
      if (manual) child.unref?.();
      return true;
    }
    if (this.stopping || this.disposed) return false;

    if (this.child === child) {
      // 先解除归属，避免 SIGTERM 触发的 exit handler 把超时当成一次崩溃并重复排程。
      this.child = null;
      this.#stopWatchdog();
      try {
        child.kill('SIGTERM');
      } catch {
        // already gone
      }
      await this.#waitChildExit(child, 500);
      if (child.exitCode === null) {
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
        await this.#waitChildExit(child, 500);
      }
      this.restarts += 1;
      this.crashTimes.push(this.now());
      this.#setState({
        state: 'failed',
        degraded: false,
        managed: false,
        attached: false,
        pid: null,
        url: null,
        healthUrl: null,
        restarts: this.restarts,
        error: publicError('start_timeout', 'sidecar 启动超时'),
      });
      this.#scheduleRestart();
    }
    return false;
  }

  async #startOnce({ force = false, manual = false, isRestart = false } = {}) {
    if (this.disposed) return this.snapshot();
    this.stopping = false;

    const discovered = await this.#refreshDiscovery({ fetchHealth: true });
    if (discovered && ['ready', 'degraded'].includes(this.statusState.state)) {
      this.#startWatchdog();
      return this.snapshot();
    }
    if (this.statusState.error && ['profile_mismatch', 'home_mismatch', 'version_incompatible'].includes(this.statusState.error.code)) {
      return this.snapshot();
    }
    if (this.stopping || this.disposed) return this.snapshot();

    if (!force && !this.isEnabled()) {
      this.statusState = makeDisabledStatus({ enabled: false, reason: 'disabled' });
      return this.snapshot();
    }
    if (!force && this.env?.MEBULAR_MEMORY_RUNTIME_DISABLE === '1') {
      this.#setState({
        state: 'stopped',
        degraded: false,
        managed: false,
        attached: false,
        pid: null,
        reason: 'disabled',
        error: null,
      });
      return this.snapshot();
    }

    const existing = await readDiscovery(this.paths.discoveryPath);
    if (existing && pidAlive(existing.pid)) {
      // 存活但未通过 health/版本校验：不启动第二个实例。
      this.#setState({
        state: 'degraded',
        degraded: true,
        managed: false,
        attached: true,
        pid: existing.pid,
        url: existing.url,
        healthUrl: existing.healthUrl,
        error: publicError('sidecar_unhealthy', '已有 sidecar 未就绪：不重复启动'),
      });
      return this.snapshot();
    }
    if (existing) await unlink(this.paths.discoveryPath).catch(() => undefined);

    const lock = await this.#readLockView();
    if (lock && pidAlive(lock.pid)) {
      const expectedProfile = this.#profileId();
      const expectedCloud = this.#cloudId();
      if ((expectedProfile && lock.profileId && expectedProfile !== lock.profileId)
        || (expectedCloud && lock.cloudId && expectedCloud !== lock.cloudId)) {
        this.#setState({
          state: 'failed',
          degraded: false,
          error: publicError('profile_mismatch', '已有 sidecar 启动锁属于其他 profile/忆云：拒绝接管'),
          lock: this.lockView,
        });
        return this.snapshot();
      }
      const deadline = this.now() + Math.max(100, this.configuredStartTimeout());
      const ready = await this.#waitForDiscovery(deadline);
      if (ready) {
        this.#startWatchdog();
        return this.snapshot();
      }
      if (this.stopping || this.disposed) return this.snapshot();
      if (this.statusState.error && ['profile_mismatch', 'home_mismatch', 'version_incompatible'].includes(this.statusState.error.code)) {
        return this.snapshot();
      }
      this.#setState({
        state: 'failed',
        degraded: false,
        error: publicError('sidecar_starting', '已有 sidecar 正在启动但未在超时内就绪'),
        lock: this.lockView,
      });
      return this.snapshot();
    }
    // 陈旧/损坏锁交给 sidecar 自己原子接管；supervisor 不删除 start.lock，避免误删并发新实例。
    if (this.stopping || this.disposed) return this.snapshot();
    if (isRestart) this.#pruneCrashTimes();
    await this.#spawnSidecar({ manual });
    return this.snapshot();
  }

  async start({ force = false, manual = false } = {}) {
    if (this.disposed) return this.snapshot();
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.#startOnce({ force, manual })
      .catch((error) => this.#setState({
        state: 'failed',
        degraded: false,
        error: publicError(error?.code ?? 'supervisor_error', 'sidecar supervisor 异常'),
      }))
      .finally(() => {
        this.startPromise = null;
      });
    return this.startPromise;
  }

  async #stopPid(pid, timeoutMs) {
    if (!pidAlive(pid)) return true;
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      return !pidAlive(pid);
    }
    const deadline = this.now() + Math.max(0, timeoutMs);
    while (pidAlive(pid) && this.now() < deadline) await sleep(25);
    if (pidAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
      const killDeadline = this.now() + 500;
      while (pidAlive(pid) && this.now() < killDeadline) await sleep(25);
    }
    return !pidAlive(pid);
  }

  async stop({ includeAttached = false, timeoutMs = 5000 } = {}) {
    this.stopping = true;
    this.#clearRestartTimer();
    this.#clearCooldownTimer();
    this.#stopWatchdog();

    // 让正在启动的流程看到 stopping 并退出，避免它在本函数返回后又拉起子进程。
    if (this.startPromise) {
      await Promise.race([this.startPromise.catch(() => undefined), sleep(250)]);
    }
    const child = this.child;
    if (child) {
      this.#killChild('SIGTERM');
      await this.#waitChildExit(child, timeoutMs);
      if (child.exitCode === null) {
        this.#killChild('SIGKILL');
        await this.#waitChildExit(child, 500);
      }
      if (this.child === child) this.child = null;
    }
    if (this.startPromise) {
      await Promise.race([this.startPromise.catch(() => undefined), sleep(250)]);
    }
    const lateChild = this.child;
    if (lateChild && lateChild !== child) {
      this.#killChild('SIGTERM');
      await this.#waitChildExit(lateChild, Math.min(timeoutMs, 1000));
      if (lateChild.exitCode === null) this.#killChild('SIGKILL');
      if (this.child === lateChild) this.child = null;
    }

    // Windows 的 SIGTERM 是强制终止，sidecar 可能来不及清理 discovery/lock。
    // 只清理确实属于本 supervisor 已停止子进程的残留，不碰 attach 实例。
    const stoppedPids = new Set([child?.pid, lateChild?.pid].filter((pid) => Number.isInteger(pid)));
    for (const pid of stoppedPids) {
      if (pidAlive(pid)) continue;
      const discovery = await readDiscovery(this.paths.discoveryPath);
      if (discovery?.pid === pid) {
        await unlink(this.paths.discoveryPath).catch(() => undefined);
      }
      const lock = await this.#readLockView();
      if (lock?.pid === pid) {
        await unlink(this.paths.lockPath).catch(() => undefined);
      }
    }

    if (includeAttached) {
      await this.#readLockView();
      const discovery = await readDiscovery(this.paths.discoveryPath);
      if (discovery && !this.#homeMismatch(discovery) && pidAlive(discovery.pid)) {
        await this.#stopPid(discovery.pid, timeoutMs);
        const current = await readDiscovery(this.paths.discoveryPath);
        if (current?.pid === discovery.pid && !pidAlive(discovery.pid)) {
          await unlink(this.paths.discoveryPath).catch(() => undefined);
        }
      }
      const lock = await this.#readLockView();
      if (lock && lock.command === 'serve' && pidAlive(lock.pid)) {
        await this.#stopPid(lock.pid, timeoutMs);
      }
      await unlink(this.paths.lockPath).catch(() => undefined);
    }

    this.#setState({
      state: 'stopped',
      degraded: false,
      managed: false,
      attached: false,
      pid: null,
      url: null,
      healthUrl: null,
      error: null,
      reason: this.isEnabled() ? null : 'disabled',
      lock: null,
    });
    this.stopping = false;
    return this.snapshot();
  }

  async restart({ includeAttached = false, timeoutMs = 5000, manual = false, force = true } = {}) {
    await this.stop({ includeAttached, timeoutMs });
    this.crashTimes = [];
    this.restarts = 0;
    this.healthFailures = 0;
    return this.start({ force, manual });
  }

  async dispose() {
    this.disposed = true;
    this.#clearRestartTimer();
    this.#clearCooldownTimer();
    this.#stopWatchdog();
    if (this.startPromise) {
      await Promise.race([this.startPromise.catch(() => undefined), sleep(250)]);
    }
    const child = this.child;
    if (child) {
      this.#killChild('SIGTERM');
      await this.#waitChildExit(child, 3000);
      if (child.exitCode === null) this.#killChild('SIGKILL');
      if (this.child === child) this.child = null;
    }
    const lateChild = this.child;
    if (lateChild && lateChild !== child) {
      this.#killChild('SIGTERM');
      await this.#waitChildExit(lateChild, 1000);
      if (lateChild.exitCode === null) this.#killChild('SIGKILL');
      if (this.child === lateChild) this.child = null;
    }
    // Windows 强制终止不会执行 sidecar 自己的清理；只清理本 supervisor
    // 确实停止的子进程残留，attach 的实例不动。
    const stoppedPids = new Set([child?.pid, lateChild?.pid].filter((pid) => Number.isInteger(pid)));
    for (const pid of stoppedPids) {
      if (pidAlive(pid)) continue;
      const discovery = await readDiscovery(this.paths.discoveryPath);
      if (discovery?.pid === pid) {
        await unlink(this.paths.discoveryPath).catch(() => undefined);
      }
      const lock = await this.#readLockView();
      if (lock?.pid === pid) {
        await unlink(this.paths.lockPath).catch(() => undefined);
      }
    }
    this.#setState({
      state: 'stopped',
      managed: false,
      attached: false,
      pid: null,
      url: null,
      healthUrl: null,
      error: null,
    });
  }
}

/** 只读检查：不 spawn、不创建目录/token；供 CLI status 与 admin 使用。 */
export async function inspectMemoryRuntimeStatus({
  home,
  env = process.env,
  config = {},
  expectedProfileId = null,
  expectedCloudId = null,
  now = Date.now,
  fetchImpl = globalThis.fetch,
} = {}) {
  const supervisor = new MemoryRuntimeSupervisor({
    home,
    env,
    config,
    profileId: () => expectedProfileId,
    cloudId: () => expectedCloudId,
    now,
    fetchImpl,
    restartOnFailure: false,
  });
  const status = await supervisor.status();
  const resolved = resolveMemoryRuntimeCommand({ config, env });
  return {
    ...status,
    installed: resolved.ok === true,
    commandSource: resolved.source,
  };
}

/** 稳定 CLI 退出码（sidecar §11.2 + MCP CLI 包装约定）。 */
export function memoryRuntimeStatusExitCode(status) {
  const code = status?.error?.code ?? null;
  if (code === 'not_installed') return 3;
  if (code === 'capability_token_missing' || code === 'capability_token_invalid') return 5;
  if (code === 'storage_unavailable' || code === 'token_permissions_insecure') return 6;
  if (code === 'bind_failed' || code === 'bind_not_loopback') return 4;
  if (code === 'version_incompatible' || code === 'capability_disabled') return 2;
  if (code === 'profile_mismatch' || code === 'home_mismatch' || code === 'lock_conflict'
    || code === 'already_running' || code === 'sidecar_starting') return 7;
  if (status?.state === 'ready' || status?.state === 'degraded' || status?.state === 'stopped') return 0;
  return 1;
}
