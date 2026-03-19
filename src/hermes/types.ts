// Hermes 集成接口类型（spec-004 Hermes 集成节）
//
// FactInput/EpisodeInput/SkillInput 直接复用 memory 模块的输入类型
// （与 spec-004 同形）；StoredMemory 在 spec 中被引用但未定义，
// 此处按实现补齐（记录于 project-status 决策记录）。

import type {
  FactInput,
  EpisodeInput,
  SkillInput,
  EpisodeType,
} from '../memory/types.js';

export type { FactInput, EpisodeInput, SkillInput } from '../memory/types.js';

// ---------- 会话与抽取 ----------

export interface HermesMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

export interface HermesSessionData {
  sessionId: string;
  userId: string;
  messages: HermesMessage[];
  startTime: number;
  endTime?: number;
  context?: string;
}

export interface PreferenceInput {
  entity: string;
  preferenceType: string;
  value: string;
  confidence?: number;
  source?: string;
}

export interface ObservationInput {
  type: string;
  content: string;
  confidence?: number;
  source?: string;
  tags?: string[];
}

export interface ExtractionResult {
  facts: FactInput[];
  episodes: EpisodeInput[];
  skills: SkillInput[];
  preferences: PreferenceInput[];
  observations: ObservationInput[];
}

/**
 * 深抽取策略（LLM 在 Hermes 侧）：注入后 extractMemory 先跑规则化浅抽取，
 * 再合并抽取器返回的结构化结果。
 */
export type MemoryExtractor = (
  session: HermesSessionData,
) => Promise<Partial<ExtractionResult>>;

// ---------- 写入 ----------

export interface MemoryInput {
  type: 'fact' | 'episode' | 'skill' | 'preference' | 'observation';
  content: string;
  metadata?: {
    source?: string;
    confidence?: number;
    tags?: string[];
    relatedTo?: string[];
    expiresAt?: number;
    /** episode 专用：情节子类型（缺省按 type 映射） */
    episodeType?: EpisodeType;
    /** skill 专用：分类（缺省 'general'） */
    category?: string;
    /** skill 专用：名称（缺省取 content 首行） */
    name?: string;
    /** preference 专用：偏好类型（缺省 'general'） */
    preferenceType?: string;
  };
}

/** spec-004 引用但未定义的类型，按实现补齐 */
export interface StoredMemory {
  id: string;
  type: string;
  createdAt: number;
}

// ---------- 检索 ----------

export interface MemoryQuery {
  types?: ('fact' | 'episode' | 'skill' | 'preference' | 'observation')[];
  /** 自然语言查询：配置向量索引时走向量，否则退回关键词匹配 */
  query?: string;
  filters?: {
    tags?: string[];
    createdAfter?: number;
    createdBefore?: number;
    entity?: string;
    minConfidence?: number;
  };
  limit?: number;
  offset?: number;
  includeHistory?: boolean;
}

export interface Memory {
  id: string;
  type: string;
  content: string;
  metadata: {
    createdAt: number;
    createdBy: string;
    tags?: string[];
    confidence?: number;
    source?: string;
    validFrom?: number;
    validTo?: number;
  };
  /** 向量检索相关度；未启用向量索引时缺省（不伪造） */
  relevance?: number;
}

export interface RetrievalResult {
  memories: Memory[];
  queryTimeMs: number;
  totalMatches: number;
}

// ---------- 用户画像 ----------

export interface Preference {
  id: string;
  type: string;
  value: string;
  confidence: number;
  validFrom: number;
  validTo?: number;
}

export interface UserProfile {
  userId: string;
  preferences: Preference[];
  properties: Record<string, unknown>;
  updatedAt: number;
}

// ---------- 技能 ----------

export interface SkillFilter {
  category?: string;
  search?: string;
  tags?: string[];
}

/** spec-004 的 Skill 形状（字段平铺，面向 Hermes 侧消费） */
export interface Skill {
  id: string;
  type: 'skill';
  name: string;
  description: string;
  category: string;
  steps?: string[];
  commands?: string[];
  toolReferences?: string[];
  prerequisites?: string[];
  relatedEntities?: string[];
  createdAt: number;
  createdBy: string;
  signature: string;
  tags?: string[];
}

// ---------- 搜索 ----------

export interface SearchQuery {
  query: string;
  types?: string[];
  filters?: {
    tags?: string[];
    createdAfter?: number;
    createdBefore?: number;
  };
  limit?: number;
  /** 是否包含命中节点的相关关系（traverse 一跳） */
  includeRelations?: boolean;
}

export interface Relation {
  sourceId: string;
  targetId: string;
  edgeType: string;
  reason?: string;
}

export interface SearchResult {
  memories: Memory[];
  relations: Relation[];
  queryTimeMs: number;
}

// ---------- 会话历史 ----------

export interface ConversationFilters {
  sessionIds?: string[];
  startTime?: number;
  endTime?: number;
  limit?: number;
  offset?: number;
  topic?: string;
}

export interface ConversationHistory {
  episodes: import('../memory/types.js').EpisodeNode[];
  totalCount: number;
}
