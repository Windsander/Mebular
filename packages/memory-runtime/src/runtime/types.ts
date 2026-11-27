// Runtime 对象模型（0.3.0 memory runtime contract §2 / §5.6 / §7.1）
//
// 这些类型是 0.3 的冻结形状：图内对象复用 GraphStore 节点，本地对象
// （staging chunk / detail cache / RecallTrace）只落在 sidecar 数据目录，
// 不进入图/事件日志，也不是权威副本。
// 本文件只定义类型与常量，不包含存储或业务实现。

export const RUNTIME_SCHEMA_VERSION = 1 as const;

export const RUNTIME_MODES = ['mcp', 'immersive'] as const;
export type RuntimeMode = (typeof RUNTIME_MODES)[number];

export const RUNTIME_OBJECT_KINDS = [
  'memory_record',
  'detail_record',
  'compact',
  'context_checkpoint',
  'recall_trace',
  'self_record',
] as const;
export type RuntimeObjectKind = (typeof RUNTIME_OBJECT_KINDS)[number];

export const RUNTIME_INTERNAL_NODE_TYPES = [
  'compact',
  'context_checkpoint',
  'self_record',
  'detail_record',
  'recall_trace', // 0.3 不落图，防御性保留
] as const;
export type RuntimeInternalNodeType = (typeof RUNTIME_INTERNAL_NODE_TYPES)[number];

export const RUNTIME_RESERVED_NAMESPACES = [
  '__policy__', // 现有策略域
  '__self__',
  '__checkpoint__',
  '__raw__', // 0.3 保留，不启用
  '__trace__', // 0.3 保留，不启用
] as const;

export const RUNTIME_TAG_PREFIX = 'mebular:runtime:';
export const RUNTIME_METADATA_KEY = 'runtime';

export const RUNTIME_MODEL_SOURCES = ['heuristic', 'local', 'host', 'api', 'auto'] as const;
export type RuntimeModelSource = (typeof RUNTIME_MODEL_SOURCES)[number];

export const RUNTIME_DETAIL_KINDS = ['raw_chunk', 'message', 'tool_output', 'document_slice'] as const;
export type RuntimeDetailKind = (typeof RUNTIME_DETAIL_KINDS)[number];

export const RUNTIME_DETAIL_AVAILABILITY = [
  'available',
  'pending_sync',
  'expired',
  'deleted',
  'quota_evicted',
  'not_subscribed',
  'redacted_only',
] as const;
export type RuntimeDetailAvailability = (typeof RUNTIME_DETAIL_AVAILABILITY)[number];

export const RUNTIME_TRACE_MODES = ['off', 'local'] as const;
export type RuntimeTraceMode = (typeof RUNTIME_TRACE_MODES)[number];

export const RUNTIME_EXTRACTORS = ['user', 'heuristic', 'local', 'host', 'api'] as const;
export type RuntimeExtractor = (typeof RUNTIME_EXTRACTORS)[number];

export type RuntimeSyncMode = 'cloud' | 'local';
export type RuntimeCheckpointSync = 'local' | 'cloud';

export type RuntimeVisibility =
  | 'user' // 用户共享记忆
  | 'relationship' // 关系记忆（仍是用户记忆的一种形状）
  | 'agent-self' // Agent 自我记录
  | 'task' // 任务/线程 checkpoint
  | 'local'; // 仅本机

/** 所有 Runtime 对象共享的逻辑信封（落图时字段分散到节点/content/metadata）。 */
export interface RuntimeEnvelope {
  schema: 1;
  kind: RuntimeObjectKind;
  id: string;
  cloudId: string;
  userId: string;
  agentId: string;
  hostId?: string;
  threadId?: string;
  namespace: string;
  visibility: RuntimeVisibility;
  sync: RuntimeSyncMode;
  internal: boolean;
  provenance: {
    source: 'legacy' | 'mcp' | 'host' | 'runtime' | 'import';
    extractor: RuntimeExtractor;
    model?: string;
    version?: string;
    /** 模型失败/未配置而回退 heuristic 时标记；仅说明来源，不可据此重放模型。 */
    degraded?: boolean;
    at: number;
    deviceId?: string;
    messageIds?: string[];
  };
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
}

/** 落在 `metadata.runtime` 的判别载荷（字段是 envelope 的子集）。 */
export interface RuntimeNodeMetadata {
  schema: 1;
  kind: RuntimeObjectKind;
  internal: boolean;
  cloudId: string;
  userId: string;
  agentId: string;
  hostId?: string;
  threadId?: string;
  visibility: RuntimeVisibility;
  sync: RuntimeSyncMode;
  provenance: RuntimeEnvelope['provenance'];
}

// ---------- 2.3.1 StagingChunk（本地过程数据，非权威） ----------

