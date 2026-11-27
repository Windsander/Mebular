// 0.4.0 W3 host plan 信封与校验。
//
// 契约（docs/design/0.4.0-w0-contract.md §4 + docs/design/0.4.0-w0-host-feasibility.md）：
// - /context 只消费宿主在上一 turn 之后预取的 plan；本模块从不调用宿主模型。
// - TTL ≤ 60s；cue 主题/实体 Jaccard ≥ 0.6；当前 top-1 候选必须在 basis top-3。
// - follow_up / task_continue / correction 豁免主题 Jaccard；候选与绑定不豁免。
// - planId 进程内单次消费；重复/重放 → host_plan_replayed。
// - 只接受 host-model；确定性启发式不能冒充 source=host。
// - 只传 hash/枚举/统计，不保存 raw query、detail 正文、token。
//
// 本模块是纯函数 + 进程内小表；不读文件、不写 trace、不打开图。

import { createHash } from 'node:crypto';
import type { Cue } from './cue.js';
import type { InterventionCandidateView } from './intervention.js';

export const HOST_PLAN_SCHEMA = 1;
export const HOST_PLAN_MAX_BYTES = 4096;
export const HOST_PLAN_TTL_MS = 60_000;
export const HOST_PLAN_CLOCK_SKEW_MS = 5_000;
export const HOST_PLAN_CUE_JACCARD = 0.6;
export const HOST_PLAN_CANDIDATE_TOP_N = 3;

export const HOST_APPS = ['opencode', 'openchamber', 'dsh', 'hermes'] as const;
export type HostApp = (typeof HOST_APPS)[number];

export const HOST_PLAN_ACTIONS = ['speak', 'defer', 'silent'] as const;
export type HostPlanAction = (typeof HOST_PLAN_ACTIONS)[number];

export const HOST_PLAN_DEPTHS = ['gist', 'detail', 'quote'] as const;
export type HostPlanDepth = (typeof HOST_PLAN_DEPTHS)[number];

export const HOST_PLAN_REASON_CODES = [
  'task_continuation',
  'explicit_memory_request',
  'correction_follow_up',
  'low_relevance',
  'duplicate_context',
  'chitchat',
  'budget_pressure',
  'session_start',
  'unknown',
  // W0-B 兼容枚举：同样是稳定值，不含 freeform。
  'high_relevance',
  'low_confidence',
  'no_candidates',
  'broad_cue',
  'no_novelty',
  'recent_false_alarm',
  'task_continue',
  'after_silence',
  'user_requested_detail',
  'user_requested_quote',
  'budget',
  'planner_timeout',
  'planner_unavailable',
  'planner_invalid_output',
  'first_turn',
  'cue_changed',
  'candidates_changed',
] as const;
export type HostPlanReasonCode = (typeof HOST_PLAN_REASON_CODES)[number];

const HOST_PLAN_REASON_SET = new Set<string>(HOST_PLAN_REASON_CODES);
const HOST_PLAN_ACTION_SET = new Set<string>(HOST_PLAN_ACTIONS);
const HOST_PLAN_DEPTH_SET = new Set<string>(HOST_PLAN_DEPTHS);
const HOST_APP_SET = new Set<string>(HOST_APPS);

export type HostPlanRejectionReason =
  | 'host_plan_missing'
  | 'host_plan_invalid'
  | 'host_plan_expired'
  | 'host_plan_scope_mismatch'
  | 'host_plan_cue_mismatch'
  | 'host_plan_candidates_changed'
  | 'host_plan_replayed'
  | 'host_plan_not_model';

export interface HostInterventionPlan {
  schema: 1;
  planId: string;
  host: HostApp;
  hostInstanceId: string;
  agentId: string;
  threadId: string;
  scope: 'session' | 'turn';
  basedOnTurnId: string;
  forTurnId?: string;
  cueSignature?: string;
  cueFingerprint: string[];
  basisCandidateFingerprint: string[];
  createdAt: number;
  expiresAt: number;
  action: HostPlanAction;
  depth: HostPlanDepth;
  confidence: number;
  reasonCode: HostPlanReasonCode;
  plannerKind: 'host-model' | 'host-adapter-deterministic';
  plannerVersion?: string;
  policyVersion?: string;
}

