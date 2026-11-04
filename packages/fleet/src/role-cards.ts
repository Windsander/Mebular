// P5 角色卡（agent_role_card）：本机 runtime job 从任务历史 + 可选内部摘要生成。
//
// 边界（P0 契约 §5.2 / §7.3 / §7.8）：
// - internal 记忆节点：`agents` 域，`metadata.internal=true` +
//   `internalObject.kind="agent_role_card"`；不新增域、不进列表/计数/搜索/SSE。
// - 只存摘要/标签/证据引用：不存原始对话、prompt、command、env 或凭据。
// - 版本按 `(device, agent, kind)` 单调；tombstone 后不再参与排序。
// - 默认 `shadow=true`：只计算、不参与派发；只有显式启用且 confidence>=0.5、
//   shadow=false 时才作为 route 的**最后一项软排序**，永不做硬过滤/授权。

import { createHash } from 'node:crypto';
import type { Mebular } from '@mebular/core';
import { AGENT_NAMESPACE } from './agentdir.js';
import { canonicalCardJson } from './cards.js';
import { reduceTaskEvents } from './model.js';
import type { TaskEvent } from './protocol/events.js';
import { PLAN_SENTINEL } from './protocol/envelope.js';

export const ROLE_CARD_KIND = 'agent_role_card';
export const ROLE_CARD_NODE_TYPE = 'agent_role_card';
export const ROLE_CARD_SCHEMA_VERSION = 1 as const;
export const ROLE_CARD_DEFAULT_CONFIDENCE_THRESHOLD = 0.5;
export const ROLE_CARD_GENERATOR = 'fleet-role-rules-v1';
export const ROLE_CARD_DEFAULT_WINDOW = 50;
export const ROLE_CARD_DEFAULT_REFRESH_TASKS = 5;
export const ROLE_CARD_DEFAULT_MIN_INTERVAL_MS = 60_000;

/** 敏感键：角色卡任何层级都不允许出现（与能力卡同一红线）。 */
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
  'prompt',
  'dialogue',
  'transcript',
  'messages',
  'raw',
  'rawchunk',
]);

const TOP_LEVEL_KEYS = new Set([
  'v',
  'kind',
  'device',
  'agent',
  'version',
  'summary',
  'strengths',
  'preferredIntents',
  'avoid',
  'confidence',
  'evidenceRefs',
  'shadow',
  'provenance',
  'tombstone',
]);

const PROVENANCE_KEYS = new Set(['source', 'sampleSize', 'generatedAt', 'generator']);
const EVIDENCE_KEYS = new Set(['kind', 'id']);
const TRAIT_KEYS = new Set(['tag', 'confidence']);

const MAX_SUMMARY_LENGTH = 512;
const MAX_TAG_LENGTH = 64;
const MAX_EVIDENCE_ID_LENGTH = 256;
const MAX_LIST_LENGTH = 32;

export interface RoleCardTrait {
  tag: string;
  confidence: number;
}

export interface RoleCardEvidenceRef {
  /** `task` / `summary` 等；只允许引用 ID 或哈希，不存原文。 */
  kind: string;
  id: string;
}

export interface RoleCardProvenance {
  source: string;
  sampleSize: number;
  generatedAt: number;
  generator: string;
}

export interface AgentRoleCard {
  v: typeof ROLE_CARD_SCHEMA_VERSION;
  kind: typeof ROLE_CARD_KIND;
  device: string;
  agent: string;
  version: number;
  summary: string;
  strengths: RoleCardTrait[];
  preferredIntents: string[];
  avoid: RoleCardTrait[];
  confidence: number;
  evidenceRefs: RoleCardEvidenceRef[];
  /** 默认 true；shadow 期 route 必须忽略。 */
  shadow: boolean;
  provenance: RoleCardProvenance;
  tombstone?: boolean;
}

/** 版本由发布器/存储层分配；生成器只产出内容 draft。 */
export type RoleCardDraft = Omit<AgentRoleCard, 'version'>;

export interface RoleCardValidation {
  ok: boolean;
  errors: string[];
}

export interface RoleCardAppendResult {
  stored: boolean;
  replayed: boolean;
  card: AgentRoleCard;
  nodeId: string | null;
  createdBy: string;
}

export interface StoredAgentRoleCard {
  card: AgentRoleCard;
  nodeId: string;
  createdBy: string;
}

export interface RoleCardNodeOptions {
  namespace?: string;
  nodeType?: string;
}

