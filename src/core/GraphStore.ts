// GraphStore - 图存储核心实现

import type { StorageAdapter } from '../storage/StorageAdapter.js';
import type { Node, Edge, NodeFilter, EdgeFilter } from '../types/index.js';
import type { EventLog } from '../eventlog/EventLog.js';
import { VectorClock } from '../sync/index.js';
import { ulid } from 'ulid';

export interface GraphStoreConfig {
  storage: StorageAdapter;
  author: string;
  signatureManager?: any;
  /** 配置后，所有图变更自动写入带签名的事件日志（Phase 3 同步的前提） */
  eventLog?: EventLog;
}

export class GraphStore {
  private storage: StorageAdapter;
  private author: string;
  private clock: VectorClock;
  private signatureManager?: any;
  private eventLog?: EventLog;

  constructor(config: GraphStoreConfig) {
    this.storage = config.storage;
    this.author = config.author;
    this.clock = new VectorClock();
    this.signatureManager = config.signatureManager;
    this.eventLog = config.eventLog;
  }

  async createNode(type: string, content: Record<string, unknown>, labels?: string[]): Promise<Node> {
    const now = Date.now();
    const node: Node = {
      id: ulid(),
      type,
      content,
      labels: labels || [],
      createdBy: this.author,
      signature: '',
      createdAt: now,
      updatedAt: now,
      validFrom: now,
      validTo: 9999999999999,
      tags: [],
    };

    this.clock.increment(this.author);
    node.clocks = this.clock.toJSON();
    node.vectorClock = this.clock.toJSON();

    if (this.signatureManager) {
      node.signature = await this.signatureManager.sign(JSON.stringify(node));
    }

    // 单一时钟源（D10 收口）：事件日志存在时，实体时钟以事件时钟为准；
    // 载荷用快照拷贝，避免随后的时钟盖写突变已被内容寻址的事件内容
    if (this.eventLog) {
      const event = await this.eventLog.append({ type: 'node_created', data: { node: { ...node } } });
      node.clocks = { ...event.vectorClock };
      node.vectorClock = { ...event.vectorClock };
    }

    await this.storage.putNode(node);
    return node;
  }

  async updateNode(id: string, updates: Partial<Node>): Promise<Node | null> {
    const existing = await this.storage.getNode(id);
    if (!existing) {
      return null;
    }

    const now = Date.now();
    const updated = {
      ...existing,
      ...updates,
      id,
      updatedAt: now,
      updatedBy: this.author,
      createdAt: existing.createdAt,
      validFrom: existing.validFrom,
      validTo: existing.validTo,
      tags: existing.tags,
      vectorClock: this.clock.toJSON(),
    };

    this.clock.increment(this.author);
    updated.clocks = this.clock.toJSON();
    updated.vectorClock = this.clock.toJSON();

    if (this.signatureManager) {
      updated.signature = await this.signatureManager.sign(JSON.stringify(updated));
    }

    if (this.eventLog) {
      const event = await this.eventLog.append({
        type: 'node_updated',
        data: { nodeId: id, newVersion: { ...updated } },
      });
      updated.clocks = { ...event.vectorClock };
      updated.vectorClock = { ...event.vectorClock };
    }

    await this.storage.putNode(updated);
    return updated;
  }

  async deleteNode(id: string): Promise<boolean> {
    const existing = await this.storage.getNode(id);
    if (!existing) {
      return false;
    }

    const now = Date.now();
    const deleted = {
      ...existing,
      deletedAt: now,
      deletedBy: this.author,
      validTo: now,
      updatedAt: now,
    };

    this.clock.increment(this.author);
    deleted.clocks = this.clock.toJSON();
    deleted.vectorClock = this.clock.toJSON();

    if (this.signatureManager) {
      deleted.signature = await this.signatureManager.sign(JSON.stringify(deleted));
    }

    if (this.eventLog) {
      const event = await this.eventLog.append({ type: 'node_deleted', data: { nodeId: id, deletionTime: now } });
      deleted.clocks = { ...event.vectorClock };
      deleted.vectorClock = { ...event.vectorClock };
    }

    await this.storage.putNode(deleted);
    return true;
  }

