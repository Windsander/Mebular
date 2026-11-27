// 介入策略单元测试：must_speak、depth、heuristic gate、探索/沉默上限、model baseline 语义。

import { describe, it, expect } from '@jest/globals';
import { extractCue, type Cue } from '../../src/sidecar/cue.js';
import {
  depthForCue,
  mustSpeakReason,
  planIntervention,
  type InterventionCandidateView,
  type InterventionPlannerInput,
} from '../../src/sidecar/intervention.js';

const NOW = 1_760_000_000_000;

function cue(query: string): Cue {
  return extractCue({
    query,
    agentId: 'opencode',
    threadId: 'th_policy',
    recallId: 'rr_policy',
    now: NOW,
    budget: { maxFragments: 3, maxBytes: 4096, maxTokens: 500 },
  });
}

function candidate(overrides: Partial<InterventionCandidateView> = {}): InterventionCandidateView {
  return {
    fragmentId: 'mf_1',
    sourceIds: ['01JPOLICY1'],
    score: 0.9,
    confidence: 0.9,
    kind: 'preference',
    domain: 'user',
    detailAvailable: true,
    conflict: false,
    ...overrides,
  };
}

function input(overrides: Partial<InterventionPlannerInput> = {}): InterventionPlannerInput {
  return {
    mode: 'heuristic',
    cue: cue('深色主题'),
    candidates: [candidate()],
    alreadyInjectedIds: [],
    threshold: 0.55,
    recentUselessRate: 0,
    silentStreak: 0,
    maxSilentStreak: 3,
    explorationRate: 0,
    random: () => 0,
    ...overrides,
  };
}