/**
 * 已接收、尚未成功写入 capability 的原始切片。
 * 旧名 RawChunk 仅作为代码兼容别名保留；本地 `staging/` 不是召回权威，
 * 成功沉降（capability `/detail`）后删除，默认 24h 过期。
 */
export interface RawChunk {
  schema: 1;
  id: string; // rc_<ULID>（本地 staging id）
  threadId: string;
  agentId: string;
  hostId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  /** 缺省为普通 raw_chunk；tool role 由 ingest 规范化为 tool_output。 */
  detailKind?: RuntimeDetailKind;
  /** staging 中保留分类，确保离线重放不会把 tool/document 当 conversation。 */
  retentionClass?: DetailRetentionClass;
  text: string; // 单块上限 256 KiB；超过由调用方切块
  mime: 'text/plain' | 'text/markdown' | 'application/json';
  at: number; // Unix ms
  messageId?: string;
  turn?: number;
  chunkIndex?: number;
  contentHash: string; // sha256 hex；去重键
  redaction: { applied: boolean; rules: string[] };
  expiresAt: number; // staging TTL（默认 now + detail.stagingHours）
}

/** 新代码应使用这个名字；RawChunk 是 0.3 旧类型的兼容别名。 */
export type StagingChunk = RawChunk;

// ---------- 2.3.2 DetailRecord（图内权威，经 capability `/detail`） ----------

export type DetailRetentionClass = 'conversation' | 'tool_output' | 'document_slice' | 'pinned';

export interface DetailRecord {
  schema: 1;
  id: string;
  kind: 'detail_record';
  detailKind: RuntimeDetailKind;
  domain: string;
  ownerType?: 'user' | 'agent' | 'other';
  ownerId?: string;
  role?: RawChunk['role'];
  text?: string;
  truncated?: boolean;
  redacted?: boolean;
  contentHash?: string;
  recordIds: string[];
  threadId?: string;
  messageId?: string;
  chunkIndex?: number;
  turn?: number;
  retentionClass?: DetailRetentionClass;
  expiresAt?: number;
  deletedAt?: number;
  availability?: RuntimeDetailAvailability[];
  provenance?: Record<string, unknown>;
}

// ---------- MemoryRecord（共享记忆视图） ----------

export type MemoryRecordKind = 'entity' | 'fact' | 'preference' | 'episode' | 'observation' | 'skill' | 'meta';

/**
 * MemoryRecord 的对外视图（recall / context 消费）。
 * 图内仍使用现有实体/事实/情节/技能节点，不新增包装节点。
 */
export interface MemoryRecordView {
  id: string;
  type: 'entity' | 'fact' | 'episode' | 'skill' | 'meta';
  kind?: MemoryRecordKind;
  content: string;
  namespace: string;
  score?: number;
  why?: string;
  validFrom?: number;
  validTo?: number | null;
  provenance?: {
    extractor?: RuntimeExtractor;
    agentId?: string;
    model?: string;
    source?: string;
    /** 指向 DetailRecord；0.3 的详情展开入口。 */
    detailIds?: string[];
    /** 旧字段，只作兼容别名；新写入不再依赖。 */
    rawChunkIds?: string[];
  };
  tags?: string[];
}

/** 契约中的对象名；与 MemoryRecordView 同形。 */
export type MemoryRecord = MemoryRecordView;

// ---------- 2.3.3 Compact（派生摘要） ----------

export interface Compact {
  schema: 1;
  summary: string; // 只含摘要，不含 raw 原文
  sourceIds: string[]; // MemoryRecord 节点 id
  sourceHashes: string[]; // 源记录内容哈希，用于陈旧判定
  strategy: 'summary' | 'dedupe';
  model: { extractor: string; model?: string; version?: string };
  tokenCount: number;
  stale: boolean;
}

// ---------- 2.3.4 ContextCheckpoint（任务/线程恢复点） ----------

export interface ContextCheckpoint {
  schema: 1;
  threadId: string;
  agentId: string;
  revision: number; // 单调递增，服务端分配
  state: Record<string, unknown>; // 不透明 JSON；上限 256 KiB
  summary?: string;
  recordIds: string[]; // 相关 MemoryRecord，可为空
  originHostId: string;
  lease: { hostId: string; until: number }; // 60s 租约，防双活恢复
  expiresAt: number; // 默认 now + runtime.retention.checkpointDays
}

// ---------- 2.3.5 RecallTrace（本地诊断） ----------

// ---------- 记忆介入策略（0.4.0） ----------

export type InterventionAction = 'speak' | 'defer' | 'silent';
export type RecallDepth = 'gist' | 'detail' | 'quote';

