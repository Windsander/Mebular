// Fleet 一键上车（Stage 1）：`quickstart`（A 一条命令）+ `join`（B 一条命令）+ `pending`/`approve`。
//
// 设计约束：
// - **仅消费 `@mebular/core` 公共 API**（不 import core 内部路径），不改 core 语义。
// - 加入码含**敏感信任材料**（当前为同一用户主密钥，Stage 2 换令牌）：绝不进日志/错误信息，
//   `--code-file` 以 0600 落盘；`describeJoinCode` 只返回脱敏字段。
// - 默认拒绝不变：`quickstart` 默认 `--no-config-grant`，授权只走图上 grant（G1）。

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import net from 'node:net';
import { hostname, networkInterfaces } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { Mebular, type Event } from '@mebular/core';

import {
  fleetConfigPath,
  fleetMasterKeyPath,
  loadFleetConfig,
  masterKeyFingerprint,
  permissionsApplicable,
  readMasterKeyFile,
  saveFleetConfig,
  writeMasterKeyFile,
  type FleetAgentConfig,
  type FleetConfig,
  type FleetEncryption,
} from './config.js';
import { mebularOptions, offlineMebularOptions, onboardDevice } from './onboard.js';
import { buildJoinToken } from './jointoken.js';

/** 加入码内信任材料的记录形状（Stage 2 将由令牌取代）。 */
export interface JoinTrustMaterial {
  publicKey: string;
  privateKeyPkcs8: string;
}

export interface JoinCode {
  v: 1;
  kind: 'mebular-fleet-join';
  /** 生成方的构建 SHA（join 侧版本核对；不一致即拒绝） */
  sha: string;
  /** A 的 deviceId */
  device: string;
  namespace: string;
  /** A 的可达 multiaddr（含 /p2p/<id>），跨网回退用 */
  multiaddrs: string[];
  /** A 自声明的引导签发者（join 侧写入本地 policyIssuers，无需等图同步） */
  policyIssuer: string;
  fingerprint: string;
  issuedAt: number;
  trust: JoinTrustMaterial;
  note?: string;
}

export interface AgentProbe {
  agents: FleetAgentConfig[];
  sources: string[];
}

export interface ServiceInstallOutcome {
  installed: boolean;
  note?: string;
}
export type ServiceInstaller = (dir: string) => Promise<ServiceInstallOutcome>;

/** 默认设备名：主机名清洗（小写、非法字符→`-`、去首尾 `-`）。 */
export function sanitizeDeviceName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return cleaned.length > 0 ? cleaned : 'device';
}

export function defaultDeviceName(host: string = hostname()): string {
  return sanitizeDeviceName(host);
}

/** 默认设备目录：`FLEET_DIR` → `~/.fleet`。 */
export function defaultFleetDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.FLEET_DIR;
  const home = env.HOME ?? env.USERPROFILE ?? '.';
  return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : join(home, '.fleet');
}

/** PATH 中是否存在可执行文件（Windows 尝试 PATHEXT 扩展）。 */
export function commandExists(command: string, env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): boolean {
  const path = env.PATH ?? env.Path ?? '';
  const exts = platform === 'win32' ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';') : [''];
  for (const dir of path.split(delimiter)) {
    if (dir.length === 0) continue;
    for (const ext of exts) {
      if (existsSync(join(dir, command + ext))) return true;
    }
  }
  return false;
}

const OPENCHAMBER_ENV_KEYS = [
  'MEBULAR_FLEET_OPENCHAMBER_ENDPOINT',
  'MEBULAR_FLEET_OPENCHAMBER_TOKEN',
  'MEBULAR_FLEET_OPENCHAMBER_TOKEN_FILE',
];

/** agent 自动探测：PATH 有 hermes → hermes；存在 `MEBULAR_FLEET_OPENCHAMBER_*` → openchamber；否则 echo。 */
export function detectAgents(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): AgentProbe {
  const agents: FleetAgentConfig[] = [];
  const sources: string[] = [];
  if (commandExists('hermes', env, platform)) {
    agents.push({ name: 'hermes', kind: 'hermes' });
    sources.push('hermes:PATH');
  }
  if (OPENCHAMBER_ENV_KEYS.some((k) => (env[k] ?? '').length > 0)) {
    agents.push({ name: 'openchamber', kind: 'openchamber' });
    sources.push('openchamber:env');
  }
  if (agents.length === 0) {
    agents.push({ name: 'echo', kind: 'echo' });
    sources.push('echo:default');
  }
  return { agents, sources };
}

