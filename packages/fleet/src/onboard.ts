// Fleet 设备上车 + 自检（Step 1b）。
//
// `onboardDevice`：一次（幂等）完成 主密钥（生成/导入，0600）→ 配置 → 设备证书（core 落盘）。
// `doctor`：逐项 PASS/FAIL/SKIP（含脱敏与修复建议）；`skipped` 明列原因。

import { access, chmod, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import net from 'node:net';
import { Mebular, POLICY_NAMESPACE } from '@mebular/core';

import {
  fileMode,
  fleetConfigPath,
  fleetMasterKeyPath,
  fleetStoragePath,
  generateMasterKey,
  loadFleetConfig,
  masterKeyFingerprint,
  readMasterKeyFile,
  saveFleetConfig,
  validateFleetConfig,
  writeMasterKeyFile,
  type FleetAgentConfig,
  type FleetConfig,
  type FleetEncryption,
  type OnboardInput,
  type OnboardResult,
} from './config.js';
import { CommandAgent, ExecutorRegistry, HermesAgent } from './runtime/agent.js';
import { HttpOpenChamberSeam } from './runtime/openchamber-http.js';
import { OpenChamberAgent } from './runtime/openchamber.js';
import { EchoExecutor } from './runtime/executor.js';

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** 由 agent 配置构建执行器注册表（未知 kind 已在校验期拒绝）。 */
export function buildRegistry(agents: readonly FleetAgentConfig[]): ExecutorRegistry {
  const registry = new ExecutorRegistry();
  for (const a of agents) {
    if (a.kind === 'echo') registry.register(a.name, new EchoExecutor());
    else if (a.kind === 'command') {
      registry.register(
        a.name,
        new CommandAgent({
          command: a.command ?? '',
          ...(a.baseArgs !== undefined ? { baseArgs: a.baseArgs } : {}),
          ...(a.timeoutMs !== undefined ? { timeoutMs: a.timeoutMs } : {}),
          ...(a.concurrency !== undefined ? { concurrency: a.concurrency } : {}),
        }),
      );
    } else if (a.kind === 'hermes') {
      registry.register(a.name, new HermesAgent({ ...(a.timeoutMs !== undefined ? { timeoutMs: a.timeoutMs } : {}) }));
    } else {
      registry.register(
        a.name,
        new OpenChamberAgent(new HttpOpenChamberSeam({ ...(a.timeoutMs !== undefined ? { timeoutMs: a.timeoutMs } : {}) })),
      );
    }
  }
  return registry;
}

/**
 * 由配置 + 加密材料构造 core `Mebular` 选项（默认拒绝：仅授权 peers）。
 *
 * `peerNamespacePolicy`：显式给出（含 `{}`）→ **以它为准**（G1：可只留图上 grant）；
 * 缺省 → 由 `peers` 推导（每个对端 `[namespace]`，Step 1b bootstrap 行为）。
 */
export function mebularOptions(config: FleetConfig, encryption: FleetEncryption): Record<string, unknown> {
  const peerNamespacePolicy = derivedPeerNamespacePolicy(config);
  return {
    storagePath: config.storagePath,
    deviceId: config.device,
    encryption,
    network: { enabled: true, libp2p: { listen: [config.listen] } },
    sync: {
      autoSync: true,
      pushOnWrite: true,
      pushOnWriteThrottleMs: 20,
      namespaces: [config.namespace],
      peerNamespacePolicy,
      policyIssuers: config.policyIssuers,
      antiEntropy: { enabled: true, intervalMs: 600_000, jitterRatio: 0.2 },
    },
  };
}

/**
 * bootstrap 配置白名单：显式 `peerNamespacePolicy`（含 `{}`）优先；缺省由 `peers` 推导。
 * 联网与离线路径**必须同源**，否则 doctor 与 serve/work 的生效授权会漂移。
 */
function derivedPeerNamespacePolicy(config: FleetConfig): Record<string, string[]> {
  return config.peerNamespacePolicy ?? Object.fromEntries(config.peers.map((peer) => [peer.device, [config.namespace]]));
}

/** 离线（不启网络）`Mebular` 选项：onboard/doctor/grant/revoke 用，只读写本地存储。 */
export function offlineMebularOptions(config: FleetConfig, encryption: FleetEncryption): Record<string, unknown> {
  return {
    storagePath: config.storagePath,
    deviceId: config.device,
    encryption,
    network: { enabled: false },
    // 策略（bootstrap 白名单 + R-a 签发者）与联网路径同源，否则离线 doctor 判定会漂移。
    sync: { policyIssuers: config.policyIssuers, peerNamespacePolicy: derivedPeerNamespacePolicy(config) },
  };
}

/** 生成/导入主密钥并写配置；幂等（重复执行不损坏身份）。 */
export async function onboardDevice(input: OnboardInput): Promise<OnboardResult> {
  if (typeof input.device !== 'string' || input.device.length === 0) throw new Error('onboard 需要 --device');
  await mkdir(input.dir, { recursive: true });
  await chmod(input.dir, 0o700);

  const keyPath = fleetMasterKeyPath(input.dir);
  let masterKeyCreated = false;
  let encryption: FleetEncryption;
  if (input.masterKeyFile !== undefined) {
    encryption = await readMasterKeyFile(input.masterKeyFile);
    await writeMasterKeyFile(keyPath, encryption); // 归一化到设备目录，0600
  } else if (await exists(keyPath)) {
    encryption = await readMasterKeyFile(keyPath);
  } else {
    encryption = await generateMasterKey();
    await writeMasterKeyFile(keyPath, encryption);
    masterKeyCreated = true;
  }

  const config: FleetConfig = {
    v: 1,
    device: input.device,
    dir: input.dir,
    storagePath: fleetStoragePath(input.dir),
    masterKeyFile: keyPath,
    namespace: input.namespace ?? 'tasks',
    listen: input.listen ?? '/ip4/0.0.0.0/tcp/0',
    peers: input.peerDevice !== undefined ? [{ device: input.peerDevice, ...(input.peerAddr !== undefined ? { addr: input.peerAddr } : {}) }] : [],
    ...(input.configGrant === false ? { peerNamespacePolicy: {} } : {}),
    policyIssuers: input.policyIssuers ?? [],
    agents: input.agents ?? [{ name: 'echo', kind: 'echo' }],
    ...(input.quotaLimitPerDevice !== undefined ? { quotaLimitPerDevice: input.quotaLimitPerDevice } : {}),
  };
  const errors = validateFleetConfig(config);
  if (errors.length > 0) throw new Error(`onboard 配置非法：${errors.join('; ')}`);

  const alreadyOnboarded = await exists(fleetConfigPath(input.dir));
  await saveFleetConfig(fleetConfigPath(input.dir), config);

  // 用 core 落盘设备身份/证书（幂等：已存在则复用）。
  const mebular = new Mebular({
    storagePath: config.storagePath,
    deviceId: config.device,
    encryption,
    network: { enabled: false },
  } as never);
  await mebular.initialize();
  await mebular.shutdown();

  return { config, alreadyOnboarded, masterKeyCreated, masterKeyFingerprint: masterKeyFingerprint(encryption.userMasterKey) };
}

/**
 * G1：本机签发 namespace grant（落保留命名空间 `__policy__`）。只有链到用户主密钥的
 * 设备签发的记录才被采纳；**不可自授**（core 的 R-a 保证），且 `grantNamespaces` 不接受
 * 指定 grantId（R-d 的恢复必须产生新 id）。只消费 core 公共 API。
 */
export async function grantNamespace(
  dir: string,
  input: { to: string; namespaces?: string[]; expiresAt?: number; note?: string },
): Promise<{ grantId: string; eventId: string; subject: string; namespaces: string[] }> {
  if (typeof input.to !== 'string' || input.to.length === 0) throw new Error('grant 需要 --to <peerDevice>');
  const config = await loadFleetConfig(fleetConfigPath(dir));
  const encryption = await readMasterKeyFile(config.masterKeyFile);
  const namespaces = input.namespaces ?? [config.namespace];
  if (namespaces.length === 0) throw new Error('grant 需要至少一个 namespace');
  const mebular = new Mebular(offlineMebularOptions(config, encryption) as never);
  await mebular.initialize();
  try {
    const event = await mebular.grantNamespaces({
      subject: input.to,
      namespaces,
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
    });
    const grant = (event.data as { grant: { grantId: string } }).grant;
    return { grantId: grant.grantId, eventId: event.id, subject: input.to, namespaces };
  } finally {
    await mebular.shutdown();
  }
}

/** G1：按 grantId 撤销授权（R-d：恢复必须用**新** grantId）。 */
export async function revokeNamespaceGrant(
  dir: string,
  input: { grantId: string; subject?: string; note?: string },
): Promise<{ grantId: string; eventId: string }> {
  if (typeof input.grantId !== 'string' || input.grantId.length === 0) throw new Error('revoke 需要 --grant-id <id>');
  const config = await loadFleetConfig(fleetConfigPath(dir));
  const encryption = await readMasterKeyFile(config.masterKeyFile);
  const mebular = new Mebular(offlineMebularOptions(config, encryption) as never);
  await mebular.initialize();
  try {
    const event = await mebular.revokeGrant({
      grantId: input.grantId,
      ...(input.subject !== undefined ? { subject: input.subject } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
    });
    return { grantId: input.grantId, eventId: event.id };
  } finally {
    await mebular.shutdown();
  }
}

export type DoctorStatus = 'PASS' | 'FAIL' | 'SKIP';
export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  detail: string;
  hint?: string;
}
export interface DoctorReport {
  ok: boolean;
  device: string;
  checks: DoctorCheck[];
  skipped: string[];
}

function parseTcp(multiaddr: string): { host: string; port: number } | null {
  const m = /\/ip4\/([0-9.]+)\/tcp\/(\d+)/.exec(multiaddr);
  return m ? { host: m[1]!, port: Number(m[2]) } : null;
}

function tcpReachable(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** 医生用的最小策略事件形状（只读 `__policy__`；不重造授权语义）。 */
interface PolicyEventLike {
  type: string;
  data?: {
    grant?: { grantId?: string; subject?: string; namespaces?: string[] };
    revoke?: { grantId?: string };
  };
}

/**
 * 是否「曾有 grant、现被 namespace_revoke 撤销」——仅用于给出 R-d 修复 hint。
 * 生效与否一律以 `getEffectiveNamespaces`（core）为准，此处不参与判定。
 */
function wasNamespaceGrantRevoked(events: readonly PolicyEventLike[], subject: string, namespace: string): boolean {
  const grants = events
    .filter((e) => e.type === 'namespace_grant')
    .map((e) => e.data?.grant)
    .filter(
      (g): g is { grantId: string; subject: string; namespaces: string[] } =>
        typeof g?.grantId === 'string' &&
        g.subject === subject &&
        Array.isArray(g.namespaces) &&
        g.namespaces.includes(namespace),
    );
  if (grants.length === 0) return false;
  const revoked = new Set(events.filter((e) => e.type === 'namespace_revoke').map((e) => e.data?.revoke?.grantId));
  return grants.every((g) => revoked.has(g.grantId));
}

/** 逐项自检；默认脱敏（不含任何密钥材料）。 */
export async function doctor(dir: string): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const cfgPath = fleetConfigPath(dir);
  const add = (name: string, status: DoctorStatus, detail: string, hint?: string): void => {
    checks.push({ name, status, detail, ...(hint !== undefined ? { hint } : {}) });
  };

  let config: FleetConfig;
  try {
    config = await loadFleetConfig(cfgPath);
  } catch (error) {
    add('config', 'FAIL', `无法加载配置：${(error as Error).message}`, `先运行：fleet onboard --dir ${dir} --device <id>`);
    return { ok: false, device: '<unknown>', checks, skipped: [] };
  }

  // 1) 配置权限
  const cfgMode = await fileMode(cfgPath).catch(() => -1);
  add('config 权限', cfgMode === 0o600 ? 'PASS' : 'FAIL', `mode=${cfgMode.toString(8)}`, cfgMode === 0o600 ? undefined : `chmod 600 ${cfgPath}`);

  // 2) 主密钥（存在 + 权限 + 可加载）
  const keyMode = await fileMode(config.masterKeyFile).catch(() => -1);
  let encryption: FleetEncryption | null = null;
  try {
    encryption = await readMasterKeyFile(config.masterKeyFile);
  } catch {
    encryption = null;
  }
  if (keyMode !== 0o600) add('主密钥权限', 'FAIL', `mode=${keyMode.toString(8)}`, `chmod 600 ${config.masterKeyFile}`);
  else if (encryption === null) add('主密钥', 'FAIL', '无法加载主密钥文件', '重新生成或导入（--master-key）');
  else add('主密钥', 'PASS', `fingerprint=${masterKeyFingerprint(encryption.userMasterKey)}`);

  // 3) 设备身份 + 主密钥链（core 验签设备证书）
  const identityPath = `${config.storagePath}.identity.json`;
  add('设备身份文件', (await exists(identityPath)) ? 'PASS' : 'FAIL', identityPath, `fleet onboard --dir ${dir} --device ${config.device}`);
  if (encryption !== null) {
    try {
      const m = new Mebular({ storagePath: config.storagePath, deviceId: config.device, encryption, network: { enabled: false } } as never);
      await m.initialize();
      await m.shutdown();
      add('主密钥链', 'PASS', '设备证书链到用户主密钥');
    } catch (error) {
      add('主密钥链', 'FAIL', `初始化失败：${(error as Error).message}`, '确认 --master-key 与既有身份一致');
    }
  }

  // 4) 对端可达（有 addr 才测；否则等待对端拨入）
  const withAddr = config.peers.filter((p) => typeof p.addr === 'string');
  if (config.peers.length === 0) {
    add('peer 可达', 'SKIP', '未配置任何对端（默认拒绝）', 'fleet onboard … --peer-device <id> [--peer-addr <multiaddr>]');
  } else if (withAddr.length === 0) {
    add('peer 可达', 'SKIP', '对端未提供 addr（等待对端拨入）', undefined);
  } else {
    for (const peer of withAddr) {
      const tcp = parseTcp(peer.addr!);
      const reachable = tcp !== null && (await tcpReachable(tcp.host, tcp.port));
      add(`peer 可达(${peer.device})`, reachable ? 'PASS' : 'FAIL', peer.addr!, '确认对端已启动且地址/端口可达');
    }
  }

  // 5) namespace 已授权：生效授权 = **图上 grant ∪ 配置白名单**（吊销优先，默认拒绝）。
  const peerDevices = config.peers.map((p) => p.device);
  if (peerDevices.length === 0) {
    add('namespace 已授权', 'FAIL', '未配置任何对端（默认拒绝）', 'fleet onboard … --peer-device <id>');
  } else if (encryption === null) {
    const cfgPolicy =
      config.peerNamespacePolicy ?? Object.fromEntries(peerDevices.map((d) => [d, [config.namespace]]));
    const ok = peerDevices.every((d) => (cfgPolicy[d] ?? []).includes(config.namespace));
    add('namespace 已授权', ok ? 'PASS' : 'FAIL', `仅配置（主密钥不可用）namespace=${config.namespace}`, ok ? undefined : '导入主密钥后重试（--master-key）');
  } else {
    try {
      const m = new Mebular(offlineMebularOptions(config, encryption) as never);
      await m.initialize();
      const policyEvents = (await m.eventLog.listEvents({ namespace: POLICY_NAMESPACE })) as unknown as PolicyEventLike[];
      const parts: string[] = [];
      let allOk = true;
      let revokedHint = false;
      for (const device of peerDevices) {
        const effective = await m.getEffectiveNamespaces(device);
        const ok = effective.includes(config.namespace);
        parts.push(`${device}:${ok ? 'ok' : 'deny'}`);
        if (!ok) {
          allOk = false;
          if (wasNamespaceGrantRevoked(policyEvents, device, config.namespace)) revokedHint = true;
        }
      }
      await m.shutdown();
      add(
        'namespace 已授权',
        allOk ? 'PASS' : 'FAIL',
        `namespace=${config.namespace} peers=[${parts.join(', ')}]`,
        allOk
          ? undefined
          : revokedHint
            ? '曾被 namespace_revoke 撤销；必须用新的 grantId 恢复（R-d）'
            : '为对端签发 grant（fleet grant --to <peer>）或配置白名单',
      );
    } catch (error) {
      add('namespace 已授权', 'FAIL', `读取本地授权失败：${(error as Error).message}`, '确认存储/主密钥可用');
    }
  }

  // 6) agent 注册表可解析
  const agentErrors = validateFleetConfig({ ...config, agents: config.agents }).filter((e) => e.startsWith('agent'));
  try {
    buildRegistry(config.agents);
    add('agent 注册表', agentErrors.length === 0 ? 'PASS' : 'FAIL', config.agents.map((a) => `${a.name}:${a.kind}`).join(','), '修正 agents 配置');
  } catch (error) {
    add('agent 注册表', 'FAIL', (error as Error).message, '修正 agents 配置');
  }

  // 7) 同步已收敛（本地是否已见对端署名的任务事件）
  if (encryption === null) {
    add('同步已收敛', 'SKIP', '主密钥不可用，跳过');
  } else {
    try {
      const m = new Mebular({ storagePath: config.storagePath, deviceId: config.device, encryption, network: { enabled: false } } as never);
      await m.initialize();
      const nodes = (await m.graph.listNodes({ type: 'task_event' })) as Array<{
        namespace?: string;
        content?: { actor?: { device?: string }; author?: string };
      }>;
      await m.shutdown();
      const taskNodes = nodes.filter((n) => n.namespace === config.namespace);
      if (taskNodes.length === 0) {
        add('同步已收敛', 'SKIP', '尚无任务事件，无法判断（可在派活后重跑 doctor）');
      } else {
        const peerDevices = new Set(config.peers.map((p) => p.device));
        const authors = taskNodes
          .map((n) => n.content?.actor?.device ?? n.content?.author)
          .filter((a): a is string => typeof a === 'string');
        const seen = new Set(authors.filter((a) => peerDevices.has(a)));
        add('同步已收敛', seen.size > 0 ? 'PASS' : 'FAIL', `对端署名事件：${seen.size}/${peerDevices.size}`, '确认对端在线、已授权且已产生同步');
      }
    } catch (error) {
      add('同步已收敛', 'FAIL', `读取本地状态失败：${(error as Error).message}`);
    }
  }

  const skipped = checks.filter((c) => c.status === 'SKIP').map((c) => c.name);
  return { ok: !checks.some((c) => c.status === 'FAIL'), device: config.device, checks, skipped };
}
