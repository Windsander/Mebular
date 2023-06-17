// 内存存储实现

import type { StorageAdapter, NodeFilter, EdgeFilter, EventFilter, StorageSnapshot } from './StorageAdapter.js';
import type { Node, Edge, Event } from '../types/index.js';
import { ulid } from 'ulid';

export class MemoryStorage implements StorageAdapter {
  private nodes = new Map<string, Node>();
  private edges = new Map<string, Edge>();
  private events: Event[] = [];
  private latestClock: Record<string, number> = {};
  private closed = false;

  async putNode(node: Node): Promise<void> {
    if (this.closed) throw new Error('Storage closed');
    this.nodes.set(node.id, node);
  }

  async getNode(id: string): Promise<Node | null> {
    if (this.closed) throw new Error('Storage closed');
    return this.nodes.get(id) ?? null;
  }

  async deleteNode(id: string): Promise<void> {
    if (this.closed) throw new Error('Storage closed');
    this.nodes.delete(id);
  }

  async listNodes(filter?: NodeFilter): Promise<Node[]> {
    if (this.closed) throw new Error('Storage closed');
    let result = Array.from(this.nodes.values());

    if (filter) {
      if (filter.type) {
        result = result.filter(n => n.type === filter.type);
      }
      if (filter.author) {
        result = result.filter(n => n.author === filter.author);
      }
      if (filter.fromTime) {
        result = result.filter(n => {
          const vf = n.validFromBigInt || BigInt(n.validFrom || 0);
          return vf >= BigInt(filter.fromTime);
        });
      }
      if (filter.toTime) {
        result = result.filter(n => {
          const vt = n.validToBigInt || n.validTo ? BigInt(n.validTo) : BigInt('9999999999999');
          return vt <= BigInt(filter.toTime);
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
    if (this.closed) throw new Error('Storage closed');
    this.edges.set(edge.id, edge);
  }

  async getEdge(id: string): Promise<Edge | null> {
    if (this.closed) throw new Error('Storage closed');
    return this.edges.get(id) ?? null;
  }

  async deleteEdge(id: string): Promise<void> {
    if (this.closed) throw new Error('Storage closed');
    this.edges.delete(id);
  }

  async listEdges(filter?: EdgeFilter): Promise<Edge[]> {
    if (this.closed) throw new Error('Storage closed');
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
    if (this.closed) throw new Error('Storage closed');
    if (!event.id) {
      event.id = ulid();
    }
    this.events.push(event);

    const clocks = event.vectorClock.clocks;
    if (clocks[event.author]) {
      this.latestClock[event.author] = Math.max(this.latestClock[event.author] || 0, clocks[event.author]);
    }
  }

  async getEvent(id: string): Promise<Event | null> {
    if (this.closed) throw new Error('Storage closed');
    return this.events.find(e => e.id === id) ?? null;
  }

  async deleteEvent(id: string): Promise<void> {
    if (this.closed) throw new Error('Storage closed');
    const idx = this.events.findIndex(e => e.id === id);
    if (idx !== -1) {
      this.events.splice(idx, 1);
    }
  }

  async listEvents(filter?: EventFilter): Promise<Event[]> {
    if (this.closed) throw new Error('Storage closed');
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
      if (filter.fromTime) {
        result = result.filter(e => e.timestamp >= filter.fromTime!);
      }
      if (filter.toTime) {
        result = result.filter(e => e.timestamp <= filter.toTime!);
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
