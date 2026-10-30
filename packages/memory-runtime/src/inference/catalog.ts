// 精选 Qwen 本地模型目录（0.3.0）
//
// Chief 决策：Qwen 9B（默认）、27B（高质量）、4B（轻量）；32B 不进入精选目录。
//
// 目录只保存“模型是什么 + 仓库坐标 + 硬件要求”，**不保存任意远程 URL**：
// - 完整 manifest（含文件 sha256）由安装器/调用方注入；
// - 仓库坐标用于展示或由上层 resolver 解析成具体镜像；
// - 下载器只接受显式传入的 mirrors，不在源码里猜 Hugging Face 地址。

import {
  modelManifestTotalBytes,
  parseModelManifest,
  type ModelManifest,
  type ModelPack,
  type ModelRepositorySource,
  type ModelSource,
} from './types.js';

const GIB = 1024 ** 3;

const QWEN_4B: ModelPack = {
  packId: 'qwen3.5-4b-instruct-q4_k_m',
  modelId: 'qwen3.5-4b-instruct',
  tier: 'light',
  displayName: 'Qwen3.5 4B（轻量）',
  description: '适合 8 GB 内存设备；响应快、占用低，复杂抽取能力有限。',
  quantization: 'Q4_K_M',
  contextLength: 32768,
  estimatedDownloadBytes: 2_900_000_000,
  requirements: {
    platforms: ['darwin', 'win32', 'linux'],
    minMemoryBytes: 8 * GIB,
    recommendedMemoryBytes: 12 * GIB,
    minDiskBytes: 4 * GIB,
    gpu: 'optional',
  },
  source: {
    kind: 'repo',
    repository: {
      provider: 'huggingface',
      repo: 'Qwen/Qwen3.5-4B-GGUF',
      revision: 'main',
    },
  },
};

const QWEN_9B: ModelPack = {
  packId: 'qwen3.5-9b-instruct-q4_k_m',
  modelId: 'qwen3.5-9b-instruct',
  tier: 'default',
  displayName: 'Qwen3.5 9B（默认）',
  description: '默认精选包：16 GB 内存可运行，质量/速度平衡，适合日常抽取与摘要。',
  quantization: 'Q4_K_M',
  contextLength: 32768,
  estimatedDownloadBytes: 6_300_000_000,
  requirements: {
    platforms: ['darwin', 'win32', 'linux'],
    minMemoryBytes: 16 * GIB,
    recommendedMemoryBytes: 24 * GIB,
    minDiskBytes: 8 * GIB,
    gpu: 'optional',
  },
  source: {
    kind: 'repo',
    repository: {
      provider: 'huggingface',
      repo: 'Qwen/Qwen3.5-9B-GGUF',
      revision: 'main',
    },
  },
  default: true,
};

const QWEN_27B: ModelPack = {
  packId: 'qwen3.5-27b-instruct-q4_k_m',
  modelId: 'qwen3.5-27b-instruct',
  tier: 'quality',
  displayName: 'Qwen3.5 27B（高质量）',
  description: '高质量精选包：建议 64 GB 内存；在复杂事实/偏好抽取上更稳。',
  quantization: 'Q4_K_M',
  contextLength: 32768,
  estimatedDownloadBytes: 17_600_000_000,
  requirements: {
    platforms: ['darwin', 'win32', 'linux'],
    minMemoryBytes: 40 * GIB,
    recommendedMemoryBytes: 64 * GIB,
    minDiskBytes: 22 * GIB,
    gpu: 'optional',
  },
  source: {
    kind: 'repo',
    repository: {
      provider: 'huggingface',
      repo: 'Qwen/Qwen3.5-27B-GGUF',
      revision: 'main',
    },
  },
};

function deepFreezePack(pack: ModelPack): ModelPack {
  const frozen: ModelPack = {
    ...pack,
    requirements: {
      ...pack.requirements,
      platforms: [...pack.requirements.platforms],
      ...(pack.requirements.architectures
        ? { architectures: [...pack.requirements.architectures] }
        : {}),
    },
    source: {
      ...pack.source,
      ...(pack.source.repository ? { repository: { ...pack.source.repository } } : {}),
    },
  };
  if (frozen.requirements.platforms) Object.freeze(frozen.requirements.platforms);
  if (frozen.requirements.architectures) Object.freeze(frozen.requirements.architectures);
  if (frozen.source.repository) Object.freeze(frozen.source.repository);
  Object.freeze(frozen.requirements);
  Object.freeze(frozen.source);
  return Object.freeze(frozen);
}

