// 忆云档案（profile）注册表：root 解析、v1 注册表读写、锁、默认条目合成、命名/指纹/路径安全。
//
// 红线：
//   - 默认忆云 = root 自身（~/.mebular），原地保留、不迁移、不 symlink。
//   - 注册表只存公开元数据（名字/相对路径/公开指纹），**不含**令牌、私钥、主密钥、TOTP 种子、恢复码。
//   - 已注册档案永不删除；删除只允许「本次独占创建且尚未注册」的目录（由调用方校验）。
//   - HTTP 不接受任意 home/path：id 只允许 `^[a-z0-9_]+$`，home 只允许 `.` / `profiles/<id>`。

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export const REGISTRY_FILE = 'profiles.json';
export const REGISTRY_LOCK_FILE = 'profiles.lock';
export const ACTIVE_LOCK_FILE = 'active.lock';
export const PROFILES_DIR = 'profiles';
export const DEFAULT_PROFILE_ID = 'default';
export const DEFAULT_PROFILE_NAME = '忆云 1';
export const REGISTRY_VERSION = 1;

const ID_RE = /^[a-z0-9_]+$/;
const PROFILE_HOME_RE = /^(.*)[\\/]profiles[\\/]([a-z0-9_]+)$/;
const FORBIDDEN_ENV = [
  'MEBULAR_CONFIG',
  'MEBULAR_STORAGE_PATH',
  'MEBULAR_USER_MASTER_KEY',
  'MEBULAR_USER_MASTER_KEY_FILE',
  'MEBULAR_ENDPOINTS_FILE',
];

/** 构造带稳定错误码的异常（HTTP 层按 code 映射状态码）。 */
export function cloudError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

export function registryPath(root) {
  return join(root, REGISTRY_FILE);
}

export function registryBakPath(root) {
  return `${registryPath(root)}.bak`;
}

export function registryLockPath(root) {
  return join(root, REGISTRY_LOCK_FILE);
}

export function activeLockPath(root) {
  return join(root, ACTIVE_LOCK_FILE);
}

export function defaultCloudHome({ userHome = homedir() } = {}) {
  return join(userHome, '.mebular');
}

/** 展示用路径：用户主目录前缀 → `~`；统一正斜杠（控制台跨平台一致，不含秘密）。 */
export function displayPath(path, { userHome = homedir() } = {}) {
  const toPosix = (value) => value.split(sep).join('/');
  const absolute = resolve(path);
  const home = resolve(userHome);
  if (absolute === home) return '~';
  if (absolute.startsWith(`${home}${sep}`)) return `~${toPosix(absolute.slice(home.length))}`;
  return toPosix(absolute);
}

/** host 是否位于 root 自身或 root/profiles/<id>（id 白名单）。 */
export function isHomeInRoot(root, home) {
  const rootPath = resolve(root);
  const homePath = resolve(home);
  if (homePath === rootPath) return true;
  const rel = relative(rootPath, homePath);
  if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) return false;
  const parts = rel.split(sep);
  return parts.length === 2 && parts[0] === PROFILES_DIR && ID_RE.test(parts[1]);
}

/**
 * 解析档案 root（唯一入口）：
 *   MEBULAR_CLOUD_ROOT > MEBULAR_HOME 形如 <root>/profiles/<id> 推 root > 默认 ~/.mebular
 * 其它自定义 home / 危险 env（会泄漏进新档案）→ 返回 available:false（CLOUD_UNAVAILABLE）。
 */
