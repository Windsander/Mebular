// `mebular-memory-runtime` 的进程入口与 CLI。
//
// 命令：
//   mebular-memory-runtime serve [--home DIR] [--port N] [--parent-pid PID]
//   mebular-memory-runtime status [--home DIR] [--json]
//   mebular-memory-runtime version
//
// serve 的 W3a 职责：
// - 初始化本地 staging/Trace/detail cache/outbox；
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
  isDiscoveryDead,
  isDiscoveryStale,
  readDiscovery,
  touchDiscovery,
  writeDiscovery,
  type SidecarDiscovery,
  type SidecarMode,
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
  createSidecarInferenceProvider,
  type SidecarInferenceProvider,
  type InferenceStatus,
} from './inference-provider.js';
import { ModelStore } from '../inference/store.js';
import {
  EngineInstaller,
  LlamaCppInferenceEngine,
  InferenceService,
} from './inference/index.js';
import { SettlementRuntime } from './settlement.js';
import { LifecycleGate } from './lifecycle-gate.js';
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
  refreshCapabilityToken,
  removeHostTokenIfMatches,
} from './token.js';
import {
  StartLockError,
  acquireStartLock,
  isStartLockStale,
  readStartLock,
  releaseStartLock,
  updateStartLock,
  type StartLockRecord,
} from './start-lock.js';

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
  | 'already_running'
  | 'lock_conflict'
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
  model: SidecarInferenceProvider;
  inferenceService: InferenceService;
  settlement: SettlementRuntime;
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
  lock: (StartLockRecord & { stale: boolean }) | null;
}

