// 召回与查询增强测试（phase-4-plan 4.3）
//
// GraphStore.traverse 的深度/方向/边类型/删除过滤与环防护；
// MemoryStore 关键词检索基线与可插拔 VectorIndex 的行为。

import { describe, it, expect, beforeEach } from '@jest/globals';
import { GraphStore } from '../../src/core/GraphStore.js';
import { EventLog } from '../../src/eventlog/EventLog.js';
import { MemoryStorage } from '../../src/storage/MemoryStorage.js';
import { MemoryStore } from '../../src/memory/MemoryStore.js';
import { EdgeTypes } from '../../src/memory/types.js';
import type { VectorIndex, VectorIndexHit } from '../../src/memory/VectorIndex.js';
import type { Node } from '../../src/types/index.js';

describe('GraphStore.traverse', () => {
  let graph: GraphStore;

  beforeEach(() => {
    const storage = new MemoryStorage();
    graph = new GraphStore({ storage, author: 'device-A' });
  });

  /** 造一条链 a→b→c→d 和一条支路 a→e，及一条环边 c→a */
  async function buildGraph() {
    const a = await graph.createNode('entity', { name: 'a' });
    const b = await graph.createNode('entity', { name: 'b' });
    const c = await graph.createNode('entity', { name: 'c' });
    const d = await graph.createNode('entity', { name: 'd' });
    const e = await graph.createNode('entity', { name: 'e' });
    await graph.createEdge(a.id, b.id, EdgeTypes.KNOWS);
    await graph.createEdge(b.id, c.id, EdgeTypes.KNOWS);
    await graph.createEdge(c.id, d.id, EdgeTypes.WORKS_ON);
    await graph.createEdge(a.id, e.id, EdgeTypes.USES);
    await graph.createEdge(c.id, a.id, EdgeTypes.KNOWS); // 环
    return { a, b, c, d, e };
  }

  it('BFS 遍历全图且环不会导致死循环', async () => {
    const { a } = await buildGraph();
    const result = await graph.traverse(a.id);
    expect(result.visitedNodes).toHaveLength(5);
    expect(result.path[0]).toEqual({ nodeId: a.id });
    // 路径包含发现顺序的边引用
    expect(result.path.filter((p) => p.edgeId).length).toBe(4);
  });

  it('maxDepth 限制遍历深度', async () => {
    const { a } = await buildGraph();
    // both 方向下 a 的邻居：b（出）、e（出）、c（c→a 入）
    const depth1 = await graph.traverse(a.id, { maxDepth: 1 });
    expect(depth1.visitedNodes.map((n) => (n.content as { name: string }).name).sort())
      .toEqual(['a', 'b', 'c', 'e']);
  });

  it('edgeTypes 与 direction 过滤', async () => {
    const { a } = await buildGraph();
    // 只走 knows 边：a→b→c（c→a 回环被 visited 拦下），d 走不到
    const knowsOnly = await graph.traverse(a.id, { edgeTypes: [EdgeTypes.KNOWS] });
    expect(knowsOnly.visitedNodes.map((n) => (n.content as { name: string }).name).sort())
      .toEqual(['a', 'b', 'c']);

    // outgoing 从 b 出发：b→c→d、c→a、a→e，全图可达
    const ids = await buildGraphIds();
    const out = await graph.traverse(ids.b!, { direction: 'outgoing' });
    expect(out.visitedNodes.map((n) => (n.content as { name: string }).name).sort())
      .toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('默认不含已删除节点，includeDeleted 时包含', async () => {
    const { a, b } = await buildGraph();
    await graph.deleteNode(b.id);
    const without = await graph.traverse(a.id);
    expect(without.visitedNodes.map((n) => n.id)).not.toContain(b.id);
    const withDeleted = await graph.traverse(a.id, { includeDeleted: true });
    expect(withDeleted.visitedNodes.map((n) => n.id)).toContain(b.id);
  });

  it('起点不存在或被删除时返回空结果', async () => {
    const { a } = await buildGraph();
    expect((await graph.traverse('ghost')).visitedNodes).toHaveLength(0);
    await graph.deleteNode(a.id);
    expect((await graph.traverse(a.id)).visitedNodes).toHaveLength(0);
  });

  async function buildGraphIds() {
    const nodes = await graph.listNodes({ type: 'entity' });
    const byName = Object.fromEntries(
      nodes.map((n) => [(n.content as { name: string }).name, n.id]),
    );
    return byName as Record<string, string>;
  }
});

describe('MemoryStore 检索', () => {
  let storage: MemoryStorage;
  let graph: GraphStore;
  let memory: MemoryStore;

  beforeEach(() => {
    storage = new MemoryStorage();
    graph = new GraphStore({ storage, author: 'device-A', eventLog: new EventLog(storage, 'device-A') });
    memory = new MemoryStore(graph);
  });

  it('关键词大小写不敏感子串匹配（名称/正文/标签）', async () => {
    await memory.addEntity({ entityType: 'tool', name: 'Kimi', description: 'AI 助手' });
    await memory.addFact({ subject: 'user', predicate: 'likes', object: 'Coffee' });
    await memory.addEntity({ entityType: 'concept', name: 'rust', tags: ['Language'] });

    expect((await memory.search('kimi')).length).toBe(1);
    expect((await memory.search('COFFEE')).length).toBe(1);
    expect((await memory.search('language')).length).toBe(1); // 命中标签
    expect((await memory.search('不存在')).length).toBe(0);
  });

  it('检索支持类型与时间窗过滤', async () => {
    await memory.addEntity({ entityType: 'tool', name: 'alpha' });
    await memory.addSkill({ name: 'alpha 技能', description: 'd', category: 'ops' });

    expect((await memory.search('alpha', { types: ['skill'] })).length).toBe(1);
    expect((await memory.search('alpha', { types: ['entity'] })).length).toBe(1);
    expect((await memory.search('alpha')).length).toBe(2);
  });

  it('未配置向量索引时 vectorQuery 诚实返回空', async () => {
    expect(memory.hasVectorIndex()).toBe(false);
    expect(await memory.vectorQuery('anything')).toEqual([]);
  });

  it('配置向量索引后写入即建索引，查询带分数', async () => {
    const indexed: string[] = [];
    const fakeIndex: VectorIndex = {
      async index(node: Node) {
        indexed.push(node.id);
      },
      async remove() {},
      async query(_text: string, k: number): Promise<VectorIndexHit[]> {
        return indexed.slice(0, k).map((nodeId, i) => ({ nodeId, score: 1 - i * 0.1 }));
      },
    };
    const withVector = new MemoryStore(graph, fakeIndex);
    const entity = await withVector.addEntity({ entityType: 'concept', name: 'mebular' });

    expect(withVector.hasVectorIndex()).toBe(true);
    expect(indexed).toContain(entity.id);

    const hits = await withVector.vectorQuery('图', 5);
    expect(hits[0]?.node.id).toBe(entity.id);
    expect(hits[0]?.score).toBeGreaterThan(0);
  });
});
