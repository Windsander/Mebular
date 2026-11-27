// 记忆介入策略（0.4.0 Phase 1–3）。
//
// 只决定「本次要不要带长期记忆片段」以及「带 gist/detail/quote」；
// self/checkpoint 不经过这里，始终保持现有注入语义。
//
// 规则优先级（v0-rules）：
//   1. defer_explicit：用户/宿主明确“暂时不要提/先别用记忆” → defer；
//      显式 defer 可以覆盖自动 must_speak，但 applied 仍保持 self/checkpoint 路径。
//   2. conflict：用户明确问“哪个对/以哪条为准/记录冲突”，且候选带 conflict group
//      → speak；exact intent 用 depthForCue() 的 quote，否则 detail。
//   3. greeting / meta：整句寒暄、致谢、助手身份/能力/时间 → silent；整句锚定，
//      混合了记忆请求的 turn 会继续落到 must_speak。
//   4. must_speak：自动策略下限，不是用户显式意图的上限。命中后 heuristic 的
//      阈值、负例率、novelty、探索/沉默上限都不能否决；无候选时仍是 checkpoint-only。
//   5. no_candidates / no_novelty：无候选 silent；只有全部候选都已注入才 anti-repeat silent。
//   6. heuristic：剩下的 turn 按 score / cue / novelty / 负例率决定。
//
// - must_speak 是硬规则，命中时不调用模型；
// - heuristic 用 score.final / cue 具体度 / novelty / 近期负例率；
// - no_novelty 是 anti-repeat 例外：不影响 maxSilentStreak / exploration 对新颖候选的作用；
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
} from './inference-provider.js';
import type {
  InterventionAction,
  InterventionDecision,
  InterventionFallbackReason,
  InterventionPlannerAttempt,
  InterventionPlannerTrace,
  InterventionPrefetchState,
  InterventionScores,
  RecallDepth,
} from '../runtime/types.js';
import type { InterventionPlannerSource } from './effective.js';
import type {
  InterventionPrefetchPlan,
} from './intervention-prefetch.js';

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

const MEMORY_FOLLOW_UP_RE = /上次|之前|以前|记得|忘记|你忘了|不是说过|我说过|我说的是|原话|当时(?:说|讲|怎么)|我的偏好是什么|last time|earlier|remember|forgot|you said|\brecall\b|\bremind me\b|\bwe (?:agreed|decided|settled)\b|\bwhat did (?:i|we) (?:say|decide|agree)\b/i;
const CORRECTION_RE = /不对|不是(?:这个|这样|那条)?|错了|搞错|纠正|应该是|我说的是|准确(?:点|些)|重新说/i;

// 显式 defer：用户要求本轮先不要回忆/注入旧上下文。
// 与 Stage 0 的 test-only 口径一致；放在 must_speak 之前，避免「暂时不要提以前的方案」
// 被 /以前/ 误判为显式回忆请求。
const EXPLICIT_DEFER_RE = /(?:先|暂时|现在)?别(?:回忆|提|再提|注入|用记忆|提旧)|不要(?:回忆|提以前|用记忆)|不用(?:回忆|记)|先不(?:查|回忆|提|看历史)|先放一放|晚点再(?:聊|说|回顾)|下一轮再|等(?:我|你|把).{0,12}再(?:说|查|回顾|聊)|跳过(?:旧|以前|历史|旧上下文)|hold off|not (?:recall|bring up)|skip the memory|don'?t bring up|let'?s not recall|until i finish/i;

// conflict 是独立硬规则：用户必须明确提出“哪个对/以哪条为准/该信哪个”。
// 仅陈述“记录冲突/不一致/和以前不一样”不触发；候选还必须确实带 conflict group。
// exact intent 用 depthForCue() 的 quote，否则 detail。
const CONFLICT_QUERY_RE = /哪个对|哪条为准|以哪条为准|到底用哪个|到底哪个|信哪个|该信哪个|怎么处理|怎么办|如何取舍|which (?:one|record|.*?)\s+(?:is\s+)?(?:correct|right)|which (?:should i|to) trust/i;

