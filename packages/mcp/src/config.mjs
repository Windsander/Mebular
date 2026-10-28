// MCP 侧配置加载（G6.2）
//
// 优先级：CLI > env > .mebular/config.json > 默认。
// 密钥不落 config：主密钥来自 env / config.encryption.keyFile / <home>/user-master-key.json，
// 都没有则生成并持久化到 <home>/user-master-key.json（0600）。

import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Mebular, IdentityManager, FileEndpointStore, EndpointBook } from '@mebular/core';
import { homeDir } from './home.mjs';
import {
  cleanLegacyConfig,
  createIdentityForStorage,
  prepareHomeIdentity,
  storagePathForHome,
} from './home-identity.mjs';

/** 统一家目录（唯一真源，F-INST-1）：见 `./home.mjs`。 */
export { homeDir };

export function configPath(home) {
  return process.env.MEBULAR_CONFIG ?? join(home, 'config.json');
}

/** C2：候选地址簿文件（0600；机制在 core，路径由 app 决定）。 */
export function endpointsPath(home) {
  return process.env.MEBULAR_ENDPOINTS_FILE ?? join(home, 'net', 'peers.json');
}

/** C2：配置里的配对 hints（deviceId/peerId → multiaddr 列表），形状容错。 */
export function networkHints(config) {
  const raw = config?.network?.endpoints;
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw)) {
    if (typeof key !== 'string' || !Array.isArray(value)) continue;
    const addrs = value.filter((entry) => typeof entry === 'string' && entry.length > 0);
    if (addrs.length > 0) out[key] = addrs;
  }
  return out;
}

/**
 * C2：从地址簿保留键读取 relay seeds（配对令牌随附；daemon 启动时并入 relayServers）。
 * 读失败一律返回 []（地址簿问题不得阻断启动）。
 */
export async function relaySeedsFromBook(home) {
  try {
    const book = new EndpointBook({ store: new FileEndpointStore(endpointsPath(home)) });
    await book.load();
    return book.relaySeeds();
  } catch {
    return [];
  }
}

/** C2：relay seeds（客户端可用于中转的 relay multiaddr；并入 libp2p.relayServers）。 */
export function relaySeeds(config) {
  const raw = config?.network?.relaySeeds;
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry) => typeof entry === 'string' && entry.length > 0);
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

/** 只读主密钥记录（CLI init / provision 在签发身份前校验 keyFile）。 */
export async function readMasterKeyRecord(source) {
  return readKeyRecord(source);
}

/**
 * 解析用户主密钥；按 env > config.keyFile > <home>/user-master-key.json > 生成并持久化。
 * `allowGenerate:false` 用于「已有身份」：绝不自动生成新的信任根。
 */
export async function resolveMasterKeys(home, config, { allowGenerate = true } = {}) {
  const envFile = process.env.MEBULAR_USER_MASTER_KEY_FILE;
  const envInline = process.env.MEBULAR_USER_MASTER_KEY;
  if (envFile) return readKeyRecord(envFile);
  if (envInline) return readKeyRecord(envInline);

  const configuredFile = config.encryption?.keyFile;
  if (configuredFile) return readKeyRecord(configuredFile);

  const defaultFile = join(home, 'user-master-key.json');
  if (existsSync(defaultFile)) return readKeyRecord(defaultFile);

  if (!allowGenerate) {
    const error = new Error(
      `已有设备身份，但缺少用户主密钥：${defaultFile}（不会自动生成新的信任根；请恢复原主密钥或从备份恢复）`,
    );
    error.code = 'IDENTITY_TRUST_ROOT_MISSING';
    throw error;
  }

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
  if (!existsSync(identityFile)) return 'root';
  try {
    const identity = JSON.parse(readFileSync(identityFile, 'utf-8'));
    // 主密钥直签的 root 身份没有 issuer/委派链；即使本地主密钥缺失也仍是 root
    // （交给「信任根缺失」错误处理，而不是误判成 delegated）。
    const chain = Array.isArray(identity?.certificateChain) ? identity.certificateChain : [];
    if (identity?.certificate?.issuer !== undefined || chain.length > 1) return 'delegated';
    if (identity?.certificate !== undefined) return 'root';
  } catch {
    // 身份文件损坏：交给 preflight 以 IDENTITY_INVALID fail closed。
    return 'root';
  }
  // 旧/异构身份文件：沿用历史判定（主私钥在场 = root）。
  const masterFile = config.encryption?.keyFile ?? join(home, 'user-master-key.json');
  try {
    const rec = JSON.parse(readFileSync(masterFile, 'utf-8'));
    if (typeof rec.privateKeyPkcs8 !== 'string') return 'delegated';
  } catch {
    return 'delegated';
  }
  return 'root';
}