export interface SidecarVersionResult {
  ok: true;
  runtimeVersion: string;
  apiVersion: number;
  capabilityApiVersion: number;
  minMcpVersion: string;
  maxMcpVersion: string;
  mode: 'immersive';
  nodeVersion: string;
  capabilities: {
    ingest: boolean;
    recall: boolean;
    context: boolean;
    feedback: boolean;
    traces: boolean;
    details: boolean;
    checkpoint: boolean;
    compact: boolean;
    self: boolean;
    models: {
      install: boolean;
      activate: boolean;
      catalog: boolean;
    };
    inference: {
      engine: boolean;
      sources: string[];
    };
  };
  details: {
    stagingHours: number;
    cacheDays: number;
    quotaBytesPerDomain: number;
    quotaBytesCloud: number;
    retentionDays: { conversation: number; tool_output: number; document_slice: number };
  };
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
  if (error instanceof StartLockError) {
    return new SidecarStartupError(error.code, error.exitCode, error.message);
  }
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

function isObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface CapabilityProbe {
  capability: SidecarStatusCapability;
  versionInfo: CapabilityVersionInfo | null;
  identity: CapabilityIdentity | null;
  detailQuota: { usedBytes: number | null; domainBytes: number | null; cloudBytes: number | null } | null;
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
    let detailQuota: CapabilityProbe['detailQuota'] = null;
    try {
      const status = await client.getStatus({
        actor: JSON.stringify({ type: 'user' }),
        includeCounts: 'true',
      });
      identity = status.data?.identity ?? null;
      const quota = isObject(status.data?.detailQuota) ? status.data.detailQuota : {};
      const counts = isObject(status.data?.counts) ? status.data.counts : {};
      detailQuota = {
        usedBytes: typeof counts.detailBytes === 'number' ? counts.detailBytes : null,
        domainBytes: typeof quota.domainBytes === 'number' ? quota.domainBytes : null,
        cloudBytes: typeof quota.cloudBytes === 'number' ? quota.cloudBytes : null,
      };
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
      detailQuota,
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
        detailQuota: null,
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

/** 启动 sidecar 进程主体；外层 wrapper 负责 start.lock 的获取/释放。 */
async function startSidecarProcess(options: StartSidecarOptions = {}): Promise<SidecarHandle> {
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
  const configWarnings: string[] = [];
  try {
    config = await loadSidecarConfig({ paths, env, overrides, warnings: configWarnings });
  } catch (error) {
    throw startupFromUnknown(error);
  }

  const localOptions: SidecarLocalLayerOptions = {
    root: paths.dataDir,
    stagingHours: config.detail.stagingHours,
    stagingBytes: config.detail.stagingBytes,
    traceRetentionDays: config.retention.traceDays,
    maxOutboxItems: config.limits.maxOutboxItems,
    maxOutboxBytes: config.limits.maxOutboxBytes,
    detailCacheDays: config.detail.cacheDays,
    detailCacheBytes: config.detail.cacheBytes,
    detailCacheMaxEntries: config.detail.cacheMaxEntries,
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
  let capabilityDetailQuota: CapabilityProbe['detailQuota'] = null;
  let warnings: string[] = [];
  let lifecycleMode: SidecarMode = 'immersive';
  let dormantReason: string | null = null;
  let dormantIncomplete = false;
  let requestDormant: ((reason: string) => Promise<boolean>) | null = null;
  const lifecycle = new LifecycleGate();

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
    // 生产实例即使由 env 引导，只要存在 capability-token 文件，401 刷新就必须以文件为准。
    let capabilityTokenFilePresent = false;
    try {
      capabilityTokenFilePresent = await readCapabilityToken({
        dataDir: paths.dataDir,
        env: {},
        now: now(),
      }) !== null;
    } catch {
      capabilityTokenFilePresent = false;
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
          const refreshed = await refreshCapabilityToken({
            dataDir: paths.dataDir,
            env,
            now: now(),
            // 从文件启动的生产实例：文件被撤销后不得回退到启动时的 stale env。
            allowEnvFallback: !capabilityTokenFilePresent,
          });
          return refreshed && !refreshed.expired ? refreshed.token : null;
        },
        onCapabilityRevoked: (error) => {
          Object.assign(capability, { reachable: false, error: error.code });
          if (requestDormant) void requestDormant(error.code);
        },
        lifecycle,
        timeoutMs: config.capability.timeoutMs,
      });
    } catch (error) {
      throw startupFromUnknown(error);
    }

    const probe = await probeCapability(client, now);
    capability = probe.capability;
    capabilityVersionInfo = probe.versionInfo;
    capabilityIdentity = probe.identity;
    capabilityDetailQuota = probe.detailQuota;
    warnings = [...probe.warnings];
  }

  const identity = mergeIdentity(paths.home, options.identity, capabilityIdentity);

  const engineInstaller = new EngineInstaller({
    dataDir: paths.dataDir,
    platform: process.platform,
    arch: process.arch,
    now,
  });
  const engineAdapter = new LlamaCppInferenceEngine({
    env,
    now,
    binaryPathProvider: () => engineInstaller.binaryPath(),
    requireBinaryPath: true,
  });
  const inferenceHolder: { current: InferenceService | null } = { current: null };
  const model = createSidecarInferenceProvider(config.model, {
    homeDir: paths.home,
    modelsDir: paths.modelsDir,
    env,
    now,
    localEngine: engineAdapter.asModelEngine(),
    createGateway: (options) => {
      if (!inferenceHolder.current) throw new Error('inference is not initialized');
      return inferenceHolder.current.createGateway(options);
    },
  });
  const inferenceService = new InferenceService({
    paths: {
      dataDir: paths.dataDir,
      modelsDir: paths.modelsDir,
      configPath: paths.configPath,
    },
    config,
    inference: model,
    store: new ModelStore({ rootDir: paths.modelsDir, now }),
    engineAdapter,
    engineInstaller,
    now,
    platform: process.platform,
    arch: process.arch,
  });
  inferenceHolder.current = inferenceService;
  try {
    await inferenceService.init();
  } catch {
    // inference 是可选能力；初始化失败只影响本地模型，不影响对话。
    configWarnings.push('inference_init_failed');
  }
  let modelStatus: InferenceStatus;
  try {
    modelStatus = await model.status();
  } catch {
    modelStatus = {
      configured: config.model.source,
      active: 'heuristic',
      degraded: true,
      reason: 'model_unavailable',
      warnings: ['model_unavailable'],
      credential: { configured: false, source: null },
      sources: ['heuristic', 'host'],
    };
  }

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

