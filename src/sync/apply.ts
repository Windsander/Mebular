// 远端事件的冲突感知应用（phase-3-plan 3.3）
//
// 所有规则都是 (本地状态, 事件) 的纯函数，平局一律用确定性规则打破，
// 保证「同一事件流、任意接收顺序，双端最终状态一致」：
//
// 1. 向量时钟占优（greater）→ 直接应用；落后/相同 → 跳过；
// 2. 并发（concurrent）→ 冲突：
//    a. 删除优先于更新（删除语义不应被并发更新复活）；
//    b. 带时间有效性的事实：validFrom 较晚者胜（新事实作废旧事实）；
//    c. 其余走 LWW：updatedAt 较新者胜，平局按作者 ID 字典序大者胜；
// 3. 删除事件在目标缺失时也要落墓碑，防止乱序到达的创建事件复活数据；
// 4. 标签操作遵循同样的时钟纪律（落后/相同直接跳过，只推进时钟不改内容），
//    并发的增/删同一标签按 OR-set 语义「增优先」——删除方重发即可生效，
//    保证任意到达顺序下双端终态一致；时钟一律合并推进，绝不回退。

import type { StorageAdapter } from '../storage/StorageAdapter.js';
import type { Event } from '../types/event.js';
import type { Node, Edge } from '../types/index.js';
import { VectorClock } from './vectorclock/index.js';

/** 与 spec-004 的 SyncConflict 对齐；localEvent 以本地版本状态代替（实现侧无事件索引） */
export interface SyncConflict {
  eventType: string;
  nodeId?: string;
  edgeId?: string;
  localVersion?: Node | Edge | null;
  remoteEvent: Event;
  resolution: 'auto' | 'manual';
  resolvedVersion?: Node | Edge;
}

export interface ApplyResult {
  status: 'applied' | 'duplicate' | 'stale';
  conflict?: SyncConflict;
}

type Clock = Record<string, number>;

function compareClocks(a: Clock, b: Clock): 'less' | 'equal' | 'greater' | 'concurrent' {
  return VectorClock.fromJSON(a).compare(VectorClock.fromJSON(b));
}

/** LWW 决胜：updatedAt 较新者胜；平局按作者 ID 字典序大者胜（确定性） */
function pickWinner(
  local: { updatedAt?: number; createdBy?: string },
  remote: { updatedAt?: number; createdBy?: string },
): 'local' | 'remote' {
  const lt = local.updatedAt ?? 0;
  const rt = remote.updatedAt ?? 0;
  if (lt !== rt) return rt > lt ? 'remote' : 'local';
  return (remote.createdBy ?? '') > (local.createdBy ?? '') ? 'remote' : 'local';
}

interface Versioned {
  updatedAt?: number;
  createdBy?: string;
  validFrom?: number;
  deletedAt?: number;
}

/** 并发版本的确定性裁决：删除优先 > 时间窗口 > LWW */
function resolveConcurrent(local: Versioned, remote: Versioned): 'local' | 'remote' {
  const localDeleted = typeof local.deletedAt === 'number';
  const remoteDeleted = typeof remote.deletedAt === 'number';
  if (localDeleted !== remoteDeleted) {
    return remoteDeleted ? 'remote' : 'local';
  }

  const localFrom = local.validFrom ?? 0;
  const remoteFrom = remote.validFrom ?? 0;
  if (localFrom !== remoteFrom) {
    return remoteFrom > localFrom ? 'remote' : 'local';
  }

  return pickWinner(local, remote);
}

export async function applyRemoteEvent(storage: StorageAdapter, event: Event): Promise<ApplyResult> {
  switch (event.type) {
    case 'node_created':
      return applyNodeCreated(storage, event);
    case 'node_updated':
      return applyNodeUpdated(storage, event);
    case 'node_deleted':
      return applyNodeDeleted(storage, event);
    case 'edge_created':
      return applyEdgeCreated(storage, event);
    case 'edge_updated':
      return applyEdgeUpdated(storage, event);
    case 'edge_deleted':
      return applyEdgeDeleted(storage, event);
    case 'tag_added':
      return applyTagAdded(storage, event);
    case 'tag_removed':
      return applyTagRemoved(storage, event);
    default:
      // 未知事件类型不阻塞同步（前向兼容），但也不应用
      return { status: 'stale' };
  }
}

