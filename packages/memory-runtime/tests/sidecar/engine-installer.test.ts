// EngineInstaller：官方资产解析、下载校验、安全解压、幂等与失败清理。
// 全部使用 fake fetch / 临时目录 / 构造的小归档，不访问网络、不下载真实引擎。

import { afterEach, describe, expect, it } from '@jest/globals';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  llamaCppReleaseAssetUrl,
  type EngineAsset,
} from '../../src/inference/engine-assets.js';
import type { FetchResponseLike, ModelStoreFetch } from '../../src/inference/store.js';
import {
  EngineInstaller,
  extractEngineArchive,
} from '../../src/sidecar/inference/engine-installer.js';

const NOW = 1_760_000_000_000;
const ROOT = 'llama-b12017/';
const BINARY = `${ROOT}llama-server`;
const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mebular-engine-'));
  dirs.push(dir);
  return dir;
}

interface TarFixtureEntry {
  name: string;
  type?: 'file' | 'directory' | 'symlink' | 'hardlink';
  data?: Buffer;
  linkName?: string;
  mode?: number;
}

function tarHeader(entry: TarFixtureEntry): Buffer {
  const header = Buffer.alloc(512, 0);
  const data = entry.type === undefined || entry.type === 'file' ? (entry.data ?? Buffer.alloc(0)) : Buffer.alloc(0);
  const typeFlag = entry.type === 'directory'
    ? '5'
    : entry.type === 'symlink' ? '2' : entry.type === 'hardlink' ? '1' : '0';
  const writeOctal = (value: number, offset: number, length: number): void => {
    header.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii');
  };
  header.write(entry.name, 0, 100, 'utf8');
  writeOctal(entry.mode ?? (entry.type === 'directory' ? 0o755 : 0o644), 100, 8);
  writeOctal(0, 108, 8);
  writeOctal(0, 116, 8);
  writeOctal(data.length, 124, 12);
  writeOctal(0, 136, 12);
  header.write('        ', 148, 8, 'ascii');
  header.write(typeFlag, 156, 1, 'ascii');
  if (entry.linkName) header.write(entry.linkName, 157, 100, 'utf8');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

function tarArchive(entries: TarFixtureEntry[]): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const data = entry.type === undefined || entry.type === 'file' ? (entry.data ?? Buffer.alloc(0)) : Buffer.alloc(0);
    chunks.push(tarHeader({ ...entry, data }));
    if (data.length > 0) {
      chunks.push(data);
      const padding = (512 - (data.length % 512)) % 512;
      if (padding > 0) chunks.push(Buffer.alloc(padding));
    }
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

interface ZipFixtureEntry {
  name: string;
  data?: Buffer;
  mode?: number;
  directory?: boolean;
  symlink?: boolean;
}

function zipArchive(entries: ZipFixtureEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = entry.data ?? Buffer.alloc(0);
    const method = 0;
    const flags = 0x0800;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);

    const external = (entry.mode ?? (entry.directory ? 0o040755 : entry.symlink ? 0o120777 : 0o100644)) << 16;
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(external >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const localPart = Buffer.concat(locals);
  const centralPart = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralPart.length, 12);
  end.writeUInt32LE(localPart.length, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([localPart, centralPart, end]);
}

function fakeAsset(archive: Buffer, archiveType: 'tar.gz' | 'zip'): EngineAsset {
  const assetName = `llama-b12017-bin-test.${archiveType}`;
  return {
    platform: 'darwin',
    arch: 'arm64',
    asset: assetName,
    sizeBytes: archive.length,
    sha256: createHash('sha256').update(archive).digest('hex'),
    archiveRoot: ROOT,
    binaryPath: BINARY,
    archiveType,
    url: llamaCppReleaseAssetUrl(assetName),
    release: 'b12017',
  };
}

function fetchBody(
  body: Buffer,
  onCall?: (url: string) => void,
  chunkSize = 7,
): ModelStoreFetch {
  return async (url) => {
    onCall?.(url);
    let offset = 0;
    const iterator: AsyncIterableIterator<Uint8Array> = {
      async next() {
        if (offset >= body.length) return { done: true, value: undefined };
        const end = Math.min(body.length, offset + chunkSize);
        const value = body.subarray(offset, end);
        offset = end;
        return { done: false, value };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: iterator,
    } as FetchResponseLike;
  };
}

function installerFor(
  dir: string,
  asset: EngineAsset,
  fetch: ModelStoreFetch,
): EngineInstaller {
  return new EngineInstaller({
    dataDir: dir,
    platform: 'darwin',
    arch: 'arm64',
    now: () => NOW,
    nonce: () => 'test',
    resolveAsset: () => ({ ok: true, asset }),
    fetch,
  });
}

function tarWithBinary(): Buffer {
  return gzipSync(tarArchive([
    { name: ROOT, type: 'directory' },
    { name: BINARY, data: Buffer.from('#!/bin/sh\nexit 0\n') },
    { name: `${ROOT}libllama.dylib`, data: Buffer.from('library') },
  ]));
}

describe('EngineInstaller assets', () => {
  it('未知平台返回 engine_asset_unsupported，不尝试下载', async () => {
    const dir = await tempDir();
    let fetched = 0;
    const installer = new EngineInstaller({
      dataDir: dir,
      platform: 'freebsd',
      arch: 'x64',
      fetch: async () => {
        fetched += 1;
        throw new Error('should not fetch');
      },
    });
    await installer.init();
    expect(installer.status()).toMatchObject({
      supported: false,
      installed: false,
      reason: 'engine_asset_unsupported',
      platform: 'freebsd',
      arch: 'x64',
    });
    await expect(installer.ensureInstalled()).rejects.toMatchObject({
      code: 'engine_asset_unsupported',
    });
    expect(fetched).toBe(0);
  });

  it('只接受官方 release URL，注入任意 URL 会被拒绝', async () => {
    const dir = await tempDir();
    const archive = tarWithBinary();
    const asset = fakeAsset(archive, 'tar.gz');
    const installer = new EngineInstaller({
      dataDir: dir,
      platform: 'darwin',
      arch: 'arm64',
      resolveAsset: () => ({ ok: true, asset: { ...asset, url: 'https://evil.example/llama.tar.gz' } }),
      fetch: async () => {
        throw new Error('should not fetch');
      },
    });
    await installer.init();
    expect(installer.status().supported).toBe(false);
    await expect(installer.ensureInstalled()).rejects.toMatchObject({
      code: 'engine_asset_unsupported',
    });
  });

  it('下载校验 size + sha256、安全安装、幂等并写入 0600 状态', async () => {
    const dir = await tempDir();
    const archive = tarWithBinary();
    const asset = fakeAsset(archive, 'tar.gz');
    const urls: string[] = [];
    const phases: string[] = [];
    const installer = installerFor(dir, asset, fetchBody(archive, (url) => urls.push(url)));
    const status = await installer.ensureInstalled({
      onProgress: (progress) => phases.push(progress.phase),
    });
    expect(status).toMatchObject({
      state: 'installed',
      installed: true,
      release: 'b12017',
      platform: 'darwin',
      arch: 'arm64',
      binaryReady: true,
      reason: null,
      progress: 1,
    });
    expect(urls).toEqual([llamaCppReleaseAssetUrl(asset.asset)]);
    expect(phases).toEqual(expect.arrayContaining(['downloading', 'verifying', 'extracting', 'installing']));

    const binary = installer.binaryPath();
    expect(binary).toBeTruthy();
    const binaryInfo = await stat(binary!);
    expect(binaryInfo.isFile()).toBe(true);
    expect(binaryInfo.size).toBeGreaterThan(0);
    if (process.platform !== 'win32') {
      expect(binaryInfo.mode & 0o111).not.toBe(0);
    }

    const statePath = join(dir, 'inference', 'engine', 'state.json');
    const stateInfo = await stat(statePath);
    if (process.platform !== 'win32') {
      expect(stateInfo.mode & 0o777).toBe(0o600);
    }
    const stored = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>;
    expect(stored).toMatchObject({
      schema: 1,
      release: 'b12017',
      platform: 'darwin',
      arch: 'arm64',
      asset: asset.asset,
      sha256: asset.sha256,
      binaryPath: BINARY,
      binaryReady: true,
      installedAt: NOW,
      verifiedAt: NOW,
    });
    expect(JSON.stringify(installer.status())).not.toContain(dir);
    expect(JSON.stringify(stored)).not.toContain(dir);

    let secondFetches = 0;
    const second = installerFor(dir, asset, async () => {
      secondFetches += 1;
      throw new Error('should not download twice');
    });
    const secondStatus = await second.ensureInstalled();
    expect(secondStatus.installed).toBe(true);
    expect(secondFetches).toBe(0);
    expect(second.binaryPath()).toBe(binary);
    expect((await readdir(join(dir, 'inference', 'engine'))).sort()).toEqual(['current', 'state.json']);

    const removed = await installer.remove();
    expect(removed.removed).toBe(true);
    expect(installer.status()).toMatchObject({ installed: false, binaryReady: false, state: 'not_installed' });
    expect(installer.binaryPath()).toBeNull();
  });

  it('sha256 不一致返回 engine_checksum_mismatch 并清理临时文件', async () => {
    const dir = await tempDir();
    const archive = tarWithBinary();
    const asset = { ...fakeAsset(archive, 'tar.gz'), sha256: '0'.repeat(64) };
    const installer = installerFor(dir, asset, fetchBody(archive));
    await expect(installer.ensureInstalled()).rejects.toMatchObject({
      code: 'engine_checksum_mismatch',
    });
    expect(installer.status()).toMatchObject({
      installed: false,
      binaryReady: false,
      state: 'failed',
      reason: 'engine_checksum_mismatch',
    });
    const engineDir = join(dir, 'inference', 'engine');
    expect(await readdir(engineDir)).toEqual([]);
    expect(await stat(join(engineDir, 'state.json')).catch(() => null)).toBeNull();
  });

  it('size 不一致返回 engine_size_mismatch，不写状态', async () => {
    const dir = await tempDir();
    const archive = tarWithBinary();
    const asset = { ...fakeAsset(archive, 'tar.gz'), sizeBytes: archive.length + 1 };
    const installer = installerFor(dir, asset, fetchBody(archive));
    await expect(installer.ensureInstalled()).rejects.toMatchObject({
      code: 'engine_size_mismatch',
    });
    const engineDir = join(dir, 'inference', 'engine');
    expect(await readdir(engineDir)).toEqual([]);
  });

  it('取消会 abort 下载并清理 partial，不留下半安装状态', async () => {
    const dir = await tempDir();
    const archive = tarWithBinary();
    const asset = fakeAsset(archive, 'tar.gz');
    const controller = new AbortController();
    const installer = installerFor(dir, asset, fetchBody(archive));
    await expect(installer.ensureInstalled({
      signal: controller.signal,
      onProgress: (progress) => {
        if (progress.downloadedBytes > 0) controller.abort();
      },
    })).rejects.toMatchObject({ code: 'cancelled' });
    expect(installer.status()).toMatchObject({
      state: 'cancelled',
      installed: false,
      reason: 'cancelled',
    });
    const engineDir = join(dir, 'inference', 'engine');
    expect(await readdir(engineDir)).toEqual([]);
  });
});

describe('safe engine archive extraction', () => {
  async function extract(
    dir: string,
    target: string,
    archive: Buffer,
    archiveType: 'tar.gz' | 'zip' = 'tar.gz',
  ): Promise<void> {
    const archivePath = join(dir, `archive-${Date.now()}-${Math.random()}.${archiveType}`);
    await writeFile(archivePath, archive);
    const asset = { ...fakeAsset(archive, archiveType) };
    await extractEngineArchive({ archivePath, asset, targetDir: target });
  }

  it('成功解压 tar.gz 并找到 llama-server', async () => {
    const dir = await tempDir();
    const target = join(dir, 'out');
    const archive = tarWithBinary();
    await extract(dir, target, archive);
    const info = await stat(join(target, BINARY));
    expect(info.isFile()).toBe(true);
    expect((await readFile(join(target, BINARY), 'utf8')).startsWith('#!/bin/sh')).toBe(true);
  });

  it('成功解压 zip 并找到 llama-server.exe 布局', async () => {
    const dir = await tempDir();
    const target = join(dir, 'out');
    const archive = zipArchive([
      { name: ROOT, directory: true },
      { name: `${ROOT}llama-server.exe`, data: Buffer.from('MZ') },
    ]);
    const asset = {
      ...fakeAsset(archive, 'zip'),
      platform: 'win32' as const,
      binaryPath: `${ROOT}llama-server.exe`,
    };
    const archivePath = join(dir, `engine-${Date.now()}.zip`);
    await writeFile(archivePath, archive);
    await extractEngineArchive({ archivePath, asset, targetDir: target });
    expect((await stat(join(target, `${ROOT}llama-server.exe`))).isFile()).toBe(true);
  });

  it('拒绝 ../、绝对路径、符号链接与硬链接', async () => {
    const dir = await tempDir();
    const cases = [
      [{ name: `${ROOT}../../evil`, data: Buffer.from('x') }],
      [{ name: '/tmp/evil', data: Buffer.from('x') }],
      [{ name: `${ROOT}llama-server`, type: 'symlink' as const, linkName: '../../evil' }],
      [{ name: `${ROOT}llama-server`, type: 'hardlink' as const, linkName: `${ROOT}other` }],
    ];
    for (const [index, entries] of cases.entries()) {
      const target = join(dir, `out-${index}`);
      const archivePath = join(dir, `bad-${index}.tar.gz`);
      await writeFile(archivePath, gzipSync(tarArchive(entries as TarFixtureEntry[])));
      await expect(extractEngineArchive({
        archivePath,
        asset: fakeAsset(Buffer.from(''), 'tar.gz'),
        targetDir: target,
      })).rejects.toMatchObject({ code: 'engine_extract_failed' });
      expect(await stat(target).catch(() => null)).toBeNull();
    }
  });

  it('zip 拒绝目录穿越与符号链接', async () => {
    const dir = await tempDir();
    const cases = [
      [{ name: '../evil', data: Buffer.from('x') }],
      [{ name: `${ROOT}link`, data: Buffer.from('../evil'), symlink: true }],
    ];
    for (const [index, entries] of cases.entries()) {
      const archive = zipArchive(entries as ZipFixtureEntry[]);
      const archivePath = join(dir, `bad-${index}.zip`);
      await writeFile(archivePath, archive);
      await expect(extractEngineArchive({
        archivePath,
        asset: fakeAsset(archive, 'zip'),
        targetDir: join(dir, `out-${index}`),
      })).rejects.toMatchObject({ code: 'engine_extract_failed' });
    }
  });

  it('归档缺少 binaryPath 时返回 engine_binary_missing', async () => {
    const dir = await tempDir();
    const archive = gzipSync(tarArchive([
      { name: ROOT, type: 'directory' },
      { name: `${ROOT}other`, data: Buffer.from('x') },
    ]));
    const archivePath = join(dir, 'missing.tar.gz');
    await writeFile(archivePath, archive);
    await expect(extractEngineArchive({
      archivePath,
      asset: fakeAsset(archive, 'tar.gz'),
      targetDir: join(dir, 'out'),
    })).rejects.toMatchObject({ code: 'engine_binary_missing' });
  });

  it('解压不继承归档 setuid/setgid 位', async () => {
    const dir = await tempDir();
    const target = join(dir, 'out');
    const archive = gzipSync(tarArchive([
      { name: ROOT, type: 'directory' },
      { name: BINARY, data: Buffer.from('binary'), mode: 0o4755 },
    ]));
    await extract(dir, target, archive);
    if (process.platform !== 'win32') {
      expect((await stat(join(target, BINARY))).mode & 0o6000).toBe(0);
    }
  });
});
