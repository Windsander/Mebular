// llama.cpp 官方 release 资产清单（0.3.0）
//
// 这里只描述“哪个平台用哪个官方归档、大小、sha256、归档内路径”，不下载、
// 不解压、不执行。URL 固定由官方仓库 `ggml-org/llama.cpp` 的 tag + 资产名
// 推导，调用方不能传入任意 URL。
//
// 资产来自 GitHub Release `b12017`（nightly，prerelease）；GitHub API 的
// `digest` 字段提供 sha256。更新版本时必须同时更新资产名、大小与哈希。

export const LLAMA_CPP_REPOSITORY = 'ggml-org/llama.cpp';
export const LLAMA_CPP_RELEASE = 'b12017';
export const LLAMA_CPP_RELEASE_TAG = LLAMA_CPP_RELEASE;

export type EngineAssetPlatform = 'darwin' | 'linux' | 'win32';
export type EngineAssetArch = 'arm64' | 'x64';
export type EngineArchiveType = 'tar.gz' | 'zip';

export interface EngineAsset {
  platform: EngineAssetPlatform;
  arch: EngineAssetArch;
  /** 官方 release 资产文件名。 */
  asset: string;
  sizeBytes: number;
  /** 小写 sha256 hex（64 字符）。 */
  sha256: string;
  /** 归档根目录，例如 `llama-b12017/`。 */
  archiveRoot: string;
  /** 归档内二进制相对路径（含归档根目录）。 */
  binaryPath: string;
  archiveType: EngineArchiveType;
  /** 仅指向官方 `ggml-org/llama.cpp` release 的下载地址。 */
  url: string;
  release: string;
}

export interface EngineAssetRequest {
  platform?: string;
  arch?: string;
}

export interface EngineAssetUnsupportedError {
  code: 'engine_asset_unsupported';
  message: string;
  platform: string;
  arch: string;
  supported: string[];
}

export type EngineAssetResolution =
  | { ok: true; asset: EngineAsset }
  | { ok: false; error: EngineAssetUnsupportedError };

const SHA256_RE = /^[a-f0-9]{64}$/;

interface EngineAssetSpec {
  platform: EngineAssetPlatform;
  arch: EngineAssetArch;
  asset: string;
  sizeBytes: number;
  sha256: string;
  archiveType: EngineArchiveType;
}

const ASSET_SPECS: readonly EngineAssetSpec[] = Object.freeze([
  {
    platform: 'darwin',
    arch: 'arm64',
    asset: 'llama-b12017-bin-macos-arm64.tar.gz',
    sizeBytes: 16508951,
    sha256: '4cfa51501cc3c602b404f43682e713405b4b946847876c5081d0a3f93ff26914',
    archiveType: 'tar.gz',
  },
  {
    platform: 'darwin',
    arch: 'x64',
    asset: 'llama-b12017-bin-macos-x64.tar.gz',
    sizeBytes: 12248734,
    sha256: 'f51371545526a8655f30bdf2e2f157d00d7ed9bddf1939106b09ac76148e59e5',
    archiveType: 'tar.gz',
  },
  {
    platform: 'linux',
    arch: 'x64',
    asset: 'llama-b12017-bin-ubuntu-x64.tar.gz',
    sizeBytes: 22880375,
    sha256: '16fe348b1bc2e943bc4c220938ce46af789e88291138bca5bd68c0cc017769a5',
    archiveType: 'tar.gz',
  },
  {
    platform: 'linux',
    arch: 'arm64',
    asset: 'llama-b12017-bin-ubuntu-arm64.tar.gz',
    sizeBytes: 18571024,
    sha256: '676e8f99db67fbecd7854b948ed50d0bf5d7db463613fc8fcd8f4491a7709bec',
    archiveType: 'tar.gz',
  },
  {
    platform: 'win32',
    arch: 'x64',
    asset: 'llama-b12017-bin-win-cpu-x64.zip',
    sizeBytes: 24574610,
    sha256: 'e89d351a603e91a9e3e944c4c4c4ccf5b4af6acbd44c5434b61bacfa3999b1f6',
    archiveType: 'zip',
  },
  {
    platform: 'win32',
    arch: 'arm64',
    asset: 'llama-b12017-bin-win-cpu-arm64.zip',
    sizeBytes: 13068809,
    sha256: '602a97c5bbf770713c6ef15ca395ef0ae27e19022735b8c2eeec3ec4bc29c549',
    archiveType: 'zip',
  },
]);

