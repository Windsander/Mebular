// P3 route resolver：能力卡硬过滤 + 状态视图软排序 + 确定性 tie-break + 可解释 why。
//
// 边界（P0 契约 §7 / §5.3）：
// - 纯函数/纯派生：不读写存储、不依赖墙钟做权威判定；状态视图不落盘、不同步。
// - 硬过滤顺序固定：候选集 → L1 授权 → policy → 能力卡 → payload 可达 → 在线/容量。
// - 显式 `to` 只考虑该目标，硬过滤不通过 → blocked；**永不改派**。
// - 本期 assign-only；角色卡 P5 前不参与（why.roleCard="disabled"）。
// - tie-break 固定 rendezvous SHA-256；同一 key + 同一候选集合 + 同一卡片集合结果恒定。

import { createHash } from 'node:crypto';
import {
  activeCapabilityCards,
  latestCapabilityCards,
  type AgentCapabilityCard,
} from './cards.js';
import {
  ROLE_CARD_DEFAULT_CONFIDENCE_THRESHOLD,
  activeAgentRoleCards,
  latestAgentRoleCards,
  roleCardForTarget,
  roleCardScore,
  roleCardSortEligible,
  type AgentRoleCard,
} from './role-cards.js';
import type { FleetEndpoint } from './protocol/envelope.js';
import type { TaskEvent } from './protocol/events.js';
import { reduceTaskEvents, type TaskState } from './model.js';
import type { PlanPolicy, PlanRoute, PlanStep, TaskPlan } from './plan.js';

export const ROUTE_TIE_BREAK = 'rendezvous-sha256' as const;
export const ROUTE_ROLE_CARD_DISABLED = 'disabled' as const;
export const ROUTE_ROLE_CARD_SHADOW = 'shadow-ignored' as const;
export const ROUTE_ROLE_CARD_USED = 'used-soft' as const;
export const ROUTE_STATUS_TTL_MS = 30_000;
export const ROUTE_OBSERVATION_WINDOW = 20;
/** 最近成功率的最小样本；不足时按中性 0.5（契约 §7.3）。 */
export const ROUTE_MIN_SUCCESS_SAMPLES = 3;

export type RouteRoleCardMode = 'shadow' | 'enabled';
export type RouteRoleCardStatus =
  | typeof ROUTE_ROLE_CARD_DISABLED
  | typeof ROUTE_ROLE_CARD_SHADOW
  | typeof ROUTE_ROLE_CARD_USED;

export type RouteDecisionCode = 'ASSIGNED' | 'NO_TARGET' | 'POLICY_DENIED';
export type RouteDecisionOutcome = 'assigned' | 'NO_TARGET' | 'POLICY_DENIED';

export type RouteRejectionCode =
  | 'UNAUTHORIZED'
  | 'OFFLINE'
  | 'EXPLICIT_OFFLINE'
  | 'MISSING_CAPABILITY'
  | 'POLICY_DENIED'
  | 'PAYLOAD_UNREACHABLE'
  | 'AT_CAPACITY'
  | 'ADAPTER_UNAVAILABLE'
  | 'NO_CANDIDATES';

export interface RouteAuthorization {
  /** L1 授权设备（已订阅任务 namespace / 白名单 / 信任链内）；本机 owner 由调用方显式加入。 */
  devices: readonly string[];
  /** 可选的按设备 Agent 授权；缺省 = 该设备的全部能力卡 Agent 均可候选。 */
  agents?: Readonly<Record<string, readonly string[]>>;
}

export interface RouteStatusSamples {
  recent: number;
  window: number;
}

/** `agent_status_view`（§5.3）：派发方实时计算，不落盘、不同步。 */
export interface AgentStatusView {
  v: 1;
  kind: 'agent_status_view';
  device: string;
  agent: string;
  online: boolean;
  inflight: number;
  capacity: number;
  recentSuccessRate?: number;
  lastLatencyMs?: number;
  samples?: RouteStatusSamples;
  asOf: number;
  ttlMs: number;
  computedBy: string;
}

/** 本机观察（最近成败/时延）；不落盘、不同步，只作为软排序输入。 */
export interface RouteObservation {
  device: string;
  agent: string;
  success: number;
  failure: number;
  recentSuccessRate?: number;
  lastLatencyMs?: number;
  samples?: RouteStatusSamples;
}

export interface RouteRejection {
  device: string;
  agent: string;
  code: RouteRejectionCode;
  detail?: string;
}

export interface RouteRanking {
  device: string;
  agent: string;
  /** 0..1 的展示分数；排序本身按 §7.3 的固定顺序（见 compareCandidates）。 */
  score: number;
  reasons: string[];
}

