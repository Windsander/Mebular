// 共享 Runtime current 指针：`<cloudRoot>/runtime/current.json`。
//
// 只记录**非敏感**的安装事实：version / runtimePath / cliPath / provider / owner /
// installedAt。读取时同时做结构校验与安装完整性校验（包名、版本、CLI 文件），因此
// provider 发现不会选中半成品目录；损坏/缺失/无效一律回退为 empty 并带 warning，
// 不阻塞 attach/service/status。
//
// 写入是 tmp → rename 的原子替换；调用方（installer/upgrade/plugin bootstrap）负责在
// 安装锁/启动锁内调用，保证同一时刻只有一个写者。

import { existsSync, readFileSync, statSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { cloudError } from './profiles.mjs';
import {
  RUNTIME_PACKAGE_NAME,
  RUNTIME_PACKAGE_RELATIVE,
  assertRuntimeVersion,
} from './runtime-layout.mjs';

export const RUNTIME_CURRENT_FILE = 'current.json';
export const RUNTIME_CURRENT_VERSION = 1;
export const RUNTIME_CURRENT_PROVIDERS = Object.freeze(['shared']);
export const RUNTIME_CURRENT_OWNERS = Object.freeze(['shared', 'app', 'cli']);

const OWNER_RE = /^[a-z0-9][a-z0-9_.:-]{0,63}$/i;

export function runtimeCurrentPath(root) {
  return join(root, 'runtime', RUNTIME_CURRENT_FILE);
}

function isIsoTime(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function assertAbsolutePath(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0 || !isAbsolute(value.trim())) {
    throw cloudError('RUNTIME_CURRENT_INVALID', `current.${field} 必须是绝对路径`);
  }
  return resolve(value.trim());
}

function normalizeOwner(value) {
  if (value === undefined || value === null || value === '') return 'shared';
  if (typeof value !== 'string' || !OWNER_RE.test(value.trim())) {
    throw cloudError('RUNTIME_CURRENT_INVALID', 'current.owner 非法');
  }
  const owner = value.trim();
  if (!RUNTIME_CURRENT_OWNERS.includes(owner)) {
    throw cloudError('RUNTIME_CURRENT_INVALID', `current.owner 必须是 ${RUNTIME_CURRENT_OWNERS.join(' / ')}`);
  }
  return owner;
}

function normalizeProvider(value) {
  if (value === undefined || value === null || value === '') return 'shared';
  if (typeof value !== 'string' || !RUNTIME_CURRENT_PROVIDERS.includes(value.trim())) {
    throw cloudError('RUNTIME_CURRENT_INVALID', `current.provider 必须是 ${RUNTIME_CURRENT_PROVIDERS.join(' / ')}`);
  }
  return value.trim();
}

/**
 * 结构规范化（写入严格；读取时异常会转成 invalid 状态）。
 * 只保留白名单字段，避免 current.json 变成秘密/任意字段仓库。
 */
export function normalizeRuntimeCurrent(input, { now = new Date().toISOString() } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw cloudError('RUNTIME_CURRENT_INVALID', 'current 必须是对象');
  }
  if (input.v !== undefined && input.v !== RUNTIME_CURRENT_VERSION) {
    throw cloudError('RUNTIME_CURRENT_INVALID', `current 版本必须是 v${RUNTIME_CURRENT_VERSION}`);
  }
  const version = assertRuntimeVersion(input.version);
  const runtimePath = assertAbsolutePath(input.runtimePath, 'runtimePath');
  const cliPath = assertAbsolutePath(input.cliPath, 'cliPath');
  const provider = normalizeProvider(input.provider);
  const owner = normalizeOwner(input.owner);
  const installedAt = isIsoTime(input.installedAt) ? input.installedAt : now;
  return {
    v: RUNTIME_CURRENT_VERSION,
    version,
    runtimePath,
    cliPath,
    provider,
    owner,
    installedAt,
  };
}

