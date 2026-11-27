// 0.4.0 W2：local plan 预取缓存语义。
// - 命中：同 cue / 高 Jaccard；miss/首轮/过期/cue mismatch；
// - TTL 60s、配置指纹变化失效、reset 清空；
// - 只保存决策元数据，不保存 raw query/detail/prompt/token。

import { describe, it, expect } from '@jest/globals';
import { extractCue } from '../../src/sidecar/cue.js';
import {
  InterventionPrefetchCache,
  LOCAL_PREFETCH_TTL_MS,
  createLocalPrefetchPlan,
  cueMatchesScope,
  cueScopeOf,
  prefetchKeyFor,
} from '../../src/sidecar/intervention-prefetch.js';
import type { InferenceInterventionResult } from '../../src/sidecar/inference-provider.js';

const NOW = 1_760_000_000_000;
const RAW_SECRET = 'ALPHA RAW QUERY SECRET 不要缓存';

function cue(query: string) {
  return extractCue({
    query,
    agentId: 'opencode',
    threadId: 'th_prefetch',
    recallId: 'rr_prefetch',
    now: NOW,
    budget: { maxFragments: 3, maxBytes: 4096, maxTokens: 500 },
  });
}

function result(overrides: Partial<InferenceInterventionResult> = {}): InferenceInterventionResult {
  return {
    ok: true,
    action: 'speak',
    depth: 'gist',
    confidence: 0.8,
    reason: 'relevant',
    model: 'fake-local',
    degraded: false,
    warnings: [],
    latencyMs: 12,
    ...overrides,
  };
}

function plan(query: string, overrides: {
  now?: number;
  result?: InferenceInterventionResult;
  localFingerprint?: string;
} = {}) {
  const c = cue(query);
  return createLocalPrefetchPlan({
    scope: cueScopeOf(c),
    result: overrides.result ?? result(),
    versionSeed: 'seed',
    localFingerprint: overrides.localFingerprint ?? 'pack-a',
    now: overrides.now ?? NOW,
  });
}

describe('InterventionPrefetchCache', () => {
  it('同 cue 命中；返回 planAgeMs；不保存 raw query', () => {
    const cache = new InterventionPrefetchCache();
    const key = prefetchKeyFor('opencode', 'th_prefetch');
    const entry = plan(RAW_SECRET);
    cache.put(key, entry);

    const hit = cache.take(key, cue(RAW_SECRET), NOW + 1_000, 'pack-a');
    expect(hit.state).toBe('hit');
    expect(hit.plan?.planId).toBe(entry.planId);
    expect(hit.ageMs).toBe(1_000);

    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain(RAW_SECRET);
    expect(serialized).not.toContain('rawQuery');
  });

  it('高 Jaccard 的追问命中；不同 cue 返回 cue_mismatch', () => {
    const cache = new InterventionPrefetchCache();
    const key = prefetchKeyFor('opencode', 'th_prefetch');
    const entry = plan('深色主题偏好');
    // 模拟“签名变化但 topic 集合几乎相同”的追问；走 Jaccard 分支。
    entry.scope.signature = 'different-signature';
    cache.put(key, entry);

    const similar = cache.take(key, cue('深色主题偏好'), NOW + 10, 'pack-a');
    expect(similar.state).toBe('hit');

    const mismatch = cache.take(key, cue('部署端口是多少'), NOW + 20, 'pack-a');
    expect(mismatch.state).toBe('cue_mismatch');
    expect(mismatch.plan).toBeNull();
  });

  it('TTL 60s：过期后返回 expired，并删除条目', () => {
    const cache = new InterventionPrefetchCache();
    const key = prefetchKeyFor('opencode', 'th_prefetch');
    cache.put(key, plan('深色主题偏好'));

    const expired = cache.take(key, cue('深色主题偏好'), NOW + LOCAL_PREFETCH_TTL_MS, 'pack-a');
    expect(expired.state).toBe('expired');
    expect(expired.plan).toBeNull();

    // 已删除；再次读取是普通 miss（该 key 曾发起过预取）。
    expect(cache.take(key, cue('深色主题偏好'), NOW + LOCAL_PREFETCH_TTL_MS + 1, 'pack-a').state)
      .toBe('miss');
    expect(cache.size()).toBe(0);
  });

  it('首轮与 miss 可区分；配置指纹变化丢弃旧 plan', () => {
    const cache = new InterventionPrefetchCache();
    const key = prefetchKeyFor('opencode', 'th_prefetch');
    expect(cache.take(key, cue('深色主题偏好'), NOW, 'pack-a').state).toBe('first_turn');

    cache.put(key, plan('深色主题偏好', { localFingerprint: 'pack-a' }));
    const changed = cache.take(key, cue('深色主题偏好'), NOW + 1, 'pack-b');
    expect(changed.state).toBe('miss');
    expect(changed.plan).toBeNull();
  });

  it('clear 清空条目与首轮标记', () => {
    const cache = new InterventionPrefetchCache();
    const key = prefetchKeyFor('opencode', 'th_prefetch');
    cache.put(key, plan('深色主题偏好'));
    cache.clear();
    expect(cache.size()).toBe(0);
    expect(cache.take(key, cue('深色主题偏好'), NOW, 'pack-a').state).toBe('first_turn');
  });

  it('失败/非法 plan 不进入缓存', () => {
    const cache = new InterventionPrefetchCache();
    const key = prefetchKeyFor('opencode', 'th_prefetch');
    cache.put(key, plan('深色主题偏好', {
      result: result({ ok: false, reasonCode: 'model_timeout' }),
    }));
    expect(cache.size()).toBe(0);
  });

  it('空 topic/entity 的 cue 不会互相误命中', () => {
    const empty = cue('');
    expect(cueMatchesScope(cueScopeOf(empty), empty)).toBe(true);
    expect(cueMatchesScope(cueScopeOf(empty), cue('深色主题'))).toBe(false);
  });
});