const OFFICIAL_ASSET_PREFIX = `llama-${LLAMA_CPP_RELEASE}-bin-`;

/** 只允许推导官方仓库 release 下的资产 URL。 */
export function llamaCppReleaseAssetUrl(asset: string): string {
  if (
    typeof asset !== 'string'
    || !asset.startsWith(OFFICIAL_ASSET_PREFIX)
    || !/^[A-Za-z0-9._-]+$/.test(asset)
  ) {
    throw new Error(`not an official llama.cpp ${LLAMA_CPP_RELEASE} release asset: ${String(asset)}`);
  }
  return `https://github.com/${LLAMA_CPP_REPOSITORY}/releases/download/${LLAMA_CPP_RELEASE}/${asset}`;
}

function buildAsset(spec: EngineAssetSpec): EngineAsset {
  if (!SHA256_RE.test(spec.sha256)) {
    throw new Error(`invalid sha256 for llama.cpp asset ${spec.asset}`);
  }
  const archiveRoot = `llama-${LLAMA_CPP_RELEASE}/`;
  return Object.freeze({
    platform: spec.platform,
    arch: spec.arch,
    asset: spec.asset,
    sizeBytes: spec.sizeBytes,
    sha256: spec.sha256,
    archiveRoot,
    binaryPath: `${archiveRoot}llama-server${spec.platform === 'win32' ? '.exe' : ''}`,
    archiveType: spec.archiveType,
    url: llamaCppReleaseAssetUrl(spec.asset),
    release: LLAMA_CPP_RELEASE,
  });
}

/** 完整平台矩阵；顺序稳定，便于文档/测试展示。 */
export const LLAMA_CPP_ENGINE_ASSETS: readonly EngineAsset[] = Object.freeze(
  ASSET_SPECS.map(buildAsset),
);

const ASSET_BY_KEY = new Map<string, EngineAsset>(
  LLAMA_CPP_ENGINE_ASSETS.map((asset) => [`${asset.platform}/${asset.arch}`, asset]),
);

export const SUPPORTED_ENGINE_TARGETS: readonly string[] = Object.freeze(
  LLAMA_CPP_ENGINE_ASSETS.map((asset) => `${asset.platform}/${asset.arch}`),
);

function normalizePlatform(value: string): EngineAssetPlatform | null {
  switch (value.trim().toLowerCase()) {
    case 'darwin':
    case 'macos':
    case 'mac':
      return 'darwin';
    case 'linux':
      return 'linux';
    case 'win32':
    case 'windows':
    case 'win':
      return 'win32';
    default:
      return null;
  }
}

function normalizeArch(value: string): EngineAssetArch | null {
  switch (value.trim().toLowerCase()) {
    case 'arm64':
    case 'aarch64':
      return 'arm64';
    case 'x64':
    case 'amd64':
    case 'x86_64':
      return 'x64';
    default:
      return null;
  }
}

/**
 * 解析当前平台对应的官方 llama.cpp 资产。未知平台/架构不抛异常，返回
 * 结构化 `engine_asset_unsupported`，由调用方决定降级或提示。
 */
export function resolveEngineAsset(request: EngineAssetRequest = {}): EngineAssetResolution {
  const rawPlatform = typeof request.platform === 'string' ? request.platform : process.platform;
  const rawArch = typeof request.arch === 'string' ? request.arch : process.arch;
  const platform = normalizePlatform(rawPlatform);
  const arch = normalizeArch(rawArch);
  if (!platform || !arch) {
    return {
      ok: false,
      error: {
        code: 'engine_asset_unsupported',
        message: `no official llama.cpp asset for ${rawPlatform}/${rawArch}`,
        platform: rawPlatform,
        arch: rawArch,
        supported: [...SUPPORTED_ENGINE_TARGETS],
      },
    };
  }
  const asset = ASSET_BY_KEY.get(`${platform}/${arch}`);
  if (!asset) {
    return {
      ok: false,
      error: {
        code: 'engine_asset_unsupported',
        message: `no official llama.cpp asset for ${platform}/${arch}`,
        platform: rawPlatform,
        arch: rawArch,
        supported: [...SUPPORTED_ENGINE_TARGETS],
      },
    };
  }
  return { ok: true, asset };
}