export function resolveCloudRoot({ home, env = process.env, userHome = homedir() } = {}) {
  const defaultHome = resolve(defaultCloudHome({ userHome }));
  const effectiveHome = resolve(home ?? env.MEBULAR_HOME ?? defaultHome);
  const unavailable = (reason, root = null) => ({
    available: false,
    root,
    home: effectiveHome,
    defaultHome,
    reason,
  });

  let root;
  const explicitRoot = typeof env.MEBULAR_CLOUD_ROOT === 'string' ? env.MEBULAR_CLOUD_ROOT.trim() : '';
  if (explicitRoot.length > 0) {
    root = resolve(explicitRoot);
  } else {
    const envHome = typeof env.MEBULAR_HOME === 'string' && env.MEBULAR_HOME.trim().length > 0
      ? resolve(env.MEBULAR_HOME)
      : null;
    if (envHome === null || envHome === defaultHome) {
      root = envHome ?? defaultHome;
    } else {
      const match = PROFILE_HOME_RE.exec(envHome);
      if (!match) return unavailable('custom_home');
      root = resolve(match[1]);
    }
  }

  const forbidden = FORBIDDEN_ENV.find((key) => typeof env[key] === 'string' && env[key].trim().length > 0);
  if (forbidden) return unavailable(`env:${forbidden}`, root);
  // 显式 CLOUD_ROOT 是 App/CLI 的内部契约（profile 子进程会同时给 MEBULAR_HOME），
  // 不再用 home 猜 root；只有从 MEBULAR_HOME 推导时才校验 home 必须位于 root 内。
  if (explicitRoot.length === 0 && !isHomeInRoot(root, effectiveHome)) {
    return unavailable('home_outside_root', root);
  }
  return { available: true, root, home: effectiveHome, defaultHome, reason: null };
}

function cloudRegistryInvalid(message, extra = {}) {
  return cloudError('CLOUD_REGISTRY_INVALID', message, extra);
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile(path) {
  try {
    return { ok: true, value: JSON.parse(await readFile(path, 'utf-8')) };
  } catch (error) {
    return { ok: false, missing: error?.code === 'ENOENT', error };
  }
}

function isIsoTime(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function inferKind(home, config) {
  const explicit = config?.identity?.mode;
  if (explicit === 'root' || explicit === 'delegated') return explicit;
  const storage = typeof config?.storagePath === 'string' && config.storagePath.length > 0
    ? resolve(home, config.storagePath)
    : join(home, 'store.jsonl');
  if (!existsSync(`${storage}.identity.json`)) return 'root';
  const masterFile = config?.encryption?.userMasterPublicKeyFile ?? join(home, 'user-master-key.json');
  try {
    const record = JSON.parse(readFileSync(masterFile, 'utf-8'));
    return typeof record.privateKeyPkcs8 === 'string' ? 'root' : 'delegated';
  } catch {
    return 'delegated';
  }
}

/**
 * 档案展示用 deviceId：身份文件优先；config.deviceId 仅旧布局回退（只读展示，不写盘）。
 * 运行期由 createMebular preflight 对无效/缺失身份 fail closed。
 */
function deviceIdForHome(home, config = {}) {
  const storage = typeof config?.storagePath === 'string' && config.storagePath.length > 0
    ? resolve(home, config.storagePath)
    : join(home, 'store.jsonl');
  try {
    const record = JSON.parse(readFileSync(`${storage}.identity.json`, 'utf-8'));
    if (typeof record?.deviceId === 'string' && record.deviceId.length > 0) return record.deviceId;
  } catch {
    // 身份文件缺失/损坏 → 旧布局回退。
  }
  return typeof config?.deviceId === 'string' ? config.deviceId : null;
}

/** 公开指纹：sha256(bytes) 前 12 hex。输入无效返回 null（不阻塞加入/展示）。 */
export function masterFingerprintFromBytes(bytes) {
  try {
    const buffer = Buffer.from(bytes);
    if (buffer.length === 0) return null;
    return `sha256:${createHash('sha256').update(buffer).digest('hex').slice(0, 12)}`;
  } catch {
    return null;
  }
}

export function masterFingerprintFromBase64(publicKey) {
  if (typeof publicKey !== 'string' || publicKey.length === 0) return null;
  try {
    return masterFingerprintFromBytes(Buffer.from(publicKey, 'base64'));
  } catch {
    return null;
  }
}

export function masterFingerprintFromHex(publicKeyHex) {
  if (typeof publicKeyHex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(publicKeyHex)) return null;
  try {
    return masterFingerprintFromBytes(Buffer.from(publicKeyHex, 'hex'));
  } catch {
    return null;
  }
}

/** 从 home 的公开主公钥文件算指纹；只读 publicKey，绝不读主私钥。 */
export function masterFingerprintForHome(home, config = null) {
  const candidates = [];
  if (typeof config?.encryption?.userMasterPublicKeyFile === 'string' && config.encryption.userMasterPublicKeyFile.length > 0) {
    candidates.push(resolve(home, config.encryption.userMasterPublicKeyFile));
  }
  candidates.push(join(home, 'user-master-key.json'), join(home, 'master-key.json'));
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const record = JSON.parse(readFileSync(file, 'utf-8'));
      const fingerprint = masterFingerprintFromBase64(record?.publicKey);
      if (fingerprint !== null) return fingerprint;
    } catch {
      // 文件损坏 → 下一个候选；不阻塞
    }
  }
  return null;
}

