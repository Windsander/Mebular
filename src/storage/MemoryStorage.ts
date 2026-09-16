// 内存存储实现

import type { StorageAdapter, NodeFilter, EdgeFilter, EventFilter } from './StorageAdapter.js';
import type { Node, Edge, Event } from '../types/index.js';
import { ErrorCodes, StorageError } from '../errors.js';
import { matchesNamespace, normalizeNamespace, normalizeNamespaceList } from '../core/namespace.js';
import { ulid } from 'ulid';

/** namespace 过滤 → 归一化集合；undefined/空数组返回 null（= 不过滤） */
function namespaceFilterSet(filter: string | string[] | undefined): Set<string> | null {
  if (filter === undefined) return null;
  const list = Array.isArray(filter) ? normalizeNamespaceList(filter) : [normalizeNamespace(filter)];
  return list.length === 0 ? null : new Set(list);
}

export class MemoryStorage implements StorageAdapter {
  private nodes = new Map<string, Node>();
  private edges = new Map<string, Edge>();
  /**
   * 事件只增不减：listEvents 返回全部事件，deleteEvent 仅在显式调用时生效。
   * 保留策略约束（PLAN 1.5）：任何自动裁剪必须排除「尚未被所有已授权对端 ack
   * 的事件」，否则对端永久缺失该记忆（约束与测试见 SyncManager.getPendingEvents）。
   */
  private events: Event[] = [];
  private latestClock: Record<string, number> = {};
  private closed = false;

  /**
   * namespace 二级索引：ns → 实体 ID 集合。listNodes/listEvents 按分区过滤时
   * 先取候选集合再叠加其余条件，避免全表扫描。SqliteStorage 另有落盘索引。
   */
  private nodeNamespaces = new Map<string, Set<string>>();
  private eventNamespaces = new Map<string, Set<string>>();

  /** 维护节点分区索引（含分区变更时从旧分区移除） */
  private indexNodeNamespace(node: Node): void {
    const ns = normalizeNamespace(node.namespace);
    for (const [knownNs, ids] of this.nodeNamespaces) {
      if (knownNs !== ns) ids.delete(node.id);
    }
    let ids = this.nodeNamespaces.get(ns);
    if (!ids) {
      ids = new Set();
      this.nodeNamespaces.set(ns, ids);
    }
    ids.add(node.id);
  }

  private unindexNodeNamespace(id: string): void {
    for (const ids of this.nodeNamespaces.values()) {
      ids.delete(id);
    }
  }

  private indexEventNamespace(event: Event): void {
    const ns = normalizeNamespace(event.namespace);
    for (const [knownNs, ids] of this.eventNamespaces) {
      if (knownNs !== ns) ids.delete(event.id);
    }
    let ids = this.eventNamespaces.get(ns);
    if (!ids) {
      ids = new Set();
      this.eventNamespaces.set(ns, ids);
    }
    ids.add(event.id);
  }

  private unindexEventNamespace(id: string): void {
    for (const ids of this.eventNamespaces.values()) {
      ids.delete(id);
    }
  }

  async putNode(node: Node): Promise<void> {
    if (this.closed) throw new StorageError('Storage closed', ErrorCodes.STORAGE_CLOSED);
    this.indexNodeNamespace(node);
    this.nodes.set(node.id, node);
  }

  async getNode(id: string): Promise<Node | null> {
    if (this.closed) throw new StorageError('Storage closed', ErrorCodes.STORAGE_CLOSED);
    return this.nodes.get(id) ?? null;
  }

  async deleteNode(id: string): Promise<void> {
    if (this.closed) throw new StorageError('Storage closed', ErrorCodes.STORAGE_CLOSED);
    this.unindexNodeNamespace(id);
    this.nodes.delete(id);
  }

  async listNodes(filter?: NodeFilter): Promise<Node[]> {
    if (this.closed) throw new StorageError('Storage closed', ErrorCodes.STORAGE_CLOSED);
    let result = Array.from(this.nodes.values());

    if (filter) {
      const nsSet = namespaceFilterSet(filter.namespace);
      if (nsSet) {
        const ids = new Set<string>();
        for (const ns of nsSet) {
          for (const id of this.nodeNamespaces.get(ns) ?? []) ids.add(id);
        }
        result = result.filter(n => ids.has(n.id));
      }
      if (filter.id) {
        result = result.filter(n => n.id === filter.id);
      }
      if (filter.type) {
        result = result.filter(n => n.type === filter.type);
      }
      if (filter.tags?.length) {
        const tags = filter.tags;
        result = result.filter(n => tags.every(t => (n.tags ?? []).includes(t)));
      }
      if (filter.labels?.length) {
        const labels = filter.labels;
        result = result.filter(n => labels.every(l => (n.labels ?? []).includes(l)));
      }
      if (filter.createdBy) {
        result = result.filter(n => n.createdBy === filter.createdBy);
      }
      if (filter.author) {
        result = result.filter(n => n.createdBy === filter.author);
      }
      if (filter.updatedBy) {
        result = result.filter(n => n.updatedBy === filter.updatedBy);
      }
      if (filter.deletedBy) {
        result = result.filter(n => n.deletedBy === filter.deletedBy);
      }
      // fromTime/toTime 作用于 createdAt（与 EventFilter 作用于 timestamp 一致）
      if (filter.fromTime !== undefined) {
        const fromTime = filter.fromTime;
        result = result.filter(n => n.createdAt >= fromTime);
      }
      if (filter.toTime !== undefined) {
        const toTime = filter.toTime;
        result = result.filter(n => n.createdAt <= toTime);
      }
      if (filter.validFrom !== undefined) {
        const validFrom = filter.validFrom;
        result = result.filter(n => {
          const vf = n.validFrom ?? 0;
          return vf >= validFrom;
        });
      }
      if (filter.validTo !== undefined) {
        const validTo = filter.validTo;
        result = result.filter(n => {
          const vt = n.validTo ?? 9999999999999;
          return vt <= validTo;
        });
      }
      if (filter.limit) {
        result = result.slice(filter.offset ?? 0, (filter.offset ?? 0) + filter.limit);
      } else if (filter.offset) {
        result = result.slice(filter.offset);
      }
    }

    return result;
  }

