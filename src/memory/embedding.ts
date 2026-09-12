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

export class LocalVectorIndex implements VectorIndex {
  private readonly provider: EmbeddingProvider;
  private readonly vectors = new Map<string, number[]>();

  constructor(provider: EmbeddingProvider) {
    this.provider = provider;
  }

  /** 已索引节点数（诊断/测试用） */
  get size(): number {
    return this.vectors.size;
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
      hits.push({ nodeId, score: cosineSimilarity(queryVector, vector) });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, k);
  }
}