  let settlement: SettlementRuntime;
  let activeReplay: Promise<unknown> | null = null;
  try {
    settlement = new SettlementRuntime({
      config,
      local,
      client,
      identity,
      policyPath: paths.policyPath,
      inference: model,
      lifecycle,
      now,
    });
    // main 拥有生命周期边界；不修改 replayer，也绝不为了等待而启动新 replay。
    const replayOnce = settlement.replayer.replayOnce.bind(settlement.replayer);
    settlement.replayer.replayOnce = () => {
      const run = replayOnce();
      activeReplay = run;
      const clear = () => {
        if (activeReplay === run) activeReplay = null;
      };
      void run.then(clear, clear);
      return run;
    };
    const recordAttempt = local.outbox.recordAttempt.bind(local.outbox);
    const deadLetter = local.outbox.deadLetter.bind(local.outbox);
    local.outbox.recordAttempt = async (id, attempt) => {
      // 已开始的 replay 可能在撤销后才收到响应；不得再增长 payload/元数据。
      if (lifecycleMode === 'mcp') return local.outbox.get(id);
      return recordAttempt(id, attempt);
    };
    local.outbox.deadLetter = async (id, errorCode) => {
      // dormant 不创造 dead 副本；保留活动项，待重新授权后按原键处理。
      if (lifecycleMode === 'mcp') return false;
      return deadLetter(id, errorCode);
    };
    const enqueueOutbox = local.outbox.enqueue.bind(local.outbox);
    local.outbox.enqueue = async (input) => {
      // 所有 ingest/object/detail 入队共用的最后一道生命周期门闩。
      lifecycle.assertAccepting('outbox.enqueue');
      return enqueueOutbox(input);
    };
    await settlement.init();
  } catch (error) {
    throw new SidecarStartupError(
      'storage_unavailable',
      6,
      `沉降本地层不可用（${(error as NodeJS.ErrnoException)?.code ?? 'storage_error'}）`,
    );
  }

  const stopSettlementWithoutFlush = async (timeoutMs = 2000): Promise<boolean> => {
    let clean = true;
    try {
      await settlement.replayer.stop({ flushMs: 0 });
    } catch {
      clean = false;
    }
    if (activeReplay && !await settleWithin(activeReplay, timeoutMs)) clean = false;
    return clean;
  };

  const runtimeDegraded = () => dormantIncomplete
    || (!options.skipHandshake && !capability.reachable)
    || settlement.degraded
    || modelStatus.degraded;

  const statusSnapshot = async (): Promise<SidecarStatusSnapshot> => {
    try {
      modelStatus = await model.status();
    } catch {
      // 模型状态探测失败只影响展示，不阻塞 status；沿用最近一次不可用状态。
    }
    const mergedWarnings = [...configWarnings, ...warnings];
    if (dormantReason && !mergedWarnings.includes(dormantReason)) mergedWarnings.push(dormantReason);
    if (dormantIncomplete && !mergedWarnings.includes('dormant_incomplete')) mergedWarnings.push('dormant_incomplete');
    for (const warning of modelStatus.warnings) {
      if (!mergedWarnings.includes(warning)) mergedWarnings.push(warning);
    }
    const inferenceStatus = await inferenceService.status().catch(() => null);
    if (inferenceStatus) {
      for (const warning of inferenceStatus.warnings) {
        if (!mergedWarnings.includes(warning)) mergedWarnings.push(warning);
      }
    }
    return settlement.statusSnapshot({
      mode: lifecycleMode,
      identity: { ...identity },
      capability: { ...capability },
      model: modelStatus,
      ...(inferenceStatus ? { inference: inferenceStatus } : {}),
      limits: {
        maxChunkBytes: config.limits.maxChunkBytes,
        maxContextTokens: config.limits.maxContextTokens,
        maxRecall: config.limits.maxRecall,
      },
      details: {
        available: true,
        ...(capabilityDetailQuota
          ? {
            quota: {
              bytesPerDomain: capabilityDetailQuota.domainBytes ?? config.detail.quotaBytesPerDomain,
              bytesCloud: capabilityDetailQuota.cloudBytes ?? config.detail.quotaBytesCloud,
              usedBytes: capabilityDetailQuota.usedBytes,
              bytes: capabilityDetailQuota.cloudBytes,
            },
          }
          : {}),
      },
      warnings: mergedWarnings,
    });
  };