/**
 * 读取**用户主公钥**（委派模式只需公钥）。
 * 候选：`config.encryption.userMasterPublicKeyFile` → <home>/user-master-key.json → <home>/master-key.json
 * （后两者覆盖 config 缺失时的既有布局；只读公开材料）。
 */
export async function resolveMasterPublicKey(home, config) {
  const candidates = [
    config.encryption?.userMasterPublicKeyFile,
    join(home, 'user-master-key.json'),
    join(home, 'master-key.json'),
  ].filter((file) => typeof file === 'string' && file.length > 0);
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const data = JSON.parse(await readFile(file, 'utf-8'));
    if (typeof data.publicKey !== 'string') throw new Error(`主公钥文件形状非法：${file}`);
    return new Uint8Array(Buffer.from(data.publicKey, 'base64'));
  }
  throw new Error(
    `委派身份模式需要用户主公钥（已尝试：${candidates.join(' / ')}）；`
      + '请配置 encryption.userMasterPublicKeyFile 或恢复主公钥文件',
  );
}

/** 依配置构建并初始化 Mebular 门面 */
export async function createMebular() {
  const home = homeDir();
  const config = await loadConfigFile(home);
  const storageAdapter = config.storageAdapter ?? 'json';
  const storagePath = storagePathForHome(home, config, process.env);
  // F-IDENT-1：身份文件是 deviceId/deviceName 的唯一权威；env/config 只在身份缺失时作为 bootstrap。
  const prepared = prepareHomeIdentity({ home, config, env: process.env });
  if (!prepared.ok) {
    const error = new Error(prepared.message);
    error.code = prepared.code;
    error.identityPath = prepared.identityPath;
    if (prepared.problems) error.problems = prepared.problems;
    throw error;
  }
  for (const warning of prepared.warnings) console.error(`warning: ${warning}`);
  const mode = identityMode(home, config, storagePath);
  if (prepared.status === 'missing' && mode === 'delegated') {
    const error = new Error(
      `委派身份缺少身份文件：${prepared.identityPath}。委派设备需要既有证书链，不能在本机新签发。`,
    );
    error.code = 'IDENTITY_NOT_INITIALIZED';
    error.identityPath = prepared.identityPath;
    throw error;
  }
  // 生效值快照（console 设置卡应展示这些，而不是静态 config，否则 CLI/env 覆盖后卡片会失真）
  const effective = {
    deviceName: prepared.identity.deviceName,
    identityMode: mode,
    storageAdapter,
    encryptionLevel: config.encryption?.level ?? 'none',
    networkEnabled: truthy(process.env.MEBULAR_NETWORK_ENABLED, config.network?.enabled ?? false),
    autoSync: config.sync?.autoSync ?? true,
    // C2：候选地址簿（自动选路）与端点簿文件
    autoConnect: config.network?.autoConnect !== false,
    endpointsPath: endpointsPath(home),
    endpointsCount: Object.keys(networkHints(config)).length,
    relaySeeds: relaySeeds(config),
    // C3：LAN 自动发现
    lanEnabled: config.network?.lan?.enabled !== false,
    lanAutoDial: config.network?.lan?.autoDial !== false,
    lanDefaultFactory: config.network?.lan?.defaultFactory !== false,
    pushOnWrite: truthy(process.env.MEBULAR_PUSH_ON_WRITE, config.sync?.pushOnWrite ?? true),
    pushOnWriteThrottleMs: config.sync?.pushOnWriteThrottleMs ?? null,
    peerWhitelist: Array.isArray(config.sync?.peerWhitelist) ? [...config.sync.peerWhitelist] : [],
    semanticEnabled: truthy(process.env.MEBULAR_SEMANTIC_ENABLED, config.semantic?.enabled ?? false),
    semanticMinScore: config.semantic?.minScore ?? 0.2,
  };
  const masterKeys =
    mode === 'delegated'
      ? { userMasterKey: await resolveMasterPublicKey(home, config) }
      // 已有身份时禁止自动生成新主密钥（避免静默更换信任根）。
      : await resolveMasterKeys(home, config, { allowGenerate: prepared.status === 'missing' });

  let deviceId = prepared.identity.deviceId;
  let deviceName = prepared.identity.deviceName;
  if (prepared.status === 'missing') {
    const created = await createIdentityForStorage({
      storagePath,
      deviceId,
      deviceName,
      userMasterPrivateKey: masterKeys.userMasterPrivateKey,
      userMasterPublicKey: masterKeys.userMasterKey,
    });
    deviceId = created.deviceId;
    deviceName = created.deviceName;
    effective.deviceName = created.deviceName;
  }

  // C2：地址簿里的 seeds（配对时随令牌写入）+ 配置 seeds → 客户端 relay 列表
  const bookSeeds = effective.networkEnabled ? await relaySeedsFromBook(home) : [];
  const app = new Mebular({
    storagePath,
    deviceId,
    ...(deviceName ? { deviceName } : {}),
    ...(config.storageAdapter ? { storageAdapter: config.storageAdapter } : {}),
    encryption: {
      level: effective.encryptionLevel,
      userMasterKey: masterKeys.userMasterKey,
      ...(masterKeys.userMasterPrivateKey !== undefined ? { userMasterPrivateKey: masterKeys.userMasterPrivateKey } : {}),
      ...(process.env[config.encryption?.passphraseEnv ?? 'MEBULAR_PASSPHRASE']
        ? { passphrase: process.env[config.encryption?.passphraseEnv ?? 'MEBULAR_PASSPHRASE'] }
        : {}),
    },
    network: {
      enabled: effective.networkEnabled,
      // C2：无显式地址时走候选地址簿（默认开）；hints/端点簿由 app 注入，core 不读文件
      autoConnect: effective.autoConnect,
      // 常驻入口：默认真 mDNS（策略在 app；库形态默认关闭）
      lan: {
        enabled: effective.lanEnabled,
        autoDial: effective.lanAutoDial,
        defaultFactory: effective.lanEnabled && effective.lanDefaultFactory,
      },
      endpoints: networkHints(config),
      endpointStore: new FileEndpointStore(effective.endpointsPath),
      // C4：NAT 穿透（AutoNAT/DCUtR）直通；未配置 = auto（依赖在场即启用）
      ...(config.network?.nat ? { nat: config.network.nat } : {}),
      ...(config.network?.libp2p || bookSeeds.length > 0
        ? {
            libp2p: {
              ...(config.network.libp2p.listen ? { listen: config.network.libp2p.listen } : {}),
              ...(() => {
                const seeds = [...new Set([...(config.network.libp2p.relayServers ?? []), ...effective.relaySeeds, ...bookSeeds])];
                return seeds.length > 0 ? { relayServers: seeds } : {};
              })(),
              ...(config.network.libp2p.relayPolicy ? { relayPolicy: config.network.libp2p.relayPolicy } : {}),
              ...(config.network.libp2p.relayServer !== undefined
                ? { relayServer: config.network.libp2p.relayServer }
                : {}),
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
      // P3 · 收敛健康度：常驻入口默认开启（纯观察层；形状照 antiEntropy 先例）。
      // 会话尾状态指纹（C3 A 类可选字段）随之启用；kill-switch：config.json 置
      // sync.convergence = { enabled:false } 即回默认静默观察。
      convergence: config.sync?.convergence ?? { enabled: true },
      ...(config.sync?.snapshotThreshold !== undefined
        ? { snapshotThreshold: config.sync.snapshotThreshold }
        : {}),
      ...(Array.isArray(config.sync?.namespaces) ? { namespaces: config.sync.namespaces } : {}),
      ...(Array.isArray(config.sync?.peerWhitelist) ? { peerWhitelist: config.sync.peerWhitelist } : {}),
    },
    semantic: {
      enabled: effective.semanticEnabled,
      ...(config.semantic?.model ? { model: config.semantic.model } : {}),
      ...(config.semantic?.cacheDir ? { cacheDir: config.semantic.cacheDir } : {}),
      ...(config.semantic?.minScore !== undefined ? { minScore: config.semantic.minScore } : {}),
    },
  });
  await app.initialize();
  // 身份已就绪：备份并移除 legacy config 身份字段（即使旧值与身份不同也以身份为准）。
  // 失败不阻断启动：身份仍是唯一权威，下次启动重试迁移。
  try {
    const migrated = await cleanLegacyConfig({ configPath: configPath(home), identity: { deviceId, deviceName } });
    for (const warning of migrated.warnings) console.error(`warning: ${warning}`);
    if (migrated.migrated) {
      delete config.deviceId;
      delete config.deviceName;
    }
  } catch (error) {
    console.error(`warning: 无法清理 config.json 旧身份字段（${error?.message ?? error}）`);
  }
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
  return { app, home, config, storagePath, deviceId, identityMode: mode, effective };
}

export { homedir } from 'node:os';