export interface HostPlanValidationInput {
  now: number;
  agentId: string;
  threadId: string | null;
  turnId: string | null;
  previousTurnId: string | null;
  /** sidecar 自己记录的上一轮 /context turnId；用于拒绝 adapter 自报 basis。 */
  lastContextTurnId: string | null;
  hostApp: string | null;
  currentCue: Cue;
  currentCandidateFingerprint: string[];
}

export interface HostPlanValidationOk {
  ok: true;
  plan: HostInterventionPlan;
  cueMatched: boolean;
  cueJaccard: number;
}

export interface HostPlanValidationError {
  ok: false;
  reason: HostPlanRejectionReason;
  warning: string;
}

export type HostPlanValidationResult = HostPlanValidationOk | HostPlanValidationError;

function reject(reason: HostPlanRejectionReason, warning: string): HostPlanValidationError {
  return { ok: false, reason, warning };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, max = 200): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return null;
  return trimmed;
}

function stringArray(value: unknown, max: number): string[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length > max) return null;
  const out: string[] = [];
  for (const entry of value) {
    const item = text(entry, 128);
    if (item === null) return null;
    out.push(item);
  }
  return out;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 16);
}

const TOKEN_STOPWORDS = new Set([
  'the', 'and', 'for', 'you', 'your', 'with', 'this', 'that', 'what', 'when', 'where',
  'which', 'how', 'why', 'can', 'could', 'would', 'should', 'please', 'about', 'from',
  'have', 'has', 'had', 'are', 'was', 'were', 'will', 'just', 'now', 'again', 'last',
  'time', 'remember', 'did', 'say', 'said', 'not', 'but', 'our', 'its', 'all', 'any',
  'one', 'two', 'use', 'using', 'make', 'need', 'want', 'let', 'get', 'got', 'also',
  'then', 'than', 'them', 'they', 'she', 'him', 'her', 'his', 'out', 'into', 'over',
  'under', 'more', 'most', 'some', 'such', 'only', 'own', 'same', 'too', 'very', 'add',
  'set', 'new', 'old',
]);

/**
 * 把 cue 归一化成稳定 token hash 集合；返回排序后的短 hash，不含原文。
 * 中文按相邻 bigram，英文/数字按词；单字中文保留单字。
 */
export function cueTokenHashes(cue: Pick<Cue, 'normalizedQuery' | 'topics' | 'entities'>): string[] {
  const source = [
    cue.normalizedQuery ?? '',
    ...(cue.topics ?? []),
    ...(cue.entities ?? []).map((entity) => entity.name),
  ].join('\n').normalize('NFKC').toLowerCase();

  const tokens = new Set<string>();
  for (const word of source.match(/[a-z0-9]+/g) ?? []) {
    if (word.length < 2 || TOKEN_STOPWORDS.has(word)) continue;
    tokens.add(word);
  }
  for (const run of source.match(/[\u3400-\u9fff]+/g) ?? []) {
    if (run.length === 1) {
      tokens.add(run);
      continue;
    }
    for (let index = 0; index + 1 < run.length; index += 1) {
      tokens.add(run.slice(index, index + 2));
    }
  }
  return [...tokens]
    .map(hashToken)
    .sort()
    .slice(0, 32);
}

export function cueSignatureOf(cueFingerprint: readonly string[]): string {
  return `sha256:${createHash('sha256').update([...cueFingerprint].sort().join('\n'), 'utf8').digest('hex')}`;
}

/**
 * 候选指纹只含稳定 candidateKey 的 hash；不含 gist/正文。
 * fragmentId 是每次召回随机的 mf_*，不能跨 turn 比较；必须优先用 sourceIds[0]
 * 这类稳定记录 ID（由 sidecar 内部提供 candidateKey）。
 */
export function candidateFingerprintOf(
  candidates: ReadonlyArray<
    InterventionCandidateView
    | { fragmentId: string; candidateKey?: string }
  >,
): string[] {
  return candidates
    .slice(0, HOST_PLAN_CANDIDATE_TOP_N)
    .map((candidate) => hashToken(candidate.candidateKey ?? candidate.fragmentId))
    .sort();
}

/** 当前 top-1 的 hash 必须在 basis top-3 内；调用方保证 candidates 已按相关度排序。 */
export function candidateMatchesBasis(
  current: readonly string[],
  basis: readonly string[],
): boolean {
  if (current.length === 0 || basis.length === 0) return false;
  const top = current[0];
  if (top === undefined) return false;
  return basis.includes(top);
}