export interface RouteWhy {
  /** `ASSIGNED`/`NO_TARGET`；显式 policy 越权按契约 §7.5 使用 `POLICY_DENIED`。 */
  code: RouteDecisionCode;
  hardFilters: string[];
  ranking: RouteRanking[];
  tieBreak: typeof ROUTE_TIE_BREAK;
  roleCard: RouteRoleCardStatus;
  /** `inherited` = 本轮实际生效的 plan policy（root 或已衰减 sub-plan），不是额外授权源。 */
  policy: 'inherited';
}

export interface RouteDecision {
  decision: RouteDecisionOutcome;
  chosen: FleetEndpoint | null;
  why: RouteWhy;
  rejected: RouteRejection[];
  /** 供 materializer / task_status 显示的直接阻塞原因；assigned 时为空。 */
  blockedBy: string[];
}

export interface RouteInput {
  planId: string;
  version: number;
  stepId: string;
  intent?: string;
  /** 显式 assign；只考虑该目标。 */
  to?: FleetEndpoint;
  route?: PlanRoute;
  policy?: PlanPolicy;
  /** 已通过 P1 信任校验的卡片（调用方可传未过滤集合）。 */
  cards: readonly AgentCapabilityCard[];
  /** P5：已通过 author 绑定/schema 校验的角色卡；缺省 = 无卡。 */
  roleCards?: readonly AgentRoleCard[];
  /** P5：默认 shadow（只解释不排序）；显式 enabled 才允许最后一项软排序。 */
  roleCardMode?: RouteRoleCardMode;
  authorization: RouteAuthorization;
  status?: readonly AgentStatusView[];
  observations?: readonly RouteObservation[];
  /** 任务 namespace；与 payload 可达性检查共用。 */
  namespace?: string;
  /** 若存在，按任务域/显式 payloadNamespace 保守校验目标可读。 */
  payloadRef?: string;
  payloadNamespace?: string;
  capacity?: (device: string, agent: string) => number | undefined;
}

/** materializer / task_status 共用的本轮路由快照（全部为纯派生）。 */
export interface RouteContext {
  cards: AgentCapabilityCard[];
  roleCards: AgentRoleCard[];
  roleCardMode: RouteRoleCardMode;
  authorization: RouteAuthorization;
  status: AgentStatusView[];
  namespace?: string;
  cardCatalog: 'verified' | 'unavailable';
  authorizationAvailable: boolean;
}

export interface PlanRoutingProvider {
  cards(): Promise<readonly AgentCapabilityCard[]>;
  /** P5：只读角色卡（authored/schema 已验证）；缺省 = 无卡。 */
  roleCards?(): Promise<readonly AgentRoleCard[]> | readonly AgentRoleCard[];
  roleCardMode?: RouteRoleCardMode;
  authorized(): Promise<RouteAuthorization> | RouteAuthorization;
  online?(device: string): boolean;
  /**
   * P6：daemon 模式的在线集合来自守护内部 `/app/peers`（已认证在线 peer）。
   * 提供时优先于同步 `online` 回调；读取失败按空集 fail-closed。
   */
  onlineDevices?(): Promise<readonly string[]>;
  observations?(): Promise<readonly RouteObservation[]> | readonly RouteObservation[];
  namespace?: string;
  capacity?(device: string, agent: string): number | undefined;
}

interface Candidate {
  device: string;
  agent: string;
  card?: AgentCapabilityCard;
  status: AgentStatusView;
  capacity: number;
  inflight: number;
  successRate: number;
  successNeutral: boolean;
  latencyMs?: number;
  preferHits: string[];
  roleCard?: AgentRoleCard;
  roleCardScore?: number;
  roleCardReason?: string;
  rendezvous: string;
}

function keyOf(device: string, agent: string): string {
  return `${device}\u0000${agent}`;
}

function truncNonNegative(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.trunc(value));
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** 契约 §7.4：`SHA-256(planId#version#stepId + "\0" + device + "\0" + agent)`。 */
export function rendezvousScore(key: string, device: string, agent: string): string {
  return createHash('sha256').update(`${key}\u0000${device}\u0000${agent}`).digest('hex');
}

function hardFiltersFor(input: RouteInput): string[] {
  // `executable`/`health` 是 0.3.2 新增硬门槛：显式不可执行或显式 unavailable 直接拒绝。
  const filters = ['authorized', 'policy', 'executable', 'health', 'capability'];
  if (input.namespace !== undefined || input.payloadRef !== undefined) filters.push('payload');
  filters.push('online', 'capacity');
  return filters;
}