function parseListenPort(listen: string): { host: string; port: number } | null {
  const m = /^\/(?:ip4|ip6)\/([^/]+)\/tcp\/(\d+)$/.exec(listen);
  if (!m) return null;
  return { host: m[1]!, port: Number(m[2]) };
}

/** 端口占用检查：占用 → 抛清晰错误 + 建议（`tcp/0` 表示随机端口，跳过）。 */
export async function assertListenAvailable(listen: string): Promise<void> {
  const parsed = parseListenPort(listen);
  if (parsed === null || parsed.port === 0) return;
  const { host, port } = parsed;
  await new Promise<void>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        reject(
          new Error(
            `监听端口被占用：${listen}（EADDRINUSE）。建议：换端口（如 --listen /ip4/0.0.0.0/tcp/${port + 1}），或停用占用进程后重试。`,
          ),
        );
      } else {
        reject(new Error(`监听地址不可用：${listen}（${error.code ?? error.message}）`));
      }
    });
    server.listen({ host: host === '0.0.0.0' || host === '::' ? undefined : host, port }, () => {
      server.close(() => resolve());
    });
  });
}

/** 解析加入码：接受内联 base64 或其文本内容（兼容直接粘贴 JSON）。 */
export function decodeJoinCode(text: string): JoinCode {
  const trimmed = text.trim();
  if (trimmed.length === 0) throw new Error('加入码为空');
  let json: string;
  if (trimmed.startsWith('{')) {
    json = trimmed;
  } else {
    json = Buffer.from(trimmed, 'base64').toString('utf-8');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('加入码无法解析（既非 base64 也非 JSON）');
  }
  if (typeof parsed !== 'object' || parsed === null) throw new Error('加入码形状非法');
  const c = parsed as Record<string, unknown>;
  if (c.v !== 1 || c.kind !== 'mebular-fleet-join') throw new Error('加入码版本/类型不受支持');
  if (typeof c.sha !== 'string' || typeof c.device !== 'string' || typeof c.namespace !== 'string') {
    throw new Error('加入码缺少必填字段');
  }
  if (!Array.isArray(c.multiaddrs) || c.multiaddrs.some((a) => typeof a !== 'string')) {
    throw new Error('加入码 multiaddrs 非法');
  }
  if (typeof c.policyIssuer !== 'string' || typeof c.fingerprint !== 'string') throw new Error('加入码缺少签发者/指纹');
  const trust = c.trust as Record<string, unknown> | undefined;
  if (typeof trust !== 'object' || trust === null || typeof trust.publicKey !== 'string' || typeof trust.privateKeyPkcs8 !== 'string') {
    throw new Error('加入码信任材料非法');
  }
  return {
    v: 1,
    kind: 'mebular-fleet-join',
    sha: c.sha,
    device: c.device,
    namespace: c.namespace,
    multiaddrs: c.multiaddrs as string[],
    policyIssuer: c.policyIssuer,
    fingerprint: c.fingerprint,
    issuedAt: typeof c.issuedAt === 'number' ? c.issuedAt : 0,
    trust: { publicKey: trust.publicKey, privateKeyPkcs8: trust.privateKeyPkcs8 },
    ...(typeof c.note === 'string' ? { note: c.note } : {}),
  };
}

/** 加入码 → 内联 base64。 */
export function encodeJoinCode(code: JoinCode): string {
  return Buffer.from(JSON.stringify(code), 'utf-8').toString('base64');
}

/** 脱敏描述（**不含信任材料**，可用于日志/报告）。 */
export function describeJoinCode(code: JoinCode): Record<string, unknown> {
  return {
    v: code.v,
    kind: code.kind,
    sha: code.sha,
    device: code.device,
    namespace: code.namespace,
    multiaddrs: code.multiaddrs,
    policyIssuer: code.policyIssuer,
    fingerprint: code.fingerprint,
    issuedAt: code.issuedAt,
    hasTrustMaterial: true,
  };
}

