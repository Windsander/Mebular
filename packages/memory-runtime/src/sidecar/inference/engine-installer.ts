// llama.cpp 引擎资产安装器（0.3.0 / C8c）。
//
// 职责：
// - 只用 `inference/engine-assets.ts` 的官方 release 清单解析平台资产；
// - 下载归档到 `<dataDir>/inference/engine/.partial-*`，校验 size + sha256；
// - 先列出归档条目并拒绝绝对路径/`..`/空段/符号链接/硬链接，再解压到临时目录；
// - 确认 `binaryPath` 是预期普通文件后原子 rename 到最终目录；
// - 状态写入 `<dataDir>/inference/engine/state.json`（0600、原子写），公开视图不含路径；
// - 安装任务与模型安装任务分开建模，但模型安装流程可以调用 `ensureInstalled()`。
//
// 安全边界：
// - 不接受任意 URL：资产必须来自官方 `ggml-org/llama.cpp` release；
// - 归档内容是不可信输入，逐条目校验；失败清理临时目录，不留下半安装状态；
// - 公开 status 只返回 release/platform/arch/asset/binaryReady/reason 等非敏感字段。

import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { gunzipSync, inflateRawSync } from 'node:zlib';
import {
  llamaCppReleaseAssetUrl,
  resolveEngineAsset,
  type EngineAsset,
  type EngineAssetResolution,
} from '../../inference/engine-assets.js';
import type { FetchResponseLike, ModelStoreFetch } from '../../inference/store.js';
import {
  ensurePrivateDir,
  readJsonFile,
  writeJsonAtomic,
} from '../atomic-json.js';

export const ENGINE_INSTALL_SCHEMA = 1 as const;

export type EngineInstallPhase = 'downloading' | 'verifying' | 'extracting' | 'installing';
export type EngineInstallState = 'not_installed' | EngineInstallPhase | 'installed' | 'failed' | 'cancelled';

export type EngineInstallerErrorCode =
  | 'engine_asset_unsupported'
  | 'engine_download_failed'
  | 'engine_http_error'
  | 'engine_size_mismatch'
  | 'engine_checksum_mismatch'
  | 'engine_extract_failed'
  | 'engine_binary_missing'
  | 'engine_install_failed'
  | 'engine_storage_unavailable'
  | 'engine_install_in_progress'
  | 'cancelled';

export class EngineInstallerError extends Error {
  constructor(
    readonly code: EngineInstallerErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'EngineInstallerError';
  }
}

export interface EngineInstallProgress {
  phase: EngineInstallPhase;
  progress: number;
  downloadedBytes: number;
  totalBytes: number;
}

export interface EngineInstallOptions {
  signal?: AbortSignal;
  onProgress?: (progress: EngineInstallProgress) => void;
}

/** 公开引擎资产状态；不包含绝对路径、URL 或 token。 */
export interface EngineInstallerStatus {
  state: EngineInstallState;
  installed: boolean;
  release: string | null;
  platform: string;
  arch: string;
  asset: string | null;
  binaryReady: boolean;
  reason: string | null;
  progress: number;
  installedAt: number | null;
  verifiedAt: number | null;
  supported: boolean;
}

export interface EngineInstallerLike {
  init(): Promise<void>;
  status(): EngineInstallerStatus;
  ensureInstalled(options?: EngineInstallOptions): Promise<EngineInstallerStatus>;
  binaryPath(): string | null;
  remove(): Promise<{ removed: boolean }>;
  dispose(): Promise<void>;
}

export interface EngineArchiveExtractOptions {
  archivePath: string;
  asset: EngineAsset;
  targetDir: string;
  signal?: AbortSignal;
  /** 解压进度 0–1（按已写入条目数估算）。 */
  onProgress?: (progress: number) => void;
  /** 解压后允许的最大总字节；默认 512 MiB。 */
  maxUncompressedBytes?: number;
}

export type EngineArchiveExtractor = (options: EngineArchiveExtractOptions) => Promise<void>;

export interface EngineInstallerOptions {
  dataDir: string;
  platform?: string;
  arch?: string;
  fetch?: ModelStoreFetch;
  now?: () => number;
  nonce?: () => string;
  extractor?: EngineArchiveExtractor;
  maxUncompressedBytes?: number;
  /** 引擎归档下载失败的重试次数（含首次）；默认 2。 */
  maxDownloadAttempts?: number;
  /** 重试间隔；默认 500ms。 */
  retryDelayMs?: number;
  /**
   * 测试/嵌入注入点；默认只解析官方清单。即使注入，也仍然强制资产 URL
   * 由 `llamaCppReleaseAssetUrl()` 生成，不能指向任意主机。
   */
  resolveAsset?: (request: { platform?: string; arch?: string }) => EngineAssetResolution;
}

interface StoredEngineState {
  schema: typeof ENGINE_INSTALL_SCHEMA;
  release: string;
  platform: string;
  arch: string;
  asset: string;
  sha256: string;
  archiveType: 'tar.gz' | 'zip';
  /** 归档内相对路径（POSIX）；不是绝对路径。 */
  binaryPath: string;
  binaryReady: boolean;
  installedAt: number;
  verifiedAt: number;
}

interface TarEntry {
  path: string;
  type: 'file' | 'directory' | 'symlink' | 'hardlink' | 'other';
  data?: Buffer;
  /** 归档中的原始链接目标；symlink 使用。 */
  linkPath?: string;
  /** 校验后的链接目标（相对解压根目录的 POSIX 路径）。 */
  linkTarget?: string;
}