function rejection(
  candidate: { device: string; agent: string },
  code: RouteRejectionCode,
  detail?: string,
): RouteRejection {
  return {
    device: candidate.device,
    agent: candidate.agent,
    code,
    ...(detail !== undefined ? { detail } : {}),
  };
}

function authorizationRejection(input: RouteInput, target: FleetEndpoint): string | null {
  if (!input.authorization.devices.includes(target.device)) return 'device';
  const agents = input.authorization.agents?.[target.device];
  if (agents !== undefined && !agents.includes(target.agent)) return 'agent';
  return null;
}

function policyRejection(policy: PlanPolicy | undefined, target: FleetEndpoint): string | null {
  if (policy?.allowedDevices !== undefined && !policy.allowedDevices.includes(target.device)) return 'device';
  if (policy?.allowedAgents !== undefined && !policy.allowedAgents.includes(target.agent)) return 'agent';
  return null;
}

function payloadRejection(input: RouteInput, card: AgentCapabilityCard): string | null {
  if (input.namespace === undefined && input.payloadRef === undefined) return null;
  const namespaces = new Set(card.permissions.taskNamespaces);
  if (input.namespace !== undefined && !namespaces.has(input.namespace)) {
    return `namespace=${input.namespace}`;
  }
  // payloadRef 是 opaque 引用；没有显式 payloadNamespace 时，至少要求目标能读任务域。
  if (input.payloadRef !== undefined && input.payloadNamespace !== undefined && !namespaces.has(input.payloadNamespace)) {
    return `namespace=${input.payloadNamespace}`;
  }
  return null;
}

function cardFor(input: RouteInput, target: FleetEndpoint): AgentCapabilityCard | undefined {
  return activeCapabilityCards(latestCapabilityCards(input.cards))
    .find((card) => card.device === target.device && card.agent === target.agent);
}

function missingCapabilities(required: readonly string[] | undefined, card: AgentCapabilityCard): string[] {
  if (required === undefined) return [];
  const available = new Set(card.capabilities);
  return required.filter((tag) => !available.has(tag));
}

function supportsTaskIntake(card: AgentCapabilityCard): boolean {
  return card.tools.includes('task_submit');
}

function capacityOf(input: RouteInput, target: FleetEndpoint, card: AgentCapabilityCard): number {
  const override = input.capacity?.(target.device, target.agent);
  if (override !== undefined && Number.isFinite(override)) return Math.max(0, Math.trunc(override));
  const status = input.status?.find((view) => view.device === target.device && view.agent === target.agent);
  if (status !== undefined && Number.isFinite(status.capacity)) return Math.max(0, Math.trunc(status.capacity));
  const limit = card.limits.maxConcurrency;
  return limit !== undefined && Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : 1;
}

function statusFor(input: RouteInput, target: FleetEndpoint, card: AgentCapabilityCard): AgentStatusView {
  const explicit = input.status?.find((view) => view.device === target.device && view.agent === target.agent);
  if (explicit !== undefined) return explicit;
  const observation = input.observations?.find((entry) => entry.device === target.device && entry.agent === target.agent);
  return {
    v: 1,
    kind: 'agent_status_view',
    device: target.device,
    agent: target.agent,
    online: false,
    inflight: 0,
    capacity: capacityOf(input, target, card),
    ...(observation?.recentSuccessRate !== undefined ? { recentSuccessRate: observation.recentSuccessRate } : {}),
    ...(observation?.lastLatencyMs !== undefined ? { lastLatencyMs: observation.lastLatencyMs } : {}),
    ...(observation?.samples !== undefined ? { samples: observation.samples } : {}),
    asOf: 0,
    ttlMs: ROUTE_STATUS_TTL_MS,
    computedBy: '',
  };
}

function candidateFrom(input: RouteInput, target: FleetEndpoint, card: AgentCapabilityCard): Candidate {
  const status = statusFor(input, target, card);
  const capacity = capacityOf(input, target, card);
  const prefer = input.route?.prefer ?? [];
  const available = new Set(card.capabilities);
  const preferHits = prefer.filter((tag) => available.has(tag));
  const sampleCount = status.samples?.recent ?? 0;
  const hasRate = status.recentSuccessRate !== undefined && Number.isFinite(status.recentSuccessRate) && sampleCount >= ROUTE_MIN_SUCCESS_SAMPLES;
  const roleCard = roleCardForTarget(input.roleCards ?? [], target.device, target.agent);
  const roleCardEnabled = input.roleCardMode === 'enabled';
  const roleCardEligible = roleCard !== null && roleCardEnabled && roleCardSortEligible(roleCard);
  return {
    device: target.device,
    agent: target.agent,
    card,
    status,
    capacity,
    inflight: truncNonNegative(status.inflight, 0),
    successRate: hasRate ? Math.max(0, Math.min(1, status.recentSuccessRate!)) : 0.5,
    successNeutral: !hasRate,
    ...(status.lastLatencyMs !== undefined && Number.isFinite(status.lastLatencyMs) && status.lastLatencyMs >= 0
      ? { latencyMs: Math.trunc(status.lastLatencyMs) }
      : {}),
    preferHits,
    ...(roleCard !== null ? {
      roleCard,
      ...(roleCardEligible
        ? { roleCardScore: roleCardScore(roleCard, input.intent), roleCardReason: 'used-soft' }
        : { roleCardReason: roleCardEnabled ? 'ineligible' : 'shadow-ignored' }),
    } : {}),
    rendezvous: rendezvousScore(`${input.planId}#${input.version}#${input.stepId}`, target.device, target.agent),
  };
}