/** 写加入码文件（0600）。 */
export async function writeJoinCodeFile(path: string, inline: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, inline, { mode: 0o600 });
  if (permissionsApplicable()) await chmod(path, 0o600);
}

/**
 * 构建 SHA 的**环境覆盖**（CLI 传入真实 `version.json` 值）。
 * 本模块刻意不读 `import.meta`（ts-jest 以 CJS 加载 src，会编译失败）；
 * 缺省 `unknown` → 版本核对自动跳过。
 */
export function envBuildSha(env: NodeJS.ProcessEnv = process.env): string {
  const envSha = env.MEBULAR_FLEET_BUILD_SHA;
  return envSha !== undefined && envSha.length > 0 ? envSha : 'unknown';
}

export interface QuickstartInput {
  dir: string;
  device: string;
  namespace?: string;
  listen?: string;
  codeFile?: string;
  joinPort?: number;
  joinHost?: string;
  agents?: FleetAgentConfig[];
  autoApprove?: boolean;
  /** 服务安装回调；缺省 = 不安装（CLI 传真实安装器） */
  installService?: ServiceInstaller;
  /** 跳过端口占用检查（测试用） */
  skipPortCheck?: boolean;
  /** 覆盖构建 SHA（测试用） */
  buildSha?: string;
  /** 覆盖探测环境（测试用） */
  env?: NodeJS.ProcessEnv;
  platform?: string;
}

export interface QuickstartResult {
  device: string;
  dir: string;
  namespace: string;
  fingerprint: string;
  code: string;
  codeFile?: string;
  multiaddrs: string[];
  agents: FleetAgentConfig[];
  agentSources: string[];
  serviceInstalled: boolean;
  serviceNote?: string;
  autoApprove: boolean;
  joinNext: string[];
  warnings: string[];
  /** T2：令牌加入（主密钥不复制）——推荐路径 */
  inviteToken: string;
  joinEndpoint: string;
  joinPort: number;
}

const DEFAULT_LISTEN = '/ip4/0.0.0.0/tcp/4001';
const DEFAULT_JOIN_PORT = 4002;

/** 选一个可对外通告的 LAN IPv4（无则回环）。 */
export function pickLanHost(): string {
  const ifaces = networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const info of list ?? []) {
      if (info.family === 'IPv4' && !info.internal) return info.address;
    }
  }
  return '127.0.0.1';
}

