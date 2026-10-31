// Memory Runtime sidecar token 读取/生成。
//
// 两个方向、两个 token（sidecar 契约 §4）：
// - host-token：sidecar 生成，宿主 → sidecar 使用；每次启动轮换，0600；
// - capability-token：MCP daemon 生成，sidecar → MCP 使用；只读，不写日志。
//
// 覆盖顺序：
// - host token：MEBULAR_MEMORY_RUNTIME_TOKEN > `<dataDir>/host-token`；
// - capability token：MEBULAR_CAPABILITY_TOKEN > `<dataDir>/capability-token`。
//
// 本模块不 import @mebular/core，也不 import MCP 内部模块。

import { randomBytes } from 'node:crypto';
import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { readJsonFile, writeJsonAtomic } from './atomic-json.js';

export const TOKEN_VERSION = 1;
export const HOST_TOKEN_FILE = 'host-token';
export const CAPABILITY_TOKEN_FILE = 'capability-token';
const MIN_TOKEN_BYTES = 32;

export type TokenErrorCode =
  | 'token_invalid'
  | 'token_permissions_insecure';

export class TokenError extends Error {
  readonly code: TokenErrorCode;

  constructor(code: TokenErrorCode, message: string) {
    super(message);
    this.name = 'TokenError';
    this.code = code;
  }
}

export interface HostTokenRecord {
  version: 1;
  token: string;
  issuedAt: number;
  expiresAt: number;
}

export interface HostTokenReadResult {
  token: string;
  issuedAt: number;
  expiresAt: number;
  source: 'env' | 'file';
  path: string | null;
}

export interface CapabilityTokenReadResult {
  token: string;
  issuedAt: number;
  expiresAt: number;
  mcpPid: number | null;
  source: 'env' | 'file';
  path: string | null;
  expired: boolean;
}

export function hostTokenPathForDataDir(dataDir: string): string {
  return join(dataDir, HOST_TOKEN_FILE);
}

export function capabilityTokenPathForDataDir(dataDir: string): string {
  return join(dataDir, CAPABILITY_TOKEN_FILE);
}

/** 至少 32 字节随机 → base64url。 */
export function generateHostToken({ bytes = MIN_TOKEN_BYTES }: { bytes?: number } = {}): string {
  const size = Number.isInteger(bytes) && bytes >= MIN_TOKEN_BYTES ? bytes : MIN_TOKEN_BYTES;
  return randomBytes(size).toString('base64url');
}

/**
 * POSIX 上拒绝组/其他可读的 token 文件。
 * Windows 的 ACL 无法用 st_mode 表达，不做伪安全判断。
 */
export async function assertPrivateTokenFile(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  let mode: number;
  try {
    const info = await stat(path);
    mode = info.mode;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if ((mode & 0o077) !== 0) {
    throw new TokenError('token_permissions_insecure', 'token 文件权限不安全（要求 0600）');
  }
}

export interface EnsureHostTokenOptions {
  tokenFile: string;
  env?: NodeJS.ProcessEnv;
  token?: string;
  now?: number;
}

export interface EnsuredHostToken extends HostTokenRecord {
  path: string;
  source: 'env' | 'generated' | 'provided';
}

/**
 * 生成/写入 host token（0600）。
 * 已存在也重新生成：每次 sidecar 启动轮换，旧 token 立即失效。
 */
export async function ensureHostToken({
  tokenFile,
  env = process.env,
  token,
  now = Date.now(),
}: EnsureHostTokenOptions): Promise<EnsuredHostToken> {
  const envToken = env?.MEBULAR_MEMORY_RUNTIME_TOKEN;
  const provided = typeof token === 'string' && token.length > 0
    ? token
    : typeof envToken === 'string' && envToken.length > 0
      ? envToken
      : null;
  const value = provided ?? generateHostToken();
  const record: HostTokenRecord = {
    version: TOKEN_VERSION,
    token: value,
    issuedAt: now,
    expiresAt: 0,
  };
  await writeJsonAtomic(tokenFile, record);
  return {
    ...record,
    path: tokenFile,
    source: provided === null ? 'generated' : token ? 'provided' : 'env',
  };
}

export interface ReadHostTokenOptions {
  tokenFile: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * 读取 host token；环境覆盖优先。
 * 文件不存在返回 null；权限不安全抛 TokenError。
 */
export async function readHostToken({
  tokenFile,
  env = process.env,
}: ReadHostTokenOptions): Promise<HostTokenReadResult | null> {
  const envToken = env?.MEBULAR_MEMORY_RUNTIME_TOKEN;
  if (typeof envToken === 'string' && envToken.length > 0) {
    return {
      token: envToken,
      issuedAt: 0,
      expiresAt: 0,
      source: 'env',
      path: null,
    };
  }

  await assertPrivateTokenFile(tokenFile);
  const record = await readJsonFile<Partial<HostTokenRecord>>(tokenFile);
  if (!record || record.version !== TOKEN_VERSION || typeof record.token !== 'string' || record.token.length === 0) {
    return null;
  }
  return {
    token: record.token,
    issuedAt: typeof record.issuedAt === 'number' ? record.issuedAt : 0,
    expiresAt: typeof record.expiresAt === 'number' ? record.expiresAt : 0,
    source: 'file',
    path: tokenFile,
  };
}

export interface ReadCapabilityTokenOptions {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  now?: number;
}

interface StoredCapabilityToken {
  version?: unknown;
  token?: unknown;
  issuedAt?: unknown;
  expiresAt?: unknown;
  mcpPid?: unknown;
}

/**
 * 读取 MCP capability token；环境覆盖优先。
 * 文件不存在/损坏返回 null；权限不安全抛 TokenError。
 * 返回对象包含 token 明文，只允许交给 capability client。
 */
export async function readCapabilityToken({
  dataDir,
  env = process.env,
  now = Date.now(),
}: ReadCapabilityTokenOptions): Promise<CapabilityTokenReadResult | null> {
  const envToken = env?.MEBULAR_CAPABILITY_TOKEN;
  if (typeof envToken === 'string' && envToken.length > 0) {
    return {
      token: envToken,
      issuedAt: 0,
      expiresAt: 0,
      mcpPid: null,
      source: 'env',
      path: null,
      expired: false,
    };
  }

  const path = capabilityTokenPathForDataDir(dataDir);
  await assertPrivateTokenFile(path);
  const record = await readJsonFile<StoredCapabilityToken>(path);
  if (!record || record.version !== TOKEN_VERSION || typeof record.token !== 'string' || record.token.length === 0) {
    return null;
  }
  const expiresAt = typeof record.expiresAt === 'number' ? record.expiresAt : 0;
  return {
    token: record.token,
    issuedAt: typeof record.issuedAt === 'number' ? record.issuedAt : 0,
    expiresAt,
    mcpPid: typeof record.mcpPid === 'number' ? record.mcpPid : null,
    source: 'file',
    path,
    expired: expiresAt > 0 && now >= expiresAt,
  };
}

/** 停止时删除 host token；不影响 MCP 写入的 capability token。 */
export async function removeHostToken(tokenFile: string): Promise<void> {
  await rm(tokenFile, { force: true }).catch(() => undefined);
}

/** 只删除仍属于当前实例的 host token，避免误删新实例轮换后的文件。 */
export async function removeHostTokenIfMatches(tokenFile: string, token: string): Promise<boolean> {
  const record = await readJsonFile<Partial<HostTokenRecord>>(tokenFile);
  if (!record || record.version !== TOKEN_VERSION || record.token !== token) return false;
  await rm(tokenFile, { force: true }).catch(() => undefined);
  return true;
}
