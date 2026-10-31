// Sidecar inference service：目录、安装、硬件检查、激活与 provider 热切换。
//
// 这是 sidecar 内模型能力的唯一门面：
// - 安装任务由 ModelInstaller 持有，下载/校验复用 inference/ModelStore；
// - 引擎只由 InferenceEngine 持有一个子进程；
// - 激活/停用通过 SidecarInferenceProvider.reconfigure 在当前进程内切换 provider，
//   不重启 sidecar，也不触碰 MCP/29 工具；
// - 所有 view 都脱敏：不返回 token、key、绝对路径或引擎 baseUrl。

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { CURATED_MODEL_PACKS, createModelCatalog, findModelPack } from '../../inference/catalog.js';
import { detectHardware } from '../../inference/detect.js';
import { ChatCompletionGateway, type ChatGatewayOptions } from '../../inference/gateway.js';
import { modelManifestTotalBytes, parseModelManifest, type ModelManifest, type ModelPack, type ModelStatus, type HardwareProfile, type ModelRecommendation } from '../../inference/types.js';
import { writeJsonAtomic } from '../atomic-json.js';
import type { SidecarConfig, InferenceSettings, SidecarPaths } from '../config.js';
import type { InferenceGateway, SidecarInferenceProvider } from '../inference-provider.js';
import { ModelInstaller, type ModelStoreLike } from './model-installer.js';
import { CuratedModelManifestResolver, FileModelManifestResolver, type ModelManifestResolver } from './manifest.js';
import type { InferenceEngine } from './engine.js';
import {
  EngineInstaller,
  EngineInstallerError,
  type EngineInstallerLike as ManagedEngineInstaller,
} from './engine-installer.js';
import {
  InferenceError,
  hardwareView,
  type EngineAssetInstallView,
  type ModelActivationView,
  type ModelActiveView,
  type ModelCatalogEntryView,
  type ModelCatalogView,
  type ModelEngineActionView,
  type InferenceEngineView,
  type ModelInstallJob,
  type ModelProvider,
  type ModelRemoveView,
  type InferenceApi,
  type InferenceCapabilities,
  type InferenceSettingsView,
  type InferenceStatusView,
  type ModelStatusView,
  type UpdateInferenceSettingsInput,
} from './types.js';
import { recommendModel } from '../../inference/detect.js';

export interface InstalledModel {
  modelPath: string;
  modelId: string;
  manifest: ModelManifest;
}

export type InstalledModelResolver = (
  packId: string,
  status: ModelStatus,
) => Promise<InstalledModel>;

export interface InferenceServiceOptions {
  paths: Pick<SidecarPaths, 'dataDir' | 'modelsDir' | 'configPath'>;
  config: SidecarConfig;
  inference: SidecarInferenceProvider;
  store: ModelStoreLike;
  engineAdapter: InferenceEngine;
  /** llama.cpp 引擎资产安装器；生产装配必须注入（默认按 dataDir 创建）。 */
  engineInstaller?: ManagedEngineInstaller;
  manifestResolver?: ModelManifestResolver;
  manifestDir?: string;
  installManager?: ModelInstaller;
  detectHardware?: (options: { diskPath: string }) => Promise<HardwareProfile>;
  resolveInstalledModel?: InstalledModelResolver;
  hardware?: HardwareProfile;
  now?: () => number;
  platform?: string;
  arch?: string;
  hardwareTtlMs?: number;
  createJobId?: () => string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safePackId(packId: string): string {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(packId)) {
    throw new InferenceError('invalid_request', '模型包 id 非法', { status: 400 });
  }
  return packId;
}

function activeSource(config: SidecarConfig, activePackId: string | null): ModelActiveView['source'] {
  if (activePackId) return 'local';
  return config.model.source;
}

function defaultInstalledModelResolver(store: ModelStoreLike): InstalledModelResolver {
  return async (packId, status) => {
    const dir = status.installedPath ?? store.packPath(packId);
    let raw: string;
    try {
      raw = await readFile(join(dir, 'manifest.json'), 'utf8');
    } catch {
      throw new InferenceError('model_corrupt', '已安装模型缺少 manifest', {
        status: 409,
        details: { packId },
      });
    }
    let manifest: ModelManifest;
    try {
      manifest = parseModelManifest(JSON.parse(raw));
    } catch {
      throw new InferenceError('model_corrupt', '已安装模型 manifest 无效', {
        status: 409,
        details: { packId },
      });
    }
    const file = manifest.files.find((entry) => entry.path.toLowerCase().endsWith('.gguf'))
      ?? manifest.files[0];
    if (!file) {
      throw new InferenceError('model_corrupt', '模型包没有可加载文件', {
        status: 409,
        details: { packId },
      });
    }
    const modelPath = join(dir, ...file.path.split('/'));
    const info = await stat(modelPath).catch(() => null);
    if (!info?.isFile() || info.size <= 0) {
      throw new InferenceError('model_corrupt', '模型文件缺失或为空', {
        status: 409,
        details: { packId },
      });
    }
    return { modelPath, modelId: manifest.modelId, manifest };
  };
}

