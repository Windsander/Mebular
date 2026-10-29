// 本地模型包存储：断点下载、镜像回退、流式 SHA256、原子安装、离线导入、卸载。
//
// 设计原则：
// - fetch / fs / clock / nonce 都可注入，测试不碰真实网络，也不下载真实大文件；
// - 下载先写 `<root>/.partial/<pack>/...`，校验通过后才移动到 `.staging`，
//   最后用 rename 原子提交；force 覆盖时先备份旧目录，失败会回滚；
// - 断点续传使用 Range + If-Range（ETag 优先，否则 Last-Modified）；
// - 下载过程中增量计算 sha256；恢复时先把已有 partial 重新流式哈希，再继续；
// - 所有 manifest 文件路径都经过目录穿越检查。

import { createHash, randomBytes } from 'node:crypto';
import { promises as fsPromises } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  ModelManifestError,
  modelManifestTotalBytes,
  parseModelManifest,
  type ModelFile,
  type ModelManifest,
  type ModelStatus,
} from './types.js';

export interface FetchResponseHeaders {
  get(name: string): string | null;
}

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  headers: FetchResponseHeaders;
  body: AsyncIterable<Uint8Array> | null;
}

export interface FetchInitLike {
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export type ModelStoreFetch = (url: string, init?: FetchInitLike) => Promise<FetchResponseLike>;

export interface ModelStoreFileStat {
  size: number;
  isFile: boolean;
  isDirectory: boolean;
}

export interface ModelStoreWriter {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export interface ModelStoreReader {
  read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

export interface ModelStoreFs {
  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void>;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  writeFile(path: string, data: string | Uint8Array, options?: { mode?: number }): Promise<void>;
  stat(path: string): Promise<ModelStoreFileStat>;
  openWrite(path: string, options?: { append?: boolean; mode?: number }): Promise<ModelStoreWriter>;
  openRead(path: string): Promise<ModelStoreReader>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  readdir(path: string): Promise<string[]>;
}

/** 默认 Node 文件系统适配器；测试可以包装它来注入失败。 */
export function createNodeModelStoreFs(): ModelStoreFs {
  return {
    async mkdir(path, options = {}) {
      await fsPromises.mkdir(path, {
        recursive: options.recursive ?? true,
        ...(options.mode !== undefined ? { mode: options.mode } : {}),
      });
    },
    async readFile(path, encoding) {
      return fsPromises.readFile(path, encoding);
    },
    async writeFile(path, data, options = {}) {
      await fsPromises.writeFile(path, data, options.mode !== undefined ? { mode: options.mode } : {});
    },
    async stat(path) {
      const stat = await fsPromises.stat(path);
      return { size: stat.size, isFile: stat.isFile(), isDirectory: stat.isDirectory() };
    },
    async openWrite(path, options = {}) {
      const handle = await fsPromises.open(path, options.append ? 'a' : 'w', options.mode ?? 0o600);
      return {
        async write(chunk) {
          await handle.write(chunk);
        },
        async close() {
          await handle.close();
        },
      };
    },
    async openRead(path) {
      const handle = await fsPromises.open(path, 'r');
      return {
        async read(buffer, offset, length, position) {
          const result = await handle.read(buffer, offset, length, position);
          return { bytesRead: result.bytesRead };
        },
        async close() {
          await handle.close();
        },
      };
    },
    async rename(from, to) {
      await fsPromises.rename(from, to);
    },
    async rm(path, options = {}) {
      await fsPromises.rm(path, {
        recursive: options.recursive ?? true,
        force: options.force ?? true,
      });
    },
    async readdir(path) {
      return fsPromises.readdir(path);
    },
  };
}

export type ModelStoreErrorCode =
  | 'invalid_manifest'
  | 'unsafe_path'
  | 'no_source'
  | 'download_failed'
  | 'http_error'
  | 'checksum_mismatch'
  | 'size_mismatch'
  | 'install_exists'
  | 'not_installed'
  | 'manifest_missing'
  | 'manifest_mismatch'
  | 'import_failed'
  | 'cancelled';

export class ModelStoreError extends Error {
  constructor(
    readonly code: ModelStoreErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ModelStoreError';
  }
}

export type DownloadFileState = 'pending' | 'downloading' | 'verifying' | 'complete' | 'failed';
export type DownloadState = 'idle' | 'downloading' | 'verifying' | 'installing' | 'installed' | 'failed' | 'cancelled';

export interface ModelDownloadFileStatus {
  path: string;
  sizeBytes: number;
  sha256: string;
  state: DownloadFileState;
  downloadedBytes: number;
  resumedFrom: number;
  errorCode?: string;
}

export interface ModelDownloadStatus {
  packId: string;
  modelId: string;
  state: DownloadState;
  files: ModelDownloadFileStatus[];
  downloadedBytes: number;
  totalBytes: number;
  startedAt: number;
  updatedAt: number;
  installedPath?: string;
  error?: { code: string; message: string };
}

export interface ModelInstallFileResult {
  path: string;
  sizeBytes: number;
  sha256: string;
  resumedFrom: number;
}

export interface ModelInstallResult {
  packId: string;
  modelId: string;
  path: string;
  manifest: ModelManifest;
  installedBytes: number;
  resumedBytes: number;
  files: ModelInstallFileResult[];
}

export interface ModelVerifyFileResult {
  path: string;
  ok: boolean;
  sizeBytes: number;
  expectedSha256: string;
  actualSha256?: string;
  error?: string;
}

export interface ModelVerifyResult {
  packId: string;
  ok: boolean;
  path: string;
  checkedAt: number;
  files: ModelVerifyFileResult[];
  errors: string[];
}

export interface ModelStoreOptions {
  rootDir: string;
  fs?: ModelStoreFs;
  fetch?: ModelStoreFetch;
  now?: () => number;
  /** staging/backup 后缀；默认随机。 */
  nonce?: () => string;
  /** 每个镜像最多尝试几轮；默认 1 轮，轮内按镜像顺序回退。 */
  maxAttemptsPerMirror?: number;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface DownloadModelOptions {
  /** 镜像 base URL（不含文件名），或按文件返回 base URLs 的函数。 */
  mirrors?: string[] | ((file: ModelFile, manifest: ModelManifest) => string[]);
  /** 是否使用 manifest 中显式 file.url / file.mirrors；默认 true。 */
  useManifestUrls?: boolean;
  force?: boolean;
  signal?: AbortSignal;
  onStatus?: (status: ModelDownloadStatus) => void;
}

export interface ImportModelOptions {
  sourceDir: string;
  manifest?: ModelManifest | unknown;
  packId?: string;
  force?: boolean;
  onStatus?: (status: ModelDownloadStatus) => void;
}

interface PartialMeta {
  etag?: string;
  lastModified?: string;
  totalBytes?: number;
  source?: string;
  expectedSha256: string;
}

const PACK_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (isAborted(signal)) {
    throw new ModelStoreError('cancelled', 'download cancelled');
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'ENOENT' || code === 'ENOTDIR' || /ENOENT|not found/i.test(messageOf(error));
}

function headerOf(response: FetchResponseLike, name: string): string | null {
  return response.headers.get(name.toLowerCase()) ?? response.headers.get(name);
}

function safeJoin(base: string, relative: string): string {
  if (
    relative.length === 0
    || relative.startsWith('/')
    || relative.startsWith('\\')
    || /^[A-Za-z]:/.test(relative)
    || relative.includes('\\')
    || relative.includes('\0')
  ) {
    throw new ModelStoreError('unsafe_path', `unsafe model file path: ${relative}`);
  }
  const parts = relative.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
    throw new ModelStoreError('unsafe_path', `unsafe model file path: ${relative}`);
  }
  return join(base, ...parts);
}

function assertPackId(packId: string): string {
  if (!PACK_ID_RE.test(packId)) {
    throw new ModelStoreError('unsafe_path', `invalid pack id: ${packId}`);
  }
  return packId;
}

function encodePath(relative: string): string {
  return relative.split('/').map((part) => encodeURIComponent(part)).join('/');
}

function mirrorUrl(base: string, relative: string): string | null {
  try {
    const parsed = new URL(base.endsWith('/') ? base : `${base}/`);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return new URL(encodePath(relative), parsed).toString();
  } catch {
    return null;
  }
}

function parseContentRange(value: string | null): { start: number; end: number; total?: number } | null {
  if (!value) return null;
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(value.trim());
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = match[3] === '*' ? undefined : Number(match[3]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return null;
  return { start, end, ...(total !== undefined ? { total } : {}) };
}

function sumDownloaded(files: ModelDownloadFileStatus[]): number {
  return files.reduce((sum, file) => sum + file.downloadedBytes, 0);
}

function cloneStatus(status: ModelDownloadStatus): ModelDownloadStatus {
  return structuredClone(status);
}

/**
 * 本地模型包管理器。默认根目录通常为 `<home>/runtime/models`。
 */
export class ModelStore {
  readonly rootDir: string;
  private readonly io: ModelStoreFs;
  private readonly fetchImpl: ModelStoreFetch;
  private readonly now: () => number;
  private readonly nonce: () => string;
  private readonly maxAttemptsPerMirror: number;
  private readonly retryDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly statuses = new Map<string, ModelDownloadStatus>();

  constructor(options: ModelStoreOptions) {
    if (!options.rootDir) throw new ModelStoreError('unsafe_path', 'rootDir is required');
    this.rootDir = options.rootDir;
    this.io = options.fs ?? createNodeModelStoreFs();
    this.fetchImpl = options.fetch ?? ((url, init) => {
      const fetchFn = globalThis.fetch;
      if (typeof fetchFn !== 'function') {
        return Promise.reject(new ModelStoreError('download_failed', 'global fetch is unavailable'));
      }
      return fetchFn(url, init) as unknown as Promise<FetchResponseLike>;
    });
    this.now = options.now ?? Date.now;
    this.nonce = options.nonce ?? (() => randomBytes(6).toString('hex'));
    this.maxAttemptsPerMirror = Math.max(1, options.maxAttemptsPerMirror ?? 1);
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? 0);
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  packPath(packId: string): string {
    return join(this.rootDir, assertPackId(packId));
  }

  private partialDir(packId: string): string {
    return join(this.rootDir, '.partial', assertPackId(packId));
  }

  private stagingRoot(): string {
    return join(this.rootDir, '.staging');
  }

  private safeNonce(): string {
    const value = this.nonce().replace(/[^A-Za-z0-9._-]/g, '-');
    return value.length > 0 ? value : 'stage';
  }

  getDownloadStatus(packId: string): ModelDownloadStatus | undefined {
    const status = this.statuses.get(packId);
    return status ? cloneStatus(status) : undefined;
  }

  async getModelStatus(packId: string): Promise<ModelStatus> {
    const active = this.statuses.get(packId);
    if (active && (active.state === 'downloading' || active.state === 'verifying' || active.state === 'installing')) {
      return {
        packId,
        modelId: active.modelId,
        state: active.state === 'downloading' ? 'downloading' : 'verifying',
        expectedBytes: active.totalBytes,
        installedBytes: active.downloadedBytes,
        ...(active.installedPath ? { installedPath: active.installedPath } : {}),
      };
    }

    const path = this.packPath(packId);
    try {
      const manifest = await this.readInstalledManifest(path);
      return {
        packId,
        modelId: manifest.modelId,
        state: 'installed',
        installedPath: path,
        installedBytes: modelManifestTotalBytes(manifest),
        expectedBytes: modelManifestTotalBytes(manifest),
        verifiedAt: this.now(),
      };
    } catch (error) {
      if (active?.state === 'failed') {
        return {
          packId,
          modelId: active.modelId,
          state: 'failed',
          expectedBytes: active.totalBytes,
          installedBytes: active.downloadedBytes,
          message: active.error?.message,
          errorCode: active.error?.code,
        };
      }
      if (error instanceof ModelStoreError && error.code === 'not_installed') {
        return {
          packId,
          modelId: active?.modelId ?? packId,
          state: 'not_installed',
        };
      }
      if (!isMissing(error)) {
        return {
          packId,
          modelId: active?.modelId ?? packId,
          state: 'corrupt',
          message: messageOf(error),
          ...(active?.error?.code ? { errorCode: active.error.code } : {}),
        };
      }
      return {
        packId,
        modelId: active?.modelId ?? packId,
        state: 'not_installed',
      };
    }
  }

  private async readInstalledManifest(packDir: string): Promise<ModelManifest> {
    let raw: string;
    try {
      raw = await this.io.readFile(join(packDir, 'manifest.json'), 'utf8');
    } catch (error) {
      if (isMissing(error)) {
        throw new ModelStoreError('not_installed', `model pack is not installed: ${packDir}`);
      }
      throw error;
    }
    try {
      return parseModelManifest(JSON.parse(raw));
    } catch (error) {
      if (error instanceof ModelManifestError) {
        throw new ModelStoreError('invalid_manifest', error.message, { errors: error.errors });
      }
      throw new ModelStoreError('invalid_manifest', `cannot parse installed manifest: ${messageOf(error)}`);
    }
  }

  private emit(status: ModelDownloadStatus, listener?: (value: ModelDownloadStatus) => void): void {
    status.updatedAt = this.now();
    status.downloadedBytes = sumDownloaded(status.files);
    this.statuses.set(status.packId, status);
    if (listener) {
      try {
        listener(cloneStatus(status));
      } catch {
        // 进度回调不能反向破坏下载。
      }
    }
  }

  private initialStatus(manifest: ModelManifest): ModelDownloadStatus {
    const now = this.now();
    return {
      packId: manifest.packId,
      modelId: manifest.modelId,
      state: 'downloading',
      files: manifest.files.map((file) => ({
        path: file.path,
        sizeBytes: file.sizeBytes,
        sha256: file.sha256,
        state: 'pending',
        downloadedBytes: 0,
        resumedFrom: 0,
      })),
      downloadedBytes: 0,
      totalBytes: modelManifestTotalBytes(manifest),
      startedAt: now,
      updatedAt: now,
    };
  }

  private failStatus(
    status: ModelDownloadStatus,
    error: unknown,
    listener?: (value: ModelDownloadStatus) => void,
  ): void {
    const code = error instanceof ModelStoreError ? error.code : 'download_failed';
    status.state = code === 'cancelled' ? 'cancelled' : 'failed';
    status.error = { code, message: messageOf(error) };
    this.emit(status, listener);
  }

  private async statOrNull(path: string): Promise<ModelStoreFileStat | null> {
    try {
      return await this.io.stat(path);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  private async removeQuietly(path: string): Promise<void> {
    try {
      await this.io.rm(path, { recursive: true, force: true });
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  private async readPartialMeta(path: string): Promise<PartialMeta | undefined> {
    try {
      const raw = await this.io.readFile(path, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return undefined;
      const meta = parsed as Record<string, unknown>;
      return {
        ...(typeof meta.etag === 'string' ? { etag: meta.etag } : {}),
        ...(typeof meta.lastModified === 'string' ? { lastModified: meta.lastModified } : {}),
        ...(typeof meta.totalBytes === 'number' ? { totalBytes: meta.totalBytes } : {}),
        ...(typeof meta.source === 'string' ? { source: meta.source } : {}),
        expectedSha256: typeof meta.expectedSha256 === 'string' ? meta.expectedSha256 : '',
      };
    } catch (error) {
      if (isMissing(error)) return undefined;
      return undefined;
    }
  }

  private async writePartialMeta(path: string, meta: PartialMeta): Promise<void> {
    await this.io.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await this.io.writeFile(path, `${JSON.stringify(meta)}\n`, { mode: 0o600 });
  }

  private async hashPath(path: string, hash: ReturnType<typeof createHash>, maxBytes?: number): Promise<number> {
    const reader = await this.io.openRead(path);
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    try {
      for (;;) {
        const { bytesRead } = await reader.read(buffer, 0, buffer.length, position);
        if (bytesRead <= 0) break;
        position += bytesRead;
        if (maxBytes !== undefined && position > maxBytes) {
          throw new ModelStoreError('size_mismatch', `partial file is larger than expected: ${path}`);
        }
        hash.update(buffer.subarray(0, bytesRead));
      }
      return position;
    } finally {
      await reader.close();
    }
  }

  private async digestOf(path: string): Promise<{ sha256: string; sizeBytes: number }> {
    const hash = createHash('sha256');
    const sizeBytes = await this.hashPath(path, hash);
    return { sha256: hash.digest('hex'), sizeBytes };
  }

  private resolveSources(
    manifest: ModelManifest,
    file: ModelFile,
    options: DownloadModelOptions,
  ): string[] {
    const urls: string[] = [];
    if (options.useManifestUrls !== false) {
      if (file.url) urls.push(file.url);
      if (file.mirrors) urls.push(...file.mirrors);
    }
    const mirrors = typeof options.mirrors === 'function'
      ? options.mirrors(file, manifest)
      : options.mirrors;
    if (mirrors) {
      for (const base of mirrors) {
        const resolved = mirrorUrl(base, file.path);
        if (resolved) urls.push(resolved);
      }
    }
    return [...new Set(urls)];
  }

  private async checkCompletePartial(file: ModelFile, partialPath: string): Promise<boolean> {
    const stat = await this.statOrNull(partialPath);
    if (!stat || !stat.isFile || stat.size !== file.sizeBytes) return false;
    const digest = await this.digestOf(partialPath);
    return digest.sha256 === file.sha256.toLowerCase();
  }

  private async downloadFile(
    manifest: ModelManifest,
    file: ModelFile,
    options: DownloadModelOptions,
    fileStatus: ModelDownloadFileStatus,
    progress: () => void,
  ): Promise<{ resumedFrom: number }> {
    throwIfAborted(options.signal);
    const sources = this.resolveSources(manifest, file, options);
    if (sources.length === 0) {
      throw new ModelStoreError('no_source', `no download source for ${file.path}`);
    }

    const partialPath = safeJoin(this.partialDir(manifest.packId), file.path);
    const metaPath = `${partialPath}.meta.json`;
    await this.io.mkdir(dirname(partialPath), { recursive: true, mode: 0o700 });

    let lastError: unknown;
    for (let attempt = 0; attempt < this.maxAttemptsPerMirror; attempt += 1) {
      for (const source of sources) {
        throwIfAborted(options.signal);
        try {
          const result = await this.downloadFromSource(
            manifest,
            file,
            source,
            partialPath,
            metaPath,
            fileStatus,
            options.signal,
            progress,
          );
          return result;
        } catch (error) {
          if (error instanceof ModelStoreError && error.code === 'cancelled') throw error;
          lastError = error;
          fileStatus.errorCode = error instanceof ModelStoreError ? error.code : 'download_failed';
          // 校验失败时清掉 partial，换镜像/重试必须从头开始。
          if (error instanceof ModelStoreError && error.code === 'checksum_mismatch') {
            await this.removeQuietly(partialPath);
            await this.removeQuietly(metaPath);
          }
          if (isAborted(options.signal)) {
            throw new ModelStoreError('cancelled', 'download cancelled');
          }
        }
      }
      if (attempt + 1 < this.maxAttemptsPerMirror && this.retryDelayMs > 0) {
        await this.sleep(this.retryDelayMs);
      }
    }
    if (lastError instanceof ModelStoreError) throw lastError;
    throw new ModelStoreError('download_failed', messageOf(lastError));
  }

  private async downloadFromSource(
    manifest: ModelManifest,
    file: ModelFile,
    source: string,
    partialPath: string,
    metaPath: string,
    fileStatus: ModelDownloadFileStatus,
    signal: AbortSignal | undefined,
    progress: () => void,
  ): Promise<{ resumedFrom: number }> {
    let restartCount = 0;
    for (;;) {
      throwIfAborted(signal);
      const existingStat = await this.statOrNull(partialPath);
      let existingBytes = existingStat?.isFile ? existingStat.size : 0;
      if (existingBytes > file.sizeBytes) {
        await this.removeQuietly(partialPath);
        await this.removeQuietly(metaPath);
        throw new ModelStoreError('size_mismatch', `partial file is larger than expected: ${file.path}`);
      }

      let meta = existingBytes > 0 ? await this.readPartialMeta(metaPath) : undefined;
      if (
        existingBytes > 0
        && meta?.expectedSha256
        && meta.expectedSha256.toLowerCase() !== file.sha256.toLowerCase()
      ) {
        // partial 属于另一个版本的 manifest：不能把旧前缀拼到新文件上。
        await this.removeQuietly(partialPath);
        await this.removeQuietly(metaPath);
        existingBytes = 0;
        meta = undefined;
      }
      const headers: Record<string, string> = {};
      if (existingBytes > 0) {
        headers.Range = `bytes=${existingBytes}-`;
        const ifRange = meta?.etag && !meta.etag.startsWith('W/')
          ? meta.etag
          : meta?.lastModified;
        if (ifRange) headers['If-Range'] = ifRange;
      }

      let response: FetchResponseLike;
      try {
        response = await this.fetchImpl(source, { headers, ...(signal ? { signal } : {}) });
      } catch (error) {
        throw new ModelStoreError('download_failed', `download request failed: ${messageOf(error)}`, {
          source,
        });
      }
      throwIfAborted(signal);

      if (response.status === 416) {
        if (await this.checkCompletePartial(file, partialPath)) {
          await this.removeQuietly(metaPath);
          fileStatus.state = 'complete';
          fileStatus.downloadedBytes = file.sizeBytes;
          fileStatus.resumedFrom = existingBytes;
          delete fileStatus.errorCode;
          return { resumedFrom: existingBytes };
        }
        await this.removeQuietly(partialPath);
        await this.removeQuietly(metaPath);
        if (restartCount >= 1) {
          throw new ModelStoreError('http_error', `range request rejected for ${file.path}`, {
            status: 416,
            source,
          });
        }
        restartCount += 1;
        continue;
      }

      if (!response.ok) {
        throw new ModelStoreError('http_error', `download failed with HTTP ${response.status}`, {
          status: response.status,
          source,
          retryable: response.status === 408 || response.status === 429 || response.status >= 500,
        });
      }

      let append = false;
      let startOffset = 0;
      if (response.status === 206) {
        const range = parseContentRange(headerOf(response, 'content-range'));
        if (!range || range.start !== existingBytes) {
          await this.removeQuietly(partialPath);
          await this.removeQuietly(metaPath);
          if (restartCount >= 1) {
            throw new ModelStoreError('http_error', `invalid Content-Range for ${file.path}`, {
              source,
              status: response.status,
            });
          }
          restartCount += 1;
          continue;
        }
        if (range.total !== undefined && range.total !== file.sizeBytes) {
          throw new ModelStoreError('size_mismatch', `server reports unexpected size for ${file.path}`, {
            expectedBytes: file.sizeBytes,
            serverBytes: range.total,
          });
        }
        append = existingBytes > 0;
        startOffset = existingBytes;
      } else if (response.status === 200) {
        // 服务器忽略了 Range，或 If-Range 校验失败：从头开始。
        append = false;
        startOffset = 0;
        if (existingBytes > 0) {
          await this.removeQuietly(partialPath);
          await this.removeQuietly(metaPath);
        }
      } else {
        throw new ModelStoreError('http_error', `unexpected HTTP status ${response.status}`, {
          status: response.status,
          source,
        });
      }

      const etag = headerOf(response, 'etag') ?? undefined;
      const lastModified = headerOf(response, 'last-modified') ?? undefined;
      await this.writePartialMeta(metaPath, {
        ...(etag ? { etag } : {}),
        ...(lastModified ? { lastModified } : {}),
        totalBytes: file.sizeBytes,
        source,
        expectedSha256: file.sha256.toLowerCase(),
      });

      const hash = createHash('sha256');
      if (append && existingBytes > 0) {
        await this.hashPath(partialPath, hash, file.sizeBytes);
      }

      fileStatus.state = 'downloading';
      fileStatus.resumedFrom = append ? existingBytes : 0;
      fileStatus.downloadedBytes = append ? existingBytes : 0;
      progress();

      const writer = await this.io.openWrite(partialPath, { append, mode: 0o600 });
      let written = startOffset;
      try {
        const body = response.body;
        if (body) {
          for await (const chunk of body) {
            throwIfAborted(signal);
            if (!(chunk instanceof Uint8Array)) {
              throw new ModelStoreError('download_failed', 'response body yielded a non-byte chunk');
            }
            hash.update(chunk);
            await writer.write(chunk);
            written += chunk.byteLength;
            fileStatus.downloadedBytes = written;
            if (written > file.sizeBytes) {
              throw new ModelStoreError('size_mismatch', `download exceeded expected size: ${file.path}`);
            }
            progress();
          }
        }
      } finally {
        await writer.close();
      }

      const stat = await this.statOrNull(partialPath);
      if (!stat || !stat.isFile || stat.size !== file.sizeBytes) {
        if (stat && stat.size > file.sizeBytes) {
          await this.removeQuietly(partialPath);
          await this.removeQuietly(metaPath);
        }
        throw new ModelStoreError('size_mismatch', `downloaded size mismatch for ${file.path}`, {
          expectedBytes: file.sizeBytes,
          actualBytes: stat?.size,
        });
      }
      const digest = hash.digest('hex');
      if (digest !== file.sha256.toLowerCase()) {
        await this.removeQuietly(partialPath);
        await this.removeQuietly(metaPath);
        throw new ModelStoreError('checksum_mismatch', `sha256 mismatch for ${file.path}`, {
          expected: file.sha256.toLowerCase(),
          actual: digest,
        });
      }

      await this.removeQuietly(metaPath);
      fileStatus.state = 'complete';
      fileStatus.downloadedBytes = file.sizeBytes;
      delete fileStatus.errorCode;
      return { resumedFrom: append ? existingBytes : 0 };
    }
  }

  /**
   * 下载并安装一个完整 manifest。不会在实际网络失败时假装成功；
   * 已存在的安装只有 force=true 才允许覆盖，覆盖失败会回滚旧目录。
   */
  async download(manifestInput: unknown, options: DownloadModelOptions = {}): Promise<ModelInstallResult> {
    let manifest: ModelManifest;
    try {
      manifest = parseModelManifest(manifestInput);
    } catch (error) {
      if (error instanceof ModelManifestError) {
        throw new ModelStoreError('invalid_manifest', error.message, { errors: error.errors });
      }
      throw error;
    }

    const finalPath = this.packPath(manifest.packId);
    const existing = await this.statOrNull(finalPath);
    if (existing && !options.force) {
      throw new ModelStoreError('install_exists', `model pack is already installed: ${manifest.packId}`);
    }

    const status = this.initialStatus(manifest);
    const listener = options.onStatus;
    this.emit(status, listener);

    try {
      let resumedBytes = 0;
      for (const file of manifest.files) {
        throwIfAborted(options.signal);
        const fileStatus = status.files.find((entry) => entry.path === file.path);
        if (!fileStatus) throw new ModelStoreError('download_failed', `missing status for ${file.path}`);
        status.state = 'downloading';
        this.emit(status, listener);
        try {
          const result = await this.downloadFile(manifest, file, options, fileStatus, () => {
            this.emit(status, listener);
          });
          resumedBytes += result.resumedFrom;
        } catch (error) {
          fileStatus.state = 'failed';
          throw error;
        }
        this.emit(status, listener);
      }

      status.state = 'verifying';
      this.emit(status, listener);

      const staging = await this.createStagingDir(manifest.packId);
      try {
        const files: ModelInstallFileResult[] = [];
        for (const file of manifest.files) {
          throwIfAborted(options.signal);
          const partialPath = safeJoin(this.partialDir(manifest.packId), file.path);
          const target = safeJoin(staging, file.path);
          await this.io.mkdir(dirname(target), { recursive: true, mode: 0o700 });
          await this.io.rename(partialPath, target);
          files.push({
            path: file.path,
            sizeBytes: file.sizeBytes,
            sha256: file.sha256,
            resumedFrom: status.files.find((entry) => entry.path === file.path)?.resumedFrom ?? 0,
          });
        }
        await this.io.writeFile(join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
          mode: 0o600,
        });

        status.state = 'installing';
        this.emit(status, listener);
        await this.commitStaging(staging, finalPath, options.force === true);
        try {
          await this.removeQuietly(this.partialDir(manifest.packId));
        } catch {
          // 安装已经提交；partial 清理失败不应把成功安装标成失败。
        }
      } catch (error) {
        await this.removeQuietly(staging);
        throw error;
      }

      status.state = 'installed';
      status.installedPath = finalPath;
      this.emit(status, listener);

      return {
        packId: manifest.packId,
        modelId: manifest.modelId,
        path: finalPath,
        manifest,
        installedBytes: modelManifestTotalBytes(manifest),
        resumedBytes,
        files: manifest.files.map((file) => ({
          path: file.path,
          sizeBytes: file.sizeBytes,
          sha256: file.sha256,
          resumedFrom: status.files.find((entry) => entry.path === file.path)?.resumedFrom ?? 0,
        })),
      };
    } catch (error) {
      const failure = error instanceof ModelStoreError
        ? error
        : new ModelStoreError('download_failed', messageOf(error));
      this.failStatus(status, failure, listener);
      throw failure;
    }
  }

  private async createStagingDir(packId: string): Promise<string> {
    const path = join(this.stagingRoot(), `${assertPackId(packId)}-${this.safeNonce()}`);
    await this.io.mkdir(path, { recursive: true, mode: 0o700 });
    return path;
  }

  private async commitStaging(staging: string, finalPath: string, force: boolean): Promise<void> {
    const existing = await this.statOrNull(finalPath);
    if (existing && !force) {
      throw new ModelStoreError('install_exists', `model pack is already installed: ${finalPath}`);
    }
    const backupPath = `${finalPath}.backup-${this.safeNonce()}`;
    let movedBackup = false;
    if (existing) {
      await this.io.rename(finalPath, backupPath);
      movedBackup = true;
    }
    try {
      await this.io.rename(staging, finalPath);
    } catch (error) {
      if (movedBackup) {
        try {
          await this.io.rename(backupPath, finalPath);
        } catch {
          // 恢复失败时保留 backup 目录，绝不删除唯一旧副本。
        }
      }
      throw error;
    }
    if (movedBackup) {
      try {
        await this.removeQuietly(backupPath);
      } catch {
        // 新安装已生效；备份清理失败留给后续 uninstall/人工清理。
      }
    }
  }

  private async importFile(
    sourcePath: string,
    targetPath: string,
    file: ModelFile,
    status: ModelDownloadStatus,
    fileStatus: ModelDownloadFileStatus,
  ): Promise<void> {
    const sourceStat = await this.statOrNull(sourcePath);
    if (!sourceStat || !sourceStat.isFile) {
      throw new ModelStoreError('import_failed', `missing imported file: ${file.path}`);
    }
    if (sourceStat.size !== file.sizeBytes) {
      throw new ModelStoreError('size_mismatch', `imported file size mismatch: ${file.path}`, {
        expectedBytes: file.sizeBytes,
        actualBytes: sourceStat.size,
      });
    }
    const reader = await this.io.openRead(sourcePath);
    const writer = await this.io.openWrite(targetPath, { append: false, mode: 0o600 });
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    fileStatus.state = 'downloading';
    try {
      for (;;) {
        const { bytesRead } = await reader.read(buffer, 0, buffer.length, position);
        if (bytesRead <= 0) break;
        const chunk = buffer.subarray(0, bytesRead);
        hash.update(chunk);
        await writer.write(chunk);
        position += bytesRead;
        fileStatus.downloadedBytes = position;
        status.downloadedBytes = sumDownloaded(status.files);
      }
    } finally {
      try {
        await reader.close();
      } finally {
        await writer.close();
      }
    }
    if (position !== file.sizeBytes) {
      throw new ModelStoreError('size_mismatch', `imported file size mismatch: ${file.path}`);
    }
    const digest = hash.digest('hex');
    if (digest !== file.sha256.toLowerCase()) {
      throw new ModelStoreError('checksum_mismatch', `sha256 mismatch for imported file: ${file.path}`, {
        expected: file.sha256.toLowerCase(),
        actual: digest,
      });
    }
    fileStatus.state = 'complete';
    fileStatus.downloadedBytes = file.sizeBytes;
  }

  /**
   * 离线导入目录：目录中需有 manifest.json 与 manifest.files 列出的文件。
   * 先复制到 staging 并流式校验，再原子提交；失败不会污染已有安装。
   */
  async importDirectory(options: ImportModelOptions): Promise<ModelInstallResult> {
    const sourceDir = options.sourceDir;
    let manifest: ModelManifest;
    try {
      if (options.manifest !== undefined) {
        manifest = parseModelManifest(options.manifest);
      } else {
        let raw: string;
        try {
          raw = await this.io.readFile(join(sourceDir, 'manifest.json'), 'utf8');
        } catch (error) {
          throw new ModelStoreError('manifest_missing', `offline import has no manifest.json: ${messageOf(error)}`);
        }
        manifest = parseModelManifest(JSON.parse(raw));
      }
    } catch (error) {
      if (error instanceof ModelStoreError) throw error;
      if (error instanceof ModelManifestError) {
        throw new ModelStoreError('invalid_manifest', error.message, { errors: error.errors });
      }
      throw new ModelStoreError('invalid_manifest', `invalid offline manifest: ${messageOf(error)}`);
    }
    if (options.packId && options.packId !== manifest.packId) {
      throw new ModelStoreError('manifest_mismatch', `packId ${options.packId} does not match manifest ${manifest.packId}`);
    }

    const finalPath = this.packPath(manifest.packId);
    const existing = await this.statOrNull(finalPath);
    if (existing && !options.force) {
      throw new ModelStoreError('install_exists', `model pack is already installed: ${manifest.packId}`);
    }

    const status = this.initialStatus(manifest);
    status.state = 'downloading';
    this.emit(status, options.onStatus);
    const staging = await this.createStagingDir(manifest.packId);
    try {
      for (const file of manifest.files) {
        const fileStatus = status.files.find((entry) => entry.path === file.path);
        if (!fileStatus) throw new ModelStoreError('import_failed', `missing status for ${file.path}`);
        const sourcePath = safeJoin(sourceDir, file.path);
        const targetPath = safeJoin(staging, file.path);
        await this.io.mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
        try {
          await this.importFile(sourcePath, targetPath, file, status, fileStatus);
        } catch (error) {
          fileStatus.state = 'failed';
          throw error;
        }
        this.emit(status, options.onStatus);
      }
      await this.io.writeFile(join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
        mode: 0o600,
      });
      status.state = 'installing';
      this.emit(status, options.onStatus);
      await this.commitStaging(staging, finalPath, options.force === true);
    } catch (error) {
      await this.removeQuietly(staging);
      const failure = error instanceof ModelStoreError
        ? error
        : new ModelStoreError('import_failed', messageOf(error));
      status.state = failure.code === 'cancelled' ? 'cancelled' : 'failed';
      status.error = { code: failure.code, message: failure.message };
      this.emit(status, options.onStatus);
      throw failure;
    }

    status.state = 'installed';
    status.installedPath = finalPath;
    this.emit(status, options.onStatus);
    return {
      packId: manifest.packId,
      modelId: manifest.modelId,
      path: finalPath,
      manifest,
      installedBytes: modelManifestTotalBytes(manifest),
      resumedBytes: 0,
      files: manifest.files.map((file) => ({
        path: file.path,
        sizeBytes: file.sizeBytes,
        sha256: file.sha256,
        resumedFrom: 0,
      })),
    };
  }

  /** 流式校验已安装包；返回逐个文件的 sha256 对比结果。 */
  async verify(packId: string): Promise<ModelVerifyResult> {
    const path = this.packPath(packId);
    let manifest: ModelManifest;
    try {
      manifest = await this.readInstalledManifest(path);
    } catch (error) {
      if (error instanceof ModelStoreError && error.code === 'not_installed') throw error;
      return {
        packId,
        ok: false,
        path,
        checkedAt: this.now(),
        files: [],
        errors: [messageOf(error)],
      };
    }

    const files: ModelVerifyFileResult[] = [];
    const errors: string[] = [];
    for (const file of manifest.files) {
      const target = safeJoin(path, file.path);
      const stat = await this.statOrNull(target);
      if (!stat || !stat.isFile) {
        files.push({
          path: file.path,
          ok: false,
          sizeBytes: 0,
          expectedSha256: file.sha256,
          error: 'missing',
        });
        errors.push(`${file.path}: missing`);
        continue;
      }
      if (stat.size !== file.sizeBytes) {
        files.push({
          path: file.path,
          ok: false,
          sizeBytes: stat.size,
          expectedSha256: file.sha256,
          error: 'size_mismatch',
        });
        errors.push(`${file.path}: expected ${file.sizeBytes} bytes, got ${stat.size}`);
        continue;
      }
      try {
        const digest = await this.digestOf(target);
        const ok = digest.sha256 === file.sha256.toLowerCase();
        files.push({
          path: file.path,
          ok,
          sizeBytes: stat.size,
          expectedSha256: file.sha256,
          actualSha256: digest.sha256,
          ...(ok ? {} : { error: 'checksum_mismatch' }),
        });
        if (!ok) errors.push(`${file.path}: sha256 mismatch`);
      } catch (error) {
        files.push({
          path: file.path,
          ok: false,
          sizeBytes: stat.size,
          expectedSha256: file.sha256,
          error: messageOf(error),
        });
        errors.push(`${file.path}: ${messageOf(error)}`);
      }
    }

    return {
      packId,
      ok: errors.length === 0,
      path,
      checkedAt: this.now(),
      files,
      errors,
    };
  }

  /** 卸载已安装包、partial 与 staging/backup 残留；幂等。 */
  async uninstall(packId: string): Promise<{ removed: boolean; path: string }> {
    const path = this.packPath(packId);
    const existing = await this.statOrNull(path);
    if (existing) await this.removeQuietly(path);
    await this.removeQuietly(this.partialDir(packId));

    try {
      const staging = await this.io.readdir(this.stagingRoot());
      for (const entry of staging) {
        if (entry.startsWith(`${packId}-`)) {
          await this.removeQuietly(join(this.stagingRoot(), entry));
        }
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    try {
      const rootEntries = await this.io.readdir(this.rootDir);
      for (const entry of rootEntries) {
        if (entry.startsWith(`${packId}.backup-`)) {
          await this.removeQuietly(join(this.rootDir, entry));
        }
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }

    this.statuses.delete(packId);
    return { removed: existing !== null, path };
  }
}
