// Memory Runtime sidecar 用户级配置：只暴露模型来源。
//
// 契约（0.3.0 immersive product contract §1.4 / §1.5 / §4.3）：
// - 用户在「高级」只选择 model.source（heuristic/local/host/api/auto）；
// - 配置真值在 `<home>/memory-runtime/config.json` 的 `model.source`；
// - 浏览器不接触 sidecar host token / endpoint / API key / keyRef / 模型路径；
// - 读取不创建目录；写入只做原子更新 + `.bak`，保留文件内其他字段。
//
// 本模块不 import sidecar 业务实现，也不读写图/事件日志。

import { randomBytes } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveMemoryRuntimePaths } from './memory-runtime-supervisor.mjs';

export const MEMORY_RUNTIME_MODEL_SOURCES = Object.freeze([
  'heuristic',
  'local',
  'host',
  'api',
  'auto',
]);

export const DEFAULT_MEMORY_RUNTIME_MODEL_SOURCE = 'heuristic';

export class MemoryRuntimeConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MemoryRuntimeConfigError';
    this.code = code;
  }
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 归一化模型来源；未知值返回 null（调用方决定回退或报错）。 */
export function normalizeMemoryRuntimeModelSource(value) {
  if (typeof value !== 'string') return null;
  const source = value.trim().toLowerCase();
  return MEMORY_RUNTIME_MODEL_SOURCES.includes(source) ? source : null;
}

/** sidecar 配置路径（与 supervisor 使用同一 home/data-dir 解析规则）。 */
export function memoryRuntimeConfigPath({ home, env = process.env } = {}) {
  const paths = resolveMemoryRuntimePaths({ home, env });
  return join(paths.dataDir, 'config.json');
}

async function readRawConfig(path) {
  let text;
  try {
    text = await readFile(path, 'utf-8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, raw: {} };
    throw new MemoryRuntimeConfigError('config_unreadable', '无法读取记忆运行时配置');
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new MemoryRuntimeConfigError('config_invalid', '记忆运行时配置不是合法 JSON');
  }
  if (!isObject(parsed)) {
    throw new MemoryRuntimeConfigError('config_invalid', '记忆运行时配置必须是 JSON 对象');
  }
  return { exists: true, raw: parsed };
}

/**
 * 读取当前模型来源。返回给浏览器的最小视图：
 * 只有 source / 默认值 / 合法选项 / 是否存在，不返回配置正文或路径。
 */
export async function readMemoryRuntimeModelSource({ home, env = process.env } = {}) {
  const path = memoryRuntimeConfigPath({ home, env });
  const { exists, raw } = await readRawConfig(path);
  const model = isObject(raw.model) ? raw.model : {};
  const normalized = normalizeMemoryRuntimeModelSource(model.source);
  return {
    source: normalized ?? DEFAULT_MEMORY_RUNTIME_MODEL_SOURCE,
    defaultSource: DEFAULT_MEMORY_RUNTIME_MODEL_SOURCE,
    values: [...MEMORY_RUNTIME_MODEL_SOURCES],
    exists,
    ...(model.source !== undefined && normalized === null ? { warnings: ['invalid_model_source'] } : {}),
  };
}

async function writeJsonAtomic(path, data) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(5).toString('hex')}`;
  try {
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
    if (existsSync(path)) await copyFile(path, `${path}.bak`).catch(() => undefined);
    await rename(tmp, path);
    await chmod(path, 0o600).catch(() => undefined);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * 写入 `model.source`，保留 config.json 的其他字段。
 * 非法来源在落盘前拒绝；已有 JSON 损坏时拒绝覆盖（避免破坏用户配置）。
 */
export async function writeMemoryRuntimeModelSource({ home, env = process.env, source } = {}) {
  const normalized = normalizeMemoryRuntimeModelSource(source);
  if (!normalized) {
    throw new MemoryRuntimeConfigError('invalid_model_source', '模型来源不合法');
  }
  const path = memoryRuntimeConfigPath({ home, env });
  const { raw, exists } = await readRawConfig(path);
  const next = JSON.parse(JSON.stringify(raw));
  next.model = isObject(next.model) ? next.model : {};
  next.model.source = normalized;
  await writeJsonAtomic(path, next);
  return {
    source: normalized,
    defaultSource: DEFAULT_MEMORY_RUNTIME_MODEL_SOURCE,
    values: [...MEMORY_RUNTIME_MODEL_SOURCES],
    exists: true,
    created: !exists,
  };
}