  const degraded = runtimeDegraded();
  const server = new SidecarServer({
    config,
    hostToken: hostToken.token,
    identity,
    getStatus: statusSnapshot,
    getModelStatus: () => model.status(),
    ingest: settlement,
    namespaces: settlement,
    recall: settlement,
    objects: settlement,
    inference: inferenceService,
    getDegraded: runtimeDegraded,
    state: 'starting',
    degraded: false,
    now,
    startedAt,
  });

  let listened;
  try {
    listened = await server.listen();
  } catch (error) {
    await stopSettlementWithoutFlush().catch(() => false);
    await removeHostTokenIfMatches(paths.hostTokenPath, hostToken.token).catch(() => undefined);
    throw startupFromUnknown(error);
  }

  let stopping = false;
  const discoveryCapabilities = (mode: SidecarMode) => ({
    ingest: mode === 'immersive',
    recall: mode === 'immersive',
    context: mode === 'immersive',
    details: mode === 'immersive',
    checkpoint: mode === 'immersive',
    compact: mode === 'immersive',
    self: mode === 'immersive',
    models: mode === 'immersive' ? modelStatus.sources : [],
  });
  const makeDiscovery = (mode: SidecarMode, state: SidecarState, isDegraded: boolean) => buildDiscovery({
    pid: process.pid,
    ...(options.parentPid !== undefined ? { parentPid: options.parentPid } : {}),
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
    state,
    mode,
    degraded: isDegraded,
    startedAt,
    updatedAt: now(),
    capabilities: discoveryCapabilities(mode),
  });
  let discovery: SidecarDiscovery;
  try {
    discovery = makeDiscovery('immersive', 'ready', degraded);
    await writeDiscovery(paths.discoveryPath, discovery);
  } catch (error) {
    await stopSettlementWithoutFlush().catch(() => false);
    await server.close().catch(() => undefined);
    await removeHostTokenIfMatches(paths.hostTokenPath, hostToken.token).catch(() => undefined);
    throw new SidecarStartupError(
      'storage_unavailable',
      6,
      `discovery 写入失败（${(error as NodeJS.ErrnoException)?.code ?? 'storage_error'}）`,
    );
  }

  const ownsDiscovery = (current: SidecarDiscovery | null) => current !== null
    && current.pid === process.pid
    && current.startedAt === startedAt;
  const publishDiscovery = async (
    mode: SidecarMode,
    state: SidecarState,
    isDegraded: boolean,
    { create = true }: { create?: boolean } = {},
  ): Promise<boolean> => {
    if (stopping) return false;
    const current = await readDiscovery(paths.discoveryPath);
    if (current && !ownsDiscovery(current)) return false;
    if (!current && !create) return false;
    const next = makeDiscovery(mode, state, isDegraded);
    await writeDiscovery(paths.discoveryPath, next);
    Object.assign(discovery, next);
    return true;
  };