/** A 一条命令：onboard（默认无配置授权）+ 声明签发者(self) + 成员(self) + 自授权 + 加入码 + 服务 + doctor。 */
export async function quickstart(input: QuickstartInput): Promise<QuickstartResult> {
  const env = input.env ?? process.env;
  const namespace = input.namespace ?? 'tasks';
  const listen = input.listen ?? DEFAULT_LISTEN;
  const warnings: string[] = [];
  await mkdir(input.dir, { recursive: true });
  if (permissionsApplicable(input.platform)) await chmod(input.dir, 0o700);
  if (input.skipPortCheck !== true) await assertListenAvailable(listen);

  const probe = input.agents !== undefined ? { agents: input.agents, sources: ['explicit'] } : detectAgents(env, input.platform);
  const onboard = await onboardDevice({
    dir: input.dir,
    device: input.device,
    namespace,
    listen,
    agents: probe.agents,
    configGrant: false,
    policyIssuers: [input.device],
  });
  const config = onboard.config;
  if (input.autoApprove === true) {
    await saveFleetConfig(fleetConfigPath(input.dir), { ...config, autoApprove: true });
  }
  const encryption = await readMasterKeyFile(config.masterKeyFile);

  // 图上门面：声明签发者(self)、成员(self active)、自授权（让对端一同步即见 A 已授权）。
  const mebular = new Mebular(offlineMebularOptions(config, encryption) as never);
  await mebular.initialize();
  try {
    await mebular.declarePolicyIssuer({ subject: input.device, note: 'quickstart self' });
    await mebular.declareNamespaceMembership({ member: input.device, namespace, active: true, note: 'quickstart self' });
    await mebular.grantNamespaces({ subject: input.device, namespaces: [namespace], note: 'quickstart self-grant' });
  } finally {
    await mebular.shutdown();
  }

  // T2：启用 join 服务并预生成一枚令牌（推荐路径；旧共享主密钥 code 仍保留用于兼容）。
  const joinPort = input.joinPort ?? DEFAULT_JOIN_PORT;
  await saveFleetConfig(fleetConfigPath(input.dir), {
    ...config,
    joinService: { enabled: true, bind: '0.0.0.0', port: joinPort },
    ...(input.autoApprove === true ? { autoApprove: true } : {}),
  });
  const joinEndpoint = `http://${input.joinHost ?? pickLanHost()}:${joinPort}`;
  const tokenBuilder = new Mebular(offlineMebularOptions(config, encryption) as never);
  await tokenBuilder.initialize();
  let inviteToken: string;
  try {
    const token = await buildJoinToken({ mebular: tokenBuilder, deviceId: config.device, namespace, endpoint: joinEndpoint });
    inviteToken = Buffer.from(JSON.stringify(token), 'utf-8').toString('base64');
  } finally {
    await tokenBuilder.shutdown();
  }

  const multiaddrs = await captureMultiaddrs(config, encryption, warnings);
  const inline = encodeJoinCode({
    v: 1,
    kind: 'mebular-fleet-join',
    sha: input.buildSha ?? envBuildSha(env),
    device: config.device,
    namespace,
    multiaddrs,
    policyIssuer: config.device,
    fingerprint: onboard.masterKeyFingerprint,
    issuedAt: Date.now(),
    trust: {
      publicKey: Buffer.from(encryption.userMasterKey).toString('base64'),
      privateKeyPkcs8: await exportPkcs8(encryption),
    },
    note: 'stage1: shared master key (stage2 will use a join token)',
  });
  if (input.codeFile !== undefined) await writeJoinCodeFile(input.codeFile, inline);

  let serviceInstalled = false;
  let serviceNote: string | undefined;
  if (input.installService !== undefined) {
    const outcome = await input.installService(input.dir);
    serviceInstalled = outcome.installed;
    serviceNote = outcome.note;
  }

  return {
    device: config.device,
    dir: config.dir,
    namespace,
    fingerprint: onboard.masterKeyFingerprint,
    code: inline,
    ...(input.codeFile !== undefined ? { codeFile: input.codeFile } : {}),
    multiaddrs,
    agents: probe.agents,
    agentSources: probe.sources,
    serviceInstalled,
    ...(serviceNote !== undefined ? { serviceNote } : {}),
    autoApprove: input.autoApprove === true,
    joinNext: [
      'fleet join --token <内联|文件>（推荐：主密钥不复制）',
      'fleet pending（A 侧查看待批准）',
      'fleet approve <deviceId>（A 批准）',
    ],
    warnings,
    inviteToken,
    joinEndpoint,
    joinPort,
  };
}

async function captureMultiaddrs(config: FleetConfig, encryption: FleetEncryption, warnings: string[]): Promise<string[]> {
  const m = new Mebular(mebularOptions(config, encryption) as never);
  await m.initialize();
  try {
    const addrs = m.node?.getLocalMultiaddrs() ?? [];
    if (addrs.length === 0) warnings.push('未捕获到可达 multiaddr（对端需人工提供地址）');
    return addrs;
  } finally {
    await m.shutdown();
  }
}

async function exportPkcs8(encryption: FleetEncryption): Promise<string> {
  if (encryption.userMasterPrivateKey === undefined) throw new Error('缺少用户主私钥，无法导出加入码信任材料');
  const raw = await globalThis.crypto.subtle.exportKey('pkcs8', encryption.userMasterPrivateKey);
  return Buffer.from(raw).toString('base64');
}

export interface JoinInput {
  dir: string;
  code: string;
  device: string;
  namespace?: string;
  listen?: string;
  agents?: FleetAgentConfig[];
  installService?: ServiceInstaller;
  skipPortCheck?: boolean;
  buildSha?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string;
}

export interface JoinResult {
  device: string;
  dir: string;
  peer: string;
  namespace: string;
  fingerprint: string;
  alreadyJoined: boolean;
  serviceInstalled: boolean;
  serviceNote?: string;
  multiaddrs: string[];
  agents: FleetAgentConfig[];
  agentSources: string[];
  awaitingApproval: boolean;
  next: string[];
}

