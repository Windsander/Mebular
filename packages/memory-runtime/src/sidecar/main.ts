// `mebular-memory-runtime` 的进程入口与 CLI。
//
// 命令：
//   mebular-memory-runtime serve [--home DIR] [--port N] [--parent-pid PID]
//   mebular-memory-runtime status [--home DIR] [--json]
//   mebular-memory-runtime version
//
// serve 的 W3a 职责：
// - 初始化本地 Raw/Trace/cache/outbox；
// - 读取 capability token 并做版本握手（可 --skip-handshake 跳过，测试/排障）；
// - 生成 host token、监听 loopback、写 `<home>/memory-runtime.json`；
// - 心跳更新 discovery；SIGINT/SIGTERM/父进程退出时优雅停止。
//
// 不实现 ingest/recall/context/模型；不打开图/事件日志；不自动启动 MCP daemon。

import { createHash } from 'node:crypto';
import {
  SIDECAR_API_VERSION,
  SIDECAR_CAPABILITY_API_VERSION,
  SIDECAR_MAX_MCP_VERSION,
  SIDECAR_MIN_MCP_VERSION,
  SIDECAR_RUNTIME_VERSION,
  SidecarConfigError,
  isCapabilityVersionCompatible,
  loadSidecarConfig,
  resolveCapabilityBaseUrl,
  resolveSidecarPaths,
  type SidecarConfig,
  type SidecarPaths,
} from './config.js';
import {
  buildDiscovery,
  clearDiscovery,
  isDiscoveryStale,
  readDiscovery,
  touchDiscovery,
  writeDiscovery,
  type SidecarDiscovery,
  type SidecarState,
} from './discovery.js';
import {
  CapabilityClient,
  CapabilityClientError,
  type CapabilityIdentity,
  type CapabilityVersionInfo,
} from './capability-client.js';
import {
  SidecarLocalLayer,
  type SidecarLocalLayerOptions,
} from './local-layer.js';
import {
  SidecarServer,
  SidecarServerError,
  type SidecarStatusCapability,
  type SidecarStatusIdentity,
  type SidecarStatusSnapshot,
} from './server.js';
import {
  TokenError,
  ensureHostToken,
  readCapabilityToken,
  removeHostTokenIfMatches,
} from './token.js';

export type SidecarStartupErrorCode =
  | 'invalid_request'
  | 'config_invalid'
  | 'legacy_config_unsupported'
  | 'data_dir_forbidden'
  | 'bind_not_loopback'
  | 'bind_failed'
  | 'capability_token_missing'
  | 'capability_token_expired'
  | 'capability_token_invalid'
  | 'token_permissions_insecure'
  | 'capability_disabled'
  | 'version_incompatible'
  | 'storage_unavailable'
  | 'internal';

export class SidecarStartupError extends Error {
  readonly code: SidecarStartupErrorCode;
  readonly exitCode: number;

