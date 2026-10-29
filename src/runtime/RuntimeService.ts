// RuntimeService（G0/G1 最小底座，contract §6.3.1 / §6.3.2）
//
// 本阶段只实现设备级状态与模式切换：
//   - status：身份 / 模式 / 能力 / 模型 / 计数 / 同步 / limits 骨架；
//   - mode：mcp ↔ immersive 读取与切换（不迁移、不重写、不删除任何节点）。
//
// ingest / recall / context / compact / checkpoint / self 业务**尚未实现**；
// 方法保留清晰签名并显式抛 `runtime_not_implemented`，避免静默假成功。

import { createHash } from 'node:crypto';
import type { GraphStore } from '../core/GraphStore.js';
import type { IdentityManager } from '../crypto/IdentityManager.js';
import type { SyncManager } from '../sync/syncmgr/SyncManager.js';
import type { Node } from '../types/index.js';
import { isRuntimeInternalNode } from './internal.js';
import { RuntimeLocalStore } from './local-store.js';
import {
  normalizeRuntimeSettings,
  type RuntimeSettings,
} from './config.js';
import {
  RUNTIME_MODES,
  type CandidateRecord,
  type MemoryRecordView,
  type RawChunk,
  type RuntimeCaptureMode,
  type RuntimeMode,
  type RuntimeModelSource,
  type RuntimeTraceMode,
} from './types.js';

export interface RuntimeServiceHost {
  readonly deviceId: string;
  readonly identity: Pick<IdentityManager, 'getUserMasterPublicKey'>;
  readonly graph: Pick<GraphStore, 'listNodes'>;
  readonly sync?: Pick<SyncManager, 'getSyncStatus' | 'getSubscriptionNamespaces'>;
  readonly node?: { isRunning(): boolean } | null;
  readonly atRestEncryption?: boolean;
}

export interface RuntimeServiceOptions {
  /** 原始 `config.runtime` 配置组（缺失即全部默认） */
  runtime?: unknown;
  /** 显式初始模式（优先于 runtime.mode） */
  mode?: RuntimeMode;
  /** `<home>/runtime`；提供后启用本地 Raw/Trace 存储 */
  runtimeDir?: string;
  /** 宿主 home 的稳定键（hostId 派生；通常传 MCP 的 homeKey(home)） */
  hostKey?: string;
  profileId?: string | null;
  agentId?: string;
  userId?: string;
  cloudId?: string;
  hostId?: string;
  version?: string;
  now?: () => number;
  localStore?: RuntimeLocalStore;
  /** 可选：模式切换后的持久化钩子（HTTP 路由默认用原子写 config.json） */
  persistMode?: (mode: RuntimeMode) => Promise<void> | void;
}

export interface RuntimeIdentityStatus {
  cloudId: string | null;
  userId: string | null;
  profileId: string | null;
  deviceId: string;
  hostId: string;
  agentId: string;
}

export interface RuntimeCapabilitiesStatus {
  mcpTools: boolean;
  ingest: boolean;
  recall: boolean;
  context: boolean;
  checkpoint: boolean;
  compact: boolean;
  rawCapture: RuntimeCaptureMode;
  trace: RuntimeTraceMode;
  modelSources: RuntimeModelSource[];
}

export interface RuntimeModelStatus {
  configured: RuntimeModelSource;
  active: RuntimeModelSource;
  degraded: boolean;
  reason: string | null;
  credential: { configured: boolean; source: 'env' | 'keychain' | 'file' | null };
}

export interface RuntimeCounts {
  memoryRecords: number;
  compacts: number;
  checkpoints: number;
  selfRecords: number;
  localRawChunks: number;
}

export interface RuntimeSyncStatus {
  running: boolean;
  pendingEvents: number;
  namespaces: string[];
}

export interface RuntimeStatus {
  version: string;
  initialized: boolean;
  mode: RuntimeMode;
  identity: RuntimeIdentityStatus;
  capabilities: RuntimeCapabilitiesStatus;
  model: RuntimeModelStatus;
  counts: RuntimeCounts;
  sync: RuntimeSyncStatus;
  limits: RuntimeSettings['limits'];
  warnings: string[];
}

