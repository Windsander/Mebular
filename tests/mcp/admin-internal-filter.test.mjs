// Console /admin/api/memories：Runtime 内部对象默认隐藏，includeInternal=1 才出现。

import { describe, it, expect } from '@jest/globals';
import { buildMemories } from '../../packages/mcp/src/admin.mjs';

describe('Console buildMemories 内部对象过滤', () => {
  const at = Date.UTC(2026, 9, 29, 12, 0, 0);
  const node = (id, type, extra = {}) => ({
    id,
    type,
    content: { content: id },
    createdAt: at,
    updatedAt: at,
    namespace: 'default',
    tags: [],
    ...extra,
  });

  const nodes = [
    node('fact-1', 'fact'),
    node('compact-1', 'compact', {
      metadata: { runtime: { schema: 1, kind: 'compact', internal: true } },
    }),
    node('self-1', 'self_record', {
      namespace: '__self__',
      metadata: { runtime: { schema: 1, kind: 'self_record', internal: true } },
    }),
    node('checkpoint-1', 'context_checkpoint', {
      namespace: '__checkpoint__',
      metadata: { runtime: { schema: 1, kind: 'context_checkpoint', internal: true } },
    }),
    node('raw-guard', 'fact', {
      namespace: '__raw__',
    }),
  ];

  const app = { storage: { listNodes: async () => nodes } };

  it('默认 total/rows 不含内部对象；includeInternal=1 时出现', async () => {
    const url = new URL('http://localhost/admin/api/memories');
    const plain = await buildMemories({ app, url });
    expect(plain.total).toBe(1);
    expect(plain.memories.map((entry) => entry.id)).toEqual(['fact-1']);
    expect(plain.includeInternal).toBe(false);

    const withInternal = new URL('http://localhost/admin/api/memories?includeInternal=1');
    const all = await buildMemories({ app, url: withInternal });
    expect(all.total).toBe(5);
    expect(all.memories.map((entry) => entry.id).sort()).toEqual(
      ['checkpoint-1', 'compact-1', 'fact-1', 'raw-guard', 'self-1'].sort(),
    );
    expect(all.includeInternal).toBe(true);
  });
});
