// 单活动安装任务：进度、取消、重试与 sidecar 重启恢复。
//
// 设计约束：
// - 同一 time 只允许一个安装；`<dataDir>/inference/install.json` 保存最近任务；
// - 下载/校验/原子安装全部复用 inference/ModelStore，不复制任何下载逻辑；
// - sidecar 重启后把进行中的任务标记为 interrupted，partial 保留以便续传；
// - 取消会 abort 下载并清理 partial；退出 sidecar 不清理，以便下次续传；
// - 对外 job 视图不包含路径、token、URL 或原始错误消息。

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  ModelStoreError,
  type DownloadModelOptions,
  type ModelDownloadStatus,
  type ModelInstallResult,
  type ModelVerifyResult,
} from '../../inference/store.js';
import { modelManifestTotalBytes, type ModelManifest, type ModelPack, type ModelStatus } from '../../inference/types.js';
import { readJsonFile, writeJsonAtomic } from '../atomic-json.js';
import type {
  EngineInstallOptions,
  EngineInstallProgress,
  EngineInstallerStatus,
} from './engine-installer.js';
import {
  MODEL_INSTALL_SCHEMA,
  InferenceError,
  type ModelInstallError,
  type ModelInstallJob,
  type ModelInstallState,
} from './types.js';

/** 只需要 ModelStore 的这组方法；测试可注入 fake。 */
export interface ModelStoreLike {
  getModelStatus(packId: string): Promise<ModelStatus>;
  download(manifest: unknown, options?: DownloadModelOptions): Promise<ModelInstallResult>;
  verify(packId: string): Promise<ModelVerifyResult>;
  uninstall(packId: string): Promise<{ removed: boolean; path: string }>;
  clearPartial(packId: string): Promise<{ removed: boolean; path: string }>;
  packPath(packId: string): string;
}

export interface InstallPreflightResult {
  warnings?: string[];
}

export type InstallPreflight = (
  pack: ModelPack,
  manifest: ModelManifest,
) => Promise<InstallPreflightResult | void>;

/** ModelInstaller 只需要引擎安装器的这两个方法；测试可注入 fake。 */
export interface ModelEngineInstallerLike {
  status(): EngineInstallerStatus;
  ensureInstalled(options?: EngineInstallOptions): Promise<EngineInstallerStatus>;
}

export interface ModelInstallerOptions {
  dataDir: string;
  store: ModelStoreLike;
  resolvePack(packId: string): ModelPack | null;
  resolveManifest(packId: string): Promise<ModelManifest>;
  preflight?: InstallPreflight;
  /** 模型安装完成后自动准备 llama.cpp 引擎；缺省表示不管理引擎。 */
  engineInstaller?: ModelEngineInstallerLike;
  now?: () => number;
  createJobId?: () => string;
  /** 进度持久化节流；默认 500ms。 */
  persistIntervalMs?: number;
}

interface StoredInstallState {
  schema: typeof MODEL_INSTALL_SCHEMA;
  job: ModelInstallJob;
}

const ACTIVE_STATES: ReadonlySet<ModelInstallState> = new Set([
  'downloading',
  'verifying',
  'installing',
]);

const STATE_WORDS: Record<ModelInstallState, string> = {
  downloading: '正在下载模型',
  verifying: '正在校验模型文件',
  installing: '正在安装模型',
  completed: '模型安装完成',
  failed: '模型安装失败',
  cancelled: '模型安装已取消',
  interrupted: '模型安装被中断，可重试',
};

const ERROR_MESSAGES: Record<string, string> = {
  manifest_missing: '模型包缺少完整 manifest，无法安装',
  manifest_invalid: '模型 manifest 校验失败',
  manifest_mismatch: 'manifest 与模型包不匹配',
  invalid_manifest: '模型 manifest 校验失败',
  no_source: '没有可用的下载来源',
  unsafe_path: '模型包文件路径不安全',
  download_failed: '模型下载失败',
  http_error: '模型下载请求失败',
  checksum_mismatch: '模型文件校验失败',
  size_mismatch: '模型文件大小不一致',
  install_exists: '模型包已安装',
  not_installed: '模型包未安装',
  import_failed: '模型导入失败',
  cancelled: '模型安装已取消',
  storage_unavailable: '模型存储不可用',
  install_internal_error: '模型安装内部错误',
  engine_asset_unsupported: '当前平台没有可用的 llama.cpp 引擎资产',
  engine_download_failed: '引擎下载失败',
  engine_http_error: '引擎下载请求失败',
  engine_size_mismatch: '引擎归档大小不一致',
  engine_checksum_mismatch: '引擎归档校验失败',
  engine_extract_failed: '引擎归档解压失败',
  engine_binary_missing: '引擎归档缺少 llama-server',
  engine_install_failed: '引擎安装失败',
  engine_storage_unavailable: '引擎存储不可用',
  engine_not_installed: '引擎尚未安装',
  engine_install_in_progress: '引擎安装正在进行',
};

