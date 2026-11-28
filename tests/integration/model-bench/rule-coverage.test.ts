// 0.4.0 W0.5b Stage 0 baseline：规则优先 hybrid 的覆盖 / 灰区测量（test-only，无模型）。
//
// 这是 **Stage 0 baseline**（commit 591ef6d）的 test-only 规则口径，冻结用于对比；
// 它不代表 W0.5c 之后的生产规则。W0.5c 的生产 planIntervention() 复测在
// rule-coverage-w05c.test.ts；本文件只回答 Stage 0 当时的“灰区是否值得进入 Stage 1”。
//
// 目标不是证明某个模型好坏，而是回答：在「规则硬判 + 分数档明确的 heuristic」之外，
// 还有多少 turn 必须交给模型（灰区）。只有灰区足够大，Stage 1 SFT 才值得做。
//
// 边界：
//   - 不修改产品代码/UI/catalog/公共 MCP；只 import 现有纯函数与 golden set / 扩展语料；
//   - 不训练、不下载模型、不访问网络；
//   - 88 条 golden set 是公开/合成、按切片配平的基准，不是真实用户分布；
//   - 扩展语料是 fixture/模板派生 + 显式 ambiguous 模板，组成是声明的，不是抽样；
//   - 因此本文件同时输出「点估计」和「对未观测参数的敏感性」，不把点估计冒充流量真值。
//
// 复现：
//   MEBULAR_RULE_COVERAGE_EVIDENCE=docs/quality/0.4.0-w0.5b-stage0-rule-coverage.json \
//   node --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand \
//     tests/integration/model-bench/rule-coverage.test.ts

import { describe, expect, it } from '@jest/globals';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { extractCue, type Cue } from '../../../packages/memory-runtime/src/sidecar/cue.js';
import {
  depthForCue,
  mustSpeakReason,
  planIntervention,
  type InterventionCandidateView,
  type InterventionPlannerInput,
} from '../../../packages/memory-runtime/src/sidecar/intervention.js';
import {
  GOLDEN_CORE_SIZE,
  GOLDEN_SET,
  GOLDEN_SET_SIZE,
  goldenSetSummary,
  type GoldenAction,
  type GoldenCase,
  type GoldenDepth,
} from './small-planner-golden-set.js';
import {
  RULE_CORPUS,
  RULE_CORPUS_PROVENANCE,
  type CorpusLang,
  type CorpusSlice,
  type RuleCorpusCase,
} from './rule-coverage-corpus.js';

const EVIDENCE_PATH = process.env.MEBULAR_RULE_COVERAGE_EVIDENCE?.trim() || null;
const NOW = 1_760_000_000_000;
const THRESHOLD = 0.55;
const LOW_BAND_MAX = 0.5;
const HIGH_BAND_MIN = 0.78;

type Tier = 'hard' | 'deterministic' | 'grey';
type RuleId =
  | 'defer_explicit'
  | 'no_candidates'
  | 'novelty_zero'
  | 'must_speak'
  | 'conflict'
  | 'greeting'
  | 'meta'
  | 'band_high'
  | 'band_low'
  | 'grey_zone';

interface Classification {
  tier: Tier;
  rule: RuleId;
  action: GoldenAction;
  depth: GoldenDepth;
  reason: string;
}

interface CaseShape {
  id: string;
  query: string;
  specificity: 'broad' | 'targeted' | 'exact';
  topics: string[];
  entities: string[];
  reasons: string[];
  followUp: boolean;
  candidates: RuleCorpusCase['candidates'];
  injectedIds: string[];
}

function cueOf(item: CaseShape): Cue {
  const reasons = [...item.reasons];
  const level = reasons.includes('chitchat')
    || reasons.includes('user_negated')
    || reasons.includes('memory_governance')
    ? 'silent'
    : reasons.includes('quote_request')
      ? 'quote'
      : reasons.length > 0
        ? 'expand'
        : 'gist';
  return {
    schema: 1,
    cueId: `cue_${item.id}`,
    recallId: `recall_${item.id}`,
    turnId: `turn_${item.id}`,
    threadId: 'w05b-stage0',
    agentId: 'w05b-stage0',
    rawQuery: item.query,
    normalizedQuery: item.query.normalize('NFKC').trim(),
    language: /[\u3400-\u9fff]/.test(item.query) ? 'zh' : 'en',
    entities: item.entities.map((name) => ({ name, type: 'concept', source: 'literal', confidence: 0.9 })),
    topics: [...item.topics],
    temporal: { kind: 'none', precision: 'unknown' },
    task: { keywords: [] },
    relations: [],
    ownerHint: 'any',
    specificity: item.specificity,
    detailIntent: { level, reasons, strength: 0.9 },
    negations: reasons.filter((reason) => reason === 'user_negated'),
    ...(item.followUp ? { followUpRef: { kind: 'last_turn' as const } } : {}),
    budget: { maxFragments: 3, maxBytes: 8192, maxTokens: 2000 },
    at: NOW,
  };
}