interface ZipEntry {
  path: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  data?: Buffer;
  linkPath?: string;
  linkTarget?: string;
}

const DEFAULT_MAX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;
const FULL_SHA256_RE = /^[a-f0-9]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (isAborted(signal)) {
    throw new EngineInstallerError('cancelled', 'engine install cancelled', true);
  }
}

function normalizeRelativePath(value: string): string | null {
  if (value.length === 0 || value.length > 1024) return null;
  if (value.includes('\0') || value.includes('\\')) return null;
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return null;
  const trimmed = value.endsWith('/') ? value.slice(0, -1) : value;
  if (trimmed.length === 0) return null;
  const parts = trimmed.split('/');
  // 允许 `./` 前缀/mid-segment（tar 常见），但仍拒绝空段与 `..` 逃逸。
  const normalized = parts.filter((part) => part !== '.');
  if (normalized.length === 0 || normalized.some((part) => part.length === 0 || part === '..')) return null;
  return normalized.join('/');
}

function underArchiveRoot(path: string, archiveRoot: string): boolean {
  const root = archiveRoot.endsWith('/') ? archiveRoot.slice(0, -1) : archiveRoot;
  return path === root || path.startsWith(`${root}/`);
}

/**
 * 校验 symlink 目标：
 * - 只允许相对目标；
 * - 目标按链接所在目录解析后必须仍在 archiveRoot 内；
 * - 拒绝绝对路径、反斜杠、NUL 与 `..` 逃逸。
 * 返回相对解压根目录的 POSIX 路径。
 */
function resolveSymlinkTarget(
  linkEntryPath: string,
  linkPath: string,
  archiveRoot: string,
): string | null {
  if (typeof linkPath !== 'string' || linkPath.length === 0 || linkPath.length > 1024) return null;
  if (linkPath.includes('\0') || linkPath.includes('\\')) return null;
  if (linkPath.startsWith('/') || /^[A-Za-z]:/.test(linkPath)) return null;
  const linkDir = linkEntryPath.includes('/')
    ? linkEntryPath.slice(0, linkEntryPath.lastIndexOf('/'))
    : '';
  const normalized = normalizeRelativePath(linkDir ? `${linkDir}/${linkPath}` : linkPath);
  if (!normalized || !underArchiveRoot(normalized, archiveRoot)) return null;
  return normalized;
}

function safeJoin(base: string, relative: string): string {
  return join(base, ...relative.split('/'));
}

function parseOctal(buffer: Buffer, offset: number, length: number): number {
  const text = buffer.subarray(offset, offset + length).toString('ascii').replace(/\0.*$/, '').trim();
  if (text.length === 0) return 0;
  if (!/^[0-7]+$/.test(text)) return Number.NaN;
  const value = Number.parseInt(text, 8);
  return Number.isSafeInteger(value) ? value : Number.NaN;
}

function cString(buffer: Buffer, offset: number, length: number): string {
  const slice = buffer.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8');
}

