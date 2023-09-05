// Edge 类型

export interface EdgeBase {
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
  clocks?: Record<string, number>;
  vectorClock?: Record<string, number>;
}

export interface Edge extends EdgeBase {
  source: string;
  target: string;
  relation: string;
}

export interface EdgeFilter {
  id?: string;
  source?: string;
  target?: string;
  relation?: string;
  labels?: string[];
  limit?: number;
  offset?: number;
}
