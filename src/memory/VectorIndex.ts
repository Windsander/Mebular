// 向量检索接口（phase-4-plan 4.3：接口先行、缺省关闭）
//
// 可插拔设计：实现方（如本地 embedding 适配器）在 MemoryStore 构造时注入；
// 未配置时检索走关键词基线，结果不携带 relevance（诚实缺失，不伪造分数）。

import type { Node } from '../types/index.js';

export interface VectorIndexHit {
  nodeId: string;
  score: number;
}

export interface VectorIndex {
  /** 写入/更新节点的向量索引 */
  index(node: Node): Promise<void>;
  /** 移除节点的向量索引 */
  remove(nodeId: string): Promise<void>;
  /** 语义检索：返回按相关度降序的命中（低于实现阈值的不返回） */
  query(text: string, k: number): Promise<VectorIndexHit[]>;
  /** 是否已索引指定节点（可选；用于惰性增量回填） */
  has?(nodeId: string): boolean;
  /** 已索引节点 ID（可选；用于删除/墓碑剪枝） */
  ids?(): string[];
  /** 已索引节点数（可选；诊断/惰性重建判定） */
  readonly size?: number;
}
