// Fleet 协作形态 ②：有限协商（M4 目标二）。
//
// 任务可回写「需澄清 / 反提案 / 接受 / 拒绝」，但**步数有上限**（可配）；超限 → 任务 `failed` 带原因。
// 协商消息独立于 `TaskEvent`（**不改线格式**）；跟踪器对消息**幂等去重**且结果**与到达顺序无关**。

import type { FleetEndpoint } from '../protocol/envelope.js';
import { isFleetEndpoint } from '../protocol/envelope.js';
import type { Mebular } from '@mebular/core';
import { MebularMessageStore } from '../store/message-store.js';

/** 协商消息的节点类型（与任务事件同分区、不同类型，随既有授权同步）。 */
export const NEGOTIATION_MESSAGE_TYPE = 'negotiation_message';

/** 构造协商消息存储（校验 + messageId 幂等）。 */
export function negotiationMessageStore(
  mebular: Mebular,
  namespace = 'tasks',
): MebularMessageStore<NegotiationMessage> {
  return new MebularMessageStore<NegotiationMessage>(mebular, {
    type: NEGOTIATION_MESSAGE_TYPE,
    namespace,
    validate: validateNegotiationMessage,
    idOf: (m) => m.messageId,
  });
}

/** 协商消息类型。 */
export const NEGOTIATION_KINDS = ['clarify', 'counter', 'accept', 'reject'] as const;
export type NegotiationKind = (typeof NEGOTIATION_KINDS)[number];

/** 一条协商消息（幂等键 = `messageId`）。 */
export interface NegotiationMessage {
  v: number;
  messageId: string;
  taskId: string;
  /** 第几轮（由发起方给；确定性上取「最大轮」） */
  round: number;
  from: FleetEndpoint;
  kind: NegotiationKind;
  text?: string;
}

export interface NegotiationValidation {
  ok: boolean;
  errors: string[];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function validateNegotiationMessage(input: unknown): NegotiationValidation {
  const errors: string[] = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: ['negotiation 必须是对象'] };
  }
  const m = input as Record<string, unknown>;
  if (m.v !== 1) errors.push('v 必须为 1');
  if (!isNonEmptyString(m.messageId)) errors.push('messageId 必须为非空字符串');
  if (!isNonEmptyString(m.taskId)) errors.push('taskId 必须为非空字符串');
  if (typeof m.round !== 'number' || !Number.isInteger(m.round) || m.round < 0) errors.push('round 必须为非负整数');
  if (!isFleetEndpoint(m.from)) errors.push('from 必须为 {device,agent}');
  if (!isNonEmptyString(m.kind) || !(NEGOTIATION_KINDS as readonly string[]).includes(m.kind)) {
    errors.push(`kind 必须为 ${NEGOTIATION_KINDS.join('|')}`);
  }
  if (m.text !== undefined && !isNonEmptyString(m.text)) errors.push('text 若存在须为非空字符串');
  return { ok: errors.length === 0, errors };
}

/** 跟踪结果（与到达顺序无关）。 */
export interface NegotiationStatus {
  rounds: number;
  maxRounds: number;
  accepted: boolean;
  rejected: boolean;
  exceeded: boolean;
}

/** 有限协商裁定。 */
export type NegotiationDecision =
  | { action: 'proceed' }
  | { action: 'continue' }
  | { action: 'fail'; reason: string };

/** 协商跟踪器：幂等去重 + 顺序无关。 */
export class NegotiationTracker {
  readonly taskId: string;
  private readonly maxRounds: number;
  private readonly byId = new Map<string, NegotiationMessage>();

  constructor(taskId: string, options: { maxRounds: number }) {
    if (!Number.isInteger(options.maxRounds) || options.maxRounds < 0) {
      throw new Error(`maxRounds 必须为非负整数：${options.maxRounds}`);
    }
    this.taskId = taskId;
    this.maxRounds = options.maxRounds;
  }

  /** 应用一条消息；重复 `messageId` 返回 false（幂等）。 */
  apply(message: NegotiationMessage): boolean {
    if (message.taskId !== this.taskId) throw new Error(`协商消息 taskId 不符：${message.taskId}`);
    if (this.byId.has(message.messageId)) return false;
    this.byId.set(message.messageId, message);
    return true;
  }

  /** 消息列表（轮次、messageId 字典序）。 */
  messages(): NegotiationMessage[] {
    return [...this.byId.values()].sort((a, b) =>
      a.round === b.round ? (a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0) : a.round - b.round,
    );
  }

  status(): NegotiationStatus {
    const messages = this.messages();
    const rounds = messages.reduce((n, m) => Math.max(n, m.round), 0);
    const accepted = messages.some((m) => m.kind === 'accept');
    const rejected = messages.some((m) => m.kind === 'reject');
    const exceeded = !accepted && rounds > this.maxRounds;
    return { rounds, maxRounds: this.maxRounds, accepted, rejected, exceeded };
  }
}

/** 由状态裁定：接受→proceed；拒绝→fail；超限→fail(带原因)；否则 continue。 */
export function negotiationDecision(status: NegotiationStatus): NegotiationDecision {
  if (status.accepted) return { action: 'proceed' };
  if (status.rejected) return { action: 'fail', reason: 'NEGOTIATION_REJECTED' };
  if (status.exceeded) return { action: 'fail', reason: `NEGOTIATION_LIMIT: ${status.rounds}>${status.maxRounds}` };
  return { action: 'continue' };
}
