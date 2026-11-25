// 记忆介入策略（0.4.0 Phase 1–3）。
//
// 只决定「本次要不要带长期记忆片段」以及「带 gist/detail/quote」；
// self/checkpoint 不经过这里，始终保持现有注入语义。
//
// - must_speak 是硬规则，任何策略都不能否决，且命中时不调用模型；
// - heuristic 用 score.final / cue 具体度 / novelty / 近期负例率；
// - maxSilentStreak 与 explorationRate 防止策略学成哑巴；
// - model 模式真实调用 SidecarInferenceProvider.planIntervention()：
//   超时/非法/失败一律回退 heuristic + degraded + intervention_model_fallback。
//
// planIntervention() 是纯函数（heuristic baseline）；
// planInterventionAsync() 只做模型编排，不做 I/O、不写 trace。
// 两者都不读配置、不写 trace，便于单元测试。

import { createHash } from 'node:crypto';
import type { Cue } from './cue.js';
import type {
  InferenceInterventionCandidate,
  InferenceInterventionRequest,
  InferenceInterventionResult,
  InferenceInterventionStats,
  SidecarOptionalModelSelection,
} from './inference-provider.js';
import type {
  InterventionAction,
  InterventionDecision,
  InterventionScores,
  RecallDepth,
} from '../runtime/types.js';

const RULES_POLICY_VERSION = 'v0-rules';
/** Console/宿主契约：策略规则版本；reset 响应也用这个值。 */
export const INTERVENTION_POLICY_VERSION = RULES_POLICY_VERSION;
const MAX_SILENT_STREAK_FALLBACK = 3;

export type InterventionMode = 'off' | 'shadow' | 'heuristic' | 'model';

export interface InterventionCandidateView {
  fragmentId: string;
  sourceIds: string[];
  score: number;
  confidence: number;
  kind: string;
  domain: string;
  detailAvailable: boolean;
  conflict: boolean;
  /** 给模型看的粗粒度摘要（截断）；绝不传 detail/正文。 */
  gist?: string;
  /** 候选年龄（天）；缺省 0。 */
  ageDays?: number;
}