/** 角色卡存储：embedded（本地 Mebular graph）与 daemon（`/app/role-cards`）共用语义。 */
export interface RoleCardStore {
  list(): Promise<AgentRoleCard[]>;
  listStored?(): Promise<StoredAgentRoleCard[]>;
  append(input: unknown): Promise<RoleCardAppendResult>;
  close?(): Promise<void>;
}

export class RoleCardValidationError extends Error {
  readonly code: string;
  readonly errors: string[];

  constructor(code: string, errors: string[]) {
    super(`${code}: ${errors.join('; ')}`);
    this.name = 'RoleCardValidationError';
    this.code = code;
    this.errors = errors;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function unitNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function scanSensitiveKeys(value: unknown, path: string, errors: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanSensitiveKeys(item, `${path}[${index}]`, errors));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      errors.push(`${path}.${key} 不得出现在角色卡中`);
      continue;
    }
    scanSensitiveKeys(child, `${path}.${key}`, errors);
  }
}

function scanUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
  errors: string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${path}.${key} 不是角色卡允许的字段`);
  }
}

function validateTraits(value: unknown, field: string, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push(`${field} 必须为数组`);
    return;
  }
  if (value.length > MAX_LIST_LENGTH) errors.push(`${field} 最多 ${MAX_LIST_LENGTH} 项`);
  value.forEach((item, index) => {
    if (!isRecord(item)) {
      errors.push(`${field}[${index}] 必须为对象`);
      return;
    }
    scanUnknownKeys(item, TRAIT_KEYS, `${field}[${index}]`, errors);
    if (!boundedString(item.tag, MAX_TAG_LENGTH)) errors.push(`${field}[${index}].tag 必须为非空短字符串`);
    if (!unitNumber(item.confidence)) errors.push(`${field}[${index}].confidence 必须为 0..1`);
  });
}

/** 严格形状校验（含隐私键/未知字段扫描；不校验作者/版本单调）。 */
export function validateAgentRoleCard(input: unknown): RoleCardValidation {
  const errors: string[] = [];
  if (!isRecord(input)) return { ok: false, errors: ['角色卡必须是对象'] };
  const card = input;
  scanUnknownKeys(card, TOP_LEVEL_KEYS, 'card', errors);
  if (card.v !== ROLE_CARD_SCHEMA_VERSION) errors.push('v 必须为 1');
  if (card.kind !== ROLE_CARD_KIND) errors.push(`kind 必须为 ${ROLE_CARD_KIND}`);
  if (!boundedString(card.device, 128)) errors.push('device 必须为非空短字符串');
  else if (card.device === PLAN_SENTINEL) errors.push(`device 不得使用保留名 ${PLAN_SENTINEL}`);
  if (!boundedString(card.agent, 128)) errors.push('agent 必须为非空短字符串');
  else if (card.agent === PLAN_SENTINEL) errors.push(`agent 不得使用保留名 ${PLAN_SENTINEL}`);
  if (!Number.isInteger(card.version) || (card.version as number) < 0) errors.push('version 必须为非负整数');
  if (!boundedString(card.summary, MAX_SUMMARY_LENGTH) || /[\u0000-\u001f\u007f]/.test(card.summary)) {
    errors.push(`summary 必须为不含控制字符的非空短字符串（<=${MAX_SUMMARY_LENGTH}）`);
  }
  validateTraits(card.strengths, 'strengths', errors);
  validateTraits(card.avoid, 'avoid', errors);
  if (!Array.isArray(card.preferredIntents)
    || card.preferredIntents.length > MAX_LIST_LENGTH
    || card.preferredIntents.some((tag) => !boundedString(tag, MAX_TAG_LENGTH))) {
    errors.push(`preferredIntents 必须为最多 ${MAX_LIST_LENGTH} 项的非空短字符串数组`);
  }
  if (!unitNumber(card.confidence)) errors.push('confidence 必须为 0..1');
  if (!Array.isArray(card.evidenceRefs) || card.evidenceRefs.length > MAX_LIST_LENGTH) {
    errors.push(`evidenceRefs 必须为最多 ${MAX_LIST_LENGTH} 项的数组`);
  } else {
    card.evidenceRefs.forEach((item, index) => {
      if (!isRecord(item)) {
        errors.push(`evidenceRefs[${index}] 必须为对象`);
        return;
      }
      scanUnknownKeys(item, EVIDENCE_KEYS, `evidenceRefs[${index}]`, errors);
      if (!boundedString(item.kind, 64)) errors.push(`evidenceRefs[${index}].kind 必须为非空短字符串`);
      if (!boundedString(item.id, MAX_EVIDENCE_ID_LENGTH)) errors.push(`evidenceRefs[${index}].id 必须为非空短字符串`);
    });
  }
  if (typeof card.shadow !== 'boolean') errors.push('shadow 必须为布尔');
  if (!isRecord(card.provenance)) {
    errors.push('provenance 必须为对象');
  } else {
    scanUnknownKeys(card.provenance, PROVENANCE_KEYS, 'provenance', errors);
    for (const key of ['source', 'generator']) {
      if (!boundedString(card.provenance[key], 128)) errors.push(`provenance.${key} 必须为非空短字符串`);
    }
    if (!Number.isInteger(card.provenance.sampleSize) || (card.provenance.sampleSize as number) < 0) {
      errors.push('provenance.sampleSize 必须为非负整数');
    }
    if (typeof card.provenance.generatedAt !== 'number' || !Number.isFinite(card.provenance.generatedAt)) {
      errors.push('provenance.generatedAt 必须为有限数字');
    }
  }
  if (card.tombstone !== undefined && typeof card.tombstone !== 'boolean') errors.push('tombstone 若存在须为布尔');
  scanSensitiveKeys(card, 'card', errors);
  return { ok: errors.length === 0, errors };
}

/** 卡片内容指纹：忽略 version 与 generatedAt；同内容不重复发版。 */
export function roleCardFingerprint(card: AgentRoleCard | RoleCardDraft): string {
  return `sha256:${createHash('sha256').update(canonicalCardJson({
    v: card.v,
    kind: card.kind,
    device: card.device,
    agent: card.agent,
    summary: card.summary,
    strengths: card.strengths,
    preferredIntents: card.preferredIntents,
    avoid: card.avoid,
    confidence: card.confidence,
    evidenceRefs: card.evidenceRefs,
    shadow: card.shadow,
    provenance: {
      source: card.provenance.source,
      sampleSize: card.provenance.sampleSize,
      generator: card.provenance.generator,
    },
    tombstone: card.tombstone === true,
  })).digest('hex')}`;
}

export function roleCardKey(card: Pick<AgentRoleCard, 'device' | 'agent'>): string {
  return `${card.device}\u0000${card.agent}\u0000${ROLE_CARD_KIND}`;
}

/** 最新版本按 `(device, agent, kind)`；同版本平局取稳定序列化较大者。 */
export function latestAgentRoleCards(cards: readonly AgentRoleCard[]): AgentRoleCard[] {
  const byTarget = new Map<string, AgentRoleCard>();
  for (const card of cards) {
    const key = roleCardKey(card);
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

/** 活跃角色卡（排除 tombstone）。 */
export function activeAgentRoleCards(cards: readonly AgentRoleCard[]): AgentRoleCard[] {
  return cards.filter((card) => card.tombstone !== true);
}

/** 某目标的最新活跃角色卡；不存在/墓碑/作者不符由调用方先通过 `list` 过滤。 */
export function roleCardForTarget(
  cards: readonly AgentRoleCard[],
  device: string,
  agent: string,
): AgentRoleCard | null {
  return activeAgentRoleCards(latestAgentRoleCards(cards))
    .find((card) => card.device === device && card.agent === agent) ?? null;
}

/** 启用软排序的资格：显式 shadow=false 且 confidence>=0.5。 */
export function roleCardSortEligible(
  card: AgentRoleCard | null,
  threshold = ROLE_CARD_DEFAULT_CONFIDENCE_THRESHOLD,
): card is AgentRoleCard {
  return card !== null
    && card.tombstone !== true
    && card.shadow === false
    && card.confidence >= threshold;
}

/**
 * 角色卡软排序分数（0..1）：总体 confidence + 意图命中/回避的轻微调整。
 * 只用于软排序，不参与授权/硬过滤。`why` 只输出分数，不输出摘要原文。
 */
export function roleCardScore(card: AgentRoleCard, intent?: string): number {
  const label = typeof intent === 'string' ? normalizeIntentLabel(intent) : undefined;
  let score = card.confidence;
  if (label !== undefined) {
    if (card.preferredIntents.includes(label)) score += 0.05;
    if (card.avoid.some((entry) => entry.tag === label)) score -= 0.05;
  }
  return round4(clamp01(score));
}

// ---------------------------------------------------------------------------
// 任务历史聚合
// ---------------------------------------------------------------------------

export interface RoleTaskSample {
  taskId: string;
  device: string;
  agent: string;
  intent: string;
  success: boolean;
  /** 终态事件时间（本机展示/最近性窗口；不参与任务一致性判定）。 */
  at: number;
  latencyMs?: number;
}

/**
 * 从任务事件派生角色卡样本：只保留真实执行者（排除 plan sentinel/通配 agent），
 * 只记录任务 ID、意图标签、成败与时长，不读取 payload/result 原文。
 */
export function collectRoleTaskSamples(
  events: readonly TaskEvent[],
): RoleTaskSample[] {
  const byTask = new Map<string, TaskEvent[]>();
  for (const event of events) {
    const list = byTask.get(event.taskId);
    if (list) list.push(event);
    else byTask.set(event.taskId, [event]);
  }
  const samples: RoleTaskSample[] = [];
  for (const [taskId, taskEvents] of byTask) {
    const state = reduceTaskEvents(taskEvents);
    if (state === null || !state.terminal) continue;
    if (!nonEmptyString(state.to.device) || state.to.device.startsWith('__')) continue;
    if (!nonEmptyString(state.to.agent) || state.to.agent === '*' || state.to.agent === PLAN_SENTINEL) continue;
    const created = [...taskEvents]
      .filter((event) => event.type === 'created')
      .sort((a, b) => (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0))[0];
    const terminalEvent = taskEvents.find((event) => event.eventId === state.lastEventId);
    if (created === undefined || terminalEvent === undefined) continue;
    const latency = terminalEvent.at - created.at;
    samples.push({
      taskId,
      device: state.to.device,
      agent: state.to.agent,
      intent: normalizeIntentLabel(state.intent),
      success: state.status === 'done',
      at: Number.isFinite(terminalEvent.at) ? terminalEvent.at : 0,
      ...(state.status === 'done' && Number.isFinite(latency) && latency >= 0 ? { latencyMs: Math.trunc(latency) } : {}),
    });
  }
  return samples.sort((a, b) => {
    if (a.at !== b.at) return b.at - a.at;
    if (a.taskId !== b.taskId) return a.taskId < b.taskId ? -1 : 1;
    return a.device < b.device ? -1 : a.device > b.device ? 1 : a.agent < b.agent ? -1 : a.agent > b.agent ? 1 : 0;
  });
}

/** 意图标签：折叠空白、小写；过长/控制字符改用短哈希，避免把长原文写进卡片。 */
export function normalizeIntentLabel(value: unknown): string {
  if (typeof value !== 'string') return 'unlabeled';
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  if (text.length === 0) return 'unlabeled';
  if (text.length <= 48) return text;
  return `intent:${createHash('sha256').update(text).digest('hex').slice(0, 16)}`;
}

/** 最近性权重：7 天内为 1，30 天后为 0，线性衰减。 */
function freshnessOf(latestAt: number, now: number): number {
  const age = Math.max(0, now - latestAt);
  const sevenDays = 7 * 24 * 60 * 60 * 1000;
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;
  if (age <= sevenDays) return 1;
  if (age >= thirtyDays) return 0;
  return (thirtyDays - age) / (thirtyDays - sevenDays);
}

/**
 * 总体 confidence：样本量 + 平滑成功率 + 意图一致性 + 最近性。
 * 1 个样本（即使成功）保持 <0.5；样本越少越接近低置信度回退。
 */
export function computeRoleConfidence(input: {
  samples: number;
  successes: number;
  consistency: number;
  freshness: number;
}): number {
  const samples = Math.max(0, Math.trunc(input.samples));
  if (samples === 0) return 0;
  const sampleFactor = Math.min(1, samples / 15);
  const smoothedSuccess = (input.successes + 1) / (samples + 2);
  return round4(clamp01(
    0.05
    + 0.45 * sampleFactor
    + 0.25 * smoothedSuccess
    + 0.15 * clamp01(input.consistency)
    + 0.10 * clamp01(input.freshness),
  ));
}

// ---------------------------------------------------------------------------
// 可选内部摘要（memory runtime compact/checkpoint）只读 seam
// ---------------------------------------------------------------------------

/** 只读摘要引用：绝不把 summary 原文写进角色卡。 */
export interface RoleSummary {
  id: string;
  device?: string;
  agent?: string;
  /** 只为兼容 provider 形状；生成器不复制该文本。 */
  summary?: string;
  intents?: string[];
  at?: number;
}

export interface RoleSummaryProvider {
  listSummaries(options: { device: string; agents: readonly string[] }): Promise<readonly RoleSummary[]>;
}

type SummaryGraph = Pick<Mebular, 'graph'>;

export interface GraphRoleSummaryProviderOptions {
  /** 摘要所在域；默认 `tasks` + `agents`。 */
  namespaces?: readonly string[];
  /** 内部对象 kind；默认 compact + context_checkpoint。 */
  kinds?: readonly string[];
}

/**
 * embedded 只读摘要 provider：读取 memory runtime 已落盘的 internal compact/checkpoint。
 * 只提取 id/agent/device/intents；summary 文本不进入角色卡，没有摘要时返回空。
 */
export function graphRoleSummaryProvider(
  mebular: SummaryGraph,
  options: GraphRoleSummaryProviderOptions = {},
): RoleSummaryProvider {
  const namespaces = new Set(options.namespaces ?? ['tasks', AGENT_NAMESPACE]);
  const kinds = new Set(options.kinds ?? ['compact', 'context_checkpoint']);
  return {
    async listSummaries(): Promise<readonly RoleSummary[]> {
      const out: RoleSummary[] = [];
      for (const kind of kinds) {
        const nodes = await mebular.graph.listNodes({ type: kind });
        for (const node of nodes) {
          if (node.deletedAt !== undefined) continue;
          if (!namespaces.has(node.namespace ?? 'default')) continue;
          if (node.metadata?.internal !== true) continue;
          const internalObject = node.metadata.internalObject;
          if (!isRecord(internalObject) || !kinds.has(String(internalObject.kind))) continue;
          const content = node.content;
          if (!isRecord(content)) continue;
          const agent = summaryAgentOf(content);
          const device = typeof content.device === 'string' && content.device.length > 0 ? content.device : undefined;
          out.push({
            id: node.id,
            ...(device !== undefined ? { device } : {}),
            ...(agent !== undefined ? { agent } : {}),
            ...(Array.isArray(content.intents)
              ? { intents: content.intents.filter((value): value is string => typeof value === 'string').slice(0, 16).map(normalizeIntentLabel) }
              : {}),
            ...(typeof content.updatedAt === 'number' && Number.isFinite(content.updatedAt) ? { at: content.updatedAt } : {}),
          });
        }
      }
      return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    },
  };
}

function summaryAgentOf(content: Record<string, unknown>): string | undefined {
  if (typeof content.agent === 'string' && content.agent.length > 0) return content.agent;
  if (typeof content.ownerId === 'string' && content.ownerId.startsWith('agent:')) {
    const agent = content.ownerId.slice('agent:'.length);
    if (agent.length > 0) return agent;
  }
  const provenance = content.provenance;
  if (isRecord(provenance) && typeof provenance.agent === 'string' && provenance.agent.length > 0) {
    return provenance.agent;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 规则生成器
// ---------------------------------------------------------------------------

export interface RoleCardGenerateInput {
  device: string;
  agents: readonly string[];
  events: readonly TaskEvent[];
  summaries?: readonly RoleSummary[];
  now?: number;
  window?: number;
  shadow?: boolean;
  generator?: string;
}

interface AgentAggregate {
  samples: RoleTaskSample[];
  successes: number;
  failures: number;
  byIntent: Map<string, { success: number; failure: number }>;
}

function aggregateForAgent(samples: readonly RoleTaskSample[]): AgentAggregate | null {
  const recent = [...samples].sort((a, b) => {
    if (a.at !== b.at) return b.at - a.at;
    return a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0;
  });
  if (recent.length === 0) return null;
  let successes = 0;
  let failures = 0;
  const byIntent = new Map<string, { success: number; failure: number }>();
  for (const sample of recent) {
    const current = byIntent.get(sample.intent) ?? { success: 0, failure: 0 };
    if (sample.success) {
      successes += 1;
      current.success += 1;
    } else {
      failures += 1;
      current.failure += 1;
    }
    byIntent.set(sample.intent, current);
  }
  return { samples: recent, successes, failures, byIntent };
}

function rankIntents(
  byIntent: ReadonlyMap<string, { success: number; failure: number }>,
  total: number,
  pick: 'success' | 'failure',
  limit = 5,
): RoleCardTrait[] {
  return [...byIntent.entries()]
    .filter(([, counts]) => counts[pick] > 0)
    .sort((a, b) => {
      const diff = b[1][pick] - a[1][pick];
      if (diff !== 0) return diff;
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    })
    .slice(0, limit)
    .map(([tag, counts]) => ({ tag, confidence: round4(Math.min(1, counts[pick] / Math.max(1, total))) }));
}

/**
 * 规则优先生成角色卡 draft：只使用任务标签/成败/时长与摘要 ID。
 * 没有样本的 Agent 不生成卡片；不复制任何 payload/result/摘要原文。
 */
export function generateRoleCards(input: RoleCardGenerateInput): RoleCardDraft[] {
  const now = input.now ?? Date.now();
  const window = Math.max(1, Math.trunc(input.window ?? ROLE_CARD_DEFAULT_WINDOW));
  const shadow = input.shadow ?? true;
  const generator = input.generator ?? ROLE_CARD_GENERATOR;
  const device = input.device;
  const agents = [...new Set(input.agents.filter((agent) => agent.length > 0 && agent !== PLAN_SENTINEL))].sort();
  const summaries = (input.summaries ?? []).filter((summary) => {
    if (!nonEmptyString(summary.id)) return false;
    if (summary.device !== undefined && summary.device !== device) return false;
    return true;
  });
  const allSamples = collectRoleTaskSamples(input.events);

  return agents.flatMap((agent): RoleCardDraft[] => {
    const agentSamples = allSamples
      .filter((sample) => sample.device === device && sample.agent === agent)
      .slice(0, window);
    const aggregate = aggregateForAgent(agentSamples);
    if (aggregate === null) return [];

    const total = aggregate.samples.length;
    const consistency = Math.max(
      0,
      ...[...aggregate.byIntent.values()].map((counts) => (counts.success + counts.failure) / total),
    );
    const latestAt = Math.max(...aggregate.samples.map((sample) => sample.at));
    const confidence = computeRoleConfidence({
      samples: total,
      successes: aggregate.successes,
      consistency,
      freshness: freshnessOf(latestAt, now),
    });
    const strengths = rankIntents(aggregate.byIntent, total, 'success');
    const avoid = rankIntents(aggregate.byIntent, total, 'failure');
    const preferredIntents = strengths.map((entry) => entry.tag);
    const agentSummaries = summaries.filter((summary) => summary.agent === undefined || summary.agent === agent);
    const summaryIntents = [...new Set(agentSummaries.flatMap((summary) => summary.intents ?? []))]
      .filter((tag) => tag.length > 0 && !preferredIntents.includes(tag))
      .slice(0, 5);
    const evidenceRefs: RoleCardEvidenceRef[] = [
      ...aggregate.samples.slice(0, 8).map((sample) => ({ kind: 'task', id: sample.taskId })),
      ...agentSummaries.slice(0, 4).map((summary) => ({ kind: 'summary', id: summary.id })),
    ];
    const successRate = round4(aggregate.successes / Math.max(1, total));
    const preferred = [...preferredIntents, ...summaryIntents];
    const summary = preferred.length > 0
      ? `${agent}: ${total} recent tasks, ${aggregate.successes} done (${Math.round(successRate * 100)}%), prefers ${preferred.slice(0, 3).join(', ')}`
      : `${agent}: ${total} recent tasks, ${aggregate.successes} done (${Math.round(successRate * 100)}%)`;

    return [{
      v: ROLE_CARD_SCHEMA_VERSION,
      kind: ROLE_CARD_KIND,
      device,
      agent,
      summary,
      strengths,
      preferredIntents: preferred,
      avoid,
      confidence,
      evidenceRefs,
      shadow,
      provenance: {
        source: agentSummaries.length > 0 ? 'task-history+internal-summary' : 'task-history',
        sampleSize: total,
        generatedAt: now,
        generator,
      },
      tombstone: false,
    }];
  });
}

// ---------------------------------------------------------------------------
// embedded 存储
// ---------------------------------------------------------------------------

interface RoleCardNodeLike {
  id: string;
  type?: string;
  namespace?: string;
  createdBy?: string;
  deletedAt?: number;
  content?: unknown;
  metadata?: Record<string, unknown>;
}

function isRoleCardNode(node: RoleCardNodeLike, nodeType: string): boolean {
  if (node.type !== nodeType) return false;
  if (node.metadata?.internal !== true) return false;
  const internalObject = node.metadata.internalObject;
  return isRecord(internalObject) && internalObject.kind === ROLE_CARD_KIND;
}

function validStoredCard(node: RoleCardNodeLike): AgentRoleCard | null {
  const validation = validateAgentRoleCard(node.content);
  if (!validation.ok) return null;
  const card = node.content as AgentRoleCard;
  if (node.createdBy !== card.device) return null;
  return card;
}

/** 读取角色卡节点：只返回 internal + schema 合法 + author 绑定（createdBy=device）的卡。 */
export async function listAgentRoleCardNodes(
  mebular: Pick<Mebular, 'graph'>,
  options: RoleCardNodeOptions = {},
): Promise<StoredAgentRoleCard[]> {
  const namespace = options.namespace ?? AGENT_NAMESPACE;
  const nodeType = options.nodeType ?? ROLE_CARD_NODE_TYPE;
  const nodes = await mebular.graph.listNodes({ type: nodeType });
  const out: StoredAgentRoleCard[] = [];
  for (const raw of nodes) {
    const node = raw as unknown as RoleCardNodeLike;
    if (node.deletedAt !== undefined) continue;
    if (node.namespace !== namespace) continue;
    if (!isRoleCardNode(node, nodeType)) continue;
    const card = validStoredCard(node);
    if (card === null) continue;
    out.push({ card, nodeId: node.id, createdBy: node.createdBy ?? card.device });
  }
  return out.sort((a, b) => {
    if (a.card.device !== b.card.device) return a.card.device < b.card.device ? -1 : 1;
    if (a.card.agent !== b.card.agent) return a.card.agent < b.card.agent ? -1 : 1;
    if (a.card.version !== b.card.version) return a.card.version - b.card.version;
    return a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0;
  });
}

export async function listAgentRoleCards(
  mebular: Pick<Mebular, 'graph'>,
  options: string | RoleCardNodeOptions = {},
): Promise<AgentRoleCard[]> {
  const opts = typeof options === 'string' ? { namespace: options } : options;
  return (await listAgentRoleCardNodes(mebular, opts)).map((entry) => entry.card);
}

const roleCardWriteQueues = new WeakMap<object, Promise<unknown>>();

function serializeRoleCardWrite<T>(key: object, run: () => Promise<T>): Promise<T> {
  const previous = roleCardWriteQueues.get(key) ?? Promise.resolve();
  const next = previous.then(run, run);
  roleCardWriteQueues.set(key, next.catch(() => undefined));
  return next;
}

/**
 * embedded 写入：校验 + 作者=本机 + 版本单调/幂等 + internal metadata。
 * 远端卡只能经同步进入，不能从本机 append 伪造。
 */
export async function appendAgentRoleCard(
  mebular: Pick<Mebular, 'graph' | 'deviceId'>,
  input: unknown,
  options: RoleCardNodeOptions = {},
): Promise<RoleCardAppendResult> {
  const validation = validateAgentRoleCard(input);
  if (!validation.ok) throw new RoleCardValidationError('ROLE_CARD_SCHEMA', validation.errors);
  const card = input as AgentRoleCard;
  if (card.device !== mebular.deviceId) {
    throw new RoleCardValidationError('ROLE_CARD_AUTHOR', [
      `卡片 device 必须是写入设备：${card.device} != ${mebular.deviceId}`,
    ]);
  }
  return serializeRoleCardWrite(mebular, async () => {
    const existing = await listAgentRoleCardNodes(mebular, options);
    const latest = latestAgentRoleCards(existing.map((entry) => entry.card))
      .find((entry) => entry.device === card.device && entry.agent === card.agent) ?? null;
    if (latest !== null) {
      if (card.version === latest.version) {
        if (roleCardFingerprint(latest) === roleCardFingerprint(card)) {
          const stored = existing.find((entry) => canonicalCardJson(entry.card) === canonicalCardJson(latest));
          return {
            stored: false,
            replayed: true,
            card: latest,
            nodeId: stored?.nodeId ?? null,
            createdBy: latest.device,
          };
        }
        throw new RoleCardValidationError('ROLE_CARD_CONFLICT', [
          `device+agent+version 已存在且内容不同：${card.device}/${card.agent}#${card.version}`,
        ]);
      }
      if (card.version < latest.version) {
        throw new RoleCardValidationError('ROLE_CARD_STALE', [
          `role card version 落后：${card.version} < ${latest.version}`,
        ]);
      }
      if (card.version !== latest.version + 1) {
        throw new RoleCardValidationError('ROLE_CARD_VERSION_GAP', [
          `role card version 必须紧邻上一版本：${card.version} != ${latest.version + 1}`,
        ]);
      }
    } else if (card.version !== 1) {
      throw new RoleCardValidationError('ROLE_CARD_VERSION_GAP', ['首版角色卡 version 必须为 1']);
    }
    const node = await mebular.graph.createNode(
      options.nodeType ?? ROLE_CARD_NODE_TYPE,
      card as unknown as Record<string, unknown>,
      [],
      {
        namespace: options.namespace ?? AGENT_NAMESPACE,
        metadata: {
          internal: true,
          internalObject: {
            schema: ROLE_CARD_SCHEMA_VERSION,
            kind: ROLE_CARD_KIND,
          },
        },
      },
    );
    return {
      stored: true,
      replayed: false,
      card,
      nodeId: node.id,
      createdBy: mebular.deviceId,
    };
  });
}

