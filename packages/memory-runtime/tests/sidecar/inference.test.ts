// Sidecar 内置 inference（C8a）：安装任务、manifest、硬件预检、激活/停用、
// 引擎控制与热切换。全部使用 fake store/engine 与临时目录，不访问网络、不启动真实模型。

import { afterEach, describe, expect, it } from '@jest/globals';
import { readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSidecarConfig, type SidecarConfig, type InferenceSettings } from '../../src/sidecar/config.js';
import type {
  InferenceConfiguredSource,
  InferenceExtractionRequest,
  InferenceExtractionResult,
  InferenceSourceSelection,
  SidecarOptionalModelSelection,
  InferenceProbe,
  InferenceQueryPlanRequest,
  InferenceQueryPlanResult,
  SidecarInferenceProvider,
  InferenceStatus,
  InferenceSummaryRequest,
  InferenceSummaryResult,
} from '../../src/sidecar/inference-provider.js';
import { ModelStoreError, type DownloadModelOptions, type ModelDownloadStatus, type ModelInstallResult, type ModelVerifyResult } from '../../src/inference/store.js';
import { findModelPack } from '../../src/inference/catalog.js';
import { CURATED_MODEL_PACKS } from '../../src/inference/catalog.js';
import type { EngineStatus, HardwareProfile, ModelManifest, ModelStatus } from '../../src/inference/types.js';
import type { InferenceEngine, InferenceProcessStartRequest } from '../../src/sidecar/inference/engine.js';
import {
  EngineInstallerError,
  type EngineInstallOptions,
  type EngineInstallerLike,
  type EngineInstallerStatus,
} from '../../src/sidecar/inference/engine-installer.js';
import { ModelInstaller, type ModelStoreLike } from '../../src/sidecar/inference/model-installer.js';
import { InferenceService, type InstalledModelResolver } from '../../src/sidecar/inference/service.js';
import { CuratedModelManifestResolver, FileModelManifestResolver } from '../../src/sidecar/inference/manifest.js';
import {
  InferenceError,
  type InferenceEngineView,
  type ModelInstallJob,
} from '../../src/sidecar/inference/types.js';

const TEST_PACK = CURATED_MODEL_PACKS.find((pack) => pack.tier === 'light') ?? CURATED_MODEL_PACKS[0]!;
const PACK_ID = TEST_PACK.packId;
const MODEL_ID = TEST_PACK.modelId;
const NOW = 1_760_000_000_000;
const SECRET = 'host-secret-never-exposed';
const SECRET_PATH = '/secret/models/never-expose';

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mebular-inference-'));
  dirs.push(dir);
  return dir;
}

function manifest(overrides: Partial<ModelManifest> = {}): ModelManifest {
  return {
    schema: 1,
    modelId: MODEL_ID,
    packId: PACK_ID,
    displayName: 'Qwen Test 4B',
    format: 'gguf',
    quantization: 'Q4_K_M',
    files: [{ path: 'model.gguf', sizeBytes: 100, sha256: 'a'.repeat(64) }],
    license: { id: 'mit' },
    requirements: {
      platforms: ['darwin', 'linux', 'win32'],
      minMemoryBytes: 8 * 1024 ** 3,
      recommendedMemoryBytes: 12 * 1024 ** 3,
      minDiskBytes: 1,
      gpu: 'optional',
    },
    context: { length: 1024 },
    runtime: { engine: 'llama-server' },
    source: { kind: 'catalog' },
    ...overrides,
  };
}

function downloadStatus(
  state: ModelDownloadStatus['state'],
  downloadedBytes: number,
  totalBytes = 100,
): ModelDownloadStatus {
  return {
    packId: PACK_ID,
    modelId: MODEL_ID,
    state,
    files: [{
      path: 'model.gguf',
      sizeBytes: totalBytes,
      sha256: 'a'.repeat(64),
      state: state === 'installed' ? 'complete' : 'downloading',
      downloadedBytes,
      resumedFrom: 0,
    }],
    downloadedBytes,
    totalBytes,
    startedAt: NOW,
    updatedAt: NOW,
  };
}