export interface InterventionPlannerInput {
  mode: InterventionMode;
  cue: Cue;
  candidates: InterventionCandidateView[];
  alreadyInjectedIds: readonly string[];
  /** 已含 adaptive offset 的阈值；clamp 由 PolicyStore 负责。 */
  threshold: number;
  /** 最近同 agent/domain 的负例率；冷启动为 0。 */
  recentUselessRate: number;
  /** 本轮之前连续沉默次数。 */
  silentStreak: number;
  /** 上一轮决策；用于「上轮 silent 后追问/纠正」硬规则。 */
  lastDecision?: { action: InterventionAction; depth: RecallDepth } | null;
  maxSilentStreak?: number;
  explorationRate?: number;
  /** 测试注入；生产默认 Math.random。 */
  random?: () => number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round4(value: number): number {
  return Number(clamp(value, 0, 1).toFixed(4));
}

const MEMORY_FOLLOW_UP_RE = /上次|之前|以前|记得|忘记|你忘了|不是说过|我说过|我说的是|原话|当时(?:说|讲|怎么)|last time|earlier|remember|forgot|you said/i;
const CORRECTION_RE = /不对|不是(?:这个|这样|那条)?|错了|搞错|纠正|应该是|我说的是|准确(?:点|些)|重新说/i;

/** 用户明确要求回忆/追问记忆。 */
export function isExplicitMemoryRequest(cue: Cue): boolean {
  return MEMORY_FOLLOW_UP_RE.test(cue.rawQuery);
}

function isCorrection(cue: Cue): boolean {
  return CORRECTION_RE.test(cue.rawQuery)
    || cue.detailIntent.reasons.includes('conflict');
}

function hasExactIntent(cue: Cue): boolean {
  return cue.detailIntent.reasons.includes('quote_request')
    || cue.detailIntent.reasons.includes('command_request')
    || cue.detailIntent.reasons.includes('exact_value');
}

/** 命中即 must_speak 的原因；null 表示不强制。 */
export function mustSpeakReason(input: InterventionPlannerInput): string | null {
  const { cue, lastDecision } = input;
  if (isExplicitMemoryRequest(cue)) return 'must_speak:explicit_memory_request';
  if (hasExactIntent(cue) && cue.specificity !== 'broad') return 'must_speak:exact_intent';
  if (cue.detailIntent.reasons.includes('task_continue') || cue.followUpRef?.kind === 'checkpoint') {
    return 'must_speak:task_continue';
  }
  if ((lastDecision?.action === 'silent' || lastDecision?.action === 'defer')
    && (cue.followUpRef !== undefined || cue.detailIntent.reasons.includes('follow_up') || isCorrection(cue))) {
    return 'must_speak:after_silence';
  }
  if (cue.followUpRef?.kind === 'last_fragment') return 'must_speak:follow_up';
  return null;
}

/** 按 cue 意图选择深度：精确值/命令/引用 → quote；why/follow-up/task/entity/conflict → detail。 */
export function depthForCue(cue: Cue): RecallDepth {
  const reasons = cue.detailIntent.reasons;
  if (reasons.includes('quote_request')
    || reasons.includes('command_request')
    || reasons.includes('exact_value')) {
    return 'quote';
  }
  if (reasons.includes('why')
    || reasons.includes('follow_up')
    || reasons.includes('task_continue')
    || reasons.includes('entity_question')
    || reasons.includes('conflict')) {
    return 'detail';
  }
  if (cue.detailIntent.level === 'quote') return 'quote';
  if (cue.followUpRef) return 'detail';
  return 'gist';
}

function specificityScore(cue: Cue): number {
  if (cue.specificity === 'exact') return 1;
  if (cue.specificity === 'targeted') return 0.7;
  return 0.3;
}

function noveltyOf(candidate: InterventionCandidateView | undefined, alreadyInjected: readonly string[]): number {
  if (!candidate) return 0;
  if (alreadyInjected.length === 0) return 1;
  const injected = new Set(alreadyInjected);
  return candidate.sourceIds.some((id) => injected.has(id)) ? 0 : 1;
}

function scoresOf(
  cue: Cue,
  candidate: InterventionCandidateView | undefined,
  novelty: number,
  recentUselessRate: number,
  depth: RecallDepth,
): InterventionScores {
  return {
    top: round4(candidate?.score ?? 0),
    specificity: round4(specificityScore(cue)),
    novelty: round4(novelty),
    recentUseless: round4(recentUselessRate),
    depthFit: round4(depth === depthForCue(cue) ? 1 : 0.6),
  };
}

function heuristicVersion(input: InterventionPlannerInput): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([
      round4(input.threshold),
      input.maxSilentStreak ?? MAX_SILENT_STREAK_FALLBACK,
      round4(input.explorationRate ?? 0),
    ]), 'utf8')
    .digest('hex');
  return `heuristic:${digest.slice(0, 8)}`;
}

function silentReason(
  cue: Cue,
  topScore: number,
  threshold: number,
  novelty: number,
  recentUselessRate: number,
): string {
  if (topScore < threshold) return 'low_confidence';
  if (cue.specificity === 'broad' && topScore < 0.70) return 'broad_cue';
  if (novelty === 0) return 'no_novelty';
  if (recentUselessRate >= 0.40) return 'recent_false_alarm';
  return 'low_confidence';
}

