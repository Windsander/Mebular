// MemoryStore - GraphStore 之上的类型化记忆层（phase-4-plan 4.1）
//
// 职责：类型安全的写入（校验必填字段与枚举）、按类型/标签/时间窗查询。
// 所有写入经 GraphStore，自动进入事件日志参与同步；
// Fact 的时间有效性语义（validFrom/validTo）与 Phase 3 冲突规则贯通。

import type { GraphStore } from '../core/GraphStore.js';
import type { Node, NodeFilter } from '../types/index.js';
import { ValidationError } from '../errors.js';
import type { VectorIndex } from './VectorIndex.js';
import {
  ENTITY_TYPES,
  EPISODE_TYPES,
  META_TYPES,
  type EntityContent,
  type EntityInput,
  type EntityNode,
  type EpisodeContent,
  type EpisodeInput,
  type EpisodeNode,
  type FactContent,
  type FactInput,
  type FactNode,
  type MetaContent,
  type MetaInput,
  type MetaNode,
  type SkillContent,
  type SkillInput,
  type SkillNode,
} from './types.js';

export interface MemoryListFilter {
  tags?: string[];
  createdAfter?: number;
  createdBefore?: number;
  includeDeleted?: boolean;
  limit?: number;
}

export class MemoryStore {
  private graph: GraphStore;
  private vectorIndex: VectorIndex | null;

  constructor(graph: GraphStore, vectorIndex?: VectorIndex) {
    this.graph = graph;
    this.vectorIndex = vectorIndex ?? null;
  }

  /** 底层 GraphStore（边操作、traverse 等直接使用） */
  getGraph(): GraphStore {
    return this.graph;
  }

  /** 是否配置了向量检索（未配置时检索走关键词基线，不伪造 relevance） */
  hasVectorIndex(): boolean {
    return this.vectorIndex !== null;
  }

  // ---------- 写入 ----------

  async addEntity(input: EntityInput): Promise<EntityNode> {
    requireNonEmpty(input.name, 'entity.name');
    if (!ENTITY_TYPES.includes(input.entityType)) {
      throw new ValidationError(`非法 entityType：${input.entityType}`, { entityType: input.entityType });
    }
    const content: EntityContent = {
      entityType: input.entityType,
      name: input.name,
    };
    if (input.description !== undefined) content.description = input.description;
    if (input.properties !== undefined) content.properties = input.properties;
    const node = await this.graph.createNode('entity', content, input.labels);
    if (input.tags?.length) {
      for (const tag of input.tags) {
        await this.graph.addTag(node.id, tag);
      }
    }
    return this.finishWrite<EntityNode>(node.id);
  }

  async addFact(input: FactInput): Promise<FactNode> {
    requireNonEmpty(input.subject, 'fact.subject');
    requireNonEmpty(input.predicate, 'fact.predicate');
    requireNonEmpty(input.object, 'fact.object');
    if (input.confidence !== undefined && (input.confidence < 0 || input.confidence > 1)) {
      throw new ValidationError('confidence 须在 [0,1] 区间', { confidence: input.confidence });
    }
    const validFrom = input.validFrom ?? Date.now();
    const validTo = input.validTo ?? 9999999999999;
    if (input.validTo !== undefined && input.validTo < validFrom) {
      throw new ValidationError('validTo 早于 validFrom', { validFrom, validTo: input.validTo });
    }

    const content: FactContent = {
      subject: input.subject,
      predicate: input.predicate,
      object: input.object,
    };
    if (input.confidence !== undefined) content.confidence = input.confidence;
    if (input.source !== undefined) content.source = input.source;

    const node = await this.graph.createNode('fact', content, input.labels, { validFrom, validTo });
    if (input.tags?.length) {
      for (const tag of input.tags) {
        await this.graph.addTag(node.id, tag);
      }
    }
    return this.finishWrite<FactNode>(node.id);
  }

  async addEpisode(input: EpisodeInput): Promise<EpisodeNode> {
    requireNonEmpty(input.content, 'episode.content');
    if (!EPISODE_TYPES.includes(input.episodeType)) {
      throw new ValidationError(`非法 episodeType：${input.episodeType}`, { episodeType: input.episodeType });
    }
    const content: EpisodeContent = {
      episodeType: input.episodeType,
      content: input.content,
    };
    if (input.title !== undefined) content.title = input.title;
    if (input.contentHash !== undefined) content.contentHash = input.contentHash;
    if (input.startTime !== undefined) content.startTime = input.startTime;
    if (input.endTime !== undefined) content.endTime = input.endTime;
    if (input.context !== undefined) content.context = input.context;
    const node = await this.graph.createNode('episode', content, input.labels);
    if (input.tags?.length) {
      for (const tag of input.tags) {
        await this.graph.addTag(node.id, tag);
      }
    }
    return this.finishWrite<EpisodeNode>(node.id);
  }

  async addSkill(input: SkillInput): Promise<SkillNode> {
    requireNonEmpty(input.name, 'skill.name');
    requireNonEmpty(input.description, 'skill.description');
    requireNonEmpty(input.category, 'skill.category');
    const content: SkillContent = {
      name: input.name,
      description: input.description,
      category: input.category,
    };
    if (input.steps !== undefined) content.steps = input.steps;
    if (input.commands !== undefined) content.commands = input.commands;
    if (input.toolReferences !== undefined) content.toolReferences = input.toolReferences;
    if (input.prerequisites !== undefined) content.prerequisites = input.prerequisites;
    if (input.relatedEntities !== undefined) content.relatedEntities = input.relatedEntities;
    const node = await this.graph.createNode('skill', content, input.labels);
    if (input.tags?.length) {
      for (const tag of input.tags) {
        await this.graph.addTag(node.id, tag);
      }
    }
    return this.finishWrite<SkillNode>(node.id);
  }

