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
  /** 记忆分区；缺失一律视为 'default'（见 core/namespace） */
  namespace?: string;
  /**
   * 预留（T3，本期不实现）：按 namespace 独立加密密钥的标识。
   * 仅占位，不参与任何加解密逻辑。
   */
  encryptionKeyId?: string;
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
  /** 单分区或分区列表；undefined/空数组 = 不过滤 */
  namespace?: string | string[];
  limit?: number;
  offset?: number;
}