function defaultDetectHardware(options: { diskPath: string }, platform: string, arch: string, now: () => number) {
  return detectHardware({
    diskPath: options.diskPath,
    platform,
    arch,
    now,
    // 状态/安装不需要 GPU 子命令；避免在 /status 或安装前拖慢 sidecar。
    exec: async () => {
      throw new Error('gpu_probe_disabled');
    },
  });
}

function supportFailure(
  pack: ModelPack,
  hardware: HardwareProfile | null,
): { code: string; message: string; warnings: string[] } | null {
  if (!hardware) return null;
  const warnings: string[] = [];
  if (!pack.requirements.platforms.includes(hardware.platform)) {
    return {
      code: 'platform_unsupported',
      message: `当前平台 ${hardware.platform}/${hardware.arch} 不在模型支持列表`,
      warnings,
    };
  }
  const archs = pack.requirements.architectures;
  if (archs && archs.length > 0 && !archs.includes(hardware.arch)) {
    return {
      code: 'platform_unsupported',
      message: `当前架构 ${hardware.arch} 不在模型支持列表`,
      warnings,
    };
  }
  if (hardware.totalMemoryBytes > 0 && hardware.totalMemoryBytes < pack.requirements.minMemoryBytes) {
    return {
      code: 'memory_insufficient',
      message: '可用内存低于模型最低要求',
      warnings,
    };
  }
  const available = hardware.disk.availableBytes;
  if (available !== undefined && available < pack.requirements.minDiskBytes) {
    return {
      code: 'disk_insufficient',
      message: '可用磁盘低于模型最低要求',
      warnings,
    };
  }
  if (pack.requirements.gpu === 'required') {
    const vram = hardware.gpu.unifiedMemory ? hardware.totalMemoryBytes : hardware.gpu.vramBytes;
    if (hardware.gpu.vendor === 'none' || hardware.gpu.vendor === 'unknown'
      || (pack.requirements.minVramBytes !== undefined && (vram ?? 0) < pack.requirements.minVramBytes)) {
      return {
        code: 'platform_unsupported',
        message: '模型需要 GPU 显存，但当前设备不满足',
        warnings,
      };
    }
  }
  return warnings.length > 0 ? { code: 'warning', message: '', warnings } : null;
}

export class InferenceService implements InferenceApi {
  readonly installManager: ModelInstaller;
  private readonly paths: InferenceServiceOptions['paths'];
  private readonly config: SidecarConfig;
  private readonly inference: SidecarInferenceProvider;
  private readonly store: ModelStoreLike;
  private readonly manifestResolver: ModelManifestResolver;
  private readonly engineAdapter: InferenceEngine;
  private readonly engineInstaller: ManagedEngineInstaller;
  private readonly resolveInstalledModel: InstalledModelResolver;
  private readonly detectHardwareImpl: (options: { diskPath: string }) => Promise<HardwareProfile>;
  private readonly now: () => number;
  private readonly platform: string;
  private readonly arch: string;
  private readonly hardwareTtlMs: number;
  private readonly packs: ModelPack[];

  private hardware: HardwareProfile | null = null;
  private hardwareAt = 0;
  private hardwareTask: Promise<HardwareProfile | null> | null = null;
  private activePackId: string | null = null;
  private warnings: string[] = [];
  private readonly verifyCache = new Map<string, { ok: boolean; at: number }>();
  private actionQueue: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(options: InferenceServiceOptions) {
    this.paths = options.paths;
    this.config = options.config;
    this.inference = options.inference;
    this.store = options.store;
    this.engineAdapter = options.engineAdapter;
    this.now = options.now ?? Date.now;
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.engineInstaller = options.engineInstaller ?? new EngineInstaller({
      dataDir: options.paths.dataDir,
      platform: this.platform,
      arch: this.arch,
      now: this.now,
    });
    this.hardwareTtlMs = Math.max(1_000, options.hardwareTtlMs ?? 60_000);
    this.hardware = options.hardware ?? null;
    this.hardwareAt = this.hardware ? this.now() : 0;
    this.packs = createModelCatalog();
    const manifestDir = options.manifestDir;
    this.manifestResolver = options.manifestResolver
      ?? (manifestDir ? new FileModelManifestResolver(manifestDir) : new CuratedModelManifestResolver());
    this.resolveInstalledModel = options.resolveInstalledModel ?? defaultInstalledModelResolver(this.store);
    const detector = options.detectHardware
      ?? ((detectOptions) => defaultDetectHardware(detectOptions, this.platform, this.arch, this.now));
    this.detectHardwareImpl = (detectOptions) => detector(detectOptions);
    this.installManager = options.installManager ?? new ModelInstaller({
      dataDir: options.paths.dataDir,
      store: this.store,
      resolvePack: (packId) => this.findPack(packId),
      resolveManifest: (packId) => this.manifestResolver.resolve(packId),
      preflight: (pack, manifest) => this.preflight(pack, manifest),
      engineInstaller: this.engineInstaller,
      now: this.now,
      ...(options.createJobId ? { createJobId: options.createJobId } : {}),
    });
  }

