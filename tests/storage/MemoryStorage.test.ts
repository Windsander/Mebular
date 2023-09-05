// MemoryStorage 测试

import { describe, it, expect } from '@jest/globals';
import { MemoryStorage } from '../../src/storage/MemoryStorage.js';

describe('MemoryStorage', () => {
  it('should store and retrieve a node', async () => {
    const storage = new MemoryStorage();
    const node = { id: 'n1', type: 'fact', content: 'test', ...s: [], vf: 1000n, vt: 2000n, author: 'a', sig: 's' };

    await storage.putNode(node);
    const retrieved = await storage.getNode('n1');
    expect(retrieved).toEqual(node);
  });

  it('should delete a node', async () => {
    const storage = new MemoryStorage();
    await storage.putNode({ id: 'del', type: 'fact', content: 'x', labels: [], validFrom: 1000n, validTo: 2000n, author: 'a', signature: 's' });
    await storage.deleteNode('del');
    const result = await storage.getNode('del');
    expect(result).toBeNull();
  });

  it('should list nodes by type', async () => {
    const storage = new MemoryStorage();
    await storage.putNode({ id: 'n1', type: 'fact', content: 'c1', labels: [], validFrom: 1000n, validTo: 2000n, author: 'a', signature: 's' });
    await storage.putNode({ id: 'n2', type: 'skill', content: 'c2', labels: [], validFrom: 1000n, validTo: 2000n, author: 'a', signature: 's' });

    const nodes = await storage.listNodes({ type: 'fact' });
    expect(nodes).toHaveLength(1);
    expect(nodes[0].id).toBe('n1');
  });

  it('should handle concurrency', async () => {
    const storage = new MemoryStorage();
    const promises = Array.from({ length: 20 }, () => {
      const id = Math.random().toString(36).substring(7);
      return storage.putNode({ id, type: 'fact', content: id, labels: [], validFrom: Date.now(), validTo: Date.now() + 1000, author: 'a', signature: 's' });
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
