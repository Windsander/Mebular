// llama.cpp 官方 release 资产清单：平台矩阵、哈希格式、URL 边界，不联网。

import { describe, it, expect } from '@jest/globals';
import {
  LLAMA_CPP_ENGINE_ASSETS,
  LLAMA_CPP_RELEASE,
  LLAMA_CPP_REPOSITORY,
  SUPPORTED_ENGINE_TARGETS,
  llamaCppReleaseAssetUrl,
  resolveEngineAsset,
} from '../../src/index.js';

const EXPECTED = {
  'darwin/arm64': {
    asset: 'llama-b12017-bin-macos-arm64.tar.gz',
    sizeBytes: 16508951,
    sha256: '4cfa51501cc3c602b404f43682e713405b4b946847876c5081d0a3f93ff26914',
    archiveType: 'tar.gz',
  },
  'darwin/x64': {
    asset: 'llama-b12017-bin-macos-x64.tar.gz',
    sizeBytes: 12248734,
    sha256: 'f51371545526a8655f30bdf2e2f157d00d7ed9bddf1939106b09ac76148e59e5',
    archiveType: 'tar.gz',
  },
  'linux/x64': {
    asset: 'llama-b12017-bin-ubuntu-x64.tar.gz',
    sizeBytes: 22880375,
    sha256: '16fe348b1bc2e943bc4c220938ce46af789e88291138bca5bd68c0cc017769a5',
    archiveType: 'tar.gz',
  },
  'linux/arm64': {
    asset: 'llama-b12017-bin-ubuntu-arm64.tar.gz',
    sizeBytes: 18571024,
    sha256: '676e8f99db67fbecd7854b948ed50d0bf5d7db463613fc8fcd8f4491a7709bec',
    archiveType: 'tar.gz',
  },
  'win32/x64': {
    asset: 'llama-b12017-bin-win-cpu-x64.zip',
    sizeBytes: 24574610,
    sha256: 'e89d351a603e91a9e3e944c4c4c4ccf5b4af6acbd44c5434b61bacfa3999b1f6',
    archiveType: 'zip',
  },
  'win32/arm64': {
    asset: 'llama-b12017-bin-win-cpu-arm64.zip',
    sizeBytes: 13068809,
    sha256: '602a97c5bbf770713c6ef15ca395ef0ae27e19022735b8c2eeec3ec4bc29c549',
    archiveType: 'zip',
  },
} as const;

const OFFICIAL_BASE = `https://github.com/${LLAMA_CPP_REPOSITORY}/releases/download/${LLAMA_CPP_RELEASE}/`;

describe('llama.cpp engine assets', () => {
  it('固定官方 release b12017', () => {
    expect(LLAMA_CPP_RELEASE).toBe('b12017');
    expect(LLAMA_CPP_REPOSITORY).toBe('ggml-org/llama.cpp');
  });

  it('平台矩阵覆盖 macOS/Linux/Windows 的 arm64/x64', () => {
    expect([...SUPPORTED_ENGINE_TARGETS].sort()).toEqual(Object.keys(EXPECTED).sort());
    expect(LLAMA_CPP_ENGINE_ASSETS).toHaveLength(6);

    for (const [target, expected] of Object.entries(EXPECTED)) {
      const [platform, arch] = target.split('/');
      const result = resolveEngineAsset({ platform, arch });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.asset).toMatchObject({
        platform,
        arch,
        ...expected,
        release: LLAMA_CPP_RELEASE,
        archiveRoot: `llama-${LLAMA_CPP_RELEASE}/`,
      });
      expect(result.asset.binaryPath).toBe(
        `llama-${LLAMA_CPP_RELEASE}/llama-server${platform === 'win32' ? '.exe' : ''}`,
      );
      expect(result.asset.url).toBe(`${OFFICIAL_BASE}${expected.asset}`);
      expect(result.asset.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(Number.isSafeInteger(result.asset.sizeBytes)).toBe(true);
      expect(result.asset.sizeBytes).toBeGreaterThan(0);
    }
  });

  it('平台/架构别名可解析，未知平台返回结构化错误', () => {
    expect(resolveEngineAsset({ platform: 'macos', arch: 'aarch64' })).toMatchObject({
      ok: true,
      asset: { platform: 'darwin', arch: 'arm64' },
    });
    expect(resolveEngineAsset({ platform: 'windows', arch: 'amd64' })).toMatchObject({
      ok: true,
      asset: { platform: 'win32', arch: 'x64' },
    });

    expect(resolveEngineAsset({ platform: 'freebsd', arch: 'x64' })).toMatchObject({
      ok: false,
      error: {
        code: 'engine_asset_unsupported',
        platform: 'freebsd',
        arch: 'x64',
        supported: expect.arrayContaining(['darwin/arm64', 'linux/x64', 'win32/x64']),
      },
    });
    expect(resolveEngineAsset({ platform: 'linux', arch: 'ia32' })).toMatchObject({
      ok: false,
      error: { code: 'engine_asset_unsupported', platform: 'linux', arch: 'ia32' },
    });
  });

  it('URL 只能指向官方 ggml-org/llama.cpp release', () => {
    for (const asset of LLAMA_CPP_ENGINE_ASSETS) {
      expect(asset.url.startsWith(OFFICIAL_BASE)).toBe(true);
      expect(asset.url).toBe(llamaCppReleaseAssetUrl(asset.asset));
    }
    expect(() => llamaCppReleaseAssetUrl('https://evil.example/llama.tar.gz')).toThrow();
    expect(() => llamaCppReleaseAssetUrl('other-b12017-bin-macos-arm64.tar.gz')).toThrow();
    expect(() => llamaCppReleaseAssetUrl('llama-b12017-bin-macos-arm64.tar.gz?x=1')).toThrow();
  });
});