function mustSpeakDecision(
  input: InterventionPlannerInput,
  candidate: InterventionCandidateView | undefined,
  reason: string,
  scores: InterventionScores,
): InterventionDecision {
  if (!candidate) {
    return {
      action: 'silent',
      depth: 'gist',
      confidence: 0,
      reason: 'must_speak_unavailable',
      policyVersion: RULES_POLICY_VERSION,
      enforced: input.mode === 'heuristic' || input.mode === 'model',
      scores,
      mustSpeak: true,
      degraded: true,
    };
  }
  const intended = depthForCue(input.cue);
  const depth: RecallDepth = intended === 'gist' || candidate.detailAvailable ? intended : 'gist';
  return {
    action: 'speak',
    depth,
    confidence: 1,
    reason,
    policyVersion: RULES_POLICY_VERSION,
    enforced: input.mode === 'heuristic' || input.mode === 'model',
    scores,
    mustSpeak: true,
    ...(depth !== intended ? { degraded: true } : {}),
  };
}

function planHeuristic(input: InterventionPlannerInput): InterventionDecision {
  const candidate = input.candidates[0];
  const topScore = clamp(candidate?.score ?? 0, 0, 1);
  const novelty = noveltyOf(candidate, input.alreadyInjectedIds);
  const threshold = clamp(input.threshold, 0, 1);
  const recentUselessRate = clamp(input.recentUselessRate, 0, 1);
  const maxSilentStreak = Math.max(1, Math.floor(input.maxSilentStreak ?? MAX_SILENT_STREAK_FALLBACK));
  const explorationRate = clamp(input.explorationRate ?? 0, 0, 1);
  const random = input.random ?? Math.random;

  const mustReason = mustSpeakReason(input);
  if (mustReason) {
    const intended = depthForCue(input.cue);
    return mustSpeakDecision(
      input,
      candidate,
      mustReason,
      scoresOf(input.cue, candidate, novelty, recentUselessRate, intended),
    );
  }

  if (!candidate) {
    return {
      action: 'silent',
      depth: 'gist',
      confidence: 0,
      reason: 'no_candidates',
      policyVersion: heuristicVersion(input),
      enforced: input.mode === 'heuristic' || input.mode === 'model',
      scores: scoresOf(input.cue, candidate, novelty, recentUselessRate, 'gist'),
    };
  }

  const depth = depthForCue(input.cue);
  const baseSpeak = topScore >= threshold
    && (input.cue.specificity !== 'broad' || topScore >= 0.70)
    && novelty > 0
    && recentUselessRate < 0.40;

  const decision = (
    action: InterventionAction,
    reason: string,
    chosenDepth: RecallDepth = depth,
  ): InterventionDecision => ({
    action,
    depth: chosenDepth,
    confidence: round4(topScore),
    reason,
    policyVersion: heuristicVersion(input),
    enforced: input.mode === 'heuristic' || input.mode === 'model',
    scores: scoresOf(input.cue, candidate, novelty, recentUselessRate, chosenDepth),
  });

  if (baseSpeak) return decision('speak', 'high_relevance');

  // 连续沉默太多：强制说一条 gist，避免策略自我强化为哑巴。
  if (input.silentStreak >= maxSilentStreak) {
    return decision('speak', 'max_silent_streak', 'gist');
  }

  // 探索：本应沉默时按比例注入，给策略留下纠错样本。
  if (explorationRate > 0 && random() < explorationRate) {
    return decision('speak', 'exploration', 'gist');
  }

  return decision('silent', silentReason(input.cue, topScore, threshold, novelty, recentUselessRate));
}

/**
 * 计算一次 heuristic 介入决策。off 模式不调用本函数（由 RecallService 记录 baseline）。
 * model 模式的真实模型调用由 planInterventionAsync() 编排；本函数返回其 heuristic
 * baseline，绝不伪造模型输出。
 */
export function planIntervention(input: InterventionPlannerInput): InterventionDecision {
  return planHeuristic(input);
}

// ---------- 0.4.0 Phase 3：真实模型决策编排 ----------

const MODEL_REASON_MAX_CHARS = 160;
const MODEL_GIST_MAX_CHARS = 240;

/** 只依赖 provider 的这两个方法，测试可注入替身。 */
export interface InterventionModelPlanner {
  selectOptionalSource(allowRemote: boolean): Promise<SidecarOptionalModelSelection>;
  planIntervention(
    request: InferenceInterventionRequest,
    options?: { timeoutMs?: number },
  ): Promise<InferenceInterventionResult>;
}

