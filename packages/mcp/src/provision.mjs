// GUI 引导态（provision mode）：真正的空家目录 → 不自举 root，先让人类在控制台选「建新 / 加入」。
//
// 判定极窄（不得影响现有流程）：同时满足
//   ① 无 config.json ② 无 <home>/user-master-key.json ③ 无 <storagePath>.identity.json
// 才进入引导态；显式 `MEBULAR_PROVISION=0`（脚本/测试自举 root）或已设主密钥 env → 视为非引导态。
//
// 加入侧**复用 @mebular/fleet 的 join 实现**（decodeJoinToken/requestJoin/joinWithToken/persistInviterHints），
// 不复制第二套令牌验签/证书兑换逻辑；本模块只负责「mebular 守护 home」的落盘形态与端口预检。

import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { configPath, readMasterKeyRecord, resolveMasterKeys } from './config.mjs';
import {
  assertFreshStore,
  createIdentityForStorage,
  identityPathFor,
  readIdentityFile,
} from './home-identity.mjs';
import {
  DEFAULT_PROFILE_NAME,
  masterFingerprintForHome,
  normalizeProfileName,
  readRegistry,
  resolveCloudRoot,
  writeRegistry,
} from './profiles.mjs';

/** 引导态判定（见文件头注释）。 */
export function isProvisionHome(home, { storagePath, env = process.env } = {}) {
  if (env.MEBULAR_PROVISION === '0') return false;
  if (env.MEBULAR_USER_MASTER_KEY || env.MEBULAR_USER_MASTER_KEY_FILE) return false;
  if (existsSync(configPath(home))) return false;
  if (existsSync(join(home, 'user-master-key.json'))) return false;
  const storage = storagePath ?? env.MEBULAR_STORAGE_PATH ?? join(home, 'store.jsonl');
  if (existsSync(`${storage}.identity.json`)) return false;
  return true;
}

const sanitize = (value) => String(value ?? '').trim().replace(/[^0-9A-Za-z._-]+/g, '-').replace(/^-+|-+$/g, '');
const defaultDeviceName = () => hostname() || 'mebular-device';

/**
 * 设备展示名：与忆云名同一口径（1–24 Unicode，拒绝 `/` `\` `..`）。
 * 仅在显式提供名字时校验；空值仍回退系统主机名（首启无输入）。
 */
export function normalizeDeviceName(raw) {
  if (raw === undefined || raw === null) return defaultDeviceName();
  if (typeof raw !== 'string') {
    const error = new Error('设备名必须是字符串');
    error.code = 'INVALID_NAME';
    throw error;
  }
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (name.length === 0) return defaultDeviceName();
  if (name.includes('/') || name.includes('\\')) {
    const error = new Error('设备名不能包含 / 或 \\');
    error.code = 'INVALID_NAME';
    throw error;
  }
  if (name.includes('..')) {
    const error = new Error('设备名不能包含 ..');
    error.code = 'INVALID_NAME';
    throw error;
  }
  if ([...name].length > 24) {
    const error = new Error('设备名最多 24 个字符');
    error.code = 'INVALID_NAME';
    throw error;
  }
  return name;
}

/**
 * P1：新建首个忆云时落盘 profile registry（current/default + 忆云名）。
 * 仅当 home 就是忆云 root 时写入；自定义 home / 危险 env 下跳过并返回原因（不阻塞初始化）。
 */
