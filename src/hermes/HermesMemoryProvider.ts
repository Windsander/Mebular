// HermesMemoryProvider（spec-004 Hermes 集成接口 / phase-4-plan 4.2）
//
// Hermes 面向的适配层：七方法全部落在 Mebular 门面之上。
// 关键映射决策（详见 phase-4-plan）：
// - preference → Fact（subject=用户实体, predicate=偏好类型, object=值）+ 'preference' 标签；
// - observation → Episode(episodeType='observation')；
// - MemoryInput 的纯文本 fact 走浅映射（subject=userId, predicate='note'），
//   结构化事实应经 extractMemory → storeExtraction 路径写入；
// - extractMemory 缺省为规则化浅抽取（会话 → Episode 原文）；
//   LLM 深抽取由 Hermes 侧完成，经 options.extractor 注入合并。

import type { Mebular } from '../mebular.js';
import { MemoryStore } from '../memory/MemoryStore.js';
import { EdgeTypes, type EpisodeNode, type FactNode, type SkillNode } from '../memory/types.js';
import type { VectorIndex } from '../memory/VectorIndex.js';
import { ValidationError } from '../errors.js';
import type { Node } from '../types/index.js';
import type {
  ConversationFilters,
  ConversationHistory,
  ExtractionResult,
  HermesSessionData,
  Memory,
  MemoryExtractor,
  MemoryInput,
  MemoryQuery,
  Preference,
  RetrievalResult,
  SearchQuery,
  SearchResult,
  Skill,
  SkillFilter,
  StoredMemory,
  UserProfile,
  Relation,
} from './types.js';

export interface HermesMemoryProviderOptions {
  /** 用户实体名（preference/profile 的主体锚点，缺省 'user'） */
  userId?: string;
  /** 深抽取策略（LLM 在 Hermes 侧）；注入后与浅抽取结果合并 */
  extractor?: MemoryExtractor;
  /** 向量索引（可插拔；缺省检索走关键词基线） */
  vectorIndex?: VectorIndex;
}

const PREFERENCE_TAG = 'preference';

export class HermesMemoryProvider {
  private readonly mebular: Mebular;
  private readonly memory: MemoryStore;
  private readonly userId: string;
  private readonly extractor: MemoryExtractor | null;

  constructor(mebular: Mebular, options: HermesMemoryProviderOptions = {}) {
    this.mebular = mebular;
    this.memory = new MemoryStore(mebular.graph, options.vectorIndex);
    this.userId = options.userId ?? 'user';
    this.extractor = options.extractor ?? null;
  }

  // ---------- 抽取 ----------

  /** 浅抽取：会话 → Episode 原文；注入 extractor 时合并其结构化结果 */
  async extractMemory(sessionData: HermesSessionData): Promise<ExtractionResult> {
    const transcript = sessionData.messages
      .map((m) => `${m.role}: ${m.content}`)
      .join('\n');

    const result: ExtractionResult = {
      facts: [],
      episodes: transcript
        ? [{
            episodeType: 'conversation',
            title: `会话 ${sessionData.sessionId}`,
            content: transcript,
            startTime: sessionData.startTime,
            endTime: sessionData.endTime,
            context: sessionData.sessionId,
          }]
        : [],
      skills: [],
      preferences: [],
      observations: [],
    };

    if (this.extractor) {
      const deep = await this.extractor(sessionData);
      result.facts.push(...(deep.facts ?? []));
      result.episodes.push(...(deep.episodes ?? []));
      result.skills.push(...(deep.skills ?? []));
      result.preferences.push(...(deep.preferences ?? []));
      result.observations.push(...(deep.observations ?? []));
    }

    return result;
  }

