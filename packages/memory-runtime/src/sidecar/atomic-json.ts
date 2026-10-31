// Memory Runtime sidecar 的私有文件写入原语。
//
// 所有 sidecar 状态文件（config/discovery/token/cache/outbox）都要求：
// - 目录 0700；
// - 文件 0600；
// - 写入采用「同目录临时文件 + fsync + rename」原子替换。
//
// 本模块只依赖 Node 内置模块，不接触图、事件日志或 MCP 内部实现。

import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

/** 创建私有目录（0700）；已存在时也校正权限。 */
export async function ensurePrivateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700).catch(() => undefined);
}

/**
 * 原子写入私有文本文件。
 * 临时文件与目标同目录，避免跨文件系统 rename；失败时清理临时文件。
 */
export async function writePrivateText(path: string, text: string): Promise<void> {
  await ensurePrivateDir(dirname(path));
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    const handle = await open(tmp, 'w', 0o600);
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(tmp, 0o600).catch(() => undefined);
    await rename(tmp, path);
    await chmod(path, 0o600).catch(() => undefined);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** 原子写入 JSON（紧凑格式，不包含额外空白）。 */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writePrivateText(path, JSON.stringify(value));
}

/**
 * 读取 JSON 文件。
 * 不存在或内容损坏时返回 null；其他 I/O 错误继续抛出。
 */
export async function readJsonFile<T>(path: string): Promise<T | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const value = JSON.parse(text) as unknown;
    return (value !== null && typeof value === 'object' ? value : null) as T | null;
  } catch {
    return null;
  }
}