export interface RuntimeModeChange {
  mode: RuntimeMode;
  changed: boolean;
  requiresRestart: false;
  capabilities: Pick<RuntimeCapabilitiesStatus, 'ingest' | 'recall' | 'context' | 'checkpoint' | 'compact'>;
}

// ---------- 后续阶段接口（本阶段仅占位） ----------

export interface RuntimeIngestRequest {
  requestId?: string;
  agentId: string;
  threadId?: string;
  namespace?: string;
  source?: 'host' | 'runtime' | 'mcp';
  capture?: RuntimeCaptureMode;
  allowRemote?: boolean;
  chunks?: RawChunk[];
  extractor?: RuntimeModelSource | 'user';
  candidates?: CandidateRecord[];
}

export interface RuntimeIngestResult {
  accepted: { chunks: number; records: number };
  rawChunkIds: string[];
  records: Array<{ id: string; type: string; kind?: string; namespace: string }>;
  extraction: { id: string; status: 'pending' | 'completed' | 'failed'; extractor: string; model?: string };
  duplicate: boolean;
  warnings: string[];
}

export interface RuntimeRecallRequest {
  query: string;
  agentId: string;
  threadId?: string;
  namespaces?: string[];
  types?: string[];
  limit?: number;
  tokenBudget?: number;
  includeHistory?: boolean;
  filters?: { tags?: string[]; minConfidence?: number };
}

export interface RuntimeRecallResult {
  records: MemoryRecordView[];
  total: number;
  traceId?: string;
  degraded: boolean;
  model: { query?: string; embedding?: string };
  tookMs: number;
}

export interface RuntimeContextBlock {
  kind: 'self' | 'checkpoint' | 'compact' | 'memory';
  content: string;
  citations: Array<{ id: string; type?: string }>;
  tokens: number;
  agentId?: string;
  threadId?: string;
  revision?: number;
  compactId?: string;
}

export interface RuntimeContextRequest {
  agentId: string;
  threadId?: string;
  query?: string;
  tokenBudget?: number;
  namespaces?: string[];
  includeCheckpoint?: boolean;
  includeSelf?: boolean;
}

export interface RuntimeContextResult {
  blocks: RuntimeContextBlock[];
  estimatedTokens: number;
  truncated: boolean;
  traceId?: string;
  degraded: boolean;
}

export type RuntimeCheckpointResult = { checkpoint: unknown | null };
export type RuntimeSelfResult = { self: unknown | null };
export type RuntimeObjectResult = { object: unknown | null };

export class RuntimeNotImplementedError extends Error {
  readonly code = 'runtime_not_implemented';
  readonly operation: string;

  constructor(operation: string) {
    super(`Runtime 接口尚未实现：${operation}`);
    this.name = 'RuntimeNotImplementedError';
    this.operation = operation;
  }
}

export class RuntimeModeError extends Error {
  readonly code = 'invalid_mode';

  constructor(mode: unknown) {
    super(`非法 Runtime 模式：${String(mode)}（可选：${RUNTIME_MODES.join(' | ')}）`);
    this.name = 'RuntimeModeError';
  }
}

const MEMORY_RECORD_TYPES = new Set(['entity', 'fact', 'episode', 'skill', 'meta']);

export class RuntimeService {
  private readonly host: RuntimeServiceHost;
  private readonly options: RuntimeServiceOptions;
  private readonly settings: RuntimeSettings;
  private readonly localStore: RuntimeLocalStore | null;
  private readonly version: string;
  private readonly cloudId: string | null;
  private readonly userId: string | null;
  private readonly hostId: string;
  private readonly agentId: string;
  private readonly profileId: string | null;
  private mode: RuntimeMode;
  private initPromise: Promise<void> | null = null;

  constructor(host: RuntimeServiceHost, options: RuntimeServiceOptions = {}) {
    this.host = host;
    this.options = options;
    this.settings = normalizeRuntimeSettings(options.runtime);
    this.mode = options.mode ?? this.settings.mode;
    if (!RUNTIME_MODES.includes(this.mode)) throw new RuntimeModeError(this.mode);

    this.version = options.version ?? '0.3.0';
    this.profileId = options.profileId ?? null;
    this.agentId = options.agentId ?? 'mebular';
    this.localStore = options.localStore ?? (options.runtimeDir
      ? new RuntimeLocalStore({
          root: options.runtimeDir,
          rawRetentionDays: this.settings.retention.rawDays,
          traceRetentionDays: this.settings.retention.traceDays,
          ...(options.now ? { now: options.now } : {}),
        })
      : null);

    const digest = identityDigest(host);
    this.cloudId = options.cloudId ?? (digest ? `cl_${digest.slice(0, 32)}` : null);
    this.userId = options.userId ?? (digest ? `u_${digest.slice(0, 16)}` : null);
    this.hostId = options.hostId ?? deriveHostId(host.deviceId, options.hostKey ?? options.runtimeDir ?? 'local');
  }

