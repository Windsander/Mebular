// Fleet 设备上车 + 自检（Step 1b）。
//
// `onboardDevice`：一次（幂等）完成 主密钥（生成/导入，0600）→ 配置 → 设备证书（core 落盘）。
// `doctor`：逐项 PASS/FAIL/SKIP（含脱敏与修复建议）；`skipped` 明列原因。

import { access, chmod, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import net from 'node:net';
import {
  Mebular,
  POLICY_NAMESPACE,
  type NamespaceHandoffPlan,
  type NamespaceHandoffResult,
  type NamespaceRejoinResult,
} from '@mebular/core';
import { isHeartbeatFresh, readHeartbeat, registeredServicesForDir } from '@mebular/service';

import {
  fileMode,
  permissionsApplicable,
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
  if (permissionsApplicable()) await chmod(input.dir, 0o700);

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

/**
 * M1：声明/注销某设备在某分区的**成员资格**（写 `namespace_membership` 到 `__policy__`）。
 * `active=false` = 注销（本轮只改成员集合，不做数据清理——2b）。
 */
export async function setNamespaceMembership(
  dir: string,
  input: { to: string; namespace?: string; active?: boolean; note?: string },
): Promise<{ member: string; namespace: string; active: boolean; eventId: string }> {
  if (typeof input.to !== 'string' || input.to.length === 0) throw new Error('member 需要 --to <deviceId>');
  const config = await loadFleetConfig(fleetConfigPath(dir));
  const encryption = await readMasterKeyFile(config.masterKeyFile);
  const namespace = input.namespace ?? config.namespace;
  const active = input.active ?? true;
  const mebular = new Mebular(offlineMebularOptions(config, encryption) as never);
  await mebular.initialize();
  try {
    const event = await mebular.declareNamespaceMembership({
      member: input.to,
      namespace,
      active,
      ...(input.note !== undefined ? { note: input.note } : {}),
    });
    return { member: input.to, namespace, active, eventId: event.id };
  } finally {
    await mebular.shutdown();
  }
}

/** M2：某分区的**生效成员集合**（图上在册成员 ∩ 生效授权）。只读。 */
export async function namespaceMembers(dir: string, namespace?: string): Promise<string[]> {
  const config = await loadFleetConfig(fleetConfigPath(dir));
  const encryption = await readMasterKeyFile(config.masterKeyFile);
  const mebular = new Mebular(offlineMebularOptions(config, encryption) as never);
  await mebular.initialize();
  try {
    return await mebular.getNamespaceMembers(namespace ?? config.namespace);
  } finally {
    await mebular.shutdown();
  }
}

/** 2c：重订阅恢复（准入：本机对该分区有生效授权 ∧ 成员在册；写图外 reset 标记）。 */
export async function rejoinNamespace(
  dir: string,
  input: { namespace?: string } = {},
): Promise<NamespaceRejoinResult> {
  const config = await loadFleetConfig(fleetConfigPath(dir));
  const encryption = await readMasterKeyFile(config.masterKeyFile);
  const mebular = new Mebular(offlineMebularOptions(config, encryption) as never);
  await mebular.initialize();
  try {
    return await mebular.rejoinNamespace({ namespace: input.namespace ?? config.namespace });
  } finally {
    await mebular.shutdown();
  }
}

/** 2c：本机是否已声明某分区重置（读图外标记）。只读。 */
export async function rejoinReset(dir: string, namespace?: string): Promise<boolean> {
  const config = await loadFleetConfig(fleetConfigPath(dir));
  const encryption = await readMasterKeyFile(config.masterKeyFile);
  const mebular = new Mebular(offlineMebularOptions(config, encryption) as never);
  await mebular.initialize();
  try {
    return await mebular.hasRejoinReset(namespace ?? config.namespace);
  } finally {
    await mebular.shutdown();
  }
}

/** 2b：交接前置校验（只读）——继任者是否在册且已 ack 本机在该分区的全部事件。 */
export async function planHandoff(
  dir: string,
  input: { namespace?: string; successor: string },
): Promise<NamespaceHandoffPlan> {
  const config = await loadFleetConfig(fleetConfigPath(dir));
  const encryption = await readMasterKeyFile(config.masterKeyFile);
  const mebular = new Mebular(offlineMebularOptions(config, encryption) as never);
  await mebular.initialize();
  try {
    return await mebular.planNamespaceHandoff({ namespace: input.namespace ?? config.namespace, successor: input.successor });
  } finally {
    await mebular.shutdown();
  }
}

/** 2b：退订交接（默认要求继任者全量 ack；`force` 仅本地 CLI，仍如实记录）。 */
export async function leaveNamespace(
  dir: string,
  input: { namespace?: string; successor: string; force?: boolean; note?: string },
): Promise<NamespaceHandoffResult> {
  const config = await loadFleetConfig(fleetConfigPath(dir));
  const encryption = await readMasterKeyFile(config.masterKeyFile);
  const mebular = new Mebular(offlineMebularOptions(config, encryption) as never);
  await mebular.initialize();
  try {
    return await mebular.leaveNamespace({
      namespace: input.namespace ?? config.namespace,
      successor: input.successor,
      ...(input.force !== undefined ? { force: input.force } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
    });
  } finally {
    await mebular.shutdown();
  }
}

/** M1：某分区成员资格（`active=false` = 未启用成员资格；`members` = 图上在册）。只读。 */
export async function namespaceMembership(
  dir: string,
  namespace?: string,
): Promise<{ active: boolean; members: string[] }> {
  const config = await loadFleetConfig(fleetConfigPath(dir));
  const encryption = await readMasterKeyFile(config.masterKeyFile);
  const mebular = new Mebular(offlineMebularOptions(config, encryption) as never);
  await mebular.initialize();
  try {
    return await mebular.getNamespaceMembership(namespace ?? config.namespace);
  } finally {
    await mebular.shutdown();
  }
}

/**
 * C1：把某设备声明为**引导签发者**（写 `policy_issuer_declare` 到 `__policy__`）。
 * 新设备同步到该声明后即可采纳其授权，**无需本地 `--policy-issuer` 配置一致**。
 */
export async function declarePolicyIssuer(
  dir: string,
  input: { to: string; note?: string },
): Promise<{ subject: string; eventId: string }> {
  if (typeof input.to !== 'string' || input.to.length === 0) throw new Error('declare-issuer 需要 --to <deviceId>');
  const config = await loadFleetConfig(fleetConfigPath(dir));
  const encryption = await readMasterKeyFile(config.masterKeyFile);
  const mebular = new Mebular(offlineMebularOptions(config, encryption) as never);
  await mebular.initialize();
  try {
    const event = await mebular.declarePolicyIssuer({
      subject: input.to,
      ...(input.note !== undefined ? { note: input.note } : {}),
    });
    return { subject: input.to, eventId: event.id };
  } finally {
    await mebular.shutdown();
  }
}

/** C1：本机当前生效的引导签发者集合（图上声明 ∪ 本地配置）。只读。 */
export async function effectivePolicyIssuers(dir: string): Promise<string[]> {
  const config = await loadFleetConfig(fleetConfigPath(dir));
  const encryption = await readMasterKeyFile(config.masterKeyFile);
  const mebular = new Mebular(offlineMebularOptions(config, encryption) as never);
  await mebular.initialize();
  try {
    return await mebular.getPolicyIssuers();
  } finally {
    await mebular.shutdown();
  }
}

/** `WARN` = 非致命告警（不使 `ok=false`），用于暴露加固/运维风险。 */
export type DoctorStatus = 'PASS' | 'FAIL' | 'SKIP' | 'WARN';
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

/** 从 multiaddr 取监听主机（`/ip4|ip6/<host>/tcp/<port>`）；无法解析 → null。 */
function listenHostOf(multiaddr: string): string | null {
  const m = /^\/(?:ip4|ip6)\/([^/]+)\/tcp\/\d+/.exec(multiaddr);
  return m ? m[1]! : null;
}

/** 回环/私有/链路本地/ULA 视为“非公网”；`0.0.0.0`/`::`/全局地址 → false。 */
function isPrivateListenHost(host: string): boolean {
  if (host === '127.0.0.1' || host === '::1' || host === 'localhost') return true;
  if (/^10\./.test(host) || /^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  if (/^fe80:/i.test(host)) return true;
  if (/^f[cd]/i.test(host)) return true; // IPv6 ULA
  return false;
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

  // 1) 配置权限（POSIX mode；Windows 无该语义 → SKIP，依赖用户目录 ACL）
  const posix = permissionsApplicable();
  if (posix) {
    const cfgMode = await fileMode(cfgPath).catch(() => -1);
    add('config 权限', cfgMode === 0o600 ? 'PASS' : 'FAIL', `mode=${cfgMode.toString(8)}`, cfgMode === 0o600 ? undefined : `chmod 600 ${cfgPath}`);
  } else {
    add('config 权限', 'SKIP', 'Windows 无 POSIX mode；依赖用户目录 ACL（见 ONBOARDING Windows 章节）');
  }

  // 1.5) 监听地址：绑定全接口/公网 → **WARN**（不静默；给加固建议）。不使 ok=false。
  const listenHost = listenHostOf(config.listen);
  if (listenHost === null) {
    add('监听地址', 'SKIP', `无法解析 listen：${config.listen}`);
  } else if (isPrivateListenHost(listenHost)) {
    add('监听地址', 'PASS', config.listen);
  } else {
    add(
      '监听地址',
      'WARN',
      `${config.listen} 绑定到全接口/公网地址（${listenHost}）`,
      '改绑回环或 LAN 地址（/ip4/127.0.0.1 或内网 IP）+ 经 relay 互联，或仅放行已授权对端（见 RELAY-OPS.md）',
    );
  }

  // 2) 主密钥（存在 + 权限 + 可加载）
  let encryption: FleetEncryption | null = null;
  try {
    encryption = await readMasterKeyFile(config.masterKeyFile);
  } catch {
    encryption = null;
  }
  if (!posix) {
    add('主密钥权限', 'SKIP', 'Windows 无 POSIX mode；依赖用户目录 ACL（见 ONBOARDING Windows 章节）');
    if (encryption === null) add('主密钥', 'FAIL', '无法加载主密钥文件', '重新生成或导入（--master-key）');
    else add('主密钥', 'PASS', `fingerprint=${masterKeyFingerprint(encryption.userMasterKey)}`);
  } else {
    const keyMode = await fileMode(config.masterKeyFile).catch(() => -1);
    if (keyMode !== 0o600) add('主密钥权限', 'FAIL', `mode=${keyMode.toString(8)}`, `chmod 600 ${config.masterKeyFile}`);
    else if (encryption === null) add('主密钥', 'FAIL', '无法加载主密钥文件', '重新生成或导入（--master-key）');
    else add('主密钥', 'PASS', `fingerprint=${masterKeyFingerprint(encryption.userMasterKey)}`);
  }

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
      const issuers = await m.getPolicyIssuers();
      const membership = await m.getNamespaceMembership(config.namespace);
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
      // C1 信息项：生效引导签发者集合（图上声明 ∪ 本地配置）。恒 PASS，供审计。
      add(
        '策略签发者',
        'PASS',
        `issuers=[${issuers.join(', ')}]${issuers.length === 0 ? '（空：fleet declare-issuer --to <self> 或 onboard --policy-issuer）' : ''}`,
      );
      // M1–M3：本机在该分区的成员资格（未启用成员资格 → SKIP 明列）。
      if (!membership.active) {
        add('namespace 成员资格', 'SKIP', '未启用成员资格（无成员记录）', `fleet member --to ${config.device} --namespace ${config.namespace}`);
      } else {
        const isMember = membership.members.includes(config.device);
        add(
          'namespace 成员资格',
          isMember ? 'PASS' : 'FAIL',
          `namespace=${config.namespace} members=[${membership.members.join(', ')}] self=${config.device}`,
          isMember ? undefined : '用 `fleet member` 将本机加入该分区',
        );
      }
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

  // 7.4) 2c 重入状态：本机是否已声明某分区重置（图外标记，不同步）。恒 PASS，供审计。
  const rejoinMarker = `${config.storagePath}.rejoin.${config.namespace}.json`;
  add(
    '重入状态',
    'PASS',
    (await exists(rejoinMarker)) ? `namespace=${config.namespace} reset=true（已声明重置；下次同步将从零拉取）` : 'reset=false',
  );

  // 7.5) 2b 交接状态：存在未完成意图（图外 sidecar）→ FAIL（重跑 `fleet leave` 幂等续跑）。
  const intentPath = `${config.storagePath}.handoff.json`;
  if (await exists(intentPath)) {
    add('交接状态', 'FAIL', `存在未完成交接意图：${intentPath}`, '重跑 `fleet leave --successor <id>`（幂等续跑）');
  } else {
    add('交接状态', 'PASS', '无未完成交接');
  }

  // 8) 服务已注册（D4）：是否有常驻服务**指向本目录**（读 manifest，dir-scoped，temp 目录可复现）。
  const registered = registeredServicesForDir(dir);
  if (registered.length === 0) {
    add('服务已注册', 'SKIP', '未安装常驻服务', 'fleet service install fleet-node|fleet-worker（或 mebular service install）');
  } else {
    add('服务已注册', 'PASS', `services=[${registered.join(', ')}]`);
  }

  // 9) 心跳新鲜（D4）：process 写 `<dir>/service.heartbeat`；无文件 → SKIP，陈旧 → FAIL。
  const heartbeat = readHeartbeat(dir);
  if (heartbeat === null) {
    add('心跳新鲜', 'SKIP', '无 service.heartbeat（服务未运行/未安装）');
  } else if (isHeartbeatFresh(dir)) {
    add('心跳新鲜', 'PASS', `role=${heartbeat.role} pid=${heartbeat.pid} age=${Date.now() - heartbeat.ts}ms sha=${heartbeat.sha}`);
  } else {
    add('心跳新鲜', 'FAIL', `心跳陈旧 age=${Date.now() - heartbeat.ts}ms（role=${heartbeat.role} pid=${heartbeat.pid}）`, '服务可能已崩溃：`fleet service status` / `fleet service logs`');
  }

  const skipped = checks.filter((c) => c.status === 'SKIP').map((c) => c.name);
  return { ok: !checks.some((c) => c.status === 'FAIL'), device: config.device, checks, skipped };
}
