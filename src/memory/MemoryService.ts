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
import {
  DEFAULT_DETAIL_QUOTA_LIMITS,
  DETAIL_NODE_TYPE,
  DetailQuotaError,
  MAX_DETAIL_BATCH_ITEMS,
  MAX_DETAIL_LIST_LIMIT,
  MAX_DETAIL_MESSAGE_ID_CHARS,
  MAX_DETAIL_RECORD_IDS,
  MAX_DETAIL_TEXT_BYTES,
  buildDetailContent,
  detailBytes,
  detailContentHash,
  detailListView,
  detailMatchesFilters,
  detailRecordIds,
  detailRetentionClass,
  detailTextBytes,
  detailView,
  deriveDetailOwner,
  isDetailDeleteReason,
  isDetailExpired,
  isDetailKind,
  isDetailMime,
  isDetailNode,
  isDetailRetentionClass,
  isDetailRole,
  normalizeRedaction,
  resolveDetailExpiresAt,
  type DetailDeleteOptions,
  type DetailDeleteReason,
  type DetailDeleteResult,
  type DetailKind,
  type DetailListOptions,
  type DetailListResult,
  type DetailQuotaLimits,
  type DetailReadOptions,
  type DetailRetentionClass,
  type DetailView,
  type DetailWriteBatchResult,
  type DetailWriteInput,
  type DetailWriteResultEntry,
} from './detail.js';
import { ValidationError, ErrorCodes, MebularError, SyncError } from '../errors.js';
import type { Edge, Node, TraverseOptions, TraverseResult } from '../types/index.js';
import { domainOfNamespace, matchesNamespace } from '../core/namespace.js';
import type { NamespaceFilter } from '../core/namespace.js';
import { computeStateHash, computeStateHashByNamespace } from '../core/stateHash.js';
import { createBuiltinAdapterRegistry } from '../exchange/index.js';
import type { AdapterImportReport, AdapterSource } from '../exchange/adapter.js';
import type { SyncResult } from '../sync/syncmgr/SyncManager.js';
import { expandMemoryTypes, matchesMemoryTypes } from './semantics.js';
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

/**
 * 授权域读选项：适配器（capability）只负责确定“可读哪些域”，
 * 具体 namespace/域过滤、分页与内部/归档过滤由 MemoryService 执行。
 */
export interface ReadScopeOptions {
  /** 单域或域列表；缺省不过滤（公共工具全局读）。 */
  domains?: string[];
}

/** 按域统计（capability /status、/namespaces 与公共 memory_status 共用）。 */
export interface MemoryDomainStats {
  domain: string;
  count: number;
  memoryRecords: number;
  internalObjects: number;
  internalKinds: Record<string, number>;
  /** 域内未删除详情正文的 UTF-8 字节数。 */
  detailBytes: number;
  lastUpdatedAt: number;
}

/**
 * 管理读面（Console /admin/api/memories、排障与审计）的统一记录列表选项。
 *
 * 默认可见性与公共查询一致：内部对象、归档、墓碑都隐藏；只有显式 flag 才返回。
 * `namespace` 支持单域或域列表，归一化/匹配复用 core 规则。
 */
export interface MemoryRecordListOptions {
  includeDeleted?: boolean;
  includeArchived?: boolean;
  includeInternal?: boolean;
  namespace?: NamespaceFilter;
  /** 截断过滤后的列表；`total` 仍是过滤后的完整计数。 */
  limit?: number;
}

/** 管理读面统一记录列表：`total` 不随 `limit` 截断。 */
export interface MemoryRecordList {
  total: number;
  nodes: Node[];
}

/** 管理面域统计选项。 */
export interface NamespaceStatsOptions {
  /**
   * 是否包含 `__*` 保留域（默认 false，与 stats() / capability 一致）。
   * Console 域列表沿用「显示本机所有 namespace」的旧行为时显式开启。
   */
  includeReserved?: boolean;
}

export interface DetailWriteOptions {
  /** 服务端身份（owner 推导；capability 传入）。 */
  userId?: string;
  /** 测试/维护可注入的时钟。 */
  now?: number;
  /** 配额（默认 256 MiB/域、1 GiB/云、64 MiB/thread；测试可收紧）。 */
  detailLimits?: Partial<DetailQuotaLimits>;
}

export interface PruneDetailsOptions {
  now?: number;
}

export interface MemoryStats {
  nodeCount: number;
  edgeCount: number;
  counts: {
    nodes: number;
    memoryRecords: number;
    compacts: number;
    checkpoints: number;
    selfRecords: number;
    details: number;
    detailBytes: number;
  };
  /** 默认详情配额（capability /status 只读展示）。 */
  detailQuota: DetailQuotaLimits;
  domains: MemoryDomainStats[];
}

/** 统一同步状态（公共 memory_status、capability /status 与 /sync GET 共用）。 */
export interface MemorySyncStatus {
  running: boolean;
  pendingEventCount: number;
  lastSyncAt: number | null;
  isSyncing: boolean;
  peerId: string | null;
}

/** G-ML-1 删除结果（墓碑；随 `node_deleted` 事件同步传播）。 */
export interface DeleteResult {
  deleted: string[];
  notFound: string[];
  /** 内部对象默认拒绝普通删除（需管理端点） */
  internal?: string[];
  /** 记录删除级联墓碑的 DetailRecord id（随 node_deleted 同步）。 */
  detailsDeleted?: string[];
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
const MEMORY_NODE_TYPES = new Set<Node['type']>(['entity', 'fact', 'episode', 'skill', 'meta']);
const THREAD_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const DETAIL_PROTECTED_METADATA_KEYS = new Set([
  'internal',
  'internalObject',
  'provenance',
  'owner',
  'ownerType',
  'ownerId',
  'domain',
  'namespace',
  'kind',
  'type',
  'contentHash',
  'contentHashValidFrom',
  'clientItemId',
  'updatedBy',
  'deletedAt',
  'deletedBy',
  'deletedReason',
  'detailAvailable',
  'expiresAt',
  'detailKind',
  'recordIds',
]);

interface DetailWritePlan {
  index: number;
  domain: string;
  detailKind: DetailKind;
  text: string;
  contentHash: string;
  chunkIndex: number;
  threadId: string | null;
  recordIds: string[];
  retentionClass: DetailRetentionClass;
  expiresAt: number;
  ownerType: string;
  ownerId: string;
  content: Record<string, unknown>;
  provenance: Record<string, unknown>;
  safeMetadata: Record<string, unknown>;
  clientItemId?: string;
}

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