  /** 启动时加载本地对象并清理过期数据；可重复调用。 */
  async init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        await this.localStore?.init();
      })();
    }
    return this.initPromise;
  }

  getMode(): RuntimeMode {
    return this.mode;
  }

  getSettings(): RuntimeSettings {
    return {
      ...this.settings,
      retention: { ...this.settings.retention },
      model: {
        ...this.settings.model,
        local: { ...this.settings.model.local },
        api: { ...this.settings.model.api },
      },
      checkpoint: { ...this.settings.checkpoint },
      self: { ...this.settings.self },
      limits: { ...this.settings.limits },
    };
  }

  /**
   * 切换设备级模式。只改配置状态，不迁移、不复制、不改写任何节点。
   * 持久化由调用方（HTTP 路由）用原子写完成；`persistMode` 可注入。
   */
  async setMode(mode: RuntimeMode): Promise<RuntimeModeChange> {
    if (!RUNTIME_MODES.includes(mode)) throw new RuntimeModeError(mode);
    const previous = this.mode;
    const changed = previous !== mode;
    this.mode = mode;
    this.settings.mode = mode;
    if (changed && this.options.persistMode) {
      await this.options.persistMode(mode);
    }
    return this.modeChange(changed);
  }

  async status(): Promise<RuntimeStatus> {
    await this.init();
    if (this.localStore) {
      await this.localStore.cleanupIfDue().catch(() => null);
    }
    const { counts, initialized, namespaces, pendingEvents } = await this.collectStatusFacts();
    return {
      version: this.version,
      initialized,
      mode: this.mode,
      identity: {
        cloudId: this.cloudId,
        userId: this.userId,
        profileId: this.profileId,
        deviceId: this.host.deviceId,
        hostId: this.hostId,
        agentId: this.agentId,
      },
      capabilities: this.capabilities(),
      model: this.modelStatus(),
      counts,
      sync: {
        running: this.host.node?.isRunning() ?? false,
        pendingEvents,
        namespaces,
      },
      limits: { ...this.settings.limits },
      warnings: this.warnings(),
    };
  }

  async localStats(): Promise<{ rawChunks: number; traces: number } | null> {
    if (!this.localStore) return null;
    const stats = await this.localStore.stats();
    return { rawChunks: stats.rawChunks, traces: stats.traces };
  }

  // ---------- 后续阶段：显式未实现 ----------

  async ingest(_request: RuntimeIngestRequest): Promise<RuntimeIngestResult> {
    throw new RuntimeNotImplementedError('ingest');
  }

  async recall(_request: RuntimeRecallRequest): Promise<RuntimeRecallResult> {
    throw new RuntimeNotImplementedError('recall');
  }

  async context(_request: RuntimeContextRequest): Promise<RuntimeContextResult> {
    throw new RuntimeNotImplementedError('context');
  }

  async getCheckpoint(_threadId: string, _agentId: string): Promise<RuntimeCheckpointResult> {
    throw new RuntimeNotImplementedError('checkpoint.get');
  }

  async putCheckpoint(_threadId: string, _checkpoint: unknown): Promise<RuntimeCheckpointResult> {
    throw new RuntimeNotImplementedError('checkpoint.put');
  }

  async deleteCheckpoint(_threadId: string, _agentId: string): Promise<{ deleted: boolean }> {
    throw new RuntimeNotImplementedError('checkpoint.delete');
  }

  async compact(_request: unknown): Promise<unknown> {
    throw new RuntimeNotImplementedError('compact');
  }

  async getSelf(_agentId: string): Promise<RuntimeSelfResult> {
    throw new RuntimeNotImplementedError('self.get');
  }

  async putSelf(_agentId: string, _self: unknown): Promise<RuntimeSelfResult> {
    throw new RuntimeNotImplementedError('self.put');
  }

  async getObject(_id: string, _options: { includeContent?: boolean } = {}): Promise<RuntimeObjectResult> {
    throw new RuntimeNotImplementedError('objects.get');
  }

  async getTrace(_id: string): Promise<unknown | null> {
    throw new RuntimeNotImplementedError('traces.get');
  }

  async traceFeedback(_traceId: string, _feedback: unknown): Promise<{ recorded: boolean }> {
    throw new RuntimeNotImplementedError('recall.feedback');
  }

  // ---------- 内部 ----------

  private async collectStatusFacts(): Promise<{
    counts: RuntimeCounts;
    initialized: boolean;
    namespaces: string[];
    pendingEvents: number;
  }> {
    let nodes: Node[] = [];
    let initialized = false;
    try {
      nodes = await this.host.graph.listNodes({});
      initialized = true;
    } catch {
      nodes = [];
    }

    const active = nodes.filter((node) => !node.deletedAt);
    const counts: RuntimeCounts = {
      memoryRecords: active.filter(
        (node) => MEMORY_RECORD_TYPES.has(node.type) && !isRuntimeInternalNode(node),
      ).length,
      compacts: active.filter((node) => node.type === 'compact').length,
      checkpoints: active.filter((node) => node.type === 'context_checkpoint').length,
      selfRecords: active.filter((node) => node.type === 'self_record').length,
      localRawChunks: this.localStore ? await this.localStore.countRawChunks() : 0,
    };

    let pendingEvents = 0;
    let namespaces: string[] = [];
    try {
      if (this.host.sync) {
        const syncStatus = await this.host.sync.getSyncStatus();
        pendingEvents = syncStatus.pendingCount ?? 0;
        namespaces = [...this.host.sync.getSubscriptionNamespaces()];
      }
    } catch {
      // 同步未启动/未初始化：保持 0 / 空，不影响 status。
    }

    return { counts, initialized, namespaces, pendingEvents };
  }

  private capabilities(): RuntimeCapabilitiesStatus {
    return {
      mcpTools: true,
      ingest: false,
      recall: false,
      context: false,
      checkpoint: false,
      compact: false,
      rawCapture: this.settings.capture,
      trace: this.settings.trace,
      modelSources: ['heuristic'],
    };
  }

  private modelStatus(): RuntimeModelStatus {
    const configured = this.settings.model.source;
    const active: RuntimeModelSource = 'heuristic';
    const keyRef = this.settings.model.api.keyRef;
    return {
      configured,
      active,
      degraded: configured !== 'heuristic',
      reason: configured === 'heuristic' ? null : 'runtime_model_not_implemented',
      credential: {
        configured: keyRef !== null,
        source: credentialSource(keyRef),
      },
    };
  }

  private modeChange(changed: boolean): RuntimeModeChange {
    const capabilities = this.capabilities();
    return {
      mode: this.mode,
      changed,
      requiresRestart: false,
      capabilities: {
        ingest: capabilities.ingest,
        recall: capabilities.recall,
        context: capabilities.context,
        checkpoint: capabilities.checkpoint,
        compact: capabilities.compact,
      },
    };
  }

  private warnings(): string[] {
    const warnings: string[] = [];
    if (this.settings.capture === 'local' && this.host.atRestEncryption !== true) {
      warnings.push('rawCaptureUnencrypted');
    }
    if (!this.cloudId) warnings.push('cloud_identity_unavailable');
    return warnings;
  }
}

function identityDigest(host: RuntimeServiceHost): string | null {
  try {
    const publicKey = host.identity.getUserMasterPublicKey();
    if (!publicKey || publicKey.length === 0) return null;
    return createHash('sha256').update(publicKey).digest('hex');
  } catch {
    return null;
  }
}

function deriveHostId(deviceId: string, homeKey: string): string {
  return `h_${createHash('sha256').update(`${deviceId}\0${homeKey}`, 'utf8').digest('hex').slice(0, 16)}`;
}

function credentialSource(keyRef: string | null): 'env' | 'keychain' | 'file' | null {
  if (!keyRef) return null;
  if (keyRef.startsWith('env:')) return 'env';
  if (keyRef.startsWith('keychain:')) return 'keychain';
  if (keyRef.startsWith('file:')) return 'file';
  return null;
}
