// 设备级本地模型 store（0.3.0）：<home>/inference.json + <home>/models。
//
// 边界：
// - 这里只读/写本机设备状态；**不**写 graph / event log / 同步事件，模型选择
//   永远不会进入忆云；
// - 模型文件只放在 <home>/models，状态文件不保存模型字节、API key 或引擎 token；
// - 精选 catalog 只有 Qwen 9B/27B/4B 的仓库坐标；完整 manifest（含 sha256）必须由
//   设备侧预置、显式安装参数或离线导入目录提供，绝不在源码里猜 URL/哈希；
// - 所有写盘都是原子写 + 0600；旧 config.json 只做局部更新，不重写其他字段。

import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile, chmod } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

let core = {};
try {
  // 0.3.0 W1：本地模型原语随 memory-runtime 包迁出 @mebular/core。
  core = await import('@mebular/memory-runtime');
} catch {
  // 源码工作树/旧安装：回退到包内 dist。
}
if (typeof core.ModelStore !== 'function') {
  try {
    core = await import(new URL('../../memory-runtime/dist/index.js', import.meta.url).href);
  } catch {
    // 保留空对象；调用方会得到结构化 inference_unavailable。
  }
}

export const INFERENCE_SCHEMA = 1;
export const INFERENCE_FILE = 'inference.json';
export const MODELS_DIR = 'models';
export const MANIFESTS_DIR = 'manifests';
export const DEFAULT_THREADS = 4;

const PACK_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

export class InferenceError extends Error {
  constructor(code, message, { status = 400, retryable = false, details } = {}) {
    super(message);
    this.name = 'InferenceError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    if (details !== undefined) this.details = details;
  }

  toBody() {
    return {
      ok: false,
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable === true,
        ...(this.details !== undefined ? { details: this.details } : {}),
      },
      code: this.code,
      message: this.message,
    };
  }
}

export function inferenceCore() {
  if (typeof core.ModelStore !== 'function') {
    throw new InferenceError('inference_unavailable', '本地模型原语不可用：请先构建 @mebular/memory-runtime', {
      status: 503,
      details: { hint: 'npm run build' },
    });
  }
  return core;
}

export function assertPackId(value) {
  if (typeof value !== 'string' || !PACK_ID_RE.test(value)) {
    throw new InferenceError('invalid_pack', '模型包 id 不合法', {
      details: { pack: typeof value === 'string' ? value.slice(0, 128) : null },
    });
  }
  return value;
}