// 只匹配「整句寒暄/礼貌」；带实质请求的 turn 不会被这里吞掉。
const GREETING_TOKEN = String.raw`(?:早上好|早安|早|上午好|中午好|下午好|晚上好|晚安|你好|您好|嗨|哈喽|在吗|收到|好的|好|嗯|谢谢|多谢|感谢|辛苦了|再见|拜拜|hi there|hello there|hi|hello|hey|good morning|good afternoon|good evening|good night|thanks|thank you|thankyou|bye|goodbye|ok|okay|got it|sure)`;
const GREETING_RE = new RegExp(
  `^${GREETING_TOKEN}(?:[\\s,，。.!！?？~～、]*${GREETING_TOKEN})*[\\s,，。.!！?？~～、呀啊哦啦呢吧]*$`,
  'i',
);

// meta：问助手身份/能力/当前时间，不是长期记忆请求。
const META_RE = /^(?:请问|打扰一下)?\s*(?:你是谁|你叫什么(?:名字)?|你是什么(?:模型|助手|东西)|你(?:能|会)(?:做|干)?什么|你有什么(?:能力|功能)|帮我解释(?:一下)?你的(?:能力|功能)|你(?:是)?怎么用|这个(?:东西)?怎么用|现在几点(?:了)?|今天几号|今天(?:是)?星期几|what model are you|who are you|what can you do|what are you|how do i use (?:this|it)|what time is it|what(?:'s| is) the (?:time|date)|what day is it)[\s!！。,.，？?~～]*$/i;

// 英文精确值/引用词：与中文「端口/版本/路径/命令」对齐。
// cue.ts 的 detailIntent 只覆盖中文词，这里补英文侧，避免同一意图在中英之间不对称。
const EN_EXACT_INTENT_RE = /\b(?:exact|quote|verbatim|version|port|path|command|script|date)\b/i;

function hasEnglishExactIntent(cue: Cue): boolean {
  return cue.language === 'en' && EN_EXACT_INTENT_RE.test(cue.rawQuery);
}

/** 用户明确要求回忆/追问记忆。 */
export function isExplicitMemoryRequest(cue: Cue): boolean {
  return MEMORY_FOLLOW_UP_RE.test(cue.rawQuery);
}

/** 用户明确要求本轮 defer（不注入记忆片段，但 checkpoint/self 照常）。 */
export function isExplicitDefer(cue: Cue): boolean {
  return EXPLICIT_DEFER_RE.test(cue.rawQuery)
    || cue.detailIntent.reasons.includes('user_negated')
    || cue.negations.includes('user_negated');
}

function isConflictRequest(cue: Cue): boolean {
  return CONFLICT_QUERY_RE.test(cue.rawQuery);
}

function isGreeting(cue: Cue): boolean {
  return cue.detailIntent.reasons.includes('chitchat')
    || GREETING_RE.test(cue.rawQuery.trim());
}

function isMeta(cue: Cue): boolean {
  return META_RE.test(cue.rawQuery.trim());
}

function isCorrection(cue: Cue): boolean {
  return CORRECTION_RE.test(cue.rawQuery)
    || cue.detailIntent.reasons.includes('conflict');
}

function hasExactIntent(cue: Cue): boolean {
  return cue.detailIntent.reasons.includes('quote_request')
    || cue.detailIntent.reasons.includes('command_request')
    || cue.detailIntent.reasons.includes('exact_value')
    || hasEnglishExactIntent(cue);
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
  const exactIntent = reasons.includes('quote_request')
    || reasons.includes('command_request')
    || reasons.includes('exact_value');
  // 冲突需要对照多条记录；但用户明确要精确值时，quote 仍然优先。
  if (reasons.includes('conflict') && !exactIntent) return 'detail';
  if (exactIntent || hasEnglishExactIntent(cue)) {
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
  // 宿主可能回传上一轮 /context 的 fragment ID（mf_…）或 source/record ID；
  // 任一命中都表示该候选已经注入过，novelty=0。
  if (injected.has(candidate.fragmentId)) return 0;
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

interface RuleDecisionOptions {
  action: InterventionAction;
  reason: string;
  depth: RecallDepth;
  candidate: InterventionCandidateView | undefined;
  novelty: number;
  recentUselessRate: number;
  degraded?: boolean;
}

/** 硬规则决策：与 must_speak 一样不依赖阈值/负例率，便于 trace 归因。 */
function ruleDecision(
  input: InterventionPlannerInput,
  options: RuleDecisionOptions,
): InterventionDecision {
  const { action, reason, depth, candidate, novelty, recentUselessRate } = options;
  return {
    action,
    depth,
    confidence: 1,
    reason,
    policyVersion: RULES_POLICY_VERSION,
    enforced: input.mode === 'heuristic' || input.mode === 'model',
    scores: scoresOf(input.cue, candidate, novelty, recentUselessRate, depth),
    ...(options.degraded ? { degraded: true } : {}),
  };
}

/** 规则层已经决定的 reason；这些分支不再调用模型。 */
const HARD_RULE_REASONS = new Set([
  'defer_explicit',
  'conflict',
  'greeting',
  'meta',
  'no_candidates',
  'no_novelty',
]);

function decidedByRules(decision: InterventionDecision): boolean {
  return decision.mustSpeak === true
    || decision.action === 'defer'
    || HARD_RULE_REASONS.has(decision.reason);
}

function planHeuristic(input: InterventionPlannerInput): InterventionDecision {
  const freshCandidate = input.candidates.find(
    (view) => noveltyOf(view, input.alreadyInjectedIds) > 0,
  );
  // 选第一个 novelty>0 的候选；只有全部已注入时才回落到 top-1 用于 no_novelty 归因。
  const candidate = freshCandidate ?? input.candidates[0];
  const allInjected = input.candidates.length > 0 && freshCandidate === undefined;
  const conflictCandidates = input.candidates.filter((view) => view.conflict);
  const freshConflictCandidate = conflictCandidates.find(
    (view) => noveltyOf(view, input.alreadyInjectedIds) > 0,
  );
  // conflict 分支只使用 conflict 候选：
  // - 优先第一个新鲜 conflict 候选；
  // - 只有全部候选都已注入时，才用 top conflict 候选（conflict 优先于 anti-repeat）；
  // - conflict 候选已注入但存在普通新鲜候选时，不进入 conflict 分支。
  const conflictCandidate = freshConflictCandidate
    ?? (allInjected ? conflictCandidates[0] : undefined);
  const topScore = clamp(candidate?.score ?? 0, 0, 1);
  const novelty = noveltyOf(candidate, input.alreadyInjectedIds);
  const threshold = clamp(input.threshold, 0, 1);
  const recentUselessRate = clamp(input.recentUselessRate, 0, 1);
  const maxSilentStreak = Math.max(1, Math.floor(input.maxSilentStreak ?? MAX_SILENT_STREAK_FALLBACK));
  const explorationRate = clamp(input.explorationRate ?? 0, 0, 1);
  const random = input.random ?? Math.random;

  // 0) 显式 defer 优先于 must_speak：用户本轮明确不想看旧记忆。
  //    放在最前，避免 /以前/ 之类的回忆触发词把 defer 误判成 must_speak。
  if (isExplicitDefer(input.cue)) {
    return ruleDecision(input, {
      action: 'defer',
      reason: 'defer_explicit',
      depth: 'gist',
      candidate,
      novelty,
      recentUselessRate,
    });
  }

  // 1) conflict 也要先于 must_speak：冲突问句要对照多条记录。
  //    exact intent 用 depthForCue() 的 quote；否则 detail；detail 不可用降 gist+degraded。
  if (conflictCandidate && isConflictRequest(input.cue)) {
    const intended = depthForCue(input.cue);
    const requestedDepth: RecallDepth = intended === 'quote' ? 'quote' : 'detail';
    const detailAvailable = conflictCandidate.detailAvailable;
    return ruleDecision(input, {
      action: 'speak',
      reason: 'conflict',
      depth: detailAvailable ? requestedDepth : 'gist',
      candidate: conflictCandidate,
      novelty: noveltyOf(conflictCandidate, input.alreadyInjectedIds),
      recentUselessRate,
      degraded: !detailAvailable,
    });
  }

  // 2) 寒暄 / meta / 纯礼貌默认 silent；它们都是整句锚定，
  //    带实质记忆请求的 turn 不会命中，因此不会压过真正的 must_speak。
  if (isGreeting(input.cue)) {
    return ruleDecision(input, {
      action: 'silent',
      reason: 'greeting',
      depth: 'gist',
      candidate,
      novelty,
      recentUselessRate,
    });
  }
  if (isMeta(input.cue)) {
    return ruleDecision(input, {
      action: 'silent',
      reason: 'meta',
      depth: 'gist',
      candidate,
      novelty,
      recentUselessRate,
    });
  }

  // 3) must_speak 是硬规则，不能被阈值、负例率或 novelty 否决。
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

  // 4) 无候选 → checkpoint-only。除 must_speak 外不再猜测记忆。
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

  // 5) anti-repeat：只有所有候选都已注入时才 hard silent no_novelty。
  //    maxSilentStreak / exploration 只对 novelty>0 的候选生效，不重复注入旧片段。
  if (allInjected) {
    return ruleDecision(input, {
      action: 'silent',
      reason: 'no_novelty',
      depth: 'gist',
      candidate,
      novelty,
      recentUselessRate,
    });
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

/** 只依赖 provider 的模型入口；测试可注入替身。 */
export interface InterventionModelPlanner {
  planIntervention(
    request: InferenceInterventionRequest,
    options?: { timeoutMs?: number },
  ): Promise<InferenceInterventionResult>;
}

/**
 * W2 首版 API 同步硬上限。W5 会把 `/context` 整体 deadline 硬化；
 * 这里先保证单次介入调用不会把用户回合拖过 1.5s。
 */
export const INTERVENTION_API_SYNC_DEADLINE_MS = 1500;
/** 剩余预算低于该值时不再尝试模型（W0-A §6.1）。 */
export const MIN_PLANNER_BUDGET_MS = 200;
/** 响应组装/序列化预留；W5 硬 deadline 会复用同一 seam。 */
export const INTERVENTION_RESPONSE_RESERVE_MS = 150;

export interface InterventionModelContext {
  planner: InterventionModelPlanner | null;
  /** 配置的 model.source；决定 local/api/auto 解析。 */
  configuredSource: InterventionPlannerSource;
  /** 是否显式允许远端；生产只读 config.model.api.allowRemote。 */
  allowRemote: boolean;
  /** 本次模型决策预算（config.intervention.modelTimeoutMs）；上限 1500ms。 */
  timeoutMs: number;
  /** W5 seam：绝对 deadline；提供后优先于 timeoutMs，并保留响应预留。 */
  deadlineAt?: number;
  /** 本地模型是否已配置（pack/path）；不在 `/context` 探测模型文件。 */
  localConfigured: boolean;
  /** API 是否已配置（baseUrl+model）；凭据在 provider 内校验。 */
  apiConfigured: boolean;
  /** 命中新鲜 local 预取 plan 时传入；W2 不会在 `/context` 同步调用本地模型。 */
  prefetchedPlan?: InterventionPrefetchPlan | null;
  prefetchState?: InterventionPrefetchState;
  prefetchAgeMs?: number;
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
  /** 0.4.0：是否消费了新鲜预取 plan。 */
  prefetched: boolean;
  /** 稳定 fallback 枚举；无 fallback 时为 null。 */
  fallbackReason: InterventionFallbackReason | null;
  /** 只读诊断；不含正文/凭据。 */
  planner: InterventionPlannerTrace;
}

export interface InterventionSourceResolutionInput {
  configuredSource: InterventionPlannerSource;
  allowRemote: boolean;
  localConfigured: boolean;
  apiConfigured: boolean;
  /** W3 seam：host plan 是否可用；W2 不实现 host bridge，生产恒为 false。 */
  hostPlanAvailable?: boolean;
  hasPrefetchedPlan: boolean;
  prefetchState?: InterventionPrefetchState;
}

export interface InterventionSourceResolution {
  source: 'host' | 'local' | 'api' | null;
  prefetched: boolean;
  fallbackReason: InterventionFallbackReason | null;
  /** 预期运行时状态（首轮/未命中/过期/cue mismatch）不算 fallback/degraded。 */
  expected: boolean;
  warnings: string[];
}

/**
 * 介入来源解析（与 extraction 的 selectOptionalSource 分离）。
 *
 * - local：只消费新鲜预取；miss/首轮/过期/cue mismatch 立即 heuristic；
 * - api：唯一允许的同步模型来源，只有配置允许且 allowRemote 才尝试；
 * - auto：host（W3）→ local（命中才用，未配置才继续）→ api → heuristic；
 * - 任何分支都不在 `/context` 启动本地模型。
 */
export function resolveInterventionSource(
  input: InterventionSourceResolutionInput,
): InterventionSourceResolution {
  const prefetchMiss = (): InterventionSourceResolution => ({
    source: null,
    prefetched: false,
    fallbackReason: 'prefetch_miss',
    expected: true,
    warnings: [prefetchWarning(input.prefetchState)],
  });

  if (input.configuredSource === 'heuristic') {
    return { source: null, prefetched: false, fallbackReason: null, expected: false, warnings: [] };
  }

  const resolveLocal = (): InterventionSourceResolution => {
    if (!input.localConfigured) {
      return {
        source: null,
        prefetched: false,
        fallbackReason: 'model_not_installed',
        expected: false,
        warnings: ['model_unavailable'],
      };
    }
    if (input.hasPrefetchedPlan) {
      return { source: 'local', prefetched: true, fallbackReason: null, expected: false, warnings: [] };
    }
    return prefetchMiss();
  };

  const resolveApi = (): InterventionSourceResolution => {
    if (!input.apiConfigured) {
      return {
        source: null,
        prefetched: false,
        fallbackReason: 'source_unavailable',
        expected: false,
        warnings: ['model_unavailable'],
      };
    }
    if (!input.allowRemote) {
      return {
        source: null,
        prefetched: false,
        fallbackReason: 'allow_remote_false',
        expected: false,
        warnings: ['remote_not_allowed', 'model_unavailable'],
      };
    }
    return { source: 'api', prefetched: false, fallbackReason: null, expected: false, warnings: [] };
  };

  if (input.configuredSource === 'local') return resolveLocal();
  if (input.configuredSource === 'host') {
    return input.hostPlanAvailable
      ? { source: 'host', prefetched: true, fallbackReason: null, expected: false, warnings: [] }
      : {
        source: null,
        prefetched: false,
        fallbackReason: 'host_plan_missing',
        expected: false,
        warnings: ['host_plan_missing'],
      };
  }
  if (input.configuredSource === 'api') return resolveApi();

  // auto（W0-A §6.3，冻结）：local 已配置时，miss/失败也走 heuristic，绝不切 api；
  // 只有 local 未配置才继续尝试 api。reviewer 的 miss→api 建议与契约冲突，不要改。
  if (input.hostPlanAvailable) {
    return { source: 'host', prefetched: true, fallbackReason: null, expected: false, warnings: [] };
  }
  if (input.localConfigured) return resolveLocal();
  return resolveApi();
}

function prefetchWarning(state: InterventionPrefetchState | undefined): string {
  if (state === 'expired') return 'intervention_prefetch_expired';
  if (state === 'cue_mismatch') return 'intervention_prefetch_cue_mismatch';
  if (state === 'first_turn') return 'intervention_prefetch_first_turn';
  return 'intervention_prefetch_miss';
}

function plannerTrace(input: {
  configuredSource: InterventionPlannerSource;
  resolvedSource: 'heuristic' | 'local' | 'host' | 'api' | null;
  latencyMs: number;
  fallbackReason: InterventionFallbackReason | null;
  prefetched: boolean;
  prefetchState?: InterventionPrefetchState;
  prefetchAgeMs?: number;
  planId?: string;
  cueMatched?: boolean;
  model?: string;
  attempts?: InterventionPlannerAttempt[];
}): InterventionPlannerTrace {
  return {
    configuredSource: input.configuredSource,
    resolvedSource: input.resolvedSource,
    latencyMs: Math.max(0, Math.round(input.latencyMs)),
    fallbackReason: input.fallbackReason,
    prefetched: input.prefetched,
    ...(input.prefetchState ? { prefetchState: input.prefetchState } : {}),
    ...(input.prefetchAgeMs !== undefined ? { planAgeMs: Math.max(0, Math.round(input.prefetchAgeMs)) } : {}),
    ...(input.planId ? { planId: input.planId } : {}),
    ...(input.cueMatched !== undefined ? { cueMatched: input.cueMatched } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.attempts && input.attempts.length > 0
      ? { attempts: input.attempts.slice(0, 4) }
      : {}),
  };
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

/** policyVersion 的稳定 seed；只含聚合 cue/候选/统计与模型身份，不含正文。 */
export function interventionVersionSeed(request: InferenceInterventionRequest): string {
  return JSON.stringify([
    // 模型身份与来源进入 hash：同一结果在不同模型/来源上必须可区分。
    request.source,
    request.cue,
    request.candidates,
    request.stats,
  ]);
}

function modelVersionOfSeed(
  seed: string,
  result: Pick<InferenceInterventionResult, 'action' | 'depth' | 'confidence' | 'reason'>,
  model: string | undefined,
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([
      seed,
      model ?? '',
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
  version: (depth: RecallDepth) => string,
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
      policyVersion: version(depth),
      enforced: true,
      ...(scores ? { scores } : {}),
      ...(degraded ? { degraded: true } : {}),
    },
    warnings,
  };
}

/**
 * W2 介入编排：
 * - heuristic：规则层直接返回，不触模型；
 * - local：只消费新鲜预取 plan，未命中立即 heuristic（不启动本地同步调用）；
 * - api：唯一同步模型来源，受 1.5s 上限与剩余预算约束；
 * - auto：一个总预算；host（W3 seam，0ms）→ local（命中才用）→ api（仅 local 未配置）；
 * - 所有失败都 fail-open 到 heuristic，并记录稳定 fallbackReason。
 */
export async function planInterventionAsync(
  input: InterventionPlannerInput,
  context: InterventionModelContext,
): Promise<InterventionPlanResult> {
  const heuristic = planIntervention({ ...input, mode: 'heuristic' });
  const configuredSource = context.configuredSource;
  const initialTrace = plannerTrace({
    configuredSource,
    resolvedSource: input.mode === 'model' ? null : 'heuristic',
    latencyMs: 0,
    fallbackReason: null,
    prefetched: false,
    ...(context.prefetchState ? { prefetchState: context.prefetchState } : {}),
  });
  if (input.mode !== 'model') {
    return {
      decision: { ...heuristic, planner: initialTrace },
      source: 'heuristic',
      latencyMs: 0,
      fromModel: false,
      modelFallback: false,
      warnings: [],
      prefetched: false,
      fallbackReason: null,
      planner: initialTrace,
    };
  }

  // 硬规则优先且省延迟；规则层已决定时不再调用模型。
  // （无候选也在此短路；must_speak 无候选时走 must_speak_unavailable 的 checkpoint-only。）
  if (decidedByRules(heuristic) || input.candidates.length === 0) {
    return {
      decision: { ...heuristic, planner: initialTrace },
      source: 'heuristic',
      latencyMs: 0,
      fromModel: false,
      modelFallback: false,
      warnings: [],
      prefetched: false,
      fallbackReason: null,
      planner: initialTrace,
    };
  }

  const now = context.now ?? Date.now;
  const started = now();
  const elapsedNow = (): number => Math.max(0, now() - started);

  const fallback = (
    reasonCode: string,
    fallbackReason: InterventionFallbackReason,
    warnings: string[],
    options: {
      model?: string;
      expected?: boolean;
      attempts?: InterventionPlannerAttempt[];
      prefetchState?: InterventionPrefetchState;
    } = {},
  ): InterventionPlanResult => {
    const expected = options.expected === true;
    const trace = plannerTrace({
      configuredSource,
      resolvedSource: null,
      latencyMs: elapsedNow(),
      fallbackReason,
      prefetched: false,
      ...(options.prefetchState ? { prefetchState: options.prefetchState } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.attempts ? { attempts: options.attempts } : {}),
    });
    return {
      decision: {
        ...heuristic,
        ...(expected ? {} : { degraded: true }),
        planner: trace,
      },
      source: 'heuristic',
      ...(options.model ? { model: options.model } : {}),
      latencyMs: elapsedNow(),
      fromModel: false,
      modelFallback: !expected,
      warnings: expected
        ? dedupe(warnings)
        : dedupe(['intervention_model_fallback', ...warnings]),
      reasonCode,
      prefetched: false,
      fallbackReason,
      planner: trace,
    };
  };

  const resolution = resolveInterventionSource({
    configuredSource,
    allowRemote: context.allowRemote,
    localConfigured: context.localConfigured,
    apiConfigured: context.apiConfigured,
    hasPrefetchedPlan: Boolean(context.prefetchedPlan),
    ...(context.prefetchState ? { prefetchState: context.prefetchState } : {}),
  });
  if (!resolution.source) {
    return fallback(
      resolution.fallbackReason === 'prefetch_miss'
        ? 'prefetch_miss'
        : resolution.fallbackReason === 'allow_remote_false'
          ? 'remote_not_allowed'
          : resolution.fallbackReason === 'model_not_installed'
            ? 'local_not_configured'
            : 'model_unavailable',
      resolution.fallbackReason ?? 'source_unavailable',
      resolution.warnings.length > 0 ? resolution.warnings : ['model_unavailable'],
      {
        expected: resolution.expected,
        ...(context.prefetchState ? { prefetchState: context.prefetchState } : {}),
      },
    );
  }

  // 1) local：只消费预取 plan；绝不在 `/context` 调用本地模型。
  if (resolution.source === 'local') {
    const plan = context.prefetchedPlan;
    if (!plan) {
      return fallback('prefetch_miss', 'prefetch_miss', ['intervention_prefetch_miss'], {
        expected: true,
        ...(context.prefetchState ? { prefetchState: context.prefetchState } : {}),
      });
    }
    const built = modelDecisionOf(
      plan.result,
      input,
      heuristic,
      (depth) => modelVersionOfSeed(
        plan.versionSeed,
        { ...plan.result, depth },
        plan.result.model,
      ),
    );
    if (!built) {
      return fallback(
        'invalid_model_response',
        'invalid_output',
        ['model_invalid_response', 'model_unavailable'],
        { model: plan.result.model, prefetchState: 'hit' },
      );
    }
    const trace = plannerTrace({
      configuredSource,
      resolvedSource: 'local',
      latencyMs: elapsedNow(),
      fallbackReason: null,
      prefetched: true,
      prefetchState: 'hit',
      prefetchAgeMs: context.prefetchAgeMs,
      planId: plan.planId,
      cueMatched: true,
      model: plan.result.model,
      attempts: [{ source: 'local', outcome: 'hit', latencyMs: 0 }],
    });
    return {
      decision: { ...built.decision, planner: trace },
      source: 'local',
      ...(plan.result.model ? { model: plan.result.model } : {}),
      latencyMs: elapsedNow(),
      fromModel: true,
      modelFallback: false,
      warnings: built.warnings,
      prefetched: true,
      fallbackReason: null,
      planner: trace,
    };
  }

  // 2) host：W3 才实现真实 bridge；W2 只保留 0ms 解析 seam，不伪造 host 结果。
  if (resolution.source === 'host') {
    return fallback('host_plan_missing', 'host_plan_missing', ['host_plan_missing'], {
      attempts: [{ source: 'host', outcome: 'unavailable', latencyMs: 0 }],
    });
  }

  if (!context.planner) {
    return fallback('model_unavailable', 'source_unavailable', ['model_unavailable'], {
      attempts: [{ source: 'api', outcome: 'unavailable', latencyMs: elapsedNow() }],
    });
  }

  // 3) api：同步调用只允许这一条路径；硬上限 1.5s，且不重试。
  const budget = resolveSyncBudget(context, now);
  if (budget === null) {
    return fallback('deadline', 'deadline', ['planner_deadline_exceeded'], {
      attempts: [{ source: 'api', outcome: 'timeout', latencyMs: elapsedNow() }],
    });
  }

  const request = buildInterventionInferenceRequest(
    input,
    context.stats,
    context.hasCheckpoint,
    'api',
    context.allowRemote,
  );
  const result = await withinDeadline(
    context.planner.planIntervention(request, { timeoutMs: budget }),
    budget,
  );
  if (!result) {
    return fallback('model_timeout', 'timeout', ['model_timeout'], {
      attempts: [{ source: 'api', outcome: 'timeout', latencyMs: elapsedNow() }],
    });
  }
  if (!result.ok) {
    const reasonCode = result.reasonCode ?? 'model_failed';
    const mapped = fallbackReasonForProvider(reasonCode);
    return fallback(
      reasonCode,
      mapped,
      result.warnings.length > 0 ? result.warnings : ['model_unavailable'],
      {
        ...(result.model ? { model: result.model } : {}),
        attempts: [{
          source: 'api',
          outcome: attemptOutcomeForFallback(mapped),
          latencyMs: Math.max(0, Math.round(result.latencyMs)),
        }],
      },
    );
  }

  const built = modelDecisionOf(
    result,
    input,
    heuristic,
    (depth) => modelVersionOfSeed(interventionVersionSeed(request), { ...result, depth }, result.model),
  );
  if (!built) {
    return fallback(
      'invalid_model_response',
      'invalid_output',
      ['model_invalid_response', 'model_unavailable'],
      {
        ...(result.model ? { model: result.model } : {}),
        attempts: [{
          source: 'api',
          outcome: 'invalid',
          latencyMs: Math.max(0, Math.round(result.latencyMs)),
        }],
      },
    );
  }

  const trace = plannerTrace({
    configuredSource,
    resolvedSource: 'api',
    latencyMs: elapsedNow(),
    fallbackReason: null,
    prefetched: false,
    ...(result.model ? { model: result.model } : {}),
    attempts: [{
      source: 'api',
      outcome: 'hit',
      latencyMs: Math.max(0, Math.round(result.latencyMs)),
    }],
  });
  return {
    decision: { ...built.decision, planner: trace },
    source: 'api',
    ...(result.model ? { model: result.model } : {}),
    latencyMs: elapsedNow(),
    fromModel: true,
    modelFallback: false,
    warnings: built.warnings,
    prefetched: false,
    fallbackReason: null,
    planner: trace,
  };
}

function resolveSyncBudget(
  context: InterventionModelContext,
  now: () => number,
): number | null {
  let budget = Math.max(1, Math.floor(context.timeoutMs));
  if (context.deadlineAt !== undefined) {
    const remaining = context.deadlineAt - now() - INTERVENTION_RESPONSE_RESERVE_MS;
    // W5 会在这里硬化整体 `/context` deadline；W2 只保证不越过剩余预算。
    if (remaining < MIN_PLANNER_BUDGET_MS) return null;
    budget = Math.min(budget, Math.floor(remaining));
  }
  return Math.max(1, Math.min(budget, INTERVENTION_API_SYNC_DEADLINE_MS));
}

function fallbackReasonForProvider(reasonCode: string): InterventionFallbackReason {
  if (reasonCode === 'model_timeout' || reasonCode === 'timeout') return 'timeout';
  if (reasonCode === 'invalid_model_response'
    || reasonCode === 'invalid_json'
    || reasonCode === 'model_invalid_json'
    || reasonCode === 'model_schema_mismatch') {
    return 'invalid_output';
  }
  if (reasonCode === 'remote_not_allowed') return 'allow_remote_false';
  if (reasonCode === 'credential_missing'
    || reasonCode === 'model_credential_missing'
    || reasonCode === 'api_not_configured'
    || reasonCode === 'model_unavailable'
    || reasonCode === 'no_candidates') {
    return 'source_unavailable';
  }
  return 'error';
}

function attemptOutcomeForFallback(
  reason: InterventionFallbackReason,
): InterventionPlannerAttempt['outcome'] {
  if (reason === 'timeout' || reason === 'deadline') return 'timeout';
  if (reason === 'invalid_output') return 'invalid';
  if (reason === 'allow_remote_false') return 'remote_not_allowed';
  if (reason === 'source_unavailable' || reason === 'model_not_installed') return 'unavailable';
  return 'error';
}