/** B 一条命令：版本核对 → 导入信任材料/地址 → onboard → 声明成员(active) → 服务 → doctor。 */
export async function joinFleet(input: JoinInput): Promise<JoinResult> {
  const env = input.env ?? process.env;
  const code = decodeJoinCode(input.code);
  const localSha = input.buildSha ?? envBuildSha(env);
  if (code.sha !== 'unknown' && localSha !== 'unknown' && code.sha !== localSha) {
    throw new Error(`版本不一致：加入码构建 SHA=${code.sha}，本机=${localSha}。请使用同版本（fleet --version）后重试。`);
  }
  const namespace = input.namespace ?? code.namespace;
  const listen = input.listen ?? DEFAULT_LISTEN;
  if (input.skipPortCheck !== true) await assertListenAvailable(listen);

  const probe = input.agents !== undefined ? { agents: input.agents, sources: ['explicit'] } : detectAgents(env, input.platform);

  // 幂等/防覆盖：已有配置且设备不符 → 拒绝；已有同设备且指纹一致 → 复用。
  const keyPath = fleetMasterKeyPath(input.dir);
  let alreadyJoined = false;
  if (existsSync(fleetConfigPath(input.dir))) {
    const existing = await loadFleetConfig(fleetConfigPath(input.dir));
    if (existing.device !== input.device) {
      throw new Error(`目录已被设备 ${existing.device} 占用（--dir ${input.dir}）；换目录或先停用。`);
    }
    if (existsSync(keyPath)) {
      const existingKey = await readMasterKeyFile(keyPath);
      if (masterKeyFingerprint(existingKey.userMasterKey) !== code.fingerprint) {
        throw new Error('本机已有不同主密钥，拒绝被加入码覆盖。');
      }
      alreadyJoined = true;
    }
  }

  await mkdir(input.dir, { recursive: true });
  if (permissionsApplicable(input.platform)) await chmod(input.dir, 0o700);
  if (!existsSync(keyPath)) {
    await writeMasterKeyFile(keyPath, await importTrust(code));
  }

  const onboard = await onboardDevice({
    dir: input.dir,
    device: input.device,
    namespace,
    listen,
    agents: probe.agents,
    peerDevice: code.device,
    ...(code.multiaddrs[0] !== undefined ? { peerAddr: code.multiaddrs[0] } : {}),
    configGrant: false,
    policyIssuers: [code.policyIssuer],
  });
  const encryption = await readMasterKeyFile(onboard.config.masterKeyFile);

  const mebular = new Mebular(offlineMebularOptions(onboard.config, encryption) as never);
  await mebular.initialize();
  try {
    await mebular.declareNamespaceMembership({ member: input.device, namespace, active: true, note: 'join self' });
  } finally {
    await mebular.shutdown();
  }

  let serviceInstalled = false;
  let serviceNote: string | undefined;
  if (input.installService !== undefined) {
    const outcome = await input.installService(input.dir);
    serviceInstalled = outcome.installed;
    serviceNote = outcome.note;
  }

  return {
    device: onboard.config.device,
    dir: onboard.config.dir,
    peer: code.device,
    namespace,
    fingerprint: onboard.masterKeyFingerprint,
    alreadyJoined,
    serviceInstalled,
    ...(serviceNote !== undefined ? { serviceNote } : {}),
    multiaddrs: code.multiaddrs,
    agents: probe.agents,
    agentSources: probe.sources,
    awaitingApproval: true,
    next: [`在 ${code.device} 上运行：fleet pending`, `在 ${code.device} 上运行：fleet approve ${onboard.config.device}`],
  };
}

async function importTrust(code: JoinCode): Promise<FleetEncryption> {
  const userMasterKey = new Uint8Array(Buffer.from(code.trust.publicKey, 'base64'));
  const userMasterPrivateKey = await globalThis.crypto.subtle.importKey(
    'pkcs8',
    Buffer.from(code.trust.privateKeyPkcs8, 'base64'),
    { name: 'Ed25519' },
    true,
    ['sign'],
  );
  return { userMasterKey, userMasterPrivateKey };
}