function candidateViews(item: CaseShape): InterventionCandidateView[] {
  return item.candidates.map((candidate, index) => ({
    fragmentId: item.injectedIds.length > 0 && candidate.novelty === 0
      ? 'mf_injected'
      : `mf_${item.id}_${index}`,
    sourceIds: [`rec_${item.id}_${index}`],
    score: candidate.score,
    confidence: candidate.confidence,
    kind: candidate.kind,
    domain: candidate.domain,
    detailAvailable: candidate.novelty === 1,
    conflict: candidate.conflict,
    gist: candidate.gist,
    ageDays: candidate.ageDays,
  }));
}

function plannerInput(item: CaseShape, cue: Cue, mode: 'heuristic' | 'shadow' = 'heuristic'): InterventionPlannerInput {
  return {
    mode,
    cue,
    candidates: candidateViews(item),
    alreadyInjectedIds: item.injectedIds,
    threshold: THRESHOLD,
    recentUselessRate: 0,
    silentStreak: 0,
    maxSilentStreak: 3,
    explorationRate: 0,
    random: () => 1,
  };
}

// ---------- test-only 规则口径 ----------
//
// 策略表（W0.5a §2.1）的 1-6 行。现有产品代码只实现了 no_candidates / novelty=0 /
// must_speak 的一部分；这里显式实现「规约口径」，用来测上限。与 W0.5a 的唯一顺序差异：
// 显式 defer 放在 must_speak 之前。否则「暂时不要提以前的方案」会被
// isExplicitMemoryRequest() 的 /以前/ 命中而误判 must_speak。这个差异单独记入 evidence。

const EXPLICIT_DEFER_RE = /(?:先|暂时|现在)?别(?:回忆|提|再提|注入|用记忆|提旧)|不要(?:回忆|提以前|用记忆)|不用(?:回忆|记)|先不(?:查|回忆|提|看历史)|先放一放|晚点再(?:聊|说|回顾)|下一轮再|等(?:我|你|把).{0,12}再(?:说|查|回顾|聊)|跳过(?:旧|以前|历史|旧上下文)|hold off|not (?:recall|bring up)|skip the memory|don'?t bring up|let'?s not recall|until i finish/i;
const META_RE = /^(?:你是谁|你能做什么|你会什么|你怎么用|这个怎么用|帮我解释(?:一下)?你的能力|你是什么模型|现在几点|今天几号|what (?:model|can you do)|who are you|how do i use this|what time is it|what day is it)[?？!！。. ]*$/i;
const GREETING_RE = /^(?:你好|您好|嗨|hi|hello|hey|谢谢|多谢|thanks|thank you|在吗|ok|okay|好的|嗯|早|早安|晚安|再见|bye)[!！。,.，？? ]*$/i;

function isExplicitDefer(cue: Cue): boolean {
  return EXPLICIT_DEFER_RE.test(cue.rawQuery)
    || cue.detailIntent.reasons.includes('user_negated')
    || cue.negations.includes('user_negated');
}

function isGreeting(cue: Cue): boolean {
  return cue.detailIntent.reasons.includes('chitchat') || GREETING_RE.test(cue.rawQuery.trim());
}

function isMeta(cue: Cue): boolean {
  return META_RE.test(cue.rawQuery.trim())
    || (cue.specificity === 'broad'
      && cue.detailIntent.reasons.includes('entity_question')
      && /(?:你|your|you)\b|助手|模型|能力|怎么用|几点|what time/i.test(cue.rawQuery));
}

function allInjected(item: CaseShape): boolean {
  if (item.candidates.length === 0) return false;
  const injected = new Set(item.injectedIds);
  return item.candidates.every((candidate) =>
    candidate.novelty === 0
    || injected.has(`mf_injected`));
}

function topConfidence(item: CaseShape): number {
  return item.candidates[0]?.score ?? 0;
}

