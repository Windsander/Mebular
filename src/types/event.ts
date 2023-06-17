// Event 类型

export type EventType =
  | 'node_created'
  | 'node_updated'
  | 'node_deleted'
  | 'edge_created'
  | 'edge_updated'
  | 'edge_deleted'
  | string;

export interface Event {
  id: string;
  type: EventType;
  timestamp: number;
  vectorClock: Record<string, number>;
  data: Record<string, unknown>;
  author: string;
  signature: string;
}

export interface EventFilter {
  id?: string;
  type?: EventType;
  fromTime?: number;
  toTime?: number;
  author?: string;
  limit?: number;
  offset?: number;
}

export interface EventData {
  nodeId?: string;
  nodeType?: string;
  edgeId?: string;
  edgeSource?: string;
  edgeTarget?: string;
  relation?: string;
  validFrom?: number;
  validTo?: number;
  deletedAt?: number;
  updatedAt?: number;
  updatedBy?: string;
  deletedBy?: string;
}
