// Fleet 协作形态 ③：配额制闲聊（M4 目标二）。
//
// 低频信息交换，受**每设备本地配额**约束（复用 `LocalQuota`）：超额按策略本地拒绝/排队，
// 无全局协调。收件按 `messageId` 幂等去重，顺序无关。

import { isFleetEndpoint, type FleetEndpoint } from '../protocol/envelope.js';
import type { LocalQuota, QuotaDecision } from '../quota.js';

/** 一条闲聊消息（幂等键 = `messageId`）。 */
export interface ChatterMessage {
  v: number;
  messageId: string;
  from: FleetEndpoint;
  topic: string;
  text: string;
}

export interface ChatterValidation {
  ok: boolean;
  errors: string[];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function validateChatterMessage(input: unknown): ChatterValidation {
  const errors: string[] = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: ['chatter 必须是对象'] };
  }
  const m = input as Record<string, unknown>;
  if (m.v !== 1) errors.push('v 必须为 1');
  if (!isNonEmptyString(m.messageId)) errors.push('messageId 必须为非空字符串');
  if (!isFleetEndpoint(m.from)) errors.push('from 必须为 {device,agent}');
  if (!isNonEmptyString(m.topic)) errors.push('topic 必须为非空字符串');
  if (!isNonEmptyString(m.text)) errors.push('text 必须为非空字符串');
  return { ok: errors.length === 0, errors };
}

/** 本地闲聊信箱：发送走本地配额，接收幂等去重。 */
export class ChatterBox {
  private readonly byId = new Map<string, ChatterMessage>();

  constructor(private readonly quota: LocalQuota) {}

  /** 发送：对 `from.device` 本地记账；超额按 quota 策略 accepted/queued/rejected。 */
  send(message: ChatterMessage): QuotaDecision {
    return this.quota.decide(message.from.device);
  }

  /** 接收：重复 `messageId` 返回 false（幂等）。 */
  receive(message: ChatterMessage): boolean {
    if (this.byId.has(message.messageId)) return false;
    this.byId.set(message.messageId, message);
    return true;
  }

  /** 收件箱（topic、messageId 字典序；确定性）。 */
  inbox(): ChatterMessage[] {
    return [...this.byId.values()].sort((a, b) =>
      a.topic === b.topic ? (a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0) : a.topic < b.topic ? -1 : 1,
    );
  }

  size(): number {
    return this.byId.size;
  }
}
