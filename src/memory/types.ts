// 类型化记忆模型（spec-004 节点/边类型 / phase-4-plan 4.1）
//
// 存储层 Node 保持通用（type + content），类型字段住在 content 里；
// 本模块提供五类记忆节点的内容接口、类型别名与边类型常量。
// 节点 ID 维持 ULID（事件层已有内容寻址幂等；节点改内容寻址会破坏
// 可更新性——同内容修改后 ID 变化会打断边引用，见 phase-4-plan 决策点）。

import type { Node } from '../types/index.js';

// ---------- 实体 ----------

export type EntityType = 'user' | 'project' | 'tool' | 'concept' | 'organization' | 'location' | 'other';

export type EntityContent = {
  entityType: EntityType;
  name: string;
  description?: string;
  properties?: Record<string, unknown>;
};

export type EntityNode = Node & { type: 'entity'; content: EntityContent };

// ---------- 事实 ----------

export type FactContent = {
  subject: string;
  predicate: string;
  object: string;
  confidence?: number;
  source?: string;
};

export type FactNode = Node & { type: 'fact'; content: FactContent };

// ---------- 情节 ----------

export type EpisodeType = 'conversation' | 'task' | 'decision' | 'error' | 'observation' | 'other';

export type EpisodeContent = {
  episodeType: EpisodeType;
  title?: string;
  content: string;
  contentHash?: string;
  startTime?: number;
  endTime?: number;
  context?: string;
}

export type EpisodeNode = Node & { type: 'episode'; content: EpisodeContent };

// ---------- 技能 ----------

export type SkillContent = {
  name: string;
  description: string;
  category: string;
  steps?: string[];
  commands?: string[];
  toolReferences?: string[];
  prerequisites?: string[];
  relatedEntities?: string[];
};

export type SkillNode = Node & { type: 'skill'; content: SkillContent };

// ---------- 元数据 ----------

export type MetaType = 'tag' | 'category' | 'index' | 'sync-group' | 'other';

export type MetaContent = {
  metaType: MetaType;
  name: string;
  value?: unknown;
};

export type MetaNode = Node & { type: 'meta'; content: MetaContent };

export type MemoryNode = EntityNode | FactNode | EpisodeNode | SkillNode | MetaNode;

// ---------- 输入类型（写入侧） ----------

export type EntityInput = EntityContent & { tags?: string[]; labels?: string[] };

export interface FactInput {
  subject: string;
  predicate: string;
  object: string;
  validFrom?: number;
  validTo?: number;
  confidence?: number;
  source?: string;
  tags?: string[];
}

export type EpisodeInput = EpisodeContent & { tags?: string[]; labels?: string[] };

export type SkillInput = SkillContent & { tags?: string[]; labels?: string[] };

export type MetaInput = MetaContent & { tags?: string[]; labels?: string[] };

// ---------- 边类型常量（spec-004） ----------

export const EdgeTypes = {
  PREFERS: 'prefers',
  KNOWS: 'knows',
  WORKS_ON: 'works_on',
  USES: 'uses',
  OWNS: 'owns',
  LOCATED_IN: 'located_in',
  RELATED_TO: 'related_to',
  TAGS: 'tags',
  BELONGS_TO: 'belongs_to',
  INDEXES: 'indexes',
  PREREQUISITE_OF: 'prerequisite_of',
  SOLVES: 'solves',
  DEPENDS_ON: 'depends_on',
  EXTENDS: 'extends',
  CONSTITUTES: 'constitutes',
  SUPERSEDES: 'supersedes',
  CONFLICTS_WITH: 'conflicts_with',
  SOURCE_OF: 'source_of',
  FOLLOWS: 'follows',
  PART_OF: 'part_of',
  RESULTS_IN: 'results_in',
  OBSERVES: 'observes',
  SYNCED_FROM: 'synced_from',
  CONFLICT_RESOLVED: 'conflict_resolved',
} as const;

export type EdgeTypeName = (typeof EdgeTypes)[keyof typeof EdgeTypes];

export const ENTITY_TYPES: readonly EntityType[] = [
  'user', 'project', 'tool', 'concept', 'organization', 'location', 'other',
];

export const EPISODE_TYPES: readonly EpisodeType[] = [
  'conversation', 'task', 'decision', 'error', 'observation', 'other',
];

export const META_TYPES: readonly MetaType[] = [
  'tag', 'category', 'index', 'sync-group', 'other',
];
