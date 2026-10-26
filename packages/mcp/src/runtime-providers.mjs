// 共享 Runtime provider 注册表：`<cloudRoot>/runtime-providers.json`。
//
// 只记录可发现的 runtime 来源（kind/path/version/capabilities），**不记录**令牌、身份、
// 私钥、主密钥或任何会泄漏到另一个入口的秘密。读取不做锁（原子 rename 保证读到完整
// 版本）；写入/移除经 `runtime-providers.lock` 串行化，tmp → rename 原子落盘。
//
// Phase 1 只消费 App/CLI/shared 三类 provider；下载、安装、升级属于后续阶段。

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { cloudError, pidAlive } from './profiles.mjs';

export const RUNTIME_PROVIDERS_FILE = 'runtime-providers.json';
export const RUNTIME_PROVIDERS_LOCK_FILE = 'runtime-providers.lock';
export const RUNTIME_PROVIDERS_VERSION = 1;
export const RUNTIME_PROVIDER_KINDS = ['app', 'cli', 'shared'];

const PROVIDER_KIND_SET = new Set(RUNTIME_PROVIDER_KINDS);
const CAPABILITY_RE = /^[a-z0-9][a-z0-9_.:-]{0,63}$/i;
const VERSION_RE = /^[0-9A-Za-z.+_-]{1,64}$/;

export function runtimeProvidersPath(root) {
  return join(root, RUNTIME_PROVIDERS_FILE);
}

export function runtimeProvidersLockPath(root) {
  return join(root, RUNTIME_PROVIDERS_LOCK_FILE);
}

export function emptyRuntimeProviders() {
  return { v: RUNTIME_PROVIDERS_VERSION, providers: [] };
}

/** 稳定 id：kind + 规范化路径的 sha256 前 12 hex（不含机器/用户信息以外的字段）。 */
export function runtimeProviderId(kind, path) {
  return createHash('sha256').update(`${kind}\n${resolve(path)}`).digest('hex').slice(0, 12);
}

function isIsoTime(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function normalizeCapabilities(value) {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  const out = [];
  for (const item of list) {
    if (typeof item !== 'string') {
      throw cloudError('RUNTIME_PROVIDER_INVALID', 'provider capabilities 必须是字符串数组');
    }
    const capability = item.trim();
    if (capability.length === 0) continue;
    if (!CAPABILITY_RE.test(capability)) {
      throw cloudError('RUNTIME_PROVIDER_INVALID', `provider capability 非法：${capability}`);
    }
    if (!out.includes(capability)) out.push(capability);
  }
  return out;
}

function normalizeVersion(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw cloudError('RUNTIME_PROVIDER_INVALID_VERSION', 'provider version 必须是字符串或 null');
  }
  const version = value.trim();
  if (version.length === 0) return null;
  if (!VERSION_RE.test(version)) {
    throw cloudError('RUNTIME_PROVIDER_INVALID_VERSION', `provider version 非法：${version}`);
  }
  return version;
}

/**
 * 规范化单条 provider：只保留 id/kind/path/version/capabilities/registeredAt/updatedAt。
 * 未知字段（例如 token/identity）一律丢弃，避免注册表被当成秘密仓库。
 */
export function normalizeRuntimeProvider(input, { now = new Date().toISOString() } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw cloudError('RUNTIME_PROVIDER_INVALID', 'provider 必须是对象');
  }
  const kind = input.kind;
  if (typeof kind !== 'string' || !PROVIDER_KIND_SET.has(kind)) {
    throw cloudError(
      'RUNTIME_PROVIDER_INVALID_KIND',
      `provider kind 必须是 ${RUNTIME_PROVIDER_KINDS.join(' / ')}`,
    );
  }
  if (typeof input.path !== 'string' || input.path.trim().length === 0) {
    throw cloudError('RUNTIME_PROVIDER_INVALID_PATH', 'provider path 不能为空');
  }
  const rawPath = input.path.trim();
  if (!isAbsolute(rawPath)) {
    throw cloudError('RUNTIME_PROVIDER_INVALID_PATH', 'provider path 必须是绝对路径');
  }
  const path = resolve(rawPath);
  const registeredAt = isIsoTime(input.registeredAt) ? input.registeredAt : now;
  const updatedAt = isIsoTime(input.updatedAt) ? input.updatedAt : now;
  return {
    id: runtimeProviderId(kind, path),
    kind,
    path,
    version: normalizeVersion(input.version),
    capabilities: normalizeCapabilities(input.capabilities),
    registeredAt,
    updatedAt,
  };
}