/** 注册表缺省时在内存里合成默认忆云（不写盘）。 */
function synthesizeDefaultRegistry(home) {
  const configFile = join(home, 'config.json');
  if (!existsSync(configFile)) {
    return { v: REGISTRY_VERSION, current: null, profiles: [] };
  }
  let config = {};
  try {
    config = JSON.parse(readFileSync(configFile, 'utf-8'));
  } catch {
    config = {};
  }
  let createdAt = new Date().toISOString();
  try {
    const stat = statSync(configFile);
    const ms = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
    if (Number.isFinite(ms) && ms > 0) createdAt = new Date(ms).toISOString();
  } catch {
    // 保持当前时间
  }
  return {
    v: REGISTRY_VERSION,
    current: DEFAULT_PROFILE_ID,
    profiles: [{
      id: DEFAULT_PROFILE_ID,
      name: DEFAULT_PROFILE_NAME,
      home: '.',
      kind: inferKind(home, config),
      createdAt,
      lastUsedAt: null,
      masterFingerprint: masterFingerprintForHome(home, config),
      deviceId: deviceIdForHome(home, config),
    }],
  };
}

function validateRegistry(home, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw cloudRegistryInvalid('注册表形状非法（应为对象）');
  }
  if (!Number.isInteger(raw.v) || raw.v < 1) {
    throw cloudRegistryInvalid('注册表版本非法');
  }
  if (raw.v > REGISTRY_VERSION) {
    throw cloudRegistryInvalid(`注册表版本 ${raw.v} 高于本机支持的 v${REGISTRY_VERSION}：请升级后重试`, { reason: 'version' });
  }
  if (!Array.isArray(raw.profiles)) {
    throw cloudRegistryInvalid('注册表 profiles 非数组');
  }
  const seen = new Set();
  const profiles = raw.profiles.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw cloudRegistryInvalid(`第 ${index + 1} 个档案条目形状非法`);
    }
    if (typeof entry.id !== 'string' || !ID_RE.test(entry.id)) {
      throw cloudRegistryInvalid(`第 ${index + 1} 个档案 id 非法`);
    }
    if (seen.has(entry.id)) throw cloudRegistryInvalid(`档案 id 重复：${entry.id}`);
    seen.add(entry.id);
    const expectedHome = entry.id === DEFAULT_PROFILE_ID ? '.' : `${PROFILES_DIR}/${entry.id}`;
    if (entry.home !== expectedHome) {
      throw cloudRegistryInvalid(`档案 ${entry.id} 的 home 必须是 ${expectedHome}`);
    }
    if (typeof entry.name !== 'string' || entry.name.trim().length === 0) {
      throw cloudRegistryInvalid(`档案 ${entry.id} 缺少名字`);
    }
    if (typeof entry.kind !== 'string' || !['root', 'delegated'].includes(entry.kind)) {
      throw cloudRegistryInvalid(`档案 ${entry.id} 的 kind 非法`);
    }
    if (entry.masterFingerprint !== null && entry.masterFingerprint !== undefined
      && (typeof entry.masterFingerprint !== 'string' || !/^sha256:[0-9a-f]{12}$/.test(entry.masterFingerprint))) {
      throw cloudRegistryInvalid(`档案 ${entry.id} 的指纹格式非法`);
    }
    if (entry.createdAt !== undefined && !isIsoTime(entry.createdAt)) {
      throw cloudRegistryInvalid(`档案 ${entry.id} 的 createdAt 非法`);
    }
    // 旧 registry 没有 nameUpdatedAt（迁移：用 createdAt/null 回退，不拒绝）。
    if (entry.nameUpdatedAt !== null && entry.nameUpdatedAt !== undefined && !isIsoTime(entry.nameUpdatedAt)) {
      throw cloudRegistryInvalid(`档案 ${entry.id} 的 nameUpdatedAt 非法`);
    }
    if (entry.lastUsedAt !== null && entry.lastUsedAt !== undefined && !isIsoTime(entry.lastUsedAt)) {
      throw cloudRegistryInvalid(`档案 ${entry.id} 的 lastUsedAt 非法`);
    }
    if (entry.deviceId !== null && entry.deviceId !== undefined && typeof entry.deviceId !== 'string') {
      throw cloudRegistryInvalid(`档案 ${entry.id} 的 deviceId 非法`);
    }
    // 路径 containment：默认 home 必须就是 root；其它必须是 root 内 root/profiles/<id>。
    const entryHome = resolve(home, expectedHome);
    if (!isHomeInRoot(home, entryHome)) {
      throw cloudRegistryInvalid(`档案 ${entry.id} 的 home 越界`);
    }
    return entry;
  });
  return {
    ...raw,
    v: REGISTRY_VERSION,
    current: typeof raw.current === 'string' ? raw.current : null,
    profiles,
  };
}