/** embedded store。 */
export class MebularRoleCardStore implements RoleCardStore {
  private readonly mebular: Pick<Mebular, 'graph' | 'deviceId'>;
  private readonly options: RoleCardNodeOptions;

  constructor(mebular: Pick<Mebular, 'graph' | 'deviceId'>, options: RoleCardNodeOptions = {}) {
    this.mebular = mebular;
    this.options = { ...options };
  }

  async list(): Promise<AgentRoleCard[]> {
    return (await this.listStored()).map((entry) => entry.card);
  }

  listStored(): Promise<StoredAgentRoleCard[]> {
    return listAgentRoleCardNodes(this.mebular, this.options);
  }

  append(input: unknown): Promise<RoleCardAppendResult> {
    return appendAgentRoleCard(this.mebular, input, this.options);
  }

  async close(): Promise<void> {
    // 存储生命周期由 Mebular 实例管理。
  }
}

// ---------------------------------------------------------------------------
// 发布（版本/tombstone/同内容 no-op）
// ---------------------------------------------------------------------------

export interface RoleCardPublishResult {
  published: number;
  unchanged: number;
  tombstoned: number;
  cards: AgentRoleCard[];
  errors: string[];
}

export interface PublishRoleCardsOptions {
  store: Pick<RoleCardStore, 'list' | 'append'>;
  device: string;
  agents: readonly string[];
  events: readonly TaskEvent[];
  summaries?: readonly RoleSummary[];
  now?: number;
  window?: number;
  shadow?: boolean;
  generator?: string;
}