  async getNode(id: string): Promise<Node | null> {
    return this.storage.getNode(id);
  }

  async listNodes(filter?: NodeFilter): Promise<Node[]> {
    return this.storage.listNodes(filter || {});
  }

  async createEdge(source: string, target: string, relation: string, labels?: string[]): Promise<Edge> {
    const now = Date.now();
    const edge: Edge = {
      id: ulid(),
      type: 'edge',
      source,
      target,
      relation,
      createdBy: this.author,
      signature: '',
      createdAt: now,
      updatedAt: now,
      labels: labels || [],
      validFrom: now,
      validTo: 9999999999999,
    };

    this.clock.increment(this.author);
    edge.clocks = this.clock.toJSON();
    edge.vectorClock = this.clock.toJSON();

    if (this.signatureManager) {
      edge.signature = await this.signatureManager.sign(JSON.stringify(edge));
    }

    if (this.eventLog) {
      const event = await this.eventLog.append({ type: 'edge_created', data: { edge: { ...edge } } });
      edge.clocks = { ...event.vectorClock };
      edge.vectorClock = { ...event.vectorClock };
    }

    await this.storage.putEdge(edge);
    return edge;
  }

  async updateEdge(id: string, updates: Partial<Edge>): Promise<Edge | null> {
    const existing = await this.storage.getEdge(id);
    if (!existing) {
      return null;
    }

    const now = Date.now();
    const updated = {
      ...existing,
      ...updates,
      id,
      updatedAt: now,
      updatedBy: this.author,
      createdAt: existing.createdAt,
      validFrom: existing.validFrom,
      validTo: existing.validTo,
      vectorClock: this.clock.toJSON(),
    };

    this.clock.increment(this.author);
    updated.clocks = this.clock.toJSON();
    updated.vectorClock = this.clock.toJSON();

    if (this.signatureManager) {
      updated.signature = await this.signatureManager.sign(JSON.stringify(updated));
    }

    if (this.eventLog) {
      const event = await this.eventLog.append({
        type: 'edge_updated',
        data: { edgeId: id, newVersion: { ...updated } },
      });
      updated.clocks = { ...event.vectorClock };
      updated.vectorClock = { ...event.vectorClock };
    }

    await this.storage.putEdge(updated);
    return updated;
  }

  async deleteEdge(id: string): Promise<boolean> {
    const existing = await this.storage.getEdge(id);
    if (!existing) {
      return false;
    }

    const now = Date.now();
    const deleted = {
      ...existing,
      deletedAt: now,
      deletedBy: this.author,
      validTo: now,
      updatedAt: now,
    };

    this.clock.increment(this.author);
    deleted.clocks = this.clock.toJSON();
    deleted.vectorClock = this.clock.toJSON();

    if (this.signatureManager) {
      deleted.signature = await this.signatureManager.sign(JSON.stringify(deleted));
    }

    if (this.eventLog) {
      const event = await this.eventLog.append({ type: 'edge_deleted', data: { edgeId: id, deletionTime: now } });
      deleted.clocks = { ...event.vectorClock };
      deleted.vectorClock = { ...event.vectorClock };
    }

    await this.storage.putEdge(deleted);
    return true;
  }

  /** 为节点添加标签（spec-003 AddTag；幂等） */
  async addTag(nodeId: string, tag: string): Promise<Node | null> {
    const existing = await this.storage.getNode(nodeId);
    if (!existing) {
      return null;
    }
    if ((existing.tags ?? []).includes(tag)) {
      return existing;
    }

    const now = Date.now();
    const updated: Node = {
      ...existing,
      tags: [...(existing.tags ?? []), tag],
      updatedAt: now,
      updatedBy: this.author,
    };

    this.clock.increment(this.author);
    updated.clocks = this.clock.toJSON();
    updated.vectorClock = this.clock.toJSON();

    if (this.signatureManager) {
      updated.signature = await this.signatureManager.sign(JSON.stringify(updated));
    }

    if (this.eventLog) {
      const event = await this.eventLog.append({ type: 'tag_added', data: { nodeId, tag } });
      updated.clocks = { ...event.vectorClock };
      updated.vectorClock = { ...event.vectorClock };
    }

    await this.storage.putNode(updated);
    return updated;
  }