export interface InterventionModelContext {
  planner: InterventionModelPlanner | null;
  allowRemote: boolean;
  /** 本次模型决策总预算（config.intervention.modelTimeoutMs）。 */
  timeoutMs: number;
  stats: InferenceInterventionStats;
  hasCheckpoint: boolean;
  now?: () => number;
}

export interface InterventionPlanResult {
  decision: InterventionDecision;
  source: 'heuristic' | 'local' | 'api';
  model?: string;
  latencyMs: number;
  /** true 表示本次决策由模型给出。 */
  fromModel: boolean;
  /** true 表示本次尝试了模型但回退 heuristic。 */
  modelFallback: boolean;
  warnings: string[];
  reasonCode?: string;
}

function dedupe(values: Iterable<string>): string[] {
  return [...new Set([...values].filter((value) => value.length > 0))];
}

/** 超时/拒绝都归一为 null，保证 fail-open；不泄漏模型错误详情。 */
function withinDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(null);
    }, timeoutMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    const finish = (value: T | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    promise.then((value) => finish(value), () => finish(null));
  });
}

/**
 * 组装模型请求：cue 聚合字段 + 候选 gist + 聚合统计。
 * 不传 rawQuery、detail、checkpoint 正文、token、fragmentId/sourceIds。
 */
export function buildInterventionInferenceRequest(
  input: InterventionPlannerInput,
  stats: InferenceInterventionStats,
  hasCheckpoint: boolean,
  source: 'local' | 'api',
  allowRemote: boolean,
): InferenceInterventionRequest {
  const candidates: InferenceInterventionCandidate[] = input.candidates.map((candidate) => ({
    kind: candidate.kind,
    domain: candidate.domain,
    gist: (candidate.gist ?? '').replace(/\s+/g, ' ').trim().slice(0, MODEL_GIST_MAX_CHARS),
    score: round4(candidate.score),
    confidence: round4(candidate.confidence),
    ageDays: Math.max(0, candidate.ageDays ?? 0),
  }));
  return {
    source,
    cue: {
      specificity: input.cue.specificity,
      topics: [...input.cue.topics],
      entities: input.cue.entities.map((entity) => entity.name),
      reasons: [...input.cue.detailIntent.reasons],
      followUp: Boolean(input.cue.followUpRef)
        || input.cue.detailIntent.reasons.includes('follow_up'),
    },
    candidates,
    stats: { ...stats },
    hasCheckpoint,
    allowRemote,
  };
}

function modelVersionOf(
  request: InferenceInterventionRequest,
  result: InferenceInterventionResult,
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([
      // 模型身份与来源进入 hash：同一结果在不同模型/来源上必须可区分。
      request.source,
      result.model ?? '',
      request.cue,
      request.candidates,
      request.stats,
      result.action,
      result.depth,
      result.confidence,
      result.reason,
    ]), 'utf8')
    .digest('hex');
  return `model:${digest.slice(0, 8)}`;
}

function modelDecisionOf(
  result: InferenceInterventionResult,
  input: InterventionPlannerInput,
  heuristic: InterventionDecision,
  request: InferenceInterventionRequest,
): { decision: InterventionDecision; warnings: string[] } | null {
  if (result.action !== 'speak' && result.action !== 'defer' && result.action !== 'silent') return null;
  if (result.depth !== 'gist' && result.depth !== 'detail' && result.depth !== 'quote') return null;
  if (typeof result.confidence !== 'number'
    || !Number.isFinite(result.confidence)
    || result.confidence < 0
    || result.confidence > 1) {
    return null;
  }
  if (typeof result.reason !== 'string' || result.reason.trim().length === 0) return null;

  const warnings: string[] = [];
  let depth: RecallDepth = result.depth;
  let degraded = false;
  const top = input.candidates[0];
  if (result.action === 'speak' && depth !== 'gist' && top && !top.detailAvailable) {
    // 不要承诺不存在的 detail/quote；降为 gist，但不否决模型的 action。
    depth = 'gist';
    degraded = true;
    warnings.push('intervention_model_depth_unavailable');
  }

  const scores: InterventionScores | undefined = heuristic.scores
    ? {
      ...heuristic.scores,
      depthFit: round4(depth === depthForCue(input.cue) ? 1 : 0.6),
    }
    : undefined;

  return {
    decision: {
      action: result.action,
      depth,
      confidence: round4(result.confidence),
      reason: result.reason.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
        .slice(0, MODEL_REASON_MAX_CHARS),
      policyVersion: modelVersionOf(request, { ...result, depth }),
      enforced: true,
      ...(scores ? { scores } : {}),
      ...(degraded ? { degraded: true } : {}),
    },
    warnings,
  };
}

