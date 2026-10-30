// MemoryService（G6.1 / D33）：记忆能力的唯一实现
//
// 检索/写入逻辑只在这里；HermesMemoryProvider 与 MCP 层均为薄壳委托。
// 复用 MemoryStore（类型化写入 + 关键词/向量检索），不重复实现。

import type { Mebular } from '../mebular.js';
import { MemoryStore, isArchived } from './MemoryStore.js';
import {
  EdgeTypes,
  type EntityType,
  type EpisodeNode,
  type EpisodeType,
  type FactNode,
  type SkillNode,
} from './types.js';
import type { VectorIndex } from './VectorIndex.js';
import { isInternalNode } from './visibility.js';
import { ValidationError, ErrorCodes, MebularError, SyncError } from '../errors.js';
import type { Node, TraverseOptions, TraverseResult } from '../types/index.js';
import { matchesNamespace } from '../core/namespace.js';
import { computeStateHash, computeStateHashByNamespace } from '../core/stateHash.js';
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

/** 统一 MemoryRecord 语义类型（observation 始终落为 episode）。 */
export type StructuredMemoryKind = 'fact' | 'preference' | 'episode' | 'observation' | 'skill' | 'entity';

/**
 * 结构化记忆写入输入（MemoryService 的统一落库形状）。
 *
 * 公共 `memory_write` 与内部 capability `/write` 各自保留自己的 API 形状，
 * 但最终都构造本结构并交给 `MemoryService.writeRecords`；不允许再有第二条
 * 直接 `GraphStore.createNode` 的普通 MemoryRecord 写入路径。
 *
 * - fact/preference：content 使用 subject/predicate/object（preference 也兼容
 *   entity/preferenceType/value，由服务归一化），preference 自动带 `preference` 标签；
 * - episode/observation：content 需有 content 正文；observation 强制 episodeType=observation；
 * - skill/entity：content 使用对应的结构化字段。
 */
export interface StructuredMemoryRecord {
  kind: StructuredMemoryKind;
  content: Record<string, unknown>;
  namespace?: string;
  tags?: string[];
  labels?: string[];
  validFrom?: number;
  validTo?: number;
  /** fact/preference：优先于 content.confidence */
  confidence?: number;
  /** fact/preference：优先于 content.source */
  source?: string;
  /** 只链接已存在、未删除且非内部的节点 */
  relatedTo?: string[];
  /** 节点创建后合并的 metadata（kind/provenance/contentHash/clientItemId 等） */
  metadata?: Record<string, unknown>;
}

export interface WriteRecordsOptions {
  /**
   * 向量索引刷新失败时不回滚图写入，仅在结果里标记 vectorIndexed=false。
   * 公共工具保持默认（失败即报错）；capability 用 true 保留 warning 语义。
   */
  tolerateVectorIndexFailure?: boolean;
}

/** 统一写入结果；`node` 供 capability 构造响应，`type` 是实际节点类型。 */
export interface StoredStructuredMemory {
  id: string;
  type: Node['type'];
  kind: StructuredMemoryKind;
  createdAt: number;
  node: Node;
  /** relatedTo 目标不存在、已删除或为内部对象而未创建边 */
  skippedRelatedTo: string[];
  /** 配置了向量索引时是否刷新成功；未配置索引视为 true */
  vectorIndexed: boolean;
}

