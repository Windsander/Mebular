// MemoryStorage 测试

import { describe, it, expect } from '@jest/globals';
import { MemoryStorage } from '../../src/storage/MemoryStorage';
import type { Node } from '../../src/types/index';

describe('MemoryStorage', () => {
  it('should store and retrieve a node', async () => {
    const storage = new MemoryStorage();
    const now = Date.now();
    const node: Node = {
      id: 'n1',
      type: 'fact',
      content: 'test content',
      createdBy: 'author1',
      signature: '',
      createdAt: now,
      updatedAt: now,
      labels: ['test'],
      validFrom: now,
      validTo: now + 1000,
      notes: 'test node',
    };

    await storage.putNode(node);
    const retrieved = await storage.getNode('n1');
    expect(retrieved).toBeDefined();
    expect(retrieved?.id).toBe('n1');
    expect(retrieved?.type).toBe('fact');
  });

  it('should delete a node', async () => {
    const storage = new MemoryStorage();
    const now = Date.now();
    await storage.putNode({
      id: 'del',
      type: 'fact',
      content: 'to be deleted',
      createdBy: 'author1',
      signature: '',
      createdAt: now,
      updatedAt: now,
      labels: [],
      validFrom: now,
      validTo: now + 1000,
    } as Node);
    await storage.deleteNode('del');
    const result = await storage.getNode('del');
    expect(result).toBeNull();
  });

  it('should list nodes by type', async () => {
    const storage = new MemoryStorage();
    const now = Date.now();
    await storage.putNode({
      id: 'n1',
      type: 'fact',
      content: 'fact content',
      createdBy: 'author1',
      signature: '',
      createdAt: now,
      updatedAt: now,
      labels: [],
      validFrom: now,
      validTo: now + 1000,
    } as Node);
    await storage.putNode({
      id: 'n2',
      type: 'skill',
      content: 'skill content',
      createdBy: 'author1',
      signature: '',
      createdAt: now,
      updatedAt: now,
      labels: [],
      validFrom: now,
      validTo: now + 1000,
    } as Node);

    const nodes = await storage.listNodes({ type: 'fact' });
    expect(nodes.length).toBe(1);
    const firstNode = nodes[0];
    expect(firstNode).toBeDefined();
    expect(firstNode?.id).toBe('n1');
    expect(firstNode?.type).toBe('fact');
  });

  it('should handle concurrency', async () => {
    const storage = new MemoryStorage();
    const now = Date.now();
    const promises = Array.from({ length: 20 }, (_, i) => {
      const id = `node-${i}-${Math.random().toString(36).substring(7)}`;
      return storage.putNode({
        id,
        type: 'fact',
        content: `content-${i}`,
        createdBy: 'author1',
        signature: '',
        createdAt: now,
        updatedAt: now,
        labels: [],
        validFrom: now,
        validTo: now + 1000,
      } as Node);
    });

    await Promise.all(promises);
    const nodes = await storage.listNodes({});
    expect(nodes.length).toBe(20);
  });

  it('should close cleanly', async () => {
    const storage = new MemoryStorage();
    await storage.close();
    // No error expected
  });
});
