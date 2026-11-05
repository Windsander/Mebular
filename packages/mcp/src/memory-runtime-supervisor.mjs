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
import { randomBytes, createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { chmod, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_VERSION } from './version.mjs';
import { readCapabilityToken } from './memory-runtime-token.mjs';
import { appendMemoryRuntimeLogSync } from './memory-runtime-diagnostics.mjs';

export const MEMORY_RUNTIME_DISCOVERY_FILE = 'memory-runtime.json';
export const MEMORY_RUNTIME_DATA_DIR = 'memory-runtime';
export const MEMORY_RUNTIME_START_LOCK_FILE = 'start.lock';
export const MEMORY_RUNTIME_TOKEN_FILE = 'host-token';
export const MEMORY_RUNTIME_CAPABILITY_TOKEN_FILE = 'capability-token';
export const MEMORY_RUNTIME_DEFAULT_PORT = 7341;
export const MEMORY_RUNTIME_DEFAULT_START_TIMEOUT_MS = 5000;
export const MEMORY_RUNTIME_HEALTH_TIMEOUT_MS = 200;
export const MEMORY_RUNTIME_HEALTH_CHECK_MS = 5000;
export const MEMORY_RUNTIME_DISCOVERY_STALE_MS = 15_000;
export const MEMORY_RUNTIME_DISCOVERY_DEAD_MS = 30_000;
export const MEMORY_RUNTIME_RESTART_WINDOW_MS = 5 * 60 * 1000;
export const MEMORY_RUNTIME_MAX_RESTARTS = 3;
export const MEMORY_RUNTIME_RESTART_BACKOFF_MS = 500;
export const MEMORY_RUNTIME_RESTART_BACKOFF_MAX_MS = 30_000;
export const MEMORY_RUNTIME_RESTART_COOLDOWN_MS = 5 * 60 * 1000;
export const MEMORY_RUNTIME_BIN = 'mebular-memory-runtime';
/** 默认 sidecar heartbeat 为 5s；禁用/停止必须覆盖至少一个完整心跳 + 有界收尾。 */
export const MEMORY_RUNTIME_ATTACHED_DORMANT_WAIT_MS = 12_000;

const SIDECAR_KIND = 'mebular-memory-runtime';
const CAPABILITY_API_VERSION = 1;

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, Math.max(0, ms)));

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringOrNull(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function loopbackHostname(hostname) {
  const normalized = String(hostname ?? '').replace(/^\[|\]$/g, '').toLowerCase();
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === 'localhost';
}

function validDiscoveryUrls(discovery) {
  try {
    const base = new URL(discovery.url);
    const health = new URL(discovery.healthUrl);
    const basePath = '/memory-runtime/v1';
    return base.protocol === 'http:'
      && health.protocol === 'http:'
      && loopbackHostname(base.hostname)
      && loopbackHostname(health.hostname)
      && base.username === '' && base.password === ''
      && health.username === '' && health.password === ''
      && base.pathname === basePath
      && health.pathname === `${basePath}/health`
      && base.search === '' && base.hash === ''
      && health.search === '' && health.hash === ''
      && base.origin === health.origin
      && Number(base.port) === discovery.port;
  } catch {
    return false;
  }
}

function sameDiscoveryInstance(left, right) {
  return Boolean(left && right)
    && left.pid === right.pid
    && left.startedAt === right.startedAt
    && left.url === right.url
    && left.tokenFile === right.tokenFile;
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
    discoveryMode: null,
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
  if (!isSidecarDiscovery(value)) return null;
  if (value.mode !== undefined && value.mode !== 'immersive' && value.mode !== 'mcp') return null;
  return { ...value, mode: value.mode ?? 'immersive' };
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
  'keyref',
  'baseurl',
  'modelpath',
  'installedpath',
  'modelsdir',
  'apikey',
  'api_key',
  'api-key',
  'accesstoken',
  'refreshtoken',
  'secretref',
  'credentialref',
  'endpoint',
  'binarypath',
  'installpath',
  'enginepath',
  'path',
  'rootdir',
  'homedir',
  'debug',
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

function traceText(value, max = 512) {
  return typeof value === 'string' ? value.slice(0, max) : null;
}

function traceNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function traceStrings(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string').slice(0, 100) : [];
}

function traceOwnerView(owner) {
  return {
    role: traceText(owner?.role, 64),
    ownerId: traceText(owner?.ownerId, 256),
    domain: traceText(owner?.domain, 256),
    agentName: traceText(owner?.agentName, 128),
  };
}

function traceProvenanceView(provenance) {
  return {
    source: traceText(provenance?.source, 64),
    extractor: traceText(provenance?.extractor, 64),
    hostId: traceText(provenance?.hostId, 128),
  };
}

function traceSummaryView(trace) {
  const feedback = trace?.feedback;
  return {
    id: traceText(trace?.id, 160),
    recallId: traceText(trace?.recallId, 160),
    schema: traceNumber(trace?.schema),
    at: traceNumber(trace?.at),
    agentId: traceText(trace?.agentId, 256),
    threadId: traceText(trace?.threadId, 256),
    queryHash: traceText(trace?.queryHash, 256),
    queryPreview: traceText(trace?.queryPreview, 160),
    domains: traceStrings(trace?.domains),
    silenceReason: traceText(trace?.silenceReason, 128),
    degraded: trace?.degraded === true,
    feedback: feedback && typeof feedback === 'object' ? {
      useful: feedback.useful === true,
      reason: traceText(feedback.reason, 500),
      at: traceNumber(feedback.at),
    } : null,
    counts: {
      candidates: traceNumber(trace?.counts?.candidates),
      expansions: traceNumber(trace?.counts?.expansions),
      injected: traceNumber(trace?.counts?.injected),
      tokens: traceNumber(trace?.counts?.tokens),
    },
    timing: { totalMs: traceNumber(trace?.timing?.totalMs) },
    model: {
      query: traceText(trace?.model?.query, 128),
      embedding: traceText(trace?.model?.embedding, 128),
      extractor: traceText(trace?.model?.extractor, 128),
      tookMs: traceNumber(trace?.model?.tookMs),
    },
  };
}

function traceDetailView(trace) {
  return {
    ...traceSummaryView(trace),
    hits: Array.isArray(trace?.hits) ? trace.hits.slice(0, 100).map((hit) => ({
      id: traceText(hit?.id, 256),
      type: traceText(hit?.type, 64),
      score: traceNumber(hit?.score),
      rank: traceNumber(hit?.rank),
    })) : [],
    cue: {
      topics: traceStrings(trace?.cue?.topics),
      entities: Array.isArray(trace?.cue?.entities) ? trace.cue.entities.slice(0, 100).map((entity) => ({
        name: traceText(entity?.name, 256),
        type: traceText(entity?.type, 64),
      })) : [],
    },
    candidates: Array.isArray(trace?.candidates) ? trace.candidates.slice(0, 100).map((candidate) => ({
      id: traceText(candidate?.id, 256),
      type: traceText(candidate?.type, 64),
      domain: traceText(candidate?.domain, 256),
      owner: traceOwnerView(candidate?.owner),
      provenance: traceProvenanceView(candidate?.provenance),
      confidence: traceNumber(candidate?.confidence),
      score: traceNumber(candidate?.score),
      rank: traceNumber(candidate?.rank),
    })) : [],
    expansions: Array.isArray(trace?.expansions) ? trace.expansions.slice(0, 100).map((expansion) => ({
      sourceId: traceText(expansion?.sourceId, 256),
      reason: traceText(expansion?.reason, 128),
      status: traceText(expansion?.status, 64),
    })) : [],
    injected: Array.isArray(trace?.injected) ? trace.injected.slice(0, 100).map((fragment) => ({
      fragmentId: traceText(fragment?.fragmentId, 256),
      sourceId: traceText(fragment?.sourceId, 256),
      layer: traceText(fragment?.layer, 64),
      tokens: traceNumber(fragment?.tokens),
      citations: traceStrings(fragment?.citations),
      confidence: traceNumber(fragment?.confidence),
      owner: traceOwnerView(fragment?.owner),
      provenance: traceProvenanceView(fragment?.provenance),
    })) : [],
  };
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
    this.managedInstance = null;
    this.dormantLock = null;
    this.dormantLockInvalidated = false;
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
      available: this.isEnabled() && (patch.available ?? (nextState === 'ready' || nextState === 'degraded')),
    };
    return this.snapshot();
  }

  #degradedError(code = 'sidecar_degraded') {
    return publicError(code, 'Memory Runtime sidecar 处于降级状态');
  }

  #profileMismatch(discovery) {
    const expectedProfile = this.#profileId();
    const actualProfile = discoveryProfileId(discovery);
    if (expectedProfile && expectedProfile !== actualProfile) return true;
    const expectedCloud = this.#cloudId();
    const actualCloud = discoveryCloudId(discovery);
    return Boolean(expectedCloud && expectedCloud !== actualCloud);
  }

  #homeMismatch(discovery) {
    if (typeof discovery?.tokenFile !== 'string' || discovery.tokenFile.length === 0) return true;
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

  #healthIdentityMatches(discovery, body, { allowDormant = false } = {}) {
    if (!isObject(body) || body.pid !== discovery.pid) return false;
    if (stringOrNull(body.profileId) !== discoveryProfileId(discovery)) return false;
    if (stringOrNull(body.cloudId) !== discoveryCloudId(discovery)) return false;
    return body.mode === discovery.mode || (allowDormant && body.mode === 'mcp');
  }

  async #fetchHealth(discovery, { acceptDormant = false } = {}) {
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
      const ready = body?.ready !== false;
      const dormant = acceptDormant && body?.mode === 'mcp' && body?.state === 'stopped';
      return {
        ok: body?.ok !== false && (ready || dormant),
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

  /** 从 start.lock 构造可验证候选；不写回 discovery，只用于显式 stop。 */
  #discoveryFromLock(lock) {
    if (!lock || lock.command !== 'serve' || !Number.isInteger(lock.port) || lock.port <= 0) return null;
    const base = `http://127.0.0.1:${lock.port}/memory-runtime/v1`;
    return {
      schema: 1,
      kind: SIDECAR_KIND,
      pid: lock.pid,
      host: '127.0.0.1',
      port: lock.port,
      url: base,
      healthUrl: `${base}/health`,
      tokenFile: this.paths.hostTokenPath,
      cloudId: lock.cloudId,
      profileId: lock.profileId,
      runtimeVersion: APP_VERSION,
      apiVersion: 1,
      capabilityApiVersion: CAPABILITY_API_VERSION,
      minMcpVersion: '0.3.0',
      maxMcpVersion: '0.3.x',
      state: 'ready',
      mode: 'immersive',
      degraded: false,
      startedAt: lock.startedAt,
      updatedAt: this.now(),
      capabilities: {},
    };
  }

  /** 当前实际 capability token（env 优先，其次生产文件）的指纹；null 表示没有可用凭据。 */
  async #capabilityFingerprint() {
    try {
      const record = await readCapabilityToken({
        home: this.paths.home,
        env: this.env,
        now: this.now(),
      });
      if (!record?.token) return null;
      return createHash('sha256').update(record.token).digest('hex');
    } catch {
      return null;
    }
  }

  get #dormantStatePath() {
    return join(this.paths.dataDir, 'dormant.json');
  }

  async #readDormantState() {
    try {
      const info = await stat(this.#dormantStatePath);
      if (process.platform !== 'win32' && (info.mode & 0o777) !== 0o600) return null;
      const value = JSON.parse(await readFile(this.#dormantStatePath, 'utf-8'));
      if (value?.version !== undefined && value.version !== 1) return null;
      if (!Number.isInteger(value?.pid) || value.pid <= 0) return null;
      if (!Number.isFinite(value?.startedAt)) return null;
      if (!(typeof value?.credential === 'string' || value?.credential === null)) return null;
      return {
        pid: value.pid,
        startedAt: value.startedAt,
        credential: value.credential,
      };
    } catch {
      return null;
    }
  }

  async #writeDormantState(state) {
    const tmp = `${this.#dormantStatePath}.tmp-${process.pid}`;
    try {
      await writeFile(tmp, JSON.stringify({ version: 1, ...state }, null, 2), { mode: 0o600 });
      if (process.platform !== 'win32') await chmod(tmp, 0o600);
      await rename(tmp, this.#dormantStatePath);
    } catch (error) {
      await unlink(tmp).catch(() => undefined);
      throw error;
    }
  }

  async #clearDormantState() {
    await unlink(this.#dormantStatePath).catch(() => undefined);
  }

  /**
   * 读取 discovery/health 并更新快照。
   * @returns {Promise<boolean>} 是否可接流量（ready 或 degraded）。
   */
  async #refreshDiscovery({ fetchHealth = true } = {}) {
    if (!this.isEnabled()) {
      if (this.statusState.error?.code !== 'disable_incomplete') {
        this.statusState = makeDisabledStatus({ enabled: false, reason: 'disabled' });
      }
      return false;
    }
    await this.#readLockView();
    const discovery = await readDiscovery(this.paths.discoveryPath);
    if (!discovery) {
      if (this.dormantLock) {
        const lock = await readLock(this.paths.lockPath);
        const credential = await this.#capabilityFingerprint();
        if (!lock
          || lock.pid !== this.dormantLock.pid
          || lock.startedAt !== this.dormantLock.startedAt
          || !pidAlive(lock.pid)
          || credential !== this.dormantLock.credential) {
          this.dormantLockInvalidated = true;
          this.dormantLock = null;
          // 保留持久化 baseline：跨进程启动仍能识别 credential 已换代。
        } else {
          this.#setState({
            state: 'stopped',
            available: false,
            degraded: false,
            managed: false,
            attached: false,
            pid: lock.pid,
            url: null,
            healthUrl: null,
            reason: 'disabled',
            error: null,
            lock: this.lockView,
          });
          return false;
        }
      }
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
          discoveryMode: null,
          restarts: this.restarts,
          error: this.readySeen ? publicError('discovery_missing', 'sidecar discovery 缺失') : null,
          lock: this.lockView,
        });
        return false;
      }
      if (this.statusState.state !== 'failed'
        || ['discovery_dead', 'discovery_stale', 'discovery_future', 'discovery_invalid', 'instance_mismatch']
          .includes(this.statusState.error?.code)) {
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
          discoveryMode: null,
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

    const managed = Boolean(this.child && this.child.pid === discovery.pid);
    if (managed) {
      // 记录本实例拥有的 pid/startedAt；child 被强杀后仍可确认 discovery/start.lock 归属。
      this.managedInstance = { pid: discovery.pid, startedAt: discovery.startedAt };
    }
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

    if (!pidAlive(discovery.pid)) {
      // 只读 status/inspect 绝不 unlink；身份校验先于 dead 判定与后续清理。
      this.#setState({
        state: 'stopped',
        available: false,
        degraded: false,
        managed: false,
        attached: false,
        pid: discovery.pid,
        url: null,
        healthUrl: null,
        discoveryMode: discovery.mode,
        error: publicError('discovery_dead', 'sidecar discovery 对应进程已退出'),
        lock: this.lockView,
      });
      return false;
    }

    if (!validDiscoveryUrls(discovery)) {
      this.#setState({
        state: 'failed', available: false, degraded: false, managed, attached: !managed,
        pid: discovery.pid, url: null, healthUrl: null,
        error: publicError('discovery_invalid', 'sidecar discovery URL 非法：拒绝连接或转发凭据'),
        lock: this.lockView,
      });
      return false;
    }
    const age = this.now() - discovery.updatedAt;
    if (!Number.isFinite(age) || age < -1000 || age > MEMORY_RUNTIME_DISCOVERY_DEAD_MS) {
      this.#setState({
        state: 'failed', available: false, degraded: false, managed, attached: !managed,
        pid: discovery.pid, url: null, healthUrl: null,
        error: publicError(age < -1000 ? 'discovery_future' : 'discovery_dead', 'sidecar discovery 已失效'),
        lock: this.lockView,
      });
      return false;
    }
    if (age > MEMORY_RUNTIME_DISCOVERY_STALE_MS) {
      this.#setState({
        state: 'degraded', available: false, degraded: true, managed, attached: !managed,
        pid: discovery.pid, url: null, healthUrl: null,
        error: publicError('discovery_stale', 'sidecar discovery 已超过 15 秒未刷新'),
        lock: this.lockView,
      });
      return false;
    }
    if (discovery.mode === 'mcp') {
      const dormantClean = discovery.state === 'stopped';
      this.#setState({
        state: dormantClean ? 'stopped' : 'degraded',
        available: false,
        degraded: !dormantClean,
        managed,
        attached: !managed,
        pid: discovery.pid,
        url: null,
        healthUrl: null,
        discoveryMode: 'mcp',
        reason: 'disabled',
        error: dormantClean
          ? null
          : publicError('disable_incomplete', 'sidecar 尚未完成 dormant 收尾'),
        lock: this.lockView,
      });
      return false;
    }

    const health = fetchHealth ? await this.#fetchHealth(discovery) : { ok: true };
    const healthBody = health.body ?? {};
    const healthMismatch = health.ok && !this.#healthIdentityMatches(discovery, healthBody);
    if (healthMismatch) {
      this.#setState({
        state: 'failed', available: false, degraded: false, managed, attached: !managed,
        pid: discovery.pid, url: null, healthUrl: null,
        error: publicError('instance_mismatch', 'sidecar health 与 discovery 实例身份不一致'),
        lock: this.lockView,
      });
      return false;
    }
    if (health.ok) {
      this.readySeen = true;
      this.dormantLock = null;
      this.dormantLockInvalidated = false;
      await this.#clearDormantState();
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
        discoveryMode: 'immersive',
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
      available: false,
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
      discoveryMode: discovery.mode,
      restarts: this.restarts,
      error: starting ? null : publicError('health_check_failed', 'sidecar 健康检查失败'),
      lock: this.lockView,
    });
    return false;
  }

  async status() {
    if (!this.isEnabled() && !this.statusState.managed && !this.statusState.pid
      && this.statusState.error?.code !== 'disable_incomplete') {
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
        mode: this.statusState.discoveryMode ?? null,
        runtimeVersion: null,
        degraded: result.state === 'degraded',
        capability: null,
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
      capability: isObject(data.capability)
        ? {
            reachable: data.capability.reachable === true,
            version: Number.isInteger(data.capability.version) ? data.capability.version : null,
            lastOkAt: typeof data.capability.lastOkAt === 'number' ? data.capability.lastOkAt : null,
            error: typeof data.capability.error === 'string' ? data.capability.error : null,
          }
        : null,
      model,
    };
  }

  /**
   * 统一 host API 代理：服务端读取 host token，调用方只拿到脱敏数据。
   *
   * 返回扁平结果，不抛异常：
   *   { ok, status, enabled, available, disabled, state, data, warnings, degraded, error }
   * 轻量模式 → memory_runtime_disabled；未就绪 → memory_runtime_unavailable。
   */
  async request(path, { method = 'GET', body = null, timeoutMs = 5000 } = {}) {
    const relative = typeof path === 'string' ? path.replace(/^\/+/, '') : '';
    if (relative.length === 0 || relative.includes('..') || relative.includes('\\')) {
      return {
        ok: false,
        status: 400,
        enabled: this.isEnabled(),
        available: false,
        disabled: false,
        state: this.statusState.state,
        data: null,
        warnings: [],
        degraded: false,
        error: { code: 'invalid_request', message: 'sidecar 请求路径非法', retryable: false },
      };
    }
    const result = await this.#proxyHostApi(relative, {
      method: String(method).toUpperCase(),
      body,
      timeoutMs,
    });
    if (!result.available) {
      const disabled = result.disabled === true;
      return {
        ok: false,
        status: disabled ? 409 : 503,
        enabled: result.enabled === true,
        available: false,
        disabled,
        state: result.state,
        data: null,
        warnings: [],
        degraded: result.state === 'degraded',
        error: {
          code: disabled ? 'memory_runtime_disabled' : 'memory_runtime_unavailable',
          message: disabled ? '记忆运行时未启用' : 'Memory Runtime sidecar 未就绪',
          retryable: !disabled,
          ...(result.reason ? { reason: result.reason } : {}),
        },
      };
    }
    if (!result.ok) {
      const envelope = isObject(result.body) ? result.body : {};
      const rawError = isObject(envelope.error) ? envelope.error : {};
      const code = typeof rawError.code === 'string'
        ? rawError.code
        : typeof envelope.error === 'string' ? envelope.error : 'sidecar_request_failed';
      const statusCode = Number.isInteger(result.statusCode) ? result.statusCode : 502;
      return {
        ok: false,
        status: statusCode >= 400 && statusCode < 500 ? statusCode : 502,
        enabled: true,
        available: true,
        disabled: false,
        state: result.state,
        data: null,
        warnings: Array.isArray(envelope.warnings) ? envelope.warnings : [],
        degraded: envelope.degraded === true || result.state === 'degraded',
        error: {
          code,
          message: proxyErrorMessage(envelope, 'sidecar 请求失败'),
          retryable: rawError.retryable === true,
          ...(isObject(rawError.details) ? { details: rawError.details } : {}),
        },
      };
    }
    const envelope = isObject(result.body) ? result.body : {};
    const data = envelope.data ?? result.body ?? null;
    return {
      ok: true,
      status: Number.isInteger(result.statusCode) ? result.statusCode : 200,
      enabled: true,
      available: true,
      disabled: false,
      state: result.state,
      data,
      warnings: Array.isArray(envelope.warnings) ? envelope.warnings : [],
      degraded: envelope.degraded === true || result.state === 'degraded',
      error: null,
    };
  }

  async listModels() {
    return this.request('models');
  }

  async modelStatus(packId) {
    return this.request(`models/${encodeURIComponent(String(packId ?? ''))}/status`);
  }

  async installModel(packId, { force = false } = {}) {
    const suffix = force === true ? '?force=true' : '';
    return this.request(`models/${encodeURIComponent(String(packId ?? ''))}/install${suffix}`, {
      method: 'POST',
      timeoutMs: 10_000,
    });
  }

  async getInstall(jobId) {
    return this.request(`installs/${encodeURIComponent(String(jobId ?? ''))}`);
  }

  async cancelInstall(jobId) {
    return this.request(`installs/${encodeURIComponent(String(jobId ?? ''))}/cancel`, {
      method: 'POST',
    });
  }

  async activateModel(packId) {
    return this.request(`models/${encodeURIComponent(String(packId ?? ''))}/activate`, {
      method: 'POST',
      timeoutMs: 30_000,
    });
  }

  async deactivateModel(packId) {
    return this.request(`models/${encodeURIComponent(String(packId ?? ''))}/deactivate`, {
      method: 'POST',
      timeoutMs: 15_000,
    });
  }

  async startEngine(packId) {
    return this.request(`models/${encodeURIComponent(String(packId ?? ''))}/start`, {
      method: 'POST',
      timeoutMs: 30_000,
    });
  }

  async stopEngine(packId) {
    return this.request(`models/${encodeURIComponent(String(packId ?? ''))}/stop`, {
      method: 'POST',
      timeoutMs: 15_000,
    });
  }

  async removeModel(packId) {
    return this.request(`models/${encodeURIComponent(String(packId ?? ''))}/remove`, {
      method: 'POST',
      timeoutMs: 15_000,
    });
  }

  async inferenceStatus() {
    return this.request('inference');
  }

  async updateInferenceSettings(input) {
    return this.request('inference/settings', {
      method: 'POST',
      body: isObject(input) ? input : {},
    });
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
    const traces = Array.isArray(data.traces) ? data.traces.slice(0, safeLimit).map(traceSummaryView) : [];
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
      trace: traceDetailView(data),
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
    const fromEnv = stringOrNull(this.env?.MEBULAR_MEMORY_RUNTIME_TOKEN);
    if (fromEnv) return { token: fromEnv, source: 'override', refreshable: false };
    if (typeof discovery?.tokenFile !== 'string' || discovery.tokenFile.length === 0) return null;
    // 只读当前 home 的生产 JSON token；raw 文件不是隐式生产回退格式。
    if (resolve(dirname(discovery.tokenFile)) !== this.paths.dataDir) return null;
    try {
      if (process.platform !== 'win32' && ((await stat(discovery.tokenFile)).mode & 0o077) !== 0) return null;
      const record = JSON.parse(await readFile(discovery.tokenFile, 'utf-8'));
      if (record?.version !== 1 || typeof record?.token !== 'string' || record.token.length === 0) return null;
      if (typeof record.expiresAt === 'number' && record.expiresAt > 0 && this.now() >= record.expiresAt) return null;
      return { token: record.token, source: 'file', refreshable: true };
    } catch {
      // 显式测试/嵌入在文件尚未可见时仍可使用本子进程持有的凭据。
      if (this.child && discovery?.pid === this.child.pid && typeof this.childToken === 'string') {
        return { token: this.childToken, source: 'child', refreshable: true };
      }
      return null;
    }
  }

  async #removeDiscoveryIfMatches(expected) {
    if (!expected || this.#homeMismatch(expected) || this.#profileMismatch(expected)) return false;
    const current = await readDiscovery(this.paths.discoveryPath);
    if (!sameDiscoveryInstance(current, expected)) return false;
    // 删除前再读一次，缩窄操作者重启/替换实例时的竞态窗口。
    const confirmed = await readDiscovery(this.paths.discoveryPath);
    if (!sameDiscoveryInstance(confirmed, expected)) return false;
    await unlink(this.paths.discoveryPath);
    return true;
  }

  async #readSidecarMode(discovery) {
    const age = this.now() - discovery.updatedAt;
    if (!validDiscoveryUrls(discovery) || this.#homeMismatch(discovery)
      || this.#profileMismatch(discovery) || this.#versionMismatch(discovery)
      || !Number.isFinite(age) || age < -1000 || age > MEMORY_RUNTIME_DISCOVERY_STALE_MS) {
      return null;
    }
    const health = await this.#fetchHealth(discovery, { acceptDormant: true });
    if (!this.#healthIdentityMatches(discovery, health.body, { allowDormant: true })) return null;
    const credential = await this.#resolveHostToken(discovery);
    if (!credential || !this.fetchImpl) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, this.healthTimeoutMs));
    timer.unref?.();
    try {
      const response = await this.fetchImpl(`${discovery.url.replace(/\/+$/, '')}/status`, {
        method: 'GET',
        headers: { accept: 'application/json', authorization: `Bearer ${credential.token}` },
        signal: controller.signal,
      });
      if (!response?.ok) return null;
      const body = await response.json().catch(() => null);
      const data = body?.data;
      if (data?.pid !== discovery.pid) return null;
      if (typeof data.startedAt === 'number' && data.startedAt !== discovery.startedAt) return null;
      const mode = data?.mode;
      const state = data?.state;
      if ((mode !== 'mcp' && mode !== 'immersive') || typeof state !== 'string') return null;
      return { mode, state };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async #waitAttachedDormant(discovery, timeoutMs) {
    // 陈旧/非法 discovery 无法证明实例身份：不发送 HTTP，立即报告 incomplete。
    const age = this.now() - discovery.updatedAt;
    if (!validDiscoveryUrls(discovery)
      || this.#homeMismatch(discovery)
      || this.#profileMismatch(discovery)
      || this.#versionMismatch(discovery)
      || !Number.isFinite(age)
      || age < -1000
      || age > MEMORY_RUNTIME_DISCOVERY_STALE_MS) {
      return false;
    }
    const deadline = Date.now() + Math.max(0, timeoutMs);
    for (;;) {
      if (!pidAlive(discovery.pid)) return true;
      const observed = await this.#readSidecarMode(discovery);
      if (observed?.mode === 'mcp' && observed.state === 'stopped') return true;
      if (Date.now() >= deadline) return false;
      await sleep(Math.min(50, Math.max(1, deadline - Date.now())));
    }
  }

  /**
   * 显式 stop 前的实例校验：与 attach 使用同一套 freshness/URL/home/profile/version、
   * health 身份和 token 鉴权的 /status 校验；任何一项无法确认都不得发送信号。
   */
  async #verifyLiveInstance(discovery, { requireDiscovery = true } = {}) {
    if (!discovery || !Number.isInteger(discovery.pid) || !pidAlive(discovery.pid)) return false;
    if (this.#homeMismatch(discovery) || this.#profileMismatch(discovery) || this.#versionMismatch(discovery)) {
      return false;
    }
    if (!validDiscoveryUrls(discovery)) return false;
    const age = this.now() - discovery.updatedAt;
    if (!Number.isFinite(age) || age < -1000 || age > MEMORY_RUNTIME_DISCOVERY_STALE_MS) return false;
    const health = await this.#fetchHealth(discovery, { acceptDormant: true });
    if (!health.ok || !this.#healthIdentityMatches(discovery, health.body, { allowDormant: true })) {
      return false;
    }
    // 需要 host token 的 /status：确认 pid（以及新实例提供的 startedAt）仍属于同一实例。
    const observed = await this.#readSidecarMode(discovery);
    if (!observed) return false;
    if (health.body?.ready === false
      && !(observed.mode === 'mcp' && observed.state === 'stopped')) {
      return false;
    }
    if (!requireDiscovery) return true;
    // 探测期间实例可能被替换；确认 discovery 仍是同一 pid/startedAt/url/tokenFile。
    return sameDiscoveryInstance(await readDiscovery(this.paths.discoveryPath), discovery);
  }

  async #proxyHostApi(pathname, { method = 'GET', body = null, timeoutMs = 2500 } = {}) {
    await this.status().catch(() => undefined);
    if (!this.isEnabled()) {
      return {
        enabled: false, available: false, disabled: true, state: 'stopped', reason: 'disabled', error: null,
      };
    }
    if (!this.statusState.available || !['ready', 'degraded'].includes(this.statusState.state)
      || typeof this.statusState.url !== 'string') {
      return {
        enabled: true,
        available: false,
        disabled: false,
        state: this.statusState.state,
        reason: this.statusState.reason ?? null,
        error: this.statusState.error ?? publicError('sidecar_unavailable', 'Memory Runtime sidecar 未就绪'),
      };
    }
    const validatedDiscovery = (candidate) => {
      const age = candidate ? this.now() - candidate.updatedAt : Number.POSITIVE_INFINITY;
      return candidate
        && candidate.pid === this.statusState.pid
        && candidate.startedAt === this.statusState.startedAt
        && candidate.url === this.statusState.url
        && candidate.mode === 'immersive'
        && age >= -1000 && age <= MEMORY_RUNTIME_DISCOVERY_STALE_MS
        && validDiscoveryUrls(candidate)
        && !this.#homeMismatch(candidate)
        && !this.#profileMismatch(candidate)
        && !this.#versionMismatch(candidate);
    };
    const discovery = await readDiscovery(this.paths.discoveryPath);
    if (!validatedDiscovery(discovery)) {
      return {
        enabled: true,
        available: false,
        disabled: false,
        state: this.statusState.state,
        reason: null,
        error: publicError(discovery ? 'instance_mismatch' : 'discovery_missing', 'sidecar discovery 已变化或失效'),
      };
    }
    if (!this.fetchImpl) {
      return {
        enabled: true, available: false, disabled: false, state: this.statusState.state, reason: null,
        error: publicError('fetch_unavailable', '当前运行环境不支持 HTTP 代理'),
      };
    }

    const requestId = `proxy_${randomBytes(16).toString('hex')}`;
    const attemptedSecrets = new Set();
    const execute = async (instance, token) => {
      attemptedSecrets.add(token);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
      timer.unref?.();
      try {
        const base = instance.url.replace(/\/+$/, '');
        const url = new URL(`${base}/${String(pathname).replace(/^\/+/, '')}`);
        const headers = {
          accept: 'application/json',
          authorization: `Bearer ${token}`,
          'x-request-id': requestId,
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
        return { response, text, parsed };
      } catch (error) {
        return { transportError: error };
      } finally {
        clearTimeout(timer);
      }
    };

    let credential = await this.#resolveHostToken(discovery);
    if (!credential) {
      return {
        enabled: true, available: false, disabled: false, state: this.statusState.state, reason: null,
        error: publicError('host_token_missing', '无法读取 sidecar host token'),
      };
    }
    let attemptedDiscovery = discovery;
    let attempt = await execute(attemptedDiscovery, credential.token);
    if (attempt.response?.status === 401 && credential.refreshable) {
      // 操作者可能已在 401 前后重启 sidecar；新实例也必须重新通过完整校验。
      await this.status().catch(() => undefined);
      const current = await readDiscovery(this.paths.discoveryPath);
      if (validatedDiscovery(current)) {
        const refreshed = await this.#resolveHostToken(current);
        if (refreshed?.refreshable) {
          attemptedDiscovery = current;
          credential = refreshed;
          attempt = await execute(attemptedDiscovery, credential.token);
        }
      }
    }
    if (attempt.transportError) {
      const error = attempt.transportError;
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
    }
    const secrets = [...attemptedSecrets, this.childToken];
    return {
      enabled: true,
      available: true,
      disabled: false,
      state: this.statusState.state,
      statusCode: attempt.response.status,
      ok: attempt.response.ok === true,
      body: scrubProxyValue(attempt.parsed, secrets),
      ...(attempt.parsed === null && attempt.text.length > 0
        ? { message: redact(attempt.text, secrets) }
        : {}),
    };
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
    if (record?.version !== 1 || typeof record?.token !== 'string' || record.token.length === 0) return null;
    if (typeof record.expiresAt === 'number' && record.expiresAt > 0 && this.now() >= record.expiresAt) return null;
    return record.token;
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
    appendMemoryRuntimeLogSync(this.paths.dataDir, {
      level: 'error',
      event: 'supervisor_restart',
      reason: 'child_exit',
      code: 'sidecar_crashed',
      exitCode: typeof code === 'number' ? code : null,
      signal: typeof signal === 'string' ? signal : null,
      restarts: this.restarts,
    }, { now: this.now });
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

  async #waitForOrphanedManagedExit(discovery) {
    const deadline = Date.now() + Math.max(100, this.configuredStartTimeout());
    this.#setState({
      state: 'starting', available: false, degraded: false, managed: false, attached: true,
      pid: discovery.pid, url: null, healthUrl: null, error: null,
    });
    for (;;) {
      const current = await readDiscovery(this.paths.discoveryPath);
      if (!sameDiscoveryInstance(current, discovery) || !pidAlive(discovery.pid)) return true;
      if (Date.now() >= deadline || this.stopping || this.disposed) return false;
      await sleep(Math.min(this.healthPollMs, 50));
    }
  }

  async #startOnce({ force = false, manual = false, isRestart = false } = {}) {
    if (this.disposed) return this.snapshot();
    this.stopping = false;

    const beforeStart = await readDiscovery(this.paths.discoveryPath);
    if (beforeStart && Number.isInteger(beforeStart.parentPid)
      && beforeStart.parentPid !== process.pid && !pidAlive(beforeStart.parentPid)) {
      // 只等待旧 parent supervision 收尾；绝不替父进程杀 attached/manual 或旧 child。
      if (!await this.#waitForOrphanedManagedExit(beforeStart)) {
        if (!this.stopping && !this.disposed) {
          this.#setState({
            state: 'degraded', available: false, degraded: true, managed: false, attached: true,
            pid: beforeStart.pid,
            error: publicError('orphaned_sidecar_alive', '旧 managed sidecar 尚未按父监督退出：不终止、不替换'),
          });
        }
        return this.snapshot();
      }
    }

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
    if (existing) {
      const removed = await this.#removeDiscoveryIfMatches(existing).catch(() => false);
      const remaining = removed ? null : await readDiscovery(this.paths.discoveryPath);
      if (sameDiscoveryInstance(remaining, existing)) {
        this.#setState({
          state: 'failed', available: false, degraded: false,
          error: publicError('discovery_cleanup_failed', '无法安全清理旧 discovery：不启动替换实例'),
        });
        return this.snapshot();
      }
    }

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
      // 已验证的 dormant 外部/manual 实例不是“正在启动”：不要卡在 sidecar_starting。
      const dormantCandidate = this.#discoveryFromLock(lock);
      if (dormantCandidate && await this.#verifyLiveInstance(dormantCandidate, { requireDiscovery: false })) {
        const observed = await this.#readSidecarMode(dormantCandidate);
        if (observed?.mode === 'mcp' && observed.state === 'stopped') {
          const persisted = await this.#readDormantState();
          const persistedMatches = persisted
            && persisted.pid === lock.pid
            && persisted.startedAt === lock.startedAt
            ? persisted
            : null;
          if (persisted && !persistedMatches) await this.#clearDormantState();
          const inMemoryBaseline = this.dormantLock
            && this.dormantLock.pid === lock.pid
            && this.dormantLock.startedAt === lock.startedAt
            ? this.dormantLock.credential
            : undefined;
          const baseline = inMemoryBaseline !== undefined
            ? inMemoryBaseline
            : (persistedMatches ? persistedMatches.credential : undefined);
          const credential = await this.#capabilityFingerprint();
          if (!this.dormantLockInvalidated) {
            if (baseline === undefined) {
              // 没有可信 baseline（文件缺失/损坏/权限异常/写失败）：不能证明仍是同一代 dormant 实例，
              // 保守进入 starting，绝不报告 clean stopped。
              this.dormantLockInvalidated = true;
            } else if (baseline !== credential) {
              // 保留旧 baseline：同一进程重启后仍据此判定凭据已换代，不得回退 stopped。
              this.dormantLock = null;
              this.dormantLockInvalidated = true;
            }
          }
          const resumeDeadline = this.now() + Math.min(500, this.configuredStartTimeout());
          while (this.now() < resumeDeadline) {
            const discovery = await readDiscovery(this.paths.discoveryPath);
            if (discovery) {
              const ready = await this.#refreshDiscovery({ fetchHealth: true });
              if (ready) return this.snapshot();
              break;
            }
            await sleep(50);
          }
          if (!this.dormantLockInvalidated) {
            this.#setState({
              state: 'stopped',
              available: false,
              degraded: false,
              managed: false,
              attached: false,
              pid: lock.pid,
              url: null,
              healthUrl: null,
              reason: 'disabled',
              error: null,
              lock: this.lockView,
            });
            this.dormantLock = {
              pid: lock.pid,
              startedAt: lock.startedAt,
              credential,
            };
            await this.#writeDormantState({
              pid: lock.pid,
              startedAt: lock.startedAt,
              credential,
            });
            return this.snapshot();
          }
        }
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
      if (this.dormantLockInvalidated
        && this.lockView
        && Number.isInteger(this.lockView.pid)
        && pidAlive(this.lockView.pid)) {
        this.#setState({
          state: 'starting',
          available: false,
          degraded: false,
          managed: false,
          attached: false,
          pid: this.lockView.pid,
          url: null,
          healthUrl: null,
          discoveryMode: 'mcp',
          reason: null,
          error: null,
          lock: this.lockView,
        });
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
    let dormantBaseline = null;
    this.#clearRestartTimer();
    this.#clearCooldownTimer();
    this.#stopWatchdog();

    if (this.startPromise) await Promise.race([this.startPromise.catch(() => undefined), sleep(250)]);
    const discoveredAtStop = await readDiscovery(this.paths.discoveryPath);
    const child = this.child;
    const attachedDiscovery = discoveredAtStop
      && discoveredAtStop.pid !== child?.pid
      && discoveredAtStop.pid !== this.managedInstance?.pid
      ? discoveredAtStop
      : null;
    if (child) {
      this.#killChild('SIGTERM');
      await this.#waitChildExit(child, timeoutMs);
      if (child.exitCode === null) {
        this.#killChild('SIGKILL');
        await this.#waitChildExit(child, 500);
      }
      if (this.child === child) this.child = null;
    }
    if (this.startPromise) await Promise.race([this.startPromise.catch(() => undefined), sleep(250)]);
    const lateChild = this.child;
    if (lateChild && lateChild !== child) {
      this.#killChild('SIGTERM');
      await this.#waitChildExit(lateChild, Math.min(timeoutMs, 1000));
      if (lateChild.exitCode === null) this.#killChild('SIGKILL');
      if (this.child === lateChild) this.child = null;
    }

    let clean = true;
    const stoppedPids = new Set([child?.pid, lateChild?.pid, this.managedInstance?.pid]
      .filter((pid) => Number.isInteger(pid)));
    for (const pid of stoppedPids) {
      if (pidAlive(pid)) {
        clean = false;
        continue;
      }
      const current = await readDiscovery(this.paths.discoveryPath);
      const knownStartedAt = discoveredAtStop?.pid === pid
        ? discoveredAtStop.startedAt
        : this.managedInstance?.pid === pid
          ? this.managedInstance.startedAt
          : this.statusState.pid === pid ? this.statusState.startedAt : null;
      if (current?.pid === pid && knownStartedAt !== null && current.startedAt === knownStartedAt) {
        const expected = current;
        const removed = await this.#removeDiscoveryIfMatches(expected).catch(() => false);
        if (!removed && sameDiscoveryInstance(await readDiscovery(this.paths.discoveryPath), expected)) {
          clean = false;
        }
      } else if (current?.pid === pid) {
        // 身份不明的残留不得删除，也不得静默当作已清理。
        clean = false;
      }
      const lock = await this.#readLockView();
      if (lock?.pid === pid) {
        if (knownStartedAt === null || lock.startedAt !== knownStartedAt) {
          clean = false;
        } else {
          await unlink(this.paths.lockPath).catch(() => {
            clean = false;
          });
        }
      }
    }

    if (includeAttached) {
      const discovery = await readDiscovery(this.paths.discoveryPath);
      const verified = discovery && await this.#verifyLiveInstance(discovery)
        ? discovery
        : null;
      if (verified) {
        // 信号前二次读取，缩窄操作者重启/替换实例的竞态窗口。
        const confirmed = await readDiscovery(this.paths.discoveryPath);
        if (!sameDiscoveryInstance(confirmed, verified)) {
          clean = false;
        } else {
          if (pidAlive(verified.pid) && !await this.#stopPid(verified.pid, timeoutMs)) clean = false;
          if (!pidAlive(verified.pid)) {
            const removed = await this.#removeDiscoveryIfMatches(verified).catch(() => false);
            if (!removed && sameDiscoveryInstance(await readDiscovery(this.paths.discoveryPath), verified)) {
              clean = false;
            }
          }
        }
      } else if (discovery) {
        // 不可验证的 live PID 绝不 kill；只允许清理已退出实例的匹配 discovery。
        if (!pidAlive(discovery.pid)) {
          const removed = await this.#removeDiscoveryIfMatches(discovery).catch(() => false);
          if (!removed && sameDiscoveryInstance(await readDiscovery(this.paths.discoveryPath), discovery)) {
            clean = false;
          }
        } else {
          clean = false;
        }
      }
      const lock = await this.#readLockView();
      if (lock && lock.command === 'serve') {
        if (!pidAlive(lock.pid)) {
          await unlink(this.paths.lockPath).catch(() => {
            clean = false;
          });
        } else {
          // 只有 lock 与已验证 discovery 的 pid/startedAt 完全一致时才允许信号；
          // 否则可能是复用 PID 或陈旧锁，必须留给操作者处理并报告 incomplete。
          const matchesVerified = Boolean(verified)
            && verified.pid === lock.pid
            && verified.startedAt === lock.startedAt;
          if (!matchesVerified) {
            // discovery 已被 stop 删除时，从 start.lock + health/status identity + pid/startedAt 验证；
            // 不重建 discovery，也不对不可验证的复用 PID 发信号。
            const candidate = this.#discoveryFromLock(lock);
            const verifiedFromLock = candidate
              && await this.#verifyLiveInstance(candidate, { requireDiscovery: false });
            if (!verifiedFromLock) {
              clean = false;
            } else {
              const confirmedLock = await this.#readLockView();
              if (!confirmedLock
                || confirmedLock.pid !== lock.pid
                || confirmedLock.startedAt !== lock.startedAt
                || !pidAlive(lock.pid)) {
                clean = false;
              } else if (!await this.#stopPid(lock.pid, timeoutMs)) {
                clean = false;
              }
            }
          } else {
            const confirmedLock = await this.#readLockView();
            const confirmedDiscovery = await readDiscovery(this.paths.discoveryPath);
            if (!confirmedLock
              || confirmedLock.pid !== lock.pid
              || confirmedLock.startedAt !== lock.startedAt
              || !sameDiscoveryInstance(confirmedDiscovery, verified)
              || !pidAlive(lock.pid)) {
              clean = false;
            } else if (!await this.#stopPid(lock.pid, timeoutMs)) {
              clean = false;
            }
          }
        }
      }
      const remainingLock = await this.#readLockView();
      if (remainingLock && !pidAlive(remainingLock.pid)) {
        await unlink(this.paths.lockPath).catch(() => {
          clean = false;
        });
      }
    } else if (attachedDiscovery && !this.#homeMismatch(attachedDiscovery)
      && !this.#profileMismatch(attachedDiscovery)) {
      // D1：外部 PID 归操作者；仅撤销匹配 discovery，再验证旧凭据也无法工作。
      const capabilityBefore = await this.#capabilityFingerprint();
      await this.#removeDiscoveryIfMatches(attachedDiscovery).catch(() => false);
      if (pidAlive(attachedDiscovery.pid)
        && !await this.#waitAttachedDormant(
          attachedDiscovery,
          Math.max(timeoutMs, MEMORY_RUNTIME_ATTACHED_DORMANT_WAIT_MS),
        )) {
        clean = false;
      }
      let remaining = await readDiscovery(this.paths.discoveryPath);
      const needsDormant = (candidate) => candidate
        && !this.#homeMismatch(candidate)
        && !this.#profileMismatch(candidate)
        && !this.#versionMismatch(candidate)
        && (candidate.mode !== 'mcp' || candidate.state !== 'stopped');
      if (needsDormant(remaining)) {
        // 操作者可能在禁用期间替换实例；新实例同样必须撤销并验证，不能漏过。
        await this.#removeDiscoveryIfMatches(remaining).catch(() => false);
        if (pidAlive(remaining.pid)
          && !await this.#waitAttachedDormant(
            remaining,
            Math.max(timeoutMs, MEMORY_RUNTIME_ATTACHED_DORMANT_WAIT_MS),
          )) {
          clean = false;
        }
        remaining = await readDiscovery(this.paths.discoveryPath);
      }
      if (needsDormant(remaining)) clean = false;
      // 能力仍有效且凭据未撤销/未换代：不能把“可能被同一 token 唤醒”的实例报告为 clean stopped。
      const capabilityAfter = await this.#capabilityFingerprint();
      const credentialUnchanged = capabilityBefore === null
        ? capabilityAfter !== null
        : capabilityAfter === capabilityBefore;
      if (credentialUnchanged) clean = false;
      // 外部进程仍存活：记录停止时的 credential baseline（可能是 null=已撤销）。
      // 下一次 start 只有在当前凭据仍等于 baseline 时才允许报告 stopped。
      if (pidAlive(attachedDiscovery.pid)) {
        dormantBaseline = {
          pid: attachedDiscovery.pid,
          startedAt: attachedDiscovery.startedAt,
          credential: capabilityBefore,
        };
      }
    } else {
      // discovery 缺失时仍可能存活 manual/attached 实例：从 start.lock 验证 identity/token/status。
      const lock = await this.#readLockView();
      if (lock && lock.command === 'serve' && !pidAlive(lock.pid)) {
        await unlink(this.paths.lockPath).catch(() => {
          clean = false;
        });
      } else if (lock && lock.command === 'serve' && pidAlive(lock.pid)) {
        const capabilityBefore = await this.#capabilityFingerprint();
        const candidate = this.#discoveryFromLock(lock);
        const verified = candidate
          && await this.#verifyLiveInstance(candidate, { requireDiscovery: false });
        if (!verified) {
          clean = false;
        } else {
          const observed = await this.#readSidecarMode(candidate);
          if (!(observed?.mode === 'mcp' && observed.state === 'stopped')) {
            // 仍然 immersive/starting/degraded：没有确认 dormant，不能 clean。
            clean = false;
          } else {
            if (lock.pid !== this.child?.pid && lock.pid !== this.managedInstance?.pid) {
              dormantBaseline = {
                pid: lock.pid,
                startedAt: lock.startedAt,
                credential: capabilityBefore,
              };
            }
            const capabilityAfter = await this.#capabilityFingerprint();
            const credentialUnchanged = capabilityBefore === null
              ? capabilityAfter !== null
              : capabilityAfter === capabilityBefore;
            if (credentialUnchanged) clean = false;
          }
        }
      }
    }

    let dormantPersistError = null;
    if (dormantBaseline) {
      try {
        await this.#writeDormantState(dormantBaseline);
      } catch (error) {
        dormantPersistError = error;
        clean = false;
      }
    } else {
      await this.#clearDormantState();
    }

    if (clean) {
      this.managedInstance = null;
      this.dormantLock = null;
      this.dormantLockInvalidated = false;
      this.#setState({
        state: 'stopped', available: false, degraded: false, managed: false, attached: false,
        pid: null, url: null, healthUrl: null, error: null,
        reason: this.isEnabled() ? null : 'disabled', lock: null,
      });
    } else {
      this.#setState({
        state: 'degraded', available: false, degraded: true, managed: false,
        attached: Boolean(attachedDiscovery && pidAlive(attachedDiscovery.pid)),
        pid: attachedDiscovery && pidAlive(attachedDiscovery.pid) ? attachedDiscovery.pid : null,
        url: null, healthUrl: null,
        error: dormantPersistError
          ? publicError(includeAttached ? 'stop_incomplete' : 'disable_incomplete',
            `sidecar 休眠凭据基线写入失败（${dormantPersistError?.code ?? 'ERROR'}）`)
          : publicError(includeAttached ? 'stop_incomplete' : 'disable_incomplete',
            includeAttached ? 'sidecar 未能完整停止' : 'sidecar 未确认 dormant：禁用不完整'),
        reason: this.isEnabled() ? null : 'disabled', lock: this.lockView,
      });
    }
    this.stopping = false;
    return this.snapshot();
  }

  async restart({ includeAttached = false, timeoutMs = 5000, manual = false, force = true } = {}) {
    if (!includeAttached && !this.child) {
      const external = await readDiscovery(this.paths.discoveryPath);
      if (external && pidAlive(external.pid)) {
        // 配置变化不是操作者 restart：不撤销/替换 attached/manual 实例。
        return this.start({ force: false, manual: false });
      }
    }
    appendMemoryRuntimeLogSync(this.paths.dataDir, {
      level: 'info',
      event: 'supervisor_restart',
      reason: manual ? 'operator_restart' : 'config_restart',
    }, { now: this.now });
    await this.stop({ includeAttached, timeoutMs });
    this.crashTimes = [];
    this.restarts = 0;
    this.healthFailures = 0;
    return this.start({ force, manual });
  }

  async dispose() {
    this.disposed = true;
    const status = await this.stop({ includeAttached: false, timeoutMs: 3000 });
    this.disposed = true;
    if (!status.error) this.#setState({ reason: 'disposed', available: false });
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
