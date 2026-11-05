// P1 能力卡（agent_capability_card）：由 fleet config + ExecutorRegistry + 运行环境编译。
//
// 边界（P0 契约 §5.1）：
// - 卡片是 `agents` 域的 **internal 记忆节点**：`metadata.internal=true` +
//   `internalObject.kind="agent_capability_card"`；不得新增域。
// - 只暴露标签/能力/限制；不包含 command 路径、env、密钥、凭据或原始对话。
// - 版本按 `(device, agent, kind)` 单调；同内容不重复发版；agent 移除发 tombstone。
// - 设备签名使用 core 既有身份（`Mebular.identity` 的 Ed25519 设备私钥），不伪造签名。

import { createHash } from 'node:crypto';
import type { Mebular } from '@mebular/core';
import {
  AGENT_NAMESPACE,
  deriveAgentExecution,
  embeddedAgentDirectoryBackend,
  publishAgentDirectoryWithBackend,
  type AgentDirectoryBackend,
  type AgentDirectoryPublishResult,
  type AgentExecutionHealth,
} from './agentdir.js';
import type { FleetAgentConfig, FleetConfig } from './config.js';
import type { ExecutorDescriptor, ExecutorExecutionMode } from './runtime/executor.js';
import { EXECUTOR_EXECUTION_MODES } from './runtime/executor.js';
import { PLAN_SENTINEL } from './protocol/envelope.js';

export const CAPABILITY_CARD_KIND = 'agent_capability_card';
export const CAPABILITY_CARD_NODE_TYPE = 'agent_capability_card';
export const CAPABILITY_CARD_SCHEMA_VERSION = 1 as const;

/** 冻结的 16 个 task 工具名（与 `TASK_TOOLS` 对齐；不得出现不存在的方法）。 */
export const AGENT_TASK_TOOL_NAMES = [
  'task_submit',
  'task_submit_batch',
  'task_cancel',
  'task_retry',
  'task_status',
  'task_list',
  'task_history',
  'task_children',
  'task_summarize',
  'task_subscribe',
  'task_negotiate',
  'chatter_send',
  'chatter_inbox',
  'task_quota',
  'task_targets',
  'board_create',
] as const;

const TOOL_NAME_SET = new Set<string>(AGENT_TASK_TOOL_NAMES);

/** 敏感键：卡片任何层级都不允许出现。 */
const SENSITIVE_KEYS = new Set([
  'command',
  'commandpath',
  'baseargs',
  'args',
  'env',
  'environment',
  'envvars',
  'token',
  'secret',
  'password',
  'credential',
  'credentials',
  'privatekey',
  'apikey',
  'authorization',
  'cookie',
]);

export interface CapabilityCardSignature {
  alg: 'Ed25519';
  keyId: string;
  sig: string;
}

export interface CapabilityCardLimits {
  maxConcurrency?: number;
  maxPayloadBytes?: number;
  timeoutMs?: number;
  [key: string]: number | undefined;
}

export interface CapabilityCardPermissions {
  taskNamespaces: string[];
  [key: string]: unknown;
}

export interface CapabilityCardRuntime {
  os: string;
  arch: string;
  runtime: string;
  runtimeVersion: string;
}

export interface CapabilityCardProvenance {
  source: string;
  configHash: string;
  registryHash: string;
  publishedAt: number;
}

export interface AgentCapabilityCard {
  v: typeof CAPABILITY_CARD_SCHEMA_VERSION;
  kind: typeof CAPABILITY_CARD_KIND;
  device: string;
  agent: string;
  version: number;
  capabilities: string[];
  tools: string[];
  limits: CapabilityCardLimits;
  permissions: CapabilityCardPermissions;
  runtime: CapabilityCardRuntime;
  provenance: CapabilityCardProvenance;
  signature: CapabilityCardSignature;
  tombstone?: boolean;
  /**
   * 该 agent 是否可真实执行（由 config/adapter 推导）。
   * 旧卡缺字段视为兼容（路由按“未知”放行），显式 `false` 不得被路由选中。
   */
  executable?: boolean;
  /** 执行通道（additive；旧卡缺省 = 未知）。 */
  executionMode?: ExecutorExecutionMode;
  /** 健康快照（additive/advisory；不得包含 env/token/端点凭据）。 */
  health?: AgentExecutionHealth;
}