function ranked(candidate: Candidate): RouteRanking {
  const loadRatio = candidate.capacity === 0 ? 1 : Math.min(1, candidate.inflight / candidate.capacity);
  const loadScore = 1 - loadRatio;
  const latencyScore = candidate.latencyMs === undefined ? 0 : 1 / (1 + candidate.latencyMs / 1_000);
  const preferScore = candidate.preferHits.length === 0
    ? 0
    : candidate.preferHits.length / Math.max(1, (candidate.card?.capabilities.length ?? 0));
  const score = 0.4 * loadScore + 0.3 * candidate.successRate + 0.2 * latencyScore + 0.1 * preferScore;
  const reasons = [
    'online',
    `inflight=${candidate.inflight}/${candidate.capacity}`,
    candidate.successNeutral ? 'success=neutral' : `success=${round4(candidate.successRate)}`,
    candidate.latencyMs === undefined ? 'latency=none' : `latency=${candidate.latencyMs}`,
    ...candidate.preferHits.map((tag) => `prefer=${tag}`),
    ...(candidate.roleCardReason === undefined
      ? []
      : candidate.roleCardScore !== undefined
        ? [`role=used-soft:${round4(candidate.roleCardScore)}`]
        : [`role=${candidate.roleCardReason}`]),
  ];
  return {
    device: candidate.device,
    agent: candidate.agent,
    score: round4(score),
    reasons,
  };
}

/** §7.3 固定顺序：在线 → 负载比 ↑ → 成功率 ↓ → 时延 ↑ → prefer 命中 ↓ → 角色卡 ↓ → rendezvous。 */
function compareCandidates(a: Candidate, b: Candidate): number {
  if (a.status.online !== b.status.online) return a.status.online ? -1 : 1;
  const loadA = a.capacity === 0 ? Number.POSITIVE_INFINITY : a.inflight / a.capacity;
  const loadB = b.capacity === 0 ? Number.POSITIVE_INFINITY : b.inflight / b.capacity;
  if (loadA !== loadB) return loadA - loadB;
  if (a.successRate !== b.successRate) return b.successRate - a.successRate;
  const latA = a.latencyMs ?? Number.POSITIVE_INFINITY;
  const latB = b.latencyMs ?? Number.POSITIVE_INFINITY;
  if (latA !== latB) return latA - latB;
  if (a.preferHits.length !== b.preferHits.length) return b.preferHits.length - a.preferHits.length;
  // P5：仅显式启用、shadow=false、confidence>=0.5 的卡进入最后一项软排序。
  const roleA = a.roleCardScore ?? 0;
  const roleB = b.roleCardScore ?? 0;
  if (roleA !== roleB) return roleB - roleA;
  if (a.rendezvous !== b.rendezvous) return a.rendezvous < b.rendezvous ? 1 : -1;
  if (a.device !== b.device) return a.device < b.device ? -1 : 1;
  return a.agent < b.agent ? -1 : a.agent > b.agent ? 1 : 0;
}

function roleCardStatus(input: RouteInput, survivors: readonly Candidate[]): RouteRoleCardStatus {
  const cards = activeAgentRoleCards(latestAgentRoleCards(input.roleCards ?? []));
  if (cards.length === 0) return ROUTE_ROLE_CARD_DISABLED;
  if (input.roleCardMode === 'enabled') {
    return survivors.some((candidate) => candidate.roleCardScore !== undefined)
      ? ROUTE_ROLE_CARD_USED
      : ROUTE_ROLE_CARD_DISABLED;
  }
  return ROUTE_ROLE_CARD_SHADOW;
}

function blockedCode(rejected: readonly RouteRejection[], explicit: boolean): string[] {
  if (rejected.length === 0) return ['NO_TARGET'];
  const codes = [...new Set(rejected.map((entry) => entry.code))];
  if (codes.length === 1) return [codes[0]!];
  if (explicit) return [codes[0]!];
  return ['NO_TARGET'];
}