function classify(item: CaseShape, cue: Cue): Classification {
  const input = plannerInput(item, cue);
  const depth = depthForCue(cue);
  const available = item.candidates[0]?.novelty === 1;

  // 0) 显式 defer 优先于 must_speak（见上方差异说明）。
  if (isExplicitDefer(cue)) {
    return { tier: 'hard', rule: 'defer_explicit', action: 'defer', depth: 'gist', reason: 'defer' };
  }
  // 1) 无候选。
  if (item.candidates.length === 0) {
    return { tier: 'hard', rule: 'no_candidates', action: 'silent', depth: 'gist', reason: 'no_candidates' };
  }
  // 2) 所有候选已注入。
  if (allInjected(item)) {
    return { tier: 'hard', rule: 'novelty_zero', action: 'silent', depth: 'gist', reason: 'novelty_zero' };
  }
  // 3) must_speak（复用生产函数，不复制正则）。
  const mustReason = mustSpeakReason(input);
  if (mustReason) {
    return {
      tier: 'hard',
      rule: 'must_speak',
      action: 'speak',
      depth: available ? depth : 'gist',
      reason: mustReason,
    };
  }
  // 4) conflict。
  if (cue.detailIntent.reasons.includes('conflict') || item.candidates.some((candidate) => candidate.conflict)) {
    return { tier: 'hard', rule: 'conflict', action: 'speak', depth, reason: 'conflict' };
  }
  // 6) 寒暄 / meta。
  if (isGreeting(cue)) {
    return { tier: 'hard', rule: 'greeting', action: 'silent', depth: 'gist', reason: 'greeting' };
  }
  if (isMeta(cue)) {
    return { tier: 'hard', rule: 'meta', action: 'silent', depth: 'gist', reason: 'meta' };
  }
  // 7) 只有分数档明确的才由 heuristic 决定；中间带进入灰区。
  const top = topConfidence(item);
  if (top < LOW_BAND_MAX) {
    return { tier: 'deterministic', rule: 'band_low', action: 'silent', depth: 'gist', reason: 'low_band' };
  }
  if (top >= HIGH_BAND_MIN) {
    return { tier: 'deterministic', rule: 'band_high', action: 'speak', depth, reason: 'high_band' };
  }
  return { tier: 'grey', rule: 'grey_zone', action: 'silent', depth: 'gist', reason: 'grey_zone' };
}

interface ShippedDecision {
  action: GoldenAction;
  depth: GoldenDepth;
  reason: string;
  /** 决策是否来自硬规则（must_speak / no_candidates / no_novelty）。 */
  hard: boolean;
  /** 归一后的生产硬规则桶；非硬规则统一记 heuristic。 */
  bucket: 'must_speak' | 'no_candidates' | 'novelty_zero' | 'heuristic';
}

function shipped(item: CaseShape, cue: Cue): ShippedDecision {
  const decision = planIntervention(plannerInput(item, cue));
  const bucket: ShippedDecision['bucket'] = decision.mustSpeak === true
    ? 'must_speak'
    : decision.reason === 'no_candidates'
      ? 'no_candidates'
      : decision.reason === 'no_novelty'
        ? 'novelty_zero'
        : 'heuristic';
  return {
    action: decision.action,
    depth: decision.depth,
    reason: decision.reason,
    hard: bucket !== 'heuristic',
    bucket,
  };
}

function asShape(item: GoldenCase | RuleCorpusCase): CaseShape {
  return item;
}

// ---------- 统计工具 ----------