/** 签名前的卡片（version 已定、signature 未生成）。 */
export type CapabilityCardDraft = Omit<AgentCapabilityCard, 'signature'>;

export interface CapabilityCardSummary {
  device: string;
  agent: string;
  version: number;
  capabilities: string[];
  online: boolean;
  inflight: number;
}

export interface CapabilityCardValidation {
  ok: boolean;
  errors: string[];
}

/** 能力卡后端：embedded（本地 Mebular 签名/写）与 daemon（守护 HTTP 签名/写）共用发布逻辑。 */
export interface CapabilityCardBackend {
  listCards(): Promise<AgentCapabilityCard[]>;
  signAndAppendCard(draft: CapabilityCardDraft): Promise<AgentCapabilityCard>;
}

/** 发布能力卡 + Agent 目录所需的完整后端。 */
export interface FleetAgentBackend extends CapabilityCardBackend, AgentDirectoryBackend {}

/** 能力卡读取信任选项：默认只返回 author 绑定 + 签名验证通过的卡。 */
export interface CapabilityCardReadOptions {
  namespace?: string;
  /** 调用方注入公钥（远端设备）；未注入时本机用 identity、远端用已认证 sync peer。 */
  publicKeyFor?: (device: string) => Uint8Array | string | undefined;
}

type CapabilityCardReader = Pick<Mebular, 'graph'> & Partial<Pick<Mebular, 'identity' | 'sync'>>;

/** 能力卡编译需要的只读注册表投影（不暴露 adapter 内部/命令）。 */
export interface CapabilityCardRegistry {
  names(): string[];
  descriptorOf?(agent: string): ExecutorDescriptor | undefined;
}

export interface CapabilityCardCompileInput {
  config: Pick<FleetConfig, 'device' | 'namespace' | 'agents'>;
  /**
   * 运行中执行器注册表；其 names 用于 provenance/注册变化检测，descriptor 只提供
   * 非敏感执行元数据（executionMode），不暴露 command。
   */
  registry?: CapabilityCardRegistry;
  runtime?: CapabilityCardRuntime;
  now?: number;
}

export interface CapabilityCardPublishResult {
  published: number;
  unchanged: number;
  tombstoned: number;
  cards: AgentCapabilityCard[];
  errors: string[];
}

export interface FleetCardsPublishResult {
  cards: CapabilityCardPublishResult;
  directory: AgentDirectoryPublishResult | null;
  errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** P7 硬化：能力卡的 runtime/provenance.source 不是自由文本，只接受安全 token。 */
const CARD_RUNTIME_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/;
const CARD_SOURCE_TOKEN_RE = /^[a-z][a-z0-9+._-]{0,127}$/;

/** 确定性 JSON：对象键递归排序、忽略 undefined。 */
export function canonicalCardJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalCardJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalCardJson(record[key])}`).join(',')}}`;
}

