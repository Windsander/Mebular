// Canonical Memory Format（CMF）v1 —— 版本化记忆交换格式（phase-5-plan 5.2）
//
// 定位：CMF 是图模型的交换投影，不是第二权威——图是唯一权威模型。
// 规则成文：
// - 版本协商：version 必须 ≤ 当前支持版本，否则诚实抛 CMF_VERSION_UNSUPPORTED；
//   缺 format/version 字段报 CMF_FORMAT_INVALID。解析器对未来低版本兼容。
// - 前向兼容：文档/节点/边上的未知字段收入 extensions 保留袋，
//   序列化时原样写回——允许降级，不允许静默丢字段。
// - 未知节点类型降级为 'other'，原类型记入 originalType；
//   再导出时还原原类型，降级路径同样往返无损。
// - 出处链：文档级 source（app/deviceId）+ 节点内容自带 source（Fact.source）
//   + 图内 source_of 边，三者各司其职、互不改写。
//
// 幂等键（import:<sha256> 标签）由适配器框架（5.3）统一负责；
// 本模块提供 cmfNodeFingerprint 作为跨端稳定指纹的输入。

import { MebularError } from '../errors.js';
import { canonicalize } from '../eventlog/EventLog.js';
import type { GraphStore } from '../core/GraphStore.js';
import type { MemoryStore } from '../memory/MemoryStore.js';
import type { Edge, Node } from '../types/index.js';

export const CMF_FORMAT = 'cmf';
export const CMF_VERSION = 1;

/** 五类已知记忆节点类型；其余一律降级 other */
export const KNOWN_NODE_TYPES = ['entity', 'fact', 'episode', 'skill', 'meta'] as const;
export type KnownNodeType = (typeof KNOWN_NODE_TYPES)[number];

// ---------- 文档结构 ----------

export interface CmfSource {
  app?: string;
  deviceId?: string;
}

export interface CmfNode {
  /** 来源端节点 ID（交换期身份；导入端另行分配本地 ID，经 idMap 对应） */
  id: string;
  type: KnownNodeType | 'other';
  content?: string | Record<string, unknown>;
  labels?: string[];
  tags?: string[];
  validFrom?: number;
  validTo?: number;
  createdAt?: number;
  createdBy?: string;
  /** 降级为 other 时的原类型 */
  originalType?: string;
  /** 未知字段保留袋（前向兼容） */
  extensions?: Record<string, unknown>;
}

export interface CmfEdge {
  source: string;
  target: string;
  relation: string;
  labels?: string[];
  extensions?: Record<string, unknown>;
}

export interface CmfDocument {
  format: typeof CMF_FORMAT;
  version: number;
  exportedAt: number;
  source?: CmfSource;
  nodes: CmfNode[];
  edges: CmfEdge[];
  extensions?: Record<string, unknown>;
}

// ---------- 解析（含兼容与降级规则） ----------

const KNOWN_NODE_FIELDS = new Set([
  'id', 'type', 'content', 'labels', 'tags', 'validFrom', 'validTo',
  'createdAt', 'createdBy', 'originalType', 'extensions',
]);
const KNOWN_EDGE_FIELDS = new Set(['source', 'target', 'relation', 'labels', 'extensions']);
const KNOWN_DOC_FIELDS = new Set(['format', 'version', 'exportedAt', 'source', 'nodes', 'edges', 'extensions']);

/** 把未知字段收入保留袋；已有 extensions 合并保留 */
function collectExtensions(
  record: Record<string, unknown>,
  knownFields: Set<string>,
): Record<string, unknown> | undefined {
  const bag: Record<string, unknown> = { ...(record.extensions as Record<string, unknown> | undefined) };
  let has = Object.keys(bag).length > 0;
  for (const key of Object.keys(record)) {
    if (!knownFields.has(key)) {
      bag[key] = record[key];
      has = true;
    }
  }
  return has ? bag : undefined;
}

