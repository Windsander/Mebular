// 图遍历类型（spec-004 TraverseOptions / TraverseResult）

export interface TraverseOptions {
  /** 最大深度（默认 3） */
  maxDepth?: number;
  /** 要遍历的边类型（relation） */
  edgeTypes?: string[];
  /** 遍历方向（默认 both） */
  direction?: 'incoming' | 'outgoing' | 'both';
  /** 是否包含已删除的节点/边（默认否） */
  includeDeleted?: boolean;
  /** 已访问节点 ID（防环；传入可跨多次遍历累积） */
  visited?: Set<string>;
}

export interface TraverseResult {
  visitedNodes: import('./node.js').Node[];
  visitedEdges: import('./edge.js').Edge[];
  /** 发现顺序的访问路径；首条为起点（无 edgeId） */
  path: { nodeId: string; edgeId?: string }[];
}