  constructor(code: SidecarStartupErrorCode, exitCode: number, message: string) {
    super(message);
    this.name = 'SidecarStartupError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

export interface StartSidecarOptions {
  home?: string;
  dataDir?: string;
  port?: number;
  host?: string;
  parentPid?: number;
  skipHandshake?: boolean;
  env?: NodeJS.ProcessEnv;
  /** 测试/嵌入用；正常 serve 由 ensureHostToken 生成。 */
  hostToken?: string;
  identity?: Partial<SidecarStatusIdentity>;
  heartbeatMs?: number;
  parentCheckMs?: number;
  now?: () => number;
  startedAt?: number;
}

export interface SidecarHandle {
  pid: number;
  paths: SidecarPaths;
  config: SidecarConfig;
  local: SidecarLocalLayer;
  server: SidecarServer;
  discovery: SidecarDiscovery;
  capability: SidecarStatusCapability;
  capabilityVersionInfo: CapabilityVersionInfo | null;
  client: CapabilityClient | null;
  url: string;
  healthUrl: string;
  stop: () => Promise<void>;
  wait: () => Promise<void>;
}

export interface SidecarStatusResult {
  ok: true;
  installed: true;
  discovered: boolean;
  state: SidecarState;
  stale: boolean;
  runtimeVersion: string;
  apiVersion: number;
  capabilityApiVersion: number;
  discovery: SidecarDiscovery | null;
}

export interface SidecarVersionResult {
  ok: true;
  runtimeVersion: string;
  apiVersion: number;
  capabilityApiVersion: number;
  minMcpVersion: string;
  maxMcpVersion: string;
  nodeVersion: string;
}

function hostIdForHome(home: string): string {
  return `h_${createHash('sha256').update(home).digest('hex').slice(0, 16)}`;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function isSidecarProcessAlive(pid: number): boolean {
  return isProcessAlive(pid);
}

function startupFromConfigError(error: SidecarConfigError): SidecarStartupError {
  switch (error.code) {
    case 'legacy_config_unsupported':
      return new SidecarStartupError('legacy_config_unsupported', 3, error.message);
    case 'bind_not_loopback':
      return new SidecarStartupError('bind_not_loopback', 4, error.message);
    case 'data_dir_forbidden':
      return new SidecarStartupError('data_dir_forbidden', 3, error.message);
    case 'capability_url_invalid':
      return new SidecarStartupError('config_invalid', 3, error.message);
    case 'config_invalid':
    default:
      return new SidecarStartupError('config_invalid', 3, error.message);
  }
}

function startupFromUnknown(error: unknown): SidecarStartupError {
  if (error instanceof SidecarStartupError) return error;
  if (error instanceof SidecarConfigError) return startupFromConfigError(error);
  if (error instanceof TokenError) {
    return error.code === 'token_permissions_insecure'
      ? new SidecarStartupError('token_permissions_insecure', 5, error.message)
      : new SidecarStartupError('capability_token_invalid', 5, error.message);
  }
  if (error instanceof SidecarServerError) {
    return error.code === 'bind_not_loopback'
      ? new SidecarStartupError('bind_not_loopback', 4, error.message)
      : new SidecarStartupError('bind_failed', 4, error.message);
  }
  return new SidecarStartupError('internal', 1, (error as Error)?.message ?? 'sidecar 启动失败');
}

interface CapabilityProbe {
  capability: SidecarStatusCapability;
  versionInfo: CapabilityVersionInfo | null;
  identity: CapabilityIdentity | null;
  warnings: string[];
}

async function probeCapability(
  client: CapabilityClient,
  now: () => number,
): Promise<CapabilityProbe> {
  try {
    const version = await client.getVersion();
    if (!isCapabilityVersionCompatible(version.data)) {
      throw new SidecarStartupError(
        'version_incompatible',
        2,
        'capability API 版本与 sidecar 不兼容',
      );
    }
    let identity: CapabilityIdentity | null = null;
    try {
      const status = await client.getStatus({
        actor: JSON.stringify({ type: 'user' }),
        includeCounts: 'false',
      });
      identity = status.data?.identity ?? null;
    } catch {
      identity = null;
    }
    return {
      capability: {
        reachable: true,
        version: version.data.capabilityApiVersion,
        lastOkAt: now(),
        error: null,
      },
      versionInfo: version.data,
      identity,
      warnings: version.warnings,
    };
  } catch (error) {
    if (error instanceof SidecarStartupError) throw error;
    if (error instanceof CapabilityClientError) {
      if (error.code === 'capability_disabled' || error.code === 'capability_version_unsupported') {
        throw new SidecarStartupError(
          error.code === 'capability_disabled' ? 'capability_disabled' : 'version_incompatible',
          2,
          error.code === 'capability_disabled'
            ? 'MCP capability API 未启用（轻量模式不应启动 sidecar）'
            : 'capability API 版本不受支持',
        );
      }
      if (error.status === 401) {
        throw new SidecarStartupError('capability_token_invalid', 5, 'capability token 已失效');
      }
      if (error.status === 404) {
        throw new SidecarStartupError(
          'capability_disabled',
          2,
          'MCP capability API 不可用（0.2 或轻量模式）',
        );
      }
      // 网络/暂时不可用：失败开放，sidecar 以 degraded 状态启动，后续 W4 再接重试。
      return {
        capability: {
          reachable: false,
          version: null,
          lastOkAt: null,
          error: error.code,
        },
        versionInfo: null,
        identity: null,
        warnings: [error.code],
      };
    }
    throw startupFromUnknown(error);
  }
}

function mergeIdentity(
  home: string,
  explicit: Partial<SidecarStatusIdentity> | undefined,
  capability: CapabilityIdentity | null,
): SidecarStatusIdentity {
  return {
    cloudId: explicit?.cloudId ?? capability?.cloudId ?? null,
    profileId: explicit?.profileId ?? capability?.profileId ?? null,
    hostId: explicit?.hostId ?? capability?.hostId ?? hostIdForHome(home),
  };
}

/** 启动 sidecar；返回可停止的 handle（CLI 与测试共用）。 */
export async function startSidecar(options: StartSidecarOptions = {}): Promise<SidecarHandle> {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const startedAt = options.startedAt ?? now();
  const heartbeatMs = Math.max(50, Math.floor(options.heartbeatMs ?? 5000));

  let paths: SidecarPaths;
  try {
    paths = resolveSidecarPaths({ home: options.home, dataDir: options.dataDir, env });
  } catch (error) {
    throw startupFromUnknown(error);
  }

  const overrides: Record<string, unknown> = {};
  if (options.port !== undefined || options.host !== undefined) {
    overrides.http = {
      ...(options.port !== undefined ? { port: options.port } : {}),
      ...(options.host !== undefined ? { host: options.host } : {}),
    };
  }

  let config: SidecarConfig;
  try {
    config = await loadSidecarConfig({ paths, env, overrides });
  } catch (error) {
    throw startupFromUnknown(error);
  }

  const localOptions: SidecarLocalLayerOptions = {
    root: paths.dataDir,
    rawRetentionDays: config.retention.rawDays,
    traceRetentionDays: config.retention.traceDays,
    maxOutboxItems: config.limits.maxOutboxItems,
    maxOutboxBytes: config.limits.maxOutboxBytes,
    now,
  };
  const local = new SidecarLocalLayer(localOptions);
  try {
    await local.init();
  } catch (error) {
    throw new SidecarStartupError(
      'storage_unavailable',
      6,
      `sidecar 本地存储不可用（${(error as NodeJS.ErrnoException)?.code ?? 'storage_error'}）`,
    );
  }

  let client: CapabilityClient | null = null;
  let capability: SidecarStatusCapability = {
    reachable: false,
    version: null,
    lastOkAt: null,
    error: null,
  };
  let capabilityVersionInfo: CapabilityVersionInfo | null = null;
  let capabilityIdentity: CapabilityIdentity | null = null;
  let warnings: string[] = [];

  if (!options.skipHandshake) {
    let tokenRecord;
    try {
      tokenRecord = await readCapabilityToken({ dataDir: paths.dataDir, env, now: now() });
    } catch (error) {
      throw startupFromUnknown(error);
    }
    if (!tokenRecord) {
      throw new SidecarStartupError(
        'capability_token_missing',
        5,
        '找不到 capability token（MCP 未启用或未启动 sidecar）',
      );
    }
    if (tokenRecord.expired) {
      throw new SidecarStartupError('capability_token_expired', 5, 'capability token 已过期');
    }

    let baseUrl: string;
    try {
      baseUrl = await resolveCapabilityBaseUrl({ home: paths.home, env, config });
    } catch (error) {
      throw startupFromUnknown(error);
    }

    try {
      client = new CapabilityClient({
        baseUrl,
        token: tokenRecord.token,
        readToken: async () => {
          const refreshed = await readCapabilityToken({ dataDir: paths.dataDir, env, now: now() });
          return refreshed && !refreshed.expired ? refreshed.token : null;
        },
        timeoutMs: config.capability.timeoutMs,
      });
    } catch (error) {
      throw startupFromUnknown(error);
    }

    const probe = await probeCapability(client, now);
    capability = probe.capability;
    capabilityVersionInfo = probe.versionInfo;
    capabilityIdentity = probe.identity;
    warnings = [...probe.warnings];
  }

  const identity = mergeIdentity(paths.home, options.identity, capabilityIdentity);

  let hostToken;
  try {
    hostToken = await ensureHostToken({
      tokenFile: paths.hostTokenPath,
      env,
      token: options.hostToken,
      now: startedAt,
    });
  } catch (error) {
    throw new SidecarStartupError(
      'storage_unavailable',
      6,
      `host token 写入失败（${(error as NodeJS.ErrnoException)?.code ?? 'storage_error'}）`,
    );
  }

  const statusSnapshot = async (): Promise<SidecarStatusSnapshot> => {
    const [stats, outbox] = await Promise.all([local.stats(), local.outbox.stats()]);
    return {
      mode: 'immersive',
      identity: { ...identity },
      capability: { ...capability },
      model: {
        configured: 'heuristic',
        active: 'heuristic',
        degraded: false,
        reason: null,
      },
      counts: {
        rawChunks: stats.rawChunks,
        traces: stats.traces,
        cachedRecords: stats.cacheEntries,
        outbox: stats.outboxItems,
        deadLetter: stats.deadLetter,
      },
      outbox: {
        items: outbox.items,
        bytes: outbox.bytes,
        oldestAt: outbox.oldestAt,
      },
      limits: {
        maxChunkBytes: config.limits.maxChunkBytes,
        maxContextTokens: config.limits.maxContextTokens,
        maxRecall: config.limits.maxRecall,
      },
      warnings: [...warnings],
    };
  };

  const degraded = !options.skipHandshake && !capability.reachable;
  const server = new SidecarServer({
    config,
    hostToken: hostToken.token,
    identity,
    getStatus: statusSnapshot,
    state: 'starting',
    degraded,
    now,
    startedAt,
  });

  let listened;
  try {
    listened = await server.listen();
  } catch (error) {
    await removeHostTokenIfMatches(paths.hostTokenPath, hostToken.token).catch(() => undefined);
    throw startupFromUnknown(error);
  }

  let discovery: SidecarDiscovery;
  try {
    discovery = buildDiscovery({
      pid: process.pid,
      host: listened.host,
      port: listened.port,
      tokenFile: paths.hostTokenPath,
      cloudId: identity.cloudId,
      profileId: identity.profileId,
      runtimeVersion: SIDECAR_RUNTIME_VERSION,
      apiVersion: SIDECAR_API_VERSION,
      capabilityApiVersion: SIDECAR_CAPABILITY_API_VERSION,
      minMcpVersion: SIDECAR_MIN_MCP_VERSION,
      maxMcpVersion: SIDECAR_MAX_MCP_VERSION,
      state: 'ready',
      degraded,
      startedAt,
      updatedAt: now(),
      capabilities: {
        ingest: false,
        recall: false,
        context: false,
        checkpoint: false,
        compact: false,
        self: false,
        models: ['heuristic'],
      },
    });
    await writeDiscovery(paths.discoveryPath, discovery);
  } catch (error) {
    await server.close().catch(() => undefined);
    await removeHostTokenIfMatches(paths.hostTokenPath, hostToken.token).catch(() => undefined);
    throw new SidecarStartupError(
      'storage_unavailable',
      6,
      `discovery 写入失败（${(error as NodeJS.ErrnoException)?.code ?? 'storage_error'}）`,
    );
  }

  let stopping = false;
  let heartbeatTask: Promise<void> = Promise.resolve();
  const heartbeat = setInterval(() => {
    if (stopping) return;
    heartbeatTask = touchDiscovery(paths.discoveryPath, {
      pid: process.pid,
      now: now(),
      state: server.state,
      degraded: server.degraded,
    }).then(() => undefined).catch(() => undefined);
  }, heartbeatMs);
  heartbeat.unref?.();

  let resolveWait: (() => void) | null = null;
  const waitPromise = new Promise<void>((resolve) => {
    resolveWait = resolve;
  });

  let stopPromise: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    if (!stopPromise) {
      stopPromise = (async () => {
        stopping = true;
        clearInterval(heartbeat);
        if (parentWatch !== null) clearInterval(parentWatch);
        try {
          await heartbeatTask;
          await server.close();
        } catch {
          // 停止路径不阻塞退出；discovery/token 仍在 finally 清理。
        } finally {
          await clearDiscovery(paths.discoveryPath, { pid: process.pid }).catch(() => false);
          await removeHostTokenIfMatches(paths.hostTokenPath, hostToken.token).catch(() => false);
          resolveWait?.();
        }
      })();
    }
    return stopPromise;
  };

  let parentWatch: ReturnType<typeof setInterval> | null = null;
  if (options.parentPid !== undefined) {
    const parentPid = options.parentPid;
    const parentCheckMs = Math.max(50, Math.floor(options.parentCheckMs ?? 2000));
    parentWatch = setInterval(() => {
      if (!isProcessAlive(parentPid)) {
        void stop();
      }
    }, parentCheckMs);
    parentWatch.unref?.();
  }

  return {
    pid: process.pid,
    paths,
    config,
    local,
    server,
    discovery,
    capability,
    capabilityVersionInfo,
    client,
    url: listened.url,
    healthUrl: listened.healthUrl,
    stop,
    wait: () => waitPromise,
  };
}

/** 只读 status：读取 discovery，不返回 token。 */
export async function getSidecarStatus({
  home,
  dataDir,
  env = process.env,
  now = Date.now(),
}: {
  home?: string;
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
  now?: number;
} = {}): Promise<SidecarStatusResult> {
  const paths = resolveSidecarPaths({ home, dataDir, env });
  const discovery = await readDiscovery(paths.discoveryPath);
  if (!discovery) {
    return {
      ok: true,
      installed: true,
      discovered: false,
      state: 'stopped',
      stale: false,
      runtimeVersion: SIDECAR_RUNTIME_VERSION,
      apiVersion: SIDECAR_API_VERSION,
      capabilityApiVersion: SIDECAR_CAPABILITY_API_VERSION,
      discovery: null,
    };
  }
  const alive = isProcessAlive(discovery.pid);
  const stale = !alive || isDiscoveryStale(discovery, now);
  return {
    ok: true,
    installed: true,
    discovered: true,
    state: alive ? discovery.state : 'stopped',
    stale,
    runtimeVersion: discovery.runtimeVersion,
    apiVersion: discovery.apiVersion,
    capabilityApiVersion: discovery.capabilityApiVersion,
    discovery,
  };
}

export function getSidecarVersion(): SidecarVersionResult {
  return {
    ok: true,
    runtimeVersion: SIDECAR_RUNTIME_VERSION,
    apiVersion: SIDECAR_API_VERSION,
    capabilityApiVersion: SIDECAR_CAPABILITY_API_VERSION,
    minMcpVersion: SIDECAR_MIN_MCP_VERSION,
    maxMcpVersion: SIDECAR_MAX_MCP_VERSION,
    nodeVersion: process.version,
  };
}

const USAGE = `用法：
  mebular-memory-runtime serve [--home DIR] [--data-dir DIR] [--port N] [--host HOST] [--parent-pid PID]
  mebular-memory-runtime status [--home DIR] [--data-dir DIR]
  mebular-memory-runtime version

说明：serve 启动 Memory Runtime sidecar（/memory-runtime/v1）。轻量 MCP 模式不应启动它。`;

function cliValue(
  args: string[],
  index: number,
  inline: string | undefined,
  name: string,
): { value: string; next: number } {
  if (inline !== undefined) {
    if (inline.length === 0) {
      throw new SidecarStartupError('invalid_request', 1, `${name} 需要一个值`);
    }
    return { value: inline, next: index + 1 };
  }
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new SidecarStartupError('invalid_request', 1, `${name} 需要一个值`);
  }
  return { value, next: index + 2 };
}

function parseInteger(value: string, name: string, { min, max }: { min: number; max: number }): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new SidecarStartupError('invalid_request', 1, `${name} 必须是 ${min}–${max} 的整数`);
  }
  return parsed;
}