/** 解析 CMF 文档（字符串或对象），执行版本协商与未知类型降级 */
export function parseCmfDocument(input: string | unknown): CmfDocument {
  let raw: unknown = input;
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input);
    } catch (error) {
      throw new MebularError('CMF 文档不是合法 JSON', 'CMF_FORMAT_INVALID', error as Error);
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new MebularError('CMF 文档必须是 JSON 对象', 'CMF_FORMAT_INVALID');
  }
  const doc = raw as Record<string, unknown>;
  if (doc.format !== CMF_FORMAT) {
    throw new MebularError(`缺少 CMF 格式标记（format !== '${CMF_FORMAT}'）`, 'CMF_FORMAT_INVALID');
  }
  if (typeof doc.version !== 'number' || !Number.isInteger(doc.version) || doc.version < 1) {
    throw new MebularError('CMF 版本号缺失或非法', 'CMF_FORMAT_INVALID');
  }
  if (doc.version > CMF_VERSION) {
    throw new MebularError(
      `CMF 版本 ${doc.version} 高于本端支持的 ${CMF_VERSION}，请升级后再导入`,
      'CMF_VERSION_UNSUPPORTED',
    );
  }

  const nodes: CmfNode[] = [];
  if (!Array.isArray(doc.nodes)) {
    throw new MebularError('CMF 文档缺少 nodes 数组', 'CMF_FORMAT_INVALID');
  }
  for (const item of doc.nodes) {
    nodes.push(parseCmfNode(item));
  }

  const edges: CmfEdge[] = [];
  if (doc.edges !== undefined) {
    if (!Array.isArray(doc.edges)) {
      throw new MebularError('CMF 文档 edges 必须是数组', 'CMF_FORMAT_INVALID');
    }
    for (const edge of doc.edges) {
      edges.push(parseCmfEdge(edge));
    }
  }

  const parsed: CmfDocument = {
    format: CMF_FORMAT,
    version: doc.version,
    exportedAt: typeof doc.exportedAt === 'number' ? doc.exportedAt : 0,
    nodes,
    edges,
  };
  if (doc.source && typeof doc.source === 'object') {
    parsed.source = doc.source as CmfSource;
  }
  const extensions = collectExtensions(doc, KNOWN_DOC_FIELDS);
  if (extensions) parsed.extensions = extensions;
  return parsed;
}

function parseCmfNode(input: unknown): CmfNode {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new MebularError('CMF 节点必须是对象', 'CMF_FORMAT_INVALID');
  }
  const record = input as Record<string, unknown>;
  if (typeof record.id !== 'string' || !record.id) {
    throw new MebularError('CMF 节点缺少 id', 'CMF_FORMAT_INVALID');
  }

  // 未知类型降级 other + originalType 保留（不静默丢字段）
  const rawType = typeof record.type === 'string' ? record.type : 'other';
  const known = (KNOWN_NODE_TYPES as readonly string[]).includes(rawType);
  const node: CmfNode = {
    id: record.id,
    type: known ? (rawType as KnownNodeType) : 'other',
  };
  if (!known) node.originalType = rawType;
  if (record.content !== undefined) node.content = record.content as CmfNode['content'];
  if (Array.isArray(record.labels)) node.labels = record.labels as string[];
  if (Array.isArray(record.tags)) node.tags = record.tags as string[];
  if (typeof record.validFrom === 'number') node.validFrom = record.validFrom;
  if (typeof record.validTo === 'number') node.validTo = record.validTo;
  if (typeof record.createdAt === 'number') node.createdAt = record.createdAt;
  if (typeof record.createdBy === 'string') node.createdBy = record.createdBy;
  if (typeof record.originalType === 'string' && known) node.originalType = record.originalType;
  const extensions = collectExtensions(record, KNOWN_NODE_FIELDS);
  if (extensions) node.extensions = extensions;
  return node;
}

function parseCmfEdge(input: unknown): CmfEdge {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new MebularError('CMF 边必须是对象', 'CMF_FORMAT_INVALID');
  }
  const record = input as Record<string, unknown>;
  if (typeof record.source !== 'string' || typeof record.target !== 'string' || typeof record.relation !== 'string') {
    throw new MebularError('CMF 边缺少 source/target/relation', 'CMF_FORMAT_INVALID');
  }
  const edge: CmfEdge = { source: record.source, target: record.target, relation: record.relation };
  if (Array.isArray(record.labels)) edge.labels = record.labels as string[];
  const extensions = collectExtensions(record, KNOWN_EDGE_FIELDS);
  if (extensions) edge.extensions = extensions;
  return edge;
}

// ---------- 序列化（extensions 写回原层级） ----------

function spreadExtensions<T extends Record<string, unknown>>(
  base: T,
  extensions: Record<string, unknown> | undefined,
): T {
  if (!extensions) return base;
  const { extensions: _drop, ...rest } = base;
  return { ...rest, ...extensions } as T;
}