  /** 把抽取结果落图（extractMemory 的配套写入路径） */
  async storeExtraction(result: ExtractionResult): Promise<StoredMemory[]> {
    const stored: StoredMemory[] = [];
    for (const fact of result.facts) {
      const node = await this.memory.addFact(fact);
      stored.push({ id: node.id, type: 'fact', createdAt: node.createdAt });
    }
    for (const episode of result.episodes) {
      const node = await this.memory.addEpisode(episode);
      stored.push({ id: node.id, type: 'episode', createdAt: node.createdAt });
    }
    for (const skill of result.skills) {
      const node = await this.memory.addSkill(skill);
      stored.push({ id: node.id, type: 'skill', createdAt: node.createdAt });
    }
    for (const preference of result.preferences) {
      const node = await this.memory.addFact({
        subject: preference.entity,
        predicate: preference.preferenceType,
        object: preference.value,
        confidence: preference.confidence,
        source: preference.source,
        tags: [PREFERENCE_TAG],
      });
      stored.push({ id: node.id, type: 'preference', createdAt: node.createdAt });
    }
    for (const observation of result.observations) {
      const node = await this.memory.addEpisode({
        episodeType: 'observation',
        content: observation.content,
        tags: observation.tags,
      });
      stored.push({ id: node.id, type: 'observation', createdAt: node.createdAt });
    }
    return stored;
  }

  // ---------- 写入 ----------

  async storeMemory(input: MemoryInput): Promise<StoredMemory> {
    const tags = input.metadata?.tags;
    const validTo = input.metadata?.expiresAt;
    // 已过期记忆是合法输入（如导入）：validFrom 钳到不晚于 validTo，保持时间窗不变量
    const validFrom = validTo !== undefined ? Math.min(Date.now(), validTo) : undefined;

    let node: Node;
    switch (input.type) {
      case 'fact':
        node = await this.memory.addFact({
          subject: this.userId,
          predicate: 'note',
          object: input.content,
          confidence: input.metadata?.confidence,
          source: input.metadata?.source,
          validFrom,
          validTo,
          tags,
        });
        break;
      case 'preference':
        node = await this.memory.addFact({
          subject: this.userId,
          predicate: input.metadata?.preferenceType ?? 'general',
          object: input.content,
          confidence: input.metadata?.confidence,
          source: input.metadata?.source,
          validFrom,
          validTo,
          tags: [...(tags ?? []), PREFERENCE_TAG],
        });
        break;
      case 'episode':
        node = await this.memory.addEpisode({
          episodeType: input.metadata?.episodeType ?? 'other',
          content: input.content,
          tags,
        });
        break;
      case 'observation':
        node = await this.memory.addEpisode({
          episodeType: 'observation',
          content: input.content,
          tags,
        });
        break;
      case 'skill':
        node = await this.memory.addSkill({
          name: input.metadata?.name ?? firstLine(input.content),
          description: input.content,
          category: input.metadata?.category ?? 'general',
          tags,
        });
        break;
      default:
        throw new ValidationError(`Unknown memory type: ${input.type as string}`);
    }

    // relatedTo：只链接已存在的目标节点（诚实失败，不造悬空边）
    for (const targetId of input.metadata?.relatedTo ?? []) {
      if (await this.mebular.graph.getNode(targetId)) {
        await this.mebular.graph.createEdge(node.id, targetId, EdgeTypes.RELATED_TO);
      }
    }

    return { id: node.id, type: input.type, createdAt: node.createdAt };
  }

  // ---------- 检索 ----------

  async retrieveMemory(query: MemoryQuery): Promise<RetrievalResult> {
    const startedAt = Date.now();
    const candidateTypes = expandTypes(query.types);

    let nodes: Array<{ node: Node; relevance?: number }>;

    if (query.query && this.memory.hasVectorIndex()) {
      const hits = await this.memory.vectorQuery(query.query, query.limit ?? 10);
      // 向量路径同样按 types 收窄（与关键词路径行为对齐，Phase 6.1 修复）
      nodes = hits
        .filter(({ node }) => candidateTypes.includes(node.type))
        .map(({ node, score }) => ({ node, relevance: score }));
    } else if (query.query) {
      const hits = await this.memory.search(query.query, { types: candidateTypes });
      nodes = hits.map((node) => ({ node }));
    } else {
      const collected: Node[] = [];
      for (const type of candidateTypes) {
        collected.push(...(await this.memory.listByType(type, { includeDeleted: query.includeHistory })));
      }
      nodes = collected.map((node) => ({ node }));
    }

    let filtered = nodes.filter(({ node }) => this.passFilters(node, query));

    // preference 虚拟类型：只保留带 preference 标签的事实
    if (query.types?.includes('preference')) {
      filtered = filtered.filter(({ node }) =>
        node.type !== 'fact' || (node.tags ?? []).includes(PREFERENCE_TAG));
    }

    const totalMatches = filtered.length;
    const offset = query.offset ?? 0;
    const limited = query.limit !== undefined
      ? filtered.slice(offset, offset + query.limit)
      : filtered.slice(offset);

    return {
      memories: limited.map(({ node, relevance }) => toMemory(node, relevance)),
      queryTimeMs: Date.now() - startedAt,
      totalMatches,
    };
  }