export function jaccard(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const a = new Set(left);
  const b = new Set(right);
  let intersection = 0;
  for (const value of a) {
    if (b.has(value)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** follow_up / task_continue / correction 豁免主题 Jaccard，但仍要求 basis turn 绑定。 */
export function cueJaccardExempt(cue: Cue): boolean {
  const reasons = cue.detailIntent?.reasons ?? [];
  return Boolean(cue.followUpRef)
    || reasons.includes('follow_up')
    || reasons.includes('task_continue')
    || reasons.includes('conflict');
}

export function parseHostPlan(raw: unknown): HostInterventionPlan | null {
  if (!isObject(raw)) return null;
  let serialized = '';
  try {
    serialized = JSON.stringify(raw);
  } catch {
    return null;
  }
  if (serialized.length === 0 || Buffer.byteLength(serialized, 'utf8') > HOST_PLAN_MAX_BYTES) {
    return null;
  }
  if (raw.schema !== HOST_PLAN_SCHEMA) return null;

  const planId = text(raw.planId, 128);
  const host = text(raw.host, 32);
  const hostInstanceId = text(raw.hostInstanceId, 128);
  const agentId = text(raw.agentId, 64);
  const threadId = text(raw.threadId, 128);
  const scope = raw.scope === 'turn' ? 'turn' : raw.scope === 'session' ? 'session' : null;
  const basedOnTurnId = text(raw.basedOnTurnId, 200);
  const forTurnId = raw.forTurnId === undefined ? undefined : text(raw.forTurnId, 200);
  const cueSignature = raw.cueSignature === undefined ? undefined : text(raw.cueSignature, 200);
  const cueFingerprint = stringArray(raw.cueFingerprint ?? raw.basisCueFingerprint, 32);
  const basisCandidateFingerprint = stringArray(
    raw.basisCandidateFingerprint ?? raw.candidateFingerprint,
    HOST_PLAN_CANDIDATE_TOP_N,
  );
  const action = text(raw.action, 16);
  const depth = text(raw.depth, 16);
  const reasonCode = text(raw.reasonCode, 64);
  const plannerKind = raw.plannerKind === 'host-adapter-deterministic'
    ? 'host-adapter-deterministic'
    : raw.plannerKind === 'host-model' ? 'host-model' : null;

  if (!planId || !/^hp_[A-Za-z0-9._:-]{1,124}$/.test(planId)) return null;
  if (!host || !HOST_APP_SET.has(host)) return null;
  if (!hostInstanceId || !agentId || !threadId || !scope || !basedOnTurnId) return null;
  if (scope === 'turn' && !forTurnId) return null;
  if (!cueFingerprint || cueFingerprint.length === 0) return null;
  if (!basisCandidateFingerprint) return null;
  if (!action || !HOST_PLAN_ACTION_SET.has(action)) return null;
  if (!depth || !HOST_PLAN_DEPTH_SET.has(depth)) return null;
  if (!reasonCode || !HOST_PLAN_REASON_SET.has(reasonCode)) return null;
  if (!plannerKind) return null;

  const createdAt = raw.createdAt;
  const expiresAt = raw.expiresAt;
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return null;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return null;
  if (expiresAt <= createdAt || expiresAt - createdAt > HOST_PLAN_TTL_MS) return null;

  const confidence = raw.confidence;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return null;
  }

  const plannerVersion = raw.plannerVersion === undefined ? undefined : text(raw.plannerVersion, 128);
  const policyVersion = raw.policyVersion === undefined ? undefined : text(raw.policyVersion, 64);
  if (raw.plannerVersion !== undefined && plannerVersion === null) return null;
  if (raw.policyVersion !== undefined && policyVersion === null) return null;

  return {
    schema: 1,
    planId,
    host: host as HostApp,
    hostInstanceId,
    agentId,
    threadId,
    scope,
    basedOnTurnId,
    ...(forTurnId ? { forTurnId } : {}),
    ...(cueSignature ? { cueSignature } : {}),
    cueFingerprint,
    basisCandidateFingerprint,
    createdAt,
    expiresAt,
    action: action as HostPlanAction,
    depth: depth as HostPlanDepth,
    confidence,
    reasonCode: reasonCode as HostPlanReasonCode,
    plannerKind,
    ...(plannerVersion ? { plannerVersion } : {}),
    ...(policyVersion ? { policyVersion } : {}),
  };
}

/**
 * 全量 freshness 校验。调用方在收到 planId 时先做单次消费检查，再调用本函数；
 * 本函数只做结构与绑定/cue/候选校验，不修改任何状态。
 */
export function validateHostPlan(
  raw: unknown,
  input: HostPlanValidationInput,
): HostPlanValidationResult {
  const plan = parseHostPlan(raw);
  if (!plan) return reject('host_plan_invalid', 'host_plan_invalid');

  if (plan.createdAt > input.now + HOST_PLAN_CLOCK_SKEW_MS) {
    return reject('host_plan_invalid', 'host_plan_clock_skew');
  }
  if (plan.expiresAt <= input.now) {
    return reject('host_plan_expired', 'host_plan_expired');
  }

  if (plan.plannerKind !== 'host-model') {
    return reject('host_plan_not_model', 'host_plan_not_model');
  }

  if (!input.hostApp || plan.host !== input.hostApp) {
    return reject('host_plan_scope_mismatch', 'host_plan_scope_mismatch');
  }
  if (plan.agentId !== input.agentId) {
    return reject('host_plan_scope_mismatch', 'host_plan_scope_mismatch');
  }
  if (!input.threadId || plan.threadId !== input.threadId) {
    return reject('host_plan_scope_mismatch', 'host_plan_scope_mismatch');
  }

  if (plan.scope === 'turn') {
    if (!input.turnId || plan.forTurnId !== input.turnId || plan.basedOnTurnId === input.turnId) {
      return reject('host_plan_scope_mismatch', 'host_plan_scope_mismatch');
    }
  } else {
    // session prior：adapter 必须报 previousTurnId，且必须等于 sidecar 记录的上一轮。
    if (!input.previousTurnId
      || !input.lastContextTurnId
      || plan.basedOnTurnId !== input.previousTurnId
      || plan.basedOnTurnId !== input.lastContextTurnId
      || (input.turnId !== null && plan.basedOnTurnId === input.turnId)) {
      return reject('host_plan_scope_mismatch', 'host_plan_scope_mismatch');
    }
  }

  const current = cueTokenHashes(input.currentCue);
  const score = jaccard(current, plan.cueFingerprint);
  const exempt = cueJaccardExempt(input.currentCue);
  const signatureMatched = plan.cueSignature
    ? plan.cueSignature === cueSignatureOf(current)
    : false;
  const cueMatched = signatureMatched || score >= HOST_PLAN_CUE_JACCARD || exempt;
  if (!cueMatched) {
    return reject('host_plan_cue_mismatch', 'host_plan_cue_mismatch');
  }

  if (!candidateMatchesBasis(input.currentCandidateFingerprint, plan.basisCandidateFingerprint)) {
    return reject('host_plan_candidates_changed', 'host_plan_candidates_changed');
  }

  return { ok: true, plan, cueMatched: !exempt || signatureMatched || score >= HOST_PLAN_CUE_JACCARD, cueJaccard: score };
}

/**
 * 进程内单次消费表。planId 一旦被接收就写入，无论后续 cue/候选是否命中，
 * 都不得再次消费，避免重放绕过 freshness。
 */
export class HostPlanReplayGuard {
  private readonly seen = new Map<string, number>();
  private readonly ttlMs: number;

  constructor(ttlMs = 5 * 60_000) {
    this.ttlMs = ttlMs;
  }

  /** true 表示该 planId 已被接收过。 */
  has(planId: string, now: number): boolean {
    this.prune(now);
    return this.seen.has(planId);
  }

  mark(planId: string, now: number): void {
    this.prune(now);
    this.seen.set(planId, now);
  }

  private prune(now: number): void {
    for (const [planId, at] of this.seen) {
      if (now - at > this.ttlMs) this.seen.delete(planId);
    }
  }
}

/** 从任意对象安全提取 planId；用于在完整 parse 前做 replay 检查。 */
export function hostPlanIdOf(raw: unknown): string | null {
  if (!isObject(raw)) return null;
  const planId = text(raw.planId, 128);
  if (!planId || !/^hp_[A-Za-z0-9._:-]{1,124}$/.test(planId)) return null;
  return planId;
}
