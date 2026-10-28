// Fleet 设备配置与用户主密钥 IO（Step 1b）：全部 **0600**、默认脱敏、绝不回显密钥材料。
//
// 目录（device home）权限 0700；配置文件 `fleet.config.json`；主密钥 `master-key.json`；
// 事件存储 `store.jsonl`（设备身份 `store.jsonl.identity.json` 由 core 落盘）。

import { existsSync, readFileSync, statSync } from 'node:fs';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

const SUBTLE = globalThis.crypto.subtle;

/**
 * 平台策略：POSIX mode 位是否构成有效保护。
 *
 * **Windows 上不成立**（`chmod`/`mode` 只有只读位语义，`stat().mode` 恒为 0666/0444），
 * 因此 doctor 在 win32 上对权限项**显式 SKIP**（写入 `skipped`），而不是对 0666 判 FAIL。
 * 威胁模型差异见 `ONBOARDING.md` 的 Windows 章节：Windows 依赖用户配置目录的 ACL
 * （`%USERPROFILE%` 默认仅本人可读）与 OS 会话边界，等价性由平台保证而非 fleet 断言。
 *
 * 参数可注入（默认 `process.platform`），便于在任意平台确定性地测试两种分支。
 */
export function permissionsApplicable(platform: string = process.platform): boolean {
  return platform !== 'win32';
}

/** core `Mebular` 需要的加密材料（用户主密钥）。令牌加入的设备**只有主公钥**（无主私钥）。 */
export interface FleetEncryption {
  userMasterKey: Uint8Array;
  userMasterPrivateKey?: CryptoKey;
}

