// 0.4.0 W0.5c：规则层补洞后的复测（test-only，无模型）。
//
// Stage 0（591ef6d）证明：灰区点估计 15.15%，但生产 planIntervention() 只硬实现了
// must_speak / no_candidates / novelty=0，conflict / defer / 寒暄 / meta 没有硬分支，
// defer 甚至不可达。W0.5c 只补这些规则，然后用同一套 Stage 0 harness/corpus 复测：
//   - 生产硬规则覆盖率（shipped hard coverage）从 38.6% / 53.4% 提升到多少；
//   - 灰区占比是否仍是 15.15%（规则修复不改变语料的声明组成，除非残留触发词洞）；
//   - 各切片残余洞（尤其 runtime cue 与注释 cue 的漂移）。
//
// 边界：只 import 现有纯函数与 test-only corpus；不训练、不下载模型、不访问网络。
// 语料组成是声明的，不是真实用户分布；灰区区间只覆盖分类不确定性。

import { describe, expect, it } from '@jest/globals';
import { promises as fs } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { extractCue, type Cue } from '../../../packages/memory-runtime/src/sidecar/cue.js';
import {
  planIntervention,
  type InterventionCandidateView,
  type InterventionPlannerInput,
} from '../../../packages/memory-runtime/src/sidecar/intervention.js';
import { GOLDEN_SET } from './small-planner-golden-set.js';
import { RULE_CORPUS, type RuleCorpusCase } from './rule-coverage-corpus.js';

const EVIDENCE_PATH = process.env.MEBULAR_RULE_RETEST_EVIDENCE?.trim() || null;
const NOW = 1_760_000_000_000;
const THRESHOLD = 0.55;

/** Stage 0 evidence 的固定点估计；用于复测对比，不重新拟合。 */
const STAGE0 = Object.freeze({
  goldenShippedHardShare: 0.5341,
  corpusShippedHardShare: 0.3864,
  corpusGrey: 20,
  corpusSize: 132,
  corpusGreyShare: 0.1515,
});

type Bucket =
  | 'defer'
  | 'conflict'
  | 'greeting'
  | 'meta'
  | 'must_speak'
  | 'no_candidates'
  | 'novelty_zero'
  | 'heuristic';

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
    cueId: `cue_w05c_${item.id}`,
    recallId: `recall_w05c_${item.id}`,
    turnId: `turn_w05c_${item.id}`,
    threadId: 'w05c-rules',
    agentId: 'w05c-rules',
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

