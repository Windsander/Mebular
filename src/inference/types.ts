// 本地模型后端原语：类型与 manifest 校验（0.3.0）
//
// 这一层只描述“模型包是什么、机器能不能跑、下载/安装/引擎/gateway 的状态”，
// 不包含任何模型推理。所有网络与文件 IO 都由调用方注入，默认实现尽量小。
//
// 安全约束：
// - manifest 是不可信输入：文件路径必须是包内相对 POSIX 路径，拒绝 `..`/绝对路径；
// - 精选目录不保存任意远程 URL；只保存仓库坐标，URL 由调用方/镜像解析器注入；
// - 状态对象中不包含 API key、引擎 token 或完整 prompt。

export const MODEL_MANIFEST_SCHEMA = 1 as const;

export const MODEL_FORMATS = ['gguf', 'safetensors', 'mlx', 'onnx'] as const;
export type ModelFormat = (typeof MODEL_FORMATS)[number];

export const MODEL_TIERS = ['light', 'default', 'quality', 'custom'] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

export const MODEL_SOURCE_KINDS = ['catalog', 'repo', 'local', 'import', 'custom'] as const;
export type ModelSourceKind = (typeof MODEL_SOURCE_KINDS)[number];

export const MODEL_SOURCE_PROVIDERS = ['huggingface', 'modelscope', 'local', 'custom'] as const;
export type ModelSourceProvider = (typeof MODEL_SOURCE_PROVIDERS)[number];

export const MODEL_STATUS_STATES = [
  'not_installed',
  'downloading',
  'verifying',
  'installed',
  'corrupt',
  'failed',
  'unsupported',
] as const;
export type ModelStatusState = (typeof MODEL_STATUS_STATES)[number];

export const ENGINE_STATES = [
  'stopped',
  'starting',
  'running',
  'stopping',
  'crashed',
  'circuit_open',
] as const;
export type EngineState = (typeof ENGINE_STATES)[number];

export type HardwarePlatform = 'darwin' | 'win32' | 'linux' | 'unknown';
export type GpuVendor = 'apple' | 'nvidia' | 'amd' | 'intel' | 'unknown' | 'none';

export interface ModelRepositorySource {
  provider: ModelSourceProvider;
  /** `owner/name`；不是 URL。 */
  repo: string;
  revision?: string;
  /** 可选的文件筛选模式（由下载器解释，catalog 不写死远程地址）。 */
  filePattern?: string;
}

export interface ModelSource {
  kind: ModelSourceKind;
  /** 仓库坐标；catalog 条目只带坐标，不带远程 URL。 */
  repository?: ModelRepositorySource;
  /** 人类可读的模型主页/许可页；下载器不会自动请求它。 */
  homepage?: string;
  licenseUrl?: string;
}

export interface ModelFile {
  /** 包内相对 POSIX 路径，例如 `model-q4_k_m.gguf`。 */
  path: string;
  sizeBytes: number;
  /** 小写 sha256 hex（64 字符）。 */
  sha256: string;
  /** 可选的显式下载地址；精选 catalog 不包含。 */
  url?: string;
  /** 可选的候选镜像；按顺序尝试。 */
  mirrors?: string[];
}

export interface ModelLicense {
  id: string;
  name?: string;
  url?: string;
  requiresAcceptance?: boolean;
}

export interface ModelRequirements {
  /** 支持的操作系统；未来平台名允许字符串扩展。 */
  platforms: string[];
  /** 可选架构限制，如 `arm64` / `x64`；缺省表示不限制。 */
  architectures?: string[];
  /** 能启动模型的最低内存。 */
  minMemoryBytes: number;
  /** 流畅运行的建议内存；推荐算法优先使用此阈值。 */
  recommendedMemoryBytes: number;
  /** 安装所需的最低可用磁盘。 */
  minDiskBytes: number;
  gpu?: 'none' | 'optional' | 'required';
  minVramBytes?: number;
}

export interface ModelContext {
  /** 训练/支持的最大上下文长度。 */
  length: number;
  defaultMaxOutputTokens?: number;
}

export interface ModelRuntime {
  engine: 'llama-server';
  minVersion?: string;
  /** 默认推理线程数；缺省由引擎决定。 */
  threads?: number;
  /** 额外的 llama-server 参数；由调用方显式提供。 */
  extraArgs?: string[];
}

export interface ModelManifest {
  schema: typeof MODEL_MANIFEST_SCHEMA;
  modelId: string;
  packId: string;
  displayName: string;
  description?: string;
  format: ModelFormat;
  quantization: string;
  files: ModelFile[];
  license: ModelLicense;
  requirements: ModelRequirements;
  context: ModelContext;
  runtime: ModelRuntime;
  source: ModelSource;
  /** 包版本（可选）；与 modelId 分离，便于同一模型多版本共存。 */
  version?: string;
}

