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
import { dirname, join } from 'node:path';
import { configPath, resolveMasterKeys } from './config.mjs';

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

export function provisionStatus({ home, mcpPort, provisioned = false, restarting = false, restart = null } = {}) {
  const name = defaultDeviceName();
  const base = {
    ok: true,
    provision: true,
    hostname: name,
    defaultDeviceName: name,
    defaultDeviceId: deriveDeviceId(name),
    home,
    configPath: configPath(home),
    mcpPort,
  };
  // C（F-ONB-2）：home 已初始化（config 存在）但进程仍是引导态 → 待重启态。
  // 不再宣称「家目录为空」；带上重启计划，前端刷新即进入待重启面板。
  if (provisioned) {
    return {
      ...base,
      provisioned: true,
      restartRequired: true,
      restarting: Boolean(restarting),
      ...(restart ? { restart } : {}),
      note: '家目录已完成初始化；当前进程仍处于引导态，需重启后进入正常态。',
    };
  }
  return {
    ...base,
    provisioned: false,
    restartRequired: false,
    note: '家目录为空：请选择「建新 Mebular」或「加入已有 Mebular」；完成后自动重启进入正常态。',
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
async function writeInitialProvisionConfig({ home, deviceName, deviceId, mcpPort, joinPort, listenPort, action = 'create', notes = [] }) {
  const name = String(deviceName ?? '').trim() || defaultDeviceName();
  const id = normalizeExplicitDeviceId(deviceId) ?? deriveDeviceId(name);
  // 端口预检（避免重启即失败）：mcp 端口 = 当前引导服务端口（我们自己持有，无需探测）
  const joinChoice = await findFreePort(Number(joinPort) > 0 ? Number(joinPort) : 4002);
  const listenChoice = await findFreePort(Number(listenPort) > 0 ? Number(listenPort) : 4001);

  const config = {
    deviceId: id,
    deviceName: name,
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
      policyIssuers: [id],
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
 * + 写 config.json（joinService 开、mcp 回环、network 默认），返回落盘结果与端口。
 */
export async function provisionCreate({ home, deviceName, deviceId, mcpPort, joinPort, listenPort }) {
  if (!isProvisionHome(home)) {
    const error = new Error('该家目录已完成初始化（已存在 config.json / 主密钥 / 身份文件）');
    error.code = 'ALREADY_PROVISIONED';
    throw error;
  }
  const master = await resolveMasterKeys(home, {});
  if (master.userMasterPrivateKey === undefined) {
    const error = new Error('建新需要 root 主密钥（生成失败：未获得私钥）');
    error.code = 'MASTER_KEY_FAILED';
    throw error;
  }
  return writeInitialProvisionConfig({
    home,
    deviceName,
    deviceId,
    mcpPort,
    joinPort,
    listenPort,
    action: 'create',
    notes: ['已生成 root 主密钥（<home>/user-master-key.json，0600）'],
  });
}

/**
 * 从备份恢复（§4.3）：解密主密钥 → 写 `<home>/user-master-key.json`（0600）→ 写 config.json。
 * 失败不残留（备份模块先解密/验公钥再写盘；本函数失败时清理本次新建的主密钥）。
 */
export async function provisionRestore({ home, file, code, deviceName, deviceId, mcpPort, joinPort, listenPort }) {
  if (!isProvisionHome(home)) {
    const error = new Error('该家目录已完成初始化（已存在 config.json / 主密钥 / 身份文件）');
    error.code = 'ALREADY_PROVISIONED';
    throw error;
  }
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
    const result = await writeInitialProvisionConfig({
      home,
      deviceName,
      deviceId,
      mcpPort,
      joinPort,
      listenPort,
      action: 'restore',
      notes: [
        `已从备份恢复主密钥（${restored.fingerprint}）`,
        '请核对指纹与既有设备「关于本机」一致',
      ],
    });
    return {
      ...result,
      fingerprint: restored.fingerprint,
      masterPublicKeyHex: restored.masterPublicKeyHex,
      notes: [
        ...result.notes,
        '既有设备无需重新入网（主密钥未变）；与恢复机建立连接即可继续同步',
        '恢复机成为新 root：建议重新导出备份并轮换恢复码',
      ],
    };
  } catch (error) {
    await rm(keyPath, { force: true }).catch(() => undefined);
    await rm(configPath(home), { force: true }).catch(() => undefined);
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

function delegatedConfig({ home, id, name, namespace, parsed, ports, peers = [] }) {
  return {
    storagePath: join(home, 'store.jsonl'),
    deviceId: id,
    deviceName: name,
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
      policyIssuers: [parsed.inviterDeviceId],
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
  deviceName,
  deviceId,
  ports,
  mcpPort,
  joinPort,
  listenPort,
  timeoutMs,
  rollbackDirectory = false,
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
  const fleet = await import('../../fleet/dist/index.js');
  const parsed = inspectJoinToken(fleet.decodeJoinToken, token.trim());

  const name = String(deviceName ?? '').trim() || defaultDeviceName();
  const id = normalizeExplicitDeviceId(deviceId) ?? deriveDeviceId(name);
  const namespace = parsed.namespace;
  const resolvedPorts = await resolveJoinPorts({ ports, mcpPort, joinPort, listenPort });

  // 复用 fleet join（不复制第二套实现）；agents 用 fleet CLI 同款占位（fleet 要求非空）
  const artifacts = ['store.jsonl', 'store.jsonl.identity.json', 'master-key.json', 'fleet.config.json', join('net', 'peers.json')];
  const preexisting = new Set(artifacts.filter((rel) => existsSync(join(home, rel))));
  const configFile = configPath(home);
  const configPreexisting = existsSync(configFile);

  // 预写 config：兑换前完成本机落盘（端口复用当前忆云；准备阶段不 bind）。
  await writeConfigFile(home, delegatedConfig({ home, id, name, namespace, parsed, ports: resolvedPorts }));

  let joined;
  try {
    joined = await fleet.joinWithToken({
      dir: home,
      token: token.trim(),
      device: id,
      namespace,
      listen: `/ip4/0.0.0.0/tcp/${resolvedPorts.listen}`,
      agents: [{ name: 'echo', kind: 'echo' }],
      ...(Number.isFinite(timeoutMs) ? { timeoutMs } : {}),
    });
  } catch (error) {
    if (rollbackDirectory) {
      await rm(home, { recursive: true, force: true }).catch(() => undefined);
    } else {
      // 失败不得留下半成品（否则引导态判定失效、无法重试）：仅清理本次新建的产物
      for (const rel of artifacts) {
        if (!preexisting.has(rel)) await rm(join(home, rel), { force: true }).catch(() => undefined);
      }
      if (!configPreexisting) await rm(configFile, { force: true }).catch(() => undefined);
    }
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
  const path = await writeConfigFile(home, delegatedConfig({ home, id, name, namespace, parsed, ports: resolvedPorts, peers }));
  return {
    ok: true,
    action: 'join',
    deviceId: id,
    deviceName: name,
    inviterDeviceId: parsed.inviterDeviceId,
    namespace,
    grantsOnJoin: parsed.grantOnJoin !== false,
    hinted: joined.hinted,
    peers,
    configPath: path,
    masterKeyPublicFile: masterKeyPublic,
    fingerprint: typeof joined.fingerprint === 'string' ? joined.fingerprint : null,
    ports: { mcp: resolvedPorts.mcp, join: resolvedPorts.join, listen: resolvedPorts.listen },
    notes: [
      '已取得委派证书链（无主私钥）：<home>/store.jsonl.identity.json',
      `用户主公钥（仅公钥）：${masterKeyPublic}`,
      `授权分区：${namespace}（兑换时自动授权=${parsed.grantOnJoin !== false}）`,
      ...(joined.hinted > 0 ? [`inviter 地址 hints 已写入 <home>/net/peers.json（${joined.hinted} 条）`] : []),
    ],
  };
}

/**
 * 首启加入：保留「只认空 home」的 gate；内部委托 provisionJoinInto。
 * 失败只清理本次新建产物（home 本身由引导流程保留，便于重试）。
 */
export async function provisionJoin({
  home,
  token,
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
  return provisionJoinInto({ home, token, deviceName, mcpPort, joinPort, listenPort, timeoutMs });
}

/** 读回已落盘的 provider 结果（供控制台「已加入」展示当前路径/授权分区）。 */
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