/** 生成 Ed25519 用户主密钥。 */
export async function generateMasterKey(): Promise<FleetEncryption> {
  const keyPair = (await SUBTLE.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const userMasterKey = new Uint8Array(await SUBTLE.exportKey('raw', keyPair.publicKey));
  return { userMasterKey, userMasterPrivateKey: keyPair.privateKey };
}

/** 写入主密钥文件（0600）。无主私钥（令牌加入设备）时只写主公钥。 */
export async function writeMasterKeyFile(path: string, encryption: FleetEncryption): Promise<void> {
  const record: { v: number; alg: string; publicKey: string; privateKeyPkcs8?: string } = {
    v: 1,
    alg: 'Ed25519',
    publicKey: Buffer.from(encryption.userMasterKey).toString('base64'),
  };
  if (encryption.userMasterPrivateKey !== undefined) {
    const pkcs8 = new Uint8Array(await SUBTLE.exportKey('pkcs8', encryption.userMasterPrivateKey));
    record.privateKeyPkcs8 = Buffer.from(pkcs8).toString('base64');
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(record), { mode: 0o600 });
  if (permissionsApplicable()) await chmod(path, 0o600);
}

/** 读取主密钥文件（不校验权限；权限由 doctor 断言）。 */
export async function readMasterKeyFile(path: string): Promise<FleetEncryption> {
  const parsed = JSON.parse(await readFile(path, 'utf-8')) as {
    v?: number;
    publicKey?: string;
    privateKeyPkcs8?: string;
  };
  // 容忍缺省 `v`：`mebular` 侧生成的主密钥文件（<home>/user-master-key.json）不带版本字段。
  if ((parsed.v !== undefined && parsed.v !== 1) || typeof parsed.publicKey !== 'string') {
    throw new Error('master key file: 形状非法');
  }
  if (parsed.privateKeyPkcs8 === undefined) {
    // 令牌加入设备：只有主公钥（无主私钥），用于验证对端/设备证书链。
    return { userMasterKey: new Uint8Array(Buffer.from(parsed.publicKey, 'base64')) };
  }
  const userMasterKey = new Uint8Array(Buffer.from(parsed.publicKey, 'base64'));
  const userMasterPrivateKey = await SUBTLE.importKey(
    'pkcs8',
    Buffer.from(parsed.privateKeyPkcs8, 'base64'),
    { name: 'Ed25519' },
    true,
    ['sign'],
  );
  return { userMasterKey, userMasterPrivateKey };
}

/** 文件权限（低 9 位八进制）。 */
export async function fileMode(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

export type FleetAgentKind = 'echo' | 'command' | 'hermes' | 'openchamber';

export interface FleetAgentConfig {
  name: string;
  kind: FleetAgentKind;
  /** kind=command 时的可执行文件 */
  command?: string;
  baseArgs?: string[];
  timeoutMs?: number;
  concurrency?: number;
}

export interface FleetPeerConfig {
  device: string;
  /** 可选 multiaddr（用于拨号；缺省则等待对端拨入） */
  addr?: string;
}

export interface FleetConfig {
  v: 1;
  device: string;
  dir: string;
  storagePath: string;
  masterKeyFile: string;
  namespace: string;
  /** 本机监听 multiaddr（libp2p） */
  listen: string;
  /** 已登记对端（地址簿；连接准入由 peerWhitelist/信任链决定） */
  peers: FleetPeerConfig[];
  /** 本机 agent 注册表（按 to.agent 名路由） */
  agents: FleetAgentConfig[];
  quotaLimitPerDevice?: number;
  /**
   * join 服务（T2）：`fleet node` 启动最小 HTTP 端点 `POST /mebular/join` 以签发委派证书。
   * 令牌是 bearer 凭据（短 TTL + 一次性 nonce）；建议仅在 LAN 绑定。
   */
  joinService?: { enabled: boolean; bind?: string; port?: number };
  /**
   * W2 存储模式：`daemon`（默认于统一上车；走守护 app 接口，fleet 客户端化）/ `embedded`（**仅测试/CI**）。
   * 缺省（未设）= `embedded`，以保持既有测试/验收不变；`quickstart` 会写 `daemon`。
   */
  store?: 'daemon' | 'embedded';
  /** W2 守护 app 端点与令牌（daemon 模式必需） */
  daemon?: { endpoint: string; token?: string; tokenFile?: string };
}

export const fleetConfigPath = (dir: string): string => join(dir, 'fleet.config.json');
export const fleetMasterKeyPath = (dir: string): string => join(dir, 'master-key.json');
export const fleetStoragePath = (dir: string): string => join(dir, 'store.jsonl');

/** 校验配置；返回错误列表（空 = 合法）。 */
export function validateFleetConfig(input: unknown): string[] {
  const errors: string[] = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return ['config 必须是对象'];
  const c = input as Record<string, unknown>;
  if (c.v !== 1) errors.push('v 必须为 1');
  for (const key of ['device', 'dir', 'storagePath', 'masterKeyFile', 'namespace', 'listen']) {
    if (typeof c[key] !== 'string' || (c[key] as string).length === 0) errors.push(`${key} 必须为非空字符串`);
  }
  if (!Array.isArray(c.peers)) errors.push('peers 必须为数组');
  if (c.store !== undefined && c.store !== 'daemon' && c.store !== 'embedded') errors.push('store 必须为 daemon|embedded');
  if (c.daemon !== undefined) {
    const d = c.daemon as Record<string, unknown>;
    if (typeof d !== 'object' || d === null || typeof d.endpoint !== 'string' || d.endpoint.length === 0) errors.push('daemon.endpoint 必填');
    else if (d.token !== undefined && typeof d.token !== 'string') errors.push('daemon.token 非法');
    else if (d.tokenFile !== undefined && typeof d.tokenFile !== 'string') errors.push('daemon.tokenFile 非法');
  }
  if (c.joinService !== undefined) {
    const js = c.joinService as Record<string, unknown>;
    if (typeof js !== 'object' || js === null || typeof js.enabled !== 'boolean') errors.push('joinService 形状非法');
    else if (js.port !== undefined && (typeof js.port !== 'number' || js.port < 0 || js.port > 65535)) errors.push('joinService.port 非法');
    else if (js.bind !== undefined && typeof js.bind !== 'string') errors.push('joinService.bind 非法');
  }
  if (!Array.isArray(c.agents) || (c.agents as unknown[]).length === 0) errors.push('agents 必须为非空数组');
  for (const agent of (Array.isArray(c.agents) ? c.agents : []) as Array<Record<string, unknown>>) {
    if (typeof agent?.name !== 'string' || agent.name.length === 0) errors.push('agent.name 非法');
    if (!['echo', 'command', 'hermes', 'openchamber'].includes(String(agent?.kind))) {
      errors.push(`agent.kind 非法：${String(agent?.kind)}`);
    }
    if (agent?.kind === 'command' && (typeof agent.command !== 'string' || agent.command.length === 0)) {
      errors.push('command agent 需要 command');
    }
  }
  return errors;
}

/**
 * 解析 `--agent name:kind[,name:kind…]`（+ `--agent-command` / `--agent-base-args`）。
 * `command` agent 一律经调用方给定的 `command`（推荐 `process.execPath`）+ `baseArgs`
 * （如 fixture 路径）调用——**不依赖 shebang/可执行位**，Windows 亦然。
 */
export function parseAgentSpecs(
  value: string,
  options: { command?: string; baseArgs?: readonly string[] } = {},
): FleetAgentConfig[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const [name, kind] = entry.split(':');
      const agent: FleetAgentConfig = { name: name || 'echo', kind: (kind as FleetAgentKind) || 'echo' };
      if (agent.kind === 'command') {
        if (options.command !== undefined) agent.command = options.command;
        if (options.baseArgs !== undefined && options.baseArgs.length > 0) agent.baseArgs = [...options.baseArgs];
      }
      return agent;
    });
}