  /** 恢复安装任务与本地模型配置；不创建模型目录、不启动引擎、不联网。 */
  async init(): Promise<void> {
    try {
      await this.installManager.init();
    } catch {
      this.warnings.push('install_state_unreadable');
    }
    try {
      await this.engineInstaller.init();
    } catch {
      this.warnings.push('engine_state_unreadable');
    }

    const configured = this.config.model;
    if (configured.source === 'local' && configured.local.pack) {
      const packId = configured.local.pack;
      const pack = this.findPack(packId);
      if (!pack) {
        this.warnings.push('configured_model_unknown');
      } else {
        try {
          const status = await this.store.getModelStatus(packId);
          if (status.state === 'installed') {
            const installed = await this.resolveInstalledModel(packId, status);
            const binaryPath = this.engineInstaller.binaryPath();
            await this.engineAdapter.prepare({
              packId,
              modelPath: installed.modelPath,
              modelId: installed.modelId,
              contextSize: installed.manifest.context.length,
              ...(installed.manifest.runtime.threads !== undefined
                ? { threads: installed.manifest.runtime.threads }
                : {}),
              ...(binaryPath ? { binaryPath } : {}),
            });
            this.activePackId = packId;
          } else {
            this.warnings.push('configured_model_not_installed');
          }
        } catch {
          this.warnings.push('configured_model_unavailable');
        }
      }
    }

    // 预热硬件信息，但不阻塞 sidecar 启动。
    void this.ensureHardware().catch(() => null);
  }

  capabilities(): InferenceCapabilities {
    return { install: true, activate: true, catalog: true, engine: true };
  }

  /** 生产装配时注入给 SidecarInferenceProvider；ChatCompletionGateway 无状态，但由 service 统一创建。 */
  createGateway(options: ChatGatewayOptions): InferenceGateway {
    return new ChatCompletionGateway(options);
  }

  async listModels(): Promise<ModelCatalogView> {
    const hardware = await this.ensureHardware().catch(() => null);
    const install = this.installManager.current();
    const warnings = [...this.warnings, ...(hardware?.warnings ?? [])];
    const packs: ModelCatalogEntryView[] = [];
    const statuses = await this.installedStatuses();
    for (const pack of this.packs) {
      const status = statuses.get(pack.packId) ?? {
        packId: pack.packId,
        modelId: pack.modelId,
        state: 'not_installed' as const,
      };
      const manifest = await this.manifestState(pack.packId);
      const support = supportFailure(pack, hardware);
      const entryWarnings: string[] = [];
      if (support && support.code !== 'warning') entryWarnings.push(support.code);
      if (!manifest.available) entryWarnings.push(manifest.error ?? 'manifest_missing');
      packs.push({
        packId: pack.packId,
        modelId: pack.modelId,
        displayName: pack.displayName,
        description: pack.description,
        tier: pack.tier,
        quantization: pack.quantization,
        contextLength: pack.contextLength,
        estimatedDownloadBytes: pack.estimatedDownloadBytes,
        requirements: {
          platforms: [...pack.requirements.platforms],
          architectures: pack.requirements.architectures
            ? [...pack.requirements.architectures]
            : null,
          minMemoryBytes: pack.requirements.minMemoryBytes,
          recommendedMemoryBytes: pack.requirements.recommendedMemoryBytes,
          minDiskBytes: pack.requirements.minDiskBytes,
          gpu: pack.requirements.gpu ?? null,
        },
        state: status.state,
        installed: status.state === 'installed',
        installedBytes: status.installedBytes ?? 0,
        expectedBytes: status.expectedBytes ?? pack.estimatedDownloadBytes,
        verifiedAt: status.verifiedAt ?? null,
        manifest,
        supported: hardware ? support === null || support.code === 'warning' : null,
        active: this.activePackId === pack.packId,
        install: install && install.packId === pack.packId ? install : null,
        warnings: entryWarnings,
      });
    }
    const recommended = hardware ? recommendModel(hardware, this.packs) : null;
    return {
      hardware: hardwareView(hardware),
      recommended,
      packs,
      active: this.activeView(),
      providers: this.providers(activeSource(this.config, this.activePackId)),
      install,
      engine: this.engineInstallView(),
      warnings: unique(warnings),
    };
  }