  async searchMemory(query: SearchQuery): Promise<SearchResult> {
    const startedAt = Date.now();
    const hits = await this.memory.search(query.query, {
      types: query.types,
      tags: query.filters?.tags,
      createdAfter: query.filters?.createdAfter,
      createdBefore: query.filters?.createdBefore,
    });
    const limited = query.limit !== undefined ? hits.slice(0, query.limit) : hits;

    const relations: Relation[] = [];
    if (query.includeRelations) {
      const seenEdges = new Set<string>();
      for (const hit of limited) {
        const traversal = await this.mebular.graph.traverse(hit.id, { maxDepth: 1 });
        for (const edge of traversal.visitedEdges) {
          if (seenEdges.has(edge.id)) {
            continue;
          }
          seenEdges.add(edge.id);
          relations.push({
            sourceId: edge.source,
            targetId: edge.target,
            edgeType: edge.relation,
            reason: `与命中节点 ${hit.id} 一跳相关`,
          });
        }
      }
    }

    return {
      memories: limited.map((node) => toMemory(node)),
      relations,
      queryTimeMs: Date.now() - startedAt,
    };
  }

  // ---------- 画像 / 技能 / 历史 ----------

  async getUserProfile(): Promise<UserProfile> {
    const entities = await this.memory.listByType('entity');
    const userEntity = entities.find(
      (node) => (node.content as { entityType?: string }).entityType === 'user'
        && (node.content as { name?: string }).name === this.userId,
    );

    const preferenceFacts = (await this.memory.listActiveFacts())
      .filter((fact) => (fact.tags ?? []).includes(PREFERENCE_TAG));

    const preferences: Preference[] = preferenceFacts.map((fact) => ({
      id: fact.id,
      type: fact.content.predicate,
      value: fact.content.object,
      confidence: fact.content.confidence ?? 1,
      validFrom: fact.validFrom ?? fact.createdAt,
      validTo: fact.validTo === 9999999999999 ? undefined : fact.validTo,
    }));

    return {
      userId: this.userId,
      preferences,
      properties: (userEntity?.content as { properties?: Record<string, unknown> })?.properties ?? {},
      updatedAt: Date.now(),
    };
  }

  async getSkills(filter?: SkillFilter): Promise<Skill[]> {
    let nodes = await this.memory.listByType('skill', { tags: filter?.tags });
    if (filter?.category) {
      nodes = nodes.filter((node) => (node.content as { category?: string }).category === filter.category);
    }
    if (filter?.search) {
      const needle = filter.search.toLowerCase();
      nodes = nodes.filter((node) => {
        const content = node.content as { name?: string; description?: string };
        return content.name?.toLowerCase().includes(needle)
          || content.description?.toLowerCase().includes(needle);
      });
    }
    return nodes.map((node) => toSpecSkill(node as SkillNode));
  }