/** 序列化为 JSON 对象（extensions 袋展开回原层级；other 还原 originalType） */
export function serializeCmfDocument(doc: CmfDocument): Record<string, unknown> {
  const nodes = doc.nodes.map((node) => {
    const base: Record<string, unknown> = { ...node };
    // 降级节点的还原：导出时写回原类型，降级路径同样往返无损
    if (node.type === 'other' && node.originalType) {
      base.type = node.originalType;
    }
    return spreadExtensions(base, node.extensions);
  });
  const edges = doc.edges.map((edge) => spreadExtensions({ ...edge }, edge.extensions));
  const docBase: Record<string, unknown> = {
    format: CMF_FORMAT,
    version: doc.version,
    exportedAt: doc.exportedAt,
    nodes,
    edges,
  };
  if (doc.source) docBase.source = doc.source;
  return spreadExtensions(docBase, doc.extensions);
}

/** 序列化为 JSON 文本 */
export function stringifyCmfDocument(doc: CmfDocument): string {
  return JSON.stringify(serializeCmfDocument(doc), null, 2);
}

// ---------- 节点指纹（供 5.3 幂等键使用） ----------

/** CMF 节点的跨端稳定指纹输入：类型 + 内容 + 排序后标签，不含本地/来源 ID */
export function canonicalCmfNode(node: CmfNode): string {
  return canonicalize({
    type: node.type,
    originalType: node.originalType ?? null,
    content: node.content ?? null,
    labels: [...(node.labels ?? [])].sort(),
    validFrom: node.validFrom ?? null,
    validTo: node.validTo ?? null,
  });
}

// ---------- 图 → CMF ----------

export interface CmfExportOptions {
  source?: CmfSource;
  /** 是否包含已删除（墓碑）节点/边，默认否 */
  includeDeleted?: boolean;
  /** 自定义节点投影；默认原样拷贝核心字段 */
  projectNode?: (node: Node) => CmfNode | null;
}

function defaultNodeProjection(node: Node): CmfNode {
  const type = (KNOWN_NODE_TYPES as readonly string[]).includes(node.type)
    ? (node.type as KnownNodeType)
    : 'other';
  const out: CmfNode = { id: node.id, type };
  if (type === 'other') out.originalType = node.type;
  if (node.content !== undefined) {
    out.content = typeof node.content === 'string'
      ? node.content
      : JSON.parse(JSON.stringify(node.content)) as Record<string, unknown>;
  }
  if (node.labels?.length) out.labels = [...node.labels];
  if (node.tags?.length) out.tags = [...node.tags];
  if (node.validFrom !== undefined) out.validFrom = node.validFrom;
  if (node.validTo !== undefined) out.validTo = node.validTo;
  out.createdAt = node.createdAt;
  if (node.createdBy) out.createdBy = node.createdBy;
  return out;
}

/** 导出图（或其子集）为 CMF 文档 */
export async function exportGraphToCmf(
  graph: GraphStore,
  options: CmfExportOptions = {},
): Promise<CmfDocument> {
  const project = options.projectNode ?? defaultNodeProjection;
  const nodes: CmfNode[] = [];
  const keptIds = new Set<string>();
  for (const node of await graph.listNodes()) {
    if (!options.includeDeleted && node.deletedAt) continue;
    const projected = project(node);
    if (!projected) continue;
    nodes.push(projected);
    keptIds.add(node.id);
  }

  const edges: CmfEdge[] = [];
  for (const edge of await graph.listEdges()) {
    if (!options.includeDeleted && edge.deletedAt) continue;
    // 端点不在导出集内的边诚实略过（投影过滤时的必然结果）
    if (!keptIds.has(edge.source) || !keptIds.has(edge.target)) continue;
    const out: CmfEdge = { source: edge.source, target: edge.target, relation: edge.relation };
    if (edge.labels?.length) out.labels = [...edge.labels];
    edges.push(out);
  }

  const doc: CmfDocument = {
    format: CMF_FORMAT,
    version: CMF_VERSION,
    exportedAt: Date.now(),
    nodes,
    edges,
  };
  if (options.source) doc.source = options.source;
  return doc;
}

// ---------- CMF → 图（经 MemoryStore 校验路径） ----------

export interface CmfImportError {
  nodeId: string;
  error: string;
}

export interface CmfImportReport {
  nodesCreated: number;
  edgesCreated: number;
  /** 来源端 ID → 本地新 ID */
  idMap: Record<string, string>;
  /** 逐条诚实上报的失败（默认收集继续，不中断整批） */
  errors: CmfImportError[];
}