function cloneJob(job: ModelInstallJob): ModelInstallJob {
  return {
    ...job,
    error: job.error ? { ...job.error } : null,
    warnings: [...job.warnings],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isInstallState(value: unknown): value is ModelInstallState {
  return typeof value === 'string' && value in STATE_WORDS;
}

function parseStoredJob(value: unknown): ModelInstallJob | null {
  if (!isRecord(value) || value.schema !== MODEL_INSTALL_SCHEMA) return null;
  if (typeof value.jobId !== 'string' || typeof value.packId !== 'string') return null;
  if (typeof value.modelId !== 'string' || !isInstallState(value.state)) return null;
  const error = isRecord(value.error)
    ? {
      code: typeof value.error.code === 'string' ? value.error.code : 'install_failed',
      message: typeof value.error.message === 'string' ? value.error.message : ERROR_MESSAGES.install_failed!,
      retryable: value.error.retryable === true,
    }
    : null;
  return {
    schema: MODEL_INSTALL_SCHEMA,
    jobId: value.jobId,
    packId: value.packId,
    modelId: value.modelId,
    state: value.state,
    phase: value.phase === 'engine' ? 'engine' : 'model',
    progress: numberOr(value.progress, 0),
    downloadedBytes: numberOr(value.downloadedBytes, 0),
    totalBytes: numberOr(value.totalBytes, 0),
    speedBytesPerSecond: numberOr(value.speedBytesPerSecond, 0),
    etaMs: typeof value.etaMs === 'number' && Number.isFinite(value.etaMs) && value.etaMs >= 0
      ? Math.round(value.etaMs)
      : null,
    startedAt: numberOr(value.startedAt, 0),
    updatedAt: numberOr(value.updatedAt, 0),
    completedAt: typeof value.completedAt === 'number' && Number.isFinite(value.completedAt)
      ? value.completedAt
      : null,
    error,
    warnings: Array.isArray(value.warnings)
      ? value.warnings.filter((entry): entry is string => typeof entry === 'string')
      : [],
  };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function statusState(state: ModelDownloadStatus['state']): ModelInstallState {
  if (state === 'verifying') return 'verifying';
  if (state === 'installing') return 'installing';
  if (state === 'installed') return 'completed';
  if (state === 'failed') return 'failed';
  if (state === 'cancelled') return 'cancelled';
  return 'downloading';
}

function installErrorFrom(error: unknown, cancelled: boolean): ModelInstallError {
  if (cancelled) {
    return {
      code: 'cancelled',
      message: ERROR_MESSAGES.cancelled!,
      retryable: true,
    };
  }
  const code = error instanceof ModelStoreError
    ? error.code
    : isRecord(error) && typeof error.code === 'string'
      ? error.code
      : 'install_internal_error';
  return {
    code,
    message: ERROR_MESSAGES[code] ?? ERROR_MESSAGES.install_internal_error!,
    retryable: code === 'http_error' || code === 'download_failed' || code === 'checksum_mismatch'
      || code === 'size_mismatch'
      || code === 'engine_download_failed' || code === 'engine_http_error'
      || code === 'engine_size_mismatch' || code === 'engine_checksum_mismatch'
      || code === 'engine_extract_failed' || code === 'engine_install_failed'
      || code === 'engine_storage_unavailable',
  };
}

function progressOf(downloadedBytes: number, totalBytes: number): number {
  if (totalBytes <= 0) return 0;
  return Math.min(1, Math.max(0, downloadedBytes / totalBytes));
}

export class ModelInstaller {
  readonly statePath: string;
  private readonly dataDir: string;
  private readonly store: ModelStoreLike;
  private readonly resolvePack: ModelInstallerOptions['resolvePack'];
  private readonly resolveManifest: ModelInstallerOptions['resolveManifest'];
  private readonly preflight: InstallPreflight;
  private readonly engineInstaller: ModelEngineInstallerLike | null;
  private readonly now: () => number;
  private readonly createJobId: () => string;
  private readonly persistIntervalMs: number;

  private job: ModelInstallJob | null = null;
  private task: Promise<void> | null = null;
  private starting = false;
  private controller: AbortController | null = null;
  private cancelReason: 'cancel' | 'shutdown' | null = null;
  private lastPersistAt = 0;
  private persistChain: Promise<void> = Promise.resolve();

  constructor(options: ModelInstallerOptions) {
    this.dataDir = options.dataDir;
    this.statePath = join(options.dataDir, 'inference', 'install.json');
    this.store = options.store;
    this.resolvePack = options.resolvePack;
    this.resolveManifest = options.resolveManifest;
    this.preflight = options.preflight ?? (async () => undefined);
    this.engineInstaller = options.engineInstaller ?? null;
    this.now = options.now ?? Date.now;
    this.createJobId = options.createJobId ?? (() => `job_${randomUUID()}`);
    this.persistIntervalMs = Math.max(0, options.persistIntervalMs ?? 500);
  }

  /** 读取上次任务；进行中的任务标记为 interrupted，partial 保留。 */
  async init(): Promise<void> {
    const stored = await readJsonFile<StoredInstallState>(this.statePath);
    const job = parseStoredJob(stored?.job);
    if (!job) return;
    if (ACTIVE_STATES.has(job.state)) {
      job.state = 'interrupted';
      job.error = {
        code: 'sidecar_restarted',
        message: 'sidecar 重启导致模型安装中断，可重试',
        retryable: true,
      };
      job.speedBytesPerSecond = 0;
      job.etaMs = null;
      job.updatedAt = this.now();
      job.warnings = [...job.warnings, 'install_interrupted'];
    }
    this.job = job;
    await this.persist(true);
  }

  current(): ModelInstallJob | null {
    return this.job ? cloneJob(this.job) : null;
  }

  get(jobId: string): ModelInstallJob | null {
    if (!this.job || this.job.jobId !== jobId) return null;
    return cloneJob(this.job);
  }

  isActive(): boolean {
    return this.starting
      || (this.task !== null && this.job !== null && ACTIVE_STATES.has(this.job.state));
  }

  /** 创建安装任务；立即返回快照，实际下载在后台继续。 */
  async install(packId: string, options: { force?: boolean } = {}): Promise<ModelInstallJob> {
    if (this.isActive()) {
      throw new InferenceError('install_in_progress', '已有模型安装任务正在进行', {
        status: 409,
        retryable: false,
        details: { jobId: this.job?.jobId ?? null, packId: this.job?.packId ?? null },
      });
    }
    this.starting = true;
    this.cancelReason = null;
    try {
      const pack = this.resolvePack(packId);
      if (!pack) {
        throw new InferenceError('unknown_pack', '未知模型包', { status: 404, details: { packId } });
      }
      const manifest = await this.resolveManifest(packId);
      const preflight = await this.preflight(pack, manifest);
      const warnings = Array.isArray(preflight?.warnings) ? [...preflight.warnings] : [];

      const installed = await this.store.getModelStatus(packId);
      const engineReady = this.engineInstaller?.status().installed === true;
      // 模型已安装但引擎未就绪：重试只补引擎，不重新下载数 GB 的模型。
      const engineOnly = installed.state === 'installed'
        && options.force !== true
        && this.engineInstaller !== null
        && !engineReady;
      if (installed.state === 'installed' && options.force !== true && !engineOnly) {
        throw new InferenceError('already_installed', '模型包已安装', {
          status: 409,
          details: { packId },
        });
      }
      if (this.cancelReason !== null) {
        throw new InferenceError('cancelled', '模型安装已取消', { status: 409, retryable: true });
      }

      const now = this.now();
      const totalBytes = modelManifestTotalBytes(manifest);
      const job: ModelInstallJob = {
        schema: MODEL_INSTALL_SCHEMA,
        jobId: this.createJobId(),
        packId,
        modelId: manifest.modelId,
        state: engineOnly ? 'installing' : 'downloading',
        phase: engineOnly ? 'engine' : 'model',
        progress: 0,
        downloadedBytes: engineOnly ? (installed.installedBytes ?? totalBytes) : 0,
        totalBytes: engineOnly ? (installed.expectedBytes ?? totalBytes) : totalBytes,
        speedBytesPerSecond: 0,
        etaMs: null,
        startedAt: now,
        updatedAt: now,
        completedAt: null,
        error: null,
        warnings,
      };
      this.job = job;
      const controller = new AbortController();
      this.controller = controller;
      await this.persist(true);
      if (this.cancelReason !== null) {
        return cloneJob(job);
      }
      this.task = this.run(job, manifest, controller, options.force === true, engineOnly);
      // run 永不 reject；这里不 await，安装通过 GET /installs/:jobId 观察。
      void this.task;
      return cloneJob(job);
    } finally {
      this.starting = false;
    }
  }

  async cancel(jobId: string): Promise<ModelInstallJob> {
    if (!this.job || this.job.jobId !== jobId) {
      throw new InferenceError('install_not_found', '安装任务不存在或已被替换', { status: 404 });
    }
    if (!this.isActive()) {
      return cloneJob(this.job);
    }
    this.cancelReason = 'cancel';
    this.controller?.abort();
    await this.task?.catch(() => undefined);
    await this.store.clearPartial(this.job.packId).catch(() => undefined);
    if (this.job && this.job.jobId === jobId) {
      const installed = await this.store.getModelStatus(this.job.packId).catch(() => null);
      const engineReady = this.engineInstaller?.status().installed === true;
      const phase = this.job.phase;
      this.controller = null;
      this.task = null;
      if (installed?.state === 'installed' && (phase !== 'engine' || engineReady)) {
        // 取消与原子提交赛跑：文件已经落盘，不能谎报 cancelled。
        this.job.state = 'completed';
        this.job.progress = 1;
        this.job.downloadedBytes = installed.installedBytes ?? this.job.totalBytes;
        this.job.totalBytes = installed.expectedBytes ?? this.job.totalBytes;
        this.job.speedBytesPerSecond = 0;
        this.job.etaMs = 0;
        this.job.completedAt = this.now();
        this.job.updatedAt = this.now();
        this.job.error = null;
        if (!this.job.warnings.includes('install_completed_before_cancel')) {
          this.job.warnings = [...this.job.warnings, 'install_completed_before_cancel'];
        }
        if (phase === 'engine' && !this.job.warnings.includes('engine_install_completed_before_cancel')) {
          this.job.warnings = [...this.job.warnings, 'engine_install_completed_before_cancel'];
        }
        await this.persist(true);
        return cloneJob(this.job);
      }
      this.job.state = 'cancelled';
      this.job.speedBytesPerSecond = 0;
      this.job.etaMs = null;
      this.job.completedAt = this.now();
      this.job.updatedAt = this.now();
      this.job.error = {
        code: 'cancelled',
        message: ERROR_MESSAGES.cancelled!,
        retryable: true,
      };
      await this.persist(true);
      return cloneJob(this.job);
    }
    throw new InferenceError('install_not_found', '安装任务不存在或已被替换', { status: 404 });
  }

  /** sidecar 停止：中断进行中的任务，保留 partial 供下次续传。 */
  async dispose(): Promise<void> {
    if (!this.isActive()) return;
    this.cancelReason = 'shutdown';
    this.controller?.abort();
    await this.task?.catch(() => undefined);
    this.controller = null;
    this.task = null;
    if (this.job && ACTIVE_STATES.has(this.job.state)) {
      this.job.state = 'interrupted';
      this.job.error = {
        code: 'sidecar_stopping',
        message: 'sidecar 停止导致模型安装中断，可重试',
        retryable: true,
      };
      this.job.speedBytesPerSecond = 0;
      this.job.etaMs = null;
      this.job.updatedAt = this.now();
      await this.persist(true);
    }
  }

  private async run(
    job: ModelInstallJob,
    manifest: ModelManifest,
    controller: AbortController,
    force: boolean,
    engineOnly: boolean,
  ): Promise<void> {
    try {
      if (!engineOnly) {
        const result = await this.store.download(manifest, {
          ...(force ? { force: true } : {}),
          signal: controller.signal,
          onStatus: (status) => this.applyStatus(job, status),
        });
        if (this.cancelReason === 'cancel' || controller.signal.aborted) {
          // cancel() 会写最终 cancelled；这里避免与它竞争。
          return;
        }
        job.downloadedBytes = result.installedBytes;
        job.totalBytes = result.installedBytes;
        job.warnings = [...job.warnings, ...(job.warnings.includes('model_installed') ? [] : ['model_installed'])];
      }
      if (this.engineInstaller) {
        job.phase = 'engine';
        job.state = 'installing';
        job.progress = 0;
        job.speedBytesPerSecond = 0;
        job.etaMs = null;
        job.updatedAt = this.now();
        await this.persist(true);
        // 已安装且校验通过时直接跳过引擎下载；activate/start 还会再次确保。
        if (this.engineInstaller.status().installed !== true) {
          await this.engineInstaller.ensureInstalled({
            signal: controller.signal,
            onProgress: (progress) => this.applyEngineProgress(job, progress),
          });
        }
        if (this.cancelReason === 'cancel' || controller.signal.aborted) return;
        job.warnings = [...job.warnings, ...(job.warnings.includes('engine_ready') ? [] : ['engine_ready'])];
      }
      job.state = 'completed';
      job.progress = 1;
      job.speedBytesPerSecond = 0;
      job.etaMs = 0;
      job.completedAt = this.now();
      job.updatedAt = this.now();
      job.error = null;
    } catch (error) {
      if (this.cancelReason === 'cancel') {
        // cancel() 负责最终状态、partial 清理与持久化。
        return;
      }
      if (this.cancelReason === 'shutdown' || controller.signal.aborted) {
        job.state = 'interrupted';
        job.error = {
          code: 'sidecar_stopping',
          message: 'sidecar 停止导致模型安装中断，可重试',
          retryable: true,
        };
      } else {
        job.state = 'failed';
        job.error = installErrorFrom(error, false);
        if (job.phase === 'engine' && !job.warnings.includes('model_installed')) {
          job.warnings = [...job.warnings, 'model_installed'];
        }
        if (job.phase === 'engine' && !job.warnings.includes('engine_install_failed')) {
          job.warnings = [...job.warnings, 'engine_install_failed'];
        }
      }
      job.speedBytesPerSecond = 0;
      job.etaMs = null;
      job.updatedAt = this.now();
    } finally {
      if (this.cancelReason !== 'cancel') {
        this.controller = null;
        this.task = null;
        await this.persist(true);
      }
    }
  }

  private applyEngineProgress(job: ModelInstallJob, progress: EngineInstallProgress): void {
    if (this.job?.jobId !== job.jobId) return;
    job.phase = 'engine';
    job.state = progress.phase === 'downloading'
      ? 'downloading'
      : progress.phase === 'verifying' ? 'verifying' : 'installing';
    job.progress = Math.min(1, Math.max(0, progress.progress));
    job.updatedAt = this.now();
    void this.persist(false);
  }

  private applyStatus(job: ModelInstallJob, status: ModelDownloadStatus): void {
    if (this.job?.jobId !== job.jobId) return;
    const state = statusState(status.state);
    job.state = state;
    job.downloadedBytes = Math.max(0, status.downloadedBytes);
    job.totalBytes = Math.max(0, status.totalBytes || job.totalBytes);
    job.progress = status.state === 'installing' || status.state === 'installed'
      ? 1
      : progressOf(job.downloadedBytes, job.totalBytes);
    const elapsedMs = Math.max(0, this.now() - job.startedAt);
    job.speedBytesPerSecond = elapsedMs >= 250
      ? Math.round((job.downloadedBytes * 1000) / elapsedMs)
      : 0;
    const remaining = Math.max(0, job.totalBytes - job.downloadedBytes);
    job.etaMs = job.speedBytesPerSecond > 0
      ? Math.round((remaining * 1000) / job.speedBytesPerSecond)
      : null;
    job.updatedAt = this.now();
    if (state === 'failed' && status.error) {
      job.error = installErrorFrom(
        new ModelStoreError(
          isStoreErrorCode(status.error.code) ? status.error.code : 'download_failed',
          status.error.message ?? '',
        ),
        false,
      );
    }
    void this.persist(false);
  }

  private persist(force: boolean): Promise<void> {
    const now = this.now();
    if (!force && now - this.lastPersistAt < this.persistIntervalMs) return Promise.resolve();
    this.lastPersistAt = now;
    if (!this.job) return Promise.resolve();
    const stored: StoredInstallState = {
      schema: MODEL_INSTALL_SCHEMA,
      job: cloneJob(this.job),
    };
    this.persistChain = this.persistChain
      .then(async () => {
        try {
          await writeJsonAtomic(this.statePath, stored);
        } catch {
          // 安装状态持久化失败不应破坏下载；下次状态变化会重试。
        }
      });
    return this.persistChain;
  }
}

function isStoreErrorCode(value: string): value is ModelStoreError['code'] {
  return [
    'invalid_manifest',
    'unsafe_path',
    'no_source',
    'download_failed',
    'http_error',
    'checksum_mismatch',
    'size_mismatch',
    'install_exists',
    'not_installed',
    'manifest_missing',
    'manifest_mismatch',
    'import_failed',
    'cancelled',
  ].includes(value);
}
