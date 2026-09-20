// MCP 侧配置加载（G6.2）
//
// 优先级：CLI > env > .mebular/config.json > 默认。
// 密钥不落 config：主密钥来自 env / config.encryption.keyFile / <home>/user-master-key.json，
// 都没有则生成并持久化到 <home>/user-master-key.json（0600）。

import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Mebular, IdentityManager } from '@mebular/core';

/** 统一家目录（W2）：`MEBULAR_HOME` 覆盖，缺省 `~/.mebular`。 */
export function homeDir() {
  return process.env.MEBULAR_HOME ?? join(homedir(), '.mebular');
}

export function configPath(home) {
  return process.env.MEBULAR_CONFIG ?? join(home, 'config.json');
}

export async function loadConfigFile(home) {
  const path = configPath(home);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(await readFile(path, 'utf-8'));
  } catch (error) {
    throw new Error(`配置文件损坏：${path}（${error.message}）`);
  }
}

function truthy(value, fallback) {
  if (value === undefined) return fallback;
  return value === true || value === 'true' || value === '1';
}

async function readKeyRecord(source) {
  const data = existsSync(source)
    ? JSON.parse(await readFile(source, 'utf-8'))
    : JSON.parse(source);
  return {
    userMasterKey: new Uint8Array(Buffer.from(data.publicKey, 'base64')),
    userMasterPrivateKey: await IdentityManager.importPrivateKey(data.privateKeyPkcs8),
  };
}

/** 解析用户主密钥；按 env > config.keyFile > <home>/user-master-key.json > 生成并持久化 */
export async function resolveMasterKeys(home, config) {
  const envFile = process.env.MEBULAR_USER_MASTER_KEY_FILE;
  const envInline = process.env.MEBULAR_USER_MASTER_KEY;
  if (envFile) return readKeyRecord(envFile);
  if (envInline) return readKeyRecord(envInline);

  const configuredFile = config.encryption?.keyFile;
  if (configuredFile) return readKeyRecord(configuredFile);

  const defaultFile = join(home, 'user-master-key.json');
  if (existsSync(defaultFile)) return readKeyRecord(defaultFile);

  const master = await new IdentityManager().generateUserMasterKey();
  const record = {
    publicKey: Buffer.from(master.publicKey).toString('base64'),
    privateKeyPkcs8: await IdentityManager.exportPrivateKey(master.privateKey),
    createdAt: new Date().toISOString(),
  };
  await mkdir(dirname(defaultFile), { recursive: true });
  await writeFile(defaultFile, JSON.stringify(record, null, 2), 'utf-8');
  await chmod(defaultFile, 0o600);
  return { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey };
}

/**
 * 身份模式（W2）：`root`（持有用户主密钥私钥）或 `delegated`（仅委派证书链 + 设备钥，**无主私钥**）。
 * 判定：显式 `identity.mode` 优先；否则存在 `<storagePath>.identity.json` 且无本地主私钥 → delegated。
 */
export function identityMode(home, config, storagePath) {
  const explicit = config.identity?.mode;
  if (explicit === 'root' || explicit === 'delegated') return explicit;
  const identityFile = `${storagePath}.identity.json`;
  const masterFile = config.encryption?.keyFile ?? join(home, 'user-master-key.json');
  if (existsSync(identityFile)) {
    try {
      const rec = JSON.parse(readFileSync(masterFile, 'utf-8'));
      if (typeof rec.privateKeyPkcs8 !== 'string') return 'delegated';
    } catch {
      return 'delegated';
    }
  }
  return 'root';
}

/** 读取**用户主公钥**（委派模式只需公钥；`config.encryption.userMasterPublicKeyFile` 或 <home>/user-master-key.json）。 */
export async function resolveMasterPublicKey(home, config) {
  const file = config.encryption?.userMasterPublicKeyFile ?? join(home, 'user-master-key.json');
  if (!existsSync(file)) {
    throw new Error(`委派身份模式需要用户主公钥：${file}（配置 encryption.userMasterPublicKeyFile 或放入该文件）`);
  }
  const data = JSON.parse(await readFile(file, 'utf-8'));
  if (typeof data.publicKey !== 'string') throw new Error(`主公钥文件形状非法：${file}`);
  return new Uint8Array(Buffer.from(data.publicKey, 'base64'));
}

