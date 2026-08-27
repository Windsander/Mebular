// Event 类型

// 证书类型仅做类型层引用（type-only，无运行时依赖）：
// DeviceCertificate 的定义归握手层所有，事件携带它用于证书链验签（D9 收口）。
import type { DeviceCertificate } from '../p2p/handshake/AuthenticationHandshake.js';

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
  /**
   * 签发设备的证书（可选）：中继/多跳路径上验证「事件签发设备 → 用户主密钥」
   * 信任链的依据。不参与内容寻址 ID 与签名（canonicalEventData 字段集固定），
   * 旧事件无此字段时退化为直连对端验签。
   */
  authorCertificate?: DeviceCertificate;
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
