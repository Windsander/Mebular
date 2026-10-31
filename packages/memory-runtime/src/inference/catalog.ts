// 精选本地模型目录（0.3.0）
//
// 精选 Qwen3 GGUF：4B（轻量）、8B（默认）、14B（高质量）、30B-A3B（高端 MoE）。
// 32B 不进入精选目录。
//
// 目录内置完整 manifest（文件列表、大小、sha256、license、revision），
// 下载 URL 只由 `source.repository`（HuggingFace owner/repo + revision）与
// 文件名推导；不接受调用方传入的任意下载 URL。模型权重不进入 npm/仓库。
//
// 未知 pack、32B、packId/modelId 不一致一律拒绝。

import { LLAMA_CPP_RELEASE } from './engine-assets.js';
import {
  MODEL_MANIFEST_SCHEMA,
  isSafeModelFilePath,
  modelManifestTotalBytes,
  parseModelManifest,
  type ModelFile,
  type ModelManifest,
  type ModelPack,
  type ModelRepositorySource,
  type ModelRequirements,
  type ModelSource,
  type ModelTier,
} from './types.js';

const GIB = 1024 ** 3;

export interface CuratedModelSpec {
  packId: string;
  modelId: string;
  tier: ModelTier;
  displayName: string;
  description: string;
  repo: string;
  revision: string;
  file: string;
  sizeBytes: number;
  sha256: string;
  minMemoryBytes: number;
  recommendedMemoryBytes: number;
  minDiskBytes: number;
  default?: boolean;
}

const QWEN_8B: CuratedModelSpec = {
  packId: 'qwen3-8b-instruct-q4_k_m',
  modelId: 'qwen3-8b-instruct',
  tier: 'default',
  displayName: 'Qwen3 8B（默认）',
  description: '默认精选包：16 GB 内存可启动，质量/速度平衡，适合日常抽取、摘要与排序。',
  repo: 'Qwen/Qwen3-8B-GGUF',
  revision: '7c41481f57cb95916b40956ab2f0b139b296d974',
  file: 'Qwen3-8B-Q4_K_M.gguf',
  sizeBytes: 5027783488,
  sha256: 'd98cdcbd03e17ce47681435b5150e34c1417f50b5c0019dd560e4882c5745785',
  minMemoryBytes: 16 * GIB,
  recommendedMemoryBytes: 24 * GIB,
  minDiskBytes: 7 * GIB,
  default: true,
};

const QWEN_30B_A3B: CuratedModelSpec = {
  packId: 'qwen3-30b-a3b-instruct-q4_k_m',
  modelId: 'qwen3-30b-a3b-instruct',
  tier: 'high',
  displayName: 'Qwen3 30B-A3B（高端 MoE）',
  description: 'MoE 模型：总参数 30B、每 token 约 3B 激活；建议 64 GB 内存，适合高精度抽取与复杂摘要。',
  repo: 'Qwen/Qwen3-30B-A3B-GGUF',
  revision: 'e4d4bafdfb96a411a163846265362aceb0b9c63a',
  file: 'Qwen3-30B-A3B-Q4_K_M.gguf',
  sizeBytes: 18556685824,
  sha256: '0d003f6662faee786ed5da3e31b29c978de5ae5d275c8794c606a7f3c01aa8f5',
  minMemoryBytes: 48 * GIB,
  recommendedMemoryBytes: 64 * GIB,
  minDiskBytes: 24 * GIB,
};

const QWEN_14B: CuratedModelSpec = {
  packId: 'qwen3-14b-instruct-q4_k_m',
  modelId: 'qwen3-14b-instruct',
  tier: 'quality',
  displayName: 'Qwen3 14B（高质量）',
  description: '高质量精选包：建议 32 GB 内存；在复杂事实/偏好抽取上比 8B 更稳。',
  repo: 'Qwen/Qwen3-14B-GGUF',
  revision: '530227a7d994db8eca5ab5ced2fb692b614357fd',
  file: 'Qwen3-14B-Q4_K_M.gguf',
  sizeBytes: 9001752960,
  sha256: '500a8806e85ee9c83f3ae08420295592451379b4f8cf2d0f41c15dffeb6b81f0',
  minMemoryBytes: 24 * GIB,
  recommendedMemoryBytes: 32 * GIB,
  minDiskBytes: 12 * GIB,
};

