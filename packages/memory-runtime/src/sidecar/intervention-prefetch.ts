// 0.4.0 W2：local intervention plan 预取缓存。
//
// 契约（W0-A §6.2）：
// - local 只消费上一轮结束后的新鲜预取 plan；`/context` 决策点不启动本地模型；
// - 命中条件：cueSignature 相同，或规范化 topic/entity Jaccard ≥0.8；
// - TTL 60s；首轮/新 cue/过期/不一致 → prefetched=false + heuristic；
// - reset / 本地模型配置变化立即失效；
// - 缓存只保存决策元数据，不保存 raw query、detail、prompt 或 token。

import { createHash, randomUUID } from 'node:crypto';
import type { Cue } from './cue.js';
import type { InferenceInterventionResult } from './inference-provider.js';
import type { InterventionPrefetchState } from '../runtime/types.js';

/** local prefetch 缓存 TTL（W0-A 冻结 60s）。 */
export const LOCAL_PREFETCH_TTL_MS = 60_000;
/** 命中判定的 topic/entity Jaccard 下限（W0-A 冻结 0.8）。 */
export const LOCAL_PREFETCH_CUE_JACCARD = 0.8;
/** 进程内缓存上限；超过时丢弃最旧条目。 */
export const LOCAL_PREFETCH_MAX_ENTRIES = 64;
/** 首轮/miss 标记上限；防止长时间运行按 thread 无限增长。 */
export const LOCAL_PREFETCH_MAX_ATTEMPTED = 256;

export interface InterventionCueScope {
  /** 规范化 topics/entities/specificity/detailIntent 的 hash；不含 raw query。 */
  signature: string;
  /** 规范化 topic token；只用于相似度，不含正文。 */
  topics: string[];
  /** 规范化 entity name token；只用于相似度，不含正文。 */
  entities: string[];
}

export interface InterventionPrefetchPlan {
  planId: string;
  source: 'local';
  scope: InterventionCueScope;
  createdAt: number;
  expiresAt: number;
  /** provider 返回的已校验决策；只保留决策字段，不保留 prompt/响应正文。 */
  result: InferenceInterventionResult;
  /** policyVersion 的稳定 seed；不包含正文。 */
  versionSeed: string;
  /** 本地模型配置指纹；配置变化后旧 plan 必须丢弃。 */
  localFingerprint: string;
}

export interface InterventionPrefetchLookup {
  plan: InterventionPrefetchPlan | null;
  state: InterventionPrefetchState;
  ageMs?: number;
}

function normalizeToken(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s_\-.,，。!！?？:：;；'"“”‘’()（）[\]【】{}]+/g, '')
    .trim()
    .slice(0, 80);
}

function uniqueTokens(values: readonly string[]): string[] {
  return [...new Set(values.map(normalizeToken).filter((value) => value.length > 0))].sort();
}

/** 用于缓存 key 的 cue scope；不含 raw query。 */
export function cueScopeOf(cue: Cue): InterventionCueScope {
  const topics = uniqueTokens(cue.topics);
  const entities = uniqueTokens(cue.entities.map((entity) => entity.name));
  const signature = createHash('sha256')
    .update(JSON.stringify([
      topics,
      entities,
      cue.specificity,
      [...cue.detailIntent.reasons].sort(),
    ]), 'utf8')
    .digest('hex');
  return { signature, topics, entities };
}

function jaccard(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 && right.length === 0) return 1;
  const a = new Set(left);
  const b = new Set(right);
  let shared = 0;
  for (const value of a) {
    if (b.has(value)) shared += 1;
  }
  const union = a.size + b.size - shared;
  return union === 0 ? 1 : shared / union;
}

/** 当前 cue 是否命中 plan scope：签名相同或 topic/entity Jaccard ≥0.8。 */
export function cueMatchesScope(scope: InterventionCueScope, cue: Cue): boolean {
  const current = cueScopeOf(cue);
  if (scope.signature === current.signature) return true;
  const topicScore = scope.topics.length > 0 && current.topics.length > 0
    ? jaccard(scope.topics, current.topics)
    : null;
  const entityScore = scope.entities.length > 0 && current.entities.length > 0
    ? jaccard(scope.entities, current.entities)
    : null;
  // 两侧都为空时 Jaccard=1；此时只认签名相同，避免空 cue 误命中。
  if (topicScore === null && entityScore === null) return false;
  // “topic/entity Jaccard ≥0.8”：topic 或 entity 任一侧足够接近即可。
  return Math.max(topicScore ?? 0, entityScore ?? 0) >= LOCAL_PREFETCH_CUE_JACCARD;
}

/** 缓存 key：按 (agentId, threadId) 隔离；同一 thread 内再校验 cue。 */
export function prefetchKeyFor(agentId: string, threadId: string | null | undefined): string {
  return `${agentId}\u0000${threadId ?? ''}`;
}

export function createLocalPrefetchPlan(input: {
  scope: InterventionCueScope;
  result: InferenceInterventionResult;
  versionSeed: string;
  localFingerprint: string;
  now: number;
}): InterventionPrefetchPlan {
  return {
    planId: `lp_${randomUUID().replace(/-/g, '')}`,
    source: 'local',
    scope: input.scope,
    createdAt: input.now,
    expiresAt: input.now + LOCAL_PREFETCH_TTL_MS,
    result: {
      ...input.result,
      warnings: [...input.result.warnings],
    },
    versionSeed: input.versionSeed,
    localFingerprint: input.localFingerprint,
  };
}

/**
 * 进程内 local plan 缓存。
 * `take()` 只消费新鲜且 cue 命中的 plan；过期/配置变化会删除条目。
 */
export class InterventionPrefetchCache {
  private readonly entries = new Map<string, InterventionPrefetchPlan>();
  /** 已经为该 key 发起过 prefetch；用于区分 first_turn 与普通 miss。 */
  private readonly attempted = new Set<string>();

  put(key: string, plan: InterventionPrefetchPlan): void {
    if (!plan.result.ok) return;
    this.attempted.add(key);
    while (this.attempted.size > LOCAL_PREFETCH_MAX_ATTEMPTED) {
      const oldest = this.attempted.values().next().value as string | undefined;
      if (oldest === undefined) break;
      this.attempted.delete(oldest);
    }
    this.entries.delete(key);
    this.entries.set(key, plan);
    while (this.entries.size > LOCAL_PREFETCH_MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  take(key: string, cue: Cue, now: number, localFingerprint: string): InterventionPrefetchLookup {
    const plan = this.entries.get(key);
    if (!plan) {
      return { plan: null, state: this.attempted.has(key) ? 'miss' : 'first_turn' };
    }
    if (now >= plan.expiresAt) {
      this.entries.delete(key);
      return { plan: null, state: 'expired' };
    }
    if (plan.localFingerprint !== localFingerprint) {
      this.entries.delete(key);
      return { plan: null, state: 'miss' };
    }
    if (!cueMatchesScope(plan.scope, cue)) {
      return { plan: null, state: 'cue_mismatch' };
    }
    return {
      plan,
      state: 'hit',
      ageMs: Math.max(0, now - plan.createdAt),
    };
  }

  clear(): void {
    this.entries.clear();
    this.attempted.clear();
  }

  /** 只读诊断；不暴露 plan 内容。 */
  size(): number {
    return this.entries.size;
  }
}
