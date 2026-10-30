// Runtime 对象模型（0.3.0 memory runtime contract §2 / §5.6 / §7.1）
//
// 这些类型是 0.3 的冻结形状：图内对象复用 GraphStore 节点，本地对象
// （RawChunk / RecallTrace）只落在 sidecar 数据目录，不进入图/事件日志。
// 本文件只定义类型与常量，不包含存储或业务实现。

export const RUNTIME_SCHEMA_VERSION = 1 as const;

export const RUNTIME_MODES = ['mcp', 'immersive'] as const;
export type RuntimeMode = (typeof RUNTIME_MODES)[number];

export const RUNTIME_OBJECT_KINDS = [
  'memory_record',
  'raw_chunk',
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
  'raw_chunk', // 0.3 不落图，防御性保留
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

export const RUNTIME_CAPTURE_MODES = ['off', 'local'] as const;
export type RuntimeCaptureMode = (typeof RUNTIME_CAPTURE_MODES)[number];

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

// ---------- 2.3.1 RawChunk（本地） ----------

export interface RawChunk {
  schema: 1;
  id: string; // rc_<ULID>
  threadId: string;
  agentId: string;
  hostId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  text: string; // 单块上限 256 KiB；超过由调用方切块
  mime: 'text/plain' | 'text/markdown' | 'application/json';
  at: number; // Unix ms
  messageId?: string;
  turn?: number;
  chunkIndex?: number;
  contentHash: string; // sha256 hex；去重键
  redaction: { applied: boolean; rules: string[] };
  expiresAt: number; // 默认 now + runtime.retention.rawDays
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

export interface RecallTrace {
  /** schema 1 是旧原型；schema 2 是 sidecar 碎片化召回 trace（本地对象）。 */
  schema: 1 | 2;
  id: string; // tr_<ULID>
  cloudId: string;
  agentId: string;
  hostId: string;
  threadId?: string;
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