function installResult(): ModelInstallResult {
  const value = manifest();
  return {
    packId: PACK_ID,
    modelId: MODEL_ID,
    path: SECRET_PATH,
    manifest: value,
    installedBytes: 100,
    resumedBytes: 0,
    files: [{ path: 'model.gguf', sizeBytes: 100, sha256: 'a'.repeat(64), resumedFrom: 0 }],
  };
}

class FakeStore implements ModelStoreLike {
  readonly statuses = new Map<string, ModelStatus>();
  readonly downloadCalls: DownloadModelOptions[] = [];
  readonly cleared: string[] = [];
  readonly uninstalled: string[] = [];
  verifyCalls = 0;
  verifyOk = true;
  downloadImpl: (options: DownloadModelOptions) => Promise<ModelInstallResult> = async (options) => {
    options.onStatus?.(downloadStatus('downloading', 40));
    options.onStatus?.(downloadStatus('verifying', 100));
    return installResult();
  };

  async getModelStatus(packId: string): Promise<ModelStatus> {
    return this.statuses.get(packId) ?? {
      packId,
      modelId: MODEL_ID,
      state: 'not_installed',
    };
  }

  async download(_manifest: unknown, options: DownloadModelOptions = {}): Promise<ModelInstallResult> {
    this.downloadCalls.push(options);
    return this.downloadImpl(options);
  }

  async verify(packId: string): Promise<ModelVerifyResult> {
    this.verifyCalls += 1;
    return {
      packId,
      ok: this.verifyOk,
      path: SECRET_PATH,
      checkedAt: NOW,
      files: [],
      errors: this.verifyOk ? [] : ['checksum_mismatch'],
    };
  }

  async uninstall(packId: string): Promise<{ removed: boolean; path: string }> {
    this.uninstalled.push(packId);
    this.statuses.set(packId, { packId, modelId: MODEL_ID, state: 'not_installed' });
    return { removed: true, path: SECRET_PATH };
  }

  async clearPartial(packId: string): Promise<{ removed: boolean; path: string }> {
    this.cleared.push(packId);
    return { removed: true, path: SECRET_PATH };
  }

  packPath(packId: string): string {
    return join(SECRET_PATH, packId);
  }
}

class FakeInferenceProvider implements SidecarInferenceProvider {
  settings: InferenceSettings;
  readonly reconfigures: InferenceSettings[] = [];
  disposed = false;

  constructor(settings: InferenceSettings) {
    this.settings = { ...settings, local: { ...settings.local }, api: { ...settings.api } };
  }

  async probe(): Promise<InferenceProbe> {
    return {
      local: {
        configured: Boolean(this.settings.local.pack || this.settings.local.path),
        available: this.settings.source === 'local',
        model: this.settings.source === 'local' ? MODEL_ID : null,
        pack: this.settings.local.pack,
        reason: null,
        warnings: [],
      },
      api: {
        configured: Boolean(this.settings.api.baseUrl && this.settings.api.model),
        available: false,
        allowRemote: this.settings.api.allowRemote,
        baseUrlConfigured: Boolean(this.settings.api.baseUrl),
        model: this.settings.api.model,
        credential: { configured: false, source: null },
        reason: 'api_not_configured',
        warnings: [],
      },
    };
  }

  async status(): Promise<InferenceStatus> {
    return this.currentStatus();
  }

  currentStatus(): InferenceStatus {
    return {
      configured: this.settings.source,
      active: this.settings.source === 'local' ? 'local' : 'heuristic',
      degraded: false,
      reason: null,
      warnings: [],
      credential: { configured: false, source: null },
      sources: ['heuristic', 'host', ...(this.settings.local.pack ? ['local' as const] : [])],
    };
  }

  async reconfigure(settings: InferenceSettings): Promise<void> {
    this.settings = { ...settings, local: { ...settings.local }, api: { ...settings.api } };
    this.reconfigures.push(this.settings);
  }

  async selectExtractionSource(
    requested: InferenceConfiguredSource,
    _allowRemote: boolean,
  ): Promise<InferenceSourceSelection> {
    return { source: requested === 'local' || requested === 'api' ? requested : 'heuristic', warnings: [], degraded: false };
  }