  async getConversationHistory(filters: ConversationFilters): Promise<ConversationHistory> {
    let episodes = (await this.memory.listByType('episode')) as EpisodeNode[];
    episodes = episodes.filter((episode) => episode.content.episodeType === 'conversation');

    if (filters.sessionIds?.length) {
      episodes = episodes.filter((episode) =>
        filters.sessionIds!.includes(episode.content.context ?? ''));
    }
    if (filters.startTime !== undefined) {
      episodes = episodes.filter((episode) =>
        (episode.content.startTime ?? episode.createdAt) >= filters.startTime!);
    }
    if (filters.endTime !== undefined) {
      episodes = episodes.filter((episode) =>
        (episode.content.endTime ?? episode.content.startTime ?? episode.createdAt) <= filters.endTime!);
    }
    if (filters.topic) {
      const needle = filters.topic.toLowerCase();
      episodes = episodes.filter((episode) =>
        episode.content.content.toLowerCase().includes(needle)
        || episode.content.title?.toLowerCase().includes(needle));
    }

    episodes.sort((a, b) => (b.content.startTime ?? b.createdAt) - (a.content.startTime ?? a.createdAt));

    const totalCount = episodes.length;
    const offset = filters.offset ?? 0;
    const limited = filters.limit !== undefined
      ? episodes.slice(offset, offset + filters.limit)
      : episodes.slice(offset);

    return { episodes: limited, totalCount };
  }

  // ---------- 内部 ----------

  private passFilters(node: Node, query: MemoryQuery): boolean {
    const filters = query.filters;
    if (!filters) {
      return true;
    }
    if (filters.tags?.length && !filters.tags.every((tag) => (node.tags ?? []).includes(tag))) {
      return false;
    }
    if (filters.createdAfter !== undefined && node.createdAt < filters.createdAfter) {
      return false;
    }
    if (filters.createdBefore !== undefined && node.createdAt > filters.createdBefore) {
      return false;
    }
    if (filters.entity && node.type === 'fact') {
      if ((node as FactNode).content.subject !== filters.entity) {
        return false;
      }
    }
    if (filters.minConfidence !== undefined) {
      const confidence = (node.content as { confidence?: number }).confidence;
      if ((confidence ?? 1) < filters.minConfidence) {
        return false;
      }
    }
    return true;
  }
}

// ---------- 映射 ----------

/** MemoryQuery.types 的虚拟类型展开：preference→fact、observation→episode */
function expandTypes(types?: MemoryQuery['types']): string[] {
  if (!types) {
    return ['entity', 'fact', 'episode', 'skill', 'meta'];
  }
  const expanded = new Set<string>();
  for (const type of types) {
    if (type === 'preference') {
      expanded.add('fact');
    } else if (type === 'observation') {
      expanded.add('episode');
    } else {
      expanded.add(type);
    }
  }
  return [...expanded];
}

function toMemory(node: Node, relevance?: number): Memory {
  const content = node.content as Record<string, unknown> | undefined;
  const memory: Memory = {
    id: node.id,
    type: node.type,
    content: renderContent(node),
    metadata: {
      createdAt: node.createdAt,
      createdBy: node.createdBy,
      tags: node.tags,
      confidence: content?.confidence as number | undefined,
      source: content?.source as string | undefined,
      validFrom: node.validFrom,
      validTo: node.validTo === 9999999999999 ? undefined : node.validTo,
    },
  };
  if (relevance !== undefined) {
    memory.relevance = relevance;
  }
  return memory;
}

function renderContent(node: Node): string {
  const content = node.content;
  if (typeof content === 'string') {
    return content;
  }
  if (!content) {
    return '';
  }
  if (node.type === 'fact') {
    const fact = content as { subject: string; predicate: string; object: string };
    return `${fact.subject} ${fact.predicate} ${fact.object}`;
  }
  const record = content as Record<string, unknown>;
  return String(record.content ?? record.name ?? record.title ?? JSON.stringify(content));
}

function toSpecSkill(node: SkillNode): Skill {
  return {
    id: node.id,
    type: 'skill',
    name: node.content.name,
    description: node.content.description,
    category: node.content.category,
    steps: node.content.steps,
    commands: node.content.commands,
    toolReferences: node.content.toolReferences,
    prerequisites: node.content.prerequisites,
    relatedEntities: node.content.relatedEntities,
    createdAt: node.createdAt,
    createdBy: node.createdBy,
    signature: node.signature,
    tags: node.tags,
  };
}

function firstLine(text: string): string {
  const line = text.split('\n', 1)[0]?.trim() ?? '';
  return line === '' ? 'skill' : line.slice(0, 80);
}