  async putEdge(edge: Edge): Promise<void> {
    if (this.closed) throw new StorageError('Storage closed', ErrorCodes.STORAGE_CLOSED);
    this.edges.set(edge.id, edge);
  }

  async getEdge(id: string): Promise<Edge | null> {
    if (this.closed) throw new StorageError('Storage closed', ErrorCodes.STORAGE_CLOSED);
    return this.edges.get(id) ?? null;
  }

  async deleteEdge(id: string): Promise<void> {
    if (this.closed) throw new StorageError('Storage closed', ErrorCodes.STORAGE_CLOSED);
    this.edges.delete(id);
  }

  async listEdges(filter?: EdgeFilter): Promise<Edge[]> {
    if (this.closed) throw new StorageError('Storage closed', ErrorCodes.STORAGE_CLOSED);
    let result = Array.from(this.edges.values());

    if (filter) {
      if (filter.id) {
        result = result.filter(e => e.id === filter.id);
      }
      if (filter.source) {
        result = result.filter(e => e.source === filter.source);
      }
      if (filter.target) {
        result = result.filter(e => e.target === filter.target);
      }
      if (filter.relation) {
        result = result.filter(e => e.relation === filter.relation);
      }
      if (filter.namespace !== undefined) {
        const ns = filter.namespace;
        result = result.filter(e => matchesNamespace(e.namespace, ns));
      }
      if (filter.labels?.length) {
        const labels = filter.labels;
        result = result.filter(e => labels.every(l => (e.labels ?? []).includes(l)));
      }
      if (filter.limit) {
        result = result.slice(filter.offset ?? 0, (filter.offset ?? 0) + filter.limit);
      } else if (filter.offset) {
        result = result.slice(filter.offset);
      }
    }

    return result;
  }

  async putEvent(event: Event): Promise<void> {
    if (this.closed) throw new StorageError('Storage closed', ErrorCodes.STORAGE_CLOSED);
    if (!event.id) {
      event.id = ulid();
    }
    this.indexEventNamespace(event);
    // 幂等：同 ID 覆盖而非重复追加（同步重放/重传的前提）
    const existingIdx = this.events.findIndex(e => e.id === event.id);
    if (existingIdx !== -1) {
      this.events[existingIdx] = event;
    } else {
      this.events.push(event);
    }

    const clocks = event.vectorClock;
    if (clocks && event.author && event.author in clocks) {
      const clockVal = clocks[event.author];
      if (clockVal !== undefined) {
        this.latestClock[event.author] = Math.max(this.latestClock[event.author] || 0, clockVal);
      }
    }
  }

  async getEvent(id: string): Promise<Event | null> {
    if (this.closed) throw new StorageError('Storage closed', ErrorCodes.STORAGE_CLOSED);
    return this.events.find(e => e.id === id) ?? null;
  }

  async deleteEvent(id: string): Promise<void> {
    if (this.closed) throw new StorageError('Storage closed', ErrorCodes.STORAGE_CLOSED);
    this.unindexEventNamespace(id);
    const idx = this.events.findIndex(e => e.id === id);
    if (idx !== -1) {
      this.events.splice(idx, 1);
    }
  }

  async listEvents(filter?: EventFilter): Promise<Event[]> {
    if (this.closed) throw new StorageError('Storage closed', ErrorCodes.STORAGE_CLOSED);
    let result = [...this.events];

    if (filter) {
      const nsSet = namespaceFilterSet(filter.namespace);
      if (nsSet) {
        const ids = new Set<string>();
        for (const ns of nsSet) {
          for (const id of this.eventNamespaces.get(ns) ?? []) ids.add(id);
        }
        result = result.filter(e => ids.has(e.id));
      }
      if (filter.id) {
        result = result.filter(e => e.id === filter.id);
      }
      if (filter.type) {
        result = result.filter(e => e.type === filter.type);
      }
      if (filter.author) {
        result = result.filter(e => e.author === filter.author);
      }
      if (filter.fromTime !== undefined) {
        const fromTime = filter.fromTime;
        result = result.filter(e => e.timestamp >= fromTime);
      }
      if (filter.toTime !== undefined) {
        const toTime = filter.toTime;
        result = result.filter(e => e.timestamp <= toTime);
      }
      if (filter.limit) {
        result = result.slice(filter.offset ?? 0, (filter.offset ?? 0) + filter.limit);
      } else if (filter.offset) {
        result = result.slice(filter.offset);
      }
    }

    return result;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
