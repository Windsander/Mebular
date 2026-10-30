// Memory Runtime sidecar 配置与路径解析。
//
// 契约（0.3.0 contract v2 §1 / sidecar §3、§7）：
// - sidecar 数据目录固定 `<home>/memory-runtime/`；
// - 发现文件固定 `<home>/memory-runtime.json`；
// - 默认 HTTP `127.0.0.1:7341`，端口占用时允许回退到临时端口（0）；
// - 不得写入 `<home>/runtime/` 或 `<cloudRoot>/runtime/`（MCP daemon 安装根）。
//
// 本模块不 import @mebular/core，也不打开图/事件日志。

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { readJsonFile } from './atomic-json.js';

export const SIDECAR_PACKAGE_NAME = '@mebular/memory-runtime';
export const SIDECAR_RUNTIME_VERSION = '0.3.0';
export const SIDECAR_API_VERSION = 1;
export const SIDECAR_CAPABILITY_API_VERSION = 1;
export const SIDECAR_MIN_MCP_VERSION = '0.3.0';
export const SIDECAR_MAX_MCP_VERSION = '0.3.x';
export const SIDECAR_API_PREFIX = '/memory-runtime/v1';
export const DEFAULT_SIDECAR_HOST = '127.0.0.1';
export const DEFAULT_SIDECAR_PORT = 7341;
export const DEFAULT_MCP_PORT = 7331;
export const CAPABILITY_API_SUFFIX = '/internal/memory/v1';

export type SidecarConfigErrorCode =
  | 'config_invalid'
  | 'legacy_config_unsupported'
  | 'bind_not_loopback'
  | 'data_dir_forbidden'
  | 'capability_url_invalid';

export class SidecarConfigError extends Error {
  readonly code: SidecarConfigErrorCode;

  constructor(code: SidecarConfigErrorCode, message: string) {
    super(message);
    this.name = 'SidecarConfigError';
    this.code = code;
  }
}

export interface SidecarRetentionSettings {
  rawDays: number;
  traceDays: number;
  checkpointDays: number;
}

export interface SidecarModelSettings {
  source: 'heuristic' | 'local' | 'host' | 'api' | 'auto';
  local: {
    pack: string | null;
    path: string | null;
    threads: number;
    /** 显式 llama-server 可执行文件；缺省走 PATH。 */
    enginePath: string | null;
  };
  api: {
    baseUrl: string | null;
    model: string | null;
    /** 只接受 env:/file:/keychain: 引用；不接受明文密钥。 */
    keyRef: string | null;
    allowRemote: boolean;
    timeoutMs: number;
  };
}

export interface SidecarLimitSettings {
  maxChunkBytes: number;
  maxContextTokens: number;
  maxRecall: number;
  maxOutboxItems: number;
  maxOutboxBytes: number;
}

export interface SidecarRecallSettings {
  defaultLimit: number;
  injectionBudgetBytes: number;
  injectionBudgetTokens: number;
  timeoutMs: number;
  /** heuristic（默认）| model；model 仅在模型可用时做 query plan，失败保留原 query。 */
  queryPlan: 'heuristic' | 'model';
}

export interface SidecarContextSettings {
  maxTokens: number;
  maxFragments: number;
}

export interface SidecarHttpSettings {
  host: string;
  port: number;
}

export interface SidecarCapabilitySettings {
  /** 覆盖 MCP capability 基地址；缺省从 MEBULAR_MCP_URL / <home>/runtime.json 解析。 */
  url: string | null;
  timeoutMs: number;
}

export interface SidecarConfig {
  schema: 1;
  capture: 'off' | 'local';
  trace: 'off' | 'local';
  retention: SidecarRetentionSettings;
  model: SidecarModelSettings;
  limits: SidecarLimitSettings;
  recall: SidecarRecallSettings;
  context: SidecarContextSettings;
  queue: { concurrency: number };
  http: SidecarHttpSettings;
  idleStopMinutes: number;
  capability: SidecarCapabilitySettings;
}