function normalizeRegistry(raw, { strict = false } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    if (strict) throw cloudError('RUNTIME_PROVIDERS_INVALID', 'provider 注册表必须是对象');
    return { registry: emptyRuntimeProviders(), warnings: ['provider 注册表形状非法'] };
  }
  if (raw.v !== RUNTIME_PROVIDERS_VERSION) {
    if (strict) {
      throw cloudError('RUNTIME_PROVIDERS_INVALID', `provider 注册表版本必须是 v${RUNTIME_PROVIDERS_VERSION}`);
    }
    return { registry: emptyRuntimeProviders(), warnings: [`provider 注册表版本不支持：${raw.v}`] };
  }
  if (!Array.isArray(raw.providers)) {
    if (strict) throw cloudError('RUNTIME_PROVIDERS_INVALID', 'provider 注册表 providers 必须是数组');
    return { registry: emptyRuntimeProviders(), warnings: ['provider 注册表 providers 非数组'] };
  }

  const warnings = [];
  const providers = [];
  const seen = new Set();
  for (const [index, entry] of raw.providers.entries()) {
    try {
      const provider = normalizeRuntimeProvider(entry);
      if (seen.has(provider.id)) {
        warnings.push(`provider 重复（第 ${index + 1} 条）：${provider.id}`);
        continue;
      }
      seen.add(provider.id);
      providers.push(provider);
    } catch (error) {
      if (strict) throw error;
      warnings.push(`provider 第 ${index + 1} 条无效：${error?.message ?? error}`);
    }
  }
  return { registry: { v: RUNTIME_PROVIDERS_VERSION, providers }, warnings };
}

async function readJsonFile(path) {
  try {
    return { ok: true, value: JSON.parse(await readFile(path, 'utf-8')) };
  } catch (error) {
    return { ok: false, missing: error?.code === 'ENOENT', error };
  }
}

/**
 * 读取注册表（不抛错）：
 *   - 不存在 → 空注册表；
 *   - 损坏/未知版本 → 空注册表 + warning（不阻塞 attach/service，只影响 provider 发现）。
 */
export async function readRuntimeProviders(root) {
  if (typeof root !== 'string' || root.length === 0) {
    return { registry: emptyRuntimeProviders(), source: 'unavailable', warnings: ['cloudRoot 不可用'] };
  }
  const main = await readJsonFile(runtimeProvidersPath(root));
  if (!main.ok) {
    if (main.missing) return { registry: emptyRuntimeProviders(), source: 'missing', warnings: [] };
    return {
      registry: emptyRuntimeProviders(),
      source: 'invalid',
      warnings: [`provider 注册表无法解析：${main.error?.message ?? main.error}`],
    };
  }
  const normalized = normalizeRegistry(main.value);
  return {
    registry: normalized.registry,
    source: normalized.warnings.length > 0 ? 'invalid' : 'main',
    warnings: normalized.warnings,
  };
}