// ---------- 节点 ----------

async function applyNodeCreated(storage: StorageAdapter, event: Event): Promise<ApplyResult> {
  const node = event.data.node as Node;
  const local = await storage.getNode(node.id);

  if (!local) {
    await storage.putNode(withEventClock(node, event));
    return { status: 'applied' };
  }

  const cmp = compareClocks(event.vectorClock, local.vectorClock ?? {});
  if (cmp === 'greater') {
    await storage.putNode(withEventClock(node, event));
    return { status: 'applied' };
  }
  if (cmp === 'less' || cmp === 'equal') {
    return { status: cmp === 'equal' ? 'duplicate' : 'stale' };
  }

  // 并发：本地已有同 ID 节点（可能是我方的创建/墓碑）
  const winner = resolveConcurrent(local, node);
  const conflict: SyncConflict = {
    eventType: event.type,
    nodeId: node.id,
    localVersion: local,
    remoteEvent: event,
    resolution: 'auto',
    resolvedVersion: winner === 'remote' ? node : local,
  };
  if (winner === 'remote') {
    await storage.putNode(withEventClock(node, event));
  }
  return { status: winner === 'remote' ? 'applied' : 'stale', conflict };
}

async function applyNodeUpdated(storage: StorageAdapter, event: Event): Promise<ApplyResult> {
  const nodeId = event.data.nodeId as string;
  const newVersion = event.data.newVersion as Node;
  const local = await storage.getNode(nodeId);

  if (!local) {
    // 本地缺失：直接采用（修复性应用）
    await storage.putNode(withEventClock(newVersion, event));
    return { status: 'applied' };
  }

  const cmp = compareClocks(event.vectorClock, local.vectorClock ?? {});
  if (cmp === 'greater') {
    await storage.putNode(withEventClock(newVersion, event));
    return { status: 'applied' };
  }
  if (cmp === 'less' || cmp === 'equal') {
    return { status: cmp === 'equal' ? 'duplicate' : 'stale' };
  }

  const winner = resolveConcurrent(local, newVersion);
  const conflict: SyncConflict = {
    eventType: event.type,
    nodeId,
    localVersion: local,
    remoteEvent: event,
    resolution: 'auto',
    resolvedVersion: winner === 'remote' ? newVersion : local,
  };
  if (winner === 'remote') {
    await storage.putNode(withEventClock(newVersion, event));
  }
  return { status: winner === 'remote' ? 'applied' : 'stale', conflict };
}

async function applyNodeDeleted(storage: StorageAdapter, event: Event): Promise<ApplyResult> {
  const nodeId = event.data.nodeId as string;
  const deletionTime = event.data.deletionTime as number;
  const local = await storage.getNode(nodeId);

  if (!local) {
    // 墓碑：防止乱序到达的创建事件复活已删除数据
    await storage.putNode(makeNodeTombstone(nodeId, event, deletionTime));
    return { status: 'applied' };
  }

  const cmp = compareClocks(event.vectorClock, local.vectorClock ?? {});
  if (cmp === 'less' || cmp === 'equal') {
    return { status: cmp === 'equal' ? 'duplicate' : 'stale' };
  }

  const tombstone = markNodeDeleted(local, deletionTime, event.vectorClock);
  // 并发：删除优先（更新不应复活并发删除的数据）
  const conflict: SyncConflict | undefined = cmp === 'concurrent'
    ? {
        eventType: event.type,
        nodeId,
        localVersion: local,
        remoteEvent: event,
        resolution: 'auto',
        resolvedVersion: tombstone,
      }
    : undefined;

  await storage.putNode(tombstone);
  return { status: 'applied', conflict };
}

// ---------- 边 ----------

