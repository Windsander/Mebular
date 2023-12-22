// 集成测试：GraphStore + MemoryStorage

import { describe, it, expect } from '@jest/globals';
import { GraphStore } from '../../src/core/GraphStore';
import { MemoryStorage } from '../../src/storage/MemoryStorage';

describe('GraphStore Integration', () => {
  it('should create and retrieve a node', async () => {
    const storage = new MemoryStorage();
    const graphStore = new GraphStore({
      storage,
      author: 'test-author',
    });

    const node = await graphStore.createNode('fact', { text: 'test content' }, ['test']);
    
    expect(node.id).toBeDefined();
    expect(node.type).toBe('fact');
    expect(node.content).toEqual({ text: 'test content' });
    expect(node.createdBy).toBe('test-author');
    expect(node.labels).toEqual(['test']);
    expect(node.clocks).toBeDefined();
    expect(node.vectorClock).toBeDefined();

    const retrieved = await graphStore.getNode(node.id);
    expect(retrieved).toBeDefined();
    expect(retrieved?.id).toBe(node.id);
  });

  it('should update a node', async () => {
    const storage = new MemoryStorage();
    const graphStore = new GraphStore({
      storage,
      author: 'test-author',
    });

    const node = await graphStore.createNode('fact', { text: 'original' });
    const updated = await graphStore.updateNode(node.id, { content: { text: 'updated' } });

    expect(updated).toBeDefined();
    expect(updated?.content).toEqual({ text: 'updated' });
    expect(updated?.updatedBy).toBe('test-author');
  });

  it('should delete a node', async () => {
    const storage = new MemoryStorage();
    const graphStore = new GraphStore({
      storage,
      author: 'test-author',
    });

    const node = await graphStore.createNode('fact', { text: 'to delete' });
    const deleted = await graphStore.deleteNode(node.id);

    expect(deleted).toBe(true);
    const retrieved = await graphStore.getNode(node.id);
    expect(retrieved).toBeDefined();
    expect(retrieved?.deletedAt).toBeDefined();
  });

  it('should create and retrieve an edge', async () => {
    const storage = new MemoryStorage();
    const graphStore = new GraphStore({
      storage,
      author: 'test-author',
    });

    const source = await graphStore.createNode('fact', { text: 'source' });
    const target = await graphStore.createNode('skill', { text: 'target' });
    const edge = await graphStore.createEdge(source.id, target.id, 'related-to');

    expect(edge.id).toBeDefined();
    expect(edge.source).toBe(source.id);
    expect(edge.target).toBe(target.id);
    expect(edge.relation).toBe('related-to');

    const retrieved = await graphStore.getEdge(edge.id);
    expect(retrieved).toBeDefined();
    expect(retrieved?.id).toBe(edge.id);
  });

  it('should list nodes by filter', async () => {
    const storage = new MemoryStorage();
    const graphStore = new GraphStore({
      storage,
      author: 'test-author',
    });

    await graphStore.createNode('fact', { text: 'fact1' });
    await graphStore.createNode('fact', { text: 'fact2' });
    await graphStore.createNode('skill', { text: 'skill1' });

    const facts = await graphStore.listNodes({ type: 'fact' });
    expect(facts.length).toBe(2);
    expect(facts.every(n => n.type === 'fact')).toBe(true);

    const skills = await graphStore.listNodes({ type: 'skill' });
    expect(skills.length).toBe(1);
    expect(skills[0]!.type).toBe('skill');
  });

  it('should list edges by filter', async () => {
    const storage = new MemoryStorage();
    const graphStore = new GraphStore({
      storage,
      author: 'test-author',
    });

    const a = await graphStore.createNode('fact', { text: 'a' });
    const b = await graphStore.createNode('fact', { text: 'b' });
    const c = await graphStore.createNode('fact', { text: 'c' });

    await graphStore.createEdge(a.id, b.id, 'related');
    await graphStore.createEdge(b.id, c.id, 'depends');

    const edges = await graphStore.listEdges({ relation: 'related' });
    expect(edges.length).toBe(1);
    expect(edges[0]!.relation).toBe('related');
  });

  it('should handle batch operations', async () => {
    const storage = new MemoryStorage();
    const graphStore = new GraphStore({
      storage,
      author: 'test-author',
    });

    const nodes = await graphStore.batchAddNodes([
      { type: 'fact', content: { text: 'n1' } },
      { type: 'fact', content: { text: 'n2' } },
      { type: 'skill', content: { text: 's1' } },
    ]);

    expect(nodes.length).toBe(3);
    expect(nodes.every(n => n.id !== undefined)).toBe(true);

    const edges = await graphStore.batchAddEdges([
      { source: nodes[0]!.id, target: nodes[1]!.id, relation: 'link1' },
      { source: nodes[1]!.id, target: nodes[2]!.id, relation: 'link2' },
    ]);

    expect(edges.length).toBe(2);
    expect(edges.every(e => e.id !== undefined)).toBe(true);
  });

  it('should get neighbors of a node', async () => {
    const storage = new MemoryStorage();
    const graphStore = new GraphStore({
      storage,
      author: 'test-author',
    });

    const center = await graphStore.createNode('fact', { text: 'center' });
    const left = await graphStore.createNode('fact', { text: 'left' });
    const right = await graphStore.createNode('fact', { text: 'right' });

    await graphStore.createEdge(left.id, center.id, 'left-to-center');
    await graphStore.createEdge(center.id, right.id, 'center-to-right');

    const incoming = await graphStore.getNeighbors(center.id, 'incoming');
    expect(incoming.length).toBe(1);
    const incomingEdge = incoming[0]!;
    expect(incomingEdge.source).toBe(left.id);

    const outgoing = await graphStore.getNeighbors(center.id, 'outgoing');
    expect(outgoing.length).toBe(1);
    const outgoingEdge = outgoing[0]!;
    expect(outgoingEdge.target).toBe(right.id);

    const all = await graphStore.getNeighbors(center.id, 'both');
    expect(all.length).toBe(2);
  });
});
