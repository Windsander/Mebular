// 图状态哈希（规范化 sha256）— G6.1
//
// 从 scripts/wan-sync.mjs 抽到 core，供脚本与 MCP/memory_status 共用：
// 排除 G3 证据 meta 节点（name 以 wan-evidence- 开头），对剩余节点/边按 id
// 规范化排序后 sha256，保证跨端/跨进程一致。

import { createHash } from 'crypto';
import type { Node, Edge } from '../types/index.js';
import { normalizeNamespace } from './namespace.js';

/** G3 广域网证据 meta 节点（不参与状态哈希） */
export function isEvidenceNode(node: Node): boolean {
  if (node.type !== 'meta') return false;
  const name = (node.content as { name?: unknown } | undefined)?.name;
  return typeof name === 'string' && name.startsWith('wan-evidence-');
}

function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * 按分区的图状态哈希（① · 一致性口径按域）。
 *
 * 两个**合法持有不同分区集合**的设备全局哈希必然不同（假警报）；跨端自检
 * 只应比**共同授权域**。本函数把节点/边按 `namespace`（缺失 = `default`）
 * 分组，逐域调用 `computeStateHash`；域相同则与全局口径一致。
 * 证据 meta 节点沿用 `isEvidenceNode` 排除规则。
 */
export function computeStateHashByNamespace(nodes: Node[], edges: Edge[]): Record<string, string> {
  const groups = new Map<string, { nodes: Node[]; edges: Edge[] }>();
  const group = (ns: string): { nodes: Node[]; edges: Edge[] } => {
    let entry = groups.get(ns);
    if (!entry) {
      entry = { nodes: [], edges: [] };
      groups.set(ns, entry);
    }
    return entry;
  };
  for (const node of nodes) {
    if (isEvidenceNode(node)) continue;
    group(normalizeNamespace(node.namespace)).nodes.push(node);
  }
  for (const edge of edges) {
    group(normalizeNamespace(edge.namespace)).edges.push(edge);
  }
  const out: Record<string, string> = {};
  for (const ns of [...groups.keys()].sort()) {
    const entry = groups.get(ns)!;
    out[ns] = computeStateHash(entry.nodes, entry.edges);
  }
  return out;
}

/** 规范化图状态哈希（sha256 hex），排除证据 meta 节点 */
export function computeStateHash(nodes: Node[], edges: Edge[]): string {
  const dataNodes = nodes.filter((node) => !isEvidenceNode(node));
  const canon = JSON.stringify({
    nodes: [...dataNodes].sort(byId).map((node) => ({
      id: node.id,
      content: node.content,
      deletedAt: node.deletedAt ?? null,
    })),
    edges: [...edges].sort(byId).map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      relation: edge.relation,
    })),
  });
  return createHash('sha256').update(canon).digest('hex');
}