/**
 * model 模式入口：must_speak 不调用模型；其余按 cue + top-3 gist + 统计决策。
 * 任何失败（无模型/超时/非法/异常）都回退 heuristic，并标记 degraded + warning。
 */
export async function planInterventionAsync(
  input: InterventionPlannerInput,
  context: InterventionModelContext,
): Promise<InterventionPlanResult> {
  const heuristic = planIntervention({ ...input, mode: 'heuristic' });
  const base: InterventionPlanResult = {
    decision: heuristic,
    source: 'heuristic',
    latencyMs: 0,
    fromModel: false,
    modelFallback: false,
    warnings: [],
  };
  if (input.mode !== 'model') return base;
  // 硬规则优先且省延迟；没有候选时模型也无法改变注入结果。
  if (heuristic.mustSpeak || input.candidates.length === 0) return base;

  const now = context.now ?? Date.now;
  const started = now();
  const elapsedNow = (): number => Math.max(0, now() - started);
  const timeoutMs = Math.max(1, Math.floor(context.timeoutMs));
  const fallback = (
    reasonCode: string,
    warnings: string[],
    extra: { model?: string } = {},
  ): InterventionPlanResult => ({
    decision: { ...heuristic, degraded: true },
    source: 'heuristic',
    ...(extra.model ? { model: extra.model } : {}),
    latencyMs: elapsedNow(),
    fromModel: false,
    modelFallback: true,
    warnings: dedupe(['intervention_model_fallback', ...warnings]),
    reasonCode,
  });

  if (!context.planner) {
    return fallback('model_unavailable', ['model_unavailable']);
  }

  const selection = await withinDeadline(
    context.planner.selectOptionalSource(context.allowRemote),
    timeoutMs,
  );
  if (!selection) return fallback('model_timeout', ['model_timeout']);
  if (!selection.source) {
    return fallback(
      selection.reason ?? 'model_unavailable',
      selection.warnings.length > 0 ? selection.warnings : ['model_unavailable'],
    );
  }

  const remaining = timeoutMs - elapsedNow();
  if (remaining <= 0) return fallback('model_timeout', ['model_timeout']);

  const request = buildInterventionInferenceRequest(
    input,
    context.stats,
    context.hasCheckpoint,
    selection.source,
    context.allowRemote,
  );
  const result = await withinDeadline(
    context.planner.planIntervention(request, { timeoutMs: remaining }),
    remaining,
  );
  if (!result) return fallback('model_timeout', ['model_timeout']);
  if (!result.ok) {
    return fallback(
      result.reasonCode ?? 'model_failed',
      result.warnings.length > 0 ? result.warnings : ['model_unavailable'],
      result.model ? { model: result.model } : {},
    );
  }

  const built = modelDecisionOf(result, input, heuristic, request);
  if (!built) {
    return fallback(
      'invalid_model_response',
      ['model_invalid_response'],
      result.model ? { model: result.model } : {},
    );
  }

  return {
    decision: built.decision,
    source: selection.source,
    ...(result.model ? { model: result.model } : {}),
    latencyMs: elapsedNow(),
    fromModel: true,
    modelFallback: false,
    warnings: built.warnings,
  };
}