  async getModelStatus(packId: string): Promise<ModelStatusView | null> {
    const pack = this.findPack(safePackId(packId));
    if (!pack) return null;
    const hardware = this.ensureHardwareCached();
    let status: ModelStatus;
    try {
      status = await this.store.getModelStatus(pack.packId);
    } catch {
      status = {
        packId: pack.packId,
        modelId: pack.modelId,
        state: 'corrupt',
        errorCode: 'storage_unavailable',
      };
    }
    const manifest = await this.manifestState(pack.packId);
    const support = supportFailure(pack, hardware);
    const install = this.installManager.current();
    const warnings: string[] = [];
    if (status.state === 'corrupt') warnings.push(status.errorCode ?? 'model_corrupt');
    if (support && support.code !== 'warning') warnings.push(support.code);
    if (!manifest.available) warnings.push(manifest.error ?? 'manifest_missing');
    const verified = this.verifyCache.get(pack.packId) ?? null;
    return {
      packId: pack.packId,
      modelId: status.modelId || pack.modelId,
      displayName: pack.displayName,
      state: status.state,
      installed: status.state === 'installed',
      installedBytes: status.installedBytes ?? 0,
      expectedBytes: status.expectedBytes ?? pack.estimatedDownloadBytes,
      verified: verified ? verified.ok : null,
      verifiedAt: verified?.at ?? status.verifiedAt ?? null,
      manifest,
      supported: hardware ? support === null || support.code === 'warning' : null,
      active: this.activePackId === pack.packId,
      install: install && install.packId === pack.packId ? install : null,
      engine: this.engineView(),
      warnings: unique(warnings),
    };
  }

  async install(packId: string, options: { force?: boolean } = {}): Promise<ModelInstallJob> {
    const pack = this.findPack(safePackId(packId));
    if (!pack) {
      throw new InferenceError('unknown_pack', '未知模型包', { status: 404, details: { packId } });
    }
    return this.serialized(async () => {
      if (this.activePackId === pack.packId) {
        await this.deactivateInternal(pack.packId);
      }
      const job = await this.installManager.install(pack.packId, options);
      this.verifyCache.delete(pack.packId);
      return job;
    });
  }

  async getInstall(jobId: string): Promise<ModelInstallJob | null> {
    return this.installManager.get(jobId);
  }

  async cancelInstall(jobId: string): Promise<ModelInstallJob> {
    return this.installManager.cancel(jobId);
  }

  async activate(packId: string): Promise<ModelActivationView> {
    const pack = this.findPack(safePackId(packId));
    if (!pack) {
      throw new InferenceError('unknown_pack', '未知模型包', { status: 404, details: { packId } });
    }
    return this.serialized(async () => {
      const status = await this.store.getModelStatus(pack.packId);
      if (status.state !== 'installed') {
        if (this.activePackId === pack.packId) await this.applyHeuristic(pack.packId);
        throw new InferenceError('not_installed', '模型包未安装', {
          status: 409,
          details: { packId: pack.packId, state: status.state },
        });
      }
      const verify = await this.store.verify(pack.packId);
      this.verifyCache.set(pack.packId, { ok: verify.ok, at: verify.checkedAt });
      if (!verify.ok) {
        if (this.activePackId === pack.packId) await this.applyHeuristic(pack.packId);
        throw new InferenceError('model_corrupt', '模型文件校验失败，不能激活', {
          status: 409,
          details: { packId: pack.packId },
        });
      }

      const hardware = await this.ensureHardware().catch(() => null);
      const support = supportFailure(pack, hardware);
      if (support && support.code !== 'warning') {
        const fallbackWarnings = await this.applyHeuristic(pack.packId);
        return this.activationView(false, 'heuristic', pack.packId, support.code, [
          support.code,
          ...support.warnings,
          ...fallbackWarnings,
        ]);
      }

      let installed: InstalledModel;
      try {
        installed = await this.resolveInstalledModel(pack.packId, status);
      } catch (error) {
        if (this.activePackId === pack.packId) await this.applyHeuristic(pack.packId);
        if (error instanceof InferenceError) throw error;
        throw new InferenceError('model_corrupt', '已安装模型不可用', {
          status: 409,
          details: { packId: pack.packId },
        });
      }

      const engine = await this.prepareEngine();
      if (!engine.ok) {
        await this.engineAdapter.stop().catch(() => undefined);
        const warnings = await this.applyHeuristic(pack.packId);
        return this.activationView(false, 'heuristic', pack.packId, engine.code, [
          engine.code,
          `engine:${engine.code}`,
          ...engine.warnings,
          ...warnings,
        ]);
      }

      try {
        await this.engineAdapter.start({
          packId: pack.packId,
          modelPath: installed.modelPath,
          modelId: installed.modelId,
          contextSize: installed.manifest.context.length,
          ...(installed.manifest.runtime.threads !== undefined
            ? { threads: installed.manifest.runtime.threads }
            : {}),
          binaryPath: engine.binaryPath,
        });
      } catch (error) {
        await this.engineAdapter.stop().catch(() => undefined);
        const code = error instanceof InferenceError ? error.code : 'engine_unavailable';
        const warnings = await this.applyHeuristic(pack.packId);
        return this.activationView(false, 'heuristic', pack.packId, code, [
          code,
          ...(error instanceof InferenceError && typeof error.options.details?.engineCode === 'string'
            ? [`engine:${error.options.details.engineCode}`]
            : []),
          ...warnings,
        ]);
      }

      const persistWarnings = await this.applyLocal(pack.packId);
      return this.activationView(true, 'local', pack.packId, null, [
        ...(support?.warnings ?? []),
        ...persistWarnings,
      ]);
    });
  }

