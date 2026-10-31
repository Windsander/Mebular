// Sidecar 内置 inference 的公共契约（0.3.0 / C8a）。
//
// 边界：
// - inference 是 Memory Runtime sidecar 的子能力，不是独立 daemon；
// - 下载/安装/引擎/ provider 都归 sidecar；MCP/Console/CLI 只通过 host API；
// - API 视图不包含 host token、capability token、API key、模型绝对路径；
// - 安装任务、引擎状态与激活状态都是 operational state，不是记忆权威。

import type {
  EngineState,
  HardwareProfile,
  ModelRecommendation,
  ModelStatusState,
  ModelTier,
} from '../../inference/types.js';

export const MODEL_INSTALL_SCHEMA = 1 as const;

export type ModelInstallState =
  | 'downloading'
  | 'verifying'
  | 'installing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

/** 安装任务的当前阶段：先模型包，再引擎资产。 */
export type ModelInstallPhase = 'model' | 'engine';

export type EngineAssetInstallState =
  | 'not_installed'
  | 'downloading'
  | 'verifying'
  | 'extracting'
  | 'installing'
  | 'installed'
  | 'failed'
  | 'cancelled';

/** 引擎资产安装状态（公开视图）；不含绝对路径、URL 或 token。 */
export interface EngineAssetInstallView {
  state: EngineAssetInstallState;
  installed: boolean;
  release: string | null;
  platform: string;
  arch: string;
  asset: string | null;
  binaryReady: boolean;
  reason: string | null;
  progress: number;
  installedAt: number | null;
  verifiedAt: number | null;
  supported: boolean;
}

export interface ModelInstallError {
  /** 稳定错误码；例如 manifest_missing / disk_insufficient / checksum_mismatch。 */
  code: string;
  /** 已脱敏的短句；不包含路径、token 或响应体。 */
  message: string;
  retryable: boolean;
}

export interface ModelInstallJob {
  schema: typeof MODEL_INSTALL_SCHEMA;
  jobId: string;
  packId: string;
  modelId: string;
  state: ModelInstallState;
  /** 当前阶段：模型包下载/校验/安装，或引擎资产准备。 */
  phase: ModelInstallPhase;
  /** 0–1；按当前 phase 计算（模型阶段按总字节，引擎阶段按引擎安装进度）。 */
  progress: number;
  downloadedBytes: number;
  totalBytes: number;
  /** 本次任务的平均下载速度；未知时为 0。 */
  speedBytesPerSecond: number;
  /** 预计剩余毫秒；无法估算时为 null。 */
  etaMs: number | null;
  startedAt: number;
  updatedAt: number;
  completedAt: number | null;
  error: ModelInstallError | null;
  warnings: string[];
}

export interface InferenceEngineView {
  state: EngineState;
  health: 'unknown' | 'ok' | 'unhealthy';
  packId: string | null;
  modelId: string | null;
  pid?: number;
  startedAt?: number;
  crashCount: number;
  restartCount: number;
  /** 只给稳定 code 与脱敏短句。 */
  lastError: { code: string; message: string } | null;
  /**
   * 引擎资产（llama.cpp 二进制）安装状态。sidecar service 注入；
   * engine adapter 自身不感知安装目录。
   */
  asset?: EngineAssetInstallView;
  /** 引擎资产状态的关键字段平铺，便于 /status.inference.engine 直接读取。 */
  installed?: boolean;
  release?: string | null;
  platform?: string;
  arch?: string;
  binaryReady?: boolean;
  reason?: string | null;
}

export interface ModelActiveView {
  source: 'heuristic' | 'host' | 'local' | 'api' | 'auto';
  packId: string | null;
  modelId: string | null;
  engine: InferenceEngineView;
}

export interface ModelProvider {
  id: 'heuristic' | 'host' | 'local' | 'api' | string;
  kind: 'builtin' | 'host' | 'local-engine' | 'remote' | 'adapter';
  /** 配置是否启用/存在。 */
  configured: boolean;
  /** 当前是否具备执行条件（不代表已加载模型）。 */
  available: boolean;
  /** 当前实际提供推理的来源。 */
  active: boolean;
  reason: string | null;
}

export interface ModelHardwareView {
  platform: string;
  arch: string;
  osVersion: string | null;
  cpuModel: string | null;
  cpuCores: number;
  totalMemoryBytes: number;
  freeMemoryBytes: number | null;
  diskAvailableBytes: number | null;
  diskTotalBytes: number | null;
  gpu: {
    vendor: string;
    name: string | null;
    vramBytes: number | null;
    unifiedMemory: boolean;
  };
  detectedAt: number;
  warnings: string[];
}

export interface ModelCatalogEntryView {
  packId: string;
  modelId: string;
  displayName: string;
  description: string;
  tier: ModelTier;
  quantization: string;
  contextLength: number;
  estimatedDownloadBytes: number;
  requirements: {
    platforms: string[];
    architectures: string[] | null;
    minMemoryBytes: number;
    recommendedMemoryBytes: number;
    minDiskBytes: number;
    gpu: 'none' | 'optional' | 'required' | null;
  };
  state: ModelStatusState;
  installed: boolean;
  installedBytes: number;
  expectedBytes: number;
  verifiedAt: number | null;
  /** 是否具备本机完整 manifest（安装所需）。 */
  manifest: {
    available: boolean;
    error: string | null;
  };
  /** 当前硬件是否满足最低要求；硬件未探测时为 null。 */
  supported: boolean | null;
  active: boolean;
  install: ModelInstallJob | null;
  warnings: string[];
}

