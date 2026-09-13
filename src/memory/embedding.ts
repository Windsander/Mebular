// 本地 embedding 与向量索引（G2）
//
// - `EmbeddingProvider`：文本 → 向量的最小接口，可注入任意实现
//   （本地 Transformers.js、替代模型或测试用确定性实现）。
// - `LocalVectorIndex`：内存向量索引，实现 `VectorIndex`，余弦相似度排序。
//
// 零强制运行时依赖：embedding 实现（Transformers.js）是可选依赖，
// 缺包时由 `resolveVectorIndex` 降级关键词基线并告警。

import type { Node } from '../types/index.js';
import { nodeSearchText } from './text.js';
import type { VectorIndex, VectorIndexHit } from './VectorIndex.js';

export interface EmbeddingProvider {
  /** 实现标识（日志/诊断用） */
  readonly id: string;
  /** 批量嵌入；返回顺序与入参一致 */
  embed(texts: string[]): Promise<number[][]>;
}

function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface LocalVectorIndexOptions {
  /**
   * 最低余弦相似度：低于该值的命中不返回（避免「硬塞 top-k」低相关结果）。
   * 缺省 0.2（面向多语言 MiniLM 量纲；可按模型调整）。
   */
  minScore?: number;
}

export const DEFAULT_MIN_SCORE = 0.2;

export class LocalVectorIndex implements VectorIndex {
  private readonly provider: EmbeddingProvider;
  private readonly vectors = new Map<string, number[]>();
  private readonly minScore: number;

  constructor(provider: EmbeddingProvider, options: LocalVectorIndexOptions = {}) {
    this.provider = provider;
    this.minScore = options.minScore ?? DEFAULT_MIN_SCORE;
  }

  /** 已索引节点数（诊断/测试用） */
  get size(): number {
    return this.vectors.size;
  }

  /** 是否已索引指定节点（惰性回填判定） */
  has(nodeId: string): boolean {
    return this.vectors.has(nodeId);
  }

  /** 当前已索引节点 ID（删除/墓碑剪枝用） */
  ids(): string[] {
    return [...this.vectors.keys()];
  }

  async index(node: Node): Promise<void> {
    const text = nodeSearchText(node).trim();
    if (text === '') {
      this.vectors.delete(node.id);
      return;
    }
    const [vector] = await this.provider.embed([text]);
    if (vector) {
      this.vectors.set(node.id, vector);
    }
  }

  async remove(nodeId: string): Promise<void> {
    this.vectors.delete(nodeId);
  }

  async query(text: string, k: number): Promise<VectorIndexHit[]> {
    if (text.trim() === '' || k <= 0) {
      return [];
    }
    const [queryVector] = await this.provider.embed([text]);
    if (!queryVector) {
      return [];
    }
    const hits: VectorIndexHit[] = [];
    for (const [nodeId, vector] of this.vectors) {
      const score = cosineSimilarity(queryVector, vector);
      if (score >= this.minScore) {
        hits.push({ nodeId, score });
      }
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, k);
  }
}
