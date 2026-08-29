// applyRemoteEvent 分支补强（Phase 6.2）：边事件全路径 + 节点 stale/duplicate
// 与并发裁决分支。所有断言锚定确定性收敛语义（phase-3-plan 3.3 / D21）。

import { describe, it, expect, beforeEach } from '@jest/globals';
import { MemoryStorage } from '../../src/storage/MemoryStorage.js';
import { applyRemoteEvent } from '../../src/sync/apply.js';
import type { Event } from '../../src/types/event.js';
import type { Edge, Node } from '../../src/types/index.js';

function makeNode(id: string, clock: Record<string, number>, extra: Partial<Node> = {}): Node {
  return {
    id,
    type: 'fact',
    content: {},
    labels: [],
    createdBy: 'local',
    signature: '',
    createdAt: 100,
    updatedAt: 100,
    validFrom: 0,
    validTo: 9999999999999,
    tags: [],
    vectorClock: clock,
    ...extra,
  };
}

function makeEdge(id: string, clock: Record<string, number>, extra: Partial<Edge> = {}): Edge {
  return {
    id,
    type: 'edge',
    source: 'n1',
    target: 'n2',
    relation: 'knows',
    createdBy: 'local',
    signature: '',
    createdAt: 100,
    updatedAt: 100,
    labels: [],
    validFrom: 0,
    validTo: 9999999999999,
    vectorClock: clock,
    ...extra,
  };
}

function makeEvent(type: string, clock: Record<string, number>, data: Record<string, unknown>): Event {
  return { id: `ev-${type}-${JSON.stringify(clock)}`, type, timestamp: Date.now(), vectorClock: clock, data, author: 'remote', signature: 'sig' };
}

describe('apply 分支补强：边事件', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
  });

  it('edge_created：本地已有且事件时钟 greater → 覆盖应用', async () => {
    await storage.putEdge(makeEdge('e1', { A: 1 }));
    const remote = makeEdge('e1', { A: 2 }, { relation: 'likes', updatedAt: 200 });
    const result = await applyRemoteEvent(storage, makeEvent('edge_created', { A: 2 }, { edge: remote }));
    expect(result.status).toBe('applied');
    expect((await storage.getEdge('e1'))?.relation).toBe('likes');
  });

  it('edge_created：时钟 equal/less → duplicate/stale 不覆盖', async () => {
    await storage.putEdge(makeEdge('e1', { A: 2 }));
    const dup = await applyRemoteEvent(storage, makeEvent('edge_created', { A: 2 }, { edge: makeEdge('e1', { A: 2 }) }));
    expect(dup.status).toBe('duplicate');
    const stale = await applyRemoteEvent(storage, makeEvent('edge_created', { A: 1 }, { edge: makeEdge('e1', { A: 1 }) }));
    expect(stale.status).toBe('stale');
    expect((await storage.getEdge('e1'))?.updatedAt).toBe(100);
  });

  it('edge_created：并发冲突按 LWW 确定性裁决（远端 updatedAt 新者胜）', async () => {
    await storage.putEdge(makeEdge('e1', { A: 2 }, { updatedAt: 100 }));
    const remote = makeEdge('e1', { A: 1, B: 1 }, { relation: 'likes', updatedAt: 200, createdBy: 'remote' });
    const result = await applyRemoteEvent(storage, makeEvent('edge_created', { A: 1, B: 1 }, { edge: remote }));
    expect(result.status).toBe('applied');
    expect(result.conflict?.edgeId).toBe('e1');
    expect((await storage.getEdge('e1'))?.relation).toBe('likes');
  });

  it('edge_updated：本地缺失修复性应用；greater 覆盖；equal/less 跳过', async () => {
    const missing = await applyRemoteEvent(storage, makeEvent('edge_updated', { A: 1 }, { edgeId: 'e9', newVersion: makeEdge('e9', { A: 1 }) }));
    expect(missing.status).toBe('applied');

    await storage.putEdge(makeEdge('e1', { A: 1 }));
    const greater = await applyRemoteEvent(storage, makeEvent('edge_updated', { A: 2 }, { edgeId: 'e1', newVersion: makeEdge('e1', { A: 2 }, { relation: 'hates' }) }));
    expect(greater.status).toBe('applied');
    expect((await storage.getEdge('e1'))?.relation).toBe('hates');

    const equal = await applyRemoteEvent(storage, makeEvent('edge_updated', { A: 2 }, { edgeId: 'e1', newVersion: makeEdge('e1', { A: 2 }) }));
    expect(equal.status).toBe('duplicate');
    const less = await applyRemoteEvent(storage, makeEvent('edge_updated', { A: 1 }, { edgeId: 'e1', newVersion: makeEdge('e1', { A: 1 }) }));
    expect(less.status).toBe('stale');
  });

  it('edge_updated：并发冲突远端胜', async () => {
    await storage.putEdge(makeEdge('e1', { A: 2 }, { updatedAt: 100 }));
    const remote = makeEdge('e1', { B: 1 }, { relation: 'likes', updatedAt: 300, createdBy: 'remote' });
    const result = await applyRemoteEvent(storage, makeEvent('edge_updated', { B: 1 }, { edgeId: 'e1', newVersion: remote }));
    expect(result.status).toBe('applied');
    expect(result.conflict?.resolution).toBe('auto');
  });

  it('edge_deleted：本地缺失落墓碑；equal/less 跳过；并发删除优先带冲突', async () => {
    const tomb = await applyRemoteEvent(storage, makeEvent('edge_deleted', { A: 1 }, { edgeId: 'e8', deletionTime: 500 }));
    expect(tomb.status).toBe('applied');
    expect((await storage.getEdge('e8'))?.deletedAt).toBe(500);

    await storage.putEdge(makeEdge('e1', { A: 2 }));
    const dup = await applyRemoteEvent(storage, makeEvent('edge_deleted', { A: 2 }, { edgeId: 'e1', deletionTime: 500 }));
    expect(dup.status).toBe('duplicate');
    const stale = await applyRemoteEvent(storage, makeEvent('edge_deleted', { A: 1 }, { edgeId: 'e1', deletionTime: 400 }));
    expect(stale.status).toBe('stale');

    // 并发：本地更新与远端删除并发 → 删除优先，上报冲突
    const concurrent = await applyRemoteEvent(storage, makeEvent('edge_deleted', { A: 1, B: 1 }, { edgeId: 'e1', deletionTime: 600 }));
    expect(concurrent.status).toBe('applied');
    expect(concurrent.conflict?.edgeId).toBe('e1');
    expect((await storage.getEdge('e1'))?.deletedAt).toBe(600);
  });
});