/** 把 CMF 文档导入记忆库：五类走 MemoryStore 校验路径，other 直通图层 */
export async function importCmfToMemory(
  memory: MemoryStore,
  doc: CmfDocument,
): Promise<CmfImportReport> {
  const report: CmfImportReport = { nodesCreated: 0, edgesCreated: 0, idMap: {}, errors: [] };

  for (const node of doc.nodes) {
    try {
      const local = await importOneNode(memory, node);
      report.idMap[node.id] = local.id;
      report.nodesCreated += 1;
    } catch (error) {
      report.errors.push({
        nodeId: node.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (const edge of doc.edges) {
    const source = report.idMap[edge.source];
    const target = report.idMap[edge.target];
    if (!source || !target) {
      report.errors.push({
        nodeId: `${edge.source}->${edge.target}`,
        error: '边端点不在成功导入集合内，略过该边',
      });
      continue;
    }
    try {
      await memory.getGraph().createEdge(source, target, edge.relation, edge.labels);
      report.edgesCreated += 1;
    } catch (error) {
      report.errors.push({
        nodeId: `${edge.source}->${edge.target}`,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return report;
}

async function importOneNode(memory: MemoryStore, node: CmfNode): Promise<Node> {
  const content = (typeof node.content === 'object' && node.content !== null
    ? node.content
    : {}) as Record<string, unknown>;
  const labels = node.labels;
  const tags = node.tags;

  switch (node.type) {
    case 'entity':
      return memory.addEntity({
        entityType: content.entityType as never,
        name: content.name as string,
        ...(content.description !== undefined ? { description: content.description as string } : {}),
        ...(content.properties !== undefined
          ? { properties: content.properties as Record<string, unknown> }
          : {}),
        ...(tags ? { tags } : {}),
        ...(labels ? { labels } : {}),
      });
    case 'fact':
      return memory.addFact({
        subject: content.subject as string,
        predicate: content.predicate as string,
        object: content.object as string,
        ...(node.validFrom !== undefined ? { validFrom: node.validFrom } : {}),
        ...(node.validTo !== undefined ? { validTo: node.validTo } : {}),
        ...(content.confidence !== undefined ? { confidence: content.confidence as number } : {}),
        ...(content.source !== undefined ? { source: content.source as string } : {}),
        ...(tags ? { tags } : {}),
        ...(labels ? { labels } : {}),
      });
    case 'episode':
      return memory.addEpisode({
        episodeType: content.episodeType as never,
        content: content.content as string,
        ...(content.title !== undefined ? { title: content.title as string } : {}),
        ...(content.contentHash !== undefined ? { contentHash: content.contentHash as string } : {}),
        ...(content.startTime !== undefined ? { startTime: content.startTime as number } : {}),
        ...(content.endTime !== undefined ? { endTime: content.endTime as number } : {}),
        ...(content.context !== undefined ? { context: content.context as string } : {}),
        ...(tags ? { tags } : {}),
        ...(labels ? { labels } : {}),
      });
    case 'skill':
      return memory.addSkill({
        name: content.name as string,
        description: content.description as string,
        category: content.category as string,
        ...(content.steps !== undefined ? { steps: content.steps as string[] } : {}),
        ...(content.commands !== undefined ? { commands: content.commands as string[] } : {}),
        ...(content.toolReferences !== undefined
          ? { toolReferences: content.toolReferences as string[] }
          : {}),
        ...(content.prerequisites !== undefined
          ? { prerequisites: content.prerequisites as string[] }
          : {}),
        ...(content.relatedEntities !== undefined
          ? { relatedEntities: content.relatedEntities as string[] }
          : {}),
        ...(tags ? { tags } : {}),
        ...(labels ? { labels } : {}),
      });
    case 'meta':
      return memory.addMeta({
        metaType: content.metaType as never,
        name: content.name as string,
        ...(content.value !== undefined ? { value: content.value } : {}),
        ...(tags ? { tags } : {}),
        ...(labels ? { labels } : {}),
      });
    case 'other': {
      // 降级节点直通图层，originalType 进 metadata 保留
      const withOrigin = {
        ...content,
        ...(typeof node.content === 'string' ? { text: node.content } : {}),
      };
      const created = await memory.getGraph().createNode('other', withOrigin, labels, {
        ...(node.validFrom !== undefined ? { validFrom: node.validFrom } : {}),
        ...(node.validTo !== undefined ? { validTo: node.validTo } : {}),
      });
      if (node.originalType) {
        await memory.getGraph().updateNode(created.id, {
          metadata: { originalType: node.originalType },
        });
      }
      return created;
    }
  }
}

export type { Edge, Node };
