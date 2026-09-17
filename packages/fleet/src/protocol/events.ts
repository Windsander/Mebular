// Fleet 任务事件（M1）：**显式状态事件**驱动权威生命周期。
//
// 事件是任务（一类记忆）上的状态迁移记录。`at` 是**本机墙钟**，仅用于展示与本地排队，
// **不参与**权威状态判定（见 `SEALING.md`：墙钟不进一致性判定）。收敛只由
// `(状态秩, 终态平局裁决, eventId)` 决定（见 `model.ts`）。

import {
  FLEET_PROTOCOL_VERSION,
  isTaskStatus,
  isFleetEndpoint,
  type FleetEndpoint,
  type FleetTrace,
  type TaskStatus,
} from './envelope.js';

/** 事件类型。 */
export const TASK_EVENT_TYPES = ['created', 'claimed', 'running', 'done', 'failed'] as const;
export type TaskEventType = (typeof TASK_EVENT_TYPES)[number];

/** 事件类型 → 目标权威状态（一一对应）。 */
export const EVENT_TO_STATUS: Readonly<Record<TaskEventType, TaskStatus>> = {
  created: 'queued',
  claimed: 'claimed',
  running: 'running',
  done: 'done',
  failed: 'failed',
};

/** 任务事件（线格式）。 */
export interface TaskEvent {
  /** 协议版本 */
  v: number;
  /** 事件唯一 ID（内容寻址或全局唯一；**幂等键**：重复投递按此去重） */
  eventId: string;
  /** 所属任务 */
  taskId: string;
  /** 事件类型 */
  type: TaskEventType;
  /** 发出该事件的端 */
  actor: FleetEndpoint;
  /** 本机墙钟（**advisory**：不参与收敛） */
  at: number;
  /** 迁移后的权威状态（必须与 `type` 一致） */
  toStatus: TaskStatus;
  /** 因果链 */
  trace: FleetTrace;
  /** `created` 事件必填：目标端 */
  to?: FleetEndpoint;
  /** `created` 事件必填：意图 */
  intent?: string;
  /** `created` 事件可选：**软约定**到期（不参与权威判定） */
  expiresAt?: number;
  /** 结果/负载引用（`done` 常带） */
  payloadRef?: string;
  /** 失败原因（`failed` 常带） */
  reason?: string;
}

/** 事件类型守卫。 */
export function isTaskEventType(value: unknown): value is TaskEventType {
  return typeof value === 'string' && (TASK_EVENT_TYPES as readonly string[]).includes(value);
}

/** 校验结果。 */
export interface TaskEventValidation {
  ok: boolean;
  errors: string[];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** 校验未知输入是否为合法 `TaskEvent`（不做迁移合法性判定）。 */
export function validateTaskEvent(input: unknown): TaskEventValidation {
  const errors: string[] = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: ['event 必须是对象'] };
  }
  const e = input as Record<string, unknown>;
  if (e.v !== FLEET_PROTOCOL_VERSION) errors.push(`v 必须为 ${FLEET_PROTOCOL_VERSION}`);
  if (!isNonEmptyString(e.eventId)) errors.push('eventId 必须为非空字符串');
  if (!isNonEmptyString(e.taskId)) errors.push('taskId 必须为非空字符串');
  if (!isTaskEventType(e.type)) errors.push(`type 必须为 ${TASK_EVENT_TYPES.join('|')}`);
  if (!isFleetEndpoint(e.actor)) errors.push('actor 必须为 {device,agent} 非空字符串');
  if (typeof e.at !== 'number' || !Number.isFinite(e.at)) errors.push('at 必须为有限数字');
  if (!isTaskStatus(e.toStatus)) errors.push('toStatus 必须为合法任务状态');
  else if (isTaskEventType(e.type) && EVENT_TO_STATUS[e.type] !== e.toStatus) {
    errors.push(`toStatus 必须与 type 一致（${e.type} → ${EVENT_TO_STATUS[e.type]}）`);
  }
  if (typeof e.trace !== 'object' || e.trace === null) {
    errors.push('trace 必须为对象');
  } else {
    const trace = e.trace as Record<string, unknown>;
    if (trace.causedBy !== undefined && !isNonEmptyString(trace.causedBy)) {
      errors.push('trace.causedBy 若存在须为非空字符串');
    }
    if (!Array.isArray(trace.chain) || !trace.chain.every(isNonEmptyString)) {
      errors.push('trace.chain 必须为字符串数组');
    }
  }
  if (e.payloadRef !== undefined && !isNonEmptyString(e.payloadRef)) {
    errors.push('payloadRef 若存在须为非空字符串');
  }
  if (e.reason !== undefined && !isNonEmptyString(e.reason)) {
    errors.push('reason 若存在须为非空字符串');
  }
  if (e.type === 'created') {
    if (!isFleetEndpoint(e.to)) errors.push('created 事件的 to 必须为 {device,agent}');
    if (!isNonEmptyString(e.intent)) errors.push('created 事件的 intent 必须为非空字符串');
  }
  if (e.expiresAt !== undefined && (typeof e.expiresAt !== 'number' || !Number.isFinite(e.expiresAt))) {
    errors.push('expiresAt 若存在须为有限数字（advisory）');
  }
  return { ok: errors.length === 0, errors };
}

/** 便于测试/构造的校验快捷键。 */
export function isTaskEvent(input: unknown): input is TaskEvent {
  return validateTaskEvent(input).ok;
}