/** 依配置构建并初始化 Mebular 门面 */
export async function createMebular() {
  const home = homeDir();
  const config = await loadConfigFile(home);
  const storagePath = process.env.MEBULAR_STORAGE_PATH ?? config.storagePath ?? join(home, 'store.jsonl');
  const deviceId = process.env.MEBULAR_DEVICE_ID ?? config.deviceId ?? `device-${process.env.HOSTNAME ?? 'local'}`;
  const deviceName = process.env.MEBULAR_DEVICE_NAME ?? config.deviceName;
  const mode = identityMode(home, config, storagePath);
  const masterKeys =
    mode === 'delegated'
      ? { userMasterKey: await resolveMasterPublicKey(home, config) }
      : await resolveMasterKeys(home, config);

  const app = new Mebular({
    storagePath,
    deviceId,
    ...(deviceName ? { deviceName } : {}),
    ...(config.storageAdapter ? { storageAdapter: config.storageAdapter } : {}),
    encryption: {
      level: config.encryption?.level ?? 'none',
      userMasterKey: masterKeys.userMasterKey,
      ...(masterKeys.userMasterPrivateKey !== undefined ? { userMasterPrivateKey: masterKeys.userMasterPrivateKey } : {}),
      ...(process.env[config.encryption?.passphraseEnv ?? 'MEBULAR_PASSPHRASE']
        ? { passphrase: process.env[config.encryption?.passphraseEnv ?? 'MEBULAR_PASSPHRASE'] }
        : {}),
    },
    network: {
      enabled: truthy(process.env.MEBULAR_NETWORK_ENABLED, config.network?.enabled ?? false),
      ...(config.network?.libp2p
        ? {
            libp2p: {
              ...(config.network.libp2p.listen ? { listen: config.network.libp2p.listen } : {}),
              ...(config.network.libp2p.relayServers ? { relayServers: config.network.libp2p.relayServers } : {}),
              ...(config.network.libp2p.relayUnlimited !== undefined
                ? { relayUnlimited: config.network.libp2p.relayUnlimited }
                : {}),
            },
          }
        : {}),
    },
    sync: {
      autoSync: config.sync?.autoSync ?? true,
      // 常驻入口（MCP serve）默认实时：写入即推（含反向 nudge）+ 周期 anti-entropy。
      // 库形态默认关闭（见 README「同步触发时机」）；可显式置 false 关闭。
      pushOnWrite: truthy(process.env.MEBULAR_PUSH_ON_WRITE, config.sync?.pushOnWrite ?? true),
      antiEntropy: config.sync?.antiEntropy ?? { enabled: true, intervalMs: 600000, jitterRatio: 0.2 },
      ...(config.sync?.snapshotThreshold !== undefined
        ? { snapshotThreshold: config.sync.snapshotThreshold }
        : {}),
      // 默认拒绝：对端白名单未配置 = 拒绝所有对端。跨机部署必须显式填写。
      ...(config.sync?.peerNamespacePolicy
        ? { peerNamespacePolicy: config.sync.peerNamespacePolicy }
        : {}),
      ...(Array.isArray(config.sync?.namespaces) ? { namespaces: config.sync.namespaces } : {}),
      // W2 A2：引导签发者白名单（图上声明 ∪ 本地配置）
      ...(Array.isArray(config.sync?.policyIssuers) ? { policyIssuers: config.sync.policyIssuers } : {}),
    },
    semantic: {
      enabled: truthy(process.env.MEBULAR_SEMANTIC_ENABLED, config.semantic?.enabled ?? false),
      ...(config.semantic?.model ? { model: config.semantic.model } : {}),
      ...(config.semantic?.cacheDir ? { cacheDir: config.semantic.cacheDir } : {}),
      ...(config.semantic?.minScore !== undefined ? { minScore: config.semantic.minScore } : {}),
    },
  });
  await app.initialize();
  // W2：按 config.network.peers 主动拨号（daemon 形态的点对点建立；只有一方需地址）
  for (const peer of config.network?.peers ?? []) {
    if (typeof peer?.addr !== 'string' || peer.addr.length === 0) continue;
    const id = /\/p2p\/([^/]+)/.exec(peer.addr)?.[1] ?? peer.device;
    try {
      await app.node?.connectToPeer({ id, multihash: new Uint8Array(), pubKey: new Uint8Array() }, peer.addr);
    } catch {
      // 由后续 anti-entropy / doctor 暴露
    }
  }
  return { app, home, config, storagePath, deviceId, identityMode: mode };
}

export { homedir };