function tombstoneDraft(card: AgentRoleCard, now: number, generator: string): RoleCardDraft {
  return {
    v: ROLE_CARD_SCHEMA_VERSION,
    kind: ROLE_CARD_KIND,
    device: card.device,
    agent: card.agent,
    summary: `${card.agent}: agent removed`,
    strengths: [],
    preferredIntents: [],
    avoid: [],
    confidence: 0,
    evidenceRefs: [],
    shadow: true,
    provenance: {
      source: 'agent-removed',
      sampleSize: 0,
      generatedAt: now,
      generator,
    },
    tombstone: true,
  };
}

/** 发布角色卡：版本单调、同内容 no-op、本机移除的 agent 发 tombstone。 */
export async function publishRoleCards(options: PublishRoleCardsOptions): Promise<RoleCardPublishResult> {
  const now = options.now ?? Date.now();
  const generator = options.generator ?? ROLE_CARD_GENERATOR;
  const desired = generateRoleCards({
    device: options.device,
    agents: options.agents,
    events: options.events,
    ...(options.summaries !== undefined ? { summaries: options.summaries } : {}),
    now,
    ...(options.window !== undefined ? { window: options.window } : {}),
    ...(options.shadow !== undefined ? { shadow: options.shadow } : {}),
    generator,
  });
  const existing = await options.store.list();
  const latestLocal = latestAgentRoleCards(existing)
    .filter((card) => card.device === options.device);
  const configuredAgents = new Set(options.agents);
  const published: AgentRoleCard[] = [];
  const errors: string[] = [];
  let unchanged = 0;
  let tombstoned = 0;

  for (const draft of desired) {
    const latest = latestLocal.find((card) => card.agent === draft.agent) ?? null;
    const candidate: AgentRoleCard = {
      ...draft,
      version: latest === null ? 1 : latest.version + 1,
    };
    if (latest !== null
      && latest.tombstone !== true
      && roleCardFingerprint(latest) === roleCardFingerprint(candidate)) {
      unchanged += 1;
      continue;
    }
    try {
      const result = await options.store.append(candidate);
      if (result.replayed) unchanged += 1;
      else published.push(result.card);
    } catch (error) {
      errors.push(`${options.device}/${draft.agent}: ${(error as Error).message}`);
    }
  }

  for (const latest of latestLocal) {
    if (configuredAgents.has(latest.agent) || latest.tombstone === true) continue;
    const candidate: AgentRoleCard = {
      ...tombstoneDraft(latest, now, generator),
      version: latest.version + 1,
    };
    try {
      const result = await options.store.append(candidate);
      if (result.replayed) unchanged += 1;
      else {
        published.push(result.card);
        tombstoned += 1;
      }
    } catch (error) {
      errors.push(`${options.device}/${latest.agent}: ${(error as Error).message}`);
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