/**
 * 精选目录条目。默认只包含仓库坐标和硬件要求；完整 manifest（含 sha256）
 * 由调用方注入，避免把未经核对的 URL/哈希写死在源码里。
 */
export interface ModelPack {
  packId: string;
  modelId: string;
  tier: ModelTier;
  displayName: string;
  description: string;
  quantization: string;
  contextLength: number;
  /** 估算下载体积，用于目录展示与磁盘预检查。 */
  estimatedDownloadBytes: number;
  requirements: ModelRequirements;
  source: ModelSource;
  default?: boolean;
  /** 注入/解析后的完整 manifest；默认 catalog 为 undefined。 */
  manifest?: ModelManifest;
}

export interface ModelStatus {
  packId: string;
  modelId: string;
  state: ModelStatusState;
  installedPath?: string;
  installedBytes?: number;
  expectedBytes?: number;
  verifiedAt?: number;
  message?: string;
  errorCode?: string;
}

export interface GpuProfile {
  vendor: GpuVendor;
  name?: string;
  /** 显存；Apple Silicon 统一内存不填，使用系统内存判断。 */
  vramBytes?: number;
  unifiedMemory: boolean;
}

export interface DiskProfile {
  path: string;
  availableBytes?: number;
  totalBytes?: number;
}

export interface HardwareProfile {
  platform: HardwarePlatform;
  arch: string;
  osVersion?: string;
  cpuModel?: string;
  cpuCores: number;
  totalMemoryBytes: number;
  freeMemoryBytes?: number;
  disk: DiskProfile;
  gpu: GpuProfile;
  detectedAt: number;
  /** 探测失败/降级信息；不影响已知字段。 */
  warnings: string[];
}

export interface ModelRecommendation {
  kind: 'local' | 'heuristic';
  packId: string | null;
  modelId: string | null;
  tier: ModelTier | null;
  reason: string;
  warnings: string[];
  /** 其他可安装的 pack id（按质量从高到低）。 */
  alternatives: string[];
}

export interface EngineStatus {
  state: EngineState;
  pid?: number;
  port?: number;
  /** loopback OpenAI 兼容根地址；不含 token。 */
  baseUrl?: string;
  modelPath?: string;
  modelId?: string;
  startedAt?: number;
  lastHealthAt?: number;
  lastUsedAt?: number;
  crashCount: number;
  restartCount: number;
  health: 'unknown' | 'ok' | 'unhealthy';
  lastError?: {
    code: string;
    message: string;
  };
}

export type ModelManifestValidation =
  | { ok: true; manifest: ModelManifest }
  | { ok: false; errors: string[] };

export class ModelManifestError extends Error {
  readonly code = 'invalid_manifest';

  constructor(readonly errors: string[]) {
    super(`invalid model manifest: ${errors.join('; ')}`);
    this.name = 'ModelManifestError';
  }
}