export interface SidecarPaths {
  /** Mebular home（MEBULAR_HOME 或 ~/.mebular）。 */
  home: string;
  /** `<home>/memory-runtime`，可被 MEBULAR_MEMORY_RUNTIME_HOME 覆盖。 */
  dataDir: string;
  /** `<home>/memory-runtime.json`。 */
  discoveryPath: string;
  configPath: string;
  policyPath: string;
  hostTokenPath: string;
  capabilityTokenPath: string;
  startLockPath: string;
  rawDir: string;
  tracesPath: string;
  cacheDir: string;
  outboxDir: string;
  outboxDeadDir: string;
  logsDir: string;
  tmpDir: string;
  modelsDir: string;
}

export function defaultSidecarConfig(): SidecarConfig {
  return {
    schema: 1,
    capture: 'off',
    trace: 'local',
    retention: { rawDays: 7, traceDays: 7, checkpointDays: 30 },
    model: {
      source: 'heuristic',
      local: { pack: null, path: null, threads: 4, enginePath: null },
      api: {
        baseUrl: null,
        model: null,
        keyRef: null,
        allowRemote: false,
        timeoutMs: 10_000,
      },
    },
    limits: {
      maxChunkBytes: 262_144,
      maxContextTokens: 12_000,
      maxRecall: 50,
      maxOutboxItems: 1000,
      maxOutboxBytes: 16_777_216,
    },
    recall: {
      defaultLimit: 20,
      injectionBudgetBytes: 8192,
      injectionBudgetTokens: 2000,
      timeoutMs: 800,
      queryPlan: 'heuristic',
    },
    context: { maxTokens: 12_000, maxFragments: 3 },
    queue: { concurrency: 1 },
    http: { host: DEFAULT_SIDECAR_HOST, port: DEFAULT_SIDECAR_PORT },
    idleStopMinutes: 0,
    capability: { url: null, timeoutMs: 5000 },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function objectOf(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function enumOf<T extends string>(
  input: Record<string, unknown>,
  key: string,
  values: readonly T[],
  fallback: T,
): T {
  const value = input[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'string' && (values as readonly string[]).includes(value)) return value as T;
  throw new SidecarConfigError('config_invalid', `${key} 不是合法取值`);
}

function intOf(
  input: Record<string, unknown>,
  key: string,
  fallback: number,
  { min = 0, max = Number.MAX_SAFE_INTEGER }: { min?: number; max?: number } = {},
): number {
  const value = input[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max) {
    return value;
  }
  throw new SidecarConfigError('config_invalid', `${key} 必须是 ${min}–${max} 的整数`);
}

function boolOf(input: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = input[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  throw new SidecarConfigError('config_invalid', `${key} 必须是布尔值`);
}

function stringOrNullOf(input: Record<string, unknown>, key: string, fallback: string | null): string | null {
  const value = input[key];
  if (value === undefined) return fallback;
  if (value === null) return null;
  if (typeof value === 'string') return value.trim().length > 0 ? value.trim() : null;
  throw new SidecarConfigError('config_invalid', `${key} 必须是字符串或 null`);
}

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KEYCHAIN_REF_RE = /^[A-Za-z0-9._:@-]+(?:\/[A-Za-z0-9._:@-]+)?$/;

/**
 * 模型密钥只保存引用：env:NAME、file:relative/path、keychain:service[/account]。
 * 明文或未知前缀在配置阶段直接拒绝，避免写入 config.json。
 */
export function normalizeModelKeyRef(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new SidecarConfigError('config_invalid', 'model.api.keyRef 必须是字符串或 null');
  }
  const ref = value.trim();
  if (ref.length === 0) return null;
  if (ref.startsWith('env:')) {
    const name = ref.slice('env:'.length);
    if (!ENV_KEY_RE.test(name)) {
      throw new SidecarConfigError('config_invalid', 'model.api.keyRef 的 env: 变量名非法');
    }
    return `env:${name}`;
  }
  if (ref.startsWith('file:')) {
    const relative = ref.slice('file:'.length).trim();
    if (
      relative.length === 0
      || relative.startsWith('/')
      || relative.startsWith('\\')
      || /^[A-Za-z]:/.test(relative)
      || relative.split(/[\\/]/).includes('..')
      || /[\u0000-\u001f\u007f]/.test(relative)
    ) {
      throw new SidecarConfigError('config_invalid', 'model.api.keyRef 的 file: 必须是安全的相对路径');
    }
    return `file:${relative}`;
  }
  if (ref.startsWith('keychain:')) {
    const rest = ref.slice('keychain:'.length).trim();
    if (rest.length === 0 || rest.length > 256 || !KEYCHAIN_REF_RE.test(rest)
      || rest.startsWith('-') || rest.includes('/-')) {
      throw new SidecarConfigError('config_invalid', 'model.api.keyRef 的 keychain: 引用非法');
    }
    return `keychain:${rest}`;
  }
  throw new SidecarConfigError(
    'config_invalid',
    'model.api.keyRef 只接受 env:/file:/keychain: 引用，不接受明文密钥',
  );
}

/** 判断 host 是否为本机回环地址（localhost 解析为 loopback）。 */
export function isLoopbackHost(host: string): boolean {
  const normalized = String(host ?? '').trim().toLowerCase()
    .replace(/^\[/, '')
    .replace(/\]$/, '');
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1';
}

/** URL 中的 host 需要 IPv6 方括号。 */
export function formatHostForUrl(host: string): string {
  const value = String(host ?? '');
  return value.includes(':') && !value.startsWith('[') ? `[${value}]` : value;
}

/**
 * 禁止 sidecar 数据目录落到 MCP daemon 的安装根。
 * 覆盖契约 §1.2 / §6.1 的硬约束：不写 `<home>/runtime/`、`<cloudRoot>/runtime/`。
 */
export function assertSafeDataDir(dataDir: string, home: string): void {
  const resolvedHome = resolve(home);
  const resolvedData = resolve(dataDir);
  const homeRuntime = join(resolvedHome, 'runtime');
  const underHomeRuntime = resolvedData === homeRuntime || resolvedData.startsWith(`${homeRuntime}${sep}`);

  // `<cloudRoot>/runtime` / `<cloudRoot>/runtime/<version>`：daemon 安装根。
  const normalized = resolvedData.split(sep).join('/');
  const underCloudRuntime = /\/runtime\/\d+\.\d+\.\d+(?:[-+][^/]*)?(?:\/|$)/.test(normalized);
  const isRuntimeDir = basename(resolvedData) === 'runtime';

  if (underHomeRuntime || underCloudRuntime || isRuntimeDir) {
    throw new SidecarConfigError(
      'data_dir_forbidden',
      'sidecar 数据目录不能指向 MCP daemon 的 runtime 安装根',
    );
  }
}

export interface ResolveSidecarPathsOptions {
  home?: string;
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
}

export function resolveHomeDir({ home, env = process.env }: { home?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const fromEnv = env?.MEBULAR_HOME;
  const value = home ?? (typeof fromEnv === 'string' && fromEnv.trim().length > 0 ? fromEnv : join(homedir(), '.mebular'));
  return resolve(value);
}

export function resolveSidecarPaths({
  home,
  dataDir,
  env = process.env,
}: ResolveSidecarPathsOptions = {}): SidecarPaths {
  const resolvedHome = resolveHomeDir({ home, env });
  const envDataDir = env?.MEBULAR_MEMORY_RUNTIME_HOME;
  const override = dataDir
    ?? (typeof envDataDir === 'string' && envDataDir.trim().length > 0 ? envDataDir : undefined);
  const resolvedDataDir = override ? resolve(override) : join(resolvedHome, 'memory-runtime');
  assertSafeDataDir(resolvedDataDir, resolvedHome);

  return {
    home: resolvedHome,
    dataDir: resolvedDataDir,
    discoveryPath: join(resolvedHome, 'memory-runtime.json'),
    configPath: join(resolvedDataDir, 'config.json'),
    policyPath: join(resolvedDataDir, 'policy.json'),
    hostTokenPath: join(resolvedDataDir, 'host-token'),
    capabilityTokenPath: join(resolvedDataDir, 'capability-token'),
    startLockPath: join(resolvedDataDir, 'start.lock'),
    rawDir: join(resolvedDataDir, 'raw'),
    tracesPath: join(resolvedDataDir, 'traces.jsonl'),
    cacheDir: join(resolvedDataDir, 'cache'),
    outboxDir: join(resolvedDataDir, 'outbox'),
    outboxDeadDir: join(resolvedDataDir, 'outbox', 'dead'),
    logsDir: join(resolvedDataDir, 'logs'),
    tmpDir: join(resolvedDataDir, 'tmp'),
    modelsDir: join(resolvedDataDir, 'models'),
  };
}

function mergeDeep(base: Record<string, unknown>, override: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!override) return { ...base };
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (isObject(value) && isObject(out[key])) {
      out[key] = mergeDeep(out[key] as Record<string, unknown>, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * 旧原型配置/已删除选项必须显式失败，不能静默沿用。
 * 检测：顶层 runtime、顶层 sync、checkpoint/self 下的 sync。
 */
export function assertNoLegacyConfigKeys(input: Record<string, unknown>): void {
  if ('runtime' in input) {
    throw new SidecarConfigError('legacy_config_unsupported', '配置包含已删除的 runtime 配置组');
  }
  if ('sync' in input) {
    throw new SidecarConfigError('legacy_config_unsupported', '配置包含已删除的 sync 选项');
  }
  for (const group of ['checkpoint', 'self'] as const) {
    if (isObject(input[group]) && 'sync' in input[group]) {
      throw new SidecarConfigError('legacy_config_unsupported', `${group} 配置包含已删除的 sync 选项`);
    }
  }
}

/** 归一化 sidecar 设备配置；非法值抛 config_invalid，不部分应用。 */
export function normalizeSidecarConfig(raw: unknown): SidecarConfig {
  if (!isObject(raw)) {
    throw new SidecarConfigError('config_invalid', '配置必须是 JSON 对象');
  }
  assertNoLegacyConfigKeys(raw);

  const defaults = defaultSidecarConfig();
  if (raw.schema !== undefined && raw.schema !== 1) {
    throw new SidecarConfigError('config_invalid', '不支持的配置 schema');
  }

  const retention = objectOf(raw.retention);
  const model = objectOf(raw.model);
  const local = objectOf(model.local);
  const api = objectOf(model.api);
  const limits = objectOf(raw.limits);
  const recall = objectOf(raw.recall);
  const context = objectOf(raw.context);
  const queue = objectOf(raw.queue);
  const http = objectOf(raw.http);
  const capability = objectOf(raw.capability);

  const host = stringOrNullOf(http, 'host', defaults.http.host) ?? defaults.http.host;
  if (!isLoopbackHost(host)) {
    throw new SidecarConfigError('bind_not_loopback', 'sidecar HTTP 只允许绑定 loopback 地址');
  }

  return {
    schema: 1,
    capture: enumOf(raw, 'capture', ['off', 'local'] as const, defaults.capture),
    trace: enumOf(raw, 'trace', ['off', 'local'] as const, defaults.trace),
    retention: {
      rawDays: intOf(retention, 'rawDays', defaults.retention.rawDays),
      traceDays: intOf(retention, 'traceDays', defaults.retention.traceDays),
      checkpointDays: intOf(retention, 'checkpointDays', defaults.retention.checkpointDays),
    },
    model: {
      source: enumOf(model, 'source', ['heuristic', 'local', 'host', 'api', 'auto'] as const, defaults.model.source),
      local: {
        pack: stringOrNullOf(local, 'pack', defaults.model.local.pack),
        path: stringOrNullOf(local, 'path', defaults.model.local.path),
        threads: intOf(local, 'threads', defaults.model.local.threads, { min: 1 }),
        enginePath: stringOrNullOf(local, 'enginePath', defaults.model.local.enginePath),
      },
      api: {
        baseUrl: stringOrNullOf(api, 'baseUrl', defaults.model.api.baseUrl),
        model: stringOrNullOf(api, 'model', defaults.model.api.model),
        keyRef: normalizeModelKeyRef(api.keyRef ?? defaults.model.api.keyRef),
        allowRemote: boolOf(api, 'allowRemote', defaults.model.api.allowRemote),
        timeoutMs: intOf(api, 'timeoutMs', defaults.model.api.timeoutMs, { min: 1 }),
      },
    },
    limits: {
      maxChunkBytes: intOf(limits, 'maxChunkBytes', defaults.limits.maxChunkBytes, { min: 1 }),
      maxContextTokens: intOf(limits, 'maxContextTokens', defaults.limits.maxContextTokens, { min: 1 }),
      maxRecall: intOf(limits, 'maxRecall', defaults.limits.maxRecall, { min: 1 }),
      maxOutboxItems: intOf(limits, 'maxOutboxItems', defaults.limits.maxOutboxItems, { min: 1 }),
      maxOutboxBytes: intOf(limits, 'maxOutboxBytes', defaults.limits.maxOutboxBytes, { min: 1 }),
    },
    recall: {
      defaultLimit: intOf(recall, 'defaultLimit', defaults.recall.defaultLimit, { min: 1 }),
      injectionBudgetBytes: intOf(recall, 'injectionBudgetBytes', defaults.recall.injectionBudgetBytes, { min: 1 }),
      injectionBudgetTokens: intOf(recall, 'injectionBudgetTokens', defaults.recall.injectionBudgetTokens, { min: 1 }),
      timeoutMs: intOf(recall, 'timeoutMs', defaults.recall.timeoutMs, { min: 1 }),
      queryPlan: enumOf(recall, 'queryPlan', ['heuristic', 'model'] as const, defaults.recall.queryPlan),
    },
    context: {
      maxTokens: intOf(context, 'maxTokens', defaults.context.maxTokens, { min: 1 }),
      maxFragments: intOf(context, 'maxFragments', defaults.context.maxFragments, { min: 1 }),
    },
    queue: { concurrency: intOf(queue, 'concurrency', defaults.queue.concurrency, { min: 1, max: 4 }) },
    http: {
      host,
      port: intOf(http, 'port', defaults.http.port, { min: 0, max: 65_535 }),
    },
    idleStopMinutes: intOf(raw, 'idleStopMinutes', defaults.idleStopMinutes),
    capability: {
      url: stringOrNullOf(capability, 'url', defaults.capability.url),
      timeoutMs: intOf(capability, 'timeoutMs', defaults.capability.timeoutMs, { min: 1 }),
    },
  };
}

export interface LoadSidecarConfigOptions {
  home?: string;
  paths: SidecarPaths;
  env?: NodeJS.ProcessEnv;
  overrides?: Record<string, unknown>;
}

/** 读取 `<home>/memory-runtime/config.json`；不存在时使用安全默认。 */
export async function loadSidecarConfig({
  paths,
  overrides,
}: LoadSidecarConfigOptions): Promise<SidecarConfig> {
  let raw: Record<string, unknown> = {};
  let text: string | null = null;
  try {
    text = await readFile(paths.configPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (text !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new SidecarConfigError('config_invalid', '配置文件不是合法 JSON');
    }
    if (!isObject(parsed)) {
      throw new SidecarConfigError('config_invalid', '配置文件必须是 JSON 对象');
    }
    raw = parsed;
  }

  assertNoLegacyConfigKeys(raw);
  const merged = mergeDeep(raw, overrides);
  return normalizeSidecarConfig(merged);
}

function runtimeHostToLoopback(host: unknown): string {
  if (typeof host !== 'string' || host.trim().length === 0) return DEFAULT_SIDECAR_HOST;
  const value = host.trim();
  const normalized = value.toLowerCase();
  if (normalized === '0.0.0.0') return '127.0.0.1';
  if (normalized === '::' || normalized === '[::]') return '::1';
  return isLoopbackHost(value) ? value : DEFAULT_SIDECAR_HOST;
}

/** 规范 capability 基地址；只允许 loopback、http(s)、无 userinfo。 */
export function normalizeCapabilityBaseUrl(
  input: string,
  { appendSuffix = true }: { appendSuffix?: boolean } = {},
): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new SidecarConfigError('capability_url_invalid', 'capability URL 不合法');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SidecarConfigError('capability_url_invalid', 'capability URL 必须是 http(s)');
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new SidecarConfigError('capability_url_invalid', 'capability URL 不能包含 userinfo');
  }
  if (!isLoopbackHost(url.hostname)) {
    throw new SidecarConfigError('capability_url_invalid', 'capability URL 只允许 loopback');
  }
  if (appendSuffix && (url.pathname === '' || url.pathname === '/')) {
    url.pathname = CAPABILITY_API_SUFFIX;
  }
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.slice(0, -1);
  }
  return url.toString().replace(/\/$/, '');
}

export interface ResolveCapabilityBaseUrlOptions {
  home: string;
  env?: NodeJS.ProcessEnv;
  config?: Pick<SidecarConfig, 'capability'>;
}

/**
 * 解析 MCP capability 基地址。
 * 顺序：MEBULAR_CAPABILITY_URL > sidecar config.capability.url >
 *       MEBULAR_MCP_URL > <home>/runtime.json > 默认 127.0.0.1:7331。
 */
export async function resolveCapabilityBaseUrl({
  home,
  env = process.env,
  config,
}: ResolveCapabilityBaseUrlOptions): Promise<string> {
  const direct = stringOrNull(env?.MEBULAR_CAPABILITY_URL) ?? stringOrNull(config?.capability.url);
  if (direct) return normalizeCapabilityBaseUrl(direct);

  const mcpUrl = stringOrNull(env?.MEBULAR_MCP_URL);
  if (mcpUrl) {
    // MEBULAR_MCP_URL 可能带 /mcp 或 /healthz；capability 基地址只保留 origin。
    try {
      const parsed = new URL(mcpUrl);
      if (parsed.pathname === '/mcp' || parsed.pathname === '/healthz') parsed.pathname = '';
      return normalizeCapabilityBaseUrl(parsed.toString());
    } catch {
      return normalizeCapabilityBaseUrl(mcpUrl);
    }
  }

  const runtime = await readJsonFile<Record<string, unknown>>(join(home, 'runtime.json'));
  const http = objectOf(runtime?.http);
  const port = typeof http.port === 'number' && Number.isInteger(http.port) && http.port > 0
    ? http.port
    : null;
  if (port !== null) {
    const host = runtimeHostToLoopback(http.host);
    return normalizeCapabilityBaseUrl(`http://${formatHostForUrl(host)}:${port}${CAPABILITY_API_SUFFIX}`);
  }

  return `http://${DEFAULT_SIDECAR_HOST}:${DEFAULT_MCP_PORT}${CAPABILITY_API_SUFFIX}`;
}

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

function parseVersion(value: string): ParsedVersion | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compareVersion(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/** MCP 版本是否落在 sidecar 支持的 [min, max] 区间；max 支持 `0.3.x` 形式。 */
export function isMcpVersionCompatible(
  mcpVersion: string,
  minVersion = SIDECAR_MIN_MCP_VERSION,
  maxVersion = SIDECAR_MAX_MCP_VERSION,
): boolean {
  const version = parseVersion(mcpVersion);
  const min = parseVersion(minVersion);
  const max = parseVersion(maxVersion);
  if (!version || !min) return false;
  if (compareVersion(version, min) < 0) return false;
  if (max) return compareVersion(version, max) <= 0;

  const wildcard = /^(\d+)\.(\d+)\.x$/.exec(maxVersion.trim());
  if (!wildcard) return false;
  return version.major === Number(wildcard[1]) && version.minor <= Number(wildcard[2]);
}

/**
 * capability `/version` 握手是否兼容。
 * major 与 wire schema 必须为 1；MCP 版本必须在 sidecar 支持区间内。
 */
export function isCapabilityVersionCompatible(payload: unknown): boolean {
  const data = objectOf(payload);
  if (data.capabilityApiVersion !== SIDECAR_CAPABILITY_API_VERSION) return false;
  if (data.schemaVersion !== 1) return false;
  if (typeof data.mcpVersion !== 'string') return false;
  return isMcpVersionCompatible(data.mcpVersion);
}