/** 保存配置（0600）。 */
export async function saveFleetConfig(path: string, config: FleetConfig): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(config, null, 2), { mode: 0o600 });
  if (permissionsApplicable()) await chmod(path, 0o600);
}

/** 读 `<storagePath>.identity.json` 的 deviceId（只读；缺失或损坏返回 null）。 */
export function identityDeviceIdForStorage(storagePath: string): string | null {
  if (typeof storagePath !== 'string' || storagePath.length === 0) return null;
  try {
    const record = JSON.parse(readFileSync(`${storagePath}.identity.json`, 'utf-8')) as Record<string, unknown>;
    return typeof record?.deviceId === 'string' && record.deviceId.length > 0 ? record.deviceId : null;
  } catch {
    return null;
  }
}

/**
 * 身份缺失时禁止在已有数据的 store 上自动签发新身份（避免自动换钥）。
 * JSONL 只有空白行视为空；其他格式（SQLite）无法证明为空即拒绝。
 */
export function assertFreshStoreForIdentity(storagePath: string): void {
  let stat;
  try {
    stat = statSync(storagePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return;
    throw error;
  }
  if (stat.size === 0) return;
  if (/\.jsonl?$/i.test(storagePath)) {
    const text = readFileSync(storagePath, 'utf-8');
    if (text.split('\n').every((line) => line.trim().length === 0)) return;
  }
  const error = new Error(
    `存储已有数据但身份文件缺失：拒绝自动生成新身份（${storagePath}）。请恢复原身份文件或从备份恢复。`,
  ) as Error & { code?: string };
  error.code = 'IDENTITY_STORE_OCCUPIED';
  throw error;
}

/** 配置里的 storagePath（相对路径按设备目录解析）。 */
export function resolveConfigStoragePath(dir: string, value: unknown): string {
  if (typeof value === 'string' && value.length > 0) {
    return isAbsolute(value) ? value : resolve(dir, value);
  }
  return join(dir, 'store.jsonl');
}

/**
 * 加载配置（形状非法即抛错）。
 * 身份文件是 deviceId 的唯一权威：fleet.config 的 `device` 仅作旧布局回退。
 */
export async function loadFleetConfig(path: string): Promise<FleetConfig> {
  const parsed = JSON.parse(await readFile(path, 'utf-8')) as unknown;
  const errors = validateFleetConfig(parsed);
  if (errors.length > 0) throw new Error(`config 非法：${errors.join('; ')}`);
  const config = parsed as FleetConfig;
  const storage = resolveConfigStoragePath(config.dir ?? dirname(path), config.storagePath);
  const identityDevice = identityDeviceIdForStorage(storage);
  return identityDevice !== null && identityDevice !== config.device
    ? { ...config, device: identityDevice }
    : config;
}

/**
 * F-UNI：任务工具的 home 适配——两种布局都支持：
 *   1) fleet home：`<dir>/fleet.config.json`（本机 fleet 设备）
 *   2) **守护 home**：`<dir>/config.json`（`mebular serve`，含 root/delegated 两种身份）
 * 由守护发起 `mebular mcp` 时 home 是守护 home，故这里把守护配置映射为等价 FleetConfig；
 * 业务逻辑（session/工具 handler）保持**唯一**在 fleet 侧。
 */
export function daemonConfigToFleet(dir: string, cfg: Record<string, unknown>): FleetConfig {
  const encryption = (cfg.encryption ?? {}) as Record<string, unknown>;
  const sync = (cfg.sync ?? {}) as Record<string, unknown>;
  const network = (cfg.network ?? {}) as Record<string, unknown>;
  const libp2p = (network.libp2p ?? {}) as Record<string, unknown>;
  const namespaces = Array.isArray(sync.namespaces) ? sync.namespaces.filter((s): s is string => typeof s === 'string' && s.length > 0) : [];
  const listen = Array.isArray(libp2p.listen) && typeof libp2p.listen[0] === 'string' ? libp2p.listen[0] : '/ip4/0.0.0.0/tcp/4001';
  const peers = (Array.isArray(network.peers) ? network.peers : [])
    .filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null && typeof (p as Record<string, unknown>).device === 'string')
    .map((p) => ({ device: String(p.device), ...(typeof p.addr === 'string' && p.addr.length > 0 ? { addr: p.addr } : {}) }));
  const storagePath = resolveConfigStoragePath(dir, cfg.storagePath);
  const masterKeyFile = typeof encryption.userMasterPublicKeyFile === 'string' && encryption.userMasterPublicKeyFile.length > 0
    ? encryption.userMasterPublicKeyFile
    : typeof encryption.keyFile === 'string' && encryption.keyFile.length > 0
      ? encryption.keyFile
      : join(dir, 'user-master-key.json');
  const identityDevice = identityDeviceIdForStorage(storagePath);
  const device = identityDevice
    ?? (typeof cfg.deviceId === 'string' && cfg.deviceId.length > 0 ? cfg.deviceId : `device-${basename(dir) || 'local'}`);
  return {
    v: 1,
    device,
    dir,
    storagePath,
    masterKeyFile,
    namespace: namespaces[0] ?? 'tasks',
    listen,
    peers,
    // 守护侧只作任务板（board），不注册执行型 agent；占位满足校验（kind 属合法枚举）
    agents: [{ name: 'board', kind: 'echo' }],
    ...(typeof cfg.quotaLimitPerDevice === 'number' ? { quotaLimitPerDevice: cfg.quotaLimitPerDevice } : {}),
  };
}