/**
 * 解析 route（纯函数）。显式 `to` 只考虑该目标；自动路由从授权 peer + 能力卡目录取候选。
 * 无候选返回 NO_TARGET；显式目标被 policy 拒绝返回 POLICY_DENIED；从不改派。
 */
export function resolveRoute(input: RouteInput): RouteDecision {
  const policy = input.policy;
  const hardFilters = hardFiltersFor(input);
  const rejected: RouteRejection[] = [];
  const survivors: Candidate[] = [];

  const consider = (target: FleetEndpoint): void => {
    const unauthorized = authorizationRejection(input, target);
    if (unauthorized !== null) {
      rejected.push(rejection(target, 'UNAUTHORIZED', unauthorized));
      return;
    }
    const denied = policyRejection(policy, target);
    if (denied !== null) {
      rejected.push(rejection(target, 'POLICY_DENIED', denied));
      return;
    }
    const card = cardFor(input, target);
    if (card === undefined) {
      rejected.push(rejection(target, 'MISSING_CAPABILITY', 'card'));
      return;
    }
    // 旧卡缺 executable/health 字段 = 兼容（不当作 false 或 unavailable）。
    if (card.executable === false) {
      rejected.push(rejection(target, 'ADAPTER_UNAVAILABLE', 'executable=false'));
      return;
    }
    // 只有显式 unavailable 才硬拒绝；degraded/未知不拒绝（advisory）。
    if (card.health?.status === 'unavailable') {
      rejected.push(rejection(target, 'ADAPTER_UNAVAILABLE', 'health=unavailable'));
      return;
    }
    const policyMissing = missingCapabilities(policy?.requireCapabilities, card);
    if (policyMissing.length > 0) {
      rejected.push(rejection(target, 'POLICY_DENIED', `requireCapabilities=${policyMissing.join(',')}`));
      return;
    }
    if (!supportsTaskIntake(card)) {
      rejected.push(rejection(target, 'MISSING_CAPABILITY', 'task_submit'));
      return;
    }
    const routeMissing = missingCapabilities(input.route?.require, card);
    if (routeMissing.length > 0) {
      rejected.push(rejection(target, 'MISSING_CAPABILITY', routeMissing.join(',')));
      return;
    }
    const unreachable = payloadRejection(input, card);
    if (unreachable !== null) {
      rejected.push(rejection(target, 'PAYLOAD_UNREACHABLE', unreachable));
      return;
    }
    const status = statusFor(input, target, card);
    if (!status.online) {
      rejected.push(rejection(target, input.to !== undefined ? 'EXPLICIT_OFFLINE' : 'OFFLINE'));
      return;
    }
    const capacity = capacityOf(input, target, card);
    const inflight = truncNonNegative(status.inflight, 0);
    if (capacity === 0 || inflight >= capacity) {
      rejected.push(rejection(target, 'AT_CAPACITY', `capacity=${capacity}`));
      return;
    }
    survivors.push(candidateFrom(input, target, card));
  };

  if (input.to !== undefined) {
    consider({ device: input.to.device, agent: input.to.agent });
  } else {
    const candidates = activeCapabilityCards(latestCapabilityCards(input.cards))
      .filter((card) => input.authorization.devices.includes(card.device))
      .filter((card) => {
        const agents = input.authorization.agents?.[card.device];
        return agents === undefined || agents.includes(card.agent);
      });
    if (candidates.length === 0) {
      rejected.push({ device: '', agent: '', code: 'NO_CANDIDATES', detail: 'no-authorized-capability-cards' });
    } else {
      for (const card of candidates) consider({ device: card.device, agent: card.agent });
    }
  }

  survivors.sort(compareCandidates);
  const ranking = survivors.map(ranked);
  const roleCard = roleCardStatus(input, survivors);
  const chosenCandidate = survivors[0];
  if (chosenCandidate !== undefined) {
    return {
      decision: 'assigned',
      chosen: { device: chosenCandidate.device, agent: chosenCandidate.agent },
      why: {
        code: 'ASSIGNED',
        hardFilters,
        ranking,
        tieBreak: ROUTE_TIE_BREAK,
        roleCard,
        policy: 'inherited',
      },
      rejected,
      blockedBy: [],
    };
  }

  const explicitPolicyDenied = input.to !== undefined
    && rejected.some((entry) => entry.code === 'POLICY_DENIED');
  return {
    decision: explicitPolicyDenied ? 'POLICY_DENIED' : 'NO_TARGET',
    chosen: null,
    why: {
      code: explicitPolicyDenied ? 'POLICY_DENIED' : 'NO_TARGET',
      hardFilters,
      ranking: [],
      tieBreak: ROUTE_TIE_BREAK,
      roleCard,
      policy: 'inherited',
    },
    rejected,
    blockedBy: blockedCode(rejected, input.to !== undefined),
  };
}