  let heartbeatTask: Promise<void> = Promise.resolve();
  let heartbeatRunning = false;
  let dormantPromise: Promise<boolean> | null = null;
  let resumingPromise: Promise<void> | null = null;
  requestDormant = (reason: string): Promise<boolean> => {
    if (stopping) return Promise.resolve(false);
    if (resumingPromise) return resumingPromise.then(() => requestDormant!(reason));
    if (dormantPromise) return dormantPromise;
    if (lifecycleMode === 'mcp') return Promise.resolve(!dormantIncomplete);
    dormantPromise = (async () => {
      lifecycleMode = 'mcp';
      dormantReason = reason;
      // 同步撤销准入；后续 ingest/staging/model/capability 写与 outbox 入队立即 409。
      lifecycle.beginDrain(reason);
      // mcp+degraded 是 draining/incomplete；只有全部收尾后才发布 mcp+stopped。
      dormantIncomplete = true;
      server.setState('degraded');
      // setMode 同步撤销准入，再等待已接受请求；后续请求立即 409。
      const idle = server.setMode('mcp', { timeoutMs: 2000 });
      let clean = await stopSettlementWithoutFlush(2000);
      // 先让已接受的 host 请求结算，再清理模型引擎；否则新启动的引擎可能在停止后复活。
      if (!await idle) clean = false;
      try {
        const inference = await inferenceService.status();
        const install = inference.install;
        if (install && ['downloading', 'verifying', 'installing'].includes(install.state)) {
          await inferenceService.cancelInstall(install.jobId);
        }
        const packId = inference.engine.packId ?? inference.active.packId;
        if (packId && inference.engine.state !== 'stopped') {
          await inferenceService.stopEngine(packId);
        }
      } catch {
        clean = false;
      }
      // 晚到的成功结果不能被当作 clean 收尾：已失效的 capability 成功不是新提交证据。
      if (lifecycle.ambiguous) clean = false;
      dormantIncomplete = !clean;
      lifecycle.finishDrain();
      try {
        const current = await readDiscovery(paths.discoveryPath);
        if (current) {
          if (!ownsDiscovery(current)
            || !await publishDiscovery('mcp', clean ? 'stopped' : 'degraded', server.currentDegraded(), { create: false })) {
            clean = false;
            dormantIncomplete = true;
            server.setState('degraded');
          }
        }
      } catch {
        clean = false;
        dormantIncomplete = true;
      }
      server.setState(clean ? 'stopped' : 'degraded');
      return clean;
    })().finally(() => {
      dormantPromise = null;
    });
    return dormantPromise;
  };

  const refreshCapability = async (): Promise<boolean> => {
    if (!client) return false;
    const lastOkAt = capability.lastOkAt;
    try {
      const probe = await probeCapability(client, now);
      Object.assign(capability, probe.capability, {
        lastOkAt: probe.capability.reachable ? probe.capability.lastOkAt : lastOkAt,
      });
      capabilityVersionInfo = probe.versionInfo;
      capabilityDetailQuota = probe.detailQuota;
      warnings = [...probe.warnings];
      return probe.capability.reachable;
    } catch (error) {
      const code = error instanceof SidecarStartupError ? error.code : 'capability_unavailable';
      Object.assign(capability, {
        reachable: false,
        version: capability.version,
        lastOkAt,
        error: code,
      });
      warnings = [code];
      return false;
    }
  };

