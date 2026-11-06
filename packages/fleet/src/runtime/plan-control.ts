// P4 plan 控制：task_cancel 的 plan/step 级联清理与永久失败清理。
//
// 边界（P0 契约 §8.6）：
// - 只使用既有 `failed` 事件（reason=CANCELLED），不新增事件类型/字段/MCP 方法。
// - best-effort、幂等：已终态任务不改写；单个 append 失败不阻止其它任务，后续 tick 可重试。
// - plan 级取消写入 root task failed(CANCELLED)；step 级取消只覆盖该 task 及其派生子树。
// - 已提交（terminal done）的 MR task 不撤销；非终态 step task 及其 sub-plan 派生树会被取消。

import type { FleetEndpoint } from '../protocol/envelope.js';
import type { TaskEvent } from '../protocol/events.js';
import { reduceTaskEvents, type TaskState } from '../model.js';
import type { TaskEventStore } from '../store/file-store.js';
import { planRootTaskId } from '../plan.js';

async function statesOf(store: TaskEventStore): Promise<TaskState[]> {
  const byTask = new Map<string, TaskEvent[]>();
  for (const event of await store.all()) {
    const list = byTask.get(event.taskId);
    if (list) list.push(event);
    else byTask.set(event.taskId, [event]);
  }
  return [...byTask.keys()].sort()
    .map((taskId) => reduceTaskEvents(byTask.get(taskId)!))
    .filter((state): state is TaskState => state !== null);
}

function descendantsOf(states: readonly TaskState[], taskId: string): string[] {
  const children = new Map<string, string[]>();
  for (const state of states) {
    const parent = state.trace.causedBy;
    if (parent === undefined) continue;
    const list = children.get(parent);
    if (list) list.push(state.taskId);
    else children.set(parent, [state.taskId]);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [...(children.get(taskId) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    for (const child of children.get(id) ?? []) stack.push(child);
  }
  return out;
}

async function appendCancelled(
  store: TaskEventStore,
  state: TaskState,
  actor: FleetEndpoint,
  reason: string,
): Promise<boolean> {
  const event: TaskEvent = {
    v: 1,
    eventId: `${state.taskId}#failed@${actor.device}`,
    taskId: state.taskId,
    type: 'failed',
    actor,
    at: Date.now(),
    toStatus: 'failed',
    trace: state.trace,
    reason,
  };
  try {
    return await store.append(event);
  } catch {
    // best-effort：单个取消失败不阻止其它任务。
    return false;
  }
}

/** 取消一个 task（可选其派生子树）；已终态任务跳过。返回实际写入取消事件的 taskId。 */
export async function cancelTaskTree(
  store: TaskEventStore,
  taskId: string,
  actor: FleetEndpoint,
  options: { subtree: boolean; reason?: string },
): Promise<string[]> {
  const states = await statesOf(store);
  const byId = new Map(states.map((state) => [state.taskId, state]));
  if (!byId.has(taskId)) return [];
  const ids = options.subtree ? [taskId, ...descendantsOf(states, taskId)] : [taskId];
  const cancelled: string[] = [];
  for (const id of [...new Set(ids)].sort()) {
    const state = byId.get(id);
    if (state === undefined || state.terminal) continue;
    if (await appendCancelled(store, state, actor, options.reason ?? 'CANCELLED')) cancelled.push(id);
  }
  return cancelled;
}

/**
 * 取消某 plan version 的全部非终态 step task 及其派生子树（不含 root task）。
 * 扫描 `${planId}#${version}#` 命名，因此 stale/sub-plan task 也能覆盖。
 */
export async function cancelPlanVersionTasks(
  store: TaskEventStore,
  planId: string,
  version: number,
  actor: FleetEndpoint,
  reason = 'CANCELLED',
): Promise<string[]> {
  const states = await statesOf(store);
  const byId = new Map(states.map((state) => [state.taskId, state]));
  const rootTaskId = planRootTaskId(planId, version);
  const prefix = `${planId}#${version}#`;
  const ids = new Set<string>();
  for (const state of states) {
    if (state.taskId === rootTaskId) continue;
    if (!state.taskId.startsWith(prefix)) continue;
    ids.add(state.taskId);
  }
  for (const stepTaskId of [...ids]) {
    for (const child of descendantsOf(states, stepTaskId)) ids.add(child);
  }
  const cancelled: string[] = [];
  for (const id of [...ids].sort()) {
    const state = byId.get(id);
    if (state === undefined || state.terminal) continue;
    if (await appendCancelled(store, state, actor, reason)) cancelled.push(id);
  }
  return cancelled;
}
