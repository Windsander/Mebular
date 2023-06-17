// Node 类型

export interface BaseNode {
  id: string;
  type: string;
  createdBy: string;
  signature: string;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
  tags?: string[];
  notes?: string;
  metadata?: Record<string, unknown>;
  labels?: string[];
  content?: unknown;
  author?: string;
  validFrom?: number;
  validTo?: number;
  validFromBigInt?: bigint;
  validToBigInt?: bigint;
  vectorClock?: Record<string, number>;
  clocks?: Record<string, number>;
}

export interface Node extends BaseNode {
  type: string;
}

export interface Entity extends BaseNode {
  type: 'entity';
  entityType: 'user' | 'project' | 'tool' | 'concept' | 'organization' | 'location' | 'other';
  name: string;
  description?: string;
  properties?: Record<string, unknown>;
}

export interface Fact extends BaseNode {
  type: 'fact';
  subject: string;
  predicate: string;
  object: string;
  validFrom?: number;
  validTo?: number;
  confidence?: number;
  source?: string;
}

export type NodeFilter = {
  id?: string;
  type?: string;
  labels?: string[];
  author?: string;
  fromTime?: number;
  toTime?: number;
  validFrom?: number;
  validTo?: number;
  limit?: number;
  offset?: number;
};