async function applyEdgeCreated(storage: StorageAdapter, event: Event): Promise<ApplyResult> {
  const edge = event.data.edge as Edge;
  const local = await storage.getEdge(edge.id);

  if (!local) {
    await storage.putEdge(withEventClock(edge, event));
    return { status: 'applied' };
  }

  const cmp = compareClocks(event.vectorClock, local.vectorClock ?? {});
  if (cmp === 'greater') {
    await storage.putEdge(withEventClock(edge, event));
    return { status: 'applied' };
  }
  if (cmp === 'less' || cmp === 'equal') {
    return { status: cmp === 'equal' ? 'duplicate' : 'stale' };
  }

  const winner = resolveConcurrent(local, edge);
  const conflict: SyncConflict = {
    eventType: event.type,
    edgeId: edge.id,
    localVersion: local,
    remoteEvent: event,
    resolution: 'auto',
    resolvedVersion: winner === 'remote' ? edge : local,
  };
  if (winner === 'remote') {
    await storage.putEdge(withEventClock(edge, event));
  }
  return { status: winner === 'remote' ? 'applied' : 'stale', conflict };
}

async function applyEdgeUpdated(storage: StorageAdapter, event: Event): Promise<ApplyResult> {
  const edgeId = event.data.edgeId as string;
  const newVersion = event.data.newVersion as Edge;
  const local = await storage.getEdge(edgeId);

  if (!local) {
    await storage.putEdge(withEventClock(newVersion, event));
    return { status: 'applied' };
  }

  const cmp = compareClocks(event.vectorClock, local.vectorClock ?? {});
  if (cmp === 'greater') {
    await storage.putEdge(withEventClock(newVersion, event));
    return { status: 'applied' };
  }
  if (cmp === 'less' || cmp === 'equal') {
    return { status: cmp === 'equal' ? 'duplicate' : 'stale' };
  }

  const winner = resolveConcurrent(local, newVersion);
  const conflict: SyncConflict = {
    eventType: event.type,
    edgeId,
    localVersion: local,
    remoteEvent: event,
    resolution: 'auto',
    resolvedVersion: winner === 'remote' ? newVersion : local,
  };
  if (winner === 'remote') {
    await storage.putEdge(withEventClock(newVersion, event));
  }
  return { status: winner === 'remote' ? 'applied' : 'stale', conflict };
}

async function applyEdgeDeleted(storage: StorageAdapter, event: Event): Promise<ApplyResult> {
  const edgeId = event.data.edgeId as string;
  const deletionTime = event.data.deletionTime as number;
  const local = await storage.getEdge(edgeId);

  if (!local) {
    await storage.putEdge(makeEdgeTombstone(edgeId, event, deletionTime));
    return { status: 'applied' };
  }

  const cmp = compareClocks(event.vectorClock, local.vectorClock ?? {});
  if (cmp === 'less' || cmp === 'equal') {
    return { status: cmp === 'equal' ? 'duplicate' : 'stale' };
  }

  const tombstone: Edge = {
    ...local,
    deletedAt: deletionTime,
    validTo: deletionTime,
    updatedAt: deletionTime,
    vectorClock: { ...event.vectorClock },
  };
  const conflict: SyncConflict | undefined = cmp === 'concurrent'
    ? {
        eventType: event.type,
        edgeId,
        localVersion: local,
        remoteEvent: event,
        resolution: 'auto',
        resolvedVersion: tombstone,
      }
    : undefined;

  await storage.putEdge(tombstone);
  return { status: 'applied', conflict };
}

// ---------- 标签 ----------

async function applyTagAdded(storage: StorageAdapter, event: Event): Promise<ApplyResult> {
  const nodeId = event.data.nodeId as string;
  const tag = event.data.tag as string;
  const local = await storage.getNode(nodeId);

  if (!local) {
    // 节点缺失时标签操作无处安放；节点创建事件携带全量标签，最终状态以创建/更新事件为准
    return { status: 'stale' };
  }
  if (local.deletedAt) {
    // 删除优先：不给墓碑补标签
    return { status: 'stale' };
  }

  // 时钟纪律：落后/相同的事件不改变内容，只推进时钟（防 stale 事件回退时钟）
  const cmp = compareClocks(event.vectorClock, local.vectorClock ?? {});
  if (cmp === 'less' || cmp === 'equal') {
    return { status: cmp === 'equal' ? 'duplicate' : 'stale' };
  }

  const merged = mergeEntityClock(local, event);
  const tags = local.tags ?? [];
  if (tags.includes(tag)) {
    // 已持有该标签：状态不变，仅推进因果前沿
    await storage.putNode({ ...local, clocks: { ...merged }, vectorClock: { ...merged } });
    return { status: 'duplicate' };
  }
  await storage.putNode({
    ...local,
    tags: [...tags, tag],
    clocks: { ...merged },
    vectorClock: { ...merged },
  });
  return { status: 'applied' };
}