function parsePaxRecords(data: Buffer): Record<string, string> {
  const result: Record<string, string> = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number(data.subarray(offset, space).toString('ascii'));
    if (!Number.isSafeInteger(length) || length <= 0 || offset + length > data.length) break;
    const record = data.subarray(space + 1, offset + length).toString('utf8').replace(/\n$/, '');
    const equals = record.indexOf('=');
    if (equals > 0) result[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return result;
}

function entryType(typeFlag: string): TarEntry['type'] {
  if (typeFlag === '1') return 'hardlink';
  if (typeFlag === '2') return 'symlink';
  if (typeFlag === '5') return 'directory';
  if (typeFlag === '0' || typeFlag === '\0' || typeFlag === '7') return 'file';
  return 'other';
}

function parseTarEntries(buffer: Buffer, maxUncompressedBytes: number): TarEntry[] {
  if (buffer.length > maxUncompressedBytes) {
    throw new EngineInstallerError('engine_extract_failed', 'engine archive is too large');
  }
  const entries: TarEntry[] = [];
  let offset = 0;
  let pendingPax: Record<string, string> | null = null;
  let pendingLongName: string | null = null;
  let pendingLongLink: string | null = null;
  let totalBytes = 0;

  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const expectedChecksum = parseOctal(header, 148, 8);
    let actualChecksum = 0;
    for (let index = 0; index < 512; index += 1) {
      actualChecksum += index >= 148 && index < 156 ? 0x20 : header[index]!;
    }
    if (!Number.isFinite(expectedChecksum) || expectedChecksum !== actualChecksum) {
      throw new EngineInstallerError('engine_extract_failed', 'invalid tar header checksum');
    }

    const typeFlag = String.fromCharCode(header[156] ?? 0);
    const headerSize = parseOctal(header, 124, 12);
    if (!Number.isSafeInteger(headerSize) || headerSize < 0) {
      throw new EngineInstallerError('engine_extract_failed', 'invalid tar entry size');
    }
    const paxSize = pendingPax?.size ? Number(pendingPax.size) : undefined;
    const size = paxSize !== undefined && Number.isSafeInteger(paxSize) && paxSize >= 0 ? paxSize : headerSize;
    const dataOffset = offset + 512;
    const dataEnd = dataOffset + size;
    if (dataEnd > buffer.length) {
      throw new EngineInstallerError('engine_extract_failed', 'truncated tar entry');
    }
    const data = buffer.subarray(dataOffset, dataEnd);
    totalBytes += size;
    if (totalBytes > maxUncompressedBytes) {
      throw new EngineInstallerError('engine_extract_failed', 'engine archive expands beyond the size limit');
    }

    if (typeFlag === 'x' || typeFlag === 'g') {
      if (typeFlag === 'x') pendingPax = { ...(pendingPax ?? {}), ...parsePaxRecords(data) };
      offset = dataOffset + Math.ceil(size / 512) * 512;
      continue;
    }
    if (typeFlag === 'L') {
      pendingLongName = data.toString('utf8').replace(/\0.*$/, '');
      offset = dataOffset + Math.ceil(size / 512) * 512;
      continue;
    }
    if (typeFlag === 'K') {
      pendingLongLink = data.toString('utf8').replace(/\0.*$/, '');
      offset = dataOffset + Math.ceil(size / 512) * 512;
      continue;
    }

    const name = cString(header, 0, 100);
    const prefix = cString(header, 345, 155);
    const linkName = cString(header, 157, 100);
    const path = pendingPax?.path ?? pendingLongName ?? (prefix ? `${prefix}/${name}` : name);
    const linkPath = pendingPax?.linkpath ?? pendingLongLink ?? linkName;
    entries.push({
      path,
      type: entryType(typeFlag),
      ...(entryType(typeFlag) === 'file' ? { data } : {}),
      ...(linkPath ? { linkPath } : {}),
    });
    pendingPax = null;
    pendingLongName = null;
    pendingLongLink = null;
    offset = dataOffset + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function readUInt16(buffer: Buffer, offset: number): number {
  return buffer.readUInt16LE(offset);
}

function readUInt32(buffer: Buffer, offset: number): number {
  return buffer.readUInt32LE(offset);
}

function findZipEnd(buffer: Buffer): number {
  const minimum = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (readUInt32(buffer, offset) === 0x06054b50) return offset;
  }
  return -1;
}

function zipEntryType(name: string, externalAttributes: number): ZipEntry['type'] {
  const unixMode = (externalAttributes >>> 16) & 0xffff;
  const fileType = unixMode & 0o170000;
  if (fileType === 0o120000) return 'symlink';
  if (name.endsWith('/') || fileType === 0o040000) return 'directory';
  if (fileType !== 0 && fileType !== 0o100000) return 'other';
  return 'file';
}

function parseZipEntries(buffer: Buffer, maxUncompressedBytes: number): ZipEntry[] {
  const end = findZipEnd(buffer);
  if (end < 0) throw new EngineInstallerError('engine_extract_failed', 'invalid zip archive');
  const disk = readUInt16(buffer, end + 4);
  const centralDisk = readUInt16(buffer, end + 6);
  const count = readUInt16(buffer, end + 10);
  const centralSize = readUInt32(buffer, end + 12);
  const centralOffset = readUInt32(buffer, end + 16);
  if (disk !== 0 || centralDisk !== 0 || count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new EngineInstallerError('engine_extract_failed', 'multi-disk or zip64 archives are not supported');
  }
  if (centralOffset + centralSize > buffer.length) {
    throw new EngineInstallerError('engine_extract_failed', 'truncated zip central directory');
  }

  const entries: ZipEntry[] = [];
  let offset = centralOffset;
  let totalBytes = 0;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > buffer.length || readUInt32(buffer, offset) !== 0x02014b50) {
      throw new EngineInstallerError('engine_extract_failed', 'invalid zip central directory entry');
    }
    const flags = readUInt16(buffer, offset + 8);
    const method = readUInt16(buffer, offset + 10);
    const compressedSize = readUInt32(buffer, offset + 20);
    const uncompressedSize = readUInt32(buffer, offset + 24);
    const nameLength = readUInt16(buffer, offset + 28);
    const extraLength = readUInt16(buffer, offset + 30);
    const commentLength = readUInt16(buffer, offset + 32);
    const externalAttributes = readUInt32(buffer, offset + 38);
    const localOffset = readUInt32(buffer, offset + 42);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > buffer.length) {
      throw new EngineInstallerError('engine_extract_failed', 'truncated zip entry name');
    }
    const name = buffer.subarray(nameStart, nameEnd).toString('utf8');
    if ((flags & 0x1) !== 0) {
      throw new EngineInstallerError('engine_extract_failed', 'encrypted zip entries are not supported');
    }
    if (method !== 0 && method !== 8) {
      throw new EngineInstallerError('engine_extract_failed', 'unsupported zip compression method');
    }
    if (localOffset + 30 > buffer.length || readUInt32(buffer, localOffset) !== 0x04034b50) {
      throw new EngineInstallerError('engine_extract_failed', 'invalid zip local header');
    }
    const localNameLength = readUInt16(buffer, localOffset + 26);
    const localExtraLength = readUInt16(buffer, localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) {
      throw new EngineInstallerError('engine_extract_failed', 'truncated zip entry data');
    }
    totalBytes += uncompressedSize;
    if (totalBytes > maxUncompressedBytes) {
      throw new EngineInstallerError('engine_extract_failed', 'engine archive expands beyond the size limit');
    }
    const compressed = buffer.subarray(dataStart, dataEnd);
    let data: Buffer | undefined;
    if (method === 0) {
      data = compressed;
    } else {
      try {
        data = inflateRawSync(compressed, { maxOutputLength: Math.max(1, uncompressedSize + 1) });
      } catch {
        throw new EngineInstallerError('engine_extract_failed', 'cannot inflate zip entry');
      }
    }
    if (data.length !== uncompressedSize) {
      throw new EngineInstallerError('engine_extract_failed', 'zip entry size mismatch');
    }
    const type = zipEntryType(name, externalAttributes);
    entries.push({
      path: name,
      type,
      ...(type === 'file' ? { data } : {}),
    });
    offset = nameEnd + extraLength + commentLength;
  }
  return entries;
}