function parseServeArgs(args: string[]): StartSidecarOptions {
  const options: StartSidecarOptions = {};
  for (let index = 0; index < args.length;) {
    const arg = args[index]!;
    const equals = arg.indexOf('=');
    const name = equals >= 0 ? arg.slice(0, equals) : arg;
    const inline = equals >= 0 ? arg.slice(equals + 1) : undefined;
    if (name === '--home') {
      const { value, next } = cliValue(args, index, inline, name);
      options.home = value;
      index = next;
      continue;
    }
    if (name === '--data-dir') {
      const { value, next } = cliValue(args, index, inline, name);
      options.dataDir = value;
      index = next;
      continue;
    }
    if (name === '--port') {
      const { value, next } = cliValue(args, index, inline, name);
      options.port = parseInteger(value, name, { min: 0, max: 65_535 });
      index = next;
      continue;
    }
    if (name === '--host') {
      const { value, next } = cliValue(args, index, inline, name);
      options.host = value;
      index = next;
      continue;
    }
    if (name === '--parent-pid') {
      const { value, next } = cliValue(args, index, inline, name);
      options.parentPid = parseInteger(value, name, { min: 1, max: Number.MAX_SAFE_INTEGER });
      index = next;
      continue;
    }
    if (name === '--skip-handshake') {
      options.skipHandshake = true;
      index += 1;
      continue;
    }
    if (name === '--foreground' || name === '--json') {
      index += 1;
      continue;
    }
    throw new SidecarStartupError('invalid_request', 1, `未知参数：${name}`);
  }
  return options;
}

