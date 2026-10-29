// Admin / CLI 共用的本地模型管理面（0.3.0）。
//
// Admin 路由（均在现有 auth/CSRF/Origin/scope 管线之后）：
//   GET  /admin/api/models                 目录 + 安装/下载状态
//   GET  /admin/api/models/status          硬件/推荐/引擎/有效 runtime 配置
//   POST /admin/api/models/select          显式选择（require installed）
//   POST /admin/api/models/download        显式下载（不自动选择、不自动更新）
//   POST /admin/api/models/pause|resume|cancel
//   POST /admin/api/models/import          离线导入目录
//   POST /admin/api/models/uninstall|remove
//   POST /admin/api/models/start|stop|test
//
// CLI `mebular models ... --json` 复用同一 manager；daemon 可用时通过 admin HTTP，
// 否则 list/status/import/remove/test 直接在设备 store 上执行。start/stop 必须由
// 常驻 daemon 持有子进程，避免 CLI 退出后留下孤儿。

import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  DEFAULT_THREADS,
  InferenceError,
  assertPackId,
  ensureInferenceStore,
  inferenceCore,
  inferencePaths,
  loadModelCatalog,
  readDeviceConfig,
  readInferenceState,
  readInstalledPack,
  resolveManifestForPack,
  resolveModelSettings,
  writeInferenceState,
  writeRuntimeModelConfig,
} from './inference-store.mjs';
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_STARTUP_TIMEOUT_MS,
  createInferenceEngineManager,
} from './inference-engine.mjs';

const managers = new Map();

function packIdOf(input = {}) {
  return input.pack ?? input.packId ?? input.id ?? null;
}

function boolOf(value) {
  return value === true || value === 'true' || value === '1';
}

function normalizeMirrors(value) {
  if (value === undefined || value === null) return undefined;
  const list = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',').map((entry) => entry.trim()).filter(Boolean)
      : [];
  return list.filter((entry) => typeof entry === 'string' && entry.length > 0);
}

function configModel(config) {
  const local = config?.runtime?.model?.local;
  return local && typeof local === 'object' && !Array.isArray(local) ? local : {};
}