  async selectOptionalSource(_allowRemote: boolean): Promise<SidecarOptionalModelSelection> {
    return { source: this.settings.source === 'local' ? 'local' : null, warnings: [], degraded: false };
  }

  async extractCandidates(_request: InferenceExtractionRequest): Promise<InferenceExtractionResult> {
    return { ok: true, candidates: [], extractor: 'heuristic', degraded: false, warnings: [], latencyMs: 0 };
  }

  async summarize(_request: InferenceSummaryRequest): Promise<InferenceSummaryResult> {
    return { ok: true, summary: '', degraded: false, warnings: [], latencyMs: 0 };
  }

  async planQuery(_request: InferenceQueryPlanRequest): Promise<InferenceQueryPlanResult> {
    return { ok: true, query: '', degraded: false, warnings: [], latencyMs: 0 };
  }

  noteHostCandidates(): void {}

  noteFailure(): void {}

  clearFailure(): void {}

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

class FakeEngineAdapter implements InferenceEngine {
  current: InferenceProcessStartRequest | null = null;
  running = false;
  startCalls = 0;
  stopCalls = 0;
  disposeCalls = 0;
  failStart: Error | null = null;

  async prepare(request: InferenceProcessStartRequest): Promise<void> {
    this.current = { ...request };
    this.running = false;
  }

  async start(request: InferenceProcessStartRequest): Promise<InferenceEngineView> {
    this.startCalls += 1;
    if (this.failStart) throw this.failStart;
    this.current = { ...request };
    this.running = true;
    return this.getView();
  }

  getStatus(): EngineStatus {
    return {
      state: this.running ? 'running' : 'stopped',
      health: this.running ? 'ok' : 'unknown',
      crashCount: 0,
      restartCount: 0,
      ...(this.current?.modelId ? { modelId: this.current.modelId } : {}),
    };
  }

  getView(): InferenceEngineView {
    return {
      state: this.running ? 'running' : 'stopped',
      health: this.running ? 'ok' : 'unknown',
      packId: this.current?.packId ?? null,
      modelId: this.current?.modelId ?? null,
      ...(this.running ? { startedAt: NOW } : {}),
      crashCount: 0,
      restartCount: 0,
      lastError: null,
    };
  }

  isRunning(): boolean {
    return this.running;
  }

  resetCircuit(): void {}

  async stop(): Promise<void> {
    this.stopCalls += 1;
    this.running = false;
  }

  async dispose(): Promise<void> {
    this.disposeCalls += 1;
    this.running = false;
  }
}

class FakeEngineInstaller implements EngineInstallerLike {
  installed: boolean;
  stayUninstalled = false;
  fail: Error | null = null;
  hold: Promise<void> | null = null;
  ensureCalls = 0;
  initCalls = 0;
  removeCalls = 0;
  disposeCalls = 0;

  constructor(options: { installed?: boolean } = {}) {
    this.installed = options.installed ?? true;
  }

  async init(): Promise<void> {
    this.initCalls += 1;
  }

  status(): EngineInstallerStatus {
    return {
      state: this.installed ? 'installed' : 'not_installed',
      installed: this.installed,
      release: 'b12017',
      platform: 'darwin',
      arch: 'arm64',
      asset: 'llama-b12017-bin-macos-arm64.tar.gz',
      binaryReady: this.installed,
      reason: this.installed ? null : 'engine_not_installed',
      progress: this.installed ? 1 : 0,
      installedAt: this.installed ? NOW : null,
      verifiedAt: this.installed ? NOW : null,
      supported: true,
    };
  }

  async ensureInstalled(options: EngineInstallOptions = {}): Promise<EngineInstallerStatus> {
    this.ensureCalls += 1;
    if (this.fail) throw this.fail;
    options.onProgress?.({
      phase: 'downloading',
      progress: 0.5,
      downloadedBytes: 50,
      totalBytes: 100,
    });
    if (this.hold) await this.hold;
    if (!this.stayUninstalled) this.installed = true;
    return this.status();
  }

