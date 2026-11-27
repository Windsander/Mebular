// 0.4.0 W3：HostInterventionPlan 信封、freshness、anti-replay 单测。
//
// 这些测试只证明 sidecar 契约；真实四宿主 E2E 由 W7 负责。

import { describe, it, expect } from '@jest/globals';
import { extractCue } from '../../src/sidecar/cue.js';
import {
  candidateFingerprintOf,
  cueSignatureOf,
  cueTokenHashes,
  HOST_PLAN_TTL_MS,
  HostPlanReplayGuard,
  parseHostPlan,
  validateHostPlan,
  type HostInterventionPlan,
} from '../../src/sidecar/host-plan.js';

const NOW = 1_760_000_000_000;

function cueOf(query: string, turnId = 'turn_2') {
  return extractCue({
    query,
    agentId: 'opencode',
    threadId: 'th_1',
    turnId,
    recallId: 'rr_1',
    now: NOW,
    budget: { maxFragments: 3, maxBytes: 8192, maxTokens: 2000 },
  });
}

const candidates = [
  { fragmentId: 'mf_dark_theme' },
  { fragmentId: 'mf_port' },
  { fragmentId: 'mf_deploy' },
];

function planOf(overrides: Partial<HostInterventionPlan> = {}): Record<string, unknown> {
  const cue = cueOf('深色主题偏好');
  const fingerprint = cueTokenHashes(cue);
  return {
    schema: 1,
    planId: 'hp_01JTESTPLAN0001',
    host: 'opencode',
    hostInstanceId: 'hi_test',
    agentId: 'opencode',
    threadId: 'th_1',
    scope: 'session',
    basedOnTurnId: 'turn_1',
    cueSignature: cueSignatureOf(fingerprint),
    cueFingerprint: fingerprint,
    basisCandidateFingerprint: candidateFingerprintOf(candidates),
    createdAt: NOW - 1000,
    expiresAt: NOW - 1000 + HOST_PLAN_TTL_MS,
    action: 'speak',
    depth: 'detail',
    confidence: 0.82,
    reasonCode: 'high_relevance',
    plannerKind: 'host-model',
    plannerVersion: 'opencode:test',
    ...overrides,
  };
}

function validationInput(overrides: Record<string, unknown> = {}) {
  const cue = cueOf('深色主题偏好');
  return {
    now: NOW,
    agentId: 'opencode',
    threadId: 'th_1',
    turnId: 'turn_2',
    previousTurnId: 'turn_1',
    lastContextTurnId: 'turn_1',
    hostApp: 'opencode',
    currentCue: cue,
    currentCandidateFingerprint: candidateFingerprintOf(candidates),
    ...overrides,
  };
}

describe('host plan envelope', () => {
  it('合法 session prior 通过并保留 basis/cue/候选字段', () => {
    const raw = planOf();
    const parsed = parseHostPlan(raw);
    expect(parsed).not.toBeNull();
    expect(parsed).toMatchObject({
      planId: 'hp_01JTESTPLAN0001',
      host: 'opencode',
      scope: 'session',
      basedOnTurnId: 'turn_1',
      action: 'speak',
      depth: 'detail',
      plannerKind: 'host-model',
    });
    const result = validateHostPlan(raw, validationInput());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.cueMatched).toBe(true);
  });

  it('过期 plan → host_plan_expired', () => {
    const raw = planOf({ createdAt: NOW - 70_000, expiresAt: NOW - 10_000 });
    const result = validateHostPlan(raw, validationInput());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('host_plan_expired');
  });

  it('TTL > 60s → host_plan_invalid', () => {
    const raw = planOf({ createdAt: NOW - 1000, expiresAt: NOW - 1000 + HOST_PLAN_TTL_MS + 1 });
    const result = validateHostPlan(raw, validationInput());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('host_plan_invalid');
  });

  it('新 cue 主题 Jaccard <0.6 → host_plan_cue_mismatch', () => {
    const raw = planOf();
    const result = validateHostPlan(raw, validationInput({
      currentCue: cueOf('生产数据库端口是多少'),
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('host_plan_cue_mismatch');
  });

  it('follow_up/task_continue/correction 豁免 cue Jaccard', () => {
    const raw = planOf();
    const cue = cueOf('继续上次那个');
    expect(cue.detailIntent.reasons).toContain('task_continue');
    const result = validateHostPlan(raw, validationInput({ currentCue: cue }));
    expect(result.ok).toBe(true);
  });

  it('当前 top-1 不在 basis top-3 → host_plan_candidates_changed', () => {
    const raw = planOf({
      basisCandidateFingerprint: candidateFingerprintOf([
        { fragmentId: 'mf_other_a' },
        { fragmentId: 'mf_other_b' },
      ]),
    });
    const result = validateHostPlan(raw, validationInput());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('host_plan_candidates_changed');
  });

  it('basis turn 与 adapter previousTurnId / sidecar 记录不一致 → scope mismatch', () => {
    const raw = planOf();
    expect(validateHostPlan(raw, validationInput({ previousTurnId: 'turn_9' })).ok).toBe(false);
    expect(validateHostPlan(raw, validationInput({ lastContextTurnId: 'turn_8' })).ok).toBe(false);
    expect(validateHostPlan(raw, validationInput({ previousTurnId: null })).ok).toBe(false);
  });

  it('host/agent/thread 身份不符 → scope mismatch', () => {
    for (const override of [
      { hostApp: 'dsh' },
      { agentId: 'dsh' },
      { threadId: 'th_other' },
      { hostApp: null },
    ]) {
      const result = validateHostPlan(planOf(), validationInput(override));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('host_plan_scope_mismatch');
    }
  });

  it('确定性 planner 不能冒充 host model → host_plan_not_model', () => {
    const raw = planOf({ plannerKind: 'host-adapter-deterministic' });
    const result = validateHostPlan(raw, validationInput());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('host_plan_not_model');
  });

  it('非法枚举/置信度/尺寸 → host_plan_invalid', () => {
    expect(validateHostPlan(planOf({ action: 'yell' as never }), validationInput()).ok).toBe(false);
    expect(validateHostPlan(planOf({ depth: 'full' as never }), validationInput()).ok).toBe(false);
    expect(validateHostPlan(planOf({ confidence: 1.2 }), validationInput()).ok).toBe(false);
    expect(validateHostPlan(planOf({ reasonCode: 'free text\nbad' as never }), validationInput()).ok).toBe(false);
    expect(validateHostPlan(planOf({ planId: 'plan_1' }), validationInput()).ok).toBe(false);
    expect(validateHostPlan({ schema: 1, plan: 'x'.repeat(5000) }, validationInput()).ok).toBe(false);
  });

  it('replay guard 单次消费且按 TTL 清理', () => {
    const guard = new HostPlanReplayGuard(1000);
    expect(guard.has('hp_a', NOW)).toBe(false);
    guard.mark('hp_a', NOW);
    expect(guard.has('hp_a', NOW)).toBe(true);
    expect(guard.has('hp_a', NOW + 1001)).toBe(false);
  });
});