const QWEN_4B: CuratedModelSpec = {
  packId: 'qwen3-4b-instruct-q4_k_m',
  modelId: 'qwen3-4b-instruct',
  tier: 'light',
  displayName: 'Qwen3 4B（轻量）',
  description: '适合 8 GB 内存设备；响应快、占用低，复杂抽取能力有限。',
  repo: 'Qwen/Qwen3-4B-GGUF',
  revision: 'bc640142c66e1fdd12af0bd68f40445458f3869b',
  file: 'Qwen3-4B-Q4_K_M.gguf',
  sizeBytes: 2497280256,
  sha256: '7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5',
  minMemoryBytes: 8 * GIB,
  recommendedMemoryBytes: 12 * GIB,
  minDiskBytes: 4 * GIB,
};

// 与旧 9B/27B 目录的顺序保持同样的“默认在前、其余按质量从高到低”。
const CURATED_SPECS: readonly CuratedModelSpec[] = Object.freeze([
  QWEN_8B,
  QWEN_30B_A3B,
  QWEN_14B,
  QWEN_4B,
]);

const HUGGINGFACE_BASE = 'https://huggingface.co';
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REVISION_RE = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * 由 HuggingFace 仓库坐标 + 包内文件名推导下载 URL。
 * 只接受 provider=huggingface、合法 repo/revision 与安全相对路径。
 */
export function huggingFaceResolveUrl(
  repository: Pick<ModelRepositorySource, 'provider' | 'repo' | 'revision'>,
  filePath: string,
): string {
  if (repository.provider !== 'huggingface') {
    throw new ModelCatalogError(
      'manifest_mismatch',
      `cannot derive a HuggingFace URL for provider ${repository.provider}`,
    );
  }
  if (!REPO_RE.test(repository.repo)) {
    throw new ModelCatalogError('manifest_mismatch', `invalid HuggingFace repo: ${repository.repo}`);
  }
  const revision = repository.revision ?? 'main';
  if (!REVISION_RE.test(revision)) {
    throw new ModelCatalogError('manifest_mismatch', `invalid HuggingFace revision: ${revision}`);
  }
  if (!isSafeModelFilePath(filePath)) {
    throw new ModelCatalogError('manifest_mismatch', `unsafe model file path: ${filePath}`);
  }
  const encodedPath = filePath.split('/').map((part) => encodeURIComponent(part)).join('/');
  return `${HUGGINGFACE_BASE}/${repository.repo}/resolve/${encodeURIComponent(revision)}/${encodedPath}`;
}

function repositoryForSpec(spec: CuratedModelSpec): ModelRepositorySource {
  return {
    provider: 'huggingface',
    repo: spec.repo,
    revision: spec.revision,
  };
}

function licenseUrlForSpec(spec: CuratedModelSpec): string {
  return `${HUGGINGFACE_BASE}/${spec.repo}/blob/${spec.revision}/LICENSE`;
}

function buildCuratedManifest(spec: CuratedModelSpec): ModelManifest {
  const repository = repositoryForSpec(spec);
  const licenseUrl = licenseUrlForSpec(spec);
  const raw: ModelManifest = {
    schema: MODEL_MANIFEST_SCHEMA,
    modelId: spec.modelId,
    packId: spec.packId,
    displayName: spec.displayName,
    description: spec.description,
    format: 'gguf',
    quantization: 'Q4_K_M',
    files: [{
      path: spec.file,
      sizeBytes: spec.sizeBytes,
      sha256: spec.sha256,
      url: huggingFaceResolveUrl(repository, spec.file),
    }],
    license: {
      id: 'apache-2.0',
      name: 'Apache License 2.0',
      url: licenseUrl,
      requiresAcceptance: false,
    },
    requirements: {
      platforms: ['darwin', 'win32', 'linux'],
      minMemoryBytes: spec.minMemoryBytes,
      recommendedMemoryBytes: spec.recommendedMemoryBytes,
      minDiskBytes: spec.minDiskBytes,
      gpu: 'optional',
    },
    context: { length: 32768, defaultMaxOutputTokens: 2048 },
    runtime: { engine: 'llama-server', minVersion: LLAMA_CPP_RELEASE },
    source: {
      kind: 'repo',
      repository,
      homepage: `${HUGGINGFACE_BASE}/${spec.repo}`,
      licenseUrl,
    },
  };
  return parseModelManifest(raw);
}