describe('intervention planner', () => {
  it('must_speak：显式记忆追问即使分数极低也 speak', () => {
    const decision = planIntervention(input({
      cue: cue('你还记得我的喜好吗？'),
      candidates: [candidate({ score: 0.05 })],
      threshold: 0.95,
      recentUselessRate: 1,
      silentStreak: 99,
    }));
    expect(decision).toMatchObject({
      action: 'speak',
      mustSpeak: true,
      confidence: 1,
      enforced: true,
    });
    expect(decision.reason).toBe('must_speak:explicit_memory_request');
  });

  it('shadow 决策 enforced=false；heuristic 决策 enforced=true', () => {
    const shadow = planIntervention(input({ mode: 'shadow', candidates: [candidate({ score: 0.8 })] }));
    expect(shadow).toMatchObject({ action: 'speak', enforced: false });
    const heuristic = planIntervention(input({ mode: 'heuristic', candidates: [candidate({ score: 0.8 })] }));
    expect(heuristic).toMatchObject({ action: 'speak', enforced: true });
  });

  it('must_speak 无候选：不静默失败，返回 degraded + must_speak_unavailable', () => {
    const decision = planIntervention(input({
      cue: cue('你还记得我的喜好吗？'),
      candidates: [],
    }));
    expect(decision).toMatchObject({
      action: 'silent',
      depth: 'gist',
      reason: 'must_speak_unavailable',
      mustSpeak: true,
      degraded: true,
      enforced: true,
    });
  });

  it('must_speak 但详情不可用：降级为 gist 并标记 degraded', () => {
    const decision = planIntervention(input({
      cue: cue('我当时原话怎么说的？'),
      candidates: [candidate({ detailAvailable: false })],
    }));
    expect(decision).toMatchObject({
      action: 'speak',
      depth: 'gist',
      mustSpeak: true,
      degraded: true,
    });
  });

  it('depth：精确值/命令/引用 → quote；why/follow-up/task/entity/conflict → detail；其余 gist', () => {
    expect(depthForCue(cue('端口是多少？'))).toBe('quote');
    expect(depthForCue(cue('部署命令是什么？'))).toBe('quote');
    expect(depthForCue(cue('我当时原话怎么说的？'))).toBe('quote');
    expect(depthForCue(cue('为什么偏好深色主题？'))).toBe('detail');
    expect(depthForCue(cue('继续上次任务'))).toBe('detail');
    expect(depthForCue(cue('那个后来呢'))).toBe('detail');
    expect(depthForCue(cue('深色主题'))).toBe('gist');
  });

  it('heuristic：高相关 speak，低置信 silent', () => {
    const speak = planIntervention(input({ candidates: [candidate({ score: 0.8 })] }));
    expect(speak).toMatchObject({ action: 'speak', reason: 'high_relevance', depth: 'gist' });
    expect(speak.policyVersion).toMatch(/^heuristic:[0-9a-f]{8}$/);

    const silent = planIntervention(input({ candidates: [candidate({ score: 0.2 })] }));
    expect(silent).toMatchObject({ action: 'silent', reason: 'low_confidence' });
  });

  it('heuristic：no_novelty / recent_false_alarm / broad cue 分别沉默', () => {
    const repeated = planIntervention(input({
      candidates: [candidate({ sourceIds: ['01JREPEAT'] })],
      alreadyInjectedIds: ['01JREPEAT'],
    }));
    expect(repeated).toMatchObject({ action: 'silent', reason: 'no_novelty' });

    const useless = planIntervention(input({ recentUselessRate: 0.5 }));
    expect(useless).toMatchObject({ action: 'silent', reason: 'recent_false_alarm' });

    const broad = planIntervention(input({
      cue: cue('我的偏好有什么'),
      candidates: [candidate({ score: 0.6 })],
    }));
    expect(broad).toMatchObject({ action: 'silent', reason: 'broad_cue' });
  });

  it('novelty：alreadyInjectedIds 传 fragment ID 也视为已注入（novelty=0）', () => {
    const repeated = planIntervention(input({
      candidates: [candidate({ fragmentId: 'mf_01JHOSTECHO', sourceIds: ['01JSOURCE'] })],
      alreadyInjectedIds: ['mf_01JHOSTECHO'],
    }));
    expect(repeated).toMatchObject({
      action: 'silent',
      reason: 'no_novelty',
      scores: { novelty: 0 },
    });
  });

  it('novelty：不相关的 fragment/source ID 不影响（novelty=1，正常 speak）', () => {
    const fresh = planIntervention(input({
      candidates: [candidate({ fragmentId: 'mf_01JHOSTECHO', sourceIds: ['01JSOURCE'] })],
      alreadyInjectedIds: ['mf_01JOTHER', '01JOTHER'],
    }));
    expect(fresh).toMatchObject({
      action: 'speak',
      reason: 'high_relevance',
      scores: { novelty: 1 },
    });
  });

  it('maxSilentStreak 与 explorationRate 避免学成哑巴', () => {
    const forced = planIntervention(input({
      candidates: [candidate({ score: 0.2 })],
      silentStreak: 3,
      maxSilentStreak: 3,
    }));
    expect(forced).toMatchObject({ action: 'speak', reason: 'max_silent_streak', depth: 'gist' });

    const explored = planIntervention(input({
      candidates: [candidate({ score: 0.2 })],
      explorationRate: 0.5,
      random: () => 0.1,
    }));
    expect(explored).toMatchObject({ action: 'speak', reason: 'exploration', depth: 'gist' });
  });

  it('上轮 silent 后追问/纠正触发 must_speak', () => {
    const decision = planIntervention(input({
      cue: cue('不对，应该是深色主题'),
      candidates: [candidate({ score: 0.1 })],
      lastDecision: { action: 'silent', depth: 'gist' },
      threshold: 0.95,
    }));
    expect(decision).toMatchObject({ action: 'speak', mustSpeak: true });
    expect(decision.reason).toBe('must_speak:after_silence');
  });

  it('model 模式的同步 baseline 不伪造模型版本（真实模型由 planInterventionAsync 负责）', () => {
    const decision = planIntervention(input({ mode: 'model', candidates: [candidate({ score: 0.8 })] }));
    expect(decision.action).toBe('speak');
    expect(decision.degraded).toBeUndefined();
    expect(decision.enforced).toBe(true);
    expect(decision.policyVersion).toMatch(/^heuristic:/);
    expect(decision.policyVersion).not.toMatch(/^model:/);
  });

  it('mustSpeakReason 对普通 query 返回 null', () => {
    expect(mustSpeakReason(input({ cue: cue('深色主题') }))).toBeNull();
  });

  it('defer：显式 defer 优先于 must_speak，即使 query 含 /以前/ 且候选高分', () => {
    const decision = planIntervention(input({
      cue: cue('暂时不要提以前的方案，让我自己想想。'),
      candidates: [candidate({ score: 0.92 })],
      threshold: 0.55,
    }));
    expect(decision).toMatchObject({
      action: 'defer',
      depth: 'gist',
      reason: 'defer_explicit',
      confidence: 1,
      enforced: true,
    });
    // 优先级回归：/以前/ 本身会触发 must_speak，但 defer 必须先短路。
    expect(mustSpeakReason(input({ cue: cue('暂时不要提以前的方案，让我自己想想。') })))
      .toBe('must_speak:explicit_memory_request');
  });

  it('defer：cue 的 user_negated 也走显式 defer，不被低分/novelty 影响', () => {
    const decision = planIntervention(input({
      cue: cue('别用记忆回答我的偏好'),
      candidates: [candidate({ score: 0.1, sourceIds: ['01JINJECTED'] })],
      alreadyInjectedIds: ['01JINJECTED'],
      threshold: 0.99,
      recentUselessRate: 1,
    }));
    expect(decision).toMatchObject({ action: 'defer', reason: 'defer_explicit' });
  });

  it('conflict：明确返回 detail，不被低分或 novelty=0 吞掉', () => {
    const conflict = planIntervention(input({
      cue: cue('部署端口有 7331 和 7332 两个说法，哪个对？'),
      candidates: [
        candidate({ fragmentId: 'mf_a', score: 0.31, conflict: true }),
        candidate({ fragmentId: 'mf_b', sourceIds: ['01JCONFLICTB'], score: 0.29, conflict: true }),
      ],
      threshold: 0.95,
      recentUselessRate: 1,
      silentStreak: 99,
    }));
    expect(conflict).toMatchObject({
      action: 'speak',
      depth: 'detail',
      reason: 'conflict',
      confidence: 1,
    });

    const repeated = planIntervention(input({
      cue: cue('两条记录到底哪个对？'),
      candidates: [candidate({ fragmentId: 'mf_repeat', conflict: true, score: 0.86 })],
      alreadyInjectedIds: ['mf_repeat'],
    }));
    expect(repeated).toMatchObject({
      action: 'speak',
      depth: 'detail',
      reason: 'conflict',
    });
  });

  it('conflict：候选没有 detail 时降为 gist 并标记 degraded，但不改变 speak', () => {
    const decision = planIntervention(input({
      cue: cue('我的偏好记录前后不一致，信哪个？'),
      candidates: [candidate({ conflict: true, detailAvailable: false, score: 0.84 })],
    }));
    expect(decision).toMatchObject({
      action: 'speak',
      depth: 'gist',
      reason: 'conflict',
      degraded: true,
    });
  });

  it('greeting/meta：纯寒暄或 meta 默认 silent，不被高分/沉默上限/探索抬成 speak', () => {
    const greeting = planIntervention(input({
      cue: cue('早上好'),
      candidates: [candidate({ score: 0.9 })],
      silentStreak: 99,
      maxSilentStreak: 1,
      explorationRate: 1,
    }));
    expect(greeting).toMatchObject({ action: 'silent', depth: 'gist', reason: 'greeting' });

    const meta = planIntervention(input({
      cue: cue('这个怎么用？'),
      candidates: [candidate({ score: 0.8 })],
    }));
    expect(meta).toMatchObject({ action: 'silent', depth: 'gist', reason: 'meta' });
  });

  it('greeting/meta 规则不会吞掉真正的 must_speak', () => {
    const greetingPrefix = planIntervention(input({
      cue: cue('早上好，帮我看看上次的部署端口'),
      candidates: [candidate({ score: 0.8 })],
    }));
    expect(greetingPrefix.action).toBe('speak');
    expect(greetingPrefix.mustSpeak).toBe(true);

    const explicit = planIntervention(input({
      cue: cue('你好，你还记得我的喜好吗？'),
      candidates: [candidate({ score: 0.05 })],
      threshold: 0.95,
    }));
    expect(explicit).toMatchObject({
      action: 'speak',
      reason: 'must_speak:explicit_memory_request',
      mustSpeak: true,
    });
  });

  it('英文触发词与中文对齐：recall / remember / last time 触发 must_speak', () => {
    for (const query of [
      'can you recall my preferred package manager?',
      'do you remember my preferred package manager?',
      'what did I say last time about the deploy port?',
      'what was the release branch name we agreed on?',
    ]) {
      const decision = planIntervention(input({
        cue: cue(query),
        candidates: [candidate({ score: 0.9 })],
      }));
      expect(decision).toMatchObject({ action: 'speak', mustSpeak: true });
      expect(decision.reason).toMatch(/^must_speak:/);
    }
  });

  it('英文寒暄与中文寒暄一样 silent：hi there / good morning', () => {
    for (const query of ['hi there', 'good morning', 'hello', 'thanks!']) {
      const decision = planIntervention(input({
        cue: cue(query),
        candidates: [candidate({ score: 0.9 })],
      }));
      expect(decision).toMatchObject({ action: 'silent', reason: 'greeting' });
    }
  });

  it('novelty=0 是硬 silent，不再被 maxSilentStreak / exploration 抬成 speak', () => {
    const decision = planIntervention(input({
      candidates: [candidate({ fragmentId: 'mf_repeat' })],
      alreadyInjectedIds: ['mf_repeat'],
      silentStreak: 99,
      maxSilentStreak: 1,
      explorationRate: 1,
      random: () => 0,
    }));
    expect(decision).toMatchObject({
      action: 'silent',
      reason: 'no_novelty',
      scores: { novelty: 0 },
    });
  });
});
