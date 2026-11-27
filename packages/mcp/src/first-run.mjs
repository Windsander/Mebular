// 0.4.0 W1b：全新空 home 的一次性首启初始化（唯一允许的“新安装默认 immersive”路径）。
//
// 契约（docs/design/0.4.0-w0-contract.md §2.4）：
// - 只在真正空 home / 首次安装时命中；已有 home 永不写 marker / 不补字段；
// - marker `<home>/first-run.json`（0600，原子写）只表达披露生命周期，不是第二个 mode；
// - 披露在现有首启页展示；ack 只由 Console 显式回传 `firstRunDisclosure` + 版本触发；
// - ack 后初始化（幂等）：sidecar seed `{"schema":1,"model":{"source":"auto"}}`（仅当 sidecar
//   config 不存在）+ 合并 `<home>/config.json` `memoryRuntime.enabled=true`（保留其他字段）；
// - 不写 `intervention.mode`，不重写已有 `model.source`，不迁移、不删除任何旧字段；
// - 任一步失败 → 不写（或只保留未启用的部分）并保持 off；调用方只记录 `first_run_init_failed`，
//   不阻塞 serve，不回退到 heuristic。
//
// 本模块不 import 图谱/事件/sync，也不读写宿主私有存储。

import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { acquireConfigFileLock } from './config-lock.mjs';
import { resolveMemoryRuntimePaths } from './memory-runtime-supervisor.mjs';

export const FIRST_RUN_FILE = 'first-run.json';
export const FIRST_RUN_SCHEMA = 1;
export const FIRST_RUN_DISCLOSURE_VERSION = 1;
/** 失败时的稳定 warning code；不含路径/配置正文。 */
export const FIRST_RUN_INIT_FAILED = 'first_run_init_failed';