/** 介入决策的解释分数；只描述本次判定，不含正文。 */
export interface InterventionScores {
  /** 首选候选的 score.final。 */
  top: number;
  /** cue 具体度：broad=0.3 / targeted=0.7 / exact=1。 */
  specificity: number;
  /** 首选候选是否不在 alreadyInjectedIds 中（0/1）。 */
  novelty: number;
  /** 同 agent/domain 最近的负例占比。 */
  recentUseless: number;
  /** 所选深度与 cue 意图的贴合度。 */
  depthFit: number;
}

/**
 * 0.4.0 介入 planner 的稳定 fallback 原因（W0-A §6.4）。
 * 只记录枚举，不含 raw query/detail/token/endpoint。
 */
export type InterventionFallbackReason =
  | 'none'
  | 'deadline'
  | 'prefetch_miss'
  | 'source_unavailable'
  | 'model_not_installed'
  | 'allow_remote_false'
  | 'host_plan_missing'
  | 'host_plan_expired'
  | 'host_plan_replayed'
  | 'host_plan_invalid'
  | 'host_plan_scope_mismatch'
  | 'host_plan_cue_mismatch'
  | 'invalid_output'
  | 'timeout'
  | 'planner_queue_overflow'
  | 'error';

/** 预取状态；first_turn/miss/expired/cue_mismatch 都是预期运行时状态。 */
export type InterventionPrefetchState =
  | 'hit'
  | 'miss'
  | 'expired'
  | 'cue_mismatch'
  | 'first_turn';

export interface InterventionPlannerAttempt {
  source: 'host' | 'local' | 'api';
  outcome: 'hit' | 'miss' | 'timeout' | 'invalid' | 'unavailable' | 'remote_not_allowed' | 'error';
  latencyMs: number;
}

/**
 * 只读 planner 诊断（W0-A §6.4）。
 * 只含枚举、布尔、计时与模型 id；不含 endpoint/keyRef/凭据/正文。
 */
export interface InterventionPlannerTrace {
  configuredSource: 'heuristic' | 'local' | 'host' | 'api' | 'auto';
  resolvedSource: 'heuristic' | 'local' | 'host' | 'api' | null;
  latencyMs: number;
  fallbackReason: InterventionFallbackReason | null;
  prefetched: boolean;
  prefetchState?: InterventionPrefetchState;
  planAgeMs?: number;
  planId?: string;
  cueMatched?: boolean;
  model?: string;
  attempts?: InterventionPlannerAttempt[];
  /**
   * W6：仅 heuristic 决策带 adaptive 诊断；model/shadow 不读 adaptive，因此不出现。
   * 只含阈值/阶段，不含 query 或正文。
   */
  adaptive?: {
    stage: 'shadow' | 'canary' | 'on';
    /** 本次 threshold 是否真的应用了 adaptive offset。 */
    applied: boolean;
    baseThreshold: number;
    recommendedThreshold: number;
    threshold: number;
    offset: number;
    /** 仅 canary 阶段出现。 */
    canaryHit?: boolean;
  };
}

export interface InterventionDecision {
  action: InterventionAction;
  depth: RecallDepth;
  /** 0..1；silent 时表示维持沉默的置信度。 */
  confidence: number;
  /** must_speak / high_relevance / low_confidence / recent_false_alarm / no_novelty / budget / baseline ... */
  reason: string;
  /** v0-baseline / v0-rules / heuristic:<hash>。model 失败回退 heuristic 时必须仍是 heuristic 版本。 */
  policyVersion: string;
  /** 本次决策是否真正作用于注入：off/baseline=false，shadow=false，heuristic/model=true。 */
  enforced: boolean;
  scores?: InterventionScores;
  /** 命中硬规则（显式追问/task 续接/上轮沉默后纠正）。 */
  mustSpeak?: boolean;
  /** 降级标记：must_speak 无候选/详情不可用，或 model 回退 heuristic。 */
  degraded?: boolean;
  /** 0.4.0 additive 诊断：来源/预取/延迟/fallback；不含正文与凭据。 */
  planner?: InterventionPlannerTrace;
}

/** 实际生效的介入结果；与 decision 在 shadow/off 下可能不同。 */
export interface AppliedIntervention {
  action: InterventionAction;
  depth: RecallDepth;
  /** 实际注入的长期记忆片段数（不含 self/checkpoint）。 */
  fragments: number;
  /** 决策所用的主域，供 outcome 归因；不含正文。 */
  domain?: string;
  /** 被策略裁掉的候选 fragmentId（heuristic 才有）。 */
  suppressed?: string[];
  /** shadow 模式下策略建议但未生效的 action/depth。 */
  wouldAction?: InterventionAction;
  wouldDepth?: RecallDepth;
  /**
   * W6：本次实际生效决策是否来自 heuristic，可作为 adaptive 样本。
   * model/shadow/off 为 false/缺省；outcome 归因据此决定是否调参。
   */
  adaptiveEligible?: boolean;
  degraded?: boolean;
}

