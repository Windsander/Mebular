// <home>/runtime.json：守护启动后的非敏感发现信息。
//
// 只包含版本、pid、实际 HTTP 监听地址、Console/MCP 路径与 embed 协议版本。
// 不读取也不写入任何 Mebular 配置、身份或密钥。写入在 HTTP listen 成功之后
// 原子完成；停止时只删除 pid 与当前进程一致的 runtime.json，避免误删新实例。

import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const RUNTIME_FILE = 'runtime.json';

/** @param {string} home */
export function runtimePath(home) {
  return join(home, RUNTIME_FILE);
}

/**
 * Build the exact non-sensitive runtime record.
 * @param {{
 *   version: string,
 *   pid?: number,
 *   host: string,
 *   port: number,
 *   consolePath?: string,
 *   mcpPath?: string,
 *   embedProtocol: number,
 * }} input
 */
export function buildRuntimeRecord(input) {
  return {
    version: input.version,
    pid: input.pid ?? process.pid,
    http: { host: input.host, port: input.port },
    consolePath: input.consolePath ?? '/console',
    mcpPath: input.mcpPath ?? '/mcp',
    embedProtocol: input.embedProtocol,
  };
}

/**
 * Atomically write <home>/runtime.json. Call only after the HTTP listener is bound.
 * @param {string} home
 * @param {Parameters<typeof buildRuntimeRecord>[0]} input
 * @returns {Promise<ReturnType<typeof buildRuntimeRecord>>}
 */
export async function writeRuntimeFile(home, input) {
  const record = buildRuntimeRecord(input);
  const path = runtimePath(home);
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    await writeFile(tmp, JSON.stringify(record, null, 2), { encoding: 'utf-8', mode: 0o600 });
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
  return record;
}

/**
 * Read <home>/runtime.json without throwing. Returns null for a missing,
 * unreadable, or malformed file.
 * @param {string} home
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function readRuntimeFile(home) {
  try {
    const value = JSON.parse(await readFile(runtimePath(home), 'utf-8'));
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Remove runtime.json only when it still belongs to `pid`. A newer instance that
 * already replaced the file is left untouched.
 * @param {string} home
 * @param {{ pid?: number }} [options]
 * @returns {Promise<boolean>}
 */
export async function clearRuntimeFile(home, { pid = process.pid } = {}) {
  const record = await readRuntimeFile(home);
  if (record === null || record.pid !== pid) return false;
  try {
    await unlink(runtimePath(home));
    return true;
  } catch {
    return false;
  }
}
