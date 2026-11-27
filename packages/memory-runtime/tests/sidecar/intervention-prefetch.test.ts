// 0.4.0 W2：local plan 预取缓存语义。
// - 命中：同 cue / 高 Jaccard；miss/首轮/过期/cue mismatch；
// - TTL 60s、配置指纹变化失效、reset 清空；
// - 只保存决策元数据，不保存 raw query/detail/prompt/token。

import { describe, it, expect } from '@jest/globals';
import { extractCue } from '../../src/sidecar/cue.js';
import {
  HOST_PREFETCH_CUE_JACCARD,
  InterventionPrefetchCache,
  LOCAL_PREFETCH_CUE_JACCARD,
  LOCAL_PREFETCH_TTL_MS,
  createLocalPrefetchPlan,
  cueMatchesScope,
  cueScopeOf,
  cueScopeSimilarity,
  prefetchKeyFor,
  type InterventionCueScope,
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

  // B4：local 0.8（topic/entity 取 max），host 0.6；公式冻结，不能改成 combined。
  it('local 阈值 0.8：topic 0.8 命中，0.6 不命中；host 阈值保持 0.6', () => {
    const scope = (topics: string[], entities: string[] = []): InterventionCueScope => ({
      signature: 'scope',
      topics,
      entities,
    });
    const at08 = cueScopeSimilarity(
      scope(['a', 'b', 'c', 'd', 'e']),
      scope(['a', 'b', 'c', 'd']),
    );
    expect(at08.topic).toBeCloseTo(0.8);
    expect(at08.matched).toBe(true);

    const at06 = cueScopeSimilarity(
      scope(['a', 'b', 'c', 'd']),
      scope(['a', 'b', 'c', 'x']),
    );
    expect(at06.topic).toBeCloseTo(0.6);
    expect(at06.matched).toBe(false);

    expect(LOCAL_PREFETCH_CUE_JACCARD).toBe(0.8);
    expect(LOCAL_PREFETCH_CUE_JACCARD).toBeGreaterThan(HOST_PREFETCH_CUE_JACCARD);
    expect(HOST_PREFETCH_CUE_JACCARD).toBe(0.6);
  });

  it('topic-only / entity-only 都走 max 公式', () => {
    // topic 不相似、entity 完全一致 → 命中（entity-only）。
    const entityOnly = cueScopeSimilarity(
      { signature: 'x', topics: ['a', 'b'], entities: ['user', 'theme'] },
      { signature: 'y', topics: ['c', 'd'], entities: ['user', 'theme'] },
    );
    expect(entityOnly.topic).toBe(0);
    expect(entityOnly.entity).toBe(1);
    expect(entityOnly.matched).toBe(true);

    // topic 完全一致、entity 不同 → 命中（topic-only）。
    const topicOnly = cueScopeSimilarity(
      { signature: 'x', topics: ['a', 'b'], entities: ['user'] },
      { signature: 'y', topics: ['a', 'b'], entities: ['device'] },
    );
    expect(topicOnly.topic).toBe(1);
    expect(topicOnly.entity).toBe(0);
    expect(topicOnly.matched).toBe(true);
  });

  it('冻结为 max(topic, entity)：两侧 0.6 不能被“合并”成 0.8', () => {
    const combined = cueScopeSimilarity(
      { signature: 'x', topics: ['a', 'b', 'c', 'd'], entities: ['u1', 'u2', 'u3', 'u4'] },
      { signature: 'y', topics: ['a', 'b', 'c', 'x'], entities: ['u1', 'u2', 'u3', 'v4'] },
    );
    expect(combined.topic).toBeCloseTo(0.6);
    expect(combined.entity).toBeCloseTo(0.6);
    expect(combined.matched).toBe(false);
  });
});