  binaryPath(): string | null {
    return this.installed ? join(SECRET_PATH, 'engine', 'llama-server') : null;
  }

  async remove(): Promise<{ removed: boolean }> {
    this.removeCalls += 1;
    this.installed = false;
    return { removed: true };
  }

  async dispose(): Promise<void> {
    this.disposeCalls += 1;
  }
}

function hardware(overrides: Partial<HardwareProfile> = {}): HardwareProfile {
  return {
    platform: 'darwin',
    arch: 'arm64',
    cpuCores: 8,
    totalMemoryBytes: 32 * 1024 ** 3,
    freeMemoryBytes: 16 * 1024 ** 3,
    disk: { path: '/secret/disk', availableBytes: 100 * 1024 ** 3, totalBytes: 500 * 1024 ** 3 },
    gpu: { vendor: 'apple', name: 'Apple M', unifiedMemory: true },
    detectedAt: NOW,
    warnings: [],
    ...overrides,
  };
}

interface ServiceHarness {
  home: string;
  store: FakeStore;
  model: FakeInferenceProvider;
  engine: FakeEngineAdapter;
  engineInstaller: FakeEngineInstaller;
  service: InferenceService;
  config: SidecarConfig;
}

async function createService(options: {
  source?: InferenceSettings['source'];
  installed?: boolean;
  store?: FakeStore;
  model?: FakeInferenceProvider;
  engine?: FakeEngineAdapter;
  engineInstaller?: FakeEngineInstaller;
  hardware?: HardwareProfile | null;
  resolveManifest?: (packId: string) => Promise<ModelManifest>;
  resolveInstalledModel?: InstalledModelResolver;
  createJobId?: () => string;
  config?: SidecarConfig;
  useCuratedManifest?: boolean;
} = {}): Promise<ServiceHarness> {
  const home = await tempDir();
  const config = options.config ?? defaultSidecarConfig();
  config.model.source = options.source ?? 'heuristic';
  if (options.source === 'local') config.model.local.pack = PACK_ID;
  const store = options.store ?? new FakeStore();
  if (options.installed !== false) {
    store.statuses.set(PACK_ID, {
      packId: PACK_ID,
      modelId: MODEL_ID,
      state: 'installed',
      installedPath: SECRET_PATH,
      installedBytes: 100,
      expectedBytes: 100,
    });
  }
  const model = options.model ?? new FakeInferenceProvider(config.model);
  const engine = options.engine ?? new FakeEngineAdapter();
  const engineInstaller = options.engineInstaller ?? new FakeEngineInstaller();
  const service = new InferenceService({
    paths: {
      dataDir: home,
      modelsDir: join(home, 'models'),
      configPath: join(home, 'config.json'),
    },
    config,
    inference: model,
    store,
    engineAdapter: engine,
    engineInstaller,
    ...(options.useCuratedManifest
      ? {}
      : {
        manifestResolver: {
          resolve: options.resolveManifest ?? (async () => manifest()),
        },
      }),
    ...(options.resolveInstalledModel
      ? { resolveInstalledModel: options.resolveInstalledModel }
      : {
        resolveInstalledModel: async (packId: string) => ({
          modelPath: join(SECRET_PATH, packId, 'model.gguf'),
          modelId: MODEL_ID,
          manifest: manifest(),
        }),
      }),
    hardware: options.hardware === null ? undefined : (options.hardware ?? hardware()),
    detectHardware: async () => options.hardware ?? hardware(),
    now: () => NOW,
    ...(options.createJobId ? { createJobId: options.createJobId } : {}),
  });
  await service.init();
  return { home, store, model, engine, engineInstaller, service, config };
}

async function waitFor<T>(fn: () => T | Promise<T>, timeoutMs = 1000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('curated manifest resolver', () => {
  it('默认使用精选目录内置 manifest，可直接安装', async () => {
    const resolver = new CuratedModelManifestResolver();
    const resolved = await resolver.resolve(PACK_ID);
    expect(resolved.packId).toBe(PACK_ID);
    expect(resolved.files[0]?.url).toContain('huggingface.co');
    await expect(resolver.resolve('qwen3.5-9b-instruct-q4_k_m')).rejects.toMatchObject({
      code: 'unknown_pack',
      status: 404,
    });
  });

  it('InferenceService 默认 resolver 让目录 manifest 可用', async () => {
    const harness = await createService({ useCuratedManifest: true, installed: false });
    const catalog = await harness.service.listModels();
    expect(catalog.packs.length).toBeGreaterThan(0);
    expect(catalog.packs.every((pack) => pack.manifest.available)).toBe(true);
  });
});

describe('sidecar model install manager', () => {
  it('同一时间只允许一个安装，进度/完成状态可查询并持久化', async () => {
    const home = await tempDir();
    const store = new FakeStore();
    let release!: () => void;
    store.downloadImpl = async (options) => {
      options.onStatus?.(downloadStatus('downloading', 40));
      await new Promise<void>((resolve) => { release = resolve; });
      options.onStatus?.(downloadStatus('installing', 100));
      return installResult();
    };
    const manager = new ModelInstaller({
      dataDir: home,
      store,
      resolvePack: () => findModelPack(PACK_ID),
      resolveManifest: async () => manifest(),
      now: () => NOW,
      createJobId: () => 'job_test',
    });
    await manager.init();
    const job = await manager.install(PACK_ID);
    expect(job).toMatchObject({ jobId: 'job_test', packId: PACK_ID, state: 'downloading' });
    await expect(manager.install(PACK_ID)).rejects.toMatchObject({ code: 'install_in_progress' });
    const progress = await waitFor(() => {
      const current = manager.get('job_test');
      return current && current.downloadedBytes >= 40 ? current : null;
    });
    expect(progress!.progress).toBeGreaterThan(0);
    release();
    const done = await waitFor(() => {
      const current = manager.get('job_test');
      return current?.state === 'completed' ? current : null;
    });
    expect(done).toMatchObject({ progress: 1, downloadedBytes: 100, totalBytes: 100, error: null });
    const persisted = await waitFor(async () => {
      const parsed = JSON.parse(await readFile(join(home, 'inference', 'install.json'), 'utf8')) as { job: ModelInstallJob };
      return parsed.job.state === 'completed' ? parsed : null;
    });
    expect(persisted!.job.state).toBe('completed');
    expect(JSON.stringify(persisted)).not.toContain(SECRET_PATH);
  });

  it('取消会 abort 下载并清理 partial', async () => {
    const home = await tempDir();
    const store = new FakeStore();
    store.downloadImpl = async (options) => {
      options.onStatus?.(downloadStatus('downloading', 20));
      return new Promise<ModelInstallResult>((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => {
          reject(new ModelStoreError('cancelled', 'cancelled'));
        }, { once: true });
      });
    };
    const manager = new ModelInstaller({
      dataDir: home,
      store,
      resolvePack: () => findModelPack(PACK_ID),
      resolveManifest: async () => manifest(),
      now: () => NOW,
      createJobId: () => 'job_cancel',
    });
    await manager.init();
    await manager.install(PACK_ID);
    const cancelled = await manager.cancel('job_cancel');
    expect(cancelled).toMatchObject({ state: 'cancelled', progress: 0.2 });
    expect(store.cleared).toEqual([PACK_ID]);
  });

  it('sidecar 重启把进行中的任务标为 interrupted 并保留 partial', async () => {
    const home = await tempDir();
    const store = new FakeStore();
    await mkdir(join(home, 'inference'), { recursive: true });
    await writeFile(join(home, 'inference', 'install.json'), JSON.stringify({
      schema: 1,
      job: {
        schema: 1,
        jobId: 'job_old',
        packId: PACK_ID,
        modelId: MODEL_ID,
        state: 'downloading',
        progress: 0.5,
        downloadedBytes: 50,
        totalBytes: 100,
        speedBytesPerSecond: 10,
        etaMs: 5000,
        startedAt: NOW - 1000,
        updatedAt: NOW - 500,
        completedAt: null,
        error: null,
        warnings: [],
      },
    }));
    const manager = new ModelInstaller({
      dataDir: home,
      store,
      resolvePack: () => findModelPack(PACK_ID),
      resolveManifest: async () => manifest(),
      now: () => NOW,
    });
    await manager.init();
    const job = manager.get('job_old');
    expect(job).toMatchObject({
      state: 'interrupted',
      error: { code: 'sidecar_restarted', retryable: true },
      downloadedBytes: 50,
    });
    expect(store.cleared).toEqual([]);
  });

  it('manifest 缺失返回结构化 manifest_missing，不下载', async () => {
    const home = await tempDir();
    const store = new FakeStore();
    const manager = new ModelInstaller({
      dataDir: home,
      store,
      resolvePack: () => findModelPack(PACK_ID),
      resolveManifest: async () => {
        throw new InferenceError('manifest_missing', '缺少 manifest', { status: 409 });
      },
      now: () => NOW,
    });
    await manager.init();
    await expect(manager.install(PACK_ID)).rejects.toMatchObject({
      code: 'manifest_missing',
      status: 409,
    });
    expect(store.downloadCalls).toHaveLength(0);
  });

  it('磁盘/内存预检失败返回结构化 code，不创建下载', async () => {
    const home = await tempDir();
    const store = new FakeStore();
    const manager = new ModelInstaller({
      dataDir: home,
      store,
      resolvePack: () => findModelPack(PACK_ID),
      resolveManifest: async () => manifest(),
      preflight: async () => {
        throw new InferenceError('disk_insufficient', '磁盘不足', { status: 409 });
      },
      now: () => NOW,
    });
    await manager.init();
    await expect(manager.install(PACK_ID)).rejects.toMatchObject({ code: 'disk_insufficient' });
    expect(store.downloadCalls).toHaveLength(0);
  });

  it('安装任务按 model → engine 阶段推进，引擎已安装时完成', async () => {
    const home = await tempDir();
    const store = new FakeStore();
    store.downloadImpl = async (options) => {
      options.onStatus?.(downloadStatus('downloading', 40));
      options.onStatus?.(downloadStatus('installing', 100));
      store.statuses.set(PACK_ID, {
        packId: PACK_ID,
        modelId: MODEL_ID,
        state: 'installed',
        installedBytes: 100,
        expectedBytes: 100,
      });
      return installResult();
    };
    const engineInstaller = new FakeEngineInstaller({ installed: false });
    let release!: () => void;
    engineInstaller.hold = new Promise<void>((resolve) => { release = resolve; });
    const manager = new ModelInstaller({
      dataDir: home,
      store,
      resolvePack: () => findModelPack(PACK_ID),
      resolveManifest: async () => manifest(),
      engineInstaller,
      now: () => NOW,
      createJobId: () => 'job_phase',
    });
    await manager.init();
    await manager.install(PACK_ID);
    const enginePhase = await waitFor(() => {
      const job = manager.get('job_phase');
      return job?.phase === 'engine'
        && (job.state === 'downloading' || job.state === 'verifying' || job.state === 'installing')
        ? job
        : null;
    });
    expect(enginePhase!.phase).toBe('engine');
    expect(store.downloadCalls).toHaveLength(1);
    release();
    const done = await waitFor(() => {
      const job = manager.get('job_phase');
      return job?.state === 'completed' ? job : null;
    });
    expect(done).toMatchObject({ phase: 'engine', progress: 1, error: null });
    expect(done!.warnings).toEqual(expect.arrayContaining(['model_installed', 'engine_ready']));
    expect(engineInstaller.ensureCalls).toBe(1);
  });

  it('引擎安装失败时模型仍在、job 结构化失败；重试跳过已安装模型', async () => {
    const home = await tempDir();
    const store = new FakeStore();
    store.downloadImpl = async (options) => {
      options.onStatus?.(downloadStatus('downloading', 100));
      store.statuses.set(PACK_ID, {
        packId: PACK_ID,
        modelId: MODEL_ID,
        state: 'installed',
        installedBytes: 100,
        expectedBytes: 100,
      });
      return installResult();
    };
    const engineInstaller = new FakeEngineInstaller({ installed: false });
    engineInstaller.fail = new EngineInstallerError('engine_checksum_mismatch', 'checksum mismatch', true);
    const manager = new ModelInstaller({
      dataDir: home,
      store,
      resolvePack: () => findModelPack(PACK_ID),
      resolveManifest: async () => manifest(),
      engineInstaller,
      now: () => NOW,
      createJobId: () => 'job_engine_failed',
    });
    await manager.init();
    await manager.install(PACK_ID);
    const failed = await waitFor(() => {
      const job = manager.get('job_engine_failed');
      return job?.state === 'failed' ? job : null;
    });
    expect(failed).toMatchObject({
      phase: 'engine',
      error: { code: 'engine_checksum_mismatch', retryable: true },
    });
    expect(failed!.warnings).toEqual(expect.arrayContaining(['model_installed', 'engine_install_failed']));
    expect((await store.getModelStatus(PACK_ID)).state).toBe('installed');

    engineInstaller.fail = null;
    const retry = await manager.install(PACK_ID);
    expect(retry).toMatchObject({ phase: 'engine', state: 'installing' });
    expect(store.downloadCalls).toHaveLength(1);
    const completed = await waitFor(() => {
      const job = manager.get('job_engine_failed');
      return job?.state === 'completed' ? job : null;
    });
    expect(completed).toMatchObject({ phase: 'engine', progress: 1, error: null });
    expect(engineInstaller.ensureCalls).toBe(2);
    expect(store.downloadCalls).toHaveLength(1);
  });
});

describe('sidecar model runtime service', () => {
  it('activate 校验安装、启动引擎并在进程内热切换 provider', async () => {
    const harness = await createService();
    const result = await harness.service.activate(PACK_ID);
    expect(result).toMatchObject({
      activated: true,
      active: 'local',
      packId: PACK_ID,
      reason: null,
      restartRequired: false,
    });
    expect(harness.engine.startCalls).toBe(1);
    expect(harness.engine.running).toBe(true);
    expect(harness.engine.current?.binaryPath).toContain('llama-server');
    expect(harness.engineInstaller.ensureCalls).toBe(1);
    expect(harness.store.verifyCalls).toBe(1);
    expect(harness.model.reconfigures.at(-1)).toMatchObject({
      source: 'local',
      local: { pack: PACK_ID, path: null },
    });
    expect(harness.model.disposed).toBe(false);
    expect(harness.engine.disposeCalls).toBe(0);
    const persisted = JSON.parse(await readFile(join(harness.home, 'config.json'), 'utf8')) as any;
    expect(persisted.model).toMatchObject({ source: 'local', local: { pack: PACK_ID } });
  });

  it('引擎启动失败只回退 heuristic，返回稳定 reason/warnings', async () => {
    const harness = await createService();
    harness.engine.failStart = new InferenceError('engine_unavailable', '引擎失败', {
      status: 503,
      details: { engineCode: 'startup_timeout' },
    });
    const result = await harness.service.activate(PACK_ID);
    expect(result).toMatchObject({
      activated: false,
      active: 'heuristic',
      reason: 'engine_unavailable',
      restartRequired: false,
    });
    expect(result.warnings).toEqual(expect.arrayContaining(['engine_unavailable', 'engine:startup_timeout']));
    expect(harness.engine.running).toBe(false);
    expect(harness.model.reconfigures.at(-1)?.source).toBe('heuristic');
  });

  it('引擎不可用/安装失败时 activate 回退 heuristic，start 返回结构化错误', async () => {
    const missing = new FakeEngineInstaller({ installed: false });
    missing.stayUninstalled = true;
    const notInstalled = await createService({ engineInstaller: missing });
    const activateMissing = await notInstalled.service.activate(PACK_ID);
    expect(activateMissing).toMatchObject({
      activated: false,
      active: 'heuristic',
      reason: 'engine_not_installed',
    });
    expect(notInstalled.engine.startCalls).toBe(0);
    await expect(notInstalled.service.startEngine(PACK_ID)).rejects.toMatchObject({
      code: 'engine_not_installed',
      status: 503,
    });

    const failing = new FakeEngineInstaller({ installed: false });
    failing.fail = new EngineInstallerError('engine_checksum_mismatch', 'checksum', true);
    const installFailed = await createService({ engineInstaller: failing });
    const activateFailed = await installFailed.service.activate(PACK_ID);
    expect(activateFailed).toMatchObject({
      activated: false,
      active: 'heuristic',
      reason: 'engine_checksum_mismatch',
    });
    expect(activateFailed.warnings).toEqual(expect.arrayContaining([
      'engine_checksum_mismatch',
      'engine:engine_checksum_mismatch',
    ]));
    await expect(installFailed.service.startEngine(PACK_ID)).rejects.toMatchObject({
      code: 'engine_checksum_mismatch',
      status: 503,
    });
  });

  it('deactivate 回到 heuristic、停止引擎且保留模型文件', async () => {
    const harness = await createService();
    await harness.service.activate(PACK_ID);
    const result = await harness.service.deactivate(PACK_ID);
    expect(result).toMatchObject({ activated: false, active: 'heuristic', reason: null });
    expect(harness.engine.running).toBe(false);
    expect(harness.store.uninstalled).toEqual([]);
    expect(harness.model.reconfigures.at(-1)?.source).toBe('heuristic');
  });

  it('remove 先停用 active 模型再卸载文件，且 status 不泄漏路径/token', async () => {
    const harness = await createService();
    await harness.service.activate(PACK_ID);
    const result = await harness.service.removeModel(PACK_ID);
    expect(result).toMatchObject({ packId: PACK_ID, removed: true, wasActive: true });
    expect(harness.engine.running).toBe(false);
    expect(harness.store.uninstalled).toEqual([PACK_ID]);

    const status = await harness.service.status();
    const catalog = await harness.service.listModels();
    const payload = JSON.stringify({ status, catalog });
    expect(payload).not.toContain(SECRET);
    expect(payload).not.toContain(SECRET_PATH);
    expect(payload).not.toContain('host-token');
  });

  it('start/stop 只控制引擎，不改变 provider 配置', async () => {
    const harness = await createService();
    const started = await harness.service.startEngine(PACK_ID);
    expect(started.started).toBe(true);
    expect(harness.engine.running).toBe(true);
    expect(harness.model.reconfigures).toHaveLength(0);
    const stopped = await harness.service.stopEngine(PACK_ID);
    expect(stopped.stopped).toBe(true);
    expect(harness.engine.running).toBe(false);
    expect(harness.model.reconfigures).toHaveLength(0);
  });

  it('安装前硬件预检失败返回 memory_insufficient/disk_insufficient', async () => {
    const small = await createService({
      hardware: hardware({ totalMemoryBytes: 1, disk: { path: '/secret/disk', availableBytes: 1 } }),
      installed: false,
    });
    await expect(small.service.install(PACK_ID)).rejects.toMatchObject({ code: 'memory_insufficient' });
    expect(small.store.downloadCalls).toHaveLength(0);

    const noDisk = await createService({
      hardware: hardware({ disk: { path: '/secret/disk', availableBytes: 1 } }),
      installed: false,
    });
    await expect(noDisk.service.install(PACK_ID)).rejects.toMatchObject({ code: 'disk_insufficient' });
  });

  it('FileModelManifestResolver 缺失 manifest 时返回 manifest_missing，不泄漏目录', async () => {
    const home = await tempDir();
    const dir = join(home, 'model-manifests');
    const resolver = new FileModelManifestResolver(dir);
    await expect(resolver.resolve(PACK_ID)).rejects.toMatchObject({
      code: 'manifest_missing',
      status: 409,
    });
    await expect(resolver.resolve('../escape')).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('init 按配置恢复 local target，但不提前启动引擎', async () => {
    const harness = await createService({
      source: 'local',
      config: (() => {
        const config = defaultSidecarConfig();
        config.model.source = 'local';
        config.model.local.pack = PACK_ID;
        return config;
      })(),
    });
    expect(harness.engine.current?.packId).toBe(PACK_ID);
    expect(harness.engine.startCalls).toBe(0);
    expect(harness.engine.running).toBe(false);
  });
});