  const runHeartbeat = async (): Promise<void> => {
    if (stopping) return;
    modelStatus = await model.status().catch(() => modelStatus);
    const current = await readDiscovery(paths.discoveryPath).catch(() => null);
    if (current && !ownsDiscovery(current)) {
      await requestDormant('discovery_mismatch');
      return;
    }
    // discovery 被 MCP 显式撤销是独立休眠信号；MCP listener 已关闭时同样有效。
    if (!current && lifecycleMode === 'immersive') {
      await requestDormant('discovery_missing');
    }
    const reachable = client ? await refreshCapability() : options.skipHandshake === true;
    if (stopping) return;
    if (reachable) {
      if (lifecycleMode === 'mcp') {
        // 只有完整 drain 结束后才允许恢复；进行中的 drain 不能被旧的正向探测抢先撤销。
        if (dormantPromise || lifecycle.currentPhase !== 'dormant') return;
        dormantReason = null;
        dormantIncomplete = false;
        const nextDegraded = settlement.degraded || modelStatus.degraded;
        const resume = (async () => {
          try {
            if (!await publishDiscovery('immersive', nextDegraded ? 'degraded' : 'ready', nextDegraded)) {
              dormantReason = 'discovery_mismatch';
              dormantIncomplete = true;
              lifecycle.beginDrain('resume_failed');
              return;
            }
            lifecycleMode = 'immersive';
            lifecycle.resume();
            await server.setMode('immersive');
            server.setState(nextDegraded ? 'degraded' : 'ready');
            settlement.replayer.start();
          } catch {
            dormantReason = 'discovery_write_failed';
            dormantIncomplete = true;
            lifecycle.beginDrain('resume_failed');
          }
        })();
        const wrapped = resume.finally(() => {
          if (resumingPromise === wrapped) resumingPromise = null;
        });
        resumingPromise = wrapped;
        await wrapped;
        return;
      }
      const touched = await touchDiscovery(paths.discoveryPath, {
        pid: process.pid,
        startedAt,
        now: now(),
        state: server.currentDegraded() ? 'degraded' : 'ready',
        mode: 'immersive',
        degraded: server.currentDegraded(),
        capabilities: discoveryCapabilities('immersive'),
      });
      if (!touched) await requestDormant('discovery_missing');
      return;
    }

    if ((capability.error === 'capability_disabled' || capability.error === 'mode_mismatch')
      && lifecycleMode === 'immersive') {
      await requestDormant(capability.error);
    }
    await touchDiscovery(paths.discoveryPath, {
      pid: process.pid,
      startedAt,
      now: now(),
      state: lifecycleMode === 'immersive' ? 'degraded' : server.state,
      mode: lifecycleMode,
      degraded: true,
      capabilities: discoveryCapabilities(lifecycleMode),
    }).catch(() => false);
  };

  const heartbeat = setInterval(() => {
    if (stopping || heartbeatRunning) return;
    heartbeatRunning = true;
    heartbeatTask = runHeartbeat()
      .catch(() => {
        Object.assign(capability, { reachable: false, error: 'heartbeat_failed' });
        dormantIncomplete = true;
      })
      .finally(() => {
        heartbeatRunning = false;
      });
  }, heartbeatMs);
  heartbeat.unref?.();

  let resolveWait: (() => void) | null = null;
  const waitPromise = new Promise<void>((resolve) => {
    resolveWait = resolve;
  });