function validateArchiveEntries(
  entries: Array<TarEntry | ZipEntry>,
  asset: EngineAsset,
): Map<string, TarEntry | ZipEntry> {
  const map = new Map<string, TarEntry | ZipEntry>();
  const binaryPath = normalizeRelativePath(asset.binaryPath);
  if (!binaryPath || !underArchiveRoot(binaryPath, asset.archiveRoot)) {
    throw new EngineInstallerError('engine_extract_failed', 'invalid engine binary path in asset manifest');
  }
  for (const entry of entries) {
    const path = normalizeRelativePath(entry.path);
    if (!path || !underArchiveRoot(path, asset.archiveRoot)) {
      throw new EngineInstallerError('engine_extract_failed', 'unsafe archive entry path');
    }
    if (entry.type === 'hardlink') {
      throw new EngineInstallerError('engine_extract_failed', 'archive hardlinks are not allowed');
    }
    if (entry.type === 'symlink') {
      const linkTarget = resolveSymlinkTarget(path, entry.linkPath ?? '', asset.archiveRoot);
      if (!linkTarget || linkTarget === path) {
        throw new EngineInstallerError('engine_extract_failed', 'unsafe archive symlink target');
      }
      entry.linkTarget = linkTarget;
    } else if (entry.type === 'other') {
      throw new EngineInstallerError('engine_extract_failed', 'unsupported archive entry type');
    } else if (entry.linkPath) {
      throw new EngineInstallerError('engine_extract_failed', 'unexpected archive link target');
    }
    if (map.has(path)) {
      throw new EngineInstallerError('engine_extract_failed', 'duplicate archive entry');
    }
    map.set(path, entry);
  }
  // 允许官方归档中的相对 symlink 链（例如 libllama.dylib -> libllama.0.dylib
  // -> libllama.0.8.0.dylib），但最终必须落在同归档内的普通文件上，且不能成环。
  for (const entry of map.values()) {
    if (entry.type !== 'symlink') continue;
    const seen = new Set<string>([entry.path]);
    let current = entry;
    let finalTarget: string | null = null;
    for (;;) {
      const targetPath = current.linkTarget;
      if (!targetPath) {
        throw new EngineInstallerError('engine_extract_failed', 'archive symlink target is missing');
      }
      if (seen.has(targetPath)) {
        throw new EngineInstallerError('engine_extract_failed', 'archive symlink cycle');
      }
      seen.add(targetPath);
      const target = map.get(targetPath);
      if (!target) {
        throw new EngineInstallerError('engine_extract_failed', 'archive symlink target is missing');
      }
      if (target.type === 'file') {
        finalTarget = targetPath;
        break;
      }
      if (target.type !== 'symlink') {
        throw new EngineInstallerError('engine_extract_failed', 'archive symlink must target a regular file');
      }
      current = target;
    }
    // 保留原始 linkPath 用于创建 symlink；linkTarget 指向链末普通文件，供复制降级使用。
    entry.linkTarget = finalTarget;
  }
  const binary = map.get(binaryPath);
  if (!binary || binary.type !== 'file') {
    throw new EngineInstallerError('engine_binary_missing', 'engine binary is missing from the archive');
  }
  return map;
}