export type RecallOutcomeKind =
  | 'accepted'
  | 'ignored'
  | 'reasked'
  | 'corrected'
  | 'dismissed'
  | 'missed'
  | 'too_shallow'
  | 'too_deep';

export type RecallOutcomeSource = 'host' | 'console' | 'heuristic';

export interface RecallOutcome {
  kind: RecallOutcomeKind;
  at: number;
  source: RecallOutcomeSource;
  confidence?: number;
  note?: string;
}

export interface RecallTrace {
  /** schema 1 是旧原型；schema 2 是 sidecar 碎片化召回 trace（本地对象）。 */
  schema: 1 | 2;
  id: string; // tr_<ULID>
  cloudId: string;
  agentId: string;
  hostId: string;
  threadId?: string;
  /** 0.4.0 W4：与 `/context` turnId 对齐，用于 outcome binding 跨 turn 校验。 */
  turnId?: string;
  /** 0.4.0 W4：显式 host 身份；只由 adapter header 注入。 */
  hostApp?: 'opencode' | 'openchamber' | 'dsh' | 'hermes';
  at: number;
  queryHash: string; // sha256(query)
  queryPreview: string; // 脱敏后最多 200 字；可配置不存
  namespaces: string[];
  hits: Array<{ id: string; type: string; score?: number; rank: number }>;
  model: { query?: string; embedding?: string; extractor?: string };
  tookMs: number;
  degraded: boolean;
  feedback?: { useful: boolean; reason?: string; at: number };

  // schema 2（只增不改；旧读取方忽略）。不存正文/raw/gist/prompt。
  recallId?: string;
  domains?: string[];
  cue?: Record<string, unknown>;
  candidates?: Array<Record<string, unknown>>;
  expansions?: Array<Record<string, unknown>>;
  injected?: Array<Record<string, unknown>>;
  silenceReason?: string | null;
  budget?: {
    maxFragments: number;
    maxBytes: number;
    maxTokens: number;
    usedBytes: number;
    usedTokens: number;
  };
  timing?: {
    cueMs: number;
    fuzzyMs: number;
    expandMs: number;
    assembleMs: number;
    totalMs: number;
  };
  warnings?: string[];
  /** 0.4.0：本次 memory fragments 的介入决策（additive，不升 schema）。 */
  decision?: InterventionDecision;
  /** 0.4.0：实际生效结果；shadow 下与 decision 不同。 */
  applied?: AppliedIntervention;
  /** 0.4.0：最近一次结果归因。 */
  outcome?: RecallOutcome;
  /** 0.4.0：最近 5 条结果归因（同 kind 幂等）。 */
  outcomeHistory?: RecallOutcome[];
  /** 0.4.0：本 trace 已记录过的 outcome kind（最多 8），用于跨 history 截断的幂等判断。 */
  seenOutcomeKinds?: RecallOutcomeKind[];
}

// ---------- 2.3.6 SelfRecord（Agent 自我） ----------

export interface SelfRecord {
  schema: 1;
  agentId: string;
  revision: number;
  displayName?: string;
  goals: string[];
  traits: string[];
  preferences: Record<string, unknown>;
  capabilities: string[];
  boundaries: string[];
  updatedAt: number;
}

// ---------- 5.6 CandidateRecord（宿主/模型提交的候选） ----------

export type CandidateRecord =
  | {
      kind: 'fact';
      data: {
        subject: string;
        predicate: string;
        object: string;
        confidence?: number;
        validFrom?: number;
        validTo?: number;
        source?: string;
      };
      namespace?: string;
      tags?: string[];
      relatedTo?: string[];
    }
  | {
      kind: 'preference';
      data: {
        entity: string;
        preferenceType: string;
        value: string;
        confidence?: number;
        source?: string;
      };
      namespace?: string;
      tags?: string[];
      relatedTo?: string[];
    }
  | {
      kind: 'episode';
      data: {
        episodeType: string;
        title?: string;
        content: string;
        startTime?: number;
        endTime?: number;
        context?: string;
      };
      namespace?: string;
      tags?: string[];
    }
  | {
      kind: 'skill';
      data: {
        name: string;
        description: string;
        category: string;
        steps?: string[];
        commands?: string[];
        toolReferences?: string[];
        prerequisites?: string[];
        relatedEntities?: string[];
      };
      namespace?: string;
      tags?: string[];
    }
  | {
      kind: 'observation';
      data: { content: string };
      namespace?: string;
      tags?: string[];
      relatedTo?: string[];
    };