const SHA256_RE = /^[a-f0-9]{64}$/i;
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PLATFORM_NAMES = new Set(['darwin', 'win32', 'linux']);
const FORMATS = new Set<string>(MODEL_FORMATS);
const TIERS = new Set<string>(MODEL_TIERS);
const SOURCE_KINDS = new Set<string>(MODEL_SOURCE_KINDS);
const SOURCE_PROVIDERS = new Set<string>(MODEL_SOURCE_PROVIDERS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isHttpUrl(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

/** 包内相对 POSIX 路径：拒绝绝对路径、盘符、反斜杠和任何 `..` 段。 */
export function isSafeModelFilePath(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;
  if (value.length > 512) return false;
  if (value.startsWith('/') || value.startsWith('\\')) return false;
  if (/^[A-Za-z]:/.test(value)) return false;
  if (value.includes('\\') || value.includes('\0')) return false;
  if (value.endsWith('/')) return false;
  const parts = value.split('/');
  return parts.every((part) => part.length > 0 && part !== '.' && part !== '..');
}

export function modelManifestTotalBytes(manifest: Pick<ModelManifest, 'files'>): number {
  return manifest.files.reduce((sum, file) => sum + file.sizeBytes, 0);
}

function validateSource(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push('source must be an object');
    return;
  }
  if (!isNonEmptyString(value.kind) || !SOURCE_KINDS.has(value.kind)) {
    errors.push(`source.kind must be one of ${MODEL_SOURCE_KINDS.join(', ')}`);
  }
  if (value.homepage !== undefined && !isHttpUrl(value.homepage)) {
    errors.push('source.homepage must be an http(s) URL');
  }
  if (value.licenseUrl !== undefined && !isHttpUrl(value.licenseUrl)) {
    errors.push('source.licenseUrl must be an http(s) URL');
  }
  if (value.repository === undefined) return;
  if (!isRecord(value.repository)) {
    errors.push('source.repository must be an object');
    return;
  }
  const repo = value.repository;
  if (!isNonEmptyString(repo.provider) || !SOURCE_PROVIDERS.has(repo.provider)) {
    errors.push(`source.repository.provider must be one of ${MODEL_SOURCE_PROVIDERS.join(', ')}`);
  }
  if (!isNonEmptyString(repo.repo) || !REPO_RE.test(repo.repo)) {
    errors.push('source.repository.repo must look like "owner/name"');
  }
  if (repo.revision !== undefined && !isNonEmptyString(repo.revision)) {
    errors.push('source.repository.revision must be a non-empty string');
  }
  if (repo.filePattern !== undefined && !isNonEmptyString(repo.filePattern)) {
    errors.push('source.repository.filePattern must be a non-empty string');
  }
}

function validateRequirements(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push('requirements must be an object');
    return;
  }
  if (!Array.isArray(value.platforms) || value.platforms.length === 0) {
    errors.push('requirements.platforms must be a non-empty array');
  } else {
    for (const platform of value.platforms) {
      if (!isNonEmptyString(platform)) {
        errors.push('requirements.platforms entries must be non-empty strings');
        break;
      }
      if (PLATFORM_NAMES.has(platform) === false && platform !== 'freebsd') {
        // 未来平台允许，但不能是明显的垃圾值。
        if (!/^[a-z][a-z0-9_-]{1,31}$/i.test(platform)) {
          errors.push(`requirements.platforms contains invalid platform "${platform}"`);
        }
      }
    }
  }
  if (value.architectures !== undefined) {
    if (!Array.isArray(value.architectures) || value.architectures.some((item) => !isNonEmptyString(item))) {
      errors.push('requirements.architectures must be an array of non-empty strings');
    }
  }
  if (!isPositiveInteger(value.minMemoryBytes)) {
    errors.push('requirements.minMemoryBytes must be a positive integer');
  }
  if (!isPositiveInteger(value.recommendedMemoryBytes)) {
    errors.push('requirements.recommendedMemoryBytes must be a positive integer');
  }
  if (
    isPositiveInteger(value.minMemoryBytes)
    && isPositiveInteger(value.recommendedMemoryBytes)
    && value.recommendedMemoryBytes < value.minMemoryBytes
  ) {
    errors.push('requirements.recommendedMemoryBytes must be >= minMemoryBytes');
  }
  if (!isPositiveInteger(value.minDiskBytes)) {
    errors.push('requirements.minDiskBytes must be a positive integer');
  }
  if (value.gpu !== undefined && value.gpu !== 'none' && value.gpu !== 'optional' && value.gpu !== 'required') {
    errors.push('requirements.gpu must be none, optional or required');
  }
  if (value.minVramBytes !== undefined && !isNonNegativeInteger(value.minVramBytes)) {
    errors.push('requirements.minVramBytes must be a non-negative integer');
  }
  if (value.gpu === 'required' && !isPositiveInteger(value.minVramBytes)) {
    errors.push('requirements.minVramBytes is required when gpu is required');
  }
}

function validateFiles(value: unknown, errors: string[]): void {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push('files must be a non-empty array');
    return;
  }
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    const prefix = `files[${index}]`;
    if (!isRecord(entry)) {
      errors.push(`${prefix} must be an object`);
      return;
    }
    if (!isSafeModelFilePath(entry.path)) {
      errors.push(`${prefix}.path must be a safe relative POSIX path`);
    } else {
      const key = entry.path.toLowerCase();
      if (seen.has(key)) errors.push(`${prefix}.path is duplicated`);
      seen.add(key);
    }
    if (!isPositiveInteger(entry.sizeBytes)) {
      errors.push(`${prefix}.sizeBytes must be a positive integer`);
    }
    if (!isNonEmptyString(entry.sha256) || !SHA256_RE.test(entry.sha256)) {
      errors.push(`${prefix}.sha256 must be a 64-character hex digest`);
    }
    if (entry.url !== undefined && !isHttpUrl(entry.url)) {
      errors.push(`${prefix}.url must be an http(s) URL`);
    }
    if (entry.mirrors !== undefined) {
      if (!Array.isArray(entry.mirrors) || entry.mirrors.length === 0) {
        errors.push(`${prefix}.mirrors must be a non-empty array when present`);
      } else if (entry.mirrors.some((url) => !isHttpUrl(url))) {
        errors.push(`${prefix}.mirrors entries must be http(s) URLs`);
      }
    }
  });
}

