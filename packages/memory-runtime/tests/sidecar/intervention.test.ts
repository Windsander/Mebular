// 介入策略单元测试：must_speak、depth、heuristic gate、探索/沉默上限、model 诚实回退。

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

  it('model 模式只返回 heuristic fallback + degraded，不伪造模型版本', () => {
    const decision = planIntervention(input({ mode: 'model', candidates: [candidate({ score: 0.8 })] }));
    expect(decision.action).toBe('speak');
    expect(decision.degraded).toBe(true);
    expect(decision.enforced).toBe(true);
    expect(decision.policyVersion).toMatch(/^heuristic:/);
    expect(decision.policyVersion).not.toMatch(/^model:/);
  });

  it('mustSpeakReason 对普通 query 返回 null', () => {
    expect(mustSpeakReason(input({ cue: cue('深色主题') }))).toBeNull();
  });
});
