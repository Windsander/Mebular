// getTyped 墓碑排除回归测试（Phase 6.1）
//
// 缺陷：MemoryStore.get* 访问器不排除已删除节点，
//       与 listByType 默认过滤行为（includeDeleted=false）不一致。

import { describe, it, expect } from '@jest/globals';
import { GraphStore } from '../../src/core/GraphStore.js';
import { MemoryStorage } from '../../src/storage/MemoryStorage.js';
import { MemoryStore } from '../../src/memory/MemoryStore.js';

describe('get* 访问器墓碑排除', () => {
  it('已删除节点返回 null；includeDeleted 显式查询仍可取回墓碑', async () => {
    const memory = new MemoryStore(new GraphStore({ storage: new MemoryStorage(), author: 'test' }));
    const fact = await memory.addFact({ subject: 'a', predicate: 'b', object: 'c' });

    await memory.getGraph().deleteNode(fact.id);

    expect(await memory.getFact(fact.id)).toBeNull();
    const tombstones = await memory.listByType('fact', { includeDeleted: true });
    expect(tombstones.map((n) => n.id)).toContain(fact.id);
  });
});
