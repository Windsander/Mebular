// 信任模型 v2（T2）：B 持**加入令牌**加入（不复制主密钥）。
//
// 流程：生成设备密钥 → 向 inviter 的 join 端点请求**委派证书**（令牌验签/TTL/一次性）→
// 落盘身份文件（含证书链，**无主私钥**）→ 写**主公钥**文件 → onboard（登记 inviter 地址）→ 声明成员。
// 主密钥私钥全程不出现；inviter 可为**任意**在册设备。

import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { constants } from 'node:fs';
import { Mebular, IdentityManager, bytesToHex, hexToBytes } from '@mebular/core';
import {
  fleetConfigPath,
  fleetMasterKeyPath,
  fleetStoragePath,
  loadFleetConfig,
  masterKeyFingerprint,
  readMasterKeyFile,
  writeMasterKeyFile,
  type FleetAgentConfig,
  type FleetEncryption,
} from './config.js';
import type { ServiceInstaller } from './quickstart.js';
import { offlineMebularOptions, onboardDevice } from './onboard.js';
import { agentMcpConfig, configureDaemonHome } from './quickstart.js';
import { decodeJoinToken, requestJoin } from './jointoken.js';

export interface JoinWithTokenInput {
  dir: string;
  token: string;
  device: string;
  namespace?: string;
  listen?: string;
  agents: FleetAgentConfig[];
  timeoutMs?: number;
  /** W2：同时配置统一守护（delegated 身份 + fleet daemon 客户端 + 令牌） */
  daemon?: boolean;
  daemonPort?: number;
  joinPort?: number;
  installDaemon?: ServiceInstaller;
}

export interface JoinWithTokenResult {
  device: string;
  dir: string;
  peer: string;
  namespace: string;
  fingerprint: string;
  alreadyJoined: boolean;
  inviterDeviceId: string;
  awaitingApproval: boolean;
  next: string[];
  /** W2：统一守护配置结果 */
  daemon?: { endpoint: string; installed: boolean; note?: string };
  /** W2：Agent MCP 配置片段 */
  agentMcp: Record<string, unknown>;
}

/** B：用令牌加入（**不持有主密钥私钥**）。 */
export async function joinWithToken(input: JoinWithTokenInput): Promise<JoinWithTokenResult> {
  const token = decodeJoinToken(input.token);
  const namespace = input.namespace ?? token.namespace;
  const listen = input.listen ?? '/ip4/0.0.0.0/tcp/4001';

  const alreadyJoined = await exists(fleetConfigPath(input.dir));
  if (alreadyJoined) {
    const existing = await loadFleetConfig(fleetConfigPath(input.dir));
    if (existing.device !== input.device) {
      throw new Error(`目录已被设备 ${existing.device} 占用（--dir ${input.dir}）；换目录或先停用。`);
    }
  }

  await mkdir(input.dir, { recursive: true });
  const storagePath = fleetStoragePath(input.dir);
  const keyPath = fleetMasterKeyPath(input.dir);
  let peerAddr: string | undefined;

  if (!alreadyJoined) {
    const im = new IdentityManager();
    const deviceKey = await im.generateDeviceKey(input.device, input.device);
    const issued = await requestJoin({
      endpoint: token.endpoint,
      token: input.token,
      deviceId: input.device,
      devicePublicKeyHex: bytesToHex(deviceKey.publicKey),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    });
    peerAddr = issued.inviterMultiaddrs[0];
    const privateKeyPkcs8 = await IdentityManager.exportPrivateKey(deviceKey.privateKey);
    const record = {
      deviceId: input.device,
      deviceName: input.device,
      publicKeyHex: bytesToHex(deviceKey.publicKey),
      certificate: issued.certificate,
      certificateChain: issued.chain,
      createdAt: Date.now(),
      privateKeyPkcs8,
    };
    await writeFile(`${storagePath}.identity.json`, JSON.stringify(record, null, 2), { mode: 0o600 });
    const publicOnly: FleetEncryption = { userMasterKey: hexToBytes(token.masterPublicKey) };
    await writeMasterKeyFile(keyPath, publicOnly);
  }

  const onboard = await onboardDevice({
    dir: input.dir,
    device: input.device,
    namespace,
    listen,
    agents: input.agents,
    peerDevice: token.inviterDeviceId,
    ...(peerAddr !== undefined ? { peerAddr } : {}),
    configGrant: false,
    policyIssuers: [token.inviterDeviceId],
  });
  const config = onboard.config;
  const encryption = await readMasterKeyFile(config.masterKeyFile);

  const mebular = new Mebular(offlineMebularOptions(config, encryption) as never);
  await mebular.initialize();
  try {
    await mebular.declareNamespaceMembership({ member: input.device, namespace, active: true, note: 'join-token self' });
  } finally {
    await mebular.shutdown();
  }

  // W2 B2：delegated 守护 home（无主私钥）+ fleet daemon 客户端 + （可选）mebular-serve
  let daemonInfo: { endpoint: string; installed: boolean; note?: string } | null = null;
  if (input.daemon === true) {
    const publicKeyFile = join(input.dir, 'user-master-key.json');
    await writeFile(publicKeyFile, JSON.stringify({ publicKey: Buffer.from(encryption.userMasterKey).toString('base64') }, null, 2), { mode: 0o600 });
    const peer = peerAddr ?? config.peers[0]?.addr;
    const peers = peer !== undefined ? [{ device: token.inviterDeviceId, addr: peer }] : [{ device: token.inviterDeviceId }];
    const { endpoint } = await configureDaemonHome(
      input.dir,
      config,
      namespace,
      input.joinPort ?? 4002,
      input.daemonPort ?? 7331,
      { userMasterPublicKeyFile: publicKeyFile },
      peers,
    );
    let installed = false;
    let note: string | undefined;
    if (input.installDaemon !== undefined) {
      const outcome = await input.installDaemon(input.dir);
      installed = outcome.installed;
      note = outcome.note;
    }
    daemonInfo = { endpoint, installed, ...(note !== undefined ? { note } : {}) };
  }

  return {
    device: config.device,
    dir: config.dir,
    peer: token.inviterDeviceId,
    namespace,
    fingerprint: masterKeyFingerprint(encryption.userMasterKey),
    alreadyJoined,
    inviterDeviceId: token.inviterDeviceId,
    awaitingApproval: true,
    next: [
      `在 ${token.inviterDeviceId} 上运行：fleet pending`,
      `在 ${token.inviterDeviceId} 上运行：fleet approve ${config.device}`,
    ],
    ...(daemonInfo !== null ? { daemon: daemonInfo } : {}),
    agentMcp: agentMcpConfig(),
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