/** 便捷入口：从 plan + step 读取 `to`/`route`，其余上下文由调用方提供。 */
export function resolvePlanStepRoute(
  plan: Pick<TaskPlan, 'planId' | 'version' | 'policy'>,
  step: PlanStep,
  context: Omit<RouteInput, 'planId' | 'version' | 'stepId' | 'to' | 'route' | 'intent' | 'policy'>,
): RouteDecision {
  return resolveRoute({
    ...context,
    planId: plan.planId,
    version: plan.version,
    stepId: step.stepId,
    intent: step.intent,
    policy: plan.policy,
    ...(step.to !== undefined ? { to: step.to } : {}),
    ...(step.route !== undefined ? { route: step.route } : {}),
  });
}

export interface RoleCardShadowReport {
  planId: string;
  version: number;
  stepId: string;
  intent?: string;
  shadow: {
    decision: RouteDecision['decision'];
    chosen: FleetEndpoint | null;
    roleCard: RouteRoleCardStatus;
  };
  enabled: {
    decision: RouteDecision['decision'];
    chosen: FleetEndpoint | null;
    roleCard: RouteRoleCardStatus;
  };
  changed: boolean;
  /** 硬过滤/拒绝集合完全一致（角色卡永不影响授权/能力/容量/policy）。 */
  hardFiltersEqual: boolean;
  eligible: Array<{ device: string; agent: string; confidence: number; score: number }>;
  ignored: Array<{ device: string; agent: string; reason: 'shadow' | 'low-confidence' | 'tombstone' }>;
}

/**
 * P5 shadow 对比报告：同一批候选分别按 shadow/enabled 解析，输出 chosen 变化与资格解释。
 * 只用于内部测试/证据；不写存储、不进入 UI/SSE，也不包含摘要原文。
 */
export function buildRoleCardShadowReport(input: RouteInput): RoleCardShadowReport {
  const shadow = resolveRoute({ ...input, roleCardMode: 'shadow' });
  const enabled = resolveRoute({ ...input, roleCardMode: 'enabled' });
  const hardFiltersEqual = shadow.decision === enabled.decision
    && canonicalShadowRejections(shadow.rejected) === canonicalShadowRejections(enabled.rejected);
  const latest = latestAgentRoleCards(input.roleCards ?? []);
  const eligible: RoleCardShadowReport['eligible'] = [];
  const ignored: RoleCardShadowReport['ignored'] = [];
  for (const card of latest) {
    if (card.tombstone === true) {
      ignored.push({ device: card.device, agent: card.agent, reason: 'tombstone' });
    } else if (card.shadow !== false) {
      ignored.push({ device: card.device, agent: card.agent, reason: 'shadow' });
    } else if (card.confidence < ROLE_CARD_DEFAULT_CONFIDENCE_THRESHOLD) {
      ignored.push({ device: card.device, agent: card.agent, reason: 'low-confidence' });
    } else {
      eligible.push({
        device: card.device,
        agent: card.agent,
        confidence: card.confidence,
        score: roleCardScore(card, input.intent),
      });
    }
  }
  return {
    planId: input.planId,
    version: input.version,
    stepId: input.stepId,
    ...(input.intent !== undefined ? { intent: input.intent } : {}),
    shadow: {
      decision: shadow.decision,
      chosen: shadow.chosen,
      roleCard: shadow.why.roleCard,
    },
    enabled: {
      decision: enabled.decision,
      chosen: enabled.chosen,
      roleCard: enabled.why.roleCard,
    },
    changed: !sameEndpoint(shadow.chosen, enabled.chosen),
    hardFiltersEqual,
    eligible,
    ignored,
  };
}

function sameEndpoint(a: FleetEndpoint | null, b: FleetEndpoint | null): boolean {
  if (a === null || b === null) return a === b;
  return a.device === b.device && a.agent === b.agent;
}

function canonicalShadowRejections(rejected: readonly RouteRejection[]): string {
  return [...rejected]
    .map((entry) => `${entry.device}\u0000${entry.agent}\u0000${entry.code}\u0000${entry.detail ?? ''}`)
    .sort()
    .join('|');
}