async function writeInitialProfile({ home, name, kind, deviceId, masterFingerprint }) {
  const cloud = resolveCloudRoot({ home, env: process.env });
  if (!cloud.available) return { written: false, reason: cloud.reason ?? 'unavailable' };
  if (resolve(cloud.root) !== resolve(home)) return { written: false, reason: 'home_not_root' };
  const state = await readRegistry(cloud.root);
  const registry = {
    ...state.registry,
    profiles: state.registry.profiles.map((entry) => ({ ...entry })),
  };
  let entry = registry.profiles.find((profile) => profile.id === 'default');
  const now = new Date().toISOString();
  if (!entry) {
    entry = {
      id: 'default',
      name: name ?? DEFAULT_PROFILE_NAME,
      home: '.',
      kind,
      createdAt: now,
      lastUsedAt: now,
      masterFingerprint: masterFingerprint ?? null,
      deviceId: deviceId ?? null,
    };
    registry.profiles.push(entry);
  } else {
    entry.name = name ?? entry.name ?? DEFAULT_PROFILE_NAME;
    entry.kind = kind;
    entry.deviceId = deviceId ?? entry.deviceId ?? null;
    entry.masterFingerprint = masterFingerprint ?? entry.masterFingerprint ?? null;
    entry.lastUsedAt = now;
  }
  registry.current = 'default';
  await writeRegistry(cloud.root, registry);
  return { written: true, id: entry.id, name: entry.name };
}

const PROVISION_STATE_PATHS = [
  'user-master-key.json',
  'store.jsonl',
  'store.jsonl.identity.json',
  'master-key.json',
  'fleet.config.json',
  join('net', 'peers.json'),
  'provision.json',
  'profiles.json',
  'profiles.json.bak',
  'join.error.json',
];

/**
 * P1：create/join 的落盘事务快照。热初始化失败时只删除**本次新建**的文件，
 * 不触碰调用前已存在的任何内容（home 锁始终由当前进程持有）。
 */
