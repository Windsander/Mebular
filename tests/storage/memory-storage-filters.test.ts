// MemoryStorage 过滤器四字段回归测试（Phase 6.1）
//
// 缺陷：listNodes 忽略 NodeFilter 的 updatedBy/deletedBy/fromTime/toTime。

import { describe, it, expect, beforeEach } from '@jest/globals';
import { GraphStore } from '../../src/core/GraphStore.js';
import { MemoryStorage } from '../../src/storage/MemoryStorage.js';

describe('MemoryStorage listNodes 过滤器补全', () => {
  let storage: MemoryStorage;
  let graph: GraphStore;

  beforeEach(() => {
    storage = new MemoryStorage();
    graph = new GraphStore({ storage, author: 'author-A' });
  });

  it('updatedBy 过滤', async () => {
    const fresh = await graph.createNode('fact', { subject: 's', predicate: 'p', object: 'o' });
    const updated = await graph.createNode('fact', { subject: 's2', predicate: 'p', object: 'o2' });
    await graph.updateNode(updated.id, { content: { subject: 's2', predicate: 'p', object: 'o2+' } });

    const hits = await storage.listNodes({ updatedBy: 'author-A' });
    expect(hits.map((n) => n.id)).toEqual([updated.id]);
    expect(await storage.listNodes({ updatedBy: 'nobody' })).toHaveLength(0);
    expect((await storage.listNodes({})).map((n) => n.id)).toContain(fresh.id);
  });

  it('deletedBy 过滤', async () => {
    const kept = await graph.createNode('fact', { subject: 's', predicate: 'p', object: 'o' });
    const doomed = await graph.createNode('fact', { subject: 's2', predicate: 'p', object: 'o2' });
    await graph.deleteNode(doomed.id);

    const hits = await storage.listNodes({ deletedBy: 'author-A' });
    expect(hits.map((n) => n.id)).toEqual([doomed.id]);
    expect(hits.map((n) => n.id)).not.toContain(kept.id);
  });

  it('fromTime/toTime 按 createdAt 时间窗过滤', async () => {
    const node = await graph.createNode('fact', { subject: 's', predicate: 'p', object: 'o' });
    const t = node.createdAt;

    expect((await storage.listNodes({ fromTime: t })).map((n) => n.id)).toContain(node.id);
    expect((await storage.listNodes({ toTime: t })).map((n) => n.id)).toContain(node.id);
    expect(await storage.listNodes({ fromTime: t + 1 })).toHaveLength(0);
    expect(await storage.listNodes({ toTime: t - 1 })).toHaveLength(0);
  });
});