function buildCuratedPack(spec: CuratedModelSpec, manifest: ModelManifest): ModelPack {
  return {
    packId: spec.packId,
    modelId: spec.modelId,
    tier: spec.tier,
    displayName: spec.displayName,
    description: spec.description,
    quantization: manifest.quantization,
    contextLength: manifest.context.length,
    estimatedDownloadBytes: modelManifestTotalBytes(manifest),
    requirements: manifest.requirements,
    source: manifest.source,
    ...(spec.default ? { default: true } : {}),
    manifest,
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value);
}

const CURATED_PACKS: readonly ModelPack[] = CURATED_SPECS.map((spec) => {
  const manifest = buildCuratedManifest(spec);
  return deepFreeze(buildCuratedPack(spec, manifest));
});

const CURATED_BY_ID = new Map(CURATED_PACKS.map((pack) => [pack.packId, pack]));

/** 精选目录：默认 8B、高端 30B-A3B、高质量 14B、轻量 4B。 */
export const CURATED_MODEL_PACKS: readonly ModelPack[] = Object.freeze([...CURATED_PACKS]);

export const DEFAULT_MODEL_PACK_ID = QWEN_8B.packId;

export interface ModelCatalogOptions {
  /**
   * 注入完整 manifest。可以是数组，或 `{ [packId]: manifest }`。
   * 只允许覆盖精选项，不能借目录夹带 32B 或其他任意模型。
   */
  manifests?: ModelManifest[] | Record<string, ModelManifest>;
  /** 覆盖精选包的仓库坐标（不改变 packId/modelId）。 */
  repositories?: Record<string, ModelRepositorySource>;
  /**
   * 是否在目录条目上附带完整 manifest；默认 true。
   * 关闭后仅保留仓库坐标与硬件要求（旧目录视图）。
   */
  includeManifests?: boolean;
}

export type ModelCatalogErrorCode =
  | 'unknown_pack'
  | 'manifest_missing'
  | 'manifest_mismatch'
  | 'excluded_model'
  | 'duplicate_pack';

export class ModelCatalogError extends Error {
  constructor(
    readonly code: ModelCatalogErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ModelCatalogError';
  }
}

const FORBIDDEN_MODEL_ID_RE = /(^|[^a-z0-9])32b([^a-z0-9]|$)/i;

function isForbiddenModel(value: string): boolean {
  return FORBIDDEN_MODEL_ID_RE.test(value);
}

function normalizeInjectedManifests(
  input: ModelCatalogOptions['manifests'],
): Map<string, ModelManifest> {
  const map = new Map<string, ModelManifest>();
  if (!input) return map;
  const entries: Array<[string | null, unknown]> = Array.isArray(input)
    ? input.map((manifest) => [null, manifest])
    : Object.entries(input);
  for (const [key, raw] of entries) {
    const manifest = parseModelManifest(raw);
    if (isForbiddenModel(manifest.modelId) || isForbiddenModel(manifest.packId)) {
      throw new ModelCatalogError(
        'excluded_model',
        `Qwen 32B is not part of the curated catalog: ${manifest.packId}`,
      );
    }
    if (key !== null && key !== manifest.packId) {
      throw new ModelCatalogError(
        'manifest_mismatch',
        `manifest key ${key} does not match packId ${manifest.packId}`,
      );
    }
    if (map.has(manifest.packId)) {
      throw new ModelCatalogError('duplicate_pack', `duplicate manifest for pack ${manifest.packId}`);
    }
    map.set(manifest.packId, manifest);
  }
  return map;
}

