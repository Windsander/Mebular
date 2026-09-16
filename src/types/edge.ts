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
  /** 记忆分区：边归属其创建时的源节点分区；缺失一律视为 'default' */
  namespace?: string;
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
  /** 单分区或分区列表；undefined/空数组 = 不过滤 */
  namespace?: string | string[];
  limit?: number;
  offset?: number;
}
