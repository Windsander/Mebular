// 存储接口

import type { Node, Edge, Event } from '../types/index.js';
import type { NodeFilter, EdgeFilter, EventFilter } from '../types/index.js';

export type { NodeFilter, EdgeFilter, EventFilter };

export interface StorageAdapter {
  // 节点操作
  putNode(node: Node): Promise<void>;
  getNode(id: string): Promise<Node | null>;
  deleteNode(id: string): Promise<void>;
  listNodes(filter?: NodeFilter): Promise<Node[]>;
  
  // 边操作
  putEdge(edge: Edge): Promise<void>;
  getEdge(id: string): Promise<Edge | null>;
  deleteEdge(id: string): Promise<void>;
  listEdges(filter?: EdgeFilter): Promise<Edge[]>;
  
  // 事件操作
  putEvent(event: Event): Promise<void>;
  getEvent(id: string): Promise<Event | null>;
  deleteEvent(id: string): Promise<void>;
  listEvents(filter?: EventFilter): Promise<Event[]>;
  
  // 通用操作
  close(): Promise<void>;
}

export interface StorageSnapshot {
  nodes: Node[];
  edges: Edge[];
  events: Event[];
  clock: Record<string, number>;
}
