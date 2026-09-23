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

export function provisionStatus({ home, mcpPort }) {
  const name = defaultDeviceName();
  return {
    ok: true,
    provision: true,
    hostname: name,
    defaultDeviceName: name,
    defaultDeviceId: `device-${sanitize(name) || 'local'}`,
    home,
    configPath: configPath(home),
    mcpPort,
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
 * 建新：生成 root 主密钥（复用 resolveMasterKeys：env > keyFile > <home>/user-master-key.json > 生成并持久化）
 * + 写 config.json（joinService 开、mcp 回环、network 默认），返回落盘结果与端口。
 */
export async function provisionCreate({ home, deviceName, deviceId, mcpPort, joinPort, listenPort }) {
  if (!isProvisionHome(home)) {
    const error = new Error('该家目录已完成初始化（已存在 config.json / 主密钥 / 身份文件）');
    error.code = 'ALREADY_PROVISIONED';
    throw error;
  }
  const name = String(deviceName ?? '').trim() || defaultDeviceName();
  const id = String(deviceId ?? '').trim() || `device-${sanitize(name) || 'local'}`;
  // 端口预检（避免重启即失败）：mcp 端口 = 当前引导服务端口（我们自己持有，无需探测）
  const joinChoice = await findFreePort(Number(joinPort) > 0 ? Number(joinPort) : 4002);
  const listenChoice = await findFreePort(Number(listenPort) > 0 ? Number(listenPort) : 4001);

  const master = await resolveMasterKeys(home, {});
  if (master.userMasterPrivateKey === undefined) {
    const error = new Error('建新需要 root 主密钥（生成失败：未获得私钥）');
    error.code = 'MASTER_KEY_FAILED';
    throw error;
  }

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
    action: 'create',
    deviceId: id,
    deviceName: name,
    configPath: path,
    ports: { mcp: mcpPort, join: joinChoice.port, listen: listenChoice.port },
    notes: [
      `已生成 root 主密钥（<home>/user-master-key.json，0600）`,
      joinChoice.preferredAvailable ? `join 端口 ${joinChoice.port}` : `join 端口 4002 被占 → 已改用 ${joinChoice.port}`,
      listenChoice.preferredAvailable ? `监听 /ip4/0.0.0.0/tcp/${listenChoice.port}` : `监听端口 4001 被占 → 已改用 ${listenChoice.port}`,
    ],
  };
}

/** 令牌可读化校验（形状/TTL）+ 提前失败，避免把不可用的令牌发到 inviter。 */
function inspectToken(decodeJoinToken, token, now = Date.now()) {
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

/**
 * 加入：复用 fleet `joinWithToken`（令牌验签/兑换/身份/主密钥公钥/hints/登记）→ 再写守护 home 的 config.json
 * （delegated，无主私钥）。inviter 返回 granted 语义由令牌 grantOnJoin 决定（服务端 C7 自动授权）。
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
  const fleet = await import('@mebular/fleet');
  const parsed = inspectToken(fleet.decodeJoinToken, token.trim());

  const name = String(deviceName ?? '').trim() || defaultDeviceName();
  const id = `device-${sanitize(name) || 'local'}`;
  const namespace = parsed.namespace;

  // 复用 fleet join（不复制第二套实现）；agents 用 fleet CLI 同款占位（fleet 要求非空）
  const artifacts = ['store.jsonl', 'store.jsonl.identity.json', 'master-key.json', 'fleet.config.json', join('net', 'peers.json')];
  const preexisting = new Set(artifacts.filter((rel) => existsSync(join(home, rel))));
  let joined;
  try {
    joined = await fleet.joinWithToken({
      dir: home,
      token: token.trim(),
      device: id,
      namespace,
      listen: `/ip4/0.0.0.0/tcp/${(await findFreePort(Number(listenPort) > 0 ? Number(listenPort) : 4001)).port}`,
      agents: [{ name: 'echo', kind: 'echo' }],
      ...(Number.isFinite(timeoutMs) ? { timeoutMs } : {}),
    });
  } catch (error) {
    // 失败不得留下半成品（否则引导态判定失效、无法重试）：仅清理本次新建的产物
    for (const rel of artifacts) {
      if (!preexisting.has(rel)) await rm(join(home, rel), { force: true }).catch(() => undefined);
    }
    const raw = String(error?.message ?? error);
    const code = error?.code ?? (error?.cause?.code ?? '');
    if (['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ETIMEDOUT'].includes(code)) {
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
  const joinChoice = await findFreePort(Number(joinPort) > 0 ? Number(joinPort) : 4002);
  const masterKeyPublic = join(home, 'master-key.json');

  const config = {
    storagePath: join(home, 'store.jsonl'),
    deviceId: id,
    deviceName: name,
    identity: { mode: 'delegated' },
    encryption: { level: 'none', userMasterPublicKeyFile: masterKeyPublic },
    network: {
      enabled: true,
      autoConnect: true,
      libp2p: { listen: [`/ip4/0.0.0.0/tcp/${(await findFreePort(Number(listenPort) > 0 ? Number(listenPort) : 4001)).port}`] },
      ...(peers.length > 0 ? { peers } : {}),
    },
    sync: {
      autoSync: true,
      pushOnWrite: true,
      namespaces: [namespace],
      policyIssuers: [parsed.inviterDeviceId],
      antiEntropy: { enabled: true, intervalMs: 600000, jitterRatio: 0.2 },
    },
    joinService: { enabled: true, bind: '0.0.0.0', port: joinChoice.port },
    mcp: { http: { host: '127.0.0.1', port: mcpPort, auth: 'none', tls: false } },
  };
  const path = await writeConfigFile(home, config);
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
    ports: { mcp: mcpPort, join: joinChoice.port },
    notes: [
      `已取得委派证书链（无主私钥）：<home>/store.jsonl.identity.json`,
      `用户主公钥（仅公钥）：${masterKeyPublic}`,
      `授权分区：${namespace}（兑换时自动授权=${parsed.grantOnJoin !== false}）`,
      ...(joined.hinted > 0 ? [`inviter 地址 hints 已写入 <home>/net/peers.json（${joined.hinted} 条）`] : []),
    ],
  };
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