function parseStatusArgs(args: string[]): { home?: string; dataDir?: string } {
  const parsed = parseServeArgs(args.filter((arg) => arg !== '--json'));
  return { home: parsed.home, dataDir: parsed.dataDir };
}

/**
 * CLI 主入口；返回进程退出码。
 * 不在这里 process.exit，便于测试与嵌入。
 */
export async function main(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const command = argv[0] ?? 'help';
  try {
    if (command === 'serve') {
      const options = parseServeArgs(argv.slice(1));
      const handle = await startSidecar({ ...options, env });
      process.stdout.write(`${JSON.stringify({
        ok: true,
        command: 'serve',
        state: 'ready',
        pid: handle.pid,
        url: handle.url,
        healthUrl: handle.healthUrl,
        discoveryPath: handle.paths.discoveryPath,
        degraded: handle.server.degraded,
      })}\n`);

      const shutdown = (): void => {
        void handle.stop();
      };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
      await handle.wait();
      process.removeListener('SIGINT', shutdown);
      process.removeListener('SIGTERM', shutdown);
      return 0;
    }

    if (command === 'status') {
      const options = parseStatusArgs(argv.slice(1));
      const status = await getSidecarStatus({ ...options, env });
      process.stdout.write(`${JSON.stringify(status)}\n`);
      return 0;
    }

    if (command === 'version') {
      process.stdout.write(`${JSON.stringify(getSidecarVersion())}\n`);
      return 0;
    }

    if (command === 'help' || command === '--help' || command === '-h') {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    }

    throw new SidecarStartupError('invalid_request', 1, `未知命令：${command}`);
  } catch (error) {
    const startup = startupFromUnknown(error);
    process.stderr.write(`${JSON.stringify({
      ok: false,
      error: {
        code: startup.code,
        message: startup.message,
      },
    })}\n`);
    return startup.exitCode;
  }
}

