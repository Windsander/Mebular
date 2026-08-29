// 内存存储实现

import type { StorageAdapter, NodeFilter, EdgeFilter, EventFilter } from './StorageAdapter.js';
import type { Node, Edge, Event } from '../types/index.js';
import { ErrorCodes, StorageError } from '../errors.js';
import { ulid } from 'ulid';

export class MemoryStorage implements StorageAdapter {
  private nodes = new Map<string, Node>();
  private edges = new Map<string, Edge>();
  private events: Event[] = [];
  private latestClock: Record<string, number> = {};
  private closed = false;

  async putNode(node: Node): Promise<void> {
    if (this.closed) throw new StorageError('Storage closed', ErrorCodes.STORAGE_CLOSED);
    this.nodes.set(node.id, node);
  }

  async getNode(id: string): Promise<Node | null> {
    if (this.closed) throw new StorageError('Storage closed', ErrorCodes.STORAGE_CLOSED);
    return this.nodes.get(id) ?? null;
  }

  async deleteNode(id: string): Promise<void> {
    if (this.closed) throw new StorageError('Storage closed', ErrorCodes.STORAGE_CLOSED);
    this.nodes.delete(id);
  }

  async listNodes(filter?: NodeFilter): Promise<Node[]> {
    if (this.closed) throw new StorageError('Storage closed', ErrorCodes.STORAGE_CLOSED);
    let result = Array.from(this.nodes.values());

    if (filter) {
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
      if (filter.source) {
        result = result.filter(e => e.source === filter.source);
      }
      if (filter.target) {
        result = result.filter(e => e.target === filter.target);
      }
      if (filter.relation) {
        result = result.filter(e => e.relation === filter.relation);
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
    const idx = this.events.findIndex(e => e.id === id);
    if (idx !== -1) {
      this.events.splice(idx, 1);
    }
  }

  async listEvents(filter?: EventFilter): Promise<Event[]> {
    if (this.closed) throw new StorageError('Storage closed', ErrorCodes.STORAGE_CLOSED);
    let result = [...this.events];

    if (filter) {
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