  async addMeta(input: MetaInput): Promise<MetaNode> {
    requireNonEmpty(input.name, 'meta.name');
    if (!META_TYPES.includes(input.metaType)) {
      throw new ValidationError(`非法 metaType：${input.metaType}`, { metaType: input.metaType });
    }
    const content: MetaContent = { metaType: input.metaType, name: input.name };
    if (input.value !== undefined) content.value = input.value;
    const node = await this.graph.createNode('meta', content, input.labels);
    if (input.tags?.length) {
      for (const tag of input.tags) {
        await this.graph.addTag(node.id, tag);
      }
    }
    return this.finishWrite<MetaNode>(node.id);
  }

  // ---------- 查询 ----------

  async getEntity(id: string): Promise<EntityNode | null> {
    return this.getTyped(id, 'entity');
  }

  async getFact(id: string): Promise<FactNode | null> {
    return this.getTyped(id, 'fact');
  }

  async getEpisode(id: string): Promise<EpisodeNode | null> {
    return this.getTyped(id, 'episode');
  }

  async getSkill(id: string): Promise<SkillNode | null> {
    return this.getTyped(id, 'skill');
  }

  async getMeta(id: string): Promise<MetaNode | null> {
    return this.getTyped(id, 'meta');
  }

  /** 按类型列出记忆节点，支持标签/时间窗/删除过滤 */
  async listByType(type: Node['type'], filter: MemoryListFilter = {}): Promise<Node[]> {
    const nodeFilter: NodeFilter = { type };
    if (filter.tags?.length) {
      nodeFilter.tags = filter.tags;
    }
    if (filter.limit !== undefined) {
      nodeFilter.limit = filter.limit;
    }
    const nodes = await this.graph.listNodes(nodeFilter);
    return nodes.filter((node) => {
      if (!filter.includeDeleted && node.deletedAt) {
        return false;
      }
      if (filter.createdAfter !== undefined && node.createdAt < filter.createdAfter) {
        return false;
      }
      if (filter.createdBefore !== undefined && node.createdAt > filter.createdBefore) {
        return false;
      }
      return true;
    });
  }

  /** 当前仍有效的事实（validFrom <= now < validTo 且未删除） */
  async listActiveFacts(filter: MemoryListFilter = {}): Promise<FactNode[]> {
    const now = Date.now();
    const facts = await this.listByType('fact', filter);
    return facts
      .filter((node) => (node.validFrom ?? 0) <= now && (node.validTo ?? Infinity) > now)
      .map((node) => node as FactNode);
  }

  // ---------- 检索 ----------

  /**
   * 关键词检索基线（零依赖）：大小写不敏感子串匹配，
   * 覆盖名称/描述/事实三元组/正文/分类与标签。
   */
  async search(
    keyword: string,
    filter: MemoryListFilter & { types?: string[] } = {},
  ): Promise<Node[]> {
    const needle = keyword.trim().toLowerCase();
    const types = filter.types ?? ['entity', 'fact', 'episode', 'skill', 'meta'];
    const seen = new Set<string>();
    const hits: Node[] = [];

    for (const type of types) {
      for (const node of await this.listByType(type, filter)) {
        if (seen.has(node.id)) {
          continue;
        }
        if (needle === '' || nodeMatchesKeyword(node, needle)) {
          seen.add(node.id);
          hits.push(node);
        }
      }
    }
    return hits;
  }

  /**
   * 向量检索：配置了 VectorIndex 时返回带分数的命中；
   * 未配置时返回空数组（调用方据此退回关键词基线）。
   */
  async vectorQuery(text: string, k = 10): Promise<Array<{ node: Node; score: number }>> {
    if (!this.vectorIndex) {
      return [];
    }
    const hits = await this.vectorIndex.query(text, k);
    const results: Array<{ node: Node; score: number }> = [];
    for (const hit of hits) {
      const node = await this.graph.getNode(hit.nodeId);
      if (node && !node.deletedAt) {
        results.push({ node, score: hit.score });
      }
    }
    return results;
  }

  // ---------- 内部 ----------

  private async getTyped<T extends Node>(id: string, type: Node['type']): Promise<T | null> {
    const node = await this.graph.getNode(id);
    // 排除墓碑：与 listByType 默认（includeDeleted=false）行为一致（Phase 6.1 修复）
    if (!node || node.type !== type || node.deletedAt) {
      return null;
    }
    return node as T;
  }

  /** 写入收尾：读回节点、（配置后）更新向量索引 */
  private async finishWrite<T extends Node>(id: string): Promise<T> {
    const node = await this.graph.getNode(id);
    if (!node) {
      throw new ValidationError('节点写入后读取失败');
    }
    if (this.vectorIndex) {
      await this.vectorIndex.index(node);
    }
    return node as T;
  }
}

/** 关键词匹配：节点的可读文本字段 + 标签 */
function nodeMatchesKeyword(node: Node, needle: string): boolean {
  const fields: string[] = [];
  const content = node.content;
  if (typeof content === 'string') {
    fields.push(content);
  } else if (content && typeof content === 'object') {
    for (const key of ['name', 'description', 'subject', 'predicate', 'object', 'content', 'title', 'category']) {
      const value = (content as Record<string, unknown>)[key];
      if (typeof value === 'string') {
        fields.push(value);
      }
    }
  }
  fields.push(...(node.tags ?? []));
  return fields.some((field) => field.toLowerCase().includes(needle));
}

function requireNonEmpty(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`${field} 不能为空`, { field });
  }
}