function cloneRequirements(requirements: ModelRequirements): ModelRequirements {
  return {
    ...requirements,
    platforms: [...requirements.platforms],
    ...(requirements.architectures ? { architectures: [...requirements.architectures] } : {}),
  };
}

function cloneSource(source: ModelSource): ModelSource {
  return {
    ...source,
    ...(source.repository ? { repository: { ...source.repository } } : {}),
  };
}

function cloneManifest(manifest: ModelManifest): ModelManifest {
  return structuredClone(manifest);
}

/** 精选目录不信任注入 manifest 自带 URL；无仓库坐标时直接移除。 */
function stripManifestUrls(manifest: ModelManifest): ModelManifest {
  return {
    ...manifest,
    files: manifest.files.map((file) => {
      const { url: _url, mirrors: _mirrors, ...rest } = file;
      return rest;
    }),
  };
}

function clonePack(pack: ModelPack): ModelPack {
  return {
    ...pack,
    requirements: cloneRequirements(pack.requirements),
    source: cloneSource(pack.source),
    ...(pack.manifest ? { manifest: cloneManifest(pack.manifest) } : {}),
  };
}

/** 用仓库坐标重写 manifest 的文件 URL；非 HF 仓库不保留任意 URL。 */
function applyRepositoryToManifest(
  manifest: ModelManifest,
  repository: ModelRepositorySource,
): ModelManifest {
  const files: ModelFile[] = manifest.files.map((file) => {
    const { mirrors: _mirrors, ...rest } = file;
    if (repository.provider === 'huggingface') {
      return { ...rest, url: huggingFaceResolveUrl(repository, file.path) };
    }
    const { url: _url, ...withoutUrl } = rest;
    return withoutUrl;
  });
  return {
    ...manifest,
    files,
    source: {
      ...manifest.source,
      kind: 'repo',
      repository: { ...repository },
      ...(repository.provider === 'huggingface'
        ? { homepage: `${HUGGINGFACE_BASE}/${repository.repo}` }
        : {}),
    },
  };
}

function applyRepository(pack: ModelPack, repository: ModelRepositorySource): ModelPack {
  const source: ModelSource = {
    ...pack.source,
    kind: 'repo',
    repository: { ...repository },
    ...(repository.provider === 'huggingface'
      ? { homepage: `${HUGGINGFACE_BASE}/${repository.repo}` }
      : {}),
  };
  return {
    ...pack,
    source,
    ...(pack.manifest
      ? { manifest: applyRepositoryToManifest(pack.manifest, repository) }
      : {}),
  };
}

function applyManifest(
  pack: ModelPack,
  manifest: ModelManifest,
  repositoryOverride?: ModelRepositorySource,
): ModelPack {
  if (manifest.packId !== pack.packId) {
    throw new ModelCatalogError(
      'manifest_mismatch',
      `manifest packId ${manifest.packId} does not match catalog pack ${pack.packId}`,
    );
  }
  if (manifest.modelId !== pack.modelId) {
    throw new ModelCatalogError(
      'manifest_mismatch',
      `manifest modelId ${manifest.modelId} does not match catalog model ${pack.modelId}`,
    );
  }

  const effectiveRepository = repositoryOverride ?? manifest.source.repository;
  const effectiveManifest = effectiveRepository
    ? applyRepositoryToManifest(manifest, effectiveRepository)
    : stripManifestUrls(cloneManifest(manifest));
  if (repositoryOverride) {
    effectiveManifest.source = {
      ...effectiveManifest.source,
      kind: 'repo',
      repository: { ...repositoryOverride },
    };
  }

  return {
    ...pack,
    displayName: effectiveManifest.displayName,
    description: effectiveManifest.description ?? pack.description,
    quantization: effectiveManifest.quantization,
    contextLength: effectiveManifest.context.length,
    estimatedDownloadBytes: modelManifestTotalBytes(effectiveManifest),
    requirements: cloneRequirements(effectiveManifest.requirements),
    source: cloneSource(effectiveManifest.source),
    manifest: effectiveManifest,
  };
}