async function writeArchiveEntries(
  targetDir: string,
  entries: Map<string, TarEntry | ZipEntry>,
  signal?: AbortSignal,
  onProgress?: (progress: number) => void,
): Promise<void> {
  let index = 0;
  const total = Math.max(1, entries.size);
  const report = async (): Promise<void> => {
    index += 1;
    if (onProgress) {
      try {
        onProgress(index / total);
      } catch {
        // 进度回调不能反向破坏解压。
      }
    }
    if (index % 64 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
  };

  // 第一遍只写目录/普通文件，保证第二遍 symlink 的目标已经存在（Windows 复制降级需要）。
  for (const [path, entry] of entries) {
    throwIfAborted(signal);
    if (entry.type === 'symlink') continue;
    const target = safeJoin(targetDir, path);
    if (entry.type === 'directory') {
      await fs.mkdir(target, { recursive: true, mode: 0o700 });
    } else if (entry.type === 'file') {
      await fs.mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await fs.writeFile(target, entry.data!, { mode: 0o600, flag: 'wx' });
    } else {
      throw new EngineInstallerError('engine_extract_failed', 'unsupported archive entry type');
    }
    await report();
  }

  // 第二遍创建 symlink；受限文件系统/Windows 不支持时复制已校验的目标文件。
  for (const [path, entry] of entries) {
    throwIfAborted(signal);
    if (entry.type !== 'symlink') continue;
    const target = safeJoin(targetDir, path);
    await fs.mkdir(dirname(target), { recursive: true, mode: 0o700 });
    try {
      await fs.symlink(entry.linkPath!, target, 'file');
    } catch {
      if (!entry.linkTarget) {
        throw new EngineInstallerError('engine_extract_failed', 'archive symlink target is missing');
      }
      await fs.copyFile(safeJoin(targetDir, entry.linkTarget), target).catch(() => {
        throw new EngineInstallerError('engine_extract_failed', 'cannot materialize archive symlink');
      });
    }
    await report();
  }
}

/** 默认安全解压；测试可注入更小的 fake extractor。 */
export async function extractEngineArchive(options: EngineArchiveExtractOptions): Promise<void> {
  const maxUncompressedBytes = Math.max(1, options.maxUncompressedBytes ?? DEFAULT_MAX_UNCOMPRESSED_BYTES);
  throwIfAborted(options.signal);
  let raw: Buffer;
  try {
    raw = await fs.readFile(options.archivePath);
  } catch (error) {
    throw new EngineInstallerError('engine_extract_failed', `cannot read engine archive: ${messageOf(error)}`);
  }
  let entries: Array<TarEntry | ZipEntry>;
  if (options.asset.archiveType === 'zip') {
    entries = parseZipEntries(raw, maxUncompressedBytes);
  } else {
    let tar: Buffer;
    try {
      tar = gunzipSync(raw, { maxOutputLength: maxUncompressedBytes + 1 });
    } catch {
      throw new EngineInstallerError('engine_extract_failed', 'cannot gunzip engine archive');
    }
    entries = parseTarEntries(tar, maxUncompressedBytes);
  }
  const validated = validateArchiveEntries(entries, options.asset);
  await fs.mkdir(options.targetDir, { recursive: true, mode: 0o700 });
  await writeArchiveEntries(options.targetDir, validated, options.signal, options.onProgress);
}

function parseStoredState(value: unknown): StoredEngineState | null {
  if (!isRecord(value) || value.schema !== ENGINE_INSTALL_SCHEMA) return null;
  if (typeof value.release !== 'string'
    || typeof value.platform !== 'string'
    || typeof value.arch !== 'string'
    || typeof value.asset !== 'string'
    || typeof value.sha256 !== 'string'
    || !FULL_SHA256_RE.test(value.sha256)
    || (value.archiveType !== 'tar.gz' && value.archiveType !== 'zip')
    || typeof value.binaryPath !== 'string'
    || typeof value.binaryReady !== 'boolean'
    || typeof value.installedAt !== 'number'
    || typeof value.verifiedAt !== 'number') {
    return null;
  }
  const binaryPath = normalizeRelativePath(value.binaryPath);
  if (!binaryPath) return null;
  return {
    schema: ENGINE_INSTALL_SCHEMA,
    release: value.release,
    platform: value.platform,
    arch: value.arch,
    asset: value.asset,
    sha256: value.sha256,
    archiveType: value.archiveType,
    binaryPath,
    binaryReady: value.binaryReady,
    installedAt: value.installedAt,
    verifiedAt: value.verifiedAt,
  };
}

function defaultFetch(): ModelStoreFetch {
  return (url, init) => {
    const fetchFn = globalThis.fetch;
    if (typeof fetchFn !== 'function') {
      return Promise.reject(new EngineInstallerError('engine_download_failed', 'global fetch is unavailable', true));
    }
    return fetchFn(url, init) as unknown as Promise<FetchResponseLike>;
  };
}

function assetUrl(asset: EngineAsset): string {
  try {
    return llamaCppReleaseAssetUrl(asset.asset);
  } catch {
    throw new EngineInstallerError('engine_asset_unsupported', 'engine asset is not an official llama.cpp release asset');
  }
}

function validateResolvedAsset(asset: EngineAsset): void {
  if (assetUrl(asset) !== asset.url) {
    throw new EngineInstallerError('engine_asset_unsupported', 'engine asset URL is not the official release URL');
  }
  if (!Number.isSafeInteger(asset.sizeBytes) || asset.sizeBytes <= 0 || !FULL_SHA256_RE.test(asset.sha256)) {
    throw new EngineInstallerError('engine_asset_unsupported', 'engine asset metadata is invalid');
  }
  const binaryPath = normalizeRelativePath(asset.binaryPath);
  if (!binaryPath || !underArchiveRoot(binaryPath, asset.archiveRoot)) {
    throw new EngineInstallerError('engine_asset_unsupported', 'engine binary path is invalid');
  }
}

function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export class EngineInstaller implements EngineInstallerLike {
  readonly engineDir: string;
  readonly statePath: string;
  private readonly currentDir: string;
  private readonly resolution: EngineAssetResolution;
  private readonly fetchImpl: ModelStoreFetch;
  private readonly now: () => number;
  private readonly nonce: () => string;
  private readonly extractor: EngineArchiveExtractor;
  private readonly maxUncompressedBytes: number;
  private readonly maxDownloadAttempts: number;
  private readonly retryDelayMs: number;

  private statusValue: EngineInstallerStatus;
  private stored: StoredEngineState | null = null;
  private readyBinaryPath: string | null = null;
  private initialized = false;
  private task: Promise<EngineInstallerStatus> | null = null;
  private activeController: AbortController | null = null;

  constructor(options: EngineInstallerOptions) {
    if (!options.dataDir) throw new EngineInstallerError('engine_storage_unavailable', 'dataDir is required');
    this.engineDir = join(options.dataDir, 'inference', 'engine');
    this.statePath = join(this.engineDir, 'state.json');
    this.currentDir = join(this.engineDir, 'current');
    this.now = options.now ?? Date.now;
    this.nonce = options.nonce ?? (() => randomBytes(6).toString('hex'));
    this.fetchImpl = options.fetch ?? defaultFetch();
    this.extractor = options.extractor ?? extractEngineArchive;
    this.maxUncompressedBytes = Math.max(1, options.maxUncompressedBytes ?? DEFAULT_MAX_UNCOMPRESSED_BYTES);
    this.maxDownloadAttempts = Math.max(1, options.maxDownloadAttempts ?? 2);
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? 500);
    const resolve = options.resolveAsset ?? resolveEngineAsset;
    this.resolution = resolve({ platform: options.platform, arch: options.arch });
    if (this.resolution.ok) {
      try {
        validateResolvedAsset(this.resolution.asset);
      } catch {
        this.resolution = {
          ok: false,
          error: {
            code: 'engine_asset_unsupported',
            message: 'engine asset is not supported',
            platform: options.platform ?? process.platform,
            arch: options.arch ?? process.arch,
            supported: [],
          },
        };
      }
    }
    this.statusValue = this.initialStatus();
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await ensurePrivateDir(this.engineDir);
    this.initialized = true;
    await this.cleanupTemporaryDirectories().catch(() => undefined);
    const stored = parseStoredState(await readJsonFile<unknown>(this.statePath).catch(() => null));
    this.stored = stored;
    await this.verifyStoredInstallation().catch(() => false);
  }

  status(): EngineInstallerStatus {
    return { ...this.statusValue };
  }

  binaryPath(): string | null {
    return this.statusValue.installed && this.statusValue.binaryReady ? this.readyBinaryPath : null;
  }

  async ensureInstalled(options: EngineInstallOptions = {}): Promise<EngineInstallerStatus> {
    await this.init();
    if (await this.verifyStoredInstallation().catch(() => false)) {
      return this.status();
    }
    if (!this.resolution.ok) {
      const error = new EngineInstallerError(
        'engine_asset_unsupported',
        this.resolution.error.message,
      );
      this.statusValue = {
        ...this.statusValue,
        state: 'failed',
        installed: false,
        binaryReady: false,
        reason: error.code,
        progress: 0,
      };
      throw error;
    }
    if (this.task) return this.task;

    const controller = new AbortController();
    const external = options.signal;
    const onExternalAbort = (): void => controller.abort();
    if (external) {
      if (external.aborted) controller.abort();
      else external.addEventListener('abort', onExternalAbort, { once: true });
    }
    this.activeController = controller;
    const task = this.installInternal(this.resolution.asset, {
      signal: controller.signal,
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    }).finally(() => {
      this.task = null;
      this.activeController = null;
      external?.removeEventListener('abort', onExternalAbort);
    });
    this.task = task;
    return task;
  }

  async remove(): Promise<{ removed: boolean }> {
    if (this.task) {
      this.activeController?.abort();
      await this.task.catch(() => undefined);
    }
    const existing = await fs.stat(this.currentDir).catch(() => null);
    await fs.rm(this.currentDir, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(this.statePath, { force: true }).catch(() => undefined);
    await this.cleanupTemporaryDirectories().catch(() => undefined);
    this.stored = null;
    this.readyBinaryPath = null;
    this.statusValue = this.initialStatus();
    return { removed: existing !== null };
  }

  async dispose(): Promise<void> {
    if (this.task) {
      this.activeController?.abort();
      await this.task.catch(() => undefined);
    }
  }

  private initialStatus(): EngineInstallerStatus {
    if (!this.resolution.ok) {
      return {
        state: 'not_installed',
        installed: false,
        release: null,
        platform: this.resolution.error.platform,
        arch: this.resolution.error.arch,
        asset: null,
        binaryReady: false,
        reason: 'engine_asset_unsupported',
        progress: 0,
        installedAt: null,
        verifiedAt: null,
        supported: false,
      };
    }
    const asset = this.resolution.asset;
    return {
      state: 'not_installed',
      installed: false,
      release: asset.release,
      platform: asset.platform,
      arch: asset.arch,
      asset: asset.asset,
      binaryReady: false,
      reason: null,
      progress: 0,
      installedAt: null,
      verifiedAt: null,
      supported: true,
    };
  }

  private async verifyStoredInstallation(): Promise<boolean> {
    if (!this.resolution.ok) return false;
    const asset = this.resolution.asset;
    const stored = this.stored;
    if (!stored
      || !stored.binaryReady
      || stored.release !== asset.release
      || stored.platform !== asset.platform
      || stored.arch !== asset.arch
      || stored.asset !== asset.asset
      || stored.sha256 !== asset.sha256
      || stored.archiveType !== asset.archiveType
      || stored.binaryPath !== normalizeRelativePath(asset.binaryPath)) {
      if (this.statusValue.installed) this.statusValue = this.initialStatus();
      return false;
    }
    const binary = safeJoin(this.currentDir, stored.binaryPath);
    const info = await fs.stat(binary).catch(() => null);
    if (!info?.isFile() || info.size <= 0) {
      this.stored = null;
      this.readyBinaryPath = null;
      this.statusValue = {
        ...this.initialStatus(),
        state: 'not_installed',
        reason: 'engine_binary_missing',
      };
      return false;
    }
    if (asset.platform !== 'win32') {
      await fs.chmod(binary, 0o755).catch(() => undefined);
    }
    this.readyBinaryPath = binary;
    this.statusValue = {
      state: 'installed',
      installed: true,
      release: asset.release,
      platform: asset.platform,
      arch: asset.arch,
      asset: asset.asset,
      binaryReady: true,
      reason: null,
      progress: 1,
      installedAt: stored.installedAt,
      verifiedAt: stored.verifiedAt,
      supported: true,
    };
    return true;
  }

  private async installInternal(asset: EngineAsset, options: EngineInstallOptions): Promise<EngineInstallerStatus> {
    const signal = options.signal;
    const nonce = this.nonce().replace(/[^A-Za-z0-9._-]/g, '-') || 'engine';
    const partialDir = join(this.engineDir, `.partial-${nonce}`);
    const extractDir = join(this.engineDir, `.extract-${nonce}`);
    const archivePath = join(partialDir, asset.asset);
    const previous = this.status();
    try {
      await ensurePrivateDir(this.engineDir);
      await ensurePrivateDir(partialDir);
      throwIfAborted(signal);

      this.publish(options, {
        phase: 'downloading',
        progress: 0,
        downloadedBytes: 0,
        totalBytes: asset.sizeBytes,
      });
      await this.download(asset, archivePath, options);

      this.publish(options, {
        phase: 'verifying',
        progress: 1,
        downloadedBytes: asset.sizeBytes,
        totalBytes: asset.sizeBytes,
      });
      await this.verifyArchive(asset, archivePath, signal);

      this.publish(options, {
        phase: 'extracting',
        progress: 0,
        downloadedBytes: asset.sizeBytes,
        totalBytes: asset.sizeBytes,
      });
      await fs.rm(extractDir, { recursive: true, force: true }).catch(() => undefined);
      await ensurePrivateDir(extractDir);
      await this.extractor({
        archivePath,
        asset,
        targetDir: extractDir,
        ...(signal ? { signal } : {}),
        maxUncompressedBytes: this.maxUncompressedBytes,
        onProgress: (progress) => this.publish(options, {
          phase: 'extracting',
          progress,
          downloadedBytes: asset.sizeBytes,
          totalBytes: asset.sizeBytes,
        }),
      });
      throwIfAborted(signal);

      const extractedBinary = safeJoin(extractDir, normalizeRelativePath(asset.binaryPath)!);
      const extractedInfo = await fs.stat(extractedBinary).catch(() => null);
      if (!extractedInfo?.isFile() || extractedInfo.size <= 0) {
        throw new EngineInstallerError('engine_binary_missing', 'engine binary is missing after extraction');
      }

      this.publish(options, {
        phase: 'installing',
        progress: 1,
        downloadedBytes: asset.sizeBytes,
        totalBytes: asset.sizeBytes,
      });
      const installedAt = this.now();
      const stored: StoredEngineState = {
        schema: ENGINE_INSTALL_SCHEMA,
        release: asset.release,
        platform: asset.platform,
        arch: asset.arch,
        asset: asset.asset,
        sha256: asset.sha256,
        archiveType: asset.archiveType,
        binaryPath: normalizeRelativePath(asset.binaryPath)!,
        binaryReady: true,
        installedAt,
        verifiedAt: installedAt,
      };
      await this.commit(extractDir, stored);
      this.stored = stored;
      this.readyBinaryPath = safeJoin(this.currentDir, stored.binaryPath);
      this.statusValue = {
        state: 'installed',
        installed: true,
        release: asset.release,
        platform: asset.platform,
        arch: asset.arch,
        asset: asset.asset,
        binaryReady: true,
        reason: null,
        progress: 1,
        installedAt,
        verifiedAt: installedAt,
        supported: true,
      };
      return this.status();
    } catch (error) {
      const failure = error instanceof EngineInstallerError
        ? error
        : new EngineInstallerError('engine_install_failed', messageOf(error), true);
      const cancelled = failure.code === 'cancelled' || isAborted(signal);
      const restored = !cancelled && previous.installed
        ? await this.verifyStoredInstallation().catch(() => false)
        : false;
      if (!restored) {
        this.readyBinaryPath = null;
        this.statusValue = {
          ...this.initialStatus(),
          state: cancelled ? 'cancelled' : 'failed',
          installed: false,
          binaryReady: false,
          reason: cancelled ? 'cancelled' : failure.code,
          progress: 0,
        };
      }
      throw cancelled
        ? new EngineInstallerError('cancelled', 'engine install cancelled', true)
        : failure;
    } finally {
      await fs.rm(partialDir, { recursive: true, force: true }).catch(() => undefined);
      await fs.rm(extractDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private publish(options: EngineInstallOptions, progress: EngineInstallProgress): void {
    this.statusValue = {
      ...this.statusValue,
      state: progress.phase,
      installed: false,
      binaryReady: false,
      reason: null,
      progress: clampProgress(progress.progress),
    };
    if (!options.onProgress) return;
    try {
      options.onProgress({ ...progress });
    } catch {
      // 进度回调不能反向破坏安装。
    }
  }

  private async download(asset: EngineAsset, targetPath: string, options: EngineInstallOptions): Promise<void> {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= this.maxDownloadAttempts; attempt += 1) {
      throwIfAborted(options.signal);
      try {
        await this.downloadOnce(asset, targetPath, options);
        return;
      } catch (error) {
        lastError = error;
        if (isAborted(options.signal) || !(error instanceof EngineInstallerError) || !error.retryable) {
          throw error;
        }
        if (error.code === 'engine_checksum_mismatch' || error.code === 'engine_size_mismatch') {
          throw error;
        }
        if (attempt < this.maxDownloadAttempts) {
          await new Promise<void>((resolve) => setTimeout(resolve, this.retryDelayMs));
        }
      }
    }
    throw lastError instanceof EngineInstallerError
      ? lastError
      : new EngineInstallerError('engine_download_failed', messageOf(lastError), true);
  }

  private async downloadOnce(asset: EngineAsset, targetPath: string, options: EngineInstallOptions): Promise<void> {
    throwIfAborted(options.signal);
    let response: FetchResponseLike;
    try {
      response = await this.fetchImpl(asset.url, {
        headers: { Accept: 'application/octet-stream', 'User-Agent': 'mebular-memory-runtime' },
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      if (isAborted(options.signal)) {
        throw new EngineInstallerError('cancelled', 'engine install cancelled', true);
      }
      throw new EngineInstallerError('engine_download_failed', `engine download failed: ${messageOf(error)}`, true);
    }
    throwIfAborted(options.signal);
    if (!response.ok) {
      throw new EngineInstallerError('engine_http_error', `engine download failed with HTTP ${response.status}`, true);
    }

    const hash = createHash('sha256');
    const handle = await fs.open(targetPath, 'w', 0o600);
    let written = 0;
    try {
      if (response.body) {
        for await (const chunk of response.body) {
          throwIfAborted(options.signal);
          if (!(chunk instanceof Uint8Array)) {
            throw new EngineInstallerError('engine_download_failed', 'engine response yielded a non-byte chunk', true);
          }
          if (written + chunk.byteLength > asset.sizeBytes) {
            throw new EngineInstallerError('engine_size_mismatch', 'engine archive is larger than expected');
          }
          hash.update(chunk);
          await handle.write(chunk);
          written += chunk.byteLength;
          this.publish(options, {
            phase: 'downloading',
            progress: written / asset.sizeBytes,
            downloadedBytes: written,
            totalBytes: asset.sizeBytes,
          });
        }
      }
    } catch (error) {
      if (isAborted(options.signal)) {
        throw new EngineInstallerError('cancelled', 'engine install cancelled', true);
      }
      throw error instanceof EngineInstallerError
        ? error
        : new EngineInstallerError('engine_download_failed', messageOf(error), true);
    } finally {
      await handle.close().catch(() => undefined);
    }
    throwIfAborted(options.signal);
    if (written !== asset.sizeBytes) {
      throw new EngineInstallerError('engine_size_mismatch', 'engine archive size mismatch');
    }
    if (hash.digest('hex') !== asset.sha256) {
      throw new EngineInstallerError('engine_checksum_mismatch', 'engine archive sha256 mismatch');
    }
  }

  private async verifyArchive(asset: EngineAsset, archivePath: string, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const info = await fs.stat(archivePath).catch(() => null);
    if (!info?.isFile() || info.size !== asset.sizeBytes) {
      throw new EngineInstallerError('engine_size_mismatch', 'engine archive size mismatch');
    }
    const hash = createHash('sha256');
    const handle = await fs.open(archivePath, 'r');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    try {
      for (;;) {
        throwIfAborted(signal);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (bytesRead <= 0) break;
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
    if (position !== asset.sizeBytes) {
      throw new EngineInstallerError('engine_size_mismatch', 'engine archive size mismatch');
    }
    if (hash.digest('hex') !== asset.sha256) {
      throw new EngineInstallerError('engine_checksum_mismatch', 'engine archive sha256 mismatch');
    }
  }

  private async commit(extractDir: string, stored: StoredEngineState): Promise<void> {
    const backupDir = join(this.engineDir, `.backup-${this.nonce().replace(/[^A-Za-z0-9._-]/g, '-') || 'engine'}`);
    const existing = await fs.stat(this.currentDir).catch(() => null);
    let movedBackup = false;
    if (existing) {
      await fs.rename(this.currentDir, backupDir);
      movedBackup = true;
    }
    try {
      await fs.rename(extractDir, this.currentDir);
      const binary = safeJoin(this.currentDir, stored.binaryPath);
      const info = await fs.stat(binary).catch(() => null);
      if (!info?.isFile() || info.size <= 0) {
        throw new EngineInstallerError('engine_binary_missing', 'engine binary is missing after installation');
      }
      if (stored.platform !== 'win32') {
        await fs.chmod(binary, 0o755).catch(() => {
          throw new EngineInstallerError('engine_storage_unavailable', 'cannot mark engine binary executable', true);
        });
      }
      await writeJsonAtomic(this.statePath, stored);
    } catch (error) {
      await fs.rm(this.currentDir, { recursive: true, force: true }).catch(() => undefined);
      if (movedBackup) {
        await fs.rename(backupDir, this.currentDir).catch(() => undefined);
      }
      throw error instanceof EngineInstallerError
        ? error
        : new EngineInstallerError('engine_storage_unavailable', messageOf(error), true);
    }
    if (movedBackup) {
      await fs.rm(backupDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async cleanupTemporaryDirectories(): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.engineDir);
    } catch {
      return;
    }
    let hasCurrent = (await fs.stat(this.currentDir).catch(() => null)) !== null;
    for (const entry of entries) {
      const path = join(this.engineDir, entry);
      if (entry.startsWith('.backup-')) {
        // 崩溃发生在 rename(current → backup) 之后：恢复旧安装，绝不删除唯一副本。
        if (!hasCurrent) {
          const restored = await fs.rename(path, this.currentDir).then(() => true).catch(() => false);
          if (restored) {
            hasCurrent = true;
            continue;
          }
        }
        await fs.rm(path, { recursive: true, force: true }).catch(() => undefined);
        continue;
      }
      if (entry.startsWith('.partial-') || entry.startsWith('.extract-')) {
        await fs.rm(path, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }
}