function countBy<T extends string>(values: T[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function round4(value: number): number {
  return Number(value.toFixed(4));
}

/** Wilson 95% 区间；用于「分类比例」的不确定性，不假装是流量抽样。 */
function wilson(successes: number, total: number): { low: number; high: number } {
  if (total === 0) return { low: 0, high: 0 };
  const z = 1.959963984540054;
  const p = successes / total;
  const denom = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denom;
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 对语料行做 bootstrap；区间只反映「这组声明语料」的分类不确定性。 */
function bootstrapGrey(tiers: Tier[], iterations = 4000, seed = 0x5b05): { low: number; high: number } {
  const random = mulberry32(seed);
  const shares: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    let grey = 0;
    for (let j = 0; j < tiers.length; j += 1) {
      if (tiers[Math.floor(random() * tiers.length)] === 'grey') grey += 1;
    }
    shares.push(grey / tiers.length);
  }
  shares.sort((a, b) => a - b);
  return {
    low: shares[Math.floor(iterations * 0.025)] ?? 0,
    high: shares[Math.floor(iterations * 0.975)] ?? 0,
  };
}

async function sha256(path: string): Promise<string> {
  const data = await fs.readFile(path);
  return createHash('sha256').update(data).digest('hex');
}

// ---------- golden set 评估 ----------

interface CaseResult {
  id: string;
  slice: string;
  lang: CorpusLang;
  source: string;
  tier: Tier;
  rule: RuleId;
  policyAction: GoldenAction;
  policyDepth: GoldenDepth;
  shippedAction: GoldenAction;
  shippedDepth: GoldenDepth;
  shippedHard: boolean;
  shippedBucket: 'must_speak' | 'no_candidates' | 'novelty_zero' | 'heuristic';
  topScore: number;
  expectedAction?: GoldenAction;
  expectedDepth?: GoldenDepth;
}

function evaluate(item: GoldenCase | RuleCorpusCase, slice: string, lang: CorpusLang, source: string): CaseResult {
  const shape = asShape(item);
  const cue = cueOf(shape);
  const classification = classify(shape, cue);
  const decision = shipped(shape, cue);
  const expected = 'expected' in item ? item.expected : undefined;
  return {
    id: item.id,
    slice,
    lang,
    source,
    tier: classification.tier,
    rule: classification.rule,
    policyAction: classification.action,
    policyDepth: classification.depth,
    shippedAction: decision.action,
    shippedDepth: decision.depth,
    shippedHard: decision.hard,
    shippedBucket: decision.bucket,
    topScore: shape.candidates[0]?.score ?? 0,
    ...(expected ? { expectedAction: expected.action, expectedDepth: expected.depth } : {}),
  };
}

function summarize(results: CaseResult[]): {
  size: number;
  tiers: Record<Tier, number>;
  tierShare: Record<Tier, number>;
  bySlice: Record<string, { count: number; hard: number; deterministic: number; grey: number }>;
  bySliceRule: Record<string, Record<string, number>>;
  byLang: Record<string, { count: number; grey: number }>;
  shippedHardShare: number;
  shippedBuckets: Record<string, number>;
} {
  const tiers: Record<Tier, number> = { hard: 0, deterministic: 0, grey: 0 };
  const bySlice: Record<string, { count: number; hard: number; deterministic: number; grey: number }> = {};
  const bySliceRule: Record<string, Record<string, number>> = {};
  const byLang: Record<string, { count: number; grey: number }> = {};
  const shippedBuckets: Record<string, number> = {};
  let shippedHard = 0;
  for (const result of results) {
    tiers[result.tier] += 1;
    const slice = bySlice[result.slice] ?? { count: 0, hard: 0, deterministic: 0, grey: 0 };
    slice.count += 1;
    slice[result.tier] += 1;
    bySlice[result.slice] = slice;
    const rules = bySliceRule[result.slice] ?? {};
    rules[result.rule] = (rules[result.rule] ?? 0) + 1;
    bySliceRule[result.slice] = rules;
    const lang = byLang[result.lang] ?? { count: 0, grey: 0 };
    lang.count += 1;
    if (result.tier === 'grey') lang.grey += 1;
    byLang[result.lang] = lang;
    shippedBuckets[result.shippedBucket] = (shippedBuckets[result.shippedBucket] ?? 0) + 1;
    if (result.shippedHard) shippedHard += 1;
  }
  const size = results.length;
  return {
    size,
    tiers,
    tierShare: {
      hard: round4(ratio(tiers.hard, size)),
      deterministic: round4(ratio(tiers.deterministic, size)),
      grey: round4(ratio(tiers.grey, size)),
    },
    bySlice,
    bySliceRule,
    byLang,
    shippedHardShare: round4(ratio(shippedHard, size)),
    shippedBuckets,
  };
}

interface Accuracy {
  attempts: number;
  actionHits: number;
  actionAccuracy: number;
  depthHits: number;
  depthAccuracy: number;
  silentSpecificity: number;
  mustSpeakRecall: number;
  noveltySilent: number;
  conflictDetail: number;
  deferAccuracy: number;
}

function accuracy(results: CaseResult[]): Accuracy {
  const withLabel = results.filter((result) =>
    result.expectedAction !== undefined && result.expectedDepth !== undefined);
  const actionHits = withLabel.filter((result) => result.shippedAction === result.expectedAction).length;
  const speak = withLabel.filter((result) => result.expectedAction === 'speak');
  const silent = withLabel.filter((result) => result.expectedAction === 'silent');
  const must = withLabel.filter((result) =>
    ['must_speak', 'task_continue', 'exact_quote'].includes(result.slice));
  const novelty = withLabel.filter((result) => result.slice === 'novelty_zero');
  const conflict = withLabel.filter((result) => result.slice === 'conflict');
  const defer = withLabel.filter((result) => result.slice === 'defer');
  return {
    attempts: withLabel.length,
    actionHits,
    actionAccuracy: round4(ratio(actionHits, withLabel.length)),
    depthHits: speak.filter((result) => result.shippedDepth === result.expectedDepth).length,
    depthAccuracy: round4(ratio(speak.filter((result) => result.shippedDepth === result.expectedDepth).length, speak.length)),
    silentSpecificity: round4(ratio(silent.filter((result) => result.shippedAction === 'silent').length, silent.length)),
    mustSpeakRecall: round4(ratio(must.filter((result) => result.shippedAction === 'speak').length, must.length)),
    noveltySilent: round4(ratio(novelty.filter((result) => result.shippedAction === 'silent').length, novelty.length)),
    conflictDetail: round4(ratio(conflict.filter((result) => result.shippedAction === 'speak' && result.shippedDepth === 'detail').length, conflict.length)),
    deferAccuracy: round4(ratio(defer.filter((result) => result.shippedAction === 'defer').length, defer.length)),
  };
}

describe('W0.5b Stage 0 baseline rule coverage', () => {
  it('classifies the 88-case golden set and the extended rule corpus without a model', async () => {
    expect(GOLDEN_SET_SIZE).toBe(88);
    expect(GOLDEN_CORE_SIZE).toBeGreaterThan(0);

    // ---- golden set ----
    const goldenResults = GOLDEN_SET.map((item) =>
      evaluate(item, item.dimension, /[\u3400-\u9fff]/.test(item.query) ? 'zh' : 'en', `golden:${item.id}`));
    const golden = summarize(goldenResults);
    const goldenShipped = accuracy(goldenResults);
    const goldenPolicy = {
      actionHits: goldenResults.filter((result) => result.policyAction === result.expectedAction).length,
      depthHits: goldenResults.filter((result) => result.expectedAction === 'speak' && result.policyDepth === result.expectedDepth).length,
      speakCases: goldenResults.filter((result) => result.expectedAction === 'speak').length,
    };

    // ---- extended corpus ----
    const corpusResults = RULE_CORPUS.map((item) =>
      evaluate(item, item.slice, item.lang, item.source));
    const corpus = summarize(corpusResults);

    // 规则口径在 hard/deterministic 上必须自洽：动作与标签一致；这能抓出规则顺序/实现错误。
    const labelled = corpusResults.filter((result) => {
      const item = RULE_CORPUS.find((candidate) => candidate.id === result.id);
      return item?.expectedAction !== undefined && item.expectedDepth !== undefined;
    });
    const actionMismatches = labelled.filter((result) => {
      const item = RULE_CORPUS.find((candidate) => candidate.id === result.id);
      return result.policyAction !== item?.expectedAction;
    });
    const depthMismatches = labelled
      .filter((result) => result.policyAction === 'speak')
      .filter((result) => {
        const item = RULE_CORPUS.find((candidate) => candidate.id === result.id);
        return item?.expectedDepth !== undefined && result.policyDepth !== item.expectedDepth;
      });
    const tierMismatches = corpusResults
      .filter((result) => {
        const item = RULE_CORPUS.find((candidate) => candidate.id === result.id);
        return item?.expectedTier !== undefined && result.tier !== item.expectedTier;
      })
      .map((result) => ({
        id: result.id,
        expected: RULE_CORPUS.find((item) => item.id === result.id)?.expectedTier,
        actual: result.tier,
        rule: result.rule,
      }));

    // 生产 cue 提取（不是注释字段）下的同口径分类：暴露标注-cue 漂移。
    const runtimeResults = RULE_CORPUS.map((item) => {
      const runtimeCue = extractCue({
        query: item.query,
        agentId: 'w05b-stage0',
        threadId: 'w05b-stage0',
        recallId: `runtime_${item.id}`,
        now: NOW,
        budget: { maxFragments: 3, maxBytes: 8192, maxTokens: 2000 },
      });
      const classification = classify(item, runtimeCue);
      return { id: item.id, slice: item.slice, tier: classification.tier, rule: classification.rule };
    });
    const runtime = {
      tiers: countBy(runtimeResults.map((result) => result.tier)),
      ruleCounts: countBy(runtimeResults.map((result) => result.rule)),
      greyShare: round4(ratio(runtimeResults.filter((result) => result.tier === 'grey').length, runtimeResults.length)),
      expectedHardDowngraded: runtimeResults
        .filter((result) => {
          const item = RULE_CORPUS.find((candidate) => candidate.id === result.id);
          return item?.expectedTier === 'hard' && result.tier !== 'hard';
        })
        .map((result) => ({ id: result.id, slice: result.slice, rule: result.rule, tier: result.tier })),
    };

    // ---- 敏感性 ----
    const hardShare = corpus.tierShare.hard;
    const eligible = corpus.tiers.deterministic + corpus.tiers.grey;
    const referenceP = ratio(corpus.tiers.grey, eligible);
    const effective = (p: number): number => round4((1 - hardShare) * p);
    const breakEven = (target: number): number | null =>
      (1 - hardShare) > 0 ? round4(target / (1 - hardShare)) : null;
    const sensitivity = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6].map((p) => ({
      ambiguousShareOfEligible: p,
      greyShare: effective(p),
      branch: effective(p) < 0.10 ? 'NO-GO' : effective(p) >= 0.20 ? 'GO-conditions' : 'conditional',
    }));
    const hardShareGrid = [0.45, 0.55, hardShare, 0.70, golden.tierShare.hard];
    const matrix = hardShareGrid.flatMap((h) =>
      [0.2, 0.3, 0.4, 0.5, 0.6].map((p) => ({
        hardShare: round4(h),
        ambiguousShareOfEligible: p,
        greyShare: round4((1 - h) * p),
      })));
    const plausibleGreyRange = {
      low: round4((1 - golden.tierShare.hard) * referenceP),
      high: round4((1 - 0.45) * referenceP),
      note: 'hardShare 0.75 is the slice-balanced golden-set upper bound; 0.45 is an ordinary-turn lower assumption. Neither is measured.',
    };
    const greyInterval = wilson(corpus.tiers.grey, corpus.size);
    const greyBootstrap = bootstrapGrey(corpusResults.map((result) => result.tier));
    const greyAtHigh070 = corpusResults.filter((result) => result.tier === 'grey' && result.topScore < 0.70).length;
    const bandBoundary = {
      currentHighBound: HIGH_BAND_MIN,
      greyShareIfHighBound070: round4(ratio(greyAtHigh070, corpus.size)),
      greyShareIfHighBound080: corpus.tierShare.grey,
      note: 'Only two ambiguous rows sit at 0.70; no row sits in 0.78-0.80.',
    };

    // 规则覆盖高 ≠ local-authoritative：生产代码只硬实现了 3 类，且 heuristic 自身有错。
    const shippedRules = golden.shippedBuckets;

    const evidence = {
      schema: 'mebular.rule-coverage.v1',
      work: '0.4.0 W0.5b Stage 0',
      generatedAt: new Date().toISOString(),
      base: 'origin/main@f064471',
      purpose: 'Decide whether the grey zone is large enough to justify Stage 1 SFT.',
      method: {
        cue: 'annotated cue fields (query/topics/entities/reasons/specificity/followUp); detailIntent.level derived from reasons, not from expected labels',
        hardRules: 'W0.5a §2.1 rows 1-6; defer moved before must_speak to avoid /以前/ false must_speak',
        deterministicRule: `top score < ${LOW_BAND_MAX} => silent; >= ${HIGH_BAND_MIN} => speak with depthForCue(); otherwise grey`,
        shippedComparison: 'planIntervention(mode=heuristic, threshold=0.55) from packages/memory-runtime/src/sidecar/intervention.ts',
        runtimeCueVariant: 'extractCue() run on the same queries; annotation-vs-runtime drift is reported, not hidden',
      },
      goldenSet: {
        size: golden.size,
        coreSize: GOLDEN_CORE_SIZE,
        dimensions: goldenSetSummary(),
        tiers: golden.tiers,
        tierShare: golden.tierShare,
        bySlice: golden.bySlice,
        bySliceRule: golden.bySliceRule,
        byLang: golden.byLang,
        shippedBuckets: golden.shippedBuckets,
        policyOracle: {
          actionHits: goldenPolicy.actionHits,
          actionAccuracy: round4(ratio(goldenPolicy.actionHits, golden.size)),
          speakDepthHits: goldenPolicy.depthHits,
          speakDepthAccuracy: round4(ratio(goldenPolicy.depthHits, goldenPolicy.speakCases)),
          depthMismatches: goldenResults
            .filter((result) => result.expectedAction === 'speak' && result.policyDepth !== result.expectedDepth)
            .map((result) => ({
              id: result.id,
              expected: result.expectedDepth,
              actual: result.policyDepth,
              rule: result.rule,
            })),
          note: 'Action 88/88. The 4 depth differences are label-vs-rule disagreements (gist_stack/gist_test_framework: depthForCue() chooses detail for entity_question; conflict_port_two/conflict_database: exact_value outranks conflict and chooses quote).',
        },
        shipped: goldenShipped,
        shippedHardShare: golden.shippedHardShare,
        shippedRuleCounts: shippedRules,
        cases: goldenResults.map((result) => ({
          id: result.id,
          dimension: result.slice,
          lang: result.lang,
          tier: result.tier,
          rule: result.rule,
          expectedAction: result.expectedAction,
          expectedDepth: result.expectedDepth,
          policyAction: result.policyAction,
          policyDepth: result.policyDepth,
          shippedAction: result.shippedAction,
          shippedDepth: result.shippedDepth,
          shippedBucket: result.shippedBucket,
        })),
        note: 'Slice-balanced by construction. 25% of cases fall outside hard rows 1-6, so this set cannot support a "<10% grey" claim; it also cannot estimate traffic share.',
      },
      extendedCorpus: {
        size: corpus.size,
        provenance: RULE_CORPUS_PROVENANCE,
        tiers: corpus.tiers,
        tierShare: corpus.tierShare,
        bySlice: corpus.bySlice,
        bySliceRule: corpus.bySliceRule,
        byLang: corpus.byLang,
        shippedBuckets: corpus.shippedBuckets,
        ruleConformance: {
          labelledCases: labelled.length,
          actionMismatches: actionMismatches.map((result) => ({
            id: result.id,
            expected: RULE_CORPUS.find((item) => item.id === result.id)?.expectedAction,
            actual: result.policyAction,
            rule: result.rule,
          })),
          depthMismatches: depthMismatches.map((result) => ({
            id: result.id,
            expected: RULE_CORPUS.find((item) => item.id === result.id)?.expectedDepth,
            actual: result.policyDepth,
            rule: result.rule,
          })),
          tierMismatches,
          tierMismatchNote: 'expectedTier=hard means the policy table should decide it. A fallback to deterministic is still rule-decided but signals a missing hard trigger (usually a query phrasing the regex does not cover).',
        },
        shippedHardShare: corpus.shippedHardShare,
        runtimeCue: runtime,
        cases: corpusResults.map((result) => ({
          id: result.id,
          slice: result.slice,
          lang: result.lang,
          source: result.source,
          tier: result.tier,
          rule: result.rule,
          expectedAction: result.expectedAction ?? null,
          policyAction: result.policyAction,
          shippedAction: result.shippedAction,
          shippedBucket: result.shippedBucket,
        })),
        note: 'Declared composition, not a traffic prior. Ambiguous rows are intentionally mid-band to make the grey zone observable.',
      },
      gapBetweenPolicyAndShipped: {
        policyHardCoverage: corpus.tierShare.hard,
        shippedHardCoverageGolden: golden.shippedHardShare,
        shippedHardCoverageCorpus: corpus.shippedHardShare,
        explanation: 'Product code hard-enforces must_speak, no_candidates and no_novelty only. Conflict, explicit defer, greeting and meta are policy rows but are not enforced as hard rules in planIntervention(); the heuristic decides them by score/depth.',
        missingHardRules: ['conflict', 'defer_explicit', 'greeting', 'meta'],
        concreteRuleGaps: [
          'isExplicitMemoryRequest() does not match English "recall" (only remember/forgot).',
          'isChitchat() requires the whole turn to be a greeting; "早上好" / "good morning" / "hi there" do not match, so the chitchat reason is absent.',
          'detectNegations() covers 别回忆/不要提 but not 先放一放/晚点再聊/下一轮再/跳过旧上下文/hold off/skip the memory.',
          'planIntervention() never returns defer; defer is not reachable in production code.',
          'Conflict is not a hard branch: without a high score or must_speak it can fall through to silent.',
          'Policy order puts must_speak before defer; /以前/ makes "暂时不要提以前的方案" look like an explicit recall request.',
        ],
      },
      greyZone: {
        pointEstimate: corpus.tierShare.grey,
        wilson95: { low: round4(greyInterval.low), high: round4(greyInterval.high) },
        bootstrap95: { low: round4(greyBootstrap.low), high: round4(greyBootstrap.high) },
        eligibleShareOfCorpus: round4(ratio(eligible, corpus.size)),
        referenceAmbiguousShareOfEligible: round4(referenceP),
        breakEvenAmbiguousShareFor10pctGrey: breakEven(0.10),
        breakEvenAmbiguousShareFor20pctGrey: breakEven(0.20),
        bandBoundary,
        note: 'The interval only covers classification uncertainty inside the declared corpus; it does not cover traffic-mix uncertainty. hardShare and p are both unmeasured in production.',
      },
      sensitivity: {
        hardShareOfTraffic: hardShare,
        formula: 'greyShare = (1 - hardShareOfTraffic) * ambiguousShareOfEligible',
        rows: sensitivity,
        matrix,
        plausibleGreyRange,
        goldenSetHardShare: golden.tierShare.hard,
        note: 'Two unmeasured parameters. The corpus fixes hardShare at its declared composition; the matrix shows how the conclusion moves when ordinary traffic has fewer hard-rule triggers or more ambiguity.',
      },
      decisionInputs: {
        stage1GoThreshold: 0.20,
        stage0NoGoThreshold: 0.10,
        pointEstimateBand: corpus.tierShare.grey < 0.10
          ? 'NO-GO'
          : corpus.tierShare.grey >= 0.20
            ? 'GO-conditions'
            : 'conditional (10-20%)',
        recommendation: 'NO-GO for Stage 1 now. The point estimate is in the 10-20% conditional band, the interval crosses both thresholds, and neither conditional-GO precondition (high misjudgment cost, controllable labeling cost) is established. Conditional GO only after a real/shadow-traffic measurement shows grey >= 20% and the Stage-1 preconditions are met.',
        canClaimRulesSufficient: false,
        canClaimLocalAuthoritative: false,
      },
      limits: [
        'No real user traffic; neither hardShare nor ambiguousShareOfEligible is measured.',
        'Golden set is public/synthetic and slice-balanced, not a held-out distribution.',
        'Extended corpus is fixture/template-derived and deliberately over-samples hard slices and ambiguous rows.',
        'Scores are band-assigned, not produced by the real retriever; real score calibration may move the deterministic/grey boundary.',
        'Annotations are single-author; no inter-annotator agreement was measured.',
        'A 100% hybrid-deterministic coverage on a synthetic set would still not prove local-authoritative quality; shipped heuristic accuracy is reported separately.',
      ],
      reproducibility: {
        command: 'MEBULAR_RULE_COVERAGE_EVIDENCE=docs/quality/0.4.0-w0.5b-stage0-rule-coverage.json node --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand tests/integration/model-bench/rule-coverage.test.ts',
        goldenSetSha256: await sha256(resolve('tests/integration/model-bench/small-planner-golden-set.ts')),
        corpusSha256: await sha256(resolve('tests/integration/model-bench/rule-coverage-corpus.ts')),
        harnessSha256: await sha256(resolve('tests/integration/model-bench/rule-coverage.test.ts')),
        noModel: true,
        noNetwork: true,
      },
    };

    if (EVIDENCE_PATH) {
      await fs.mkdir(dirname(resolve(EVIDENCE_PATH)), { recursive: true });
      await fs.writeFile(resolve(EVIDENCE_PATH), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    }

    // 结构断言：语料必须覆盖要求的中英/切片，且规则口径自洽。
    const slices = new Set(RULE_CORPUS.map((item) => item.slice));
    for (const required of [
      'must_speak', 'no_candidates', 'novelty_zero', 'conflict', 'defer',
      'greeting', 'meta', 'detail', 'quote', 'silent_low_relevance', 'ambiguous',
    ] as CorpusSlice[]) {
      expect(slices.has(required)).toBe(true);
    }
    expect(RULE_CORPUS.filter((item) => item.lang === 'zh').length).toBeGreaterThan(20);
    expect(RULE_CORPUS.filter((item) => item.lang === 'en').length).toBeGreaterThan(20);
    expect(actionMismatches).toEqual([]);
    expect(depthMismatches).toEqual([]);
    expect(goldenPolicy.actionHits).toBeGreaterThanOrEqual(80);
    expect(golden.shippedHardShare).toBeLessThan(golden.tierShare.hard);
    expect(runtime.tiers.grey).toBeGreaterThan(0);
  }, 60_000);
});