function hardwareOverride(env) {
  const raw = env?.MEBULAR_MODEL_HARDWARE_JSON;
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function publicDownload(state, live = null) {
  if (live) {
    return {
      pack: live.packId,
      packId: live.packId,
      state: live.state,
      downloadedBytes: live.downloadedBytes ?? 0,
      totalBytes: live.totalBytes ?? 0,
      startedAt: live.startedAt ?? null,
      updatedAt: live.updatedAt ?? null,
      ...(live.error ? { error: live.error } : {}),
      ...(live.reason ? { reason: live.reason } : {}),
    };
  }
  if (!state) return null;
  return {
    pack: state.packId,
    packId: state.packId,
    state: state.state,
    downloadedBytes: state.downloadedBytes ?? 0,
    totalBytes: state.totalBytes ?? 0,
    updatedAt: state.updatedAt ?? null,
    ...(state.error ? { error: state.error } : {}),
    ...(state.reason ? { reason: state.reason } : {}),
  };
}

function safeDetails(details) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return undefined;
  const allowed = [
    'pack', 'status', 'expectedBytes', 'actualBytes', 'expected', 'actual',
    'errors', 'hint', 'manifestDir', 'reason',
  ];
  const out = {};
  for (const key of allowed) {
    if (details[key] !== undefined) out[key] = details[key];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function translateError(error) {
  if (error instanceof InferenceError) return error;
  const code = typeof error?.code === 'string' ? error.code : 'internal';
  const statusByCode = {
    unknown_pack: 404,
    not_installed: 409,
    install_exists: 409,
    download_in_progress: 409,
    selection_in_use: 409,
    invalid_manifest: 400,
    manifest_missing: 409,
    manifest_mismatch: 400,
    unsafe_path: 400,
    no_source: 400,
    import_failed: 400,
    checksum_mismatch: 422,
    size_mismatch: 422,
    cancelled: 409,
    http_error: 502,
    download_failed: 502,
    circuit_open: 409,
  };
  const details = safeDetails(error?.details);
  return new InferenceError(code, String(error?.message ?? error), {
    status: statusByCode[code] ?? 500,
    retryable: error?.retryable === true || ['http_error', 'download_failed'].includes(code),
    ...(details ? { details } : {}),
  });
}

export class InferenceManager {
  constructor({
    home,
    env = process.env,
    now = Date.now,
    sleep,
    fetch,
    storeFactory = null,
    engineFactory = null,
    gatewayFactory = null,
    manifestDir = null,
    detect = null,
    hardwareTtlMs = 60_000,
  } = {}) {
    this.home = home;
    this.env = env;
    this.now = now;
    this.sleep = sleep;
    this.fetch = fetch;
    this.storeFactory = storeFactory;
    this.engineFactory = engineFactory;
    this.gatewayFactory = gatewayFactory;
    this.manifestDir = manifestDir;
    this.detect = detect;
    this.hardwareTtlMs = hardwareTtlMs;
    this.store = null;
    this.engine = null;
    this.jobs = new Map();
    this.persistChain = Promise.resolve();
    this.hardwareCache = null;
  }

  paths() {
    return inferencePaths(this.home);
  }

  storeFor() {
    if (this.store) return this.store;
    if (typeof this.storeFactory === 'function') {
      this.store = this.storeFactory({ home: this.home, modelsDir: this.paths().modelsDir });
      return this.store;
    }
    const lib = inferenceCore();
    this.store = new lib.ModelStore({
      rootDir: this.paths().modelsDir,
      ...(this.fetch ? { fetch: this.fetch } : {}),
      now: this.now,
      ...(this.sleep ? { sleep: this.sleep } : {}),
    });
    return this.store;
  }

  engineFor() {
    if (this.engine) return this.engine;
    const paths = this.paths();
    this.engine = createInferenceEngineManager({
      home: this.home,
      modelsDir: paths.modelsDir,
      env: this.env,
      now: this.now,
      ...(this.sleep ? { sleep: this.sleep } : {}),
      ...(this.engineFactory ? { engineFactory: this.engineFactory } : {}),
      ...(this.gatewayFactory ? { gatewayFactory: this.gatewayFactory } : {}),
      idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
      startupTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS,
    });
    return this.engine;
  }

  async catalog() {
    return loadModelCatalog(this.home, {
      ...(this.manifestDir ? { manifestDir: this.manifestDir } : {}),
    });
  }

  async state() {
    return readInferenceState(this.home, { init: true });
  }

  persist(state) {
    this.persistChain = this.persistChain
      .catch(() => undefined)
      .then(() => writeInferenceState(this.home, state))
      .catch(() => undefined);
    return this.persistChain;
  }

  async hardware(packs) {
    if (this.hardwareCache && this.now() - this.hardwareCache.at < this.hardwareTtlMs) {
      return this.hardwareCache.value;
    }
    const paths = this.paths();
    const lib = inferenceCore();
    let profile = hardwareOverride(this.env);
    const warnings = [];
    if (!profile) {
      try {
        profile = this.detect
          ? await this.detect({ diskPath: paths.modelsDir })
          : await lib.detectHardware({ diskPath: paths.modelsDir });
      } catch {
        warnings.push('hardware_detection_failed');
      }
    }
    const value = { profile: profile ?? null, recommendation: null, warnings };
    if (profile) {
      try {
        value.recommendation = lib.recommendModel(profile, packs);
      } catch {
        warnings.push('model_recommendation_failed');
      }
    }
    this.hardwareCache = { at: this.now(), value };
    return value;
  }

  async list({ config = {} } = {}) {
    const paths = await ensureInferenceStore(this.home);
    const stateRead = await readInferenceState(this.home, { init: false });
    const catalog = await this.catalog();
    const settings = resolveModelSettings({ config, state: stateRead.state, home: this.home });
    const packs = [];

    for (const pack of catalog.packs) {
      // config 显式 path 是用户覆盖；对选中的包按该目录检查安装状态。
      const dirOverride = settings.pack === pack.packId && settings.path && settings.path !== join(paths.modelsDir, pack.packId)
        ? settings.path
        : null;
      const installed = await readInstalledPack(this.home, pack.packId, { dir: dirOverride });
      const live = this.jobs.get(pack.packId);
      const download = publicDownload(
        stateRead.state.downloads[pack.packId]
          ? { ...stateRead.state.downloads[pack.packId], packId: pack.packId }
          : null,
        live,
      );
      let status = installed.state;
      if (!installed.installed && download && ['downloading', 'paused', 'failed'].includes(download.state)) {
        status = download.state;
      } else if (installed.state === 'installed' && download?.state === 'downloading') {
        status = 'downloading';
      }
      packs.push({
        packId: pack.packId,
        modelId: pack.modelId,
        tier: pack.tier,
        displayName: pack.displayName,
        description: pack.description,
        quantization: pack.quantization,
        contextLength: pack.contextLength,
        estimatedDownloadBytes: pack.estimatedDownloadBytes,
        default: pack.default === true,
        requirements: { ...pack.requirements, platforms: [...pack.requirements.platforms] },
        source: {
          kind: pack.source.kind,
          ...(pack.source.repository ? { repository: { ...pack.source.repository } } : {}),
          ...(pack.source.homepage ? { homepage: pack.source.homepage } : {}),
          ...(pack.source.licenseUrl ? { licenseUrl: pack.source.licenseUrl } : {}),
        },
        selected: settings.pack === pack.packId,
        installed: installed.state === 'installed',
        state: status,
        manifestAvailable: Boolean(pack.manifest),
        installedPath: installed.installed ? installed.dir : null,
        installedBytes: installed.installedBytes || 0,
        expectedBytes: installed.expectedBytes || pack.estimatedDownloadBytes,
        ...(installed.errors.length > 0 ? { errors: [...installed.errors] } : {}),
        ...(download ? { download } : {}),
      });
    }

    return {
      ok: true,
      schema: 1,
      home: paths.home,
      modelsDir: paths.modelsDir,
      statePath: paths.statePath,
      manifestDir: catalog.manifestDir,
      selectedPack: stateRead.state.selectedPack,
      effectivePack: settings.pack,
      selectionSource: settings.selectionSource,
      runtime: settings,
      packs,
      warnings: [...stateRead.warnings, ...catalog.warnings],
      ...(stateRead.stateError ? { stateError: stateRead.stateError } : {}),
    };
  }

  async status({ config = {}, includeHardware = true } = {}) {
    const list = await this.list({ config });
    const stateRead = await this.state();
    const settings = resolveModelSettings({ config, state: stateRead.state, home: this.home });
    const hardware = includeHardware
      ? await this.hardware(list.packs)
      : { profile: null, recommendation: null, warnings: [] };
    const engine = this.engineFor().getStatus();
    const localConfig = configModel(config);
    const warnings = [...list.warnings, ...hardware.warnings];
    if (settings.pack && settings.source !== 'local' && settings.source !== 'auto') {
      warnings.push('runtime_source_not_local');
    }
    if (settings.configPack && settings.selectedPack && settings.configPack !== settings.selectedPack) {
      warnings.push('config_pack_overrides_selection');
    }
    if (settings.pack) {
      const pack = list.packs.find((entry) => entry.packId === settings.pack);
      if (!pack) warnings.push('selected_pack_unknown');
      if (pack && pack.state !== 'installed') {
        warnings.push('selected_pack_not_installed');
      }
      if (pack && pack.state === 'corrupt') {
        warnings.push('selected_pack_corrupt');
      }
    }
    return {
      ok: true,
      schema: 1,
      home: list.home,
      modelsDir: list.modelsDir,
      statePath: list.statePath,
      manifestDir: list.manifestDir,
      selectedPack: list.selectedPack,
      effectivePack: list.effectivePack,
      selectionSource: list.selectionSource,
      runtime: {
        source: settings.source,
        pack: settings.pack,
        path: settings.path,
        threads: settings.threads,
        selectionSource: settings.selectionSource,
        configPack: settings.configPack,
        configuredPath: localConfig.path ?? null,
        enginePath: localConfig.enginePath ?? null,
        idleTimeoutMs: localConfig.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
      },
      engine,
      hardware: hardware.profile,
      recommendation: hardware.recommendation,
      downloads: list.packs
        .filter((pack) => pack.download && !['installed'].includes(pack.download.state))
        .map((pack) => pack.download),
      packs: list.packs.map((pack) => ({
        packId: pack.packId,
        modelId: pack.modelId,
        tier: pack.tier,
        state: pack.state,
        selected: pack.selected,
        installed: pack.installed,
        installedBytes: pack.installedBytes,
        expectedBytes: pack.expectedBytes,
      })),
      warnings: [...new Set(warnings)],
      ...(list.stateError ? { stateError: list.stateError } : {}),
      ...(stateRead.stateError ? { stateError: stateRead.stateError } : {}),
    };
  }

  async select(input = {}, { config = {} } = {}) {
    const packId = assertPackId(packIdOf(input));
    const catalog = await this.catalog();
    if (!catalog.packs.some((pack) => pack.packId === packId)) {
      throw new InferenceError('unknown_pack', `未知模型包：${packId}`, { status: 404 });
    }
    const stateBefore = await this.state();
    const settingsBefore = resolveModelSettings({ config, state: stateBefore.state, home: this.home });
    const pathsBefore = this.paths();
    const dirOverride = settingsBefore.pack === packId
      && settingsBefore.path
      && settingsBefore.path !== join(pathsBefore.modelsDir, packId)
      ? settingsBefore.path
      : null;
    const installed = await readInstalledPack(this.home, packId, { dir: dirOverride });
    if (installed.state !== 'installed' && !boolOf(input.allowMissing)) {
      throw new InferenceError('not_installed', `模型包未安装：${packId}`, {
        status: 409,
        details: { pack: packId, state: installed.state },
      });
    }
    if (this.engine && this.engine.getStatus().packId && this.engine.getStatus().packId !== packId) {
      await this.engine.stop().catch(() => undefined);
    }
    const paths = await ensureInferenceStore(this.home);
    // 选择本地精选包默认把 runtime.model.source 切到 local；调用方仍可显式传
    // host/api/auto/heuristic。这样“select 成功但 runtime 仍走 heuristic”不会发生。
    const source = typeof input.source === 'string' ? input.source : 'local';
    await writeRuntimeModelConfig(this.home, {
      pack: packId,
      path: join(paths.modelsDir, packId),
      source,
    });
    const stateRead = await readInferenceState(this.home, { init: false });
    const next = {
      ...stateRead.state,
      selectedPack: packId,
    };
    await writeInferenceState(this.home, next);
    // config 刚被写入 pack/path；重新读取，状态里的 runtime 才是实际生效值。
    const nextConfig = await readDeviceConfig(this.home);
    const effective = resolveModelSettings({ config: nextConfig, state: next, home: this.home });
    return {
      ok: true,
      selectedPack: packId,
      runtime: effective,
      requiresRestart: false,
      warnings: installed.state === 'installed' ? [] : ['selected_pack_not_installed'],
    };
  }

  async download(input = {}) {
    const packId = assertPackId(packIdOf(input));
    const previousJob = this.jobs.get(packId);
    if (previousJob && ['downloading', 'verifying', 'installing'].includes(previousJob.state)) {
      throw new InferenceError('download_in_progress', `模型包正在下载：${packId}`, { status: 409 });
    }
    if (previousJob) this.jobs.delete(packId);
    const installed = await readInstalledPack(this.home, packId);
    if (installed.installed && !boolOf(input.force)) {
      throw new InferenceError('install_exists', `模型包已安装：${packId}`, { status: 409 });
    }
    const catalog = await this.catalog();
    const resolved = await resolveManifestForPack({
      home: this.home,
      packId,
      manifest: input.manifest ?? null,
      manifestPath: input.manifestPath ?? input.manifestFile ?? null,
      catalog,
    });
    // 覆盖安装前先停掉正在使用同一包的引擎，避免运行中的进程读到被替换的文件。
    if (this.engine && this.engine.getStatus().packId === packId) {
      await this.engine.stop().catch(() => undefined);
    }
    const mirrors = normalizeMirrors(input.mirrors ?? input.mirror);
    const force = boolOf(input.force);
    const job = {
      packId,
      state: 'downloading',
      downloadedBytes: 0,
      totalBytes: 0,
      startedAt: this.now(),
      updatedAt: this.now(),
      pauseRequested: false,
      controller: new AbortController(),
      promise: null,
      manifest: resolved.manifest,
      force,
      mirrors,
    };
    this.jobs.set(packId, job);
    job.promise = this.runDownload(job).finally(() => {
      job.updatedAt = this.now();
    });
    if (boolOf(input.wait)) {
      await job.promise;
      return this.downloadResult(job);
    }
    return { ok: true, accepted: true, job: publicDownload(job) };
  }

  downloadResult(job) {
    const body = publicDownload(job);
    if (job.state === 'installed') return { ok: true, ...body };
    return {
      ok: false,
      ...body,
      error: job.error ?? {
        code: job.state === 'paused' ? 'download_paused' : job.state === 'cancelled' ? 'cancelled' : 'download_failed',
        message: job.state === 'paused' ? '下载已暂停' : job.state === 'cancelled' ? '下载已取消' : '下载失败',
        retryable: job.state === 'paused',
      },
    };
  }

  async runDownload(job) {
    const stateRead = await readInferenceState(this.home, { init: false });
    const state = { ...stateRead.state, downloads: { ...stateRead.state.downloads } };
    let lastState = null;
    const store = this.storeFor();
    try {
      const result = await store.download(job.manifest, {
        ...(job.mirrors ? { mirrors: job.mirrors } : {}),
        force: job.force,
        signal: job.controller.signal,
        onStatus: (status) => {
          job.state = status.state === 'verifying'
            ? 'verifying'
            : status.state === 'installing'
              ? 'installing'
              : 'downloading';
          job.downloadedBytes = status.downloadedBytes ?? 0;
          job.totalBytes = status.totalBytes ?? 0;
          job.updatedAt = this.now();
          if (lastState !== job.state) {
            lastState = job.state;
            state.downloads[job.packId] = {
              state: job.state,
              downloadedBytes: job.downloadedBytes,
              totalBytes: job.totalBytes,
              updatedAt: job.updatedAt,
            };
            this.persist(state);
          }
        },
      });
      job.state = 'installed';
      job.downloadedBytes = result.installedBytes;
      job.totalBytes = result.installedBytes;
      job.installedPath = result.path;
      job.updatedAt = this.now();
      state.downloads[job.packId] = {
        state: 'installed',
        downloadedBytes: job.downloadedBytes,
        totalBytes: job.totalBytes,
        updatedAt: job.updatedAt,
      };
      state.installs[job.packId] = {
        installedAt: this.now(),
        verifiedAt: this.now(),
        installedBytes: result.installedBytes,
      };
      await this.persist(state);
      return result;
    } catch (error) {
      const mapped = translateError(error);
      if (job.pauseRequested) {
        job.state = 'paused';
        job.reason = 'paused';
        job.updatedAt = this.now();
        state.downloads[job.packId] = {
          state: 'paused',
          downloadedBytes: job.downloadedBytes,
          totalBytes: job.totalBytes,
          updatedAt: job.updatedAt,
          reason: 'paused',
        };
      } else if (job.controller.signal.aborted || mapped.code === 'cancelled') {
        job.state = 'cancelled';
        job.reason = 'cancelled';
        job.updatedAt = this.now();
        delete state.downloads[job.packId];
      } else {
        job.state = 'failed';
        job.error = {
          code: mapped.code,
          message: mapped.message,
          retryable: mapped.retryable === true,
        };
        job.updatedAt = this.now();
        state.downloads[job.packId] = {
          state: 'failed',
          downloadedBytes: job.downloadedBytes,
          totalBytes: job.totalBytes,
          updatedAt: job.updatedAt,
          error: { code: mapped.code, message: mapped.message },
        };
      }
      await this.persist(state);
      return null;
    } finally {
      job.controller = null;
      job.manifest = undefined;
      if (job.state !== 'downloading' && job.state !== 'verifying' && job.state !== 'installing') {
        // 保留 terminal job 供 status 读取；下一次 download 会覆盖。
        this.jobs.set(job.packId, job);
      }
    }
  }

  async pause(input = {}) {
    const packId = assertPackId(packIdOf(input));
    const job = this.jobs.get(packId);
    if (!job || !['downloading', 'verifying', 'installing'].includes(job.state)) {
      const stateRead = await this.state();
      const record = stateRead.state.downloads[packId];
      if (record?.state === 'paused') {
        return { ok: true, paused: true, job: publicDownload({ ...record, packId }) };
      }
      throw new InferenceError('no_active_download', `没有正在下载的模型包：${packId}`, { status: 409 });
    }
    job.pauseRequested = true;
    job.controller?.abort();
    await job.promise;
    return { ok: true, paused: job.state === 'paused', job: publicDownload(job) };
  }

  async resume(input = {}, { config = {} } = {}) {
    const packId = assertPackId(packIdOf(input));
    const job = this.jobs.get(packId);
    if (job && ['downloading', 'verifying', 'installing'].includes(job.state)) {
      throw new InferenceError('download_in_progress', `模型包正在下载：${packId}`, { status: 409 });
    }
    const stateRead = await this.state();
    const record = stateRead.state.downloads[packId];
    if (record?.state !== 'paused' && job?.state !== 'paused') {
      throw new InferenceError('nothing_to_resume', `没有可恢复的下载：${packId}`, { status: 409 });
    }
    const mirrors = input.mirrors ?? input.mirror ?? job?.mirrors;
    this.jobs.delete(packId);
    return this.download({
      ...input,
      ...(mirrors !== undefined ? { mirrors } : {}),
      pack: packId,
      wait: boolOf(input.wait),
    }, { config });
  }

  async cancel(input = {}) {
    const packId = assertPackId(packIdOf(input));
    const job = this.jobs.get(packId);
    if (job && ['downloading', 'verifying', 'installing'].includes(job.state)) {
      job.controller?.abort();
      await job.promise;
    }
    const store = this.storeFor();
    if (typeof store.clearPartial === 'function') await store.clearPartial(packId);
    const stateRead = await this.state();
    if (stateRead.state.downloads[packId]) {
      const next = { ...stateRead.state, downloads: { ...stateRead.state.downloads } };
      delete next.downloads[packId];
      await writeInferenceState(this.home, next);
    }
    if (job) {
      job.state = 'cancelled';
      job.reason = 'cancelled';
      job.updatedAt = this.now();
    }
    return { ok: true, cancelled: true, pack: packId, job: job ? publicDownload(job) : null };
  }

  async importPack(input = {}) {
    const sourceDir = input.sourceDir ?? input.path ?? input.dir;
    if (typeof sourceDir !== 'string' || sourceDir.length === 0) {
      throw new InferenceError('invalid_request', '缺少离线导入目录 path/sourceDir');
    }
    const source = resolve(sourceDir);
    const info = await stat(source).catch(() => null);
    if (!info?.isDirectory()) {
      throw new InferenceError('import_failed', `离线导入目录不存在：${source}`, { status: 400 });
    }
    const catalog = await this.catalog();
    const lib = inferenceCore();
    let manifest = input.manifest ?? null;
    if (!manifest) {
      try {
        manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf-8'));
      } catch {
        throw new InferenceError('manifest_missing', '离线导入目录缺少 manifest.json', { status: 409 });
      }
    }
    const validation = lib.validateModelManifest(manifest);
    if (!validation.ok) {
      throw new InferenceError('invalid_manifest', '离线包 manifest 校验失败', {
        details: { errors: validation.errors.slice(0, 20) },
      });
    }
    manifest = validation.manifest;
    const explicitPackId = packIdOf(input) ? assertPackId(packIdOf(input)) : null;
    if (explicitPackId && explicitPackId !== manifest.packId) {
      throw new InferenceError('manifest_mismatch', `packId ${explicitPackId} 与 manifest ${manifest.packId} 不一致`);
    }
    const packId = explicitPackId ?? manifest.packId;
    const catalogPack = catalog.packs.find((pack) => pack.packId === packId);
    if (!catalogPack) {
      throw new InferenceError('unknown_pack', `manifest 不在精选 Qwen 目录：${packId}`, { status: 404 });
    }
    if (manifest.modelId !== catalogPack.modelId) {
      throw new InferenceError(
        'manifest_mismatch',
        `manifest modelId ${manifest.modelId} 与精选包 ${catalogPack.modelId} 不一致`,
      );
    }
    const previousJob = this.jobs.get(packId);
    if (previousJob && ['downloading', 'verifying', 'installing'].includes(previousJob.state)) {
      throw new InferenceError('download_in_progress', `模型包正在下载：${packId}`, { status: 409 });
    }
    if (this.engine && this.engine.getStatus().packId === packId) {
      await this.engine.stop().catch(() => undefined);
    }
    const store = this.storeFor();
    const result = await store.importDirectory({
      sourceDir: source,
      packId,
      manifest,
      force: boolOf(input.force),
    });
    const stateRead = await this.state();
    const next = { ...stateRead.state, installs: { ...stateRead.state.installs } };
    next.installs[result.packId] = {
      installedAt: this.now(),
      verifiedAt: this.now(),
      installedBytes: result.installedBytes,
    };
    delete next.downloads[result.packId];
    await writeInferenceState(this.home, next);
    return {
      ok: true,
      imported: true,
      pack: result.packId,
      modelId: result.modelId,
      path: result.path,
      installedBytes: result.installedBytes,
      warnings: [],
    };
  }

  async remove(input = {}, { config = {} } = {}) {
    const packId = assertPackId(packIdOf(input));
    const stateRead = await this.state();
    const effectiveConfig = config && Object.keys(config).length > 0
      ? config
      : await readDeviceConfig(this.home);
    const settings = resolveModelSettings({ config: effectiveConfig, state: stateRead.state, home: this.home });
    if (!boolOf(input.force) && (settings.pack === packId || stateRead.state.selectedPack === packId)) {
      throw new InferenceError('selection_in_use', `模型包正在被选择：${packId}；先选择其他包或使用 force`, {
        status: 409,
        details: { pack: packId },
      });
    }
    const job = this.jobs.get(packId);
    if (job && ['downloading', 'verifying', 'installing'].includes(job.state)) {
      job.controller?.abort();
      await job.promise;
    }
    await this.engineFor().stop(packId).catch(() => undefined);
    const store = this.storeFor();
    const result = await store.uninstall(packId);
    const next = {
      ...stateRead.state,
      downloads: { ...stateRead.state.downloads },
      installs: { ...stateRead.state.installs },
    };
    delete next.downloads[packId];
    delete next.installs[packId];
    if (next.selectedPack === packId) next.selectedPack = null;
    await writeInferenceState(this.home, next);
    if (settings.configPack === packId) {
      await writeRuntimeModelConfig(this.home, { pack: null, path: null });
    }
    this.jobs.delete(packId);
    const externalPath = settings.pack === packId
      && settings.path
      && settings.path !== join(this.paths().modelsDir, packId);
    return {
      ok: true,
      removed: result.removed,
      pack: packId,
      path: result.path,
      selectionCleared: settings.pack === packId,
      // 自定义 runtime.model.local.path 属于用户目录；uninstall 不删除它。
      ...(externalPath ? { externalPathPreserved: true } : {}),
    };
  }

  async resolvePackId(input = {}, config = {}) {
    const explicit = packIdOf(input);
    if (explicit !== null && explicit !== undefined) return assertPackId(explicit);
    const stateRead = await this.state();
    const settings = resolveModelSettings({ config, state: stateRead.state, home: this.home });
    if (!settings.pack) {
      throw new InferenceError('no_model_selected', '尚未选择本地模型包', {
        status: 409,
        details: { hint: 'POST /admin/api/models/select 或 --pack <id>' },
      });
    }
    return assertPackId(settings.pack);
  }

  engineOptions(config = {}) {
    const local = configModel(config);
    return {
      threads: typeof local.threads === 'number' ? local.threads : DEFAULT_THREADS,
      binaryPath: typeof local.enginePath === 'string' && local.enginePath.length > 0
        ? local.enginePath
        : undefined,
      modelDir: typeof local.path === 'string' && local.path.length > 0 ? local.path : undefined,
      idleTimeoutMs: typeof local.idleTimeoutMs === 'number' ? local.idleTimeoutMs : DEFAULT_IDLE_TIMEOUT_MS,
      startupTimeoutMs: typeof local.startupTimeoutMs === 'number' ? local.startupTimeoutMs : DEFAULT_STARTUP_TIMEOUT_MS,
    };
  }

  async start(input = {}, { config = {} } = {}) {
    const packId = await this.resolvePackId(input, config);
    const options = this.engineOptions(config);
    const status = await this.engineFor().start({
      packId,
      threads: typeof input.threads === 'number' ? input.threads : options.threads,
      ...(options.binaryPath ? { binaryPath: options.binaryPath } : {}),
      ...(options.modelDir ? { modelDir: options.modelDir } : {}),
      idleTimeoutMs: options.idleTimeoutMs,
      startupTimeoutMs: options.startupTimeoutMs,
    });
    return { ok: true, ...status };
  }

  async stop(input = {}) {
    const packId = packIdOf(input) ? assertPackId(packIdOf(input)) : null;
    const result = await this.engineFor().stop(packId);
    return { ok: true, ...result, pack: result.packId ?? packId };
  }

  async test(input = {}, { config = {} } = {}) {
    const packId = await this.resolvePackId(input, config);
    const options = this.engineOptions(config);
    const result = await this.engineFor().test({
      packId,
      threads: typeof input.threads === 'number' ? input.threads : options.threads,
      ...(options.binaryPath ? { binaryPath: options.binaryPath } : {}),
      ...(options.modelDir ? { modelDir: options.modelDir } : {}),
      ...(typeof input.timeoutMs === 'number' ? { timeoutMs: input.timeoutMs } : {}),
      ...(typeof input.prompt === 'string' ? { prompt: input.prompt } : {}),
    });
    return { ok: true, ...result };
  }

  async dispose() {
    for (const job of this.jobs.values()) {
      job.pauseRequested = false;
      job.controller?.abort();
    }
    await Promise.allSettled([...this.jobs.values()].map((job) => job.promise).filter(Boolean));
    await this.persistChain.catch(() => undefined);
    await this.engineFor().dispose().catch(() => undefined);
  }
}

export function createInferenceManager(options) {
  return new InferenceManager(options);
}

export function getInferenceManager(home) {
  const key = resolve(home);
  let manager = managers.get(key);
  if (!manager) {
    manager = createInferenceManager({ home: key });
    managers.set(key, manager);
  }
  return manager;
}

export async function disposeInferenceManager(home) {
  const key = resolve(home);
  const manager = managers.get(key);
  if (!manager) return false;
  managers.delete(key);
  await manager.dispose();
  return true;
}

const ACTIONS = new Set([
  'select',
  'download',
  'pause',
  'resume',
  'cancel',
  'import',
  'uninstall',
  'remove',
  'start',
  'stop',
  'test',
]);

export async function buildModelsList({ home, config = {} } = {}) {
  return getInferenceManager(home).list({ config });
}

export async function buildModelsStatus({ home, config = {} } = {}) {
  return getInferenceManager(home).status({ config });
}

/** Admin write 分发；返回 {status, body}。CSRF/Origin/scope 已由 serve 校验。 */
export async function handleModelsWrite({ home, config = {}, action, input = {} } = {}) {
  const name = action === 'uninstall' ? 'remove' : action;
  if (!ACTIONS.has(name)) {
    return {
      status: 404,
      body: {
        ok: false,
        error: { code: 'unknown_action', message: `未知模型操作：${action}`, retryable: false },
        code: 'unknown_action',
        message: `未知模型操作：${action}`,
      },
    };
  }
  const manager = getInferenceManager(home);
  try {
    if (name === 'select') return { status: 200, body: await manager.select(input, { config }) };
    if (name === 'download') {
      const body = await manager.download(input, { config });
      return { status: body.ok && body.accepted ? 202 : body.ok ? 200 : 409, body };
    }
    if (name === 'pause') return { status: 200, body: await manager.pause(input) };
    if (name === 'resume') {
      const body = await manager.resume(input, { config });
      return { status: body.ok && body.accepted ? 202 : body.ok ? 200 : 409, body };
    }
    if (name === 'cancel') return { status: 200, body: await manager.cancel(input) };
    if (name === 'import') return { status: 200, body: await manager.importPack(input, { config }) };
    if (name === 'remove') return { status: 200, body: await manager.remove(input, { config }) };
    if (name === 'start') return { status: 200, body: await manager.start(input, { config }) };
    if (name === 'stop') return { status: 200, body: await manager.stop(input) };
    if (name === 'test') return { status: 200, body: await manager.test(input, { config }) };
    return { status: 500, body: { ok: false, error: { code: 'internal', message: 'unreachable' } } };
  } catch (error) {
    const mapped = translateError(error);
    return { status: mapped.status, body: mapped.toBody() };
  }
}