function validateLicense(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push('license must be an object');
    return;
  }
  if (!isNonEmptyString(value.id)) errors.push('license.id must be a non-empty string');
  if (value.name !== undefined && !isNonEmptyString(value.name)) {
    errors.push('license.name must be a non-empty string');
  }
  if (value.url !== undefined && !isHttpUrl(value.url)) {
    errors.push('license.url must be an http(s) URL');
  }
  if (value.requiresAcceptance !== undefined && typeof value.requiresAcceptance !== 'boolean') {
    errors.push('license.requiresAcceptance must be a boolean');
  }
}

function validateContext(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push('context must be an object');
    return;
  }
  if (!isPositiveInteger(value.length)) {
    errors.push('context.length must be a positive integer');
  }
  if (value.defaultMaxOutputTokens !== undefined) {
    if (!isPositiveInteger(value.defaultMaxOutputTokens)) {
      errors.push('context.defaultMaxOutputTokens must be a positive integer');
    } else if (isPositiveInteger(value.length) && value.defaultMaxOutputTokens > value.length) {
      errors.push('context.defaultMaxOutputTokens must be <= context.length');
    }
  }
}

function validateRuntime(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push('runtime must be an object');
    return;
  }
  if (value.engine !== 'llama-server') {
    errors.push('runtime.engine must be "llama-server"');
  }
  if (value.minVersion !== undefined && !isNonEmptyString(value.minVersion)) {
    errors.push('runtime.minVersion must be a non-empty string');
  }
  if (value.threads !== undefined && !isPositiveInteger(value.threads)) {
    errors.push('runtime.threads must be a positive integer');
  }
  if (value.extraArgs !== undefined) {
    if (!Array.isArray(value.extraArgs) || value.extraArgs.some((arg) => typeof arg !== 'string')) {
      errors.push('runtime.extraArgs must be an array of strings');
    }
  }
}

/**
 * 校验并归一化 manifest；unknown 字段会被保留，sha256 统一为小写。
 * 不访问网络、不读文件。
 */
export function validateModelManifest(input: unknown): ModelManifestValidation {
  const errors: string[] = [];
  if (!isRecord(input)) {
    return { ok: false, errors: ['manifest must be an object'] };
  }
  if (input.schema !== MODEL_MANIFEST_SCHEMA) {
    errors.push(`schema must be ${MODEL_MANIFEST_SCHEMA}`);
  }
  if (!isNonEmptyString(input.modelId) || !ID_RE.test(input.modelId)) {
    errors.push('modelId must match ^[a-z0-9][a-z0-9._-]{0,127}$');
  }
  if (!isNonEmptyString(input.packId) || !ID_RE.test(input.packId)) {
    errors.push('packId must match ^[a-z0-9][a-z0-9._-]{0,127}$');
  }
  if (!isNonEmptyString(input.displayName) || input.displayName.length > 200) {
    errors.push('displayName must be a non-empty string (<= 200 chars)');
  }
  if (input.description !== undefined && (typeof input.description !== 'string' || input.description.length > 4000)) {
    errors.push('description must be a string (<= 4000 chars)');
  }
  if (!isNonEmptyString(input.format) || !FORMATS.has(input.format)) {
    errors.push(`format must be one of ${MODEL_FORMATS.join(', ')}`);
  }
  if (!isNonEmptyString(input.quantization) || input.quantization.length > 64) {
    errors.push('quantization must be a non-empty string (<= 64 chars)');
  }
  if (input.version !== undefined && !isNonEmptyString(input.version)) {
    errors.push('version must be a non-empty string');
  }
  validateFiles(input.files, errors);
  validateLicense(input.license, errors);
  validateRequirements(input.requirements, errors);
  validateContext(input.context, errors);
  validateRuntime(input.runtime, errors);
  validateSource(input.source, errors);

  if (errors.length > 0) return { ok: false, errors };

  const manifest = structuredClone(input) as unknown as ModelManifest;
  manifest.files = manifest.files.map((file) => ({
    ...file,
    sha256: file.sha256.toLowerCase(),
    ...(file.mirrors ? { mirrors: [...file.mirrors] } : {}),
  }));
  return { ok: true, manifest };
}

export function parseModelManifest(input: unknown): ModelManifest {
  const result = validateModelManifest(input);
  if (!result.ok) throw new ModelManifestError(result.errors);
  return result.manifest;
}

export function isModelTier(value: unknown): value is ModelTier {
  return typeof value === 'string' && TIERS.has(value);
}