/** 状态视图 + 本机观察合成为排序输入（不落盘、不同步）。 */
export function buildAgentStatusViews(options: {
  cards: readonly AgentCapabilityCard[];
  online: (device: string) => boolean;
  inflight: (device: string, agent: string) => number;
  observations?: readonly RouteObservation[];
  capacity?: (device: string, agent: string) => number | undefined;
  asOf: number;
  ttlMs?: number;
  computedBy: string;
}): AgentStatusView[] {
  const byTarget = new Map((options.observations ?? []).map((entry) => [keyOf(entry.device, entry.agent), entry]));
  const ttlMs = options.ttlMs ?? ROUTE_STATUS_TTL_MS;
  return activeCapabilityCards(latestCapabilityCards(options.cards)).map((card) => {
    const observation = byTarget.get(keyOf(card.device, card.agent));
    const capacity = options.capacity?.(card.device, card.agent)
      ?? (Number.isFinite(card.limits.maxConcurrency) ? Math.max(0, Math.trunc(card.limits.maxConcurrency!)) : 1);
    return {
      v: 1 as const,
      kind: 'agent_status_view' as const,
      device: card.device,
      agent: card.agent,
      online: options.online(card.device),
      inflight: truncNonNegative(options.inflight(card.device, card.agent), 0),
      capacity,
      ...(observation?.recentSuccessRate !== undefined ? { recentSuccessRate: observation.recentSuccessRate } : {}),
      ...(observation?.lastLatencyMs !== undefined ? { lastLatencyMs: observation.lastLatencyMs } : {}),
      ...(observation?.samples !== undefined ? { samples: observation.samples } : {}),
      asOf: options.asOf,
      ttlMs,
      computedBy: options.computedBy,
    };
  }).sort((a, b) =>
    a.device < b.device ? -1 : a.device > b.device ? 1 : a.agent < b.agent ? -1 : a.agent > b.agent ? 1 : 0);
}

interface TerminalObservation {
  device: string;
  agent: string;
  taskId: string;
  success: boolean;
  latencyMs?: number;
  at: number;
}

/**
 * 从本机事件派生最近成败/时延（只读、不落盘）。
 * 只统计已有 `created` + 终态事件的任务；`at` 仅用于本机观察窗口排序。
 */
export function observeRouteOutcomes(
  events: readonly TaskEvent[],
  options: { window?: number } = {},
): RouteObservation[] {
  const window = Math.max(1, Math.trunc(options.window ?? ROUTE_OBSERVATION_WINDOW));
  const byTask = new Map<string, TaskEvent[]>();
  for (const event of events) {
    const list = byTask.get(event.taskId);
    if (list) list.push(event);
    else byTask.set(event.taskId, [event]);
  }
  const terminal: TerminalObservation[] = [];
  for (const [taskId, taskEvents] of byTask) {
    const state = reduceTaskEvents(taskEvents);
    if (state === null || !state.terminal) continue;
    if (state.to.device.length === 0 || state.to.device.startsWith('__')) continue;
    const created = [...taskEvents]
      .filter((event) => event.type === 'created')
      .sort((a, b) => (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0))[0];
    const terminalEvent = taskEvents.find((event) => event.eventId === state.lastEventId);
    if (created === undefined || terminalEvent === undefined) continue;
    const latency = terminalEvent.at - created.at;
    terminal.push({
      device: state.to.device,
      agent: state.to.agent,
      taskId,
      success: state.status === 'done',
      ...(state.status === 'done' && Number.isFinite(latency) && latency >= 0 ? { latencyMs: Math.trunc(latency) } : {}),
      at: Number.isFinite(terminalEvent.at) ? terminalEvent.at : 0,
    });
  }
  terminal.sort((a, b) => {
    if (a.at !== b.at) return b.at - a.at;
    if (a.taskId !== b.taskId) return a.taskId < b.taskId ? -1 : 1;
    return a.device < b.device ? -1 : a.device > b.device ? 1 : a.agent < b.agent ? -1 : a.agent > b.agent ? 1 : 0;
  });
  const recent = terminal.slice(0, window);
  const byTarget = new Map<string, RouteObservation>();
  for (const entry of recent) {
    const key = keyOf(entry.device, entry.agent);
    const current = byTarget.get(key) ?? {
      device: entry.device,
      agent: entry.agent,
      success: 0,
      failure: 0,
      samples: { recent: 0, window },
    };
    if (entry.success) current.success += 1;
    else current.failure += 1;
    current.samples = { recent: current.success + current.failure, window };
    if (entry.success && entry.latencyMs !== undefined && current.lastLatencyMs === undefined) {
      // recent 已按时间倒序；第一条成功即最近成功。
      current.lastLatencyMs = entry.latencyMs;
    }
    byTarget.set(key, current);
  }
  const out: RouteObservation[] = [];
  for (const entry of byTarget.values()) {
    const samples = entry.samples?.recent ?? 0;
    out.push({
      ...entry,
      ...(samples >= ROUTE_MIN_SUCCESS_SAMPLES
        ? { recentSuccessRate: round4(entry.success / samples) }
        : {}),
    });
  }
  return out.sort((a, b) =>
    a.device < b.device ? -1 : a.device > b.device ? 1 : a.agent < b.agent ? -1 : a.agent > b.agent ? 1 : 0);
}

