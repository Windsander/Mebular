// applyRemoteEvent 冲突检测与确定性收敛测试（phase-3-plan 3.3）
//
// 核心承诺：「同一事件流、任意接收顺序，双端最终状态一致」——
// 时钟占优直接用；并发时删除优先 > validFrom 时间窗口 > LWW（平局作者 ID 决胜）；
// 删除对缺失目标落墓碑，防止乱序创建事件复活数据。

import { describe, it, expect, beforeEach } from '@jest/globals';
import { applyRemoteEvent } from '../../src/sync/apply.js';
import { MemoryStorage } from '../../src/storage/MemoryStorage.js';
import type { Event } from '../../src/types/event.js';
import type { Node } from '../../src/types/index.js';

let seq = 0;

function makeEvent(
  type: string,
  data: Record<string, unknown>,
  author: string,
  clock: Record<string, number>,
  timestamp = 1000,
): Event {
  seq += 1;
  return {
    id: `test-${seq}`,
    type,
    timestamp,
    vectorClock: clock,
    data,
    author,
    signature: '',
  };
}

function makeNode(id: string, overrides: Partial<Node> = {}): Node {
  return {
    id,
    type: 'fact',
    content: { text: `v-${id}` },
    labels: [],
    createdBy: 'device-A',
    signature: '',
    createdAt: 1000,
    updatedAt: 1000,
    validFrom: 1000,
    validTo: 9999999999999,
    tags: [],
    ...overrides,
  };
}

