// Node 类型

export interface BaseNode {
  id: string;
  type: string;
  createdBy: string;
  updatedBy?: string;
  signature: string;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
  deletedBy?: string;
  validFrom?: number;
  validTo?: number;
  tags?: string[];
  notes?: string;
  metadata?: Record<string, unknown>;
  labels?: string[];
}

export interface Node extends BaseNode {
  content?: string | Record<string, unknown>;
  clocks?: Record<string, number>;
  vectorClock?: Record<string, number>;
}

export interface NodeFilter {
  id?: string;
  type?: string;
  createdBy?: string;
  updatedBy?: string;
  deletedBy?: string;
  author?: string;
  validFrom?: number;
  validTo?: number;
  tags?: string[];
  fromTime?: number;
  toTime?: number;
  labels?: string[];
  limit?: number;
  offset?: number;
}