  async deactivate(packId: string): Promise<ModelActivationView> {
    const pack = this.findPack(safePackId(packId));
    if (!pack) {
      throw new InferenceError('unknown_pack', '未知模型包', { status: 404, details: { packId } });
    }
    return this.serialized(async () => {
      const wasActive = this.activePackId === pack.packId;
      if (!wasActive && this.config.model.local.pack !== pack.packId) {
        return this.activationView(false, 'heuristic', pack.packId, 'not_active', []);
      }
      const warnings = await this.deactivateInternal(pack.packId);
      return this.activationView(false, 'heuristic', pack.packId, wasActive ? null : 'not_active', warnings);
    });
  }

  async startEngine(packId: string): Promise<ModelEngineActionView> {
    const pack = this.findPack(safePackId(packId));
    if (!pack) {
      throw new InferenceError('unknown_pack', '未知模型包', { status: 404, details: { packId } });
    }
    return this.serialized(async () => {
      const status = await this.store.getModelStatus(pack.packId);
      if (status.state !== 'installed') {
        throw new InferenceError('not_installed', '模型包未安装', {
          status: 409,
          details: { packId: pack.packId, state: status.state },
        });
      }
      const hardware = await this.ensureHardware().catch(() => null);
      const support = supportFailure(pack, hardware);
      if (support && support.code !== 'warning') {
        throw new InferenceError(
          support.code === 'memory_insufficient' ? 'memory_insufficient' : support.code === 'disk_insufficient'
            ? 'disk_insufficient'
            : 'platform_unsupported',
          support.message,
          { status: 409, details: { packId: pack.packId } },
        );
      }
      const installed = await this.resolveInstalledModel(pack.packId, status);
      const engine = await this.prepareEngine();
      if (!engine.ok) {
        throw new InferenceError(engine.code as InferenceError['code'], engine.message, {
          status: 503,
          retryable: engine.retryable,
          details: { packId: pack.packId, engineCode: engine.code },
        });
      }
      await this.engineAdapter.start({
        packId: pack.packId,
        modelPath: installed.modelPath,
        modelId: installed.modelId,
        contextSize: installed.manifest.context.length,
        ...(installed.manifest.runtime.threads !== undefined
          ? { threads: installed.manifest.runtime.threads }
          : {}),
        binaryPath: engine.binaryPath,
      });
      return {
        packId: pack.packId,
        started: true,
        stopped: false,
        reason: null,
        warnings: [...(support?.warnings ?? []), ...engine.warnings],
        engine: this.engineView(),
      };
    });
  }

  async stopEngine(packId: string): Promise<ModelEngineActionView> {
    const pack = this.findPack(safePackId(packId));
    if (!pack) {
      throw new InferenceError('unknown_pack', '未知模型包', { status: 404, details: { packId } });
    }
    return this.serialized(async () => {
      const view = this.engineAdapter.getView();
      if (view.packId && view.packId !== pack.packId) {
        throw new InferenceError('engine_pack_mismatch', '当前运行的是另一个模型包', {
          status: 409,
          details: { packId: pack.packId, runningPackId: view.packId },
        });
      }
      await this.engineAdapter.stop();
      return {
        packId: pack.packId,
        started: false,
        stopped: true,
        reason: view.state === 'running' ? null : 'already_stopped',
        warnings: this.activePackId === pack.packId ? ['engine_stopped_while_active'] : [],
        engine: this.engineView(),
      };
    });
  }

  async removeModel(packId: string): Promise<ModelRemoveView> {
    const pack = this.findPack(safePackId(packId));
    if (!pack) {
      throw new InferenceError('unknown_pack', '未知模型包', { status: 404, details: { packId } });
    }
    return this.serialized(async () => {
      const warnings: string[] = [];
      const wasActive = this.activePackId === pack.packId;
      if (wasActive) {
        warnings.push(...await this.deactivateInternal(pack.packId));
      }
      const job = this.installManager.current();
      if (job && job.packId === pack.packId
        && ['downloading', 'verifying', 'installing'].includes(job.state)) {
        await this.installManager.cancel(job.jobId).catch(() => undefined);
        warnings.push('install_cancelled_for_remove');
      }
      let removed = false;
      try {
        const result = await this.store.uninstall(pack.packId);
        removed = result.removed;
      } catch {
        throw new InferenceError('storage_unavailable', '模型文件卸载失败', {
          status: 500,
          retryable: true,
          details: { packId: pack.packId },
        });
      }
      this.verifyCache.delete(pack.packId);
      if (this.activePackId === pack.packId) this.activePackId = null;
      return { packId: pack.packId, removed, wasActive, warnings };
    });
  }