/** @param {string} home */
export function inferencePaths(home) {
  if (typeof home !== 'string' || home.length === 0) {
    throw new InferenceError('invalid_home', 'home 不能为空');
  }
  const base = resolve(home);
  const modelsDir = join(base, MODELS_DIR);
  return {
    home: base,
    statePath: join(base, INFERENCE_FILE),
    modelsDir,
    manifestDir: join(modelsDir, MANIFESTS_DIR),
    partialDir: join(modelsDir, '.partial'),
    configPath: join(base, 'config.json'),
  };
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringOrNull(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function intOr(value, fallback, min = 0) {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= min
    ? value
    : fallback;
}

async function writeJsonAtomic(path, data, { mode = 0o600, backup = false } = {}) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(5).toString('hex')}`;
  try {
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf-8', mode });
    if (backup && existsSync(path)) await copyFile(path, `${path}.bak`).catch(() => undefined);
    await rename(tmp, path);
    await chmod(path, mode).catch(() => undefined);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function defaultInferenceState() {
  return {
    schema: INFERENCE_SCHEMA,
    selectedPack: null,
    downloads: {},
    installs: {},
    updatedAt: 0,
  };
}

function normalizeDownload(raw) {
  if (!isObject(raw)) return null;
  const state = typeof raw.state === 'string' ? raw.state : 'failed';
  return {
    state: ['downloading', 'verifying', 'installing', 'installed', 'paused', 'failed', 'cancelled'].includes(state)
      ? state
      : 'failed',
    downloadedBytes: intOr(raw.downloadedBytes, 0),
    totalBytes: intOr(raw.totalBytes, 0),
    updatedAt: intOr(raw.updatedAt, 0),
    ...(typeof raw.error?.code === 'string'
      ? { error: { code: raw.error.code, message: typeof raw.error.message === 'string' ? raw.error.message : '' } }
      : {}),
    ...(typeof raw.reason === 'string' ? { reason: raw.reason } : {}),
  };
}

function normalizeInstall(raw) {
  if (!isObject(raw)) return null;
  return {
    installedAt: intOr(raw.installedAt, 0),
    verifiedAt: intOr(raw.verifiedAt, 0),
    installedBytes: intOr(raw.installedBytes, 0),
  };
}

export function normalizeInferenceState(raw) {
  const input = isObject(raw) ? raw : {};
  const downloads = {};
  if (isObject(input.downloads)) {
    for (const [packId, value] of Object.entries(input.downloads)) {
      if (!PACK_ID_RE.test(packId)) continue;
      const record = normalizeDownload(value);
      if (record) downloads[packId] = record;
    }
  }
  const installs = {};
  if (isObject(input.installs)) {
    for (const [packId, value] of Object.entries(input.installs)) {
      if (!PACK_ID_RE.test(packId)) continue;
      const record = normalizeInstall(value);
      if (record) installs[packId] = record;
    }
  }
  return {
    schema: INFERENCE_SCHEMA,
    selectedPack: typeof input.selectedPack === 'string' && PACK_ID_RE.test(input.selectedPack)
      ? input.selectedPack
      : null,
    downloads,
    installs,
    updatedAt: intOr(input.updatedAt, 0),
  };
}

/** 初始化设备级 store：<home>/models (0700) 与 <home>/inference.json (0600)。 */
export async function ensureInferenceStore(home) {
  const paths = inferencePaths(home);
  await mkdir(paths.modelsDir, { recursive: true, mode: 0o700 });
  await chmod(paths.modelsDir, 0o700).catch(() => undefined);
  if (!existsSync(paths.statePath)) {
    try {
      await writeJsonAtomic(paths.statePath, defaultInferenceState(), { mode: 0o600 });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  return paths;
}

/**
 * 读取设备状态。损坏的 inference.json 不会被覆盖；返回默认状态 + stateError，
 * 让调用方决定是否修复。进程中断遗留的 downloading 状态归一为 paused。
 */
export async function readInferenceState(home, { init = true } = {}) {
  const paths = init ? await ensureInferenceStore(home) : inferencePaths(home);
  const warnings = [];
  let raw;
  try {
    raw = await readFile(paths.statePath, 'utf-8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { state: defaultInferenceState(), paths, warnings, stateError: null, missing: true };
    }
    return {
      state: defaultInferenceState(),
      paths,
      warnings: ['inference_state_unreadable'],
      stateError: { code: 'inference_state_unreadable', message: '无法读取 inference.json' },
      missing: false,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      state: defaultInferenceState(),
      paths,
      warnings: ['inference_state_invalid'],
      stateError: { code: 'inference_state_invalid', message: 'inference.json 不是合法 JSON' },
      missing: false,
    };
  }
  if (!isObject(parsed)) {
    return {
      state: defaultInferenceState(),
      paths,
      warnings: ['inference_state_invalid'],
      stateError: { code: 'inference_state_invalid', message: 'inference.json 顶层必须是对象' },
      missing: false,
    };
  }

  const state = normalizeInferenceState(parsed);
  for (const [packId, record] of Object.entries(state.downloads)) {
    if (record.state === 'downloading' || record.state === 'verifying' || record.state === 'installing') {
      state.downloads[packId] = {
        ...record,
        state: 'paused',
        reason: record.reason ?? 'process_interrupted',
      };
      warnings.push(`download_interrupted:${packId}`);
    }
  }
  return { state, paths, warnings, stateError: null, missing: false };
}

/** 原子写设备状态；保留 schema 并只写白名单字段。 */
export async function writeInferenceState(home, state) {
  const paths = inferencePaths(home);
  const normalized = normalizeInferenceState({
    ...state,
    updatedAt: Date.now(),
  });
  await writeJsonAtomic(paths.statePath, normalized, { mode: 0o600 });
  return normalized;
}

/** 读 config.json（不存在返回 {}）；不修改、不打印内容。 */
export async function readDeviceConfig(home) {
  try {
    const parsed = JSON.parse(await readFile(inferencePaths(home).configPath, 'utf-8'));
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 原子更新 config.json 的 runtime.model.local.*，保留其他字段与 .bak。
 * 只接受 pack/path/source；任何 API key 字段都不会被写入。
 */
export async function writeRuntimeModelConfig(home, { pack = null, path = null, source = null } = {}) {
  const paths = inferencePaths(home);
  let current = await readDeviceConfig(home);
  let merged;
  try {
    merged = JSON.parse(JSON.stringify(current));
  } catch {
    merged = {};
  }
  const runtime = isObject(merged.runtime) ? merged.runtime : {};
  const model = isObject(runtime.model) ? runtime.model : {};
  const local = isObject(model.local) ? model.local : {};

  if (pack === null) delete local.pack;
  else local.pack = assertPackId(pack);
  if (path === null) delete local.path;
  else if (typeof path === 'string' && path.length > 0) local.path = path;
  else delete local.path;

  if (source !== null) {
    if (!['heuristic', 'local', 'host', 'api', 'auto'].includes(source)) {
      throw new InferenceError('invalid_source', 'runtime.model.source 不合法');
    }
    model.source = source;
  }
  model.local = local;
  runtime.model = model;
  merged.runtime = runtime;

  await writeJsonAtomic(paths.configPath, merged, { mode: 0o600, backup: true });
  return merged;
}

/** 兼容旧 manifest 目录与显式注入，构造精选目录（仍然只有 9B/27B/4B）。 */
export async function loadModelCatalog(home, { manifests = null, manifestDir = null } = {}) {
  const lib = inferenceCore();
  const paths = inferencePaths(home);
  const dir = manifestDir ?? paths.manifestDir;
  const warnings = [];
  const injected = {};

  let files = [];
  try {
    files = (await readdir(dir)).filter((name) => name.toLowerCase().endsWith('.json')).sort();
  } catch (error) {
    if (error?.code !== 'ENOENT') warnings.push('manifest_dir_unreadable');
  }
  for (const name of files) {
    try {
      const raw = JSON.parse(await readFile(join(dir, name), 'utf-8'));
      const validation = lib.validateModelManifest(raw);
      if (!validation.ok) {
        warnings.push(`manifest_invalid:${name}`);
        continue;
      }
      const manifest = validation.manifest;
      const curated = Array.isArray(lib.CURATED_MODEL_PACKS)
        ? lib.CURATED_MODEL_PACKS.find((pack) => pack.packId === manifest.packId)
        : null;
      if (!curated) {
        warnings.push(`manifest_unknown_pack:${manifest.packId}`);
        continue;
      }
      if (curated.modelId !== manifest.modelId) {
        warnings.push(`manifest_mismatch:${manifest.packId}`);
        continue;
      }
      if (injected[manifest.packId]) {
        warnings.push(`manifest_duplicate:${manifest.packId}`);
        continue;
      }
      injected[manifest.packId] = manifest;
    } catch {
      warnings.push(`manifest_invalid:${name}`);
    }
  }

  if (manifests) {
    const list = Array.isArray(manifests) ? manifests : Object.values(manifests);
    for (const entry of list) {
      const validation = lib.validateModelManifest(entry);
      if (!validation.ok) {
        warnings.push('manifest_invalid:injected');
        continue;
      }
      const manifest = validation.manifest;
      const curated = Array.isArray(lib.CURATED_MODEL_PACKS)
        ? lib.CURATED_MODEL_PACKS.find((pack) => pack.packId === manifest.packId)
        : null;
      if (!curated) {
        warnings.push(`manifest_unknown_pack:${manifest.packId}`);
        continue;
      }
      if (curated.modelId !== manifest.modelId) {
        warnings.push(`manifest_mismatch:${manifest.packId}`);
        continue;
      }
      injected[manifest.packId] = manifest;
    }
  }

  let packs;
  try {
    packs = lib.createModelCatalog({ manifests: injected });
  } catch (error) {
    throw new InferenceError('catalog_invalid', String(error?.message ?? error), {
      status: 500,
      details: { code: error?.code ?? null },
    });
  }
  return { packs, manifests: injected, manifestDir: dir, warnings };
}

/** 显式 manifest 优先；否则只接受设备预置 manifest；不存在就报 manifest_missing。 */
export async function resolveManifestForPack({
  home,
  packId,
  manifest = null,
  manifestPath = null,
  catalog = null,
} = {}) {
  const lib = inferenceCore();
  const id = assertPackId(packId);
  let resolvedCatalog = catalog;
  if (!resolvedCatalog) resolvedCatalog = await loadModelCatalog(home);

  let candidate = null;
  if (manifest !== null && manifest !== undefined) {
    const validation = lib.validateModelManifest(manifest);
    if (!validation.ok) {
      throw new InferenceError('invalid_manifest', 'manifest 校验失败', {
        details: { errors: validation.errors.slice(0, 20) },
      });
    }
    candidate = validation.manifest;
  } else if (manifestPath !== null && manifestPath !== undefined) {
    let raw;
    try {
      raw = JSON.parse(await readFile(resolve(String(manifestPath)), 'utf-8'));
    } catch (error) {
      throw new InferenceError('invalid_manifest', `无法读取 manifest：${String(error?.message ?? error)}`);
    }
    const validation = lib.validateModelManifest(raw);
    if (!validation.ok) {
      throw new InferenceError('invalid_manifest', 'manifest 校验失败', {
        details: { errors: validation.errors.slice(0, 20) },
      });
    }
    candidate = validation.manifest;
  } else {
    const pack = resolvedCatalog.packs.find((entry) => entry.packId === id);
    if (!pack) throw new InferenceError('unknown_pack', `未知模型包：${id}`, { status: 404 });
    candidate = pack.manifest ?? null;
  }

  if (!candidate) {
    throw new InferenceError(
      'manifest_missing',
      `模型包 ${id} 缺少完整 manifest（sha256/文件列表）；不会猜测下载地址或哈希`,
      { status: 409, details: { pack: id, manifestDir: resolvedCatalog.manifestDir } },
    );
  }
  if (candidate.packId !== id) {
    throw new InferenceError('manifest_mismatch', `manifest packId ${candidate.packId} 与 ${id} 不一致`);
  }
  const catalogPack = resolvedCatalog.packs.find((entry) => entry.packId === id);
  if (!catalogPack) {
    throw new InferenceError('unknown_pack', `manifest 不在精选 Qwen 目录：${id}`, { status: 404 });
  }
  if (candidate.modelId !== catalogPack.modelId) {
    throw new InferenceError(
      'manifest_mismatch',
      `manifest modelId ${candidate.modelId} 与精选包 ${catalogPack.modelId} 不一致`,
    );
  }
  return { manifest: candidate, catalog: resolvedCatalog };
}

/** 读取已安装包并做轻量文件检查（不重算 sha256）。 */
export async function readInstalledPack(home, packId, { dir: requestedDir = null } = {}) {
  const lib = inferenceCore();
  const id = assertPackId(packId);
  const paths = inferencePaths(home);
  const dir = requestedDir && typeof requestedDir === 'string'
    ? requestedDir
    : join(paths.modelsDir, id);
  let manifest;
  try {
    const raw = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf-8'));
    const validation = lib.validateModelManifest(raw);
    if (!validation.ok) {
      return {
        installed: true,
        state: 'corrupt',
        dir,
        manifest: null,
        expectedBytes: 0,
        installedBytes: 0,
        errors: ['manifest_invalid'],
      };
    }
    manifest = validation.manifest;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { installed: false, state: 'not_installed', dir, manifest: null, expectedBytes: 0, installedBytes: 0, errors: [] };
    }
    return {
      installed: true,
      state: 'corrupt',
      dir,
      manifest: null,
      expectedBytes: 0,
      installedBytes: 0,
      errors: ['manifest_unreadable'],
    };
  }

  let expectedBytes = 0;
  let installedBytes = 0;
  const errors = [];
  for (const file of manifest.files) {
    expectedBytes += file.sizeBytes;
    const target = join(dir, ...file.path.split('/'));
    try {
      const info = await stat(target);
      if (!info.isFile()) {
        errors.push(`missing:${file.path}`);
      } else if (info.size !== file.sizeBytes) {
        errors.push(`size_mismatch:${file.path}`);
        installedBytes += info.size;
      } else {
        installedBytes += info.size;
      }
    } catch {
      errors.push(`missing:${file.path}`);
    }
  }
  return {
    installed: true,
    state: errors.length > 0 ? 'corrupt' : 'installed',
    dir,
    manifest,
    expectedBytes,
    installedBytes,
    errors,
  };
}

export function findModelFilePath(manifest, dir) {
  if (!manifest || !Array.isArray(manifest.files) || manifest.files.length === 0) return null;
  const file = manifest.files.find((entry) => entry.path.toLowerCase().endsWith('.gguf'))
    ?? manifest.files[0];
  if (!file) return null;
  return join(dir, ...file.path.split('/'));
}

/**
 * runtime.model.local.pack/path 与 inference.json 的关系：
 * - config 中显式 pack 优先；否则使用设备选择 selectedPack；
 * - config 中显式 path 优先；否则 <home>/models/<pack>；
 * - threads 只来自 config；选择本身不同步进忆云。
 */
export function resolveModelSettings({ config = {}, state = null, home }) {
  const paths = inferencePaths(home);
  const model = isObject(config?.runtime?.model) ? config.runtime.model : {};
  const local = isObject(model.local) ? model.local : {};
  const configPack = stringOrNull(local.pack);
  const selectedPack = stringOrNull(state?.selectedPack);
  const pack = configPack ?? selectedPack;
  const configuredPath = stringOrNull(local.path);
  const path = configuredPath
    ? (isAbsolute(configuredPath) ? configuredPath : resolve(paths.home, configuredPath))
    : (pack ? join(paths.modelsDir, pack) : null);
  return {
    source: typeof model.source === 'string'
      ? model.source
      : 'heuristic',
    pack,
    path,
    threads: intOr(local.threads, DEFAULT_THREADS, 1),
    selectionSource: configPack ? 'config' : selectedPack ? 'inference' : null,
    configPack,
    selectedPack,
    modelsDir: paths.modelsDir,
  };
}

export function assertInstalledPathSafe(path) {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0')) {
    throw new InferenceError('unsafe_path', '模型路径不合法');
  }
  return isAbsolute(path) ? path : resolve(path);
}

export function isCuratedPack(catalog, packId) {
  return Array.isArray(catalog?.packs) && catalog.packs.some((pack) => pack.packId === packId);
}