/**
 * 读注册表（不写盘）：
 *   主文件解析失败 → .bak；再失败 → CLOUD_REGISTRY_INVALID（fail-closed，不自动重建）。
 *   注册表不存在但有 config.json → 内存合成默认忆云（第一次改名/切换/加入才落盘）。
 */
export async function readRegistry(home) {
  const main = await readJsonFile(registryPath(home));
  let raw = null;
  let source = 'synthesized';
  if (main.ok) {
    raw = main.value;
    source = 'main';
  } else if (!main.missing) {
    const backup = await readJsonFile(registryBakPath(home));
    if (!backup.ok) throw cloudRegistryInvalid('注册表主文件与 .bak 都无法解析（fail-closed）');
    raw = backup.value;
    source = 'bak';
  } else {
    const backup = await readJsonFile(registryBakPath(home));
    if (backup.ok) {
      raw = backup.value;
      source = 'bak';
    } else if (!backup.missing) {
      throw cloudRegistryInvalid('注册表不存在且 .bak 无法解析（fail-closed）');
    }
  }

  if (raw === null) {
    return { registry: synthesizeDefaultRegistry(home), source: 'synthesized', synthesized: true, warning: null };
  }
  const registry = validateRegistry(home, raw);
  let warning = null;
  const ids = new Set(registry.profiles.map((entry) => entry.id));
  if (registry.current === null || !ids.has(registry.current)) {
    const fallback = ids.has(DEFAULT_PROFILE_ID) ? DEFAULT_PROFILE_ID : (registry.profiles[0]?.id ?? null);
    warning = `当前忆云不存在，已回退到 ${fallback ?? '（无）'}`;
    registry.current = fallback;
  }
  return { registry, source, synthesized: false, warning };
}

