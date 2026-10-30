// core 通用内部可见性：只认 metadata.internal 与保留 namespace。
//
// 这里刻意断言 core 不认识 compact / self_record / context_checkpoint 等
// Memory Runtime 类型名——原型内部对象必须显式写 metadata.internal=true。

import { describe, it, expect } from '@jest/globals';
import { filterInternalNodes, isInternalNode } from '../../src/memory/visibility.js';
import type { Node } from '../../src/types/index.js';

const base = {
  id: 'n1',
  type: 'fact',
  createdBy: 'device-a',
  signature: '',
  createdAt: 0,
  updatedAt: 0,
  namespace: 'default',
} as Node;

describe('core 通用 internal 可见性', () => {
  it('metadata.internal=true 或保留 namespace 视为内部', () => {
    expect(isInternalNode({ ...base, metadata: { internal: true } })).toBe(true);
    expect(isInternalNode({ ...base, namespace: '__raw__' })).toBe(true);
    expect(isInternalNode({ ...base, namespace: '__self__' })).toBe(true);
    expect(isInternalNode({ ...base, namespace: '__policy__' })).toBe(false);
    expect(isInternalNode(base)).toBe(false);
    expect(isInternalNode(null)).toBe(false);
  });

  it('core 不再按 runtime 类型名判定内部对象', () => {
    expect(isInternalNode({ ...base, type: 'compact' } as Node)).toBe(false);
    expect(isInternalNode({ ...base, type: 'self_record' } as Node)).toBe(false);
    expect(isInternalNode({ ...base, metadata: { runtime: { internal: true } } })).toBe(false);
  });

  it('filterInternalNodes 默认排除，includeInternal 显式包含', () => {
    const nodes = [
      { ...base, id: 'public' },
      { ...base, id: 'internal', metadata: { internal: true } },
      { ...base, id: 'reserved', namespace: '__checkpoint__' },
    ];
    expect(filterInternalNodes(nodes).map((node) => node.id)).toEqual(['public']);
    expect(filterInternalNodes(nodes, { includeInternal: true })).toHaveLength(3);
  });
});