const ALLOWED_EMPTY_ENTRIES = new Set(['.DS_Store', 'Thumbs.db', FIRST_RUN_FILE]);
const BLOCKING_ENTRIES = [
  'config.json',
  'user-master-key.json',
  'store.jsonl',
  'store.jsonl.identity.json',
  'runtime.json',
  'memory-runtime',
  'net',
];
const VALID_STATES = new Set(['pending', 'acked', 'done']);

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringOrNull(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function isoTimestamp(now) {
  const value = typeof now === 'function' ? now() : now;
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  return date.toISOString();
}

function mcpConfigPath(home, env) {
  return env?.MEBULAR_CONFIG ?? join(home, 'config.json');
}

function firstRunPath(home) {
  return join(home, FIRST_RUN_FILE);
}

/** marker 文件存在且形状合法才返回；损坏/未知 state 视为不存在，避免把坏文件当 ack。 */
export async function readFirstRunMarker({ home } = {}) {
  if (typeof home !== 'string' || home.length === 0) return null;
  let parsed;
  try {
    parsed = JSON.parse(await readFile(firstRunPath(home), 'utf-8'));
  } catch {
    return null;
  }
  if (!isObject(parsed) || parsed.schema !== FIRST_RUN_SCHEMA) return null;
  if (typeof parsed.state !== 'string' || !VALID_STATES.has(parsed.state)) return null;
  if (!Number.isInteger(parsed.disclosureVersion) || parsed.disclosureVersion < 1) return null;
  return {
    schema: parsed.schema,
    disclosureVersion: parsed.disclosureVersion,
    state: parsed.state,
    createdAt: stringOrNull(parsed.createdAt),
    ...(stringOrNull(parsed.ackedAt) ? { ackedAt: stringOrNull(parsed.ackedAt) } : {}),
    ...(stringOrNull(parsed.initializedAt) ? { initializedAt: stringOrNull(parsed.initializedAt) } : {}),
  };
}

/** 给 Console/provision status 的最小只读视图；不含路径/用户数据。 */
export function firstRunPublicView(marker) {
  if (!marker) return null;
  return {
    pending: marker.state === 'pending',
    disclosureVersion: marker.disclosureVersion,
    state: marker.state,
  };
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await chmod(tmp, 0o600).catch(() => undefined);
    await rename(tmp, path);
    await chmod(path, 0o600).catch(() => undefined);
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
}

/**
 * 极窄空 home 判定（契约 §2.4）：
 * - 无 config / 主密钥 / store / identity / runtime.json / memory-runtime/ / net/；
 * - 目录为空，或只含 `.DS_Store` / `Thumbs.db` / `first-run.json`；
 * - 设置了 `MEBULAR_CONFIG` / `MEBULAR_MEMORY_RUNTIME_HOME` / `MEBULAR_STORAGE_PATH` 时
 *   一律不命中（外部存储可能在 home 之外已有 store，不能证明“首次安装”）。
 *
 * 非 ENOENT 的 readdir 错误不当作空 home（失败闭合）。
 */
export async function detectFreshHome({ home, env = process.env } = {}) {
  if (typeof home !== 'string' || home.length === 0) return false;
  if (stringOrNull(env?.MEBULAR_CONFIG)
    || stringOrNull(env?.MEBULAR_MEMORY_RUNTIME_HOME)
    || stringOrNull(env?.MEBULAR_STORAGE_PATH)) {
    return false;
  }
  const root = resolve(home);
  for (const name of BLOCKING_ENTRIES) {
    if (existsSync(join(root, name))) return false;
  }
  let entries;
  try {
    entries = await readdir(root);
  } catch (error) {
    // 空 home 可能尚未创建目录；只有 ENOENT 视为空。
    return error?.code === 'ENOENT';
  }
  return entries.every((entry) => ALLOWED_EMPTY_ENTRIES.has(entry));
}

/**
 * 首启检测：只有真正空 home 才写 `pending` marker。
 * 已有 home、非空目录、显式 env 覆盖一律 no-op（返回 null，不创建文件）。
 */
export async function markFirstRunPending({ home, env = process.env, now = Date.now } = {}) {
  if (!(await detectFreshHome({ home, env }))) return null;
  const existing = await readFirstRunMarker({ home });
  if (existing) return existing;
  const marker = {
    schema: FIRST_RUN_SCHEMA,
    disclosureVersion: FIRST_RUN_DISCLOSURE_VERSION,
    state: 'pending',
    createdAt: isoTimestamp(now),
  };
  try {
    await writeJsonAtomic(firstRunPath(home), marker);
  } catch {
    // 写 marker 失败 = 无法证明披露已发生：不落盘、不启用；调用方保持 off。
    return null;
  }
  return readFirstRunMarker({ home });
}

/**
 * 披露成功的显式 ack。只有 pending marker + 匹配的 disclosureVersion 才接受；
 * 其他情况（已有用户 / 无 marker / 版本不符）返回 null，绝不凭空创建 marker。
 */
export async function markFirstRunAcked({
  home,
  disclosureVersion = FIRST_RUN_DISCLOSURE_VERSION,
  now = Date.now,
} = {}) {
  const marker = await readFirstRunMarker({ home });
  if (!marker || marker.state !== 'pending') return null;
  if (!Number.isInteger(disclosureVersion) || disclosureVersion !== marker.disclosureVersion) return null;
  const next = {
    ...marker,
    state: 'acked',
    ackedAt: isoTimestamp(now),
  };
  try {
    await writeJsonAtomic(firstRunPath(home), next);
  } catch {
    return null;
  }
  return readFirstRunMarker({ home });
}

async function markFirstRunDone({ home, marker, now = Date.now } = {}) {
  if (!marker) return null;
  const next = {
    ...marker,
    state: 'done',
    initializedAt: marker.initializedAt ?? isoTimestamp(now),
  };
  try {
    await writeJsonAtomic(firstRunPath(home), next);
  } catch {
    return null;
  }
  return readFirstRunMarker({ home });
}

async function readConfigObject(path) {
  let text;
  try {
    text = await readFile(path, 'utf-8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, config: {} };
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const error = new Error('config_invalid');
    error.code = 'config_invalid';
    throw error;
  }
  if (!isObject(parsed)) {
    const error = new Error('config_invalid');
    error.code = 'config_invalid';
    throw error;
  }
  return { exists: true, config: parsed };
}

function withMemoryRuntimeEnabled(config) {
  const next = { ...config };
  const memoryRuntime = isObject(next.memoryRuntime) ? { ...next.memoryRuntime } : {};
  memoryRuntime.enabled = true;
  next.memoryRuntime = memoryRuntime;
  return next;
}

/**
 * 把 acked marker 落成真正的 immersive 初始化。幂等、原子、失败闭合：
 * - 无 marker / 非 acked → `{ ok:false, reason:'no_marker'|'not_acked' }`，不写任何配置；
 * - 已 enabled → 只把 marker 收敛为 done；
 * - sidecar config 不存在才写 seed（source=auto，sourcePresent 自然为 true）；
 * - MCP config 只合并 `memoryRuntime.enabled=true`，其他键逐字保留；
 * - 任一步失败 → 返回 `{ ok:false, reason }`（调用方记录 warning），不抛异常、不阻塞启动。
 */
export async function initializeFirstRunHome({ home, env = process.env, now = Date.now } = {}) {
  if (typeof home !== 'string' || home.length === 0) {
    return { ok: false, reason: 'home_required' };
  }
  const root = resolve(home);
  let marker = await readFirstRunMarker({ home: root });
  if (!marker) return { ok: false, reason: 'no_marker' };
  if (marker.state === 'done') {
    return { ok: true, skipped: 'done', initialized: false, enabled: false };
  }
  if (marker.state !== 'acked') return { ok: false, reason: 'not_acked' };

  const configFile = mcpConfigPath(root, env);
  const release = await acquireConfigFileLock(configFile, { timeoutMs: 2000 });
  if (!release) return { ok: false, reason: 'config_locked' };
  try {
    // 锁内重查 marker + enabled：并发初始化/用户手动开启时只允许一个写者。
    marker = await readFirstRunMarker({ home: root });
    if (!marker || marker.state === 'done') {
      return marker?.state === 'done'
        ? { ok: true, skipped: 'done', initialized: false, enabled: false }
        : { ok: false, reason: 'no_marker' };
    }
    if (marker.state !== 'acked') return { ok: false, reason: 'not_acked' };

    const { config } = await readConfigObject(configFile);
    // memoryRuntime 不是对象 = 用户配置损坏/未知形态：fail closed，绝不覆盖成 {enabled:true}。
    if (config.memoryRuntime !== undefined && !isObject(config.memoryRuntime)) {
      return { ok: false, reason: 'config_invalid', enabled: false };
    }
    const explicitEnabled = isObject(config.memoryRuntime)
      && typeof config.memoryRuntime.enabled === 'boolean';
    if (explicitEnabled) {
      // 显式 enabled 已存在（用户/模板写过）→ 绝不覆盖；false 也视为用户选择，停止重试。
      await markFirstRunDone({ home: root, marker, now });
      const enabled = config.memoryRuntime.enabled === true;
      return {
        ok: true,
        skipped: enabled ? 'already_enabled' : 'explicit_disabled',
        initialized: false,
        enabled,
      };
    }

    // 先写 sidecar seed：失败则 MCP 仍保持 disabled（off），不会出现“enabled 但没有 source”。
    const sidecarConfigPath = join(resolveMemoryRuntimePaths({ home: root, env }).dataDir, 'config.json');
    let sidecarSeed = 'existing';
    if (!existsSync(sidecarConfigPath)) {
      try {
        await mkdir(dirname(sidecarConfigPath), { recursive: true, mode: 0o700 });
        await writeJsonAtomic(sidecarConfigPath, { schema: 1, model: { source: 'auto' } });
        sidecarSeed = 'created';
      } catch (error) {
        return {
          ok: false,
          reason: 'sidecar_seed_failed',
          error: String(error?.code ?? error?.message ?? error),
        };
      }
    }

    const next = withMemoryRuntimeEnabled(config);
    try {
      await writeJsonAtomic(configFile, next);
    } catch (error) {
      return {
        ok: false,
        reason: 'config_write_failed',
        error: String(error?.code ?? error?.message ?? error),
        sidecarSeed,
      };
    }

    const done = await markFirstRunDone({ home: root, marker, now });
    return {
      ok: true,
      initialized: true,
      enabled: true,
      source: sidecarSeed === 'created' ? 'auto' : 'existing',
      sidecarSeed,
      markerState: done?.state ?? marker.state,
    };
  } catch (error) {
    return {
      ok: false,
      reason: error?.code === 'config_invalid' ? 'config_invalid' : 'first_run_init_failed',
      error: String(error?.code ?? error?.message ?? error),
    };
  } finally {
    await release().catch(() => undefined);
  }
}

/** `first-run.json` 是否存在（诊断用；不创建目录）。 */
export async function firstRunMarkerExists({ home } = {}) {
  if (typeof home !== 'string' || home.length === 0) return false;
  try {
    const info = await stat(firstRunPath(home));
    return info.isFile();
  } catch {
    return false;
  }
}