function readJsonFileSync(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

function inspectInstalledLayoutSync(current) {
  try {
    if (!statSync(current.runtimePath).isDirectory()) {
      return { ok: false, reason: 'runtime_missing', detail: 'runtime_path_not_directory' };
    }
  } catch {
    return { ok: false, reason: 'runtime_missing', detail: 'runtime_path_missing' };
  }
  if (!existsSync(current.cliPath)) {
    return { ok: false, reason: 'cli_missing', detail: 'cli_path_missing' };
  }
  try {
    const info = statSync(current.cliPath);
    if (!info.isFile()) {
      return { ok: false, reason: 'cli_missing', detail: 'cli_not_file' };
    }
  } catch {
    return { ok: false, reason: 'cli_missing', detail: 'cli_unreadable' };
  }
  const packagePath = join(current.runtimePath, RUNTIME_PACKAGE_RELATIVE);
  const manifest = readJsonFileSync(packagePath);
  if (!manifest || typeof manifest !== 'object') {
    return { ok: false, reason: 'package_missing', detail: 'package_json_missing' };
  }
  if (manifest.name !== undefined && manifest.name !== RUNTIME_PACKAGE_NAME) {
    return { ok: false, reason: 'package_mismatch', detail: 'package_name_mismatch' };
  }
  if (manifest.version !== current.version) {
    return { ok: false, reason: 'package_mismatch', detail: 'package_version_mismatch' };
  }
  return { ok: true };
}

async function readJsonFile(path) {
  try {
    return { ok: true, value: JSON.parse(await readFile(path, 'utf-8')) };
  } catch (error) {
    return { ok: false, missing: error?.code === 'ENOENT', error };
  }
}

/**
 * 读取 current（永不抛错）。
 *
 * `source`：
 *   - `main`：文件有效且指向完整安装；
 *   - `missing`：没有 current（合法）；
 *   - `invalid`：文件损坏/字段非法/指向半成品；调用方必须回退到旧 provider 规则并 warning。
 */
export async function readRuntimeCurrent(root, { userHome = homedir() } = {}) {
  const base = { current: null, source: 'missing', usable: false, warnings: [] };
  if (typeof root !== 'string' || root.length === 0) {
    return { ...base, source: 'unavailable', warnings: ['cloudRoot 不可用'] };
  }
  const path = runtimeCurrentPath(root);
  const raw = await readJsonFile(path);
  if (!raw.ok) {
    if (raw.missing) return base;
    return {
      ...base,
      source: 'invalid',
      warnings: [`runtime current 无法解析：${displayCurrentPath(path, userHome)}`],
    };
  }

  let current;
  try {
    current = normalizeRuntimeCurrent(raw.value);
  } catch (error) {
    return {
      ...base,
      source: 'invalid',
      warnings: [`runtime current 无效：${error?.message ?? error}`],
    };
  }

  const inspected = inspectInstalledLayoutSync(current);
  if (!inspected.ok) {
    return {
      current,
      source: 'invalid',
      usable: false,
      warnings: [`runtime current 指向不可用的 runtime（${inspected.reason}/${inspected.detail}）：${displayCurrentPath(path, userHome)}`],
    };
  }
  return { current, source: 'main', usable: true, warnings: [] };
}

function displayCurrentPath(path, userHome) {
  const resolved = resolve(path);
  const home = typeof userHome === 'string' && userHome.length > 0 ? resolve(userHome) : null;
  if (home !== null && (resolved === home || resolved.startsWith(`${home}/`))) {
    return `~${resolved.slice(home.length)}`;
  }
  return resolved;
}

/**
 * 原子写 current：tmp-<pid>(0600) → rename（0600）。
 * 输入先严格校验；`installedAt` 缺省用 now。
 */
export async function writeRuntimeCurrent(root, input, { now = new Date().toISOString() } = {}) {
  if (typeof root !== 'string' || root.length === 0) {
    throw cloudError('CLOUD_UNAVAILABLE', '缺少 cloudRoot，无法写 runtime current');
  }
  const current = normalizeRuntimeCurrent({ ...input, v: input?.v ?? RUNTIME_CURRENT_VERSION }, { now });
  const dir = join(root, 'runtime');
  await mkdir(dir, { recursive: true });
  const path = runtimeCurrentPath(root);
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    await writeFile(tmp, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
    await chmod(tmp, 0o600).catch(() => undefined);
    await rename(tmp, path);
    await chmod(path, 0o600).catch(() => undefined);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
  return current;
}

/** 清除 current（只用于回滚/测试；不删除 runtime 目录本身）。 */
export async function clearRuntimeCurrent(root) {
  if (typeof root !== 'string' || root.length === 0) return false;
  await rm(runtimeCurrentPath(root), { force: true });
  return true;
}

/** 返回给 CLI/status 的非敏感摘要（不含任何秘密）。 */
export function publicRuntimeCurrent(current) {
  if (!current || typeof current !== 'object') return null;
  return {
    version: current.version ?? null,
    runtimePath: current.runtimePath ?? null,
    cliPath: current.cliPath ?? null,
    provider: current.provider ?? null,
    owner: current.owner ?? null,
    installedAt: current.installedAt ?? null,
  };
}