export interface PendingResult {
  device: string;
  namespace: string;
  active: boolean;
  members: string[];
  authorized: string[];
  pending: string[];
}

/** A 侧：列出该分区在册但尚未授权的设备（待批准）。 */
export async function pendingDevices(dir: string, namespace?: string): Promise<PendingResult> {
  const config = await loadFleetConfig(fleetConfigPath(dir));
  const encryption = await readMasterKeyFile(config.masterKeyFile);
  const ns = namespace ?? config.namespace;
  const mebular = new Mebular(offlineMebularOptions(config, encryption) as never);
  await mebular.initialize();
  try {
    const membership = await mebular.getNamespaceMembership(ns);
    const authorized: string[] = [];
    const pending: string[] = [];
    for (const member of membership.members) {
      const ok = (await mebular.getEffectiveNamespaces(member)).includes(ns);
      if (ok) authorized.push(member);
      else if (member !== config.device) pending.push(member);
    }
    return { device: config.device, namespace: ns, active: membership.active, members: membership.members, authorized, pending };
  } finally {
    await mebular.shutdown();
  }
}

export interface ApproveInput {
  device: string;
  namespace?: string;
  /** 可选：登记对端可达地址（A 作为拨号方/医生可达性检查用） */
  addr?: string;
}

export interface ApproveResult {
  device: string;
  namespace: string;
  grantId: string;
  eventId: string;
  memberEventId: string;
  peerRegistered: boolean;
}

/** A 批准：图上 grant + 成员在册 + （可选）登记对端地址。 */
export async function approveDevice(dir: string, input: ApproveInput): Promise<ApproveResult> {
  const config = await loadFleetConfig(fleetConfigPath(dir));
  const encryption = await readMasterKeyFile(config.masterKeyFile);
  const ns = input.namespace ?? config.namespace;
  const mebular = new Mebular(offlineMebularOptions(config, encryption) as never);
  await mebular.initialize();
  let grant: Event;
  let member: Event;
  try {
    grant = await mebular.grantNamespaces({ subject: input.device, namespaces: [ns], note: 'approve' });
    member = await mebular.declareNamespaceMembership({ member: input.device, namespace: ns, active: true, note: 'approve' });
  } finally {
    await mebular.shutdown();
  }
  const grantRecord = (grant.data as { grant: { grantId: string } }).grant;

  let peerRegistered = false;
  const peers = [...config.peers];
  const idx = peers.findIndex((p) => p.device === input.device);
  if (idx >= 0) {
    if (input.addr !== undefined && peers[idx]!.addr !== input.addr) {
      peers[idx] = { device: input.device, addr: input.addr };
      peerRegistered = true;
    }
  } else {
    peers.push(input.addr !== undefined ? { device: input.device, addr: input.addr } : { device: input.device });
    peerRegistered = true;
  }
  if (peerRegistered) await saveFleetConfig(fleetConfigPath(dir), { ...config, peers });

  return { device: input.device, namespace: ns, grantId: grantRecord.grantId, eventId: grant.id, memberEventId: member.id, peerRegistered };
}

/** 运行期自动批准（`--auto-approve`）：对每个在册且未授权的成员发 grant + 成员在册。仅在 `fleet node` 常驻循环调用。 */
export async function autoApproveOnce(mebular: Mebular, self: string, namespace: string): Promise<number> {
  const membership = await mebular.getNamespaceMembership(namespace);
  let approved = 0;
  for (const member of membership.members) {
    if (member === self) continue;
    if ((await mebular.getEffectiveNamespaces(member)).includes(namespace)) continue;
    await mebular.grantNamespaces({ subject: member, namespaces: [namespace], note: 'auto-approve' });
    await mebular.declareNamespaceMembership({ member, namespace, active: true, note: 'auto-approve' });
    approved += 1;
  }
  return approved;
}

/** 读加入码文件（或内联）。 */
export async function readJoinCode(input: { code?: string; codeFile?: string }): Promise<string> {
  if (input.code !== undefined && input.code.length > 0) return input.code;
  if (input.codeFile !== undefined) return await readFile(input.codeFile, 'utf-8');
  throw new Error('join 需要 --code <内联> 或 --code-file <路径>');
}