describe('apply 分支补强：节点与标签残余分支', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
  });

  it('node_updated：greater 覆盖；equal/less 跳过', async () => {
    await storage.putNode(makeNode('n1', { A: 1 }));
    const greater = await applyRemoteEvent(storage, makeEvent('node_updated', { A: 2 }, { nodeId: 'n1', newVersion: makeNode('n1', { A: 2 }, { updatedAt: 200 }) }));
    expect(greater.status).toBe('applied');

    const equal = await applyRemoteEvent(storage, makeEvent('node_updated', { A: 2 }, { nodeId: 'n1', newVersion: makeNode('n1', { A: 2 }) }));
    expect(equal.status).toBe('duplicate');
    const less = await applyRemoteEvent(storage, makeEvent('node_updated', { A: 1 }, { nodeId: 'n1', newVersion: makeNode('n1', { A: 1 }) }));
    expect(less.status).toBe('stale');
  });

  it('node_created：并发本地墓碑 vs 远端创建 → 删除优先（本地胜）', async () => {
    await storage.putNode(makeNode('n1', { A: 2 }, { deletedAt: 300 }));
    const remote = makeNode('n1', { A: 1, B: 1 }, { updatedAt: 400, createdBy: 'remote' });
    const result = await applyRemoteEvent(storage, makeEvent('node_created', { A: 1, B: 1 }, { node: remote }));
    expect(result.status).toBe('stale');
    expect(result.conflict?.nodeId).toBe('n1');
    expect((await storage.getNode('n1'))?.deletedAt).toBe(300);
  });

  it('node_created：并发远端创建胜（updatedAt 较新）', async () => {
    await storage.putNode(makeNode('n1', { A: 2 }, { updatedAt: 100 }));
    const remote = makeNode('n1', { A: 1, B: 1 }, { updatedAt: 400, createdBy: 'remote', content: { v: 'new' } });
    const result = await applyRemoteEvent(storage, makeEvent('node_created', { A: 1, B: 1 }, { node: remote }));
    expect(result.status).toBe('applied');
    expect(result.conflict?.resolvedVersion).toBe(remote);
  });

  it('node_deleted：equal/less 跳过', async () => {
    await storage.putNode(makeNode('n1', { A: 2 }));
    const dup = await applyRemoteEvent(storage, makeEvent('node_deleted', { A: 2 }, { nodeId: 'n1', deletionTime: 500 }));
    expect(dup.status).toBe('duplicate');
    const stale = await applyRemoteEvent(storage, makeEvent('node_deleted', { A: 1 }, { nodeId: 'n1', deletionTime: 400 }));
    expect(stale.status).toBe('stale');
    expect((await storage.getNode('n1'))?.deletedAt).toBeUndefined();
  });

  it('tag_added：节点已持该标签 → duplicate（仅推进时钟）；节点缺失 → stale', async () => {
    await storage.putNode(makeNode('n1', { A: 1 }, { tags: ['x'] }));
    const dup = await applyRemoteEvent(storage, makeEvent('tag_added', { A: 2 }, { nodeId: 'n1', tag: 'x' }));
    expect(dup.status).toBe('duplicate');
    expect((await storage.getNode('n1'))?.vectorClock).toEqual({ A: 2 });

    const missing = await applyRemoteEvent(storage, makeEvent('tag_added', { A: 1 }, { nodeId: 'ghost', tag: 'x' }));
    expect(missing.status).toBe('stale');
  });

  it('tag_removed：节点缺失 → stale；墓碑 → stale；equal 时钟 → duplicate', async () => {
    const missing = await applyRemoteEvent(storage, makeEvent('tag_removed', { A: 1 }, { nodeId: 'ghost', tag: 'x' }));
    expect(missing.status).toBe('stale');

    await storage.putNode(makeNode('n1', { A: 1 }, { deletedAt: 300, tags: ['x'] }));
    const tomb = await applyRemoteEvent(storage, makeEvent('tag_removed', { A: 2 }, { nodeId: 'n1', tag: 'x' }));
    expect(tomb.status).toBe('stale');

    await storage.putNode(makeNode('n2', { A: 2 }, { tags: ['x'] }));
    const dup = await applyRemoteEvent(storage, makeEvent('tag_removed', { A: 2 }, { nodeId: 'n2', tag: 'x' }));
    expect(dup.status).toBe('duplicate');
  });

  it('未知事件类型前向兼容：不阻塞也不应用', async () => {
    const result = await applyRemoteEvent(storage, makeEvent('future_event', { A: 1 }, {}));
    expect(result.status).toBe('stale');
  });
});
