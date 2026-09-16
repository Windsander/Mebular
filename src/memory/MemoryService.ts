// MemoryService（G6.1 / D33）：记忆能力的唯一实现
//
// 检索/写入逻辑只在这里；HermesMemoryProvider 与 MCP 层均为薄壳委托。
// 复用 MemoryStore（类型化写入 + 关键词/向量检索），不重复实现。

import type { Mebular } from '../mebular.js';
import { MemoryStore } from './MemoryStore.js';
import { EdgeTypes, type EpisodeNode, type FactNode, type SkillNode } from './types.js';
import type { VectorIndex } from './VectorIndex.js';
import { ValidationError, ErrorCodes, MebularError, SyncError } from '../errors.js';
import type { Node, TraverseOptions, TraverseResult } from '../types/index.js';
import { matchesNamespace } from '../core/namespace.js';
import { computeStateHash } from '../core/stateHash.js';
import { createBuiltinAdapterRegistry } from '../exchange/index.js';
import type { AdapterImportReport, AdapterSource } from '../exchange/adapter.js';
import type { SyncResult } from '../sync/syncmgr/SyncManager.js';
import type {
  ConversationFilters,
  ConversationHistory,
  ExtractionResult,
  Memory,
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
} from '../hermes/types.js';

export interface MemoryServiceOptions {
  /** 用户实体名（preference/profile 的主体锚点，缺省 'user'） */
  userId?: string;
  /** 向量索引（可插拔；缺省回落到门面 semantic 索引） */
  vectorIndex?: VectorIndex;
  /** 同步等待超时（ms，缺省 30s） */
  syncTimeoutMs?: number;
}

export interface MemoryStatus {
  deviceId: string;
  peerId: string | null;
  running: boolean;
  listenAddrs: string[];
  relays: string[];
  nodeCount: number;
  edgeCount: number;
  stateHash: string;
  atRest: boolean;
  semantic: boolean;
  /** 待发事件数（尚未送达对端的事件；源自 SyncManager.getSyncStatus().pendingCount） */
  pendingEventCount: number;
}

export type ImportInput = AdapterSource;
export type ImportResult = AdapterImportReport;

const PREFERENCE_TAG = 'preference';

export class MemoryService {
  private readonly mebular: Mebular;
  private readonly memory: MemoryStore;
  private readonly userId: string;
  private readonly syncTimeoutMs: number;

  constructor(mebular: Mebular, options: MemoryServiceOptions = {}) {
    this.mebular = mebular;
    this.memory = new MemoryStore(
      mebular.graph,
      options.vectorIndex ?? mebular.semanticVectorIndex ?? undefined,
    );
    this.userId = options.userId ?? 'user';
    this.syncTimeoutMs = options.syncTimeoutMs ?? 30_000;

    // 同步应用远端事件后索引可能落后：标记失效，下次向量查询增量回填（G2-R）
    try {
      mebular.sync.on('sync-completed', () => this.memory.markVectorIndexStale());
    } catch {
      // 门面未初始化时 sync 不可访问；调用方应先 initialize 再构造服务
    }
  }

  // ---------- 写入 ----------

  /** 批量写入（MCP 层钳制 batch ≤ 100） */
  async write(items: MemoryInput[]): Promise<StoredMemory[]> {
    const stored: StoredMemory[] = [];
    for (const item of items) {
      stored.push(await this.writeOne(item));
    }
    return stored;
  }

  /** 结构化抽取结果落图（provider 薄壳的使用路径） */
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

  // ---------- 检索 ----------