export interface UpdateMemoryRecordInput {
  id: string;
  content?: Record<string, unknown>;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface UpdatedMemoryRecord {
  node: Node;
  vectorIndexed: boolean;
}

/**
 * G-ML-1 生命周期选项：**默认不召回已归档**（`metadata.archivedAt`）；显式 `includeArchived: true` 才可见。
 * 以交叉类型方式挂在查询参数上——不改动 Hermes/工具侧的既有类型定义。
 */
export interface LifecycleOptions {
  includeArchived?: boolean;
}

/** G-ML-1 删除结果（墓碑；随 `node_deleted` 事件同步传播）。 */
export interface DeleteResult {
  deleted: string[];
  notFound: string[];
  /** 内部对象默认拒绝普通删除（需管理端点） */
  internal?: string[];
}

/** G-ML-1 归档结果（`metadata.archivedAt` 标记，可逆；随 `node_updated` 事件同步传播）。 */
export interface ArchiveResult {
  archived: string[];
  unarchived: string[];
  notFound: string[];
  /** 墓碑节点：不可归档（删除不可逆于归档语义） */
  skipped: string[];
  /** 内部对象默认拒绝普通归档/解除归档 */
  internal?: string[];
}

export interface MemoryStatus {
  deviceId: string;
  peerId: string | null;
  running: boolean;
  listenAddrs: string[];
  relays: string[];
  nodeCount: number;
  edgeCount: number;
  /** 全局状态哈希（兼容保留）；不同授权域的两端天然不同，跨端自检请比 `stateHashByNamespace` 的共同域 */
  stateHash: string;
  /** 按分区的状态哈希（①）：跨端一致性自检只比共同授权域 */
  stateHashByNamespace: Record<string, string>;
  atRest: boolean;
  semantic: boolean;
  /** 待发事件数（尚未送达对端的事件；源自 SyncManager.getSyncStatus().pendingCount） */
  pendingEventCount: number;
  /** C3/F-NET-1：LAN 设备发现状态；禁用时带原因（其余传输不受影响） */
  lan: {
    enabled: boolean;
    discovery: { running: boolean; disabled: boolean; reason: string | null };
  } | null;
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

  /** 批量写入（MCP 层钳制 batch ≤ 100；公共工具的唯一写入入口） */
  async write(items: MemoryInput[]): Promise<StoredMemory[]> {
    const stored: StoredMemory[] = [];
    for (const item of items) {
      stored.push(await this.writeOne(item));
    }
    return stored;
  }

  /**
   * 统一 MemoryRecord 落库（公共 `memory_write` / capability `/write` / 抽取结果共用）。
   *
   * 只通过 MemoryStore 的类型化写入方法落图；metadata 在节点创建后合并，
   * relatedTo 由服务统一跳过缺失/墓碑/内部对象，最后统一刷新向量索引。
   */
  async writeRecords(
    records: StructuredMemoryRecord[],
    options: WriteRecordsOptions = {},
  ): Promise<StoredStructuredMemory[]> {
    const stored: StoredStructuredMemory[] = [];
    for (const record of records) {
      stored.push(await this.writeRecord(record, options));
    }
    return stored;
  }

  /** 结构化抽取结果落图（provider 薄壳的使用路径；复用 writeRecords） */
  async storeExtraction(result: ExtractionResult): Promise<StoredMemory[]> {
    const records: StructuredMemoryRecord[] = [];
    for (const fact of result.facts) {
      records.push({
        kind: 'fact',
        content: {
          subject: fact.subject,
          predicate: fact.predicate,
          object: fact.object,
          ...(fact.confidence !== undefined ? { confidence: fact.confidence } : {}),
          ...(fact.source !== undefined ? { source: fact.source } : {}),
        },
        ...(fact.validFrom !== undefined ? { validFrom: fact.validFrom } : {}),
        ...(fact.validTo !== undefined ? { validTo: fact.validTo } : {}),
        ...(fact.tags !== undefined ? { tags: fact.tags } : {}),
        ...(fact.labels !== undefined ? { labels: fact.labels } : {}),
        ...(fact.namespace !== undefined ? { namespace: fact.namespace } : {}),
      });
    }
    for (const episode of result.episodes) {
      records.push({
        kind: 'episode',
        content: {
          episodeType: episode.episodeType,
          content: episode.content,
          ...(episode.title !== undefined ? { title: episode.title } : {}),
          ...(episode.contentHash !== undefined ? { contentHash: episode.contentHash } : {}),
          ...(episode.startTime !== undefined ? { startTime: episode.startTime } : {}),
          ...(episode.endTime !== undefined ? { endTime: episode.endTime } : {}),
          ...(episode.context !== undefined ? { context: episode.context } : {}),
        },
        ...(episode.validFrom !== undefined ? { validFrom: episode.validFrom } : {}),
        ...(episode.validTo !== undefined ? { validTo: episode.validTo } : {}),
        ...(episode.tags !== undefined ? { tags: episode.tags } : {}),
        ...(episode.labels !== undefined ? { labels: episode.labels } : {}),
        ...(episode.namespace !== undefined ? { namespace: episode.namespace } : {}),
      });
    }
    for (const skill of result.skills) {
      records.push({
        kind: 'skill',
        content: {
          name: skill.name,
          description: skill.description,
          category: skill.category,
          ...(skill.steps !== undefined ? { steps: skill.steps } : {}),
          ...(skill.commands !== undefined ? { commands: skill.commands } : {}),
          ...(skill.toolReferences !== undefined ? { toolReferences: skill.toolReferences } : {}),
          ...(skill.prerequisites !== undefined ? { prerequisites: skill.prerequisites } : {}),
          ...(skill.relatedEntities !== undefined ? { relatedEntities: skill.relatedEntities } : {}),
        },
        ...(skill.validFrom !== undefined ? { validFrom: skill.validFrom } : {}),
        ...(skill.validTo !== undefined ? { validTo: skill.validTo } : {}),
        ...(skill.tags !== undefined ? { tags: skill.tags } : {}),
        ...(skill.labels !== undefined ? { labels: skill.labels } : {}),
        ...(skill.namespace !== undefined ? { namespace: skill.namespace } : {}),
      });
    }
    for (const preference of result.preferences) {
      records.push({
        kind: 'preference',
        content: {
          subject: preference.entity,
          predicate: preference.preferenceType,
          object: preference.value,
          ...(preference.confidence !== undefined ? { confidence: preference.confidence } : {}),
          ...(preference.source !== undefined ? { source: preference.source } : {}),
        },
      });
    }
    for (const observation of result.observations) {
      records.push({
        kind: 'observation',
        content: { content: observation.content },
        ...(observation.tags !== undefined ? { tags: observation.tags } : {}),
      });
    }
    return (await this.writeRecords(records)).map((stored) => ({
      id: stored.id,
      type: stored.kind,
      createdAt: stored.createdAt,
    }));
  }