/** 读任务工具上下文配置：优先 fleet.config.json，否则按守护 config.json 适配。 */
export async function loadToolConfig(dir: string): Promise<FleetConfig> {
  const fleetPath = fleetConfigPath(dir);
  if (existsSync(fleetPath)) return loadFleetConfig(fleetPath);
  const daemonPath = join(dir, 'config.json');
  if (!existsSync(daemonPath)) {
    throw new Error(`缺少配置：${fleetPath} 与 ${daemonPath} 均不存在（需要 fleet.config.json 或守护 config.json）`);
  }
  const raw = JSON.parse(await readFile(daemonPath, 'utf-8')) as Record<string, unknown>;
  return daemonConfigToFleet(dir, raw);
}

export interface OnboardInput {
  dir: string;
  device: string;
  /** 已存在的用户主密钥文件（导入）；不给则生成 */
  masterKeyFile?: string;
  peerDevice?: string;
  peerAddr?: string;
  namespace?: string;
  listen?: string;
  agents?: FleetAgentConfig[];
  quotaLimitPerDevice?: number;
}

export interface OnboardResult {
  config: FleetConfig;
  alreadyOnboarded: boolean;
  masterKeyCreated: boolean;
  masterKeyFingerprint: string;
}

/** 主密钥指纹（sha256 前 12 hex；**非密钥材料**，可安全展示/用于匹配）。 */
export function masterKeyFingerprint(publicKey: Uint8Array): string {
  return `sha256:${createHash('sha256').update(publicKey).digest('hex').slice(0, 12)}`;
}