  async status(): Promise<InferenceStatusView> {
    const engine = this.engineView();
    const install = this.installManager.current();
    const hardware = this.ensureHardwareCached();
    let recommended: ModelRecommendation | null = null;
    if (hardware) {
      try {
        recommended = recommendModel(hardware, this.packs);
      } catch {
        recommended = null;
      }
    }
    const installedPackIds: string[] = [];
    for (const pack of this.packs) {
      const status = await this.store.getModelStatus(pack.packId).catch(() => null);
      if (status?.state === 'installed') installedPackIds.push(pack.packId);
    }
    const warnings = [...this.warnings, ...(hardware ? [] : ['hardware_not_detected'])];
    return {
      active: this.activeView(),
      engine,
      install,
      recommended,
      installedPackIds,
      warnings: unique(warnings),
    };
  }

  async settings(): Promise<InferenceSettingsView> {
    return this.settingsView();
  }

  /**
   * 进程内切换非 local 推理来源。
   *
   * - heuristic：停引擎、清 active，保留 local.pack 作为“上次选择”；
   * - host/api/auto：local 正在运行时先停引擎，再切换 provider；
   * - local 只允许 `POST /models/:pack/activate`，这里返回 400 pack_required；
   * - 全程不重启 sidecar，配置持久化失败只返回 warning。
   */
  async updateSettings(input: UpdateInferenceSettingsInput): Promise<InferenceSettingsView> {
    const source = (input as { source?: unknown } | undefined)?.source;
    if (source === 'local') {
      throw new InferenceError('pack_required', 'local 来源必须通过模型包激活设置', {
        status: 400,
        details: { hint: 'POST /memory-runtime/v1/models/:packId/activate' },
      });
    }
    if (source !== 'heuristic' && source !== 'host' && source !== 'api' && source !== 'auto') {
      throw new InferenceError('invalid_request', 'source 必须是 heuristic/host/api/auto', {
        status: 400,
      });
    }
    return this.serialized(async () => {
      const engineRunning = this.engineAdapter.isRunning();
      if (source === 'heuristic' || this.activePackId !== null || engineRunning) {
        await this.engineAdapter.stop().catch(() => undefined);
      }
      this.activePackId = null;
      this.config.model.source = source;
      await this.reconfigure();
      const warnings = await this.persistModelSource(source);
      return this.settingsView(warnings);
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.installManager.dispose().catch(() => undefined);
    await this.engineInstaller.dispose().catch(() => undefined);
    await this.engineAdapter.dispose().catch(() => undefined);
  }

  private findPack(packId: string): ModelPack | null {
    return findModelPack(packId, this.packs)
      ?? findModelPack(packId, CURATED_MODEL_PACKS)
      ?? null;
  }

  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.actionQueue.then(fn, fn);
    this.actionQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  private async settingsView(extraWarnings: string[] = []): Promise<InferenceSettingsView> {
    const status = await this.status();
    return {
      ...status,
      config: { source: this.config.model.source },
      providers: this.providers(activeSource(this.config, this.activePackId)),
      warnings: unique([...status.warnings, ...extraWarnings]),
    };
  }

  private activeView(): ModelActiveView {
    const source = activeSource(this.config, this.activePackId);
    const pack = this.activePackId ? this.findPack(this.activePackId) : null;
    return {
      source,
      packId: this.activePackId ?? (source === 'local' ? this.config.model.local.pack : null),
      modelId: pack?.modelId ?? null,
      engine: this.engineView(),
    };
  }

  private engineView(): InferenceEngineView {
    const process = this.engineAdapter.getView();
    const asset = this.engineInstallView();
    return {
      ...process,
      asset,
      installed: asset.installed,
      release: asset.release,
      platform: asset.platform,
      arch: asset.arch,
      binaryReady: asset.binaryReady,
      reason: asset.reason,
    };
  }

  private engineInstallView(): EngineAssetInstallView {
    return { ...this.engineInstaller.status() };
  }

  /**
   * 激活/启动前的引擎准备：只使用 EngineInstaller 校验过的二进制。
   * 失败返回稳定 code，由 activate 回退 heuristic、start 返回结构化错误。
   */
  private async prepareEngine(): Promise<
    | { ok: true; binaryPath: string; warnings: string[] }
    | { ok: false; code: string; message: string; retryable: boolean; warnings: string[] }
  > {
    try {
      const status = await this.engineInstaller.ensureInstalled();
      const binaryPath = this.engineInstaller.binaryPath();
      if (!status.installed || !status.binaryReady || !binaryPath) {
        return {
          ok: false,
          code: 'engine_not_installed',
          message: 'llama.cpp 引擎尚未安装或未通过校验',
          retryable: true,
          warnings: status.reason ? [status.reason] : [],
        };
      }
      return { ok: true, binaryPath, warnings: [] };
    } catch (error) {
      const code = error instanceof EngineInstallerError
        ? error.code
        : (error as { code?: unknown })?.code;
      const stable = typeof code === 'string' && code.length > 0 ? code : 'engine_install_failed';
      return {
        ok: false,
        code: stable,
        message: engineFailureMessage(stable),
        retryable: error instanceof EngineInstallerError ? error.retryable : true,
        warnings: [],
      };
    }
  }

  private providers(active: ModelActiveView['source']): ModelProvider[] {
    const localConfigured = Boolean(this.config.model.local.pack || this.config.model.local.path);
    const localAvailable = Boolean(this.activePackId) || this.engineAdapter.isRunning();
    const apiConfigured = Boolean(this.config.model.api.baseUrl && this.config.model.api.model);
    return [
      {
        id: 'heuristic',
        kind: 'builtin',
        configured: true,
        available: true,
        active: active === 'heuristic' || (this.config.model.source === 'auto' && !localAvailable && !apiConfigured),
        reason: null,
      },
      {
        id: 'host',
        kind: 'host',
        configured: true,
        available: true,
        active: active === 'host',
        reason: active === 'host' ? null : 'host_candidates_missing',
      },
      {
        id: 'local',
        kind: 'local-engine',
        configured: localConfigured,
        available: localAvailable,
        active: active === 'local',
        reason: localAvailable ? null : 'local_not_installed',
      },
      {
        id: 'api',
        kind: 'remote',
        configured: apiConfigured,
        available: apiConfigured && this.config.model.api.allowRemote,
        active: active === 'api',
        reason: apiConfigured
          ? (this.config.model.api.allowRemote ? null : 'remote_not_allowed')
          : 'api_not_configured',
      },
    ];
  }

  private async manifestState(packId: string): Promise<{ available: boolean; error: string | null }> {
    try {
      await this.manifestResolver.resolve(packId);
      return { available: true, error: null };
    } catch (error) {
      const code = error instanceof InferenceError ? error.code : 'manifest_missing';
      return { available: false, error: code };
    }
  }

  private async installedStatuses(): Promise<Map<string, ModelStatus>> {
    const map = new Map<string, ModelStatus>();
    for (const pack of this.packs) {
      try {
        map.set(pack.packId, await this.store.getModelStatus(pack.packId));
      } catch {
        map.set(pack.packId, {
          packId: pack.packId,
          modelId: pack.modelId,
          state: 'corrupt',
          errorCode: 'storage_unavailable',
        });
      }
    }
    return map;
  }

  private async preflight(pack: ModelPack, manifest: ModelManifest): Promise<{ warnings: string[] }> {
    const hardware = await this.ensureHardware().catch(() => null);
    if (!hardware) {
      return { warnings: ['hardware_not_detected'] };
    }
    const requirements = manifest.requirements;
    if (!requirements.platforms.includes(hardware.platform)) {
      throw new InferenceError(
        'platform_unsupported',
        `当前平台 ${hardware.platform}/${hardware.arch} 不在模型支持列表`,
        { status: 409, details: { packId: pack.packId } },
      );
    }
    const archs = requirements.architectures;
    if (archs && archs.length > 0 && !archs.includes(hardware.arch)) {
      throw new InferenceError(
        'platform_unsupported',
        `当前架构 ${hardware.arch} 不在模型支持列表`,
        { status: 409, details: { packId: pack.packId } },
      );
    }
    if (hardware.totalMemoryBytes > 0 && hardware.totalMemoryBytes < requirements.minMemoryBytes) {
      throw new InferenceError('memory_insufficient', '可用内存低于模型最低要求', {
        status: 409,
        details: {
          packId: pack.packId,
          requiredBytes: requirements.minMemoryBytes,
          availableBytes: hardware.totalMemoryBytes,
        },
      });
    }
    const availableDisk = hardware.disk.availableBytes;
    const requiredDisk = Math.max(requirements.minDiskBytes, modelManifestTotalBytes(manifest));
    if (availableDisk !== undefined && availableDisk < requiredDisk) {
      throw new InferenceError('disk_insufficient', '可用磁盘低于模型安装所需', {
        status: 409,
        details: {
          packId: pack.packId,
          requiredBytes: requiredDisk,
          availableBytes: availableDisk,
        },
      });
    }
    if (requirements.gpu === 'required') {
      const vram = hardware.gpu.unifiedMemory ? hardware.totalMemoryBytes : hardware.gpu.vramBytes;
      if (hardware.gpu.vendor === 'none' || hardware.gpu.vendor === 'unknown'
        || (requirements.minVramBytes !== undefined && (vram ?? 0) < requirements.minVramBytes)) {
        throw new InferenceError('platform_unsupported', '模型需要 GPU 显存，但当前设备不满足', {
          status: 409,
          details: { packId: pack.packId },
        });
      }
    }
    return { warnings: hardware.warnings };
  }

  private ensureHardwareCached(): HardwareProfile | null {
    if (this.hardware && this.now() - this.hardwareAt <= this.hardwareTtlMs) return this.hardware;
    return null;
  }

  private async ensureHardware(): Promise<HardwareProfile | null> {
    const cached = this.ensureHardwareCached();
    if (cached) return cached;
    if (this.hardwareTask) return this.hardwareTask;
    this.hardwareTask = (async () => {
      try {
        const profile = await this.detectHardwareImpl({ diskPath: this.paths.dataDir });
        this.hardware = profile;
        this.hardwareAt = this.now();
        return profile;
      } catch {
        this.warnings = unique([...this.warnings, 'hardware_probe_failed']);
        return null;
      } finally {
        this.hardwareTask = null;
      }
    })();
    return this.hardwareTask;
  }

  private currentSettings(): InferenceSettings {
    return {
      source: this.config.model.source,
      local: { ...this.config.model.local },
      api: { ...this.config.model.api },
    };
  }

  private async reconfigure(): Promise<void> {
    try {
      await this.inference.reconfigure(this.currentSettings());
    } catch {
      this.warnings = unique([...this.warnings, 'model_reconfigure_failed']);
    }
  }

  private async applyHeuristic(packId: string): Promise<string[]> {
    await this.engineAdapter.stop().catch(() => undefined);
    this.activePackId = null;
    this.config.model.source = 'heuristic';
    this.config.model.local.pack = packId;
    this.config.model.local.path = null;
    await this.reconfigure();
    return this.persistModelConfig('heuristic', packId);
  }

  private async deactivateInternal(packId: string): Promise<string[]> {
    const engine = this.engineAdapter.getView();
    if (!engine.packId || engine.packId === packId) {
      await this.engineAdapter.stop().catch(() => undefined);
    }
    this.activePackId = null;
    this.config.model.source = 'heuristic';
    this.config.model.local.pack = packId;
    this.config.model.local.path = null;
    await this.reconfigure();
    return this.persistModelConfig('heuristic', packId);
  }

  private async applyLocal(packId: string): Promise<string[]> {
    this.activePackId = packId;
    this.config.model.source = 'local';
    this.config.model.local.pack = packId;
    this.config.model.local.path = null;
    await this.reconfigure();
    return this.persistModelConfig('local', packId);
  }

  /** 只更新 config.model.source，保留 local/api 等用户配置；失败只 warning。 */
  private async persistModelSource(source: SidecarConfig['model']['source']): Promise<string[]> {
    try {
      let raw: Record<string, unknown> = {};
      try {
        const text = await readFile(this.paths.configPath, 'utf8');
        const parsed: unknown = JSON.parse(text);
        if (isObject(parsed)) raw = parsed;
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') return ['config_persist_failed'];
      }
      const model = isObject(raw.model) ? { ...raw.model } : {};
      model.source = source;
      raw.model = model;
      await writeJsonAtomic(this.paths.configPath, raw);
      return [];
    } catch {
      return ['config_persist_failed'];
    }
  }

  /** 持久化 source/pack，保证 sidecar 重启后仍按同一模型配置启动；失败只 warning。 */
  private async persistModelConfig(source: 'heuristic' | 'local', packId: string): Promise<string[]> {
    try {
      let raw: Record<string, unknown> = {};
      try {
        const text = await readFile(this.paths.configPath, 'utf8');
        const parsed: unknown = JSON.parse(text);
        if (isObject(parsed)) raw = parsed;
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') return ['config_persist_failed'];
      }
      const model = isObject(raw.model) ? { ...raw.model } : {};
      const local = isObject(model.local) ? { ...model.local } : {};
      model.source = source;
      local.pack = packId;
      delete local.path;
      model.local = local;
      raw.model = model;
      await writeJsonAtomic(this.paths.configPath, raw);
      return [];
    } catch {
      return ['config_persist_failed'];
    }
  }

  private activationView(
    activated: boolean,
    active: ModelActivationView['active'],
    packId: string,
    reason: string | null,
    warnings: string[],
  ): ModelActivationView {
    return {
      activated,
      active,
      packId,
      modelId: this.findPack(packId)?.modelId ?? null,
      reason,
      warnings: unique(warnings),
      engine: this.engineView(),
      restartRequired: false,
    };
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function engineFailureMessage(code: string): string {
  if (code === 'engine_asset_unsupported') return '当前平台没有可用的 llama.cpp 引擎资产';
  if (code === 'engine_not_installed') return 'llama.cpp 引擎尚未安装或未通过校验';
  if (code === 'engine_checksum_mismatch') return 'llama.cpp 引擎下载校验失败';
  if (code === 'engine_size_mismatch') return 'llama.cpp 引擎下载大小不一致';
  if (code === 'engine_extract_failed') return 'llama.cpp 引擎归档解压失败';
  if (code === 'engine_binary_missing') return 'llama.cpp 引擎归档缺少 llama-server';
  if (code === 'cancelled') return 'llama.cpp 引擎安装已取消';
  return 'llama.cpp 引擎安装失败';
}