/** 读取一次路由快照；任何 provider 失败都 fail-closed（空卡片/空授权），不伪造候选。 */
export async function loadRouteContext(
  provider: PlanRoutingProvider,
  options: {
    states: readonly TaskState[];
    events: readonly TaskEvent[];
    asOf: number;
    computedBy: string;
    window?: number;
  },
): Promise<RouteContext> {
  let cards: AgentCapabilityCard[] = [];
  let cardCatalog: RouteContext['cardCatalog'] = 'unavailable';
  try {
    cards = activeCapabilityCards(latestCapabilityCards(await provider.cards()));
    cardCatalog = 'verified';
  } catch {
    cards = [];
    cardCatalog = 'unavailable';
  }
  let roleCards: AgentRoleCard[] = [];
  try {
    roleCards = activeAgentRoleCards(latestAgentRoleCards(await (provider.roleCards?.() ?? [])));
  } catch {
    // 角色卡读取失败 → 无卡（不伪造、不影响 P3 能力卡/授权/状态路径）。
    roleCards = [];
  }
  const roleCardMode: RouteRoleCardMode = provider.roleCardMode ?? 'shadow';
  let authorization: RouteAuthorization = { devices: [] };
  let authorizationAvailable = false;
  try {
    const loaded = await provider.authorized();
    authorization = {
      devices: [...new Set(loaded.devices)],
      ...(loaded.agents !== undefined
        ? { agents: Object.fromEntries(Object.entries(loaded.agents).map(([device, agents]) => [device, [...new Set(agents)]])) }
        : {}),
    };
    authorizationAvailable = true;
  } catch {
    authorization = { devices: [] };
    authorizationAvailable = false;
  }
  let observations: readonly RouteObservation[] = [];
  try {
    observations = provider.observations !== undefined
      ? await provider.observations()
      : observeRouteOutcomes(options.events, { window: options.window });
  } catch {
    observations = [];
  }
  const inflight = new Map<string, number>();
  for (const state of options.states) {
    if (state.terminal) continue;
    const key = keyOf(state.to.device, state.to.agent);
    inflight.set(key, (inflight.get(key) ?? 0) + 1);
  }
  // 非阻塞硬化：provider 的 online/capacity 是外部回调；任何异常都按 fail-closed 处理，
  // 不让单个坏回调打断整轮 materializer tick。
  let onlineDevices: ReadonlySet<string> | undefined;
  try {
    const loaded = await provider.onlineDevices?.();
    if (loaded !== undefined) onlineDevices = new Set(loaded);
  } catch {
    onlineDevices = new Set();
  }
  const safeOnline = (device: string): boolean => {
    try {
      if (onlineDevices !== undefined) return onlineDevices.has(device);
      return provider.online?.(device) ?? false;
    } catch {
      return false;
    }
  };
  const capacityOverride = provider.capacity;
  const safeCapacity = capacityOverride === undefined
    ? undefined
    : (device: string, agent: string): number | undefined => {
      try {
        return capacityOverride(device, agent);
      } catch {
        return undefined;
      }
    };
  let status: AgentStatusView[] = [];
  try {
    status = buildAgentStatusViews({
      cards,
      online: safeOnline,
      inflight: (device, agent) => inflight.get(keyOf(device, agent)) ?? 0,
      observations,
      ...(safeCapacity !== undefined ? { capacity: safeCapacity } : {}),
      asOf: options.asOf,
      computedBy: options.computedBy,
    });
  } catch {
    status = [];
  }
  return {
    cards,
    roleCards,
    roleCardMode,
    authorization,
    status,
    ...(provider.namespace !== undefined ? { namespace: provider.namespace } : {}),
    cardCatalog,
    authorizationAvailable,
  };
}

/** 从 RouteContext 构造 resolver 输入（不含 plan/step 字段）。 */
export function routeInputFromContext(
  context: RouteContext,
): Pick<RouteInput, 'cards' | 'roleCards' | 'roleCardMode' | 'authorization' | 'status' | 'namespace'> {
  return {
    cards: context.cards,
    roleCards: context.roleCards,
    roleCardMode: context.roleCardMode,
    authorization: context.authorization,
    status: context.status,
    ...(context.namespace !== undefined ? { namespace: context.namespace } : {}),
  };
}