async function applyTagRemoved(storage: StorageAdapter, event: Event): Promise<ApplyResult> {
  const nodeId = event.data.nodeId as string;
  const tag = event.data.tag as string;
  const local = await storage.getNode(nodeId);

  if (!local) {
    return { status: 'stale' };
  }
  if (local.deletedAt) {
    return { status: 'stale' };
  }

  const cmp = compareClocks(event.vectorClock, local.vectorClock ?? {});
  if (cmp === 'less' || cmp === 'equal') {
    return { status: cmp === 'equal' ? 'duplicate' : 'stale' };
  }

  const merged = mergeEntityClock(local, event);
  const tags = local.tags ?? [];
  if (!tags.includes(tag)) {
    // 本地已无该标签（可能从未见对应 add，或已被删）：推进时钟即可
    await storage.putNode({ ...local, clocks: { ...merged }, vectorClock: { ...merged } });
    return { status: 'duplicate' };
  }

  if (cmp === 'concurrent') {
    // OR-set 语义：并发的添加获胜，删除被击败——推进时钟、保留标签、上报冲突
    // （删除方可重发：因果在后的删除按 greater 路径正常生效）
    const resolved: Node = { ...local, clocks: { ...merged }, vectorClock: { ...merged } };
    await storage.putNode(resolved);
    return {
      status: 'stale',
      conflict: {
        eventType: event.type,
        nodeId,
        localVersion: local,
        remoteEvent: event,
        resolution: 'auto',
        resolvedVersion: resolved,
      },
    };
  }

  // greater：因果在后的删除正常生效
  await storage.putNode({
    ...local,
    tags: tags.filter((t) => t !== tag),
    clocks: { ...merged },
    vectorClock: { ...merged },
  });
  return { status: 'applied' };
}

// ---------- 工具 ----------

function withEventClock<T extends Node | Edge>(entity: T, event: Event): T {
  return { ...entity, clocks: { ...event.vectorClock }, vectorClock: { ...event.vectorClock } };
}

/** 因果前沿合并推进（标签操作用）：取本地与事件时钟的逐作者最大值，绝不回退 */
function mergeEntityClock(entity: Node | Edge, event: Event): Clock {
  const merged = VectorClock.fromJSON((entity.vectorClock ?? {}) as Clock);
  merged.merge(VectorClock.fromJSON(event.vectorClock ?? {}));
  return merged.toJSON();
}

function markNodeDeleted(node: Node, deletionTime: number, clock: Clock): Node {
  return {
    ...node,
    deletedAt: deletionTime,
    validTo: deletionTime,
    updatedAt: deletionTime,
    vectorClock: { ...clock },
  };
}

function makeNodeTombstone(nodeId: string, event: Event, deletionTime: number): Node {
  return {
    id: nodeId,
    type: 'tombstone',
    content: {},
    labels: [],
    createdBy: event.author,
    signature: '',
    createdAt: deletionTime,
    updatedAt: deletionTime,
    validFrom: 0,
    validTo: deletionTime,
    deletedAt: deletionTime,
    tags: [],
    vectorClock: { ...event.vectorClock },
  };
}

function makeEdgeTombstone(edgeId: string, event: Event, deletionTime: number): Edge {
  return {
    id: edgeId,
    type: 'tombstone',
    source: '',
    target: '',
    relation: 'tombstone',
    createdBy: event.author,
    signature: '',
    createdAt: deletionTime,
    updatedAt: deletionTime,
    labels: [],
    validFrom: 0,
    validTo: deletionTime,
    deletedAt: deletionTime,
    vectorClock: { ...event.vectorClock },
  };
}