  async query(query: MemoryQuery & LifecycleOptions & ReadScopeOptions): Promise<RetrievalResult> {
    const startedAt = Date.now();
    const candidateTypes = expandMemoryTypes(query.types);
    const includeArchived = query.includeArchived === true;
    const namespace = query.domains ?? query.filters?.namespace;

    let nodes: Array<{ node: Node; relevance?: number }>;

    if (query.query && this.memory.hasVectorIndex()) {
      const requested = query.limit ?? 10;
      const requestedOffset = query.offset ?? 0;
      // 语义过滤可能剔除部分向量命中；适度多取，最终分页仍统一在本方法执行。
      const fetchLimit = Math.min(200, Math.max(requested + requestedOffset, requested * 4));
      const hits = await this.memory.vectorQuery(query.query, fetchLimit, { includeArchived });
      const vectorNodes = hits
        .filter(({ node }) => candidateTypes.includes(node.type) && matchesNamespace(node.namespace, namespace))
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

    const filtered = nodes.filter(({ node }) =>
      this.passFilters(node, query)
      && !isInternalNode(node)
      && matchesMemoryTypes(node, query.types));

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

  async search(query: SearchQuery & LifecycleOptions & ReadScopeOptions): Promise<SearchResult> {
    const startedAt = Date.now();
    const includeArchived = query.includeArchived === true;
    const namespace = query.domains ?? query.filters?.namespace;
    const hits = await this.memory.search(query.query, {
      types: expandMemoryTypes(query.types),
      tags: query.filters?.tags,
      createdAfter: query.filters?.createdAfter,
      createdBefore: query.filters?.createdBefore,
      namespace,
      includeArchived,
    });
    const filtered = hits.filter((node) => matchesMemoryTypes(node, query.types));
    const limited = query.limit !== undefined ? filtered.slice(0, query.limit) : filtered;

    const relations: Relation[] = [];
    if (query.includeRelations) {
      const seenEdges = new Set<string>();
      for (const hit of limited) {
        const traversal = await this.mebular.graph.traverse(hit.id, {
          maxDepth: 1,
          ...(namespace !== undefined ? { namespace } : {}),
        });
        for (const edge of traversal.visitedEdges) {
          if (seenEdges.has(edge.id)) continue;
          const [sourceNode, targetNode] = await Promise.all([
            this.mebular.graph.getNode(edge.source),
            this.mebular.graph.getNode(edge.target),
          ]);
          // 防御性过滤：内部/归档对象不得经关系端点泄漏给普通 search。
          const visible = (node: Node | null): boolean =>
            Boolean(node) && !isInternalNode(node) && (includeArchived || !isArchived(node));
          if (!visible(sourceNode) || !visible(targetNode)) {
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

  /**
   * 管理读面统一记录列表（Console /admin/api/memories 与管理排障共用）。
   *
   * 过滤只使用 core 的生命周期/可见性规则：`deletedAt`、`isArchived`、`isInternalNode`；
   * 不复制任何 Runtime 类型名或管理面自定义规则。默认与公共查询一致，
   * 显式 `includeDeleted` / `includeArchived` / `includeInternal` 才放开对应集合。
   * 排序与旧 Console 读面一致（createdAt 倒序），`limit` 在过滤/排序后截断。
   */
  async listRecords(options: MemoryRecordListOptions = {}): Promise<MemoryRecordList> {
    const nodes = await this.allStorageNodes();
    const filtered = nodes.filter((node) => {
      if (!options.includeDeleted && node.deletedAt) return false;
      if (!options.includeArchived && isArchived(node)) return false;
      if (!options.includeInternal && isInternalNode(node)) return false;
      if (options.namespace !== undefined && !matchesNamespace(node.namespace, options.namespace)) {
        return false;
      }
      return true;
    });
    filtered.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    const limit = typeof options.limit === 'number' && Number.isFinite(options.limit)
      ? Math.max(0, Math.trunc(options.limit))
      : undefined;
    return {
      total: filtered.length,
      nodes: limit !== undefined ? filtered.slice(0, limit) : filtered,
    };
  }

  // ---------- 画像 / 技能 / 历史 ----------

  async profile(options: LifecycleOptions & ReadScopeOptions = {}): Promise<UserProfile> {
    const includeArchived = options.includeArchived === true;
    const namespace = options.domains;
    const entities = await this.memory.listByType('entity', {
      includeArchived,
      ...(namespace !== undefined ? { namespace } : {}),
    });
    const userEntity = entities.find(
      (node) => (node.content as { entityType?: string }).entityType === 'user'
        && (node.content as { name?: string }).name === this.userId,
    );

    const preferenceFacts = (await this.memory.listActiveFacts({
      includeArchived,
      ...(namespace !== undefined ? { namespace } : {}),
    })).filter((fact) => (fact.tags ?? []).includes(PREFERENCE_TAG));

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

  async skills(filter?: SkillFilter & LifecycleOptions & ReadScopeOptions & { limit?: number }): Promise<Skill[]> {
    return (await this.skillPage(filter)).skills;
  }

  /**
   * 技能列表 + 过滤后总数（capability /skills 需要 total；公共工具只取 skills）。
   * 域、归档、内部对象、分类/关键词与分页都在这里统一执行。
   */
  async skillPage(
    filter?: SkillFilter & LifecycleOptions & ReadScopeOptions & { limit?: number },
  ): Promise<{ skills: Skill[]; total: number }> {
    const namespace = filter?.domains;
    let nodes = await this.memory.listByType('skill', {
      tags: filter?.tags,
      includeArchived: filter?.includeArchived === true,
      ...(namespace !== undefined ? { namespace } : {}),
    });
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
    const total = nodes.length;
    const limited = filter?.limit !== undefined ? nodes.slice(0, filter.limit) : nodes;
    return { skills: limited.map((node) => toSpecSkill(node as SkillNode)), total };
  }

  async history(filters: ConversationFilters & LifecycleOptions & ReadScopeOptions): Promise<ConversationHistory> {
    let episodes = (await this.memory.listByType('episode', { includeArchived: filters.includeArchived === true })) as EpisodeNode[];
    episodes = episodes.filter((episode) => episode.content.episodeType === 'conversation');
    if (filters.domains !== undefined) {
      episodes = episodes.filter((episode) => matchesNamespace(episode.namespace, filters.domains));
    }

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
    // O6 / API-34：记录删除级联墓碑其链接详情；仅当没有其他 live 记录引用该详情。
    // Compact 只由 source 状态变 stale，不在此级联删除。
    const detailsDeleted = deleted.length > 0 ? await this.cascadeDetailTombstones(deleted) : [];
    const result: DeleteResult = internal.length > 0
      ? { deleted, notFound, internal }
      : { deleted, notFound };
    if (detailsDeleted.length > 0) result.detailsDeleted = detailsDeleted;
    return result;
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

  // ---------- 域内详情（DetailRecord / RawChunk，0.3.0 §2） ----------

  /**
   * 批量写入详情（capability `/detail op=write` 的唯一落库入口）。
   *
   * - 校验原子：所有 item 的域、recordIds、retention、大小先全部通过；
   * - 落库逐项：配额失败只影响该项（结果 code=detail_quota_exceeded），不静默丢弃；
   * - 复用现有图 + 事件日志，不建第二套存储/同步。
   */
  async writeDetails(
    inputs: DetailWriteInput[],
    options: DetailWriteOptions = {},
  ): Promise<DetailWriteBatchResult> {
    if (!Array.isArray(inputs) || inputs.length === 0) {
      throw new ValidationError('items 必须是非空数组', { field: 'items' });
    }
    if (inputs.length > MAX_DETAIL_BATCH_ITEMS) {
      throw new ValidationError(`items 最多 ${MAX_DETAIL_BATCH_ITEMS} 条`, {
        field: 'items',
        maxBatchItems: MAX_DETAIL_BATCH_ITEMS,
      });
    }
    const now = options.now ?? Date.now();
    const userId = options.userId ?? 'user';
    const limits: DetailQuotaLimits = {
      ...DEFAULT_DETAIL_QUOTA_LIMITS,
      ...(options.detailLimits ?? {}),
    };

    const plans: DetailWritePlan[] = [];
    for (let index = 0; index < inputs.length; index += 1) {
      plans.push(await this.validateDetailWrite(inputs[index]!, index, now, userId));
    }

    const live = (await this.detailNodes()).filter((node) => !node.deletedAt);
    const dedupe = new Map<string, Node>();
    for (const node of live) {
      const content = isRecord(node.content) ? node.content : {};
      const domain = domainOfNamespace(node.namespace);
      const key = detailDedupeKey({
        domain,
        detailKind: content.detailKind as DetailKind,
        contentHash: typeof content.contentHash === 'string' ? content.contentHash : '',
        chunkIndex: typeof content.chunkIndex === 'number' ? content.chunkIndex : 0,
      });
      dedupe.set(key, node);
      const clientItemId = node.metadata?.clientItemId;
      if (typeof clientItemId === 'string') {
        dedupe.set(detailClientDedupeKey(domain, clientItemId), node);
      }
    }

    const results: DetailWriteResultEntry[] = [];
    const evicted: string[] = [];
    let created = 0;
    let duplicates = 0;
    let failed = 0;

    for (const plan of plans) {
      const contentKey = detailDedupeKey(plan);
      const clientKey = plan.clientItemId !== undefined
        ? detailClientDedupeKey(plan.domain, plan.clientItemId)
        : null;
      const existing = (clientKey !== null ? dedupe.get(clientKey) : undefined) ?? dedupe.get(contentKey);
      if (existing) {
        duplicates += 1;
        results.push(detailResultEntry('duplicate', plan, existing.id));
        continue;
      }
      let createdNode: Node | null = null;
      try {
        const evictedForItem = await this.ensureDetailQuota(plan, live, limits);
        evicted.push(...evictedForItem);
        createdNode = await this.mebular.graph.createNode(DETAIL_NODE_TYPE, plan.content, undefined, {
          namespace: plan.domain,
        });
        const node = await this.mebular.graph.updateNode(createdNode.id, {
          metadata: this.detailMetadata(plan),
        });
        if (!node) {
          throw new ValidationError('详情写入后读取失败', { index: plan.index, id: createdNode.id });
        }
        await this.refreshRecordDetailAvailability(plan.recordIds);
        live.push(node);
        dedupe.set(contentKey, node);
        if (clientKey !== null) dedupe.set(clientKey, node);
        created += 1;
        results.push(detailResultEntry('created', plan, node.id));
      } catch (error) {
        if (createdNode) {
          // 元数据合并失败时不要把半成品暴露给列表/召回；写墓碑后按失败项返回。
          await this.mebular.graph.deleteNode(createdNode.id).catch(() => undefined);
        }
        if (error instanceof DetailQuotaError) {
          if (Array.isArray(error.details?.evicted)) {
            for (const id of error.details.evicted) {
              if (typeof id === 'string' && !evicted.includes(id)) evicted.push(id);
            }
          }
          failed += 1;
          results.push({
            ...(plan.clientItemId !== undefined ? { clientItemId: plan.clientItemId } : {}),
            status: 'failed',
            domain: plan.domain,
            detailKind: plan.detailKind,
            contentHash: plan.contentHash,
            ownerType: plan.ownerType,
            ownerId: plan.ownerId,
            code: 'detail_quota_exceeded',
            retryable: false,
            message: error.message,
            details: error.details,
          });
          continue;
        }
        failed += 1;
        results.push({
          ...(plan.clientItemId !== undefined ? { clientItemId: plan.clientItemId } : {}),
          status: 'failed',
          domain: plan.domain,
          detailKind: plan.detailKind,
          contentHash: plan.contentHash,
          ownerType: plan.ownerType,
          ownerId: plan.ownerId,
          code: 'internal',
          retryable: true,
        });
      }
    }

    return {
      results,
      created,
      duplicates,
      failed,
      partial: failed > 0,
      evicted,
    };
  }

  /** capability `/detail op=get`：返回详情视图（是否过期/删除由 availability 表达）。 */
  async getDetail(id: string, options: DetailReadOptions = {}): Promise<DetailView | null> {
    const node = await this.mebular.graph.getNode(id);
    if (!isDetailNode(node)) return null;
    return detailView(node, { userId: options.userId ?? 'user', ...options });
  }

  /** capability `/detail op=list`：默认只返回未过期、未删除详情；list 不带正文。 */
  async listDetails(options: DetailListOptions = {}): Promise<DetailListResult> {
    const now = options.now ?? Date.now();
    const userId = options.userId ?? 'user';
    const nodes = (await this.detailNodes())
      .filter((node) => detailMatchesFilters(node, options, now))
      .sort((a, b) => {
        const delta = (b.createdAt ?? 0) - (a.createdAt ?? 0);
        if (delta !== 0) return delta;
        return String(b.id).localeCompare(String(a.id));
      });
    const total = nodes.length;
    const offset = typeof options.offset === 'number' && Number.isFinite(options.offset)
      ? Math.max(0, Math.trunc(options.offset))
      : 0;
    const limit = typeof options.limit === 'number' && Number.isFinite(options.limit)
      ? Math.min(Math.max(1, Math.trunc(options.limit)), MAX_DETAIL_LIST_LIMIT)
      : 20;
    const page = nodes.slice(offset, offset + limit);
    return {
      details: page.map((node) => detailListView(node, {
        userId,
        includeDeleted: options.includeDeleted === true,
        includeExpired: options.includeExpired === true,
        now,
      })),
      total,
      offset,
      limit,
      hasMore: offset + page.length < total,
    };
  }

  /**
   * capability `/detail op=delete`：写墓碑，不删除 MemoryRecord。
   * agent 只能删除自己域内、自己写入的详情；user/system 可治理全部。
   */
  async deleteDetails(ids: string[], options: DetailDeleteOptions = {}): Promise<DetailDeleteResult> {
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new ValidationError('ids 必须是非空数组', { field: 'ids' });
    }
    const reason = options.reason ?? 'user_requested';
    if (!isDetailDeleteReason(reason)) {
      throw new ValidationError('reason 非法', { field: 'reason', reason });
    }
    const actorType = options.actorType ?? 'system';
    const deleted: string[] = [];
    const notFound: string[] = [];
    const forbidden: string[] = [];
    for (const id of [...new Set(ids)]) {
      const node = await this.mebular.graph.getNode(id);
      if (!isDetailNode(node) || node.deletedAt) {
        notFound.push(id);
        continue;
      }
      if (!this.canGovernDetail(actorType, options.agentId, node)) {
        forbidden.push(id);
        continue;
      }
      const ok = await this.tombstoneDetailNode(node, reason);
      (ok ? deleted : notFound).push(id);
    }
    return {
      deleted,
      notFound,
      forbidden,
      partial: notFound.length > 0 || forbidden.length > 0,
    };
  }

  /** 维护：按 retention 过期写墓碑（不做模型摘要，不做第二套存储）。 */
  async pruneExpiredDetails(options: PruneDetailsOptions = {}): Promise<string[]> {
    const now = options.now ?? Date.now();
    const pruned: string[] = [];
    for (const node of await this.detailNodes()) {
      if (node.deletedAt || !isDetailExpired(node, now)) continue;
      if (await this.tombstoneDetailNode(node, 'retention_expired')) {
        pruned.push(node.id);
      }
    }
    return pruned;
  }

  // ---------- 图 / 导入 / 状态 / 同步 ----------


  async graph(
    startId: string,
    options?: TraverseOptions & LifecycleOptions & ReadScopeOptions,
  ): Promise<TraverseResult> {
    const includeArchived = options?.includeArchived === true;
    const namespace = options?.namespace ?? options?.domains;
    const start = await this.mebular.graph.getNode(startId);
    // 内部对象不是公共记忆图的一部分；从内部 id 起遍历直接拒绝（不返回部分图）。
    if (start && isInternalNode(start)) {
      throw new MebularError('内部对象不可通过记忆图访问', 'INTERNAL_OBJECT');
    }
    const result = await this.mebular.graph.traverse(startId, {
      ...options,
      ...(namespace !== undefined ? { namespace } : {}),
    });
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

  /**
   * 按域统计（管理读面，与 `stats()` 共用同一聚合规则）。
   *
   * 默认与 `stats()`/capability 一致，排除 `__*` 保留域；Console 域列表需要
   * 保留旧行为（本机所有 namespace 都显示）时显式传 `includeReserved: true`，
   * 避免静默丢掉保留域行。
   */
  async namespaceStats(options: NamespaceStatsOptions = {}): Promise<MemoryDomainStats[]> {
    const nodes = await this.allStorageNodes();
    return domainStatsFromNodes(nodes, { includeReserved: options.includeReserved === true });
  }

  /**
   * 统一状态/域统计（公共 `memory_status`、capability `/status` `/namespaces` 共用）。
   * 只读取一次图快照；不按域/类型复制第二套统计规则。
   */
  async stats(): Promise<MemoryStats> {
    const { nodes, edges } = await this.snapshot();
    const list = domainStatsFromNodes(nodes, { includeReserved: false });
    const counts = {
      nodes: 0,
      memoryRecords: 0,
      compacts: 0,
      checkpoints: 0,
      selfRecords: 0,
      details: 0,
      detailBytes: 0,
    };
    for (const entry of list) {
      counts.nodes += entry.count;
      counts.memoryRecords += entry.memoryRecords;
      counts.compacts += entry.internalKinds.compact ?? 0;
      counts.checkpoints += entry.internalKinds.context_checkpoint ?? 0;
      counts.selfRecords += entry.internalKinds.self_record ?? 0;
      counts.details += entry.internalKinds.detail_record ?? 0;
      counts.detailBytes += entry.detailBytes;
    }
    return {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      counts,
      detailQuota: { ...DEFAULT_DETAIL_QUOTA_LIMITS },
      domains: list,
    };
  }

  /** 统一同步状态（状态、capability /status 与 /sync GET 共用）。 */
  async syncStatus(): Promise<MemorySyncStatus> {
    const node = this.mebular.node;
    let pendingEventCount = 0;
    let lastSyncAt: number | null = null;
    let isSyncing = false;
    try {
      const syncStatus = await this.mebular.sync.getSyncStatus();
      pendingEventCount = syncStatus.pendingCount;
      lastSyncAt = typeof syncStatus.lastSyncAt === 'number' ? syncStatus.lastSyncAt : null;
      isSyncing = syncStatus.isSyncing === true;
    } catch {
      // 门面未初始化时 sync 不可访问
    }
    return {
      running: node?.isRunning() ?? false,
      pendingEventCount,
      lastSyncAt,
      isSyncing,
      peerId: node?.peerId.id ?? null,
    };
  }

  async status(): Promise<MemoryStatus> {
    const { nodes, edges } = await this.snapshot();
    const node = this.mebular.node;
    const lanStatus = node?.getLanStatus?.();
    const syncStatus = await this.syncStatus();
    return {
      deviceId: this.mebular.deviceId,
      peerId: node?.peerId.id ?? null,
      running: syncStatus.running,
      listenAddrs: node?.getLocalMultiaddrs() ?? [],
      relays: this.mebular.relayServers,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      stateHash: computeStateHash(nodes, edges),
      stateHashByNamespace: computeStateHashByNamespace(nodes, edges),
      atRest: this.mebular.atRestEncryption,
      semantic: this.mebular.semanticVectorIndex !== null,
      pendingEventCount: syncStatus.pendingEventCount,
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

  private async validateDetailWrite(
    input: DetailWriteInput,
    index: number,
    now: number,
    userId: string,
  ): Promise<DetailWritePlan> {
    if (!isRecord(input)) throw detailValidationError(index, 'item', 'item 必须是对象');
    const raw = input as unknown as Record<string, unknown>;
    if (typeof raw.domain !== 'string' || raw.domain.trim() === '') {
      throw detailValidationError(index, 'domain', 'domain 必填');
    }
    const domain = raw.domain.trim();
    if (domain.length > 128 || domain.startsWith('__')) {
      throw detailValidationError(index, 'domain', 'domain 非法', { domain });
    }
    if (!isDetailKind(raw.detailKind)) {
      throw detailValidationError(index, 'detailKind', 'detailKind 非法');
    }
    if (typeof raw.text !== 'string' || raw.text.trim() === '') {
      throw detailValidationError(index, 'text', 'text 必须是非空字符串');
    }
    if (detailTextBytes(raw.text) > MAX_DETAIL_TEXT_BYTES) {
      throw new ValidationError(`text 超过 ${MAX_DETAIL_TEXT_BYTES} 字节`, {
        index,
        field: 'text',
        maxBytes: MAX_DETAIL_TEXT_BYTES,
      });
    }
    const contentHash = detailContentHash(raw.text);
    if (raw.contentHash !== undefined && raw.contentHash !== contentHash) {
      throw detailValidationError(index, 'contentHash', 'contentHash 必须等于 sha256(text)', {
        expected: contentHash,
      });
    }
    if (raw.mime !== undefined && !isDetailMime(raw.mime)) {
      throw detailValidationError(index, 'mime', 'mime 非法');
    }
    if (raw.role !== undefined && !isDetailRole(raw.role)) {
      throw detailValidationError(index, 'role', 'role 非法');
    }
    if (raw.detailKind === 'raw_chunk' && raw.role === undefined) {
      throw detailValidationError(index, 'role', 'raw_chunk 需要 role');
    }
    if (raw.messageId !== undefined
      && (typeof raw.messageId !== 'string' || raw.messageId.length > MAX_DETAIL_MESSAGE_ID_CHARS)) {
      throw detailValidationError(index, 'messageId', `messageId 需为 1–${MAX_DETAIL_MESSAGE_ID_CHARS} 字符`);
    }
    const chunkIndex = raw.chunkIndex === undefined ? 0 : raw.chunkIndex;
    if (typeof chunkIndex !== 'number' || !Number.isInteger(chunkIndex) || chunkIndex < 0) {
      throw detailValidationError(index, 'chunkIndex', 'chunkIndex 必须是非负整数');
    }
    if (raw.turn !== undefined
      && (typeof raw.turn !== 'number' || !Number.isInteger(raw.turn) || raw.turn < 0)) {
      throw detailValidationError(index, 'turn', 'turn 必须是非负整数');
    }

    const provenanceInput = isRecord(raw.provenance) ? { ...raw.provenance } : {};
    if (raw.provenance !== undefined && raw.provenance !== null && !isRecord(raw.provenance)) {
      throw detailValidationError(index, 'provenance', 'provenance 必须是对象');
    }
    let threadId: string | undefined;
    if (raw.threadId !== undefined && raw.threadId !== null && typeof raw.threadId !== 'string') {
      throw detailValidationError(index, 'threadId', 'threadId 必须是字符串');
    }
    if (typeof raw.threadId === 'string') threadId = raw.threadId;
    else if (typeof provenanceInput.threadId === 'string') threadId = provenanceInput.threadId;
    if (domain.startsWith('task:')) {
      const expected = domain.slice('task:'.length);
      if (threadId !== undefined && threadId !== expected) {
        throw detailValidationError(index, 'threadId', 'task 域详情 threadId 必须与域一致', {
          domain,
          expected,
        });
      }
      threadId = expected;
    }
    if (threadId !== undefined && !THREAD_ID_PATTERN.test(threadId)) {
      throw detailValidationError(index, 'threadId', 'threadId 格式非法');
    }
    if (typeof provenanceInput.threadId === 'string'
      && threadId !== undefined
      && provenanceInput.threadId !== threadId) {
      throw detailValidationError(index, 'provenance.threadId', 'provenance.threadId 与详情 threadId 不一致');
    }
    const provenance: Record<string, unknown> = {
      source: 'runtime',
      writerType: 'system',
      writerId: 'system',
      extractor: 'heuristic',
      model: null,
      version: '0.3.0',
      deviceId: null,
      hostId: null,
      threadId: threadId ?? null,
      agentId: null,
      agentName: null,
      messageIds: [],
      rawChunkIds: [],
      confirmation: 'none',
      at: now,
      ...provenanceInput,
    };
    provenance.threadId = threadId ?? provenance.threadId ?? null;

    if (!Array.isArray(raw.recordIds) || raw.recordIds.length === 0) {
      throw detailValidationError(index, 'recordIds', 'recordIds 必须是非空数组');
    }
    if (raw.recordIds.length > MAX_DETAIL_RECORD_IDS) {
      throw detailValidationError(index, 'recordIds', `recordIds 最多 ${MAX_DETAIL_RECORD_IDS} 项`);
    }
    const recordIds: string[] = [];
    for (const entry of raw.recordIds) {
      if (typeof entry !== 'string' || entry.length === 0 || entry.length > 128) {
        throw detailValidationError(index, 'recordIds', 'recordIds 含非法节点 id');
      }
      if (recordIds.includes(entry)) continue;
      const target = await this.mebular.graph.getNode(entry);
      if (!target || target.deletedAt) {
        throw detailValidationError(index, 'recordIds', 'recordIds 指向的记录不存在或已删除', { id: entry });
      }
      if (isInternalNode(target)) {
        const internalKind = target.metadata?.internalObject && typeof target.metadata.internalObject === 'object'
          ? (target.metadata.internalObject as { kind?: unknown }).kind
          : null;
        if (internalKind !== 'context_checkpoint' && internalKind !== 'detail_record') {
          throw detailValidationError(index, 'recordIds', 'recordIds 不能指向该内部对象', { id: entry });
        }
      }
      const targetDomain = domainOfNamespace(target.namespace);
      if (targetDomain !== domain) {
        throw detailValidationError(index, 'recordIds', 'recordIds 必须与详情同域', {
          id: entry,
          domain,
          recordDomain: targetDomain,
        });
      }
      recordIds.push(entry);
    }
    if (recordIds.length === 0) {
      throw detailValidationError(index, 'recordIds', '没有可链接的记录；详情不应写入');
    }

    const retentionClass: DetailRetentionClass = raw.retentionClass === undefined
      ? 'conversation'
      : raw.retentionClass as DetailRetentionClass;
    if (!isDetailRetentionClass(retentionClass)) {
      throw detailValidationError(index, 'retentionClass', 'retentionClass 非法');
    }
    let expiresAt: number;
    try {
      if (raw.expiresAt !== undefined && raw.expiresAt !== null
        && (typeof raw.expiresAt !== 'number' || !Number.isFinite(raw.expiresAt) || raw.expiresAt < 0)) {
        throw new RangeError('expiresAt 必须是非负有限数字');
      }
      expiresAt = resolveDetailExpiresAt(
        retentionClass,
        typeof raw.expiresAt === 'number' ? raw.expiresAt : undefined,
        now,
      );
    } catch (error) {
      throw detailValidationError(index, 'expiresAt', (error as Error).message);
    }

    const owner = deriveDetailOwner(domain, { userId });
    if (raw.ownerType !== undefined && raw.ownerType !== owner.ownerType) {
      throw detailValidationError(index, 'ownerType', 'ownerType 与服务端推导不一致', {
        expected: owner.ownerType,
      });
    }
    if (raw.ownerId !== undefined && raw.ownerId !== owner.ownerId) {
      throw detailValidationError(index, 'ownerId', 'ownerId 与服务端推导不一致', {
        expected: owner.ownerId,
      });
    }

    let clientItemId: string | undefined;
    if (raw.clientItemId !== undefined) {
      if (typeof raw.clientItemId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(raw.clientItemId)) {
        throw detailValidationError(index, 'clientItemId', 'clientItemId 格式非法');
      }
      clientItemId = raw.clientItemId;
    }

    const safeMetadata: Record<string, unknown> = isRecord(raw.metadata) ? { ...raw.metadata } : {};
    if (raw.metadata !== undefined && raw.metadata !== null && !isRecord(raw.metadata)) {
      throw detailValidationError(index, 'metadata', 'metadata 必须是对象');
    }
    if (raw.redaction !== undefined && raw.redaction !== null && !isRecord(raw.redaction)) {
      throw detailValidationError(index, 'redaction', 'redaction 必须是对象');
    }
    for (const key of Object.keys(safeMetadata)) {
      if (DETAIL_PROTECTED_METADATA_KEYS.has(key)) {
        throw detailValidationError(index, `metadata.${key}`, 'metadata 含受保护字段', { field: key });
      }
    }

    const content = buildDetailContent({
      ...input,
      detailKind: raw.detailKind,
      text: raw.text,
      mime: raw.mime as DetailWriteInput['mime'],
      role: raw.role as DetailWriteInput['role'],
      messageId: raw.messageId as string | undefined,
      chunkIndex,
      turn: raw.turn as number | undefined,
      threadId: threadId ?? undefined,
      recordIds,
      redaction: normalizeRedaction(input.redaction),
      retentionClass,
    }, {
      contentHash,
      expiresAt,
      threadId: threadId ?? null,
    });

    return {
      index,
      domain,
      detailKind: raw.detailKind,
      text: raw.text,
      contentHash,
      chunkIndex,
      threadId: threadId ?? null,
      recordIds,
      retentionClass,
      expiresAt,
      ownerType: owner.ownerType,
      ownerId: owner.ownerId,
      content,
      provenance,
      safeMetadata,
      ...(clientItemId !== undefined ? { clientItemId } : {}),
    };
  }

  private detailMetadata(plan: DetailWritePlan): Record<string, unknown> {
    return {
      internal: true,
      internalObject: {
        schema: 1,
        kind: 'detail_record',
        detailKind: plan.detailKind,
        ...(plan.threadId !== null ? { threadId: plan.threadId } : {}),
        recordIds: [...plan.recordIds],
        contentHash: plan.contentHash,
        expiresAt: plan.expiresAt,
      },
      provenance: plan.provenance,
      ...(plan.clientItemId !== undefined ? { clientItemId: plan.clientItemId } : {}),
      ...plan.safeMetadata,
    };
  }

  private async detailNodes(): Promise<Node[]> {
    let nodes: Node[];
    try {
      nodes = await this.mebular.graph.listNodes({ type: DETAIL_NODE_TYPE });
    } catch {
      nodes = [];
    }
    if (nodes.length === 0) {
      nodes = await this.allStorageNodes();
    }
    const seen = new Set<string>();
    const out: Node[] = [];
    for (const node of nodes) {
      if (!isDetailNode(node) || seen.has(node.id)) continue;
      seen.add(node.id);
      out.push(node);
    }
    return out;
  }

  private async ensureDetailQuota(
    plan: DetailWritePlan,
    live: Node[],
    limits: DetailQuotaLimits,
  ): Promise<string[]> {
    const incoming = detailTextBytes(plan.text);
    const evicted: string[] = [];
    const usageWhere = (predicate: (node: Node) => boolean): number =>
      live.reduce((sum, node) => sum + (predicate(node) ? detailBytes(node) : 0), 0);
    const domainUsage = (domain: string): number =>
      usageWhere((node) => domainOfNamespace(node.namespace) === domain);
    const threadUsage = (threadId: string): number =>
      usageWhere((node) => {
        const content = isRecord(node.content) ? node.content : {};
        return content.threadId === threadId;
      });
    const evictionPriority = (node: Node): number => {
      const retention = detailRetentionClass(node);
      if (retention === 'tool_output') return 0;
      if (retention === 'conversation') return 1;
      return 2;
    };

    const evictOldest = async (
      scope: 'domain' | 'cloud' | 'thread',
      limit: number,
      used: () => number,
      matcher: (node: Node) => boolean,
      extra: Record<string, unknown>,
    ): Promise<void> => {
      while (used() + incoming > limit) {
        const domainBytes = new Map<string, number>();
        if (scope === 'cloud') {
          for (const node of live) {
            const domain = domainOfNamespace(node.namespace);
            domainBytes.set(domain, (domainBytes.get(domain) ?? 0) + detailBytes(node));
          }
        }
        const candidates = live
          .filter((node) => !node.deletedAt && matcher(node) && evictionPriority(node) < 2)
          .sort((a, b) => {
            if (scope === 'cloud') {
              // 单云总量：按域公平淘汰（当前占用最大的域先让出空间）。
              const aDomain = domainOfNamespace(a.namespace);
              const bDomain = domainOfNamespace(b.namespace);
              const bytesDelta = (domainBytes.get(bDomain) ?? 0) - (domainBytes.get(aDomain) ?? 0);
              if (bytesDelta !== 0) return bytesDelta;
            }
            const priorityDelta = evictionPriority(a) - evictionPriority(b);
            if (priorityDelta !== 0) return priorityDelta;
            return (a.createdAt ?? 0) - (b.createdAt ?? 0) || String(a.id).localeCompare(String(b.id));
          });
        const candidate = candidates[0];
        if (!candidate) {
          throw new DetailQuotaError('详情配额超限且无法淘汰', {
            ...extra,
            limitBytes: limit,
            usedBytes: used(),
            requiredBytes: used() + incoming,
            evicted: [...evicted],
          });
        }
        const ok = await this.tombstoneDetailNode(candidate, 'quota_evicted');
        const position = live.indexOf(candidate);
        if (position >= 0) live.splice(position, 1);
        if (ok) evicted.push(candidate.id);
      }
    };

    await evictOldest(
      'domain',
      limits.domainBytes,
      () => domainUsage(plan.domain),
      (node) => domainOfNamespace(node.namespace) === plan.domain,
      { scope: 'domain', domain: plan.domain },
    );
    await evictOldest(
      'cloud',
      limits.cloudBytes,
      () => usageWhere(() => true),
      () => true,
      { scope: 'cloud' },
    );
    if (plan.threadId !== null) {
      await evictOldest(
        'thread',
        limits.threadBytes,
        () => threadUsage(plan.threadId!),
        (node) => {
          const content = isRecord(node.content) ? node.content : {};
          return content.threadId === plan.threadId;
        },
        { scope: 'thread', threadId: plan.threadId },
      );
    }
    return evicted;
  }

  private async tombstoneDetailNode(node: Node, reason: DetailDeleteReason): Promise<boolean> {
    if (node.deletedAt) return false;
    const metadata = {
      ...(isRecord(node.metadata) ? node.metadata : {}),
      deletedReason: reason,
    };
    await this.mebular.graph.updateNode(node.id, { metadata });
    const ok = await this.mebular.graph.deleteNode(node.id);
    if (ok) {
      await this.refreshRecordDetailAvailability(detailRecordIds(node));
    }
    return ok;
  }

  private async refreshRecordDetailAvailability(recordIds: string[]): Promise<void> {
    const unique = [...new Set(recordIds)];
    if (unique.length === 0) return;
    const liveDetails = (await this.detailNodes())
      .filter((node) => !node.deletedAt && !isDetailExpired(node));
    for (const id of unique) {
      const record = await this.mebular.graph.getNode(id);
      if (!record || record.deletedAt || isInternalNode(record)) continue;
      const referenced = liveDetails.some((detail) => detailRecordIds(detail).includes(id));
      const metadata = isRecord(record.metadata) ? record.metadata : {};
      if (referenced && metadata.detailAvailable === false) {
        await this.mebular.graph.updateNode(id, { metadata: { ...metadata, detailAvailable: true } });
      } else if (!referenced && metadata.detailAvailable !== false) {
        await this.mebular.graph.updateNode(id, { metadata: { ...metadata, detailAvailable: false } });
      }
    }
  }

  private canGovernDetail(
    actorType: 'agent' | 'user' | 'system',
    agentId: string | undefined,
    node: Node,
  ): boolean {
    if (actorType === 'user' || actorType === 'system') return true;
    if (actorType !== 'agent' || typeof agentId !== 'string') return false;
    if (domainOfNamespace(node.namespace) !== `agent:${agentId}`) return false;
    const provenance = isRecord(node.metadata?.provenance) ? node.metadata.provenance : {};
    return provenance.writerId === agentId;
  }

  private async cascadeDetailTombstones(recordIds: string[]): Promise<string[]> {
    const deletedIds = new Set(recordIds);
    if (deletedIds.size === 0) return [];
    const detailsDeleted: string[] = [];
    for (const detail of await this.detailNodes()) {
      if (detail.deletedAt) continue;
      const refs = detailRecordIds(detail);
      if (!refs.some((id) => deletedIds.has(id))) continue;
      let hasLiveOther = false;
      for (const otherId of refs) {
        if (deletedIds.has(otherId)) continue;
        const other = await this.mebular.graph.getNode(otherId);
        if (!other || other.deletedAt) continue;
        const internalKind = other.metadata?.internalObject && typeof other.metadata.internalObject === 'object'
          ? (other.metadata.internalObject as { kind?: unknown }).kind
          : null;
        if (!isInternalNode(other)
          || internalKind === 'context_checkpoint'
          || internalKind === 'detail_record') {
          hasLiveOther = true;
          break;
        }
      }
      if (hasLiveOther) continue;
      if (await this.tombstoneDetailNode(detail, 'record_deleted')) {
        detailsDeleted.push(detail.id);
      }
    }
    return detailsDeleted;
  }

  private async allStorageNodes(): Promise<Node[]> {
    return this.mebular.storage.listNodes();
  }

  private async snapshot(): Promise<{ nodes: Node[]; edges: Edge[] }> {
    const [nodes, edges] = await Promise.all([
      this.allStorageNodes(),
      this.mebular.storage.listEdges(),
    ]);
    return { nodes, edges };
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

function detailValidationError(
  index: number,
  field: string,
  message: string,
  extra?: Record<string, unknown>,
): ValidationError {
  return new ValidationError(message, { index, field, ...(extra ?? {}) });
}

function detailDedupeKey(value: {
  domain: string;
  detailKind: DetailKind;
  contentHash: string;
  chunkIndex: number;
}): string {
  return `content\u0000${value.domain}\u0000${value.detailKind}\u0000${value.contentHash}\u0000${value.chunkIndex}`;
}

function detailClientDedupeKey(domain: string, clientItemId: string): string {
  return `client\u0000${domain}\u0000${clientItemId}`;
}

function detailResultEntry(
  status: 'created' | 'duplicate',
  plan: DetailWritePlan,
  id: string,
): DetailWriteResultEntry {
  return {
    ...(plan.clientItemId !== undefined ? { clientItemId: plan.clientItemId } : {}),
    status,
    id,
    type: DETAIL_NODE_TYPE,
    kind: DETAIL_NODE_TYPE,
    domain: plan.domain,
    detailKind: plan.detailKind,
    contentHash: plan.contentHash,
    ownerType: plan.ownerType,
    ownerId: plan.ownerId,
    ...(status === 'duplicate' ? { duplicate: true } : {}),
  };
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

/**
 * 统一域聚合：`stats()` 与管理面 `namespaceStats()` 共用，避免两套计数规则。
 * `count` 保留历史口径（域内全部节点，含归档/墓碑）；`memoryRecords` 排除内部对象。
 */
function domainStatsFromNodes(nodes: Node[], options: { includeReserved: boolean }): MemoryDomainStats[] {
  const domains = new Map<string, MemoryDomainStats>();
  for (const node of nodes) {
    const domain = domainOfNamespace(node.namespace);
    // `__policy__` 与其他 `__*` 保留域不是记忆域；capability 默认不读写。
    if (!options.includeReserved && domain.startsWith('__')) continue;
    let entry = domains.get(domain);
    if (!entry) {
      entry = {
        domain,
        count: 0,
        memoryRecords: 0,
        internalObjects: 0,
        internalKinds: {},
        detailBytes: 0,
        lastUpdatedAt: 0,
      };
      domains.set(domain, entry);
    }
    entry.count += 1;
    if (isDetailNode(node) && !node.deletedAt) entry.detailBytes += detailBytes(node);
    if (isInternalNode(node)) {
      entry.internalObjects += 1;
      const kind = internalObjectKindOf(node);
      if (kind) entry.internalKinds[kind] = (entry.internalKinds[kind] ?? 0) + 1;
    } else if (MEMORY_NODE_TYPES.has(node.type)) {
      entry.memoryRecords += 1;
    }
    entry.lastUpdatedAt = Math.max(
      entry.lastUpdatedAt,
      typeof node.updatedAt === 'number' ? node.updatedAt : 0,
    );
  }
  return [...domains.values()];
}

function internalObjectKindOf(node: Node): string | null {
  const metadata = node.metadata?.internalObject;
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    const kind = (metadata as { kind?: unknown }).kind;
    if (typeof kind === 'string' && kind.length > 0) return kind;
  }
  return node.type ?? null;
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
