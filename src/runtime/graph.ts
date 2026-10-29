// Runtime 图映射（contract §2.1 / §2.2 / §2.5）
//
// Compact / ContextCheckpoint(cloud) / SelfRecord(cloud) 都是普通图节点：
// type 使用冻结的内部类型，`metadata.runtime` 是唯一判别键，tag 使用保留前缀。
// 不创建从用户记录到内部对象的边；来源关系只写在 content.sourceIds / recordIds。

import type { GraphStore } from '../core/GraphStore.js';
import { ValidationError } from '../errors.js';
import type { Node } from '../types/index.js';
import { isRuntimeInternalNode, readRuntimeMetadata } from './internal.js';
import {
  RUNTIME_METADATA_KEY,
  RUNTIME_SCHEMA_VERSION,
  RUNTIME_TAG_PREFIX,
  type Compact,
  type ContextCheckpoint,
  type RuntimeEnvelope,
  type RuntimeInternalNodeType,
  type RuntimeNodeMetadata,
  type SelfRecord,
} from './types.js';

/** envelope → `metadata.runtime` 载荷。 */
export function toRuntimeNodeMetadata(envelope: RuntimeEnvelope): RuntimeNodeMetadata {
  const metadata: RuntimeNodeMetadata = {
    schema: RUNTIME_SCHEMA_VERSION,
    kind: envelope.kind,
    internal: envelope.internal,
    cloudId: envelope.cloudId,
    userId: envelope.userId,
    agentId: envelope.agentId,
    visibility: envelope.visibility,
    sync: envelope.sync,
    provenance: { ...envelope.provenance },
  };
  if (envelope.hostId !== undefined) metadata.hostId = envelope.hostId;
  if (envelope.threadId !== undefined) metadata.threadId = envelope.threadId;
  return metadata;
}

/** 内部节点 tag：`mebular:runtime:internal` + `mebular:runtime:kind:<kind>`。 */
export function runtimeNodeTags(kind: RuntimeEnvelope['kind']): string[] {
  return [`${RUNTIME_TAG_PREFIX}internal`, `${RUNTIME_TAG_PREFIX}kind:${kind}`];
}

export interface CreateRuntimeObjectInput {
  type: RuntimeInternalNodeType;
  content: Record<string, unknown>;
  envelope: RuntimeEnvelope;
  namespace?: string;
  extraTags?: string[];
}

/**
 * 创建 Runtime 内部对象节点。
 * - content 是对象正文（Compact / ContextCheckpoint / SelfRecord）；
 * - `metadata.runtime` 由 envelope 生成；
 * - 不创建任何边。
 */
export async function createRuntimeObjectNode(
  graph: Pick<GraphStore, 'createNode' | 'updateNode' | 'addTag'>,
  input: CreateRuntimeObjectInput,
): Promise<Node> {
  if (input.envelope.kind !== input.type) {
    throw new ValidationError(`runtime envelope kind ${input.envelope.kind} 与节点类型 ${input.type} 不一致`);
  }
  if (input.envelope.internal !== true) {
    throw new ValidationError('Runtime 内部对象必须设置 envelope.internal=true');
  }

  const created = await graph.createNode(input.type, input.content, undefined, {
    namespace: input.namespace ?? input.envelope.namespace ?? 'default',
  });
  const existingMetadata = (created.metadata ?? {}) as Record<string, unknown>;
  const withMetadata = await graph.updateNode(created.id, {
    metadata: {
      ...existingMetadata,
      [RUNTIME_METADATA_KEY]: toRuntimeNodeMetadata(input.envelope),
    },
  });
  if (!withMetadata) {
    throw new ValidationError(`Runtime 节点写入后读取失败：${created.id}`);
  }

  let node = withMetadata;
  const tags = [...new Set([...runtimeNodeTags(input.type), ...(input.extraTags ?? [])])];
  for (const tag of tags) {
    node = (await graph.addTag(node.id, tag)) ?? node;
  }
  return node;
}

export async function createCompactNode(
  graph: Pick<GraphStore, 'createNode' | 'updateNode' | 'addTag'>,
  compact: Compact,
  envelope: RuntimeEnvelope,
  options: { namespace?: string; extraTags?: string[] } = {},
): Promise<Node> {
  return createRuntimeObjectNode(graph, {
    type: 'compact',
    content: compact as unknown as Record<string, unknown>,
    envelope,
    namespace: options.namespace ?? envelope.namespace ?? 'default',
    ...(options.extraTags !== undefined ? { extraTags: options.extraTags } : {}),
  });
}

export async function createContextCheckpointNode(
  graph: Pick<GraphStore, 'createNode' | 'updateNode' | 'addTag'>,
  checkpoint: ContextCheckpoint,
  envelope: RuntimeEnvelope,
): Promise<Node> {
  return createRuntimeObjectNode(graph, {
    type: 'context_checkpoint',
    content: checkpoint as unknown as Record<string, unknown>,
    envelope,
    namespace: '__checkpoint__',
  });
}

export async function createSelfRecordNode(
  graph: Pick<GraphStore, 'createNode' | 'updateNode' | 'addTag'>,
  self: SelfRecord,
  envelope: RuntimeEnvelope,
): Promise<Node> {
  return createRuntimeObjectNode(graph, {
    type: 'self_record',
    content: self as unknown as Record<string, unknown>,
    envelope,
    namespace: '__self__',
  });
}

/** 管理面调试视图（`GET /runtime/v1/objects/:id` 的 data 形状）。 */
export interface RuntimeObjectView {
  id: string;
  type: string;
  kind: string | null;
  internal: boolean;
  namespace: string;
  metadata: Record<string, unknown>;
  content?: unknown;
}

export function toRuntimeObjectView(node: Node, options: { includeContent?: boolean } = {}): RuntimeObjectView {
  const runtime = readRuntimeMetadata(node);
  return {
    id: node.id,
    type: node.type,
    kind: runtime?.kind ?? null,
    internal: isRuntimeInternalNode(node),
    namespace: node.namespace ?? 'default',
    metadata: node.metadata ?? {},
    ...(options.includeContent === true ? { content: node.content } : {}),
  };
}
