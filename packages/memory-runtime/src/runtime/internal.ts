// Memory Runtime 原型内部对象判定（0.3.0 W1）
//
// 本模块只属于 @mebular/memory-runtime；core 不认识这里的具体类型名，只使用
// 自己的通用判定（metadata.internal + 保留 namespace）。
//
// 原型判定：通用 metadata.internal + 节点类型 + metadata.runtime.internal
// + 保留 namespace（`__*`，但 `__policy__` 属于既有策略语义）。
// 这层额外判定用于 RuntimeService 的读路径与管理面，防止原型旧数据泄漏。

import type { Node } from '@mebular/core';
import {
  RUNTIME_INTERNAL_NODE_TYPES,
  RUNTIME_METADATA_KEY,
  RUNTIME_RESERVED_NAMESPACES,
  type RuntimeInternalNodeType,
  type RuntimeNodeMetadata,
} from './types.js';

type InternalCheckNode = Pick<Node, 'type' | 'metadata' | 'namespace'>;

/** `metadata.runtime` 是否是 Runtime 判别载荷（只做形状判断，不校验完整字段）。 */
export function readRuntimeMetadata(
  node: Pick<Node, 'metadata'> | null | undefined,
): Partial<RuntimeNodeMetadata> | null {
  const value = node?.metadata?.[RUNTIME_METADATA_KEY];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Partial<RuntimeNodeMetadata>;
}

/** 是否为 Runtime 内部节点（默认查询必须排除）。 */
export function isRuntimeInternalNode(node: InternalCheckNode | null | undefined): boolean {
  if (!node) return false;
  const type = node.type;
  if (typeof type === 'string' && (RUNTIME_INTERNAL_NODE_TYPES as readonly string[]).includes(type)) {
    return true;
  }
  // 0.3 通用判别键：core（MemoryStore/MemoryService/CMF）只认 metadata.internal。
  if (node.metadata?.internal === true) return true;
  const runtime = readRuntimeMetadata(node);
  if (runtime?.internal === true) return true;
  const namespace = node.namespace;
  if (typeof namespace === 'string' && namespace.startsWith('__') && namespace !== '__policy__') {
    return true;
  }
  return false;
}

/** Runtime 保留域：候选/写入默认不得落入（`__policy__` 也是保留域）。 */
export function isRuntimeReservedNamespace(namespace: string | undefined | null): boolean {
  if (typeof namespace !== 'string') return false;
  return (RUNTIME_RESERVED_NAMESPACES as readonly string[]).includes(namespace)
    || (namespace.startsWith('__') && namespace !== '__policy__');
}

/** 节点类型是否为 Runtime 内部类型（防御性保留 raw/trace）。 */
export function isRuntimeInternalNodeType(type: string | undefined | null): type is RuntimeInternalNodeType {
  return typeof type === 'string' && (RUNTIME_INTERNAL_NODE_TYPES as readonly string[]).includes(type);
}

/**
 * 控制台/管理面默认过滤：默认排除内部对象；显式 `includeInternal` 才返回。
 * 纯函数，供后续 Console `/admin/api/memories` 接线复用。
 */
export function filterRuntimeInternalNodes<T extends InternalCheckNode>(
  nodes: readonly T[],
  options: { includeInternal?: boolean } = {},
): T[] {
  if (options.includeInternal === true) return [...nodes];
  return nodes.filter((node) => !isRuntimeInternalNode(node));
}
