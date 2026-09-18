// Fleet 设备配置与用户主密钥 IO（Step 1b）：全部 **0600**、默认脱敏、绝不回显密钥材料。
//
// 目录（device home）权限 0700；配置文件 `fleet.config.json`；主密钥 `master-key.json`；
// 事件存储 `store.jsonl`（设备身份 `store.jsonl.identity.json` 由 core 落盘）。

import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

const SUBTLE = globalThis.crypto.subtle;

/** core `Mebular` 需要的加密材料（用户主密钥）。 */
export interface FleetEncryption {
  userMasterKey: Uint8Array;
  userMasterPrivateKey: CryptoKey;
}

/** 生成 Ed25519 用户主密钥。 */
export async function generateMasterKey(): Promise<FleetEncryption> {
  const keyPair = (await SUBTLE.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const userMasterKey = new Uint8Array(await SUBTLE.exportKey('raw', keyPair.publicKey));
  return { userMasterKey, userMasterPrivateKey: keyPair.privateKey };
}

/** 写入主密钥文件（0600）。 */
export async function writeMasterKeyFile(path: string, encryption: FleetEncryption): Promise<void> {
  const pkcs8 = new Uint8Array(await SUBTLE.exportKey('pkcs8', encryption.userMasterPrivateKey));
  const record = {
    v: 1,
    alg: 'Ed25519',
    publicKey: Buffer.from(encryption.userMasterKey).toString('base64'),
    privateKeyPkcs8: Buffer.from(pkcs8).toString('base64'),
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(record), { mode: 0o600 });
  await chmod(path, 0o600);
}

/** 读取主密钥文件（不校验权限；权限由 doctor 断言）。 */
export async function readMasterKeyFile(path: string): Promise<FleetEncryption> {
  const parsed = JSON.parse(await readFile(path, 'utf-8')) as {
    v?: number;
    publicKey?: string;
    privateKeyPkcs8?: string;
  };
  if (parsed.v !== 1 || typeof parsed.publicKey !== 'string' || typeof parsed.privateKeyPkcs8 !== 'string') {
    throw new Error('master key file: 形状非法');
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
  /** 已授权对端（默认拒绝：未列出 = 不发送任何分区） */
  peers: FleetPeerConfig[];
  /** 引导签发者白名单（R-a） */
  policyIssuers: string[];
  /** 本机 agent 注册表（按 to.agent 名路由） */
  agents: FleetAgentConfig[];
  quotaLimitPerDevice?: number;
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
  if (!Array.isArray(c.policyIssuers)) errors.push('policyIssuers 必须为数组');
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

/** 保存配置（0600）。 */
export async function saveFleetConfig(path: string, config: FleetConfig): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(config, null, 2), { mode: 0o600 });
  await chmod(path, 0o600);
}

/** 加载配置（形状非法即抛错）。 */
export async function loadFleetConfig(path: string): Promise<FleetConfig> {
  const parsed = JSON.parse(await readFile(path, 'utf-8')) as unknown;
  const errors = validateFleetConfig(parsed);
  if (errors.length > 0) throw new Error(`config 非法：${errors.join('; ')}`);
  return parsed as FleetConfig;
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
  policyIssuers?: string[];
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