  /** 移除节点标签（spec-003 RemoveTag；幂等） */
  async removeTag(nodeId: string, tag: string): Promise<Node | null> {
    const existing = await this.storage.getNode(nodeId);
    if (!existing) {
      return null;
    }
    if (!(existing.tags ?? []).includes(tag)) {
      return existing;
    }

    const now = Date.now();
    const updated: Node = {
      ...existing,
      tags: (existing.tags ?? []).filter((t) => t !== tag),
      updatedAt: now,
      updatedBy: this.author,
    };

    this.clock.increment(this.author);
    updated.clocks = this.clock.toJSON();
    updated.vectorClock = this.clock.toJSON();

    if (this.signatureManager) {
      updated.signature = await this.signatureManager.sign(JSON.stringify(updated));
    }

    if (this.eventLog) {
      const event = await this.eventLog.append({ type: 'tag_removed', data: { nodeId, tag } });
      updated.clocks = { ...event.vectorClock };
      updated.vectorClock = { ...event.vectorClock };
    }

    await this.storage.putNode(updated);
    return updated;
  }

  async getEdge(id: string): Promise<Edge | null> {
    return this.storage.getEdge(id);
  }

  async listEdges(filter?: EdgeFilter): Promise<Edge[]> {
    return this.storage.listEdges(filter || {});
  }

  async getNeighbors(nodeId: string, direction?: 'incoming' | 'outgoing' | 'both'): Promise<Edge[]> {
    const filter: EdgeFilter = { limit: 100 };
    if (direction === 'incoming') {
      filter.target = nodeId;
    } else if (direction === 'outgoing') {
      filter.source = nodeId;
    } else {
      const incoming = await this.storage.listEdges({ target: nodeId });
      const outgoing = await this.storage.listEdges({ source: nodeId });
      return [...incoming, ...outgoing];
    }
    return this.storage.listEdges(filter);
  }

  async batchAddNodes(nodes: Array<{ type: string; content: Record<string, unknown>; labels?: string[] }>): Promise<Node[]> {
    const created: Node[] = [];
    for (const nodeData of nodes) {
      const node = await this.createNode(nodeData.type, nodeData.content, nodeData.labels);
      created.push(node);
    }
    return created;
  }

  async batchAddEdges(edges: Array<{ source: string; target: string; relation: string; labels?: string[] }>): Promise<Edge[]> {
    const created: Edge[] = [];
    for (const edgeData of edges) {
      const edge = await this.createEdge(edgeData.source, edgeData.target, edgeData.relation, edgeData.labels);
      created.push(edge);
    }
    return created;
  }

  async snapshot(): Promise<{ nodes: Node[]; edges: Edge[]; clock: Record<string, number> }> {
    const nodes = await this.storage.listNodes({});
    const edges = await this.storage.listEdges({});
    return {
      nodes,
      edges,
      clock: this.clock.toJSON(),
    };
  }

  async merge(snapshot: { nodes: Node[]; edges: Edge[]; clock: Record<string, number> }): Promise<void> {
    const existingNodes = await this.storage.listNodes({});
    const existingEdges = await this.storage.listEdges({});
    const existingNodeIds = new Set(existingNodes.map(n => n.id));
    const existingEdgeIds = new Set(existingEdges.map(e => e.id));

    for (const node of snapshot.nodes) {
      if (!existingNodeIds.has(node.id)) {
        await this.storage.putNode(node);
      } else {
        const existing = await this.storage.getNode(node.id);
        if (existing && node.updatedAt > existing.updatedAt) {
          await this.storage.putNode(node);
        }
      }
    }

    for (const edge of snapshot.edges) {
      if (!existingEdgeIds.has(edge.id)) {
        await this.storage.putEdge(edge);
      }
    }

    this.clock.merge(new VectorClock(this.clock.toJSON()));
  }
}