export interface ModelCatalogView {
  hardware: ModelHardwareView | null;
  recommended: ModelRecommendation | null;
  packs: ModelCatalogEntryView[];
  active: ModelActiveView;
  providers: ModelProvider[];
  install: ModelInstallJob | null;
  /** 引擎资产安装状态；与模型安装/激活分开，不包含路径。 */
  engine: EngineAssetInstallView;
  warnings: string[];
}

export interface ModelStatusView {
  packId: string;
  modelId: string;
  displayName: string | null;
  state: ModelStatusState;
  installed: boolean;
  installedBytes: number;
  expectedBytes: number;
  verified: boolean | null;
  verifiedAt: number | null;
  manifest: {
    available: boolean;
    error: string | null;
  };
  supported: boolean | null;
  active: boolean;
  install: ModelInstallJob | null;
  engine: InferenceEngineView;
  warnings: string[];
}

export interface ModelActivationView {
  activated: boolean;
  active: 'heuristic' | 'host' | 'local' | 'api' | 'auto';
  packId: string;
  modelId: string | null;
  reason: string | null;
  warnings: string[];
  engine: InferenceEngineView;
  /** 热切换：为 false 表示无需重启 sidecar。 */
  restartRequired: false;
}

export interface ModelEngineActionView {
  packId: string;
  started: boolean;
  stopped: boolean;
  reason: string | null;
  warnings: string[];
  engine: InferenceEngineView;
}

export interface ModelRemoveView {
  packId: string;
  removed: boolean;
  wasActive: boolean;
  warnings: string[];
}

export interface InferenceStatusView {
  active: ModelActiveView;
  engine: InferenceEngineView;
  install: ModelInstallJob | null;
  recommended: ModelRecommendation | null;
  installedPackIds: string[];
  warnings: string[];
}

export interface InferenceCapabilities {
  install: boolean;
  activate: boolean;
  catalog: boolean;
  engine: boolean;
}

/** host API 使用的完整 inference 面；server 只依赖这个接口。 */
export interface InferenceApi {
  capabilities(): InferenceCapabilities;
  listModels(): Promise<ModelCatalogView>;
  getModelStatus(packId: string): Promise<ModelStatusView | null>;
  install(packId: string, options?: { force?: boolean }): Promise<ModelInstallJob>;
  getInstall(jobId: string): Promise<ModelInstallJob | null>;
  cancelInstall(jobId: string): Promise<ModelInstallJob>;
  activate(packId: string): Promise<ModelActivationView>;
  deactivate(packId: string): Promise<ModelActivationView>;
  startEngine(packId: string): Promise<ModelEngineActionView>;
  stopEngine(packId: string): Promise<ModelEngineActionView>;
  removeModel(packId: string): Promise<ModelRemoveView>;
  status(): Promise<InferenceStatusView>;
  dispose(): Promise<void>;
}

export type InferenceErrorCode =
  | 'invalid_request'
  | 'unknown_pack'
  | 'not_installed'
  | 'already_installed'
  | 'install_in_progress'
  | 'install_not_found'
  | 'install_not_running'
  | 'manifest_missing'
  | 'manifest_invalid'
  | 'manifest_mismatch'
  | 'platform_unsupported'
  | 'memory_insufficient'
  | 'disk_insufficient'
  | 'model_corrupt'
  | 'engine_unavailable'
  | 'engine_not_running'
  | 'engine_pack_mismatch'
  | 'engine_not_installed'
  | 'engine_asset_unsupported'
  | 'engine_download_failed'
  | 'engine_http_error'
  | 'engine_size_mismatch'
  | 'engine_checksum_mismatch'
  | 'engine_extract_failed'
  | 'engine_binary_missing'
  | 'engine_install_failed'
  | 'engine_storage_unavailable'
  | 'storage_unavailable'
  | 'not_active'
  | 'cancelled';

/**
 * 结构化 inference 错误。
 * 面向 host API 的 message 必须已脱敏；details 只放 packId/jobId/字节数等非敏感字段。
 */
export class InferenceError extends Error {
  constructor(
    readonly code: InferenceErrorCode,
    message: string,
    readonly options: {
      status?: number;
      retryable?: boolean;
      details?: Record<string, unknown>;
    } = {},
  ) {
    super(message);
    this.name = 'InferenceError';
  }

  get status(): number {
    return this.options.status ?? 500;
  }

  get retryable(): boolean {
    return this.options.retryable === true;
  }
}

export function hardwareView(profile: HardwareProfile | null): ModelHardwareView | null {
  if (!profile) return null;
  return {
    platform: profile.platform,
    arch: profile.arch,
    osVersion: profile.osVersion ?? null,
    cpuModel: profile.cpuModel ?? null,
    cpuCores: profile.cpuCores,
    totalMemoryBytes: profile.totalMemoryBytes,
    freeMemoryBytes: profile.freeMemoryBytes ?? null,
    diskAvailableBytes: profile.disk.availableBytes ?? null,
    diskTotalBytes: profile.disk.totalBytes ?? null,
    gpu: {
      vendor: profile.gpu.vendor,
      name: profile.gpu.name ?? null,
      vramBytes: profile.gpu.vramBytes ?? null,
      unifiedMemory: profile.gpu.unifiedMemory,
    },
    detectedAt: profile.detectedAt,
    warnings: [...profile.warnings],
  };
}