function knownPackIds(): Set<string> {
  return new Set(CURATED_PACKS.map((pack) => pack.packId));
}

function assertPackLookup(packId: string): ModelPack {
  if (isForbiddenModel(packId)) {
    throw new ModelCatalogError('excluded_model', `Qwen 32B is not part of the curated catalog: ${packId}`);
  }
  const pack = CURATED_BY_ID.get(packId);
  if (!pack) {
    throw new ModelCatalogError('unknown_pack', `unknown model pack ${packId}`);
  }
  return pack;
}

/**
 * 构造目录视图。默认附带内置完整 manifest；注入 manifest 后覆盖对应条目。
 * 未知 packId / 32B / id 不匹配一律拒绝。
 */
export function createModelCatalog(options: ModelCatalogOptions = {}): ModelPack[] {
  const manifests = normalizeInjectedManifests(options.manifests);
  const includeManifests = options.includeManifests ?? true;
  const known = knownPackIds();
  for (const packId of manifests.keys()) {
    if (!known.has(packId)) {
      throw new ModelCatalogError(
        'unknown_pack',
        `manifest pack ${packId} is not in the curated Qwen catalog`,
      );
    }
  }
  if (options.repositories) {
    for (const packId of Object.keys(options.repositories)) {
      if (!known.has(packId)) {
        throw new ModelCatalogError(
          'unknown_pack',
          `repository override for unknown pack ${packId}`,
        );
      }
    }
  }

  return CURATED_PACKS.map((sourcePack) => {
    const repository = options.repositories?.[sourcePack.packId];
    let pack = clonePack(sourcePack);
    if (repository) pack = applyRepository(pack, repository);

    const manifest = manifests.get(sourcePack.packId);
    if (manifest) {
      return applyManifest(pack, manifest, repository);
    }
    if (!includeManifests) {
      delete pack.manifest;
    }
    return pack;
  });
}

export function findModelPack(
  packId: string,
  packs: readonly ModelPack[] = CURATED_MODEL_PACKS,
): ModelPack | null {
  return packs.find((pack) => pack.packId === packId) ?? null;
}

export function getDefaultModelPack(
  packs: readonly ModelPack[] = CURATED_MODEL_PACKS,
): ModelPack {
  const pack = packs.find((entry) => entry.default)
    ?? packs.find((entry) => entry.tier === 'default')
    ?? packs[0];
  if (!pack) {
    throw new ModelCatalogError('manifest_missing', 'model catalog is empty');
  }
  return pack;
}

/** 取得精选包的内置 manifest；安装器无需再注入 manifest。 */
export function resolveCuratedManifest(packId: string): ModelManifest {
  return cloneManifest(assertPackLookup(packId).manifest!);
}

/** 列出全部精选内置 manifest（深拷贝，调用方可安全修改副本）。 */
export function listCuratedManifests(): ModelManifest[] {
  return CURATED_PACKS.map((pack) => cloneManifest(pack.manifest!));
}

/**
 * 兼容旧调用：注入 manifest 时返回注入结果，否则返回内置 manifest。
 * 只有显式 `includeManifests: false` 且没有注入时才会抛 manifest_missing。
 */
export function resolveModelManifest(
  packId: string,
  options: ModelCatalogOptions = {},
): ModelManifest {
  const pack = findModelPack(packId, createModelCatalog(options));
  if (!pack) {
    assertPackLookup(packId);
    throw new ModelCatalogError('unknown_pack', `unknown model pack ${packId}`);
  }
  if (!pack.manifest) {
    throw new ModelCatalogError(
      'manifest_missing',
      `pack ${packId} has no manifest; enable manifests or inject one explicitly`,
    );
  }
  return pack.manifest;
}

/** 测试/展示用：目录的稳定摘要不包含任何文件内容或密钥。 */
export function curatedPackIds(): string[] {
  return CURATED_PACKS.map((pack) => pack.packId);
}
