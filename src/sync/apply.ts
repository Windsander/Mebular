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
// 4. 标签操作幂等；并发的增/删同一标签 → 删优先，记录冲突。

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
  const tags = local.tags ?? [];
  if (tags.includes(tag)) {
    return { status: 'duplicate' };
  }
  await storage.putNode({ ...local, tags: [...tags, tag], vectorClock: { ...event.vectorClock } });
  return { status: 'applied' };
}

async function applyTagRemoved(storage: StorageAdapter, event: Event): Promise<ApplyResult> {
  const nodeId = event.data.nodeId as string;
  const tag = event.data.tag as string;
  const local = await storage.getNode(nodeId);

  if (!local) {
    return { status: 'stale' };
  }
  const tags = local.tags ?? [];
  if (!tags.includes(tag)) {
    return { status: 'duplicate' };
  }

  // 并发检测：本地有未被我方观测的并发操作时记录冲突（删除优先）
  const cmp = compareClocks(event.vectorClock, local.vectorClock ?? {});
  const conflict: SyncConflict | undefined = cmp === 'concurrent'
    ? {
        eventType: event.type,
        nodeId,
        localVersion: local,
        remoteEvent: event,
        resolution: 'auto',
        resolvedVersion: { ...local, tags: tags.filter((t) => t !== tag) },
      }
    : undefined;

  await storage.putNode({
    ...local,
    tags: tags.filter((t) => t !== tag),
    vectorClock: { ...event.vectorClock },
  });
  return { status: 'applied', conflict };
}

// ---------- 工具 ----------

function withEventClock<T extends Node | Edge>(entity: T, event: Event): T {
  return { ...entity, vectorClock: { ...event.vectorClock } };
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