function sha256(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalCardJson(value)).digest('hex')}`;
}

function normalizeTags(values: readonly string[] | undefined): string[] {
  if (values === undefined) return [];
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))].sort();
}

function defaultRuntime(): CapabilityCardRuntime {
  return {
    os: process.platform,
    arch: process.arch,
    runtime: 'node',
    runtimeVersion: process.versions.node,
  };
}

/** 配置哈希只覆盖非敏感投影；command/baseArgs/env 永不进入。 */
function configHashOf(config: Pick<FleetConfig, 'namespace' | 'agents'>): string {
  const agents = [...config.agents]
    .map((agent) => {
      const execution = deriveAgentExecution(agent);
      return {
        name: agent.name,
        kind: agent.kind,
        capabilities: normalizeTags(agent.capabilities),
        executable: execution.executable,
        executionMode: execution.executionMode,
        ...(agent.concurrency !== undefined ? { concurrency: agent.concurrency } : {}),
        ...(agent.timeoutMs !== undefined ? { timeoutMs: agent.timeoutMs } : {}),
      };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return sha256({ namespace: config.namespace, agents });
}

function registryHashOf(config: Pick<FleetConfig, 'agents'>, registry?: CapabilityCardRegistry): string {
  const names = [...new Set((registry?.names() ?? config.agents.map((agent) => agent.name)).filter(nonEmptyString))].sort();
  return sha256({ agents: names });
}

/** 长跑平台 Agent 的默认超时（能力卡只暴露数值，不含命令/环境/凭据）。 */
const LONG_RUNNING_AGENT_KINDS = new Set<FleetAgentConfig['kind']>(['hermes', 'dsh', 'opencode', 'claude-code']);

function defaultTimeoutForKind(kind: FleetAgentConfig['kind']): number {
  return LONG_RUNNING_AGENT_KINDS.has(kind) ? 600_000 : 60_000;
}

function limitsForAgent(agent: FleetAgentConfig): CapabilityCardLimits {
  const concurrency = Number.isInteger(agent.concurrency) && (agent.concurrency as number) >= 1
    ? (agent.concurrency as number)
    : 1;
  const timeoutMs = typeof agent.timeoutMs === 'number' && Number.isFinite(agent.timeoutMs) && agent.timeoutMs > 0
    ? Math.trunc(agent.timeoutMs)
    : defaultTimeoutForKind(agent.kind);
  return {
    maxConcurrency: concurrency,
    maxPayloadBytes: 262_144,
    timeoutMs,
  };
}

/**
 * 从 config + registry + 运行环境编译能力卡草稿。
 *
 * - config agents 是**权威成员表**（能力/并发/超时也来自 config）。
 * - registry 只进入 provenance（注册变化 → 新版本），不把无 config 的临时注册者
 *   变成可路由目标——路由仍以 config 声明的 agent 为准。
 * - 同内容稳定：agents/capabilities/tools 全部排序、去重。
 */
export function compileCapabilityCards(input: CapabilityCardCompileInput): CapabilityCardDraft[] {
  const runtime = input.runtime ?? defaultRuntime();
  const now = input.now ?? Date.now();
  const configHash = configHashOf(input.config);
  const registryHash = registryHashOf(input.config, input.registry);

  const agents = new Map<string, FleetAgentConfig>();
  for (const agent of input.config.agents) {
    if (nonEmptyString(agent.name) && agent.name !== PLAN_SENTINEL) agents.set(agent.name, agent);
  }

  return [...agents.values()]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((agent) => {
      const execution = deriveAgentExecution(agent);
      // registry descriptor 只补充非敏感执行元数据；可执行性仍以 config 静态推导为准。
      const executionMode = input.registry?.descriptorOf?.(agent.name)?.executionMode ?? execution.executionMode;
      return {
        v: CAPABILITY_CARD_SCHEMA_VERSION,
        kind: CAPABILITY_CARD_KIND,
        device: input.config.device,
        agent: agent.name,
        version: 1,
        capabilities: normalizeTags(['fleet.task', ...(agent.capabilities ?? [])]),
        tools: [...AGENT_TASK_TOOL_NAMES],
        limits: limitsForAgent(agent),
        permissions: { taskNamespaces: normalizeTags([input.config.namespace]) },
        runtime,
        provenance: {
          source: 'config+executor-registry+runtime',
          configHash,
          registryHash,
          publishedAt: now,
        },
        executable: execution.executable,
        executionMode,
        tombstone: false,
      };
    });
}

/** 卡片内容指纹：忽略 version/signature/publishedAt；同内容不重复发版。 */
export function capabilityCardFingerprint(card: AgentCapabilityCard | CapabilityCardDraft): string {
  const provenance = card.provenance;
  return sha256({
    v: card.v,
    kind: card.kind,
    device: card.device,
    agent: card.agent,
    capabilities: [...card.capabilities].sort(),
    tools: [...card.tools].sort(),
    limits: card.limits,
    permissions: {
      ...card.permissions,
      taskNamespaces: [...card.permissions.taskNamespaces].sort(),
    },
    runtime: card.runtime,
    provenance: {
      source: provenance.source,
      configHash: provenance.configHash,
      registryHash: provenance.registryHash,
    },
    ...(card.executable !== undefined ? { executable: card.executable } : {}),
    ...(card.executionMode !== undefined ? { executionMode: card.executionMode } : {}),
    ...(card.health !== undefined ? { health: card.health } : {}),
    tombstone: card.tombstone === true,
  });
}

/** 签名覆盖的规范化内容（不含 signature 字段）。 */
export function canonicalCapabilityCard(card: AgentCapabilityCard | CapabilityCardDraft): string {
  const { signature: _signature, ...rest } = card as AgentCapabilityCard;
  return canonicalCardJson(rest);
}

function signerUnavailable(device: string): Error {
  const error = new Error(`能力卡签名不可用：设备 ${device} 没有已加载的私钥`) as Error & { code?: string };
  error.code = 'CARD_SIGNER_UNAVAILABLE';
  return error;
}

/** 用本机设备身份签名（core 既有 `Mebular.identity`；不伪造、不落私钥）。 */
export async function signAgentCapabilityCard(
  mebular: Pick<Mebular, 'identity'>,
  draft: CapabilityCardDraft,
): Promise<AgentCapabilityCard> {
  const identity = mebular.identity?.getDeviceKey(draft.device);
  if (!identity || identity.privateKey === undefined) throw signerUnavailable(draft.device);
  const data = new TextEncoder().encode(canonicalCapabilityCard(draft));
  const signature = await crypto.subtle.sign({ name: 'Ed25519' }, identity.privateKey, data);
  return {
    ...draft,
    signature: {
      alg: 'Ed25519',
      keyId: identity.deviceId,
      sig: Buffer.from(new Uint8Array(signature)).toString('base64'),
    },
  };
}

/** 用给定设备公钥校验卡片签名（raw 32B 或 hex）。 */
export async function verifyAgentCapabilityCardSignature(
  card: AgentCapabilityCard,
  devicePublicKey: Uint8Array | string,
): Promise<boolean> {
  try {
    const raw = typeof devicePublicKey === 'string'
      ? Buffer.from(devicePublicKey, 'hex')
      : Buffer.from(devicePublicKey);
    const key = await crypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      Buffer.from(card.signature.sig, 'base64'),
      new TextEncoder().encode(canonicalCapabilityCard(card)),
    );
  } catch {
    return false;
  }
}

function scanSensitiveKeys(value: unknown, path: string, errors: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanSensitiveKeys(item, `${path}[${index}]`, errors));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      errors.push(`${path}.${key} 不得出现在能力卡中`);
      continue;
    }
    scanSensitiveKeys(child, `${path}.${key}`, errors);
  }
}

/** 严格形状校验（含隐私键扫描；不校验签名有效性）。 */
export function validateAgentCapabilityCard(input: unknown): CapabilityCardValidation {
  return validateCardFields(input, true);
}

/** 签名前 draft 校验：与完整卡同一套字段规则，但要求 `signature` 不存在。 */
export function validateCapabilityCardDraft(input: unknown): CapabilityCardValidation {
  return validateCardFields(input, false);
}

function validateCardFields(input: unknown, requireSignature: boolean): CapabilityCardValidation {
  const errors: string[] = [];
  if (!isRecord(input)) return { ok: false, errors: ['能力卡必须是对象'] };
  const card = input;
  if (card.v !== CAPABILITY_CARD_SCHEMA_VERSION) errors.push('v 必须为 1');
  if (card.kind !== CAPABILITY_CARD_KIND) errors.push(`kind 必须为 ${CAPABILITY_CARD_KIND}`);
  if (!nonEmptyString(card.device)) errors.push('device 必须为非空字符串');
  else if (card.device === PLAN_SENTINEL) errors.push(`device 不得使用保留名 ${PLAN_SENTINEL}`);
  if (!nonEmptyString(card.agent)) errors.push('agent 必须为非空字符串');
  else if (card.agent === PLAN_SENTINEL) errors.push(`agent 不得使用保留名 ${PLAN_SENTINEL}`);
  if (!Number.isInteger(card.version) || (card.version as number) < 0) errors.push('version 必须为非负整数');
  if (!Array.isArray(card.capabilities) || card.capabilities.some((value) => !nonEmptyString(value))) {
    errors.push('capabilities 必须为非空字符串数组');
  }
  if (!Array.isArray(card.tools) || card.tools.some((value) => !nonEmptyString(value))) {
    errors.push('tools 必须为字符串数组');
  } else {
    for (const tool of card.tools) if (!TOOL_NAME_SET.has(tool)) errors.push(`tools 含不存在的方法：${tool}`);
  }
  if (!isRecord(card.limits)) {
    errors.push('limits 必须为对象');
  } else {
    for (const [key, value] of Object.entries(card.limits)) {
      if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) errors.push(`limits.${key} 必须为有限数字`);
    }
  }
  if (!isRecord(card.permissions)) {
    errors.push('permissions 必须为对象');
  } else {
    if (!Array.isArray(card.permissions.taskNamespaces)
      || card.permissions.taskNamespaces.some((value) => !nonEmptyString(value))) {
      errors.push('permissions.taskNamespaces 必须为字符串数组');
    } else if (card.permissions.taskNamespaces.some((value) => value.startsWith('__'))) {
      errors.push('permissions.taskNamespaces 不得使用保留 namespace');
    }
    if ('allowSubcontract' in card.permissions) errors.push('permissions 不得定义 allowSubcontract（plan-level 字段）');
  }
  if (!isRecord(card.runtime)) {
    errors.push('runtime 必须为对象');
  } else {
    for (const key of ['os', 'arch', 'runtime', 'runtimeVersion']) {
      const value = card.runtime[key];
      if (!nonEmptyString(value) || !CARD_RUNTIME_TOKEN_RE.test(value)) {
        errors.push(`runtime.${key} 必须为安全 token（无空白/路径/引号/原文）`);
      }
    }
  }
  if (!isRecord(card.provenance)) {
    errors.push('provenance 必须为对象');
  } else {
    for (const key of ['source', 'configHash', 'registryHash']) {
      const value = card.provenance[key];
      if (!nonEmptyString(value)) errors.push(`provenance.${key} 必须为非空字符串`);
      else if (key === 'source' && !CARD_SOURCE_TOKEN_RE.test(value)) {
        errors.push('provenance.source 必须为安全 token（无空白/路径/引号/原文）');
      }
    }
    if (typeof card.provenance.publishedAt !== 'number' || !Number.isFinite(card.provenance.publishedAt)) {
      errors.push('provenance.publishedAt 必须为有限数字');
    }
  }
  if (requireSignature) {
    if (!isRecord(card.signature)) {
      errors.push('signature 必须为对象');
    } else {
      if (card.signature.alg !== 'Ed25519') errors.push('signature.alg 必须为 Ed25519');
      if (!nonEmptyString(card.signature.keyId)) errors.push('signature.keyId 必须为非空字符串');
      if (!nonEmptyString(card.signature.sig)) errors.push('signature.sig 必须为非空字符串');
    }
  } else if ('signature' in card) {
    errors.push('draft 不得包含 signature');
  }
  if (card.tombstone !== undefined && typeof card.tombstone !== 'boolean') errors.push('tombstone 若存在须为布尔');
  // additive：旧卡缺字段仍合法；一旦出现就必须是稳定形状。
  if (card.executable !== undefined && typeof card.executable !== 'boolean') {
    errors.push('executable 若存在须为布尔');
  }
  if (card.executionMode !== undefined
    && !EXECUTOR_EXECUTION_MODES.includes(card.executionMode as ExecutorExecutionMode)) {
    errors.push('executionMode 若存在须为 cli|http|json-rpc|in-process');
  }
  if (card.health !== undefined) {
    if (!isRecord(card.health)) {
      errors.push('health 若存在须为对象');
    } else {
      const health = card.health as Record<string, unknown>;
      if (health.status !== 'ok' && health.status !== 'degraded' && health.status !== 'unavailable') {
        errors.push('health.status 须为 ok|degraded|unavailable');
      }
      if (health.checkedAt !== undefined && (typeof health.checkedAt !== 'number' || !Number.isFinite(health.checkedAt))) {
        errors.push('health.checkedAt 若存在须为有限数字');
      }
      if (health.latencyMs !== undefined && (typeof health.latencyMs !== 'number' || !Number.isFinite(health.latencyMs))) {
        errors.push('health.latencyMs 若存在须为有限数字');
      }
      if (health.detail !== undefined && typeof health.detail !== 'string') {
        errors.push('health.detail 若存在须为字符串');
      }
    }
  }
  scanSensitiveKeys(card, 'card', errors);
  return { ok: errors.length === 0, errors };
}

/**
 * 读取能力卡：只返回 **author 绑定 + 签名验证通过** 的卡片。
 * - `node.createdBy === card.device`；
 * - 本机 device 用 `mebular.identity` 公钥；远端用已认证 `sync.getPeerPublicKey`；
 * - 调用方也可注入 `publicKeyFor`（测试/离线校验）。
 * 没有可信公钥或验证失败 → 丢弃；不把未验证卡交给路由/展示。
 */
export async function listCapabilityCards(
  mebular: CapabilityCardReader,
  options: string | CapabilityCardReadOptions = {},
): Promise<AgentCapabilityCard[]> {
  const opts = typeof options === 'string' ? { namespace: options } : options;
  const namespace = opts.namespace ?? AGENT_NAMESPACE;
  const nodes = await mebular.graph.listNodes({ type: CAPABILITY_CARD_NODE_TYPE });
  const cards: AgentCapabilityCard[] = [];
  for (const node of nodes) {
    if (node.namespace !== namespace || node.deletedAt) continue;
    if (node.metadata?.internal !== true) continue;
    const internalObject = node.metadata.internalObject;
    if (!isRecord(internalObject) || internalObject.kind !== CAPABILITY_CARD_KIND) continue;
    const validation = validateAgentCapabilityCard(node.content);
    if (!validation.ok) continue;
    const card = node.content as unknown as AgentCapabilityCard;
    if (node.createdBy !== card.device) continue;
    const publicKey = opts.publicKeyFor?.(card.device)
      ?? mebular.identity?.getDeviceKey(card.device)?.publicKey
      ?? mebular.sync?.getPeerPublicKey?.(card.device);
    if (publicKey === undefined) continue;
    if (!(await verifyAgentCapabilityCardSignature(card, publicKey))) continue;
    cards.push(card);
  }
  return cards;
}

/** 最新版本：`(device, agent)` 取最大 version；平局取稳定序列化较大者。 */
export function latestCapabilityCards(cards: readonly AgentCapabilityCard[]): AgentCapabilityCard[] {
  const byTarget = new Map<string, AgentCapabilityCard>();
  for (const card of cards) {
    const key = `${card.device}\u0000${card.agent}`;
    const previous = byTarget.get(key);
    if (previous === undefined) {
      byTarget.set(key, card);
      continue;
    }
    const stronger = card.version !== previous.version
      ? card.version > previous.version
      : canonicalCardJson(card) > canonicalCardJson(previous);
    if (stronger) byTarget.set(key, card);
  }
  return [...byTarget.values()].sort((a, b) =>
    a.device < b.device ? -1 : a.device > b.device ? 1 : a.agent < b.agent ? -1 : a.agent > b.agent ? 1 : 0);
}

/** 活跃卡片（排除 tombstone）。 */
export function activeCapabilityCards(cards: readonly AgentCapabilityCard[]): AgentCapabilityCard[] {
  return cards.filter((card) => card.tombstone !== true);
}

/** 写入 internal 节点（metadata 在创建时写入，避免泄漏窗口）。 */
export async function appendCapabilityCard(
  mebular: Pick<Mebular, 'graph'>,
  card: AgentCapabilityCard,
  namespace = AGENT_NAMESPACE,
): Promise<string> {
  const validation = validateAgentCapabilityCard(card);
  if (!validation.ok) throw new Error(`能力卡非法：${validation.errors.join('; ')}`);
  const node = await mebular.graph.createNode(CAPABILITY_CARD_NODE_TYPE, card as unknown as Record<string, unknown>, [], {
    namespace,
    metadata: {
      internal: true,
      internalObject: {
        schema: CAPABILITY_CARD_SCHEMA_VERSION,
        kind: CAPABILITY_CARD_KIND,
      },
    },
  });
  return node.id;
}

/** embedded 后端：本地 Mebular 签名并写 internal 节点。 */
export function embeddedCapabilityCardBackend(
  mebular: Pick<Mebular, 'graph' | 'identity'>,
  namespace = AGENT_NAMESPACE,
): CapabilityCardBackend {
  return {
    listCards: () => listCapabilityCards(mebular, namespace),
    signAndAppendCard: async (draft) => {
      const signed = await signAgentCapabilityCard(mebular, draft);
      await appendCapabilityCard(mebular, signed, namespace);
      return signed;
    },
  };
}

/** 发布能力卡（后端无关）：版本单调、同内容 no-op、agent 移除发 tombstone。 */
export async function publishCapabilityCardsWithBackend(options: {
  backend: CapabilityCardBackend;
  config: Pick<FleetConfig, 'device' | 'namespace' | 'agents'>;
  registry?: CapabilityCardRegistry;
  runtime?: CapabilityCardRuntime;
  now?: number;
}): Promise<CapabilityCardPublishResult> {
  const now = options.now ?? Date.now();
  const existing = latestCapabilityCards(await options.backend.listCards());
  const desired = compileCapabilityCards({
    config: options.config,
    ...(options.registry !== undefined ? { registry: options.registry } : {}),
    ...(options.runtime !== undefined ? { runtime: options.runtime } : {}),
    now,
  });
  const desiredAgents = new Set(desired.map((card) => card.agent));
  const published: AgentCapabilityCard[] = [];
  const errors: string[] = [];
  let unchanged = 0;
  let tombstoned = 0;

  for (const draft of desired) {
    const latest = existing.find((card) => card.device === draft.device && card.agent === draft.agent) ?? null;
    const candidate: CapabilityCardDraft = {
      ...draft,
      version: latest === null ? 1 : latest.version + 1,
      tombstone: false,
    };
    if (latest !== null
      && latest.tombstone !== true
      && capabilityCardFingerprint(latest) === capabilityCardFingerprint(candidate)) {
      unchanged += 1;
      continue;
    }
    try {
      const signed = await options.backend.signAndAppendCard(candidate);
      published.push(signed);
    } catch (error) {
      errors.push(`${draft.device}/${draft.agent}: ${(error as Error).message}`);
    }
  }

  for (const latest of existing) {
    if (latest.device !== options.config.device) continue; // 只为本机移除的 agent 发 tombstone
    if (desiredAgents.has(latest.agent) || latest.tombstone === true) continue;
    const { signature: _signature, ...rest } = latest;
    const candidate: CapabilityCardDraft = {
      ...rest,
      version: latest.version + 1,
      capabilities: [],
      tools: [],
      limits: {},
      permissions: { taskNamespaces: [] },
      provenance: {
        ...latest.provenance,
        source: 'agent-removed',
        configHash: configHashOf(options.config),
        registryHash: registryHashOf(options.config, options.registry),
        publishedAt: now,
      },
      tombstone: true,
    };
    try {
      const signed = await options.backend.signAndAppendCard(candidate);
      published.push(signed);
      tombstoned += 1;
    } catch (error) {
      errors.push(`${latest.device}/${latest.agent}: ${(error as Error).message}`);
    }
  }

  return {
    published: published.length - tombstoned,
    unchanged,
    tombstoned,
    cards: published,
    errors,
  };
}

/** embedded 便利入口：本地 Mebular 签名/写节点。 */
export async function publishCapabilityCards(options: {
  mebular: Pick<Mebular, 'graph' | 'identity'>;
  config: Pick<FleetConfig, 'device' | 'namespace' | 'agents'>;
  registry?: CapabilityCardRegistry;
  namespace?: string;
  runtime?: CapabilityCardRuntime;
  now?: number;
}): Promise<CapabilityCardPublishResult> {
  return publishCapabilityCardsWithBackend({
    backend: embeddedCapabilityCardBackend(options.mebular, options.namespace ?? AGENT_NAMESPACE),
    config: options.config,
    ...(options.registry !== undefined ? { registry: options.registry } : {}),
    ...(options.runtime !== undefined ? { runtime: options.runtime } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
}

/** 发布能力卡 + 每设备 Agent 目录（后端无关）；单次失败只进入 errors。 */
export async function publishFleetCardsWithBackend(options: {
  backend: FleetAgentBackend;
  config: Pick<FleetConfig, 'device' | 'namespace' | 'agents'>;
  registry?: CapabilityCardRegistry;
  runtime?: CapabilityCardRuntime;
  now?: number;
}): Promise<FleetCardsPublishResult> {
  const errors: string[] = [];
  let directory: AgentDirectoryPublishResult | null = null;
  try {
    directory = await publishAgentDirectoryWithBackend(options.backend, options.config, {
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
  } catch (error) {
    errors.push(`directory: ${(error as Error).message}`);
  }
  const cards = await publishCapabilityCardsWithBackend(options);
  errors.push(...cards.errors);
  return { cards, directory, errors };
}

/** embedded 便利入口：发布能力卡 + 目录。 */
export async function publishFleetCards(options: {
  mebular: Pick<Mebular, 'graph' | 'identity'>;
  config: Pick<FleetConfig, 'device' | 'namespace' | 'agents'>;
  registry?: CapabilityCardRegistry;
  namespace?: string;
  runtime?: CapabilityCardRuntime;
  now?: number;
}): Promise<FleetCardsPublishResult> {
  const namespace = options.namespace ?? AGENT_NAMESPACE;
  const backend: FleetAgentBackend = {
    ...embeddedCapabilityCardBackend(options.mebular, namespace),
    ...embeddedAgentDirectoryBackend(options.mebular as Mebular, namespace),
  };
  return publishFleetCardsWithBackend({
    backend,
    config: options.config,
    ...(options.registry !== undefined ? { registry: options.registry } : {}),
    ...(options.runtime !== undefined ? { runtime: options.runtime } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
}

/** `task_targets.cards` 摘要：只含标签/版本/在线/在途，不含卡片原文或角色卡。 */
export function summarizeCapabilityCards(
  cards: readonly AgentCapabilityCard[],
  options: {
    online?: (device: string) => boolean;
    inflight?: (device: string, agent: string) => number;
    devices?: readonly string[];
  } = {},
): CapabilityCardSummary[] {
  const allowed = options.devices === undefined ? null : new Set(options.devices);
  return activeCapabilityCards(latestCapabilityCards(cards))
    .filter((card) => allowed === null || allowed.has(card.device))
    .map((card) => ({
      device: card.device,
      agent: card.agent,
      version: card.version,
      capabilities: [...card.capabilities].sort(),
      online: options.online?.(card.device) ?? false,
      inflight: Math.max(0, Math.trunc(options.inflight?.(card.device, card.agent) ?? 0)),
    }))
    .sort((a, b) =>
      a.device < b.device ? -1 : a.device > b.device ? 1 : a.agent < b.agent ? -1 : a.agent > b.agent ? 1 : 0);
}