function runtimeCueOf(item: CaseShape): Cue {
  return extractCue({
    query: item.query,
    agentId: 'w05c-rules',
    threadId: 'w05c-rules',
    recallId: `runtime_w05c_${item.id}`,
    now: NOW,
    budget: { maxFragments: 3, maxBytes: 8192, maxTokens: 2000 },
  });
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

function plannerInput(item: CaseShape, cue: Cue): InterventionPlannerInput {
  return {
    mode: 'heuristic',
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

function bucketOf(decision: ReturnType<typeof planIntervention>): Bucket {
  if (decision.action === 'defer') return 'defer';
  switch (decision.reason) {
    case 'conflict':
      return 'conflict';
    case 'greeting':
      return 'greeting';
    case 'meta':
      return 'meta';
    case 'no_candidates':
    case 'must_speak_unavailable':
      return 'no_candidates';
    case 'no_novelty':
      return 'novelty_zero';
    default:
      break;
  }
  return decision.mustSpeak === true ? 'must_speak' : 'heuristic';
}

function isHard(bucket: Bucket): boolean {
  return bucket !== 'heuristic';
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function round4(value: number): number {
  return Number(value.toFixed(4));
}

function countBy<T extends string>(values: T[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

function asShape(item: RuleCorpusCase | (typeof GOLDEN_SET)[number]): CaseShape {
  return item;
}

interface CaseOutcome {
  id: string;
  slice: string;
  lang: string;
  source: string;
  tier: string;
  bucket: Bucket;
  hard: boolean;
  action: string;
  depth: string;
  reason: string;
  topScore: number;
  expectedAction?: string;
  expectedDepth?: string;
}

function outcomeOf(
  item: RuleCorpusCase | (typeof GOLDEN_SET)[number],
  slice: string,
  lang: string,
  source: string,
  tier: string,
  useRuntimeCue: boolean,
): CaseOutcome {
  const shape = asShape(item);
  const cue = useRuntimeCue ? runtimeCueOf(shape) : cueOf(shape);
  const decision = planIntervention(plannerInput(shape, cue));
  const bucket = bucketOf(decision);
  const expected = 'expected' in item
    ? item.expected
    : item.expectedAction !== undefined && item.expectedDepth !== undefined
      ? { action: item.expectedAction, depth: item.expectedDepth }
      : undefined;
  return {
    id: item.id,
    slice,
    lang,
    source,
    tier,
    bucket,
    hard: isHard(bucket),
    action: decision.action,
    depth: decision.depth,
    reason: decision.reason,
    topScore: shape.candidates[0]?.score ?? 0,
    ...(expected ? { expectedAction: expected.action, expectedDepth: expected.depth } : {}),
  };
}

function sliceSummary(outcomes: CaseOutcome[]): Record<string, {
  count: number;
  hard: number;
  heuristic: number;
  grey: number;
  actions: Record<string, number>;
}> {
  const out: Record<string, {
    count: number;
    hard: number;
    heuristic: number;
    grey: number;
    actions: Record<string, number>;
  }> = {};
  for (const outcome of outcomes) {
    const slice = out[outcome.slice] ?? { count: 0, hard: 0, heuristic: 0, grey: 0, actions: {} };
    slice.count += 1;
    if (outcome.hard) slice.hard += 1;
    else slice.heuristic += 1;
    if (outcome.tier === 'grey') slice.grey += 1;
    slice.actions[outcome.action] = (slice.actions[outcome.action] ?? 0) + 1;
    out[outcome.slice] = slice;
  }
  return out;
}

describe('W0.5c rule-layer retest', () => {
  it('re-measures hard-rule coverage and the grey zone on the Stage 0 corpus', async () => {
    // ---- extended corpus：注释 cue 与 runtime cue 各跑一遍生产 planIntervention() ----
    const annotated = RULE_CORPUS.map((item) =>
      outcomeOf(item, item.slice, item.lang, item.source, item.expectedTier, false));
    const runtime = RULE_CORPUS.map((item) =>
      outcomeOf(item, item.slice, item.lang, item.source, item.expectedTier, true));

    const annotatedHard = annotated.filter((outcome) => outcome.hard).length;
    const runtimeHard = runtime.filter((outcome) => outcome.hard).length;
    const corpusSize = RULE_CORPUS.length;
    const grey = RULE_CORPUS.filter((item) => item.expectedTier === 'grey').length;

    const expectedActionMismatches = annotated
      .filter((outcome) => outcome.expectedAction !== undefined && outcome.action !== outcome.expectedAction)
      .map((outcome) => ({
        id: outcome.id,
        slice: outcome.slice,
        expected: outcome.expectedAction,
        actual: outcome.action,
        reason: outcome.reason,
      }));
    const expectedDepthMismatches = annotated
      .filter((outcome) => outcome.action === 'speak'
        && outcome.expectedDepth !== undefined
        && outcome.depth !== outcome.expectedDepth)
      .map((outcome) => ({
        id: outcome.id,
        slice: outcome.slice,
        expected: outcome.expectedDepth,
        actual: outcome.depth,
        reason: outcome.reason,
      }));

    // runtime cue 下预期硬判但仍落回 heuristic 的洞：这是「注释-cue 漂移」而非产品回归。
    const runtimeDowngraded = runtime
      .filter((outcome) => outcome.tier === 'hard' && !outcome.hard)
      .map((outcome) => ({
        id: outcome.id,
        slice: outcome.slice,
        reason: outcome.reason,
        action: outcome.action,
      }));
    const runtimeActionMismatches = runtime
      .filter((outcome) => outcome.expectedAction !== undefined && outcome.action !== outcome.expectedAction)
      .map((outcome) => ({
        id: outcome.id,
        slice: outcome.slice,
        expected: outcome.expectedAction,
        actual: outcome.action,
        reason: outcome.reason,
      }));

    // ---- golden set：88 条上的生产硬判覆盖与 action 正确率 ----
    const golden = GOLDEN_SET.map((item) =>
      outcomeOf(
        item,
        item.dimension,
        /[\u3400-\u9fff]/.test(item.query) ? 'zh' : 'en',
        `golden:${item.id}`,
        'n/a',
        false,
      ));
    const goldenHard = golden.filter((outcome) => outcome.hard).length;
    const goldenActionHits = golden
      .filter((outcome) => outcome.expectedAction !== undefined && outcome.action === outcome.expectedAction).length;
    const goldenSpeak = golden.filter((outcome) => outcome.expectedAction === 'speak');
    const goldenDepthHits = goldenSpeak
      .filter((outcome) => outcome.depth === outcome.expectedDepth).length;
    const goldenDepthMismatches = goldenSpeak
      .filter((outcome) => outcome.depth !== outcome.expectedDepth)
      .map((outcome) => ({
        id: outcome.id,
        slice: outcome.slice,
        expected: outcome.expectedDepth,
        actual: outcome.depth,
        reason: outcome.reason,
      }));
    const goldenDefer = golden.filter((outcome) => outcome.slice === 'defer');
    const goldenConflict = golden.filter((outcome) => outcome.slice === 'conflict');
    const goldenConflictByReason = goldenConflict.filter((outcome) => outcome.reason === 'conflict');
    const goldenConflictQuote = goldenConflictByReason.filter((outcome) => outcome.depth === 'quote');
    const goldenConflictDetail = goldenConflictByReason.filter((outcome) => outcome.depth === 'detail');
    const goldenConflictNonExplicit = goldenConflict.filter((outcome) => outcome.reason !== 'conflict');
    const goldenGreetingMeta = golden.filter((outcome) =>
      outcome.slice === 'greeting' || outcome.slice === 'meta');

    const evidence = {
      schema: 'mebular.rule-coverage-retest.v1',
      work: '0.4.0 W0.5c rule-layer retest',
      generatedAt: new Date().toISOString(),
      base: 'origin/main@f064471',
      stage0: {
        base: 'design/0.4-w05b-stage0@591ef6d',
        greyPointEstimate: STAGE0.corpusGreyShare,
        goldenShippedHardShare: STAGE0.goldenShippedHardShare,
        corpusShippedHardShare: STAGE0.corpusShippedHardShare,
      },
      corpus: {
        size: corpusSize,
        tiers: countBy(RULE_CORPUS.map((item) => item.expectedTier)),
        annotated: {
          hard: annotatedHard,
          hardShare: round4(ratio(annotatedHard, corpusSize)),
          heuristic: corpusSize - annotatedHard,
          buckets: countBy(annotated.map((outcome) => outcome.bucket)),
          bySlice: sliceSummary(annotated),
          expectedActionMismatches,
          expectedDepthMismatches,
        },
        runtimeCue: {
          hard: runtimeHard,
          hardShare: round4(ratio(runtimeHard, corpusSize)),
          heuristic: corpusSize - runtimeHard,
          buckets: countBy(runtime.map((outcome) => outcome.bucket)),
          bySlice: sliceSummary(runtime),
          downgraded: runtimeDowngraded,
          expectedActionMismatches: runtimeActionMismatches,
        },
        grey: {
          count: grey,
          share: round4(ratio(grey, corpusSize)),
          deltaVsStage0: round4(ratio(grey, corpusSize) - STAGE0.corpusGreyShare),
          bySlice: sliceSummary(annotated.filter((outcome) => outcome.tier === 'grey')),
          note: 'Grey is fixed by the declared corpus composition (ambiguous rows). Rule fixes raise hard coverage but cannot decide these mid-band, no-hard-trigger turns.',
        },
        hardCoverageDeltaVsStage0: round4(ratio(annotatedHard, corpusSize) - STAGE0.corpusShippedHardShare),
      },
      goldenSet: {
        size: golden.length,
        hard: goldenHard,
        hardShare: round4(ratio(goldenHard, golden.length)),
        hardCoverageDeltaVsStage0: round4(ratio(goldenHard, golden.length) - STAGE0.goldenShippedHardShare),
        actionHits: goldenActionHits,
        actionAccuracy: round4(ratio(goldenActionHits, golden.length)),
        depthHits: goldenDepthHits,
        depthAccuracy: round4(ratio(goldenDepthHits, goldenSpeak.length)),
        depthMismatches: goldenDepthMismatches,
        buckets: countBy(golden.map((outcome) => outcome.bucket)),
        defer: {
          count: goldenDefer.length,
          deferAction: goldenDefer.filter((outcome) => outcome.action === 'defer').length,
          reasons: countBy(goldenDefer.map((outcome) => outcome.reason)),
        },
        conflict: {
          count: goldenConflict.length,
          explicitConflict: goldenConflictByReason.length,
          detail: goldenConflictDetail.length,
          quote: goldenConflictQuote.length,
          nonExplicit: goldenConflictNonExplicit.map((outcome) => ({
            id: outcome.id,
            reason: outcome.reason,
            action: outcome.action,
          })),
          note: 'B2: only an explicit which-is-right question with conflict candidates enters the conflict branch; exact intent uses quote, otherwise detail. "两条记忆说的发布流程不一样" is intentionally not a conflict trigger.',
        },
        greetingMeta: {
          count: goldenGreetingMeta.length,
          silent: goldenGreetingMeta.filter((outcome) => outcome.action === 'silent').length,
          reasons: countBy(goldenGreetingMeta.map((outcome) => outcome.reason)),
        },
      },
      decision: {
        greyBand: ratio(grey, corpusSize) < 0.10
          ? 'NO-GO (<10%)'
          : ratio(grey, corpusSize) >= 0.20
            ? 'GO-conditions (>=20%)'
            : 'conditional (10-20%)',
        stage1Training: 'NO-GO',
        note: 'Rule fixes are cheap and now enforced, but the declared grey point estimate is unchanged at 15.15%; measure real/shadow traffic before Stage 1.',
      },
      limits: [
        'Declared corpus composition, not a traffic sample; grey share is conditional on it.',
        'Scores are band-assigned, not produced by the real retriever.',
        'Annotated cue fields and runtime extractCue() are both reported; drift is not hidden.',
      ],
    };

    if (EVIDENCE_PATH) {
      await fs.mkdir(dirname(resolve(EVIDENCE_PATH)), { recursive: true });
      await fs.writeFile(resolve(EVIDENCE_PATH), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    }

    // ---- 回归门：硬规则切片必须全部由规则决定，动作/深度与标签一致 ----
    expect(corpusSize).toBe(132);
    expect(grey).toBe(STAGE0.corpusGrey);
    expect(round4(ratio(grey, corpusSize))).toBe(STAGE0.corpusGreyShare);
    expect(annotatedHard).toBeGreaterThanOrEqual(86);
    expect(round4(ratio(annotatedHard, corpusSize))).toBeGreaterThanOrEqual(0.65);
    expect(round4(ratio(annotatedHard, corpusSize))).toBeGreaterThan(STAGE0.corpusShippedHardShare);
    expect(expectedActionMismatches).toEqual([]);
    expect(expectedDepthMismatches).toEqual([]);

    // runtime cue 不应把已经实现的硬规则再降级。
    // B2 明确移除“不一样/对不上”触发后，x_conf_release_zh 按设计回落到 heuristic；
    // 它不再属于 conflict hard slice，但仍应 speak（不能误 silent）。
    expect(runtimeDowngraded.map((outcome) => outcome.id).sort()).toEqual(['x_conf_release_zh']);
    // 两个已知的 runtime-cue 残余洞（非 W0.5c 新增，均在 Stage 0 已存在）：
    //   - x_nov_port_zh：真实 cue 的 exact_value 让 must_speak 先于 novelty=0；
    //   - x_sil_physics_zh：泛化「是多少」被当成 exact intent，低分候选仍 speak。
    // 这里显式锁定名单；修掉任何一个都应更新本断言。
    expect(runtimeActionMismatches.map((outcome) => outcome.id).sort()).toEqual([
      'x_nov_port_zh',
      'x_sil_physics_zh',
    ]);

    // 88 条 golden：defer 必须全部可达；conflict 只对显式问句生效；
    // exact 冲突用 quote，其余 detail；“发布流程不一样”按 B2 不触发 conflict。
    expect(goldenDefer.length).toBe(8);
    expect(goldenDefer.filter((outcome) => outcome.action === 'defer')).toHaveLength(8);
    expect(goldenConflict).toHaveLength(8);
    expect(goldenConflictByReason).toHaveLength(7);
    expect(goldenConflictQuote).toHaveLength(2);
    expect(goldenConflictDetail).toHaveLength(5);
    expect(goldenConflictNonExplicit.map((outcome) => outcome.id)).toEqual(['conflict_release_flow']);
    expect(goldenGreetingMeta.filter((outcome) => outcome.action === 'silent'))
      .toHaveLength(goldenGreetingMeta.length);

    // 生产硬判覆盖必须显著高于 Stage 0，且 action 正确率不回退。
    expect(round4(ratio(goldenHard, golden.length))).toBeGreaterThan(STAGE0.goldenShippedHardShare);
    expect(round4(ratio(goldenActionHits, golden.length))).toBeGreaterThanOrEqual(0.95);
    // B2 让 exact 冲突使用 quote，2 条旧标签（expected detail）不再匹配规则契约；
    // 其余 depth 标签保持一致。
    expect(goldenDepthHits / goldenSpeak.length).toBeGreaterThanOrEqual(0.90);
  }, 60_000);
});
