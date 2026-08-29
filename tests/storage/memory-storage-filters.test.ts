// MemoryStorage 过滤器四字段回归测试（Phase 6.1）
//
// 缺陷：listNodes 忽略 NodeFilter 的 updatedBy/deletedBy/fromTime/toTime。

import { describe, it, expect, beforeEach } from '@jest/globals';
import { GraphStore } from '../../src/core/GraphStore.js';
import { MemoryStorage } from '../../src/storage/MemoryStorage.js';
import type { Event } from '../../src/types/index.js';

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

// ---------- Phase 6.2 覆盖补强：过滤/分页/事件覆盖全路径 ----------

describe('MemoryStorage 全路径覆盖', () => {
  function makeEvent(id: string, author = 'author-A', timestamp = 1000): Event {
    return {
      id,
      type: 'node_created',
      timestamp,
      vectorClock: { [author]: 1 },
      data: {},
      author,
      signature: 'sig',
    };
  }

  it('listNodes：id/createdBy/author 过滤与 limit/offset 分页', async () => {
    const storage = new MemoryStorage();
    const graph = new GraphStore({ storage, author: 'author-A' });
    const n1 = await graph.createNode('fact', { subject: 'a', predicate: 'p', object: '1' });
    await graph.createNode('fact', { subject: 'b', predicate: 'p', object: '2' });
    await graph.createNode('entity', { name: 'E' });

    expect((await storage.listNodes({ id: n1.id })).map((n) => n.id)).toEqual([n1.id]);
    expect(await storage.listNodes({ createdBy: 'author-A' })).toHaveLength(3);
    expect(await storage.listNodes({ author: 'author-A' })).toHaveLength(3);
    expect(await storage.listNodes({ createdBy: 'nobody' })).toHaveLength(0);
    expect(await storage.listNodes({ limit: 2 })).toHaveLength(2);
    expect(await storage.listNodes({ limit: 1, offset: 2 })).toHaveLength(1);
    expect(await storage.listNodes({ offset: 1 })).toHaveLength(2);
  });

  it('listEdges：source/target/relation 过滤与分页', async () => {
    const storage = new MemoryStorage();
    const graph = new GraphStore({ storage, author: 'author-A' });
    const a = await graph.createNode('entity', { name: 'A' });
    const b = await graph.createNode('entity', { name: 'B' });
    const c = await graph.createNode('entity', { name: 'C' });
    const e1 = await graph.createEdge(a.id, b.id, 'knows');
    await graph.createEdge(b.id, c.id, 'likes');

    expect((await storage.listEdges({ id: e1.id })).map((e) => e.id)).toEqual([e1.id]);
    expect(await storage.listEdges({ source: a.id })).toHaveLength(1);
    expect(await storage.listEdges({ target: c.id })).toHaveLength(1);
    expect(await storage.listEdges({ relation: 'likes' })).toHaveLength(1);
    expect(await storage.listEdges({ limit: 1 })).toHaveLength(1);
    expect(await storage.listEdges({ offset: 1 })).toHaveLength(1);
    // getEdge / deleteEdge 直连路径
    expect((await storage.getEdge(e1.id))?.relation).toBe('knows');
    await storage.deleteEdge(e1.id);
    expect(await storage.getEdge(e1.id)).toBeNull();
  });

  it('putEvent：无 ID 自动分配；同 ID 覆盖而非重复追加', async () => {
    const storage = new MemoryStorage();
    const event = makeEvent('');
    await storage.putEvent(event);
    expect(event.id).not.toBe('');

    await storage.putEvent(makeEvent('ev-1'));
    const updated = { ...makeEvent('ev-1'), signature: 'sig2' };
    await storage.putEvent(updated);

    expect(await storage.listEvents({})).toHaveLength(2);
    expect((await storage.getEvent('ev-1'))?.signature).toBe('sig2');

    await storage.deleteEvent('ev-1');
    expect(await storage.getEvent('ev-1')).toBeNull();
  });

  it('listEvents：id/type/author/fromTime/toTime 过滤与分页', async () => {
    const storage = new MemoryStorage();
    await storage.putEvent(makeEvent('e1', 'author-A', 1000));
    await storage.putEvent({ ...makeEvent('e2', 'author-B', 2000), type: 'node_deleted' });
    await storage.putEvent(makeEvent('e3', 'author-A', 3000));

    expect((await storage.listEvents({ id: 'e2' })).map((e) => e.id)).toEqual(['e2']);
    expect((await storage.listEvents({ type: 'node_deleted' })).map((e) => e.id)).toEqual(['e2']);
    expect(await storage.listEvents({ author: 'author-A' })).toHaveLength(2);
    expect(await storage.listEvents({ fromTime: 1500 })).toHaveLength(2);
    expect(await storage.listEvents({ toTime: 2000 })).toHaveLength(2);
    expect(await storage.listEvents({ fromTime: 1500, toTime: 2500 })).toHaveLength(1);
    expect(await storage.listEvents({ limit: 2 })).toHaveLength(2);
    expect(await storage.listEvents({ limit: 1, offset: 1 })).toHaveLength(1);
    expect(await storage.listEvents({ offset: 2 })).toHaveLength(1);
  });

  it('关闭后所有访问诚实抛 STORAGE_CLOSED', async () => {
    const storage = new MemoryStorage();
    await storage.close();
    await expect(storage.getNode('x')).rejects.toThrow('Storage closed');
    await expect(storage.listEvents({})).rejects.toThrow('Storage closed');
  });
});