  // ---------- 检索 ----------

  async query(query: MemoryQuery & LifecycleOptions): Promise<RetrievalResult> {
    const startedAt = Date.now();
    const candidateTypes = expandTypes(query.types);
    const includeArchived = query.includeArchived === true;

    let nodes: Array<{ node: Node; relevance?: number }>;

    const namespace = query.filters?.namespace;
    const inNamespace = (node: Node): boolean => matchesNamespace(node.namespace, namespace);

    if (query.query && this.memory.hasVectorIndex()) {
      const hits = await this.memory.vectorQuery(query.query, query.limit ?? 10, { includeArchived });
      const vectorNodes = hits
        .filter(({ node }) => candidateTypes.includes(node.type) && inNamespace(node))
        .map(({ node, score }) => ({ node, relevance: score }));
      if (vectorNodes.length > 0) {
        nodes = vectorNodes;
      } else {
        // 向量无命中：诚实回退关键词基线（G2-R）
        const keywordHits = await this.memory.search(query.query, { types: candidateTypes, namespace, includeArchived });
        nodes = keywordHits.map((node) => ({ node }));
      }
    } else if (query.query) {
      const hits = await this.memory.search(query.query, { types: candidateTypes, namespace, includeArchived });
      nodes = hits.map((node) => ({ node }));
    } else {
      const collected: Node[] = [];
      for (const type of candidateTypes) {
        collected.push(...(await this.memory.listByType(type, {
          includeDeleted: query.includeHistory,
          includeArchived,
          ...(namespace !== undefined ? { namespace } : {}),
        })));
      }
      nodes = collected.map((node) => ({ node }));
    }

    let filtered = nodes.filter(({ node }) => this.passFilters(node, query) && !isInternalNode(node));
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

  async search(query: SearchQuery & LifecycleOptions): Promise<SearchResult> {
    const startedAt = Date.now();
    const hits = await this.memory.search(query.query, {
      types: query.types,
      tags: query.filters?.tags,
      createdAfter: query.filters?.createdAfter,
      createdBefore: query.filters?.createdBefore,
      namespace: query.filters?.namespace,
      includeArchived: query.includeArchived === true,
    });
    const limited = query.limit !== undefined ? hits.slice(0, query.limit) : hits;

    const relations: Relation[] = [];
    if (query.includeRelations) {
      const seenEdges = new Set<string>();
      for (const hit of limited) {
        const traversal = await this.mebular.graph.traverse(hit.id, { maxDepth: 1 });
        for (const edge of traversal.visitedEdges) {
          if (seenEdges.has(edge.id)) continue;
          const [sourceNode, targetNode] = await Promise.all([
            this.mebular.graph.getNode(edge.source),
            this.mebular.graph.getNode(edge.target),
          ]);
          // 防御性过滤：内部对象不得经关系端点泄漏给普通 search。
          if ((sourceNode && isInternalNode(sourceNode))
            || (targetNode && isInternalNode(targetNode))) {
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

  async profile(options: LifecycleOptions = {}): Promise<UserProfile> {
    const includeArchived = options.includeArchived === true;
    const entities = await this.memory.listByType('entity', { includeArchived });
    const userEntity = entities.find(
      (node) => (node.content as { entityType?: string }).entityType === 'user'
        && (node.content as { name?: string }).name === this.userId,
    );

    const preferenceFacts = (await this.memory.listActiveFacts({ includeArchived }))
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

  async skills(filter?: SkillFilter & LifecycleOptions): Promise<Skill[]> {
    let nodes = await this.memory.listByType('skill', { tags: filter?.tags, includeArchived: filter?.includeArchived === true });
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

  async history(filters: ConversationFilters & LifecycleOptions): Promise<ConversationHistory> {
    let episodes = (await this.memory.listByType('episode', { includeArchived: filters.includeArchived === true })) as EpisodeNode[];
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

  // ---------- 生命周期：删除 / 归档（G-ML-1） ----------

  /**
   * 删除：复用 GraphStore 既有墓碑 API（`deleteNode` → `deletedAt` + `node_deleted` 事件）。
   * 删除后默认不参与任何召回，且**随图事件同步**到各端（D1a：墓碑传播；对端旧快照无法强制回收）。
   */
  async delete(ids: string[]): Promise<DeleteResult> {
    const deleted: string[] = [];
    const notFound: string[] = [];
    const internal: string[] = [];
    for (const id of ids) {
      const node = await this.mebular.graph.getNode(id);
      if (node && isInternalNode(node)) {
        internal.push(id);
        continue;
      }
      const ok = await this.mebular.graph.deleteNode(id);
      (ok ? deleted : notFound).push(id);
    }
    return internal.length > 0
      ? { deleted, notFound, internal }
      : { deleted, notFound };
  }

  /**
   * 归档 / 解除归档：节点级 `metadata.archivedAt` 标记（走 `updateNode` → `node_updated` 事件）。
   * 可逆、无损；默认不参与召回，`includeArchived: true` 可查。墓碑节点跳过（skipped）。
   * G-ML-1r：归档不改内容但改变「是否可召回」，标记向量索引失效 → 下次向量查询
   * 按最新图自愈（`listAllNodes` 含归档，故归档条目保留、解除后即可再召回）。
   */
  async archive(ids: string[], archived = true): Promise<ArchiveResult> {
    const archivedIds: string[] = [];
    const unarchivedIds: string[] = [];
    const notFound: string[] = [];
    const skipped: string[] = [];
    const internal: string[] = [];
    for (const id of ids) {
      const node = await this.mebular.graph.getNode(id);
      if (!node) { notFound.push(id); continue; }
      if (isInternalNode(node)) { internal.push(id); continue; }
      if (node.deletedAt) { skipped.push(id); continue; }
      const raw = (node.metadata ?? {}) as Record<string, unknown>;
      const { archivedAt: _drop, ...rest } = raw;
      const metadata = archived ? { ...rest, archivedAt: Date.now() } : rest;
      await this.mebular.graph.updateNode(id, { metadata });
      (archived ? archivedIds : unarchivedIds).push(id);
    }
    if (archivedIds.length > 0 || unarchivedIds.length > 0) {
      this.memory.markVectorIndexStale();
    }
    return internal.length > 0
      ? { archived: archivedIds, unarchived: unarchivedIds, notFound, skipped, internal }
      : { archived: archivedIds, unarchived: unarchivedIds, notFound, skipped };
  }

  // ---------- 图 / 导入 / 状态 / 同步 ----------

  async graph(startId: string, options?: TraverseOptions & LifecycleOptions): Promise<TraverseResult> {
    const includeArchived = options?.includeArchived === true;
    const start = await this.mebular.graph.getNode(startId);
    // 内部对象不是公共记忆图的一部分；从内部 id 起遍历直接拒绝（不返回部分图）。
    if (start && isInternalNode(start)) {
      throw new MebularError('内部对象不可通过记忆图访问', 'INTERNAL_OBJECT');
    }
    const result = await this.mebular.graph.traverse(startId, options);
    // G-ML-1：归档默认不参与遍历（节点与边按端点过滤；起点的归档由 core 侧决定）
    // 内部对象无论 includeArchived 与否都不可见。
    const keep = (node: Node): boolean =>
      !isInternalNode(node) && (includeArchived || !isArchived(node));
    const keptIds = new Set(result.visitedNodes.filter(keep).map((n) => n.id));
    return {
      ...result,
      visitedNodes: result.visitedNodes.filter(keep),
      // G-ML-1r：**两端都在可见集**才保留边——否则归档/内部节点 id 会经端点泄漏
      visitedEdges: result.visitedEdges.filter((e) => keptIds.has(e.source) && keptIds.has(e.target)),
    };
  }

  async import(input: ImportInput): Promise<ImportResult> {
    const registry = createBuiltinAdapterRegistry();
    return registry.import(input, this.memory);
  }

  async status(): Promise<MemoryStatus> {
    const nodes = await this.mebular.storage.listNodes();
    const edges = await this.mebular.storage.listEdges();
    const node = this.mebular.node;
    const lanStatus = node?.getLanStatus?.();
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
      stateHashByNamespace: computeStateHashByNamespace(nodes, edges),
      atRest: this.mebular.atRestEncryption,
      semantic: this.mebular.semanticVectorIndex !== null,
      pendingEventCount,
      // F-NET-1（B）：发现层禁用时暴露「已禁用 + 原因」，其余传输不受影响
      lan: lanStatus
        ? {
            enabled: lanStatus.enabled,
            discovery: {
              running: lanStatus.running,
              disabled: !lanStatus.enabled,
              reason: lanStatus.lastError ?? null,
            },
          }
        : null,
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

  /** 公共 `memory_write` 形状 → 统一 MemoryRecord；语义保持不变。 */
  private async writeOne(input: MemoryInput): Promise<StoredMemory> {
    const tags = input.metadata?.tags;
    const validTo = input.metadata?.expiresAt;
    const validFrom = validTo !== undefined ? Math.min(Date.now(), validTo) : undefined;
    const namespace = input.metadata?.namespace;
    const relatedTo = input.metadata?.relatedTo;
    const temporal = { ...(validFrom !== undefined ? { validFrom } : {}), ...(validTo !== undefined ? { validTo } : {}) };

    let record: StructuredMemoryRecord;
    switch (input.type) {
      case 'fact':
        record = {
          kind: 'fact',
          content: { subject: this.userId, predicate: 'note', object: input.content },
          confidence: input.metadata?.confidence,
          source: input.metadata?.source,
          ...temporal,
          ...(tags !== undefined ? { tags } : {}),
          ...(namespace !== undefined ? { namespace } : {}),
          ...(relatedTo !== undefined ? { relatedTo } : {}),
        };
        break;
      case 'preference':
        record = {
          kind: 'preference',
          content: {
            subject: this.userId,
            predicate: input.metadata?.preferenceType ?? 'general',
            object: input.content,
          },
          confidence: input.metadata?.confidence,
          source: input.metadata?.source,
          ...temporal,
          ...(tags !== undefined ? { tags } : {}),
          ...(namespace !== undefined ? { namespace } : {}),
          ...(relatedTo !== undefined ? { relatedTo } : {}),
        };
        break;
      case 'episode':
        record = {
          kind: 'episode',
          content: {
            episodeType: input.metadata?.episodeType ?? 'other',
            content: input.content,
          },
          ...(tags !== undefined ? { tags } : {}),
          ...(namespace !== undefined ? { namespace } : {}),
          ...(relatedTo !== undefined ? { relatedTo } : {}),
        };
        break;
      case 'observation':
        record = {
          kind: 'observation',
          content: { content: input.content },
          ...(tags !== undefined ? { tags } : {}),
          ...(namespace !== undefined ? { namespace } : {}),
          ...(relatedTo !== undefined ? { relatedTo } : {}),
        };
        break;
      case 'skill':
        record = {
          kind: 'skill',
          content: {
            name: input.metadata?.name ?? firstLine(input.content),
            description: input.content,
            category: input.metadata?.category ?? 'general',
          },
          ...(tags !== undefined ? { tags } : {}),
          ...(namespace !== undefined ? { namespace } : {}),
          ...(relatedTo !== undefined ? { relatedTo } : {}),
        };
        break;
      default:
        throw new ValidationError(`Unknown memory type: ${input.type as string}`);
    }

    const [stored] = await this.writeRecords([record]);
    if (!stored) {
      throw new ValidationError('记忆写入未返回结果', { type: input.type });
    }
    return { id: stored.id, type: input.type, createdAt: stored.createdAt };
  }

  private async writeRecord(
    record: StructuredMemoryRecord,
    options: WriteRecordsOptions,
  ): Promise<StoredStructuredMemory> {
    if (!isRecord(record.content)) {
      throw new ValidationError('content 必须是对象', { kind: record.kind });
    }
    if (record.validFrom !== undefined && record.validTo !== undefined && record.validTo < record.validFrom) {
      throw new ValidationError('validTo 早于 validFrom', {
        validFrom: record.validFrom,
        validTo: record.validTo,
      });
    }
    const content = record.content;
    const tags = record.tags !== undefined ? uniqueStrings(record.tags) : undefined;
    const common = {
      ...(tags !== undefined && tags.length > 0 ? { tags } : {}),
      ...(record.labels !== undefined && record.labels.length > 0 ? { labels: record.labels } : {}),
      ...(record.namespace !== undefined ? { namespace: record.namespace } : {}),
      ...(record.validFrom !== undefined ? { validFrom: record.validFrom } : {}),
      ...(record.validTo !== undefined ? { validTo: record.validTo } : {}),
    };

    let node: Node;
    switch (record.kind) {
      case 'fact':
      case 'preference': {
        const fact = factContentFrom(content);
        const confidence = record.confidence ?? numberValue(content.confidence);
        const source = record.source ?? stringValue(content.source);
        node = await this.memory.addFact({
          ...fact,
          ...(confidence !== undefined ? { confidence } : {}),
          ...(source !== undefined ? { source } : {}),
          ...common,
          ...(record.kind === 'preference'
            ? { tags: uniqueStrings([...(tags ?? []), PREFERENCE_TAG]) }
            : {}),
        }, { deferVectorIndex: true });
        break;
      }
      case 'episode':
      case 'observation': {
        const episodeType = record.kind === 'observation'
          ? 'observation'
          : ((stringValue(content.episodeType) ?? 'other') as EpisodeType);
        const title = stringValue(content.title);
        const contentHash = stringValue(content.contentHash);
        const startTime = numberValue(content.startTime);
        const endTime = numberValue(content.endTime);
        const context = stringValue(content.context);
        node = await this.memory.addEpisode({
          episodeType,
          content: stringValue(content.content) ?? '',
          ...(title !== undefined ? { title } : {}),
          ...(contentHash !== undefined ? { contentHash } : {}),
          ...(startTime !== undefined ? { startTime } : {}),
          ...(endTime !== undefined ? { endTime } : {}),
          ...(context !== undefined ? { context } : {}),
          ...common,
        }, { deferVectorIndex: true });
        break;
      }
      case 'skill': {
        const description = stringValue(content.description) ?? '';
        const name = stringValue(content.name) ?? firstLine(description);
        const category = stringValue(content.category) ?? 'general';
        const steps = optionalStringArray(content.steps);
        const commands = optionalStringArray(content.commands);
        const toolReferences = optionalStringArray(content.toolReferences);
        const prerequisites = optionalStringArray(content.prerequisites);
        const relatedEntities = optionalStringArray(content.relatedEntities);
        node = await this.memory.addSkill({
          name,
          description,
          category,
          ...(steps !== undefined ? { steps } : {}),
          ...(commands !== undefined ? { commands } : {}),
          ...(toolReferences !== undefined ? { toolReferences } : {}),
          ...(prerequisites !== undefined ? { prerequisites } : {}),
          ...(relatedEntities !== undefined ? { relatedEntities } : {}),
          ...common,
        }, { deferVectorIndex: true });
        break;
      }
      case 'entity': {
        const description = stringValue(content.description);
        node = await this.memory.addEntity({
          entityType: (stringValue(content.entityType) ?? '') as EntityType,
          name: stringValue(content.name) ?? '',
          ...(description !== undefined ? { description } : {}),
          ...(isRecord(content.properties) ? { properties: content.properties } : {}),
          ...common,
        }, { deferVectorIndex: true });
        break;
      }
      default:
        throw new ValidationError(`Unknown memory kind: ${record.kind as string}`);
    }

    if (record.metadata !== undefined && Object.keys(record.metadata).length > 0) {
      node = await this.memory.mergeMetadata(node.id, record.metadata, { deferVectorIndex: true });
    }
    const skippedRelatedTo = await this.linkRelatedTo(node.id, record.relatedTo);
    const vectorIndexed = await this.memory.indexNode(node.id, {
      tolerateFailure: options.tolerateVectorIndexFailure === true,
    });

    return {
      id: node.id,
      type: node.type,
      kind: record.kind,
      createdAt: node.createdAt,
      node,
      skippedRelatedTo,
      vectorIndexed,
    };
  }

  /** relatedTo：只链接已存在、未删除且非内部的节点；返回被跳过目标。 */
  private async linkRelatedTo(sourceId: string, relatedTo?: string[]): Promise<string[]> {
    const skipped: string[] = [];
    const seen = new Set<string>();
    for (const targetId of relatedTo ?? []) {
      if (seen.has(targetId)) continue;
      seen.add(targetId);
      const target = await this.mebular.graph.getNode(targetId);
      if (!target || target.deletedAt || isInternalNode(target)) {
        skipped.push(targetId);
        continue;
      }
      await this.mebular.graph.createEdge(sourceId, targetId, EdgeTypes.RELATED_TO);
    }
    return skipped;
  }

  /**
   * 更新普通 MemoryRecord（capability `/update` 统一入口）。
   * 内部对象仍必须走内部对象接口；标签按差量同步；向量索引统一刷新。
   */
  async updateRecord(
    input: UpdateMemoryRecordInput,
    options: WriteRecordsOptions = {},
  ): Promise<UpdatedMemoryRecord | null> {
    const existing = await this.mebular.graph.getNode(input.id);
    if (!existing) return null;
    if (isInternalNode(existing)) {
      throw new MebularError('内部对象必须通过内部对象接口更新', 'INTERNAL_OBJECT');
    }
    const metadata = input.metadata !== undefined
      ? { ...(existing.metadata ?? {}), ...input.metadata }
      : undefined;
    let node = await this.mebular.graph.updateNode(input.id, {
      ...(input.content !== undefined ? { content: input.content } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
    });
    if (!node) return null;
    if (input.tags !== undefined) {
      const currentTags = existing.tags ?? [];
      const nextTags = uniqueStrings(input.tags);
      for (const tag of currentTags) {
        if (!nextTags.includes(tag)) {
          node = (await this.mebular.graph.removeTag(input.id, tag)) ?? node;
        }
      }
      for (const tag of nextTags) {
        if (!currentTags.includes(tag)) {
          node = (await this.mebular.graph.addTag(input.id, tag)) ?? node;
        }
      }
    }
    const vectorIndexed = await this.memory.indexNode(input.id, {
      tolerateFailure: options.tolerateVectorIndexFailure === true,
    });
    node = (await this.mebular.graph.getNode(input.id)) ?? node;
    return { node, vectorIndexed };
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

// ---------- 写入归一化辅助 ----------

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/** fact/preference 两种外部形状 → 统一三元组（preference 允许 entity/preferenceType/value）。 */
function factContentFrom(content: Record<string, unknown>): {
  subject: string;
  predicate: string;
  object: string;
} {
  return {
    subject: stringValue(content.subject) ?? stringValue(content.entity) ?? '',
    predicate: stringValue(content.predicate) ?? stringValue(content.preferenceType) ?? '',
    object: stringValue(content.object) ?? stringValue(content.value) ?? '',
  };
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
  const record = content as Record<string, unknown>;
  if (node.type === 'fact') {
    // capability `/write` 的 observation / legacy fact 可能只有 content，
    // 不能把缺失的 subject/predicate/object 渲染成 "undefined undefined undefined"。
    const parts = [record.subject, record.predicate, record.object]
      .filter((part): part is string => typeof part === 'string' && part.length > 0);
    if (parts.length > 0) return parts.join(' ');
  }
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