/** 原子写注册表：tmp-<pid>(0600) → rename；写入前严格校验。 */
export async function writeRuntimeProviders(root, registry) {
  const normalized = normalizeRegistry(registry, { strict: true });
  await mkdir(root, { recursive: true });
  const path = runtimeProvidersPath(root);
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    await writeFile(tmp, `${JSON.stringify(normalized.registry, null, 2)}\n`, { mode: 0o600 });
    await chmod(tmp, 0o600).catch(() => undefined);
    await rename(tmp, path);
    await chmod(path, 0o600).catch(() => undefined);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** 注册表读改写锁（wx + PID 存活 + 陈旧回收）；临界区只做文件操作。 */
export async function withRuntimeProvidersLock(root, fn) {
  await mkdir(root, { recursive: true });
  const path = runtimeProvidersLockPath(root);
  const payload = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
  const acquire = async () => writeFile(path, payload, { mode: 0o600, flag: 'wx' });

  let acquired = false;
  try {
    await acquire();
    acquired = true;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    let held = null;
    try {
      held = JSON.parse(await readFile(path, 'utf-8'));
    } catch {
      held = null;
    }
    if (held?.pid && pidAlive(held.pid)) {
      throw cloudError(
        'RUNTIME_PROVIDERS_LOCKED',
        `runtime provider 注册表正被其他进程写入（pid ${held.pid}）；请稍后重试`,
        { pid: held.pid },
      );
    }
    await rm(path, { force: true }).catch(() => undefined);
    try {
      await acquire();
      acquired = true;
    } catch (retryError) {
      if (retryError?.code === 'EEXIST') {
        throw cloudError('RUNTIME_PROVIDERS_LOCKED', 'runtime provider 注册表正被其他进程写入；请稍后重试');
      }
      throw retryError;
    }
  }

  try {
    return await fn();
  } finally {
    if (acquired) {
      try {
        const held = JSON.parse(await readFile(path, 'utf-8'));
        if (held?.pid === process.pid) await rm(path, { force: true });
      } catch {
        // 已被回收/删除：无需处理
      }
    }
  }
}

function assertWritable(state) {
  if (state.source === 'invalid') {
    throw cloudError(
      'RUNTIME_PROVIDERS_INVALID',
      `runtime provider 注册表损坏：${state.warnings?.[0] ?? '无法解析'}；请先修复或删除 ${RUNTIME_PROVIDERS_FILE}`,
    );
  }
}

/** 注册/更新 provider（同一 kind+path 覆盖 version/capabilities，保留 registeredAt）。 */
export async function registerRuntimeProvider(root, input, { now = new Date().toISOString() } = {}) {
  return withRuntimeProvidersLock(root, async () => {
    const state = await readRuntimeProviders(root);
    assertWritable(state);
    const provider = normalizeRuntimeProvider(input, { now });
    const providers = state.registry.providers.map((entry) => ({ ...entry }));
    const index = providers.findIndex((entry) => entry.id === provider.id);
    let created = false;
    if (index >= 0) {
      provider.registeredAt = providers[index].registeredAt;
      providers[index] = provider;
    } else {
      providers.push(provider);
      created = true;
    }
    await writeRuntimeProviders(root, { v: RUNTIME_PROVIDERS_VERSION, providers });
    return { provider, created, warnings: state.warnings };
  });
}

function sameCapabilities(left, right) {
  const a = Array.isArray(left) ? left : [];
  const b = Array.isArray(right) ? right : [];
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

/**
 * 注册**单实例 kind** 的 provider：在同一把 `runtime-providers.lock` 内原子替换该 kind 的全部记录。
 *
 * 语义（App = kind:app 单入口）：
 *   - 同一 kind+path：更新 version/capabilities，保留 registeredAt；
 *   - 路径变化：删除该 kind 的旧 path 记录，只保留当前一条（避免旧 App runtime 被优先选中）；
 *   - 只影响输入 provider 的 kind；CLI/shared 等其他 kind 原样保留；
 *   - 内容完全一致时返回 unchanged，不重写文件；
 *   - 注册表损坏 → assertWritable fail-closed，不覆盖。
 *
 * 不使用方必须保证该 kind 在本机确实单实例；多实例 kind 用 registerRuntimeProvider。
 */
export async function registerExclusiveRuntimeProvider(root, input, { now = new Date().toISOString() } = {}) {
  return withRuntimeProvidersLock(root, async () => {
    const state = await readRuntimeProviders(root);
    assertWritable(state);
    const provider = normalizeRuntimeProvider(input, { now });
    const previous = state.registry.providers;
    const samePath = previous.find((entry) => entry.id === provider.id) ?? null;
    if (samePath !== null) provider.registeredAt = samePath.registeredAt;

    const sameKind = previous.filter((entry) => entry.kind === provider.kind);
    const unchanged = sameKind.length === 1
      && samePath !== null
      && samePath.version === provider.version
      && sameCapabilities(samePath.capabilities, provider.capabilities);
    if (unchanged) {
      return {
        provider: { ...samePath },
        created: false,
        unchanged: true,
        replaced: [],
        warnings: state.warnings,
      };
    }

    const replaced = sameKind.filter((entry) => entry.id !== provider.id);
    const providers = previous.filter((entry) => entry.kind !== provider.kind);
    providers.push(provider);
    await writeRuntimeProviders(root, { v: RUNTIME_PROVIDERS_VERSION, providers });
    return {
      provider,
      created: sameKind.length === 0,
      unchanged: false,
      replaced,
      warnings: state.warnings,
    };
  });
}

/**
 * 移除 provider：按 id，或按 kind + path。
 * 不存在 → RUNTIME_PROVIDER_NOT_FOUND（调用方显式处理，不静默成功）。
 */
export async function removeRuntimeProvider(root, { id, kind, path } = {}) {
  return withRuntimeProvidersLock(root, async () => {
    const state = await readRuntimeProviders(root);
    assertWritable(state);
    let targetId = typeof id === 'string' && id.length > 0 ? id : null;
    if (targetId === null && typeof kind === 'string' && typeof path === 'string' && path.length > 0) {
      if (!PROVIDER_KIND_SET.has(kind)) {
        throw cloudError('RUNTIME_PROVIDER_INVALID_KIND', `provider kind 非法：${kind}`);
      }
      if (!isAbsolute(path)) {
        throw cloudError('RUNTIME_PROVIDER_INVALID_PATH', 'provider path 必须是绝对路径');
      }
      targetId = runtimeProviderId(kind, path);
    }
    if (targetId === null) {
      throw cloudError('RUNTIME_PROVIDER_INVALID', '移除 provider 需要 id，或 kind + path');
    }
    const target = state.registry.providers.find((entry) => entry.id === targetId) ?? null;
    if (target === null) {
      throw cloudError('RUNTIME_PROVIDER_NOT_FOUND', `未找到 provider：${targetId}`);
    }
    const providers = state.registry.providers.filter((entry) => entry.id !== targetId);
    await writeRuntimeProviders(root, { v: RUNTIME_PROVIDERS_VERSION, providers });
    return { removed: target, warnings: state.warnings };
  });
}

/** 列出 provider（附带路径是否存在，便于 CLI 诊断；不修改注册表）。 */
export async function listRuntimeProviders(root) {
  const state = await readRuntimeProviders(root);
  return {
    ...state,
    providers: state.registry.providers.map((provider) => ({
      ...provider,
      available: existsSync(provider.path),
    })),
  };
}