  let stopPromise: Promise<void> | null = null;
  let parentWatch: ReturnType<typeof setInterval> | null = null;
  const stop = (): Promise<void> => {
    if (!stopPromise) {
      stopPromise = (async () => {
        stopping = true;
        lifecycleMode = 'mcp';
        lifecycle.beginDrain('stopping');
        void server.setMode('mcp', { timeoutMs: 0 });
        clearInterval(heartbeat);
        if (parentWatch !== null) clearInterval(parentWatch);
        try {
          await settleWithin(heartbeatTask, 500);
          server.setState('stopping');
          // 每个故障独立隔离；任何 dispose 失败都不能跳过 HTTP/文件清理。
          await stopSettlementWithoutFlush(1500);
          await settleWithin(Promise.resolve().then(() => inferenceService.dispose()), 1500);
          await settleWithin(Promise.resolve().then(() => model.dispose()), 1500);
          await settleWithin(Promise.resolve().then(() => server.close()), 2500);
        } finally {
          await clearDiscovery(paths.discoveryPath, { pid: process.pid, startedAt }).catch(() => false);
          await removeHostTokenIfMatches(paths.hostTokenPath, hostToken.token).catch(() => false);
          resolveWait?.();
        }
      })();
    }
    return stopPromise;
  };

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
    model,
    inferenceService,
    settlement,
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

/**
 * 启动 sidecar；返回可停止的 handle（CLI、supervisor 与测试共用）。
 *
 * 单实例（contract §2.2）：先获取 `<dataDir>/start.lock`；已有存活实例时抛
 * `already_running`（exitCode 7），profile/忆云不匹配时抛 `lock_conflict`（exitCode 7）。
 * 陈旧锁自动清理后接管。停止时释放锁；SIGTERM/SIGINT 由 CLI main 触发同一条 stop 路径。
 */
export async function startSidecar(options: StartSidecarOptions = {}): Promise<SidecarHandle> {
  const env = options.env ?? process.env;
  let paths: SidecarPaths;
  try {
    paths = resolveSidecarPaths({ home: options.home, dataDir: options.dataDir, env });
  } catch (error) {
    throw startupFromUnknown(error);
  }
  const startedAt = options.startedAt ?? (options.now ?? Date.now)();

  try {
    await acquireStartLock({
      path: paths.startLockPath,
      pid: process.pid,
      startedAt,
      now: startedAt,
      command: 'serve',
      expectedCloudId: options.identity?.cloudId ?? null,
      expectedProfileId: options.identity?.profileId ?? null,
    });
  } catch (error) {
    throw startupFromUnknown(error);
  }

  let handle: SidecarHandle;
  try {
    // lock 与 discovery 必须属于同一实例身份；startedAt 只在这里生成一次。
    handle = await startSidecarProcess({ ...options, startedAt });
  } catch (error) {
    await releaseStartLock(paths.startLockPath, { pid: process.pid }).catch(() => false);
    throw error;
  }

  await updateStartLock(paths.startLockPath, {
    pid: process.pid,
    patch: {
      port: handle.discovery.port,
      cloudId: handle.discovery.cloudId,
      profileId: handle.discovery.profileId,
    },
  }).catch(() => false);

  const processStop = handle.stop;
  handle.stop = async (): Promise<void> => {
    try {
      await processStop();
    } finally {
      await releaseStartLock(paths.startLockPath, { pid: process.pid }).catch(() => false);
    }
  };
  return handle;
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
  const lock = await readStartLock(paths.startLockPath);
  const lockView = lock === null
    ? null
    : { ...lock, stale: isStartLockStale(lock, { now, pidAlive: isProcessAlive }) };
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
      lock: lockView,
    };
  }
  const alive = isProcessAlive(discovery.pid);
  const dead = !alive || isDiscoveryDead(discovery, now);
  const stale = dead || isDiscoveryStale(discovery, now);
  return {
    ok: true,
    installed: true,
    discovered: true,
    state: dead ? 'stopped' : discovery.state,
    stale,
    runtimeVersion: discovery.runtimeVersion,
    apiVersion: discovery.apiVersion,
    capabilityApiVersion: discovery.capabilityApiVersion,
    discovery,
    lock: lockView,
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
    mode: 'immersive',
    nodeVersion: process.version,
    capabilities: {
      ingest: true,
      recall: true,
      context: true,
      feedback: true,
      traces: true,
      details: true,
      checkpoint: true,
      compact: true,
      self: true,
      models: {
        install: true,
        activate: true,
        catalog: true,
      },
      inference: {
        engine: true,
        sources: ['heuristic', 'host', 'local', 'api'],
      },
    },
    details: {
      stagingHours: 24,
      cacheDays: 30,
      quotaBytesPerDomain: 268_435_456,
      quotaBytesCloud: 1_073_741_824,
      retentionDays: { conversation: 30, tool_output: 7, document_slice: 90 },
    },
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
