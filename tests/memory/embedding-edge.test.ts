// LocalVectorIndex 边界：零向量、空文本、非法查询与 provider 空返回（覆盖补强）。
//
// 这些分支在真实模型下不常走到，但决定了「不硬塞低相关结果」与「空输入不炸」
// 的行为；用可注入的确定性 provider 锁定。

import { describe, it, expect } from '@jest/globals';
import { LocalVectorIndex, type EmbeddingProvider } from '../../src/memory/embedding.js';
import type { Node } from '../../src/types/index.js';

function makeNode(id: string, text: string): Node {
  return {
    id,
    type: 'fact',
    content: { name: text },
    labels: [],
    createdBy: 'device-A',
    signature: '',
    createdAt: 1000,
    updatedAt: 1000,
  };
}

function providerFor(map: Record<string, number[]>): { provider: EmbeddingProvider; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    provider: {
      id: 'fake',
      embed: async (texts) => {
        calls.push(...texts);
        return texts.map((text) => map[text] ?? [0, 0]);
      },
    },
  };
}

describe('LocalVectorIndex 边界', () => {
  it('查询向量为零向量（normA=0）→ 不返回命中', async () => {
    const { provider } = providerFor({ hello: [1, 0], zero: [0, 0] });
    const index = new LocalVectorIndex(provider);
    await index.index(makeNode('n1', 'hello'));
    expect(await index.query('zero', 5)).toEqual([]);
  });

  it('已索引向量为零向量（normB=0）→ 不返回命中', async () => {
    const { provider } = providerFor({ hello: [1, 0], zero: [0, 0] });
    const index = new LocalVectorIndex(provider);
    await index.index(makeNode('n1', 'zero'));
    expect(await index.query('hello', 5)).toEqual([]);
  });

  it('空文本节点：index 不建立向量，已有向量被移除', async () => {
    const { provider } = providerFor({ hello: [1, 0] });
    const index = new LocalVectorIndex(provider);
    await index.index(makeNode('n1', 'hello'));
    expect(index.has('n1')).toBe(true);

    const empty: Node = { ...makeNode('n1', ''), content: {} };
    await index.index(empty);
    expect(index.has('n1')).toBe(false);
    expect(index.size).toBe(0);
  });

  it('空查询 / k<=0：直接返回空且不调用 provider', async () => {
    const { provider, calls } = providerFor({ hello: [1, 0] });
    const index = new LocalVectorIndex(provider);
    await index.index(makeNode('n1', 'hello'));

    expect(await index.query('   ', 5)).toEqual([]);
    expect(await index.query('hello', 0)).toEqual([]);
    expect(await index.query('hello', -1)).toEqual([]);
    // 仅 index 阶段调用过一次 embed
    expect(calls).toEqual(['hello']);
  });

  it('provider 返回空数组（无查询向量）→ 返回空命中', async () => {
    const provider: EmbeddingProvider = {
      id: 'empty',
      embed: async () => [],
    };
    const index = new LocalVectorIndex(provider);
    expect(await index.query('hello', 5)).toEqual([]);
  });
});