describe('applyRemoteEvent', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
  });

  it('乱序到达收敛：更新先于创建到达，最终状态与正序一致', async () => {
    const nodeV1 = makeNode('n1');
    const nodeV2 = makeNode('n1', { content: { text: 'v2' }, updatedAt: 2000 });
    const create = makeEvent('node_created', { node: nodeV1 }, 'device-B', { 'device-B': 1 });
    const update = makeEvent('node_updated', { nodeId: 'n1', newVersion: nodeV2 }, 'device-B', { 'device-B': 2 });

    // 乱序：更新先到（本地缺失，修复性应用），创建后到（时钟落后 → stale）
    expect((await applyRemoteEvent(storage, update)).status).toBe('applied');
    expect((await applyRemoteEvent(storage, create)).status).toBe('stale');
    expect((await storage.getNode('n1'))?.content).toEqual({ text: 'v2' });
  });

  it('时钟相等判重：重复事件返回 duplicate', async () => {
    const node = makeNode('n1');
    await storage.putNode({ ...node, vectorClock: { 'device-B': 1 } });
    const create = makeEvent('node_created', { node }, 'device-B', { 'device-B': 1 });
    expect((await applyRemoteEvent(storage, create)).status).toBe('duplicate');
  });

  it('并发更新走 LWW：updatedAt 较新者胜，双端裁决一致', async () => {
    // 本地：device-A 的 v-local（updatedAt 2000，时钟 {A:1}）
    const local = makeNode('n1', { content: { text: 'v-local' }, updatedAt: 2000, vectorClock: { 'device-A': 1 } });
    await storage.putNode(local);

    // 远端并发：device-B 的 v-remote-newer（updatedAt 3000，时钟 {B:1}，与 {A:1} 并发）
    const remoteNewer = makeNode('n1', { content: { text: 'v-remote-newer' }, updatedAt: 3000, createdBy: 'device-B' });
    const event = makeEvent('node_updated', { nodeId: 'n1', newVersion: remoteNewer }, 'device-B', { 'device-B': 1 });

    const result = await applyRemoteEvent(storage, event);
    expect(result.status).toBe('applied');
    expect(result.conflict).toBeDefined();
    expect(result.conflict?.resolution).toBe('auto');
    expect((await storage.getNode('n1'))?.content).toEqual({ text: 'v-remote-newer' });

    // 反向场景：本地较新 → 远端落败，本地保持
    const storage2 = new MemoryStorage();
    await storage2.putNode(makeNode('n1', { content: { text: 'v-local-newer' }, updatedAt: 4000, vectorClock: { 'device-A': 1 } }));
    const result2 = await applyRemoteEvent(storage2, event);
    expect(result2.status).toBe('stale');
    expect(result2.conflict).toBeDefined();
    expect((await storage2.getNode('n1'))?.content).toEqual({ text: 'v-local-newer' });
  });

  it('LWW 平局按作者 ID 字典序大者胜（确定性）', async () => {
    const local = makeNode('n1', { content: { text: 'local' }, updatedAt: 2000, createdBy: 'device-A', vectorClock: { 'device-A': 1 } });
    await storage.putNode(local);
    const remote = makeNode('n1', { content: { text: 'remote' }, updatedAt: 2000, createdBy: 'device-Z' });
    const event = makeEvent('node_updated', { nodeId: 'n1', newVersion: remote }, 'device-Z', { 'device-Z': 1 });

    const result = await applyRemoteEvent(storage, event);
    expect(result.status).toBe('applied');
    expect((await storage.getNode('n1'))?.content).toEqual({ text: 'remote' });
  });

  it('并发更新遇删除：删除优先，记录冲突', async () => {
    const local = makeNode('n1', { updatedAt: 2000, vectorClock: { 'device-A': 1 } });
    await storage.putNode(local);

    const deletion = makeEvent('node_deleted', { nodeId: 'n1', deletionTime: 3000 }, 'device-B', { 'device-B': 1 });
    const result = await applyRemoteEvent(storage, deletion);

    expect(result.status).toBe('applied');
    expect(result.conflict).toBeDefined();
    const stored = await storage.getNode('n1');
    expect(stored?.deletedAt).toBe(3000);
    expect(stored?.validTo).toBe(3000);
  });

  it('删除缺失目标落墓碑，乱序并发创建无法复活', async () => {
    // 删除先到达：本地无此节点 → 落墓碑
    const deletion = makeEvent('node_deleted', { nodeId: 'n1', deletionTime: 3000 }, 'device-B', { 'device-B': 2 });
    expect((await applyRemoteEvent(storage, deletion)).status).toBe('applied');
    const tombstone = await storage.getNode('n1');
    expect(tombstone?.deletedAt).toBe(3000);
    expect(tombstone?.type).toBe('tombstone');

    // 并发的创建随后到达（时钟不含 B:2）→ 墓碑保留
    const create = makeEvent('node_created', { node: makeNode('n1') }, 'device-A', { 'device-A': 1 });
    const result = await applyRemoteEvent(storage, create);
    expect(result.status).toBe('stale');
    expect(result.conflict).toBeDefined();
    expect((await storage.getNode('n1'))?.deletedAt).toBe(3000);
  });

  it('因果上晚于删除的创建可以复活（时钟占优）', async () => {
    const deletion = makeEvent('node_deleted', { nodeId: 'n1', deletionTime: 3000 }, 'device-B', { 'device-B': 2 });
    await applyRemoteEvent(storage, deletion);

    // 创建事件的时钟包含删除（{B:2, A:1} ⊃ {B:2}）→ 因果更晚 → 应用
    const recreated = makeNode('n1', { content: { text: 'reborn' }, updatedAt: 4000 });
    const create = makeEvent('node_created', { node: recreated }, 'device-A', { 'device-B': 2, 'device-A': 1 });
    const result = await applyRemoteEvent(storage, create);
    expect(result.status).toBe('applied');
    const stored = await storage.getNode('n1');
    expect(stored?.content).toEqual({ text: 'reborn' });
    expect(stored?.deletedAt).toBeUndefined();
  });

  it('validFrom 时间窗口：并发时新事实作废旧事实', async () => {
    const local = makeNode('n1', { content: { text: 'old-fact' }, validFrom: 1000, updatedAt: 2000, vectorClock: { 'device-A': 1 } });
    await storage.putNode(local);

    // 远端并发更新：validFrom 更晚（新事实），即便 updatedAt 较旧也应胜出
    const remote = makeNode('n1', { content: { text: 'new-fact' }, validFrom: 5000, updatedAt: 1500, createdBy: 'device-B' });
    const event = makeEvent('node_updated', { nodeId: 'n1', newVersion: remote }, 'device-B', { 'device-B': 1 });

    const result = await applyRemoteEvent(storage, event);
    expect(result.status).toBe('applied');
    expect(result.conflict).toBeDefined();
    expect((await storage.getNode('n1'))?.content).toEqual({ text: 'new-fact' });
  });

  it('标签增删幂等；并发增删同标签删除优先', async () => {
    await storage.putNode(makeNode('n1', { tags: ['keep'], vectorClock: { 'device-A': 1 } }));

    // 增标签幂等
    const add = makeEvent('tag_added', { nodeId: 'n1', tag: 'x' }, 'device-B', { 'device-B': 1 });
    expect((await applyRemoteEvent(storage, add)).status).toBe('applied');
    expect((await applyRemoteEvent(storage, add)).status).toBe('duplicate');
    expect((await storage.getNode('n1'))?.tags).toEqual(['keep', 'x']);

    // 并发删标签：本地时钟 {A:1}（落后事件时钟 {B:1}? 不并发）→ 直接应用；
    // 重放到已删除状态 → duplicate
    const remove = makeEvent('tag_removed', { nodeId: 'n1', tag: 'x' }, 'device-B', { 'device-B': 2 });
    expect((await applyRemoteEvent(storage, remove)).status).toBe('applied');
    expect((await applyRemoteEvent(storage, remove)).status).toBe('duplicate');
    expect((await storage.getNode('n1'))?.tags).toEqual(['keep']);
  });

  it('缺失节点的更新事件修复性应用，标签事件则跳过', async () => {
    const update = makeEvent('node_updated', { nodeId: 'ghost', newVersion: makeNode('ghost') }, 'device-B', { 'device-B': 1 });
    expect((await applyRemoteEvent(storage, update)).status).toBe('applied');
    expect(await storage.getNode('ghost')).not.toBeNull();

    const tag = makeEvent('tag_added', { nodeId: 'ghost2', tag: 'x' }, 'device-B', { 'device-B': 2 });
    expect((await applyRemoteEvent(storage, tag)).status).toBe('stale');
    expect(await storage.getNode('ghost2')).toBeNull();
  });

  it('边的创建/删除与节点同构收敛', async () => {
    const edge = {
      id: 'e1', type: 'edge', source: 'n1', target: 'n2', relation: 'knows',
      createdBy: 'device-B', signature: '', createdAt: 1000, updatedAt: 1000, labels: [],
    };
    const create = makeEvent('edge_created', { edge }, 'device-B', { 'device-B': 1 });
    expect((await applyRemoteEvent(storage, create)).status).toBe('applied');
    expect((await storage.getEdge('e1'))?.relation).toBe('knows');

    const deletion = makeEvent('edge_deleted', { edgeId: 'e1', deletionTime: 2000 }, 'device-B', { 'device-B': 2 });
    expect((await applyRemoteEvent(storage, deletion)).status).toBe('applied');
    expect((await storage.getEdge('e1'))?.deletedAt).toBe(2000);
  });

  it('未知事件类型不阻塞同步（前向兼容）', async () => {
    const future = makeEvent('future_operation', { whatever: 1 }, 'device-B', { 'device-B': 9 });
    expect((await applyRemoteEvent(storage, future)).status).toBe('stale');
  });
});