/** 精选目录：固定三项，顺序为 默认/高质量/轻量。 */
export const CURATED_MODEL_PACKS: readonly ModelPack[] = Object.freeze([
  deepFreezePack(QWEN_9B),
  deepFreezePack(QWEN_27B),
  deepFreezePack(QWEN_4B),
]);

export const DEFAULT_MODEL_PACK_ID = QWEN_9B.packId;

export interface ModelCatalogOptions {
  /**
   * 注入完整 manifest。可以是数组，或 `{ [packId]: manifest }`。
   * 只允许覆盖精选三项，不能借目录夹带 32B 或其他任意模型。
   */
  manifests?: ModelManifest[] | Record<string, ModelManifest>;
  /** 覆盖精选包的仓库坐标（不改变 packId/modelId）。 */
  repositories?: Record<string, ModelRepositorySource>;
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
    if (FORBIDDEN_MODEL_ID_RE.test(manifest.modelId) || FORBIDDEN_MODEL_ID_RE.test(manifest.packId)) {
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

function applyManifest(pack: ModelPack, manifest: ModelManifest): ModelPack {
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
  return {
    ...pack,
    displayName: manifest.displayName,
    description: manifest.description ?? pack.description,
    quantization: manifest.quantization,
    contextLength: manifest.context.length,
    estimatedDownloadBytes: modelManifestTotalBytes(manifest),
    requirements: {
      ...manifest.requirements,
      platforms: [...manifest.requirements.platforms],
      ...(manifest.requirements.architectures
        ? { architectures: [...manifest.requirements.architectures] }
        : {}),
    },
    source: {
      ...manifest.source,
      ...(manifest.source.repository ? { repository: { ...manifest.source.repository } } : {}),
    },
    manifest,
  };
}

/**
 * 构造目录视图。默认返回精选三项（无完整 manifest）；注入 manifest 后对应
 * 条目才具备安装所需的文件哈希。未知 packId / 32B / id 不匹配一律拒绝。
 */
export function createModelCatalog(options: ModelCatalogOptions = {}): ModelPack[] {
  const manifests = normalizeInjectedManifests(options.manifests);
  const known = new Set(CURATED_MODEL_PACKS.map((pack) => pack.packId));
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

  return CURATED_MODEL_PACKS.map((sourcePack) => {
    const repository = options.repositories?.[sourcePack.packId];
    const withRepo: ModelPack = repository
      ? {
          ...sourcePack,
          source: {
            ...sourcePack.source,
            repository: { ...repository },
          } as ModelSource,
        }
      : {
          ...sourcePack,
          requirements: {
            ...sourcePack.requirements,
            platforms: [...sourcePack.requirements.platforms],
            ...(sourcePack.requirements.architectures
              ? { architectures: [...sourcePack.requirements.architectures] }
              : {}),
          },
          source: {
            ...sourcePack.source,
            ...(sourcePack.source.repository
              ? { repository: { ...sourcePack.source.repository } }
              : {}),
          },
        };
    const manifest = manifests.get(sourcePack.packId);
    const withManifest = manifest ? applyManifest(withRepo, manifest) : withRepo;
    if (!repository) return withManifest;
    // 仓库覆盖优先于 manifest 自带的坐标（manifest 仍负责文件与哈希）。
    return {
      ...withManifest,
      source: {
        ...withManifest.source,
        repository: { ...repository },
      },
    };
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

/** 取得可安装 manifest；目录本身不伪造 sha256，必须由调用方注入。 */
export function resolveModelManifest(
  packId: string,
  options: ModelCatalogOptions = {},
): ModelManifest {
  const pack = findModelPack(packId, createModelCatalog(options));
  if (!pack) {
    throw new ModelCatalogError('unknown_pack', `unknown model pack ${packId}`);
  }
  if (!pack.manifest) {
    throw new ModelCatalogError(
      'manifest_missing',
      `pack ${packId} has no injected manifest; refusing to guess file hashes or URLs`,
    );
  }
  return pack.manifest;
}

/** 测试/展示用：目录的稳定摘要不包含任何文件内容或密钥。 */
export function curatedPackIds(): string[] {
  return CURATED_MODEL_PACKS.map((pack) => pack.packId);
}