export async function snapshotProvisionState(home, { storagePath } = {}) {
  const paths = new Set(PROVISION_STATE_PATHS.map((rel) => join(home, rel)));
  const effectiveStorage = typeof storagePath === 'string' && storagePath.length > 0
    ? storagePath
    : join(home, 'store.jsonl');
  paths.add(identityPathFor(effectiveStorage));
  paths.add(`${configPath(home)}.identity-legacy.bak`);
  paths.add(configPath(home));
  const cloud = resolveCloudRoot({ home, env: process.env });
  if (cloud.available) {
    paths.add(join(cloud.root, 'profiles.json'));
    paths.add(join(cloud.root, 'profiles.json.bak'));
  }
  const entries = new Map();
  for (const path of paths) entries.set(path, existsSync(path));
  return {
    entries,
    async rollback() {
      for (const [path, existed] of entries) {
        if (!existed) await rm(path, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}

// F-ONB-1：设备名 → deviceId 归一化（create / join / status 唯一入口）
//   规则：先 sanitize（合法字符集 + 去首尾 '-'），再去掉**所有重复的 `device-` 前缀**（大小写不敏感，
//   含连续重复），最后拼**一次**前缀。空名 / 只剩 `device` → `local`（保持 `device-local` 现状）。
//   例：TestB→device-TestB · device-TestB→device-TestB · device-device-TestB→device-TestB · ''→device-local
const DEVICE_PREFIX_RE = /^device-+/i;
/** 去 `device-` 前缀后的「名字本体」；空或只剩 `device` → `local`。 */
export function deviceNameCore(raw) {
  let core = sanitize(raw);
  while (DEVICE_PREFIX_RE.test(core)) core = core.replace(DEVICE_PREFIX_RE, '');
  if (core.length === 0 || /^device$/i.test(core)) core = 'local';
  return core;
}

/** 设备名 → deviceId（先 sanitize，再去重复 `device-` 前缀，再拼一次前缀）。 */
export const deriveDeviceId = (name) => `device-${deviceNameCore(name)}`;

/**
 * 显式 `deviceId` 参数：以 `device-` 开头时按同一规则归一化（去重复前缀），否则原样保留（自定义 ID）。
 * 返回 null 表示未提供。
 */
export function normalizeExplicitDeviceId(value) {
  const raw = String(value ?? '').trim();
  if (raw.length === 0) return null;
  return /^device-+/i.test(raw) ? deriveDeviceId(raw) : (sanitize(raw) || null);
}

export function provisionStatus({ home, mcpPort, phase = 'UNINITIALIZED', provisioned = false } = {}) {
  const name = defaultDeviceName();
  const base = {
    ok: true,
    provision: true,
    phase,
    hostname: name,
    defaultDeviceName: name,
    defaultDeviceId: deriveDeviceId(name),
    home,
    configPath: configPath(home),
    mcpPort,
    // 兼容旧控制台字段：P1 起初始化不再需要重启。
    restartRequired: false,
    restarting: false,
  };
  if (phase === 'INITIALIZING') {
    return {
      ...base,
      provisioned: Boolean(provisioned),
      note: '正在当前进程内完成初始化（写入配置并启动应用）；完成后本页自动进入正常态，无需重启。',
    };
  }
  if (provisioned) {
    return {
      ...base,
      provisioned: true,
      note: '检测到已初始化的配置；当前进程尚未加载应用，请重新启动守护后进入正常态。',
    };
  }
  return {
    ...base,
    provisioned: false,
    note: '家目录为空：请选择「新建忆云」或「加入已有忆云」；完成后当前进程会直接进入正常态（无需重启），之后由各设备自行订阅记忆域。',
  };
}

/** 端口预检：优先用期望端口，被占则取系统分配（返回实际可用端口）。 */
export async function findFreePort(preferred, host = '0.0.0.0') {
  const tryListen = (port) => new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(null));
    server.listen(port, host, () => {
      const actual = server.address()?.port ?? port;
      server.close(() => resolve(actual));
    });
  });
  const chosen = await tryListen(preferred);
  if (chosen !== null) return { port: chosen, preferredAvailable: true };
  const fallback = await tryListen(0);
  if (fallback === null) throw new Error(`无法在 ${host} 上分配端口（preferred=${preferred}）`);
  return { port: fallback, preferredAvailable: false };
}

async function writeConfigFile(home, config) {
  await mkdir(dirname(configPath(home)), { recursive: true });
  const path = configPath(home);
  await writeFile(path, JSON.stringify(config, null, 2), { mode: 0o600 });
  try { await chmod(path, 0o600); } catch { /* Windows ACL 兜底 */ }
  return path;
}

/**
 * 写引导态 config.json（create/restore 共用）。调用方必须已确保 `<home>/user-master-key.json` 存在
 * （create 由 resolveMasterKeys 生成；restore 由备份解密落盘）。
 */
async function writeInitialProvisionConfig({ home, storagePath, deviceName, deviceId, mcpPort, joinPort, listenPort, action = 'create', notes = [] }) {
  const name = String(deviceName ?? '').trim() || defaultDeviceName();
  // 调用方传入的身份值即权威；仅在缺省时按名字派生（保持旧内部契约）。
  const id = String(deviceId ?? '').trim() || deriveDeviceId(name);
  // 与 isProvisionHome/createMebular 同序：env 覆盖 > <home>/store.jsonl。
  const effectiveStorage = typeof storagePath === 'string' && storagePath.length > 0
    ? storagePath
    : (process.env.MEBULAR_STORAGE_PATH ?? join(home, 'store.jsonl'));
  // 端口预检（避免重启即失败）：mcp 端口 = 当前引导服务端口（我们自己持有，无需探测）
  const joinChoice = await findFreePort(Number(joinPort) > 0 ? Number(joinPort) : 4002);
  const listenChoice = await findFreePort(Number(listenPort) > 0 ? Number(listenPort) : 4001);

  // F-IDENT-1：config 不写身份字段；deviceId/deviceName 由 <storagePath>.identity.json 提供。
  const config = {
    storagePath: effectiveStorage,
    encryption: { level: 'none' },
    network: {
      enabled: true,
      autoConnect: true,
      libp2p: { listen: [`/ip4/0.0.0.0/tcp/${listenChoice.port}`] },
    },
    sync: {
      autoSync: true,
      pushOnWrite: true,
      namespaces: ['tasks'],
      antiEntropy: { enabled: true, intervalMs: 600000, jitterRatio: 0.2 },
    },
    joinService: { enabled: true, bind: '0.0.0.0', port: joinChoice.port },
    mcp: { http: { host: '127.0.0.1', port: mcpPort, auth: 'none', tls: false } },
  };
  const path = await writeConfigFile(home, config);
  return {
    ok: true,
    action,
    deviceId: id,
    deviceName: name,
    configPath: path,
    ports: { mcp: mcpPort, join: joinChoice.port, listen: listenChoice.port },
    notes: [
      ...notes,
      joinChoice.preferredAvailable ? `join 端口 ${joinChoice.port}` : `join 端口 4002 被占 → 已改用 ${joinChoice.port}`,
      listenChoice.preferredAvailable ? `监听 /ip4/0.0.0.0/tcp/${listenChoice.port}` : `监听端口 4001 被占 → 已改用 ${listenChoice.port}`,
    ],
  };
}

/**
 * 建新：生成 root 主密钥（复用 resolveMasterKeys：env > keyFile > <home>/user-master-key.json > 生成并持久化）
 * + 写 config.json（joinService 开、mcp 回环、network 默认）+ 写首个 profile registry，返回落盘结果与端口。
 * P1：失败即回滚本次新建的主密钥 / config / registry，不留下「config 已写但 app 没起来」的半状态。
 */
export async function provisionCreate({ home, cloudName, deviceName, deviceId, mcpPort, joinPort, listenPort }) {
  if (!isProvisionHome(home)) {
    const error = new Error('该家目录已完成初始化（已存在 config.json / 主密钥 / 身份文件）');
    error.code = 'ALREADY_PROVISIONED';
    throw error;
  }
  const name = normalizeDeviceName(deviceName);
  const profileName = cloudName === undefined ? null : normalizeProfileName(cloudName);
  const keyPath = join(home, 'user-master-key.json');
  const cfgPath = configPath(home);
  const keyExisted = existsSync(keyPath);
  const configExisted = existsSync(cfgPath);
  const cloud = resolveCloudRoot({ home, env: process.env });
  const registryPath = cloud.available ? join(cloud.root, 'profiles.json') : null;
  const registryBackupPath = cloud.available ? join(cloud.root, 'profiles.json.bak') : null;
  const registryExisted = registryPath !== null && existsSync(registryPath);
  const registryBackupExisted = registryBackupPath !== null && existsSync(registryBackupPath);
  const storagePath = process.env.MEBULAR_STORAGE_PATH ?? join(home, 'store.jsonl');
  const identityFile = identityPathFor(storagePath);
  const identityExisted = existsSync(identityFile);
  try {
    // 缺身份但 store 已有数据 = 自动换钥风险：先拒绝，绝不写主密钥/配置。
    assertFreshStore(storagePath);
    const master = await resolveMasterKeys(home, {});
    if (master.userMasterPrivateKey === undefined) {
      const error = new Error('建新需要 root 主密钥（生成失败：未获得私钥）');
      error.code = 'MASTER_KEY_FAILED';
      throw error;
    }
    const identity = await createIdentityForStorage({
      storagePath,
      deviceId: normalizeExplicitDeviceId(deviceId) ?? deriveDeviceId(name),
      deviceName: name,
      userMasterPrivateKey: master.userMasterPrivateKey,
      userMasterPublicKey: master.userMasterKey,
    });
    const result = await writeInitialProvisionConfig({
      home,
      storagePath,
      deviceName: identity.deviceName,
      deviceId: identity.deviceId,
      mcpPort,
      joinPort,
      listenPort,
      action: 'create',
      notes: ['已生成 root 主密钥（<home>/user-master-key.json，0600）'],
    });
    const profile = await writeInitialProfile({
      home,
      name: profileName,
      kind: 'root',
      deviceId: result.deviceId,
      masterFingerprint: masterFingerprintForHome(home, {}),
    }).catch((error) => {
      const wrapped = new Error(`写入忆云档案失败：${error?.message ?? error}`);
      wrapped.code = error?.code ?? 'PROFILE_WRITE_FAILED';
      throw wrapped;
    });
    return {
      ...result,
      cloudName: profile.written ? profile.name : DEFAULT_PROFILE_NAME,
      profile: profile.written ? { id: profile.id, name: profile.name } : null,
      notes: [
        ...result.notes,
        profile.written
          ? `已写入忆云档案（current=default，名字=「${profile.name}」）`
          : `未写入忆云档案（${profile.reason ?? '当前 home 不是忆云 root'}）：控制台沿用默认名字`,
      ],
    };
  } catch (error) {
    if (!keyExisted) await rm(keyPath, { force: true }).catch(() => undefined);
    if (!configExisted) await rm(cfgPath, { force: true }).catch(() => undefined);
    if (!identityExisted) await rm(identityFile, { force: true }).catch(() => undefined);
    if (registryPath !== null && !registryExisted) await rm(registryPath, { force: true }).catch(() => undefined);
    if (registryBackupPath !== null && !registryBackupExisted) await rm(registryBackupPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * 从备份恢复（§4.3）：解密主密钥 → 写 `<home>/user-master-key.json`（0600）→ 写 config.json。
 * 失败不残留（备份模块先解密/验公钥再写盘；本函数失败时清理本次新建的主密钥）。
 */
export async function provisionRestore({ home, file, code, cloudName, deviceName, deviceId, mcpPort, joinPort, listenPort }) {
  if (!isProvisionHome(home)) {
    const error = new Error('该家目录已完成初始化（已存在 config.json / 主密钥 / 身份文件）');
    error.code = 'ALREADY_PROVISIONED';
    throw error;
  }
  const name = normalizeDeviceName(deviceName);
  const profileName = cloudName === undefined ? null : normalizeProfileName(cloudName);
  if (typeof file !== 'string' || file.trim().length === 0) {
    const error = new Error('需要备份文件路径');
    error.code = 'BACKUP_FILE_REQUIRED';
    throw error;
  }
  if (typeof code !== 'string' || code.trim().length === 0) {
    const error = new Error('需要备份码');
    error.code = 'BACKUP_CODE_REQUIRED';
    throw error;
  }
  const fleet = await import('../../fleet/dist/index.js');
  const keyPath = join(home, 'user-master-key.json');
  const storagePath = process.env.MEBULAR_STORAGE_PATH ?? join(home, 'store.jsonl');
  // 缺身份但 store 已有数据 = 自动换钥风险：写主密钥前先拒绝。
  assertFreshStore(storagePath);
  const transaction = await snapshotProvisionState(home, { storagePath });
  let restored;
  try {
    restored = await fleet.restoreMasterKeyBackup({
      file: await readFile(file, 'utf-8'),
      code: code.trim(),
      dir: home,
      keyPath,
    });
  } catch (error) {
    await rm(keyPath, { force: true }).catch(() => undefined);
    const wrapped = new Error(`恢复失败：${error?.message ?? error}`);
    wrapped.code = 'RESTORE_FAILED';
    throw wrapped;
  }
  try {
    const master = await readMasterKeyRecord(keyPath);
    if (master.userMasterPrivateKey === undefined) {
      const error = new Error('恢复失败：主密钥文件缺少私钥（无法签发设备身份）');
      error.code = 'RESTORE_FAILED';
      throw error;
    }
    const identity = await createIdentityForStorage({
      storagePath,
      deviceId: normalizeExplicitDeviceId(deviceId) ?? deriveDeviceId(name),
      deviceName: name,
      userMasterPrivateKey: master.userMasterPrivateKey,
      userMasterPublicKey: master.userMasterKey,
    });
    const result = await writeInitialProvisionConfig({
      home,
      storagePath,
      deviceName: identity.deviceName,
      deviceId: identity.deviceId,
      mcpPort,
      joinPort,
      listenPort,
      action: 'restore',
      notes: [
        `已从备份恢复主密钥（${restored.fingerprint}）`,
        '请核对指纹与既有设备「关于本机」一致',
      ],
    });
    const profile = await writeInitialProfile({
      home,
      name: profileName,
      kind: 'root',
      deviceId: result.deviceId,
      masterFingerprint: restored.fingerprint ?? masterFingerprintForHome(home, {}),
    });
    return {
      ...result,
      cloudName: profile.written ? profile.name : DEFAULT_PROFILE_NAME,
      profile: profile.written ? { id: profile.id, name: profile.name } : null,
      fingerprint: restored.fingerprint,
      masterPublicKeyHex: restored.masterPublicKeyHex,
      notes: [
        ...result.notes,
        ...(profile.written ? [`已写入忆云档案（current=default，名字=「${profile.name}」）`] : []),
        '既有设备无需重新入网（主密钥未变）；与恢复机建立连接即可继续同步',
        '恢复机成为新 root：建议重新导出备份并轮换恢复码',
      ],
    };
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

/** 令牌可读化校验（形状/TTL）+ 提前失败，避免把不可用的令牌发到 inviter。 */
export function inspectJoinToken(decodeJoinToken, token, now = Date.now()) {
  let parsed;
  try {
    parsed = decodeJoinToken(token);
  } catch (error) {
    const wrapped = new Error(`令牌无法解析：${error?.message ?? error}`);
    wrapped.code = 'TOKEN_INVALID';
    throw wrapped;
  }
  if (typeof parsed.expiresAt === 'number' && parsed.expiresAt <= now) {
    const error = new Error('令牌已过期：请让邀请方重新生成（邀请面板 → 一次性令牌）');
    error.code = 'TOKEN_EXPIRED';
    throw error;
  }
  return parsed;
}

async function resolveJoinPorts({ ports = {}, mcpPort, joinPort, listenPort }) {
  const positive = (value) => Number.isInteger(Number(value)) && Number(value) > 0;
  const mcp = positive(ports.mcp) ? Number(ports.mcp) : (positive(mcpPort) ? Number(mcpPort) : 0);
  // 档案加入必须复用当前忆云的端口（旧守护还占着，不能探测）；只有首启/显式 0 才回退 findFreePort。
  const join = positive(ports.join)
    ? Number(ports.join)
    : (positive(joinPort) ? Number(joinPort) : (await findFreePort(4002)).port);
  const listen = positive(ports.listen)
    ? Number(ports.listen)
    : (positive(listenPort) ? Number(listenPort) : (await findFreePort(4001)).port);
  return { mcp, join, listen };
}

function delegatedConfig({ home, namespace, ports, peers = [] }) {
  return {
    storagePath: join(home, 'store.jsonl'),
    // F-IDENT-1：不写身份字段；deviceId/deviceName 由身份文件提供。
    identity: { mode: 'delegated' },
    encryption: { level: 'none', userMasterPublicKeyFile: join(home, 'master-key.json') },
    network: {
      enabled: true,
      autoConnect: true,
      libp2p: { listen: [`/ip4/0.0.0.0/tcp/${ports.listen}`] },
      ...(peers.length > 0 ? { peers } : {}),
    },
    sync: {
      autoSync: true,
      pushOnWrite: true,
      namespaces: [namespace],
      antiEntropy: { enabled: true, intervalMs: 600000, jitterRatio: 0.2 },
    },
    joinService: { enabled: true, bind: '0.0.0.0', port: ports.join },
    mcp: { http: { host: '127.0.0.1', port: ports.mcp, auth: 'none', tls: false } },
  };
}

/**
 * 加入一个**已存在的空 home**（档案加入复用）：
 *   ① 先解码/校验令牌（形状/TTL）② 预写 delegated config（避免「令牌已兑换、本机写失败」窗口）
 *   ③ 复用 fleet joinWithToken（身份/证书/hints）④ 补写 peers。
 *
 * `ports` 由调用方显式给出时**原样使用**（档案切换复用当前忆云端口，不探测、不抢端口）；
 * 未给出时按首启习惯 findFreePort。`rollbackDirectory` 只允许调用方对「本次独占创建、尚未注册」的
 * 目录使用：失败时整目录回滚；默认仅清理本次新建的文件（保留首启 provisionJoin 的旧语义）。
 */
export async function provisionJoinInto({
  home,
  token,
  cloudName,
  deviceName,
  deviceId,
  ports,
  mcpPort,
  joinPort,
  listenPort,
  timeoutMs,
  rollbackDirectory = false,
  registerCurrentProfile = false,
}) {
  if (!isProvisionHome(home)) {
    const error = new Error('该家目录已完成初始化（已存在 config.json / 主密钥 / 身份文件）');
    error.code = 'ALREADY_PROVISIONED';
    throw error;
  }
  // 身份缺失但 store 已有数据 = 自动换钥风险：在写 config / 请求加入前拒绝。
  assertFreshStore(join(home, 'store.jsonl'));
  if (typeof token !== 'string' || token.trim().length === 0) {
    const error = new Error('需要令牌文本（邀请面板生成的 base64 令牌）');
    error.code = 'TOKEN_REQUIRED';
    throw error;
  }
  const fleet = await import('../../fleet/dist/index.js');
  const parsed = inspectJoinToken(fleet.decodeJoinToken, token.trim());

  const name = normalizeDeviceName(deviceName);
  const profileName = cloudName === undefined ? null : normalizeProfileName(cloudName);
  const id = normalizeExplicitDeviceId(deviceId) ?? deriveDeviceId(name);
  const namespace = parsed.namespace;
  const resolvedPorts = await resolveJoinPorts({ ports, mcpPort, joinPort, listenPort });

  // 复用 fleet join（不复制第二套实现）；agents 用 fleet CLI 同款占位（fleet 要求非空）
  const artifacts = ['store.jsonl', 'store.jsonl.identity.json', 'master-key.json', 'fleet.config.json', join('net', 'peers.json')];
  const preexisting = new Set(artifacts.filter((rel) => existsSync(join(home, rel))));
  const configFile = configPath(home);
  const configPreexisting = existsSync(configFile);
  const rollbackArtifacts = async () => {
    if (rollbackDirectory) {
      await rm(home, { recursive: true, force: true }).catch(() => undefined);
      return;
    }
    // 失败不得留下半成品（否则引导态判定失效、无法重试）：仅清理本次新建的产物
    for (const rel of artifacts) {
      if (!preexisting.has(rel)) await rm(join(home, rel), { force: true }).catch(() => undefined);
    }
    if (!configPreexisting) await rm(configFile, { force: true }).catch(() => undefined);
  };

  // 预写 config：兑换前完成本机落盘（端口复用当前忆云；准备阶段不 bind）。
  await writeConfigFile(home, delegatedConfig({ home, namespace, ports: resolvedPorts }));

  let joined;
  try {
    joined = await fleet.joinWithToken({
      dir: home,
      token: token.trim(),
      device: id,
      deviceName: name,
      namespace,
      listen: `/ip4/0.0.0.0/tcp/${resolvedPorts.listen}`,
      agents: [{ name: 'echo', kind: 'echo' }],
      ...(Number.isFinite(timeoutMs) ? { timeoutMs } : {}),
    });
  } catch (error) {
    await rollbackArtifacts();
    const raw = String(error?.message ?? error);
    const code = error?.code ?? (error?.cause?.code ?? '');
    if (['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ETIMEDOUT'].includes(code) || /超时|timeout/i.test(raw)) {
      const wrapped = new Error(`邀请方端点不可达（${parsed.endpoint}）：请确认对方 serve 在运行且该地址可达`);
      wrapped.code = 'ENDPOINT_UNREACHABLE';
      throw wrapped;
    }
    if (/令牌不可用|used|expired|signature|签名/i.test(raw)) {
      const wrapped = new Error(`令牌不可用：${raw}`);
      wrapped.code = 'TOKEN_REJECTED';
      throw wrapped;
    }
    throw error;
  }

  // fleet 落盘：<home>/store.jsonl.identity.json（委派身份，无主私钥）+ <home>/master-key.json（仅公钥）
  //           + <home>/fleet.config.json（登记 inviter 地址）+ <home>/net/peers.json（hints）
  const fleetCfg = await fleet.loadFleetConfig(fleet.fleetConfigPath(home)).catch(() => null);
  const peers = Array.isArray(fleetCfg?.peers)
    ? fleetCfg.peers.filter((p) => p && typeof p.device === 'string').map((p) => (p.addr ? { device: p.device, addr: p.addr } : { device: p.device }))
    : [];
  const masterKeyPublic = join(home, 'master-key.json');
  const fingerprint = typeof joined.fingerprint === 'string' ? joined.fingerprint : null;
  try {
    // 加入后身份文件必须可用且与请求一致——config 与档案都只引用身份提供的 deviceId。
    const identity = readIdentityFile(join(home, 'store.jsonl'));
    if (identity.status !== 'valid') {
      const error = new Error(`加入后身份文件不可用：${identity.path}`);
      error.code = 'IDENTITY_INVALID';
      throw error;
    }
    if (identity.deviceId !== id) {
      const error = new Error(`加入后身份 ${identity.deviceId} 与请求 ${id} 不一致`);
      error.code = 'IDENTITY_MISMATCH';
      throw error;
    }
    const path = await writeConfigFile(home, delegatedConfig({ home, namespace, ports: resolvedPorts, peers }));
    const profile = registerCurrentProfile
      ? await writeInitialProfile({
        home,
        name: profileName,
        kind: 'delegated',
        deviceId: identity.deviceId,
        masterFingerprint: fingerprint,
      })
      : { written: false, reason: 'not_current_profile' };
    return {
      ok: true,
      action: 'join',
      deviceId: identity.deviceId,
      deviceName: identity.deviceName,
      inviterDeviceId: parsed.inviterDeviceId,
      namespace,
      hinted: joined.hinted,
      peers,
      configPath: path,
      masterKeyPublicFile: masterKeyPublic,
      fingerprint,
      cloudName: profile.written ? profile.name : DEFAULT_PROFILE_NAME,
      profile: profile.written ? { id: profile.id, name: profile.name } : null,
      ports: { mcp: resolvedPorts.mcp, join: resolvedPorts.join, listen: resolvedPorts.listen },
      notes: [
        '已取得委派证书链（无主私钥）：<home>/store.jsonl.identity.json',
        `用户主公钥（仅公钥）：${masterKeyPublic}`,
        `默认订阅：${namespace}（加入后由本机自行声明；不复制任何权限记录）`,
        ...(profile.written
          ? [`已写入忆云档案（current=default，名字=「${profile.name}」；令牌不含忆云名时沿用默认）`]
          : []),
        ...(joined.hinted > 0 ? [`inviter 地址 hints 已写入 <home>/net/peers.json（${joined.hinted} 条）`] : []),
      ],
    };
  } catch (error) {
    await rollbackArtifacts();
    throw error;
  }
}

/**
 * 首启加入：保留「只认空 home」的 gate；内部委托 provisionJoinInto。
 * 失败只清理本次新建产物（home 本身由引导流程保留，便于重试）。
 */
export async function provisionJoin({
  home,
  token,
  cloudName,
  deviceName,
  mcpPort,
  joinPort,
  listenPort,
  timeoutMs,
}) {
  if (!isProvisionHome(home)) {
    const error = new Error('该家目录已完成初始化（已存在 config.json / 主密钥 / 身份文件）');
    error.code = 'ALREADY_PROVISIONED';
    throw error;
  }
  if (typeof token !== 'string' || token.trim().length === 0) {
    const error = new Error('需要令牌文本（邀请面板生成的 base64 令牌）');
    error.code = 'TOKEN_REQUIRED';
    throw error;
  }
  return provisionJoinInto({
    home,
    token,
    cloudName,
    deviceName,
    mcpPort,
    joinPort,
    listenPort,
    timeoutMs,
    registerCurrentProfile: true,
  });
}

/** 读回已落盘的 provider 结果（供控制台「已加入」展示当前路径/订阅分区）。 */
export async function readProvisionRecord(home) {
  try {
    const record = JSON.parse(await readFile(join(home, 'provision.json'), 'utf-8'));
    return record && typeof record === 'object' ? record : null;
  } catch {
    return null;
  }
}

/** 记录最近一次引导（create/join）结果，供重启后控制台展示。 */
export async function writeProvisionRecord(home, record) {
  await writeFile(join(home, 'provision.json'), JSON.stringify(record, null, 2), { mode: 0o600 }).catch(() => undefined);
}