  async query(query: MemoryQuery): Promise<RetrievalResult> {
    const startedAt = Date.now();
    const candidateTypes = expandTypes(query.types);

    let nodes: Array<{ node: Node; relevance?: number }>;

    const namespace = query.filters?.namespace;
    const inNamespace = (node: Node): boolean => matchesNamespace(node.namespace, namespace);

    if (query.query && this.memory.hasVectorIndex()) {
      const hits = await this.memory.vectorQuery(query.query, query.limit ?? 10);
      const vectorNodes = hits
        .filter(({ node }) => candidateTypes.includes(node.type) && inNamespace(node))
        .map(({ node, score }) => ({ node, relevance: score }));
      if (vectorNodes.length > 0) {
        nodes = vectorNodes;
      } else {
        // 向量无命中：诚实回退关键词基线（G2-R）
        const keywordHits = await this.memory.search(query.query, { types: candidateTypes, namespace });
        nodes = keywordHits.map((node) => ({ node }));
      }
    } else if (query.query) {
      const hits = await this.memory.search(query.query, { types: candidateTypes, namespace });
      nodes = hits.map((node) => ({ node }));
    } else {
      const collected: Node[] = [];
      for (const type of candidateTypes) {
        collected.push(...(await this.memory.listByType(type, {
          includeDeleted: query.includeHistory,
          ...(namespace !== undefined ? { namespace } : {}),
        })));
      }
      nodes = collected.map((node) => ({ node }));
    }

    let filtered = nodes.filter(({ node }) => this.passFilters(node, query));
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

  async search(query: SearchQuery): Promise<SearchResult> {
    const startedAt = Date.now();
    const hits = await this.memory.search(query.query, {
      types: query.types,
      tags: query.filters?.tags,
      createdAfter: query.filters?.createdAfter,
      createdBefore: query.filters?.createdBefore,
      namespace: query.filters?.namespace,
    });
    const limited = query.limit !== undefined ? hits.slice(0, query.limit) : hits;

    const relations: Relation[] = [];
    if (query.includeRelations) {
      const seenEdges = new Set<string>();
      for (const hit of limited) {
        const traversal = await this.mebular.graph.traverse(hit.id, { maxDepth: 1 });
        for (const edge of traversal.visitedEdges) {
          if (seenEdges.has(edge.id)) continue;
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

  async profile(): Promise<UserProfile> {
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

  async skills(filter?: SkillFilter): Promise<Skill[]> {
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

  async history(filters: ConversationFilters): Promise<ConversationHistory> {
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

  // ---------- 图 / 导入 / 状态 / 同步 ----------

  async graph(startId: string, options?: TraverseOptions): Promise<TraverseResult> {
    return this.mebular.graph.traverse(startId, options);
  }

  async import(input: ImportInput): Promise<ImportResult> {
    const registry = createBuiltinAdapterRegistry();
    return registry.import(input, this.memory);
  }

  async status(): Promise<MemoryStatus> {
    const nodes = await this.mebular.storage.listNodes();
    const edges = await this.mebular.storage.listEdges();
    const node = this.mebular.node;
    let pendingEventCount = 0;
    try {
      const syncStatus = await this.mebular.sync.getSyncStatus();
      pendingEventCount = syncStatus.pendingCount;
    } catch {
      // 门面未初始化时 sync 不可访问
    }
    return {
      deviceId: this.mebular.deviceId,
      peerId: node?.peerId.id ?? null,
      running: node?.isRunning() ?? false,
      listenAddrs: node?.getLocalMultiaddrs() ?? [],
      relays: this.mebular.relayServers,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      stateHash: computeStateHash(nodes, edges),
      atRest: this.mebular.atRestEncryption,
      semantic: this.mebular.semanticVectorIndex !== null,
      pendingEventCount,
    };
  }

  async sync(peerId: string, address?: string): Promise<SyncResult> {
    const node = this.mebular.node;
    if (!node || !node.isRunning()) {
      throw new MebularError('网络未启用，无法同步（network.enabled=false）', ErrorCodes.NETWORK_NOT_RUNNING);
    }
    const remote = { multihash: new Uint8Array(), pubKey: new Uint8Array(), id: peerId };
    const synced = new Promise<SyncResult>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new SyncError(`同步超时（${this.syncTimeoutMs}ms）`, ErrorCodes.SYNC_TIMEOUT)),
        this.syncTimeoutMs,
      );
      this.mebular.sync.once('sync-completed', (result) => {
        clearTimeout(timer);
        resolve(result);
      });
    });
    await node.connectToPeer(remote, address);
    return synced;
  }

  // ---------- 内部 ----------

  private async writeOne(input: MemoryInput): Promise<StoredMemory> {
    const tags = input.metadata?.tags;
    const validTo = input.metadata?.expiresAt;
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
          namespace: input.metadata?.namespace,
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
          namespace: input.metadata?.namespace,
        });
        break;
      case 'episode':
        node = await this.memory.addEpisode({
          episodeType: input.metadata?.episodeType ?? 'other',
          content: input.content,
          tags,
          namespace: input.metadata?.namespace,
        });
        break;
      case 'observation':
        node = await this.memory.addEpisode({
          episodeType: 'observation',
          content: input.content,
          tags,
          namespace: input.metadata?.namespace,
        });
        break;
      case 'skill':
        node = await this.memory.addSkill({
          name: input.metadata?.name ?? firstLine(input.content),
          description: input.content,
          category: input.metadata?.category ?? 'general',
          tags,
          namespace: input.metadata?.namespace,
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

  private passFilters(node: Node, query: MemoryQuery): boolean {
    const filters = query.filters;
    if (!filters) return true;
    if (!matchesNamespace(node.namespace, filters.namespace)) {
      return false;
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

// ---------- 映射（与既有 provider 输出保持同形） ----------

function expandTypes(types?: MemoryQuery['types']): string[] {
  if (!types) {
    return ['entity', 'fact', 'episode', 'skill', 'meta'];
  }
  const expanded = new Set<string>();
  for (const type of types) {
    if (type === 'preference') expanded.add('fact');
    else if (type === 'observation') expanded.add('episode');
    else expanded.add(type);
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
      namespace: node.namespace,
    },
  };
  if (relevance !== undefined) {
    memory.relevance = relevance;
  }
  return memory;
}

function renderContent(node: Node): string {
  const content = node.content;
  if (typeof content === 'string') return content;
  if (!content) return '';
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
