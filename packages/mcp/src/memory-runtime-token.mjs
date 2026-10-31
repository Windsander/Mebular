// MCP Memory Capability token（0.3.0 contract v2 §2.1）
//
// 只服务于 MCP daemon 内部的 `/internal/memory/v1`：
// - 生成 ≥32 字节随机 base64url token；
// - 写入 `<home>/memory-runtime/capability-token`（目录 0700、文件 0600）；
// - `MEBULAR_CAPABILITY_TOKEN` 可覆盖（测试/调试/由 MCP 注入 sidecar 子进程）；
// - 进程内只保存 token 的 sha256（tokenHash）与过期时间；token 明文只在生成/读取时短暂存在。
//
// 本模块不在 import 时创建任何目录或文件；轻量模式（memoryRuntime.enabled=false）不会调用 ensure。

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const CAPABILITY_TOKEN_VERSION = 1;
export const CAPABILITY_TOKEN_DIR = 'memory-runtime';
export const CAPABILITY_TOKEN_FILE = 'capability-token';
export const DEFAULT_CAPABILITY_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** `<home>/memory-runtime`。 */
export function capabilityTokenDir(home) {
  return join(home, CAPABILITY_TOKEN_DIR);
}

/** `<home>/memory-runtime/capability-token`。 */
export function capabilityTokenPath(home) {
  return join(capabilityTokenDir(home), CAPABILITY_TOKEN_FILE);
}

/** 至少 32 字节随机 → base64url（约 43 字符）。 */
export function generateCapabilityToken({ bytes = 32 } = {}) {
  const size = Number.isInteger(bytes) && bytes >= 32 ? bytes : 32;
  return randomBytes(size).toString('base64url');
}

/** token 的 sha256 十六进制摘要（进程内只保存它）。 */
export function hashCapabilityToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

/** 稳定 tokenId（可安全放进日志/状态；不含 token 明文）。 */
export function tokenIdForToken(token) {
  return `tok_${hashCapabilityToken(token).slice(0, 16)}`;
}

/** 常量时间比较两个 token 字符串（内部按 sha256 比较，避免长度泄漏）。 */
export function safeTokenEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ah = Buffer.from(hashCapabilityToken(a), 'hex');
  const bh = Buffer.from(hashCapabilityToken(b), 'hex');
  return ah.length === bh.length && timingSafeEqual(ah, bh);
}

/**
 * 校验调用方 token 是否匹配进程内记录。
 * @param {unknown} token
 * @param {{tokenHash?: string, expiresAt?: number|null}|null|undefined} record
 * @param {{now?: number}} [options]
 */
export function verifyCapabilityToken(token, record, { now = Date.now() } = {}) {
  if (!record || typeof record.tokenHash !== 'string' || typeof token !== 'string' || token.length === 0) {
    return false;
  }
  const expiresAt = typeof record.expiresAt === 'number' ? record.expiresAt : 0;
  if (expiresAt > 0 && now >= expiresAt) return false;
  let expected;
  try {
    expected = Buffer.from(record.tokenHash, 'hex');
  } catch {
    return false;
  }
  if (expected.length !== 32) return false;
  const actual = Buffer.from(hashCapabilityToken(token), 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * 读取 sidecar 可用的 token 记录。
 *
 * 顺序：`MEBULAR_CAPABILITY_TOKEN` → `<home>/memory-runtime/capability-token`。
 * 文件损坏/过期仍返回记录（带 `expired`），由调用方决定是否拒绝；不存在返回 null。
 * 返回对象包含 token 明文——只允许交给本机 sidecar / 测试，不得写入日志或 status。
 */
export async function readCapabilityToken({ home, env = process.env, now = Date.now() } = {}) {
  const override = env?.MEBULAR_CAPABILITY_TOKEN;
  if (typeof override === 'string' && override.length > 0) {
    return {
      version: CAPABILITY_TOKEN_VERSION,
      token: override,
      tokenId: tokenIdForToken(override),
      tokenHash: hashCapabilityToken(override),
      issuedAt: 0,
      expiresAt: 0,
      mcpPid: null,
      source: 'env',
      expired: false,
    };
  }
  if (typeof home !== 'string' || home.length === 0) return null;
  const file = capabilityTokenPath(home);
  if (!existsSync(file)) return null;
  let data;
  try {
    data = JSON.parse(await readFile(file, 'utf-8'));
  } catch {
    return null;
  }
  if (!data || data.version !== CAPABILITY_TOKEN_VERSION || typeof data.token !== 'string' || data.token.length === 0) {
    return null;
  }
  const expiresAt = typeof data.expiresAt === 'number' ? data.expiresAt : 0;
  return {
    ...data,
    tokenId: tokenIdForToken(data.token),
    tokenHash: hashCapabilityToken(data.token),
    source: 'file',
    expired: expiresAt > 0 && now >= expiresAt,
  };
}

/**
 * 生成并持久化 token；已存在也**重新生成**（MCP 每次启动轮换，旧 token 立即失效）。
 * 设置 `MEBULAR_CAPABILITY_TOKEN` 时不创建目录/文件，直接返回覆盖值。
 *
 * @returns {Promise<{version:number, token:string, tokenId:string, tokenHash:string,
 *   issuedAt:number, expiresAt:number, mcpPid:number|null, source:'env'|'file', file:string|null}>}
 */
export async function ensureCapabilityToken({
  home,
  env = process.env,
  now = Date.now(),
  ttlMs = DEFAULT_CAPABILITY_TOKEN_TTL_MS,
  mcpPid = process.pid,
  dirMode = 0o700,
  fileMode = 0o600,
} = {}) {
  const override = env?.MEBULAR_CAPABILITY_TOKEN;
  if (typeof override === 'string' && override.length > 0) {
    return {
      version: CAPABILITY_TOKEN_VERSION,
      token: override,
      tokenId: tokenIdForToken(override),
      tokenHash: hashCapabilityToken(override),
      issuedAt: now,
      expiresAt: 0,
      mcpPid,
      source: 'env',
      file: null,
    };
  }
  if (typeof home !== 'string' || home.length === 0) {
    throw new Error('capability token 需要 home 目录');
  }

  const dir = capabilityTokenDir(home);
  const file = capabilityTokenPath(home);
  const token = generateCapabilityToken();
  const record = {
    version: CAPABILITY_TOKEN_VERSION,
    token,
    issuedAt: now,
    expiresAt: now + (Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_CAPABILITY_TOKEN_TTL_MS),
    mcpPid,
  };

  await mkdir(dir, { recursive: true, mode: dirMode });
  await chmod(dir, dirMode);
  const tmp = join(dir, `.${CAPABILITY_TOKEN_FILE}.tmp-${process.pid}-${randomUUID()}`);
  try {
    await writeFile(tmp, JSON.stringify(record), { encoding: 'utf-8', mode: fileMode });
    await chmod(tmp, fileMode);
    await rename(tmp, file);
    await chmod(file, fileMode);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }

  return {
    ...record,
    tokenId: tokenIdForToken(token),
    tokenHash: hashCapabilityToken(token),
    source: 'file',
    file,
  };
}

/** 删除 token 文件（撤销/停用）；目录保留。 */
export async function removeCapabilityToken({ home } = {}) {
  if (typeof home !== 'string' || home.length === 0) return;
  await rm(capabilityTokenPath(home), { force: true }).catch(() => undefined);
}
