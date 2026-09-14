// 图状态哈希（规范化 sha256）— G6.1
//
// 从 scripts/wan-sync.mjs 抽到 core，供脚本与 MCP/memory_status 共用：
// 排除 G3 证据 meta 节点（name 以 wan-evidence- 开头），对剩余节点/边按 id
// 规范化排序后 sha256，保证跨端/跨进程一致。

import { createHash } from 'crypto';
import type { Node, Edge } from '../types/index.js';

/** G3 广域网证据 meta 节点（不参与状态哈希） */
export function isEvidenceNode(node: Node): boolean {
  if (node.type !== 'meta') return false;
  const name = (node.content as { name?: unknown } | undefined)?.name;
  return typeof name === 'string' && name.startsWith('wan-evidence-');
}

function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
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
