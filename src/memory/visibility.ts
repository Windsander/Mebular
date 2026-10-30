// 通用内部对象可见性（0.3.0 contract §5.3 / §9.2）
//
// core 只认识两个通用信号：
// - `metadata.internal === true`（内部对象唯一通用判别键）；
// - 保留 namespace（`__*`，但 `__policy__` 属于既有策略语义）。
//
// core 不认识 compact / self_record / context_checkpoint 等 Memory Runtime 类型；
// 普通 MemoryRecord 不设置 `metadata.internal`，因此不受影响。

import type { Node } from '../types/index.js';

type InternalCheckNode = Pick<Node, 'metadata' | 'namespace'>;

/** 是否为内部对象（默认查询必须排除）。 */
export function isInternalNode(node: InternalCheckNode | null | undefined): boolean {
  if (!node) return false;
  if (node.metadata?.internal === true) return true;
  const namespace = node.namespace;
  return typeof namespace === 'string' && namespace.startsWith('__') && namespace !== '__policy__';
}

/** 管理面/调试面默认过滤：显式 `includeInternal` 才返回内部对象。 */
export function filterInternalNodes<T extends InternalCheckNode>(
  nodes: readonly T[],
  options: { includeInternal?: boolean } = {},
): T[] {
  if (options.includeInternal === true) return [...nodes];
  return nodes.filter((node) => !isInternalNode(node));
}