/** 原子写注册表：tmp-<pid>(0600) → rename；rename 前把上一版复制为 .bak。 */
export async function writeRegistry(home, registry) {
  if (!registry || typeof registry !== 'object' || registry.v !== REGISTRY_VERSION) {
    throw cloudRegistryInvalid('拒绝写入非 v1 注册表');
  }
  await mkdir(home, { recursive: true });
  const path = registryPath(home);
  const tmp = `${path}.tmp-${process.pid}`;
  const text = `${JSON.stringify(registry, null, 2)}\n`;
  try {
    await writeFile(tmp, text, { mode: 0o600 });
    await chmod(tmp, 0o600).catch(() => undefined);
    if (existsSync(path)) {
      try {
        // 只把**可解析的上一次成功版本**复制为 .bak；主文件已损坏时保留现有 .bak。
        JSON.parse(await readFile(path, 'utf-8'));
        await copyFile(path, registryBakPath(home));
        await chmod(registryBakPath(home), 0o600);
      } catch {
        // .bak 只是恢复兜底；复制失败不阻塞本次成功写入
      }
    }
    await rename(tmp, path);
    await chmod(path, 0o600).catch(() => undefined);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** 注册表读改写锁（wx + PID 存活 + 陈旧回收）；临界区只做文件操作。 */
export async function withRegistryLock(home, fn) {
  await mkdir(home, { recursive: true });
  const path = registryLockPath(home);
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
        'CLOUD_REGISTRY_LOCKED',
        `忆云注册表正被其他进程写入（pid ${held.pid}）；请稍后重试`,
        { pid: held.pid },
      );
    }
    await rm(path, { force: true }).catch(() => undefined);
    try {
      await acquire();
      acquired = true;
    } catch (retryError) {
      if (retryError?.code === 'EEXIST') {
        throw cloudError('CLOUD_REGISTRY_LOCKED', '忆云注册表正被其他进程写入；请稍后重试');
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

/** 读改写：保留未知字段（向前兼容），写入前校验 v1。 */
export async function mutateRegistry(home, mutator) {
  return withRegistryLock(home, async () => {
    const state = await readRegistry(home);
    const draft = {
      ...state.registry,
      profiles: state.registry.profiles.map((entry) => ({ ...entry })),
    };
    const value = await mutator(draft, state);
    const registry = { ...draft, v: REGISTRY_VERSION };
    await writeRegistry(home, registry);
    return { registry, value, source: state.source, warning: state.warning };
  });
}

function sameName(a, b) {
  return String(a).trim().toLocaleLowerCase() === String(b).trim().toLocaleLowerCase();
}

/**
 * 名字：与 core `normalizeDisplayName` 同一口径（去控制字符/trim；1–24 Unicode 字符；
 * 拒绝 `/`、`\`、`..`）。**不在这里 import @mebular/core**：profiles.mjs 也被 Jest
 * `--coverage` 的 ESM 链接直接加载，core 桶会触发命名导出链接错误；口径一致性由
 * `tests/sync/display-name-parity.test.ts` 的对照用例锁定。
 */
export function normalizeProfileName(raw) {
  if (typeof raw !== 'string') throw cloudError('INVALID_NAME', '忆云名字必须是字符串');
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (name.length === 0) throw cloudError('INVALID_NAME', '忆云名字不能为空');
  if (name.includes('/') || name.includes('\\')) throw cloudError('INVALID_NAME', '忆云名字不能包含 / 或 \\');
  if (name.includes('..')) throw cloudError('INVALID_NAME', '忆云名字不能包含 ..');
  if ([...name].length > 24) throw cloudError('INVALID_NAME', '忆云名字最多 24 个字符');
  return name;
}

/** 新档案默认名：未占用的最小整数 N >= 2 → 忆云 N（大小写不敏感）。 */
export function nextProfileName(profiles) {
  for (let n = 2; n < 10_000; n += 1) {
    const candidate = `忆云 ${n}`;
    if (!profiles.some((entry) => sameName(entry.name, candidate))) return candidate;
  }
  return `忆云 ${Date.now()}`;
}

export function newProfileId(profiles, { random = randomBytes } = {}) {
  const used = new Set(profiles.map((entry) => entry.id));
  for (let i = 0; i < 100; i += 1) {
    const id = `p_${random(4).toString('hex')}`;
    if (!used.has(id)) return id;
  }
  throw cloudError('PROFILE_ID_EXHAUSTED', '无法分配新的忆云 id');
}

/**
 * 注册档案（锁内校验 id/名字/指纹重复）；current 不变。
 * 成功返回 { registry, value: entry }；失败不写盘。
 */
export async function registerProfile(home, input = {}) {
  return mutateRegistry(home, (registry) => {
    const id = input.id;
    if (typeof id !== 'string' || !ID_RE.test(id)) {
      throw cloudError('INVALID_PROFILE_ID', '忆云 id 非法');
    }
    if (registry.profiles.some((entry) => entry.id === id)) {
      throw cloudError('PROFILE_EXISTS', `忆云 ${id} 已存在`);
    }
    const name = input.name === undefined
      ? nextProfileName(registry.profiles)
      : normalizeProfileName(input.name);
    if (registry.profiles.some((entry) => sameName(entry.name, name))) {
      throw cloudError('NAME_TAKEN', '已有同名忆云，请换一个名字');
    }
    const masterFingerprint = typeof input.masterFingerprint === 'string' ? input.masterFingerprint : null;
    if (masterFingerprint !== null) {
      const existing = registry.profiles.find((entry) => entry.masterFingerprint === masterFingerprint);
      if (existing) {
        throw cloudError(
          'CLOUD_ALREADY_JOINED',
          `这台设备已加入「${existing.name}」，可直接切换`,
          { existing: { id: existing.id, name: existing.name } },
        );
      }
    }
    const entry = {
      id,
      name,
      home: id === DEFAULT_PROFILE_ID ? '.' : `${PROFILES_DIR}/${id}`,
      kind: input.kind === 'delegated' ? 'delegated' : 'root',
      createdAt: isIsoTime(input.createdAt) ? input.createdAt : new Date().toISOString(),
      lastUsedAt: null,
      masterFingerprint,
      deviceId: typeof input.deviceId === 'string' ? input.deviceId : null,
    };
    registry.profiles = [...registry.profiles, entry];
    return entry;
  });
}

/** 改名（current 不变；大小写不敏感重名拒绝）。 */
export async function renameProfile(home, id, rawName) {
  return mutateRegistry(home, (registry) => {
    const entry = registry.profiles.find((profile) => profile.id === id);
    if (!entry) throw cloudError('PROFILE_NOT_FOUND', `未找到忆云：${id}`);
    const name = normalizeProfileName(rawName);
    if (registry.profiles.some((profile) => profile.id !== id && sameName(profile.name, name))) {
      throw cloudError('NAME_TAKEN', '已有同名忆云，请换一个名字');
    }
    entry.name = name;
    // 本机 registry 缓存时间：重名时判断“最近更新”的依据；旧条目缺失时回退 createdAt。
    entry.nameUpdatedAt = new Date().toISOString();
    return entry;
  });
}

/** 写 current（切换引擎在停旧后、起新前调用）；可同时更新 lastUsedAt。 */
export async function setCurrentProfile(home, id, { lastUsedAt } = {}) {
  return mutateRegistry(home, (registry) => {
    const entry = registry.profiles.find((profile) => profile.id === id);
    if (!entry) throw cloudError('PROFILE_NOT_FOUND', `未找到忆云：${id}`);
    registry.current = id;
    if (lastUsedAt !== undefined) entry.lastUsedAt = lastUsedAt;
    return entry;
  });
}

export async function findProfile(home, id) {
  const state = await readRegistry(home);
  const entry = state.registry.profiles.find((profile) => profile.id === id) ?? null;
  return { entry, ...state };
}

/**
 * 档案 home 解析 + containment：
 *   - 只接受注册表里的 `.` / `profiles/<id>`；
 *   - 存在时 realpath 必须仍在 root 内（防符号链接逃逸）。
 */
export function profileHomeForEntry(root, entry) {
  const rootPath = resolve(root);
  const expected = entry.id === DEFAULT_PROFILE_ID ? '.' : `${PROFILES_DIR}/${entry.id}`;
  if (entry.home !== expected) {
    throw cloudRegistryInvalid(`档案 ${entry.id} 的 home 必须是 ${expected}`);
  }
  const home = resolve(rootPath, expected);
  if (!isHomeInRoot(rootPath, home)) {
    throw cloudError('CLOUD_PROFILE_PATH_INVALID', `档案 ${entry.id} 的 home 越界`);
  }
  if (existsSync(home)) {
    let realHome;
    let realRoot;
    try {
      realHome = realpathSync(home);
      realRoot = realpathSync(rootPath);
    } catch {
      throw cloudError('CLOUD_PROFILE_PATH_INVALID', `档案 ${entry.id} 的 home 无法解析`);
    }
    if (realHome !== realRoot && !realHome.startsWith(`${realRoot}${sep}`)) {
      throw cloudError('CLOUD_PROFILE_PATH_INVALID', `档案 ${entry.id} 的 home 指向 root 之外`);
    }
    if (realHome === realRoot && entry.id !== DEFAULT_PROFILE_ID) {
      throw cloudError('CLOUD_PROFILE_PATH_INVALID', `档案 ${entry.id} 的 home 不能是 root 自身`);
    }
  }
  return home;
}

export async function profileHomeForId(root, id) {
  const state = await readRegistry(root);
  const entry = state.registry.profiles.find((profile) => profile.id === id);
  if (!entry) throw cloudError('PROFILE_NOT_FOUND', `未找到忆云：${id}`);
  return { entry, home: profileHomeForEntry(root, entry), ...state };
}

/** 由 home 反查档案 id（healthz 身份用）；读失败/未知返回 null。 */
export async function profileIdForHome(root, home) {
  const homePath = resolve(home);
  const rootPath = resolve(root);
  if (homePath === rootPath) return DEFAULT_PROFILE_ID;
  const rel = relative(rootPath, homePath);
  const parts = rel.split(sep);
  if (parts.length === 2 && parts[0] === PROFILES_DIR && ID_RE.test(parts[1])) {
    try {
      const state = await readRegistry(rootPath);
      if (state.registry.profiles.some((entry) => entry.id === parts[1])) return parts[1];
    } catch {
      // 注册表损坏：仍返回路径 id（healthz 只用于身份比对）
    }
    return parts[1];
  }
  return null;
}

/** 实例身份：home 的 sha256 前 12 hex（与 @mebular/service homeKey 同定义）。 */
export function homeKey(home) {
  const normalized = resolve(home).replace(/[/\\]+$/, '') || resolve(home);
  return createHash('sha256').update(normalized).digest('hex').slice(0, 12);
}

/**
 * root 级单活锁：`<root>/active.lock` `{pid, profileId, home, startedAt}`。
 * 被活 PID 占用且 home 不同 → CLOUD_ALREADY_ACTIVE；陈旧锁回收。
 */
export async function acquireActiveLock({ root, home, profileId = null, startedAt = new Date().toISOString() }) {
  await mkdir(root, { recursive: true });
  const path = activeLockPath(root);
  const homePath = resolve(home);
  const payload = JSON.stringify({ pid: process.pid, profileId, home: homePath, startedAt });
  const release = async () => {
    try {
      const held = JSON.parse(await readFile(path, 'utf-8'));
      if (held?.pid === process.pid && resolve(held.home ?? '') === homePath) {
        await rm(path, { force: true });
      }
    } catch {
      // 已不存在/损坏：无需处理
    }
  };
  const write = () => writeFile(path, payload, { mode: 0o600, flag: 'wx' });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await write();
      return { path, release };
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
          'CLOUD_ALREADY_ACTIVE',
          `已有忆云守护在运行（pid ${held.pid}，home=${held.home ?? '未知'}）；请先停止它`,
          { held, path },
        );
      }
      await rm(path, { force: true }).catch(() => undefined);
    }
  }
  throw cloudError('CLOUD_ALREADY_ACTIVE', '忆云单活锁竞争失败：请稍后重试', { path });
}
