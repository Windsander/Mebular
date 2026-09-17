// Fleet 任务模型（M1）：由**显式状态事件**确定性推导权威 `TaskState`。
//
// 关键性质（见 PROTOCOL-INVARIANTS.md）：
// - **顺序无关收敛**：输入事件数组任意排列、任意重复，结果一致；
// - **至少一次 + 幂等应用**：按 `eventId` 去重，重复投递不改变状态、不重复执行；
// - **墙钟无关**：`at` / `expiresAt` 不参与权威判定（只做本机展示）。

import {
  STATUS_RANK,
  TERMINAL_PRECEDENCE,
  isTerminal,
  canTransition,
  type FleetEndpoint,
  type FleetTrace,
  type TaskStatus,
} from './protocol/envelope.js';
import type { TaskEvent } from './protocol/events.js';

/** 权威任务状态（由事件推导；与到达顺序无关）。 */
export interface TaskState {
  taskId: string;
  from: FleetEndpoint;
  to: FleetEndpoint;
  intent: string;
  /** 任务输入负载引用（取自 `created` 事件） */
  payloadRef?: string;
  status: TaskStatus;
  /** 已尝试次数（= 去重后 `claimed` 事件数） */
  attempts: number;
  /** **软约定**：仅本机展示；不参与权威判定 */
  expiresAt?: number;
  trace: FleetTrace;
  terminal: boolean;
  /** 决定 `status` 的事件 id（确定性） */
  lastEventId: string;
  /** `done` 时的结果引用 */
  resultRef?: string;
  /** `failed` 时的原因 */
  reason?: string;
}

/** 状态迁移是否合法（显式迁移表；`from === to` 视为幂等自迁移）。 */
export function validateTaskTransition(from: TaskStatus, to: TaskStatus): boolean {
  return canTransition(from, to);
}

/** 非法迁移则抛错（本地发起侧用；负例测试）。 */
export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (!validateTaskTransition(from, to)) {
    throw new Error(`非法任务状态迁移：${from} → ${to}`);
  }
}

/** 事件“更权威”判定（确定性全序）：状态秩 ↑，再终态平局裁决 ↑，再 `eventId` 字典序 ↑。 */
function isStronger(a: TaskEvent, b: TaskEvent): boolean {
  const rankA = STATUS_RANK[a.toStatus];
  const rankB = STATUS_RANK[b.toStatus];
  if (rankA !== rankB) return rankA > rankB;
  const precA = TERMINAL_PRECEDENCE[a.toStatus];
  const precB = TERMINAL_PRECEDENCE[b.toStatus];
  if (precA !== precB) return precA > precB;
  return a.eventId > b.eventId;
}

/** 确定性序列化：对象键递归排序，保证结果与对象构造/解析顺序无关。 */
function stableStringify(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

/**
 * 去重（按 `eventId`）。同一 `eventId` 对应**不同内容**时（违约/对抗输入），
 * 按稳定序列化取字典序较大者做**确定性裁决**——使「去重后的集合」本身与输入
 * 顺序无关，堵住同一 id 不同内容造成的顺序相关分叉（§2.1 顺序无关收敛）。
 * 契约上 `eventId` 仍应内容寻址或全局唯一；本裁决只是兜底，不改变正常路径。
 */
export function dedupeEvents(events: readonly TaskEvent[]): TaskEvent[] {
  const byId = new Map<string, TaskEvent>();
  for (const event of events) {
    const existing = byId.get(event.eventId);
    if (existing === undefined) {
      byId.set(event.eventId, event);
      continue;
    }
    if (stableStringify(event) > stableStringify(existing)) {
      byId.set(event.eventId, event);
    }
  }
  return [...byId.values()];
}

/**
 * 由事件集合推导权威状态（**顺序无关、幂等**）。无 `created` 事件 → 返回 `null`（任务未知）。
 * 不读取 `at` / `now`（墙钟无关）。
 */
export function reduceTaskEvents(events: readonly TaskEvent[]): TaskState | null {
  const unique = dedupeEvents(events);
  if (unique.length === 0) return null;

  let created: TaskEvent | null = null;
  for (const event of unique) {
    if (event.type !== 'created') continue;
    if (created === null || event.eventId < created.eventId) created = event;
  }
  if (created === null) return null;

  let winner = unique[0]!;
  for (const event of unique) if (isStronger(event, winner)) winner = event;

  const attempts = unique.reduce((n, e) => (e.type === 'claimed' ? n + 1 : n), 0);

  const chainSet = new Set<string>();
  for (const event of unique) for (const id of event.trace.chain) chainSet.add(id);
  if (created.trace.causedBy !== undefined) chainSet.add(created.trace.causedBy);
  const chain = [...chainSet].sort();

  const status = winner.toStatus;
  const state: TaskState = {
    taskId: created.taskId,
    from: created.actor,
    to: created.to ?? created.actor,
    intent: created.intent ?? '',
    status,
    attempts,
    trace: {
      ...(created.trace.causedBy !== undefined ? { causedBy: created.trace.causedBy } : {}),
      chain,
    },
    terminal: isTerminal(status),
    lastEventId: winner.eventId,
  };
  if (created.payloadRef !== undefined) state.payloadRef = created.payloadRef;
  if (created.expiresAt !== undefined) state.expiresAt = created.expiresAt;
  if (winner.type === 'done' && winner.payloadRef !== undefined) state.resultRef = winner.payloadRef;
  if (winner.type === 'failed' && winner.reason !== undefined) state.reason = winner.reason;
  return state;
}

/** 幂等应用器：按 `eventId` 去重；重复投递不改变状态、不重复执行。 */
export interface ApplyOutcome {
  /** 是否为首次应用（false = 重复投递，被幂等忽略） */
  applied: boolean;
  state: TaskState | null;
}

export class IdempotentTaskApplier {
  private readonly byTask = new Map<string, Map<string, TaskEvent>>();

  /** 应用一个事件（首次返回 applied=true；重复返回 applied=false）。 */
  apply(event: TaskEvent): ApplyOutcome {
    let map = this.byTask.get(event.taskId);
    if (map === undefined) {
      map = new Map();
      this.byTask.set(event.taskId, map);
    }
    if (map.has(event.eventId)) {
      return { applied: false, state: reduceTaskEvents([...map.values()]) };
    }
    map.set(event.eventId, event);
    return { applied: true, state: reduceTaskEvents([...map.values()]) };
  }

  hasApplied(taskId: string, eventId: string): boolean {
    return this.byTask.get(taskId)?.has(eventId) ?? false;
  }

  /** 是否应执行该事件对应的工作（非 `created` 且未应用过）——保证「重复投递不重复执行」。 */
  shouldExecute(event: TaskEvent): boolean {
    return event.type !== 'created' && !this.hasApplied(event.taskId, event.eventId);
  }

  eventsOf(taskId: string): TaskEvent[] {
    return [...(this.byTask.get(taskId)?.values() ?? [])];
  }

  state(taskId: string): TaskState | null {
    const events = this.byTask.get(taskId);
    return events === undefined ? null : reduceTaskEvents([...events.values()]);
  }

  taskIds(): string[] {
    return [...this.byTask.keys()].sort();
  }
}

/** 本机展示用：是否已过期（**advisory**，不参与权威判定）。 */
export function isExpiredLocally(expiresAt: number | undefined, now: number): boolean {
  return expiresAt !== undefined && now >= expiresAt;
}
