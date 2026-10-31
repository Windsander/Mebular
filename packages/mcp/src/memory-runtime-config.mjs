// Memory Runtime sidecar 用户级配置：只读模型来源（轻量/未就绪时的展示回退）。
//
// 契约（0.3.0 immersive product contract §1.4 / §1.5 / §4.3）：
// - 用户在「高级」只选择 model.source（heuristic/local/host/api/auto）；
// - 配置真值在 sidecar；MCP 不再写 `<home>/memory-runtime/config.json`；
// - 浏览器不接触 sidecar host token / endpoint / API key / keyRef / 模型路径；
// - 读取不创建目录。
//
// 本模块不 import sidecar 业务实现，也不读写图/事件日志。

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
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
