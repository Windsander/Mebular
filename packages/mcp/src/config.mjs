// MCP 侧配置加载（G6.2）
//
// 优先级：CLI > env > .mebular/config.json > 默认。
// 密钥不落 config：主密钥来自 env / config.encryption.keyFile / <home>/user-master-key.json，
// 都没有则生成并持久化到 <home>/user-master-key.json（0600）。

import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Mebular, IdentityManager } from '@mebular/core';

export function homeDir() {
  return process.env.MEBULAR_HOME ?? join(process.cwd(), '.mebular');
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

/** 依配置构建并初始化 Mebular 门面 */
export async function createMebular() {
  const home = homeDir();
  const config = await loadConfigFile(home);
  const storageAdapter = config.storageAdapter ?? 'json';
  const storagePath = process.env.MEBULAR_STORAGE_PATH
    ?? config.storagePath
    ?? join(home, storageAdapter === 'sqlite' ? 'store.sqlite' : 'store.jsonl');
  const deviceId = process.env.MEBULAR_DEVICE_ID ?? config.deviceId ?? `device-${process.env.HOSTNAME ?? 'local'}`;
  const deviceName = process.env.MEBULAR_DEVICE_NAME ?? config.deviceName;
  // 生效值快照（console 设置卡应展示这些，而不是静态 config，否则 CLI/env 覆盖后卡片会失真）
  const effective = {
    deviceName: deviceName ?? null,
    storageAdapter,
    encryptionLevel: config.encryption?.level ?? 'none',
    networkEnabled: truthy(process.env.MEBULAR_NETWORK_ENABLED, config.network?.enabled ?? false),
    autoSync: config.sync?.autoSync ?? true,
    pushOnWrite: truthy(process.env.MEBULAR_PUSH_ON_WRITE, config.sync?.pushOnWrite ?? true),
    pushOnWriteThrottleMs: config.sync?.pushOnWriteThrottleMs ?? null,
    // L5：对端白名单（设备级）；此前未透传 → 配置写了不生效
    peerWhitelist: Array.isArray(config.sync?.peerWhitelist) ? [...config.sync.peerWhitelist] : [],
    semanticEnabled: truthy(process.env.MEBULAR_SEMANTIC_ENABLED, config.semantic?.enabled ?? false),
    semanticMinScore: config.semantic?.minScore ?? 0.2,
  };
  const masterKeys = await resolveMasterKeys(home, config);

  const app = new Mebular({
    storagePath,
    deviceId,
    ...(deviceName ? { deviceName } : {}),
    ...(config.storageAdapter ? { storageAdapter: config.storageAdapter } : {}),
    encryption: {
      level: effective.encryptionLevel,
      userMasterKey: masterKeys.userMasterKey,
      userMasterPrivateKey: masterKeys.userMasterPrivateKey,
      ...(process.env[config.encryption?.passphraseEnv ?? 'MEBULAR_PASSPHRASE']
        ? { passphrase: process.env[config.encryption?.passphraseEnv ?? 'MEBULAR_PASSPHRASE'] }
        : {}),
    },
    network: {
      enabled: effective.networkEnabled,
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
      pushOnWrite: effective.pushOnWrite,
      ...(effective.pushOnWriteThrottleMs !== null ? { pushOnWriteThrottleMs: effective.pushOnWriteThrottleMs } : {}),
      antiEntropy: config.sync?.antiEntropy ?? { enabled: true, intervalMs: 600000, jitterRatio: 0.2 },
      ...(config.sync?.snapshotThreshold !== undefined
        ? { snapshotThreshold: config.sync.snapshotThreshold }
        : {}),
      // 默认拒绝：对端白名单未配置 = 拒绝所有对端。跨机部署必须显式填写。
      ...(config.sync?.peerNamespacePolicy
        ? { peerNamespacePolicy: config.sync.peerNamespacePolicy }
        : {}),
      ...(Array.isArray(config.sync?.namespaces) ? { namespaces: config.sync.namespaces } : {}),
      ...(Array.isArray(config.sync?.peerWhitelist) ? { peerWhitelist: config.sync.peerWhitelist } : {}),
      // 引导期策略签发者白名单（R-a）：图上 grant-as-memory 的 bootstrap 路径，
      // 未透传会让本机签发的 grant 无法被采纳（控制台域开关会显示为空）。
      ...(Array.isArray(config.sync?.policyIssuers) ? { policyIssuers: config.sync.policyIssuers } : {}),
    },
    semantic: {
      enabled: effective.semanticEnabled,
      ...(config.semantic?.model ? { model: config.semantic.model } : {}),
      ...(config.semantic?.cacheDir ? { cacheDir: config.semantic.cacheDir } : {}),
      ...(config.semantic?.minScore !== undefined ? { minScore: config.semantic.minScore } : {}),
    },
  });
  await app.initialize();
  return { app, home, config, storagePath, deviceId, effective };
}

export { homedir };
