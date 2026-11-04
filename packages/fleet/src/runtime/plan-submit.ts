// P2 `task_submit.plan`：完整 plan 定义 → 校验 → 写 internal plan 节点 → 创建 root task。
//
// 唯一提交路径；不新增 MCP 方法。旧 `task_submit`（无 plan 字段）完全走原 handler。
// 幂等：同 planId+version+规范化内容返回已有；内容不同 PLAN_CONFLICT；root 缺失补建一次。

import type { FleetEndpoint } from '../protocol/envelope.js';
import { PLAN_SENTINEL } from '../protocol/envelope.js';
import type { TaskEvent } from '../protocol/events.js';
import type { TaskState } from '../model.js';
import { reduceTaskEvents } from '../model.js';
import type { TaskEventStore } from '../store/file-store.js';
import type { TaskPlanWriteStore } from '../store/plan-store.js';
import { effectiveBudget } from '../collab/tree.js';
import {
  PlanValidationError,
  planMrTaskRefs,
  planRootTaskId,
  planTaskId,
  validatePlan,
  validatePlanShape,
  type PlanErrorCode,
  type TaskPlan,
} from '../plan.js';
import { ensurePlanRootTask } from './materializer.js';

export interface SubmitTaskPlanOptions {
  plan: unknown;
  /** 旧必填字段：root task 的意图摘要。 */
  intent: string;
  /** 旧必填字段；plan 提交必须是 `{device:"__plan__",agent:"__plan__"}`。 */
  to: unknown;
  caller: FleetEndpoint;
  plans: TaskPlanWriteStore;
  store: TaskEventStore;
}

export interface SubmitTaskPlanSuccess {
  ok: true;
  planId: string;
  version: number;
  rootTaskId: string;
  taskId: string;
  rootTarget: FleetEndpoint;
  deduped?: true;
}

export interface SubmitTaskPlanFailure {
  ok: false;
  error: PlanErrorCode;
  errors: string[];
  created: [];
  planId?: string;
  version?: number;
}

export type SubmitTaskPlanResult = SubmitTaskPlanSuccess | SubmitTaskPlanFailure;

function failure(code: PlanErrorCode, errors: string[], plan?: { planId?: string; version?: number }): SubmitTaskPlanFailure {
  return {
    ok: false,
    error: code,
    errors,
    created: [],
    ...(plan?.planId !== undefined ? { planId: plan.planId } : {}),
    ...(plan?.version !== undefined ? { version: plan.version } : {}),
  };
}

function isSentinelTarget(to: unknown): boolean {
  if (typeof to !== 'object' || to === null || Array.isArray(to)) return false;
  const endpoint = to as { device?: unknown; agent?: unknown };
  return endpoint.device === PLAN_SENTINEL && endpoint.agent === PLAN_SENTINEL;
}

async function taskStatesOf(store: TaskEventStore): Promise<TaskState[]> {
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

// 同进程串行化同一 planId+version 的提交（校验→plan 节点→root 补建）。
// 跨进程仍由 plan 节点幂等与确定性 taskId/eventId 兜底。
const submitQueues = new Map<string, Promise<unknown>>();

function serializeSubmit<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = submitQueues.get(key) ?? Promise.resolve();
  const next = previous.then(run, run);
  const tracked = next.catch(() => undefined);
  submitQueues.set(key, tracked);
  void tracked.finally(() => {
    if (submitQueues.get(key) === tracked) submitQueues.delete(key);
  });
  return next;
}

/**
 * 提交完整 plan。校验顺序：schema → 版本/幂等 → DAG → budget → policy → join → MR →
 * acceptance → reuse → 写 plan 节点 → root task（缺失补建）。
 */
export async function submitTaskPlan(options: SubmitTaskPlanOptions): Promise<SubmitTaskPlanResult> {
  const shape = validatePlanShape(options.plan);
  if (!shape.ok) return failure(shape.code, shape.errors);
  const candidate = shape.plan;

  if (typeof options.intent !== 'string' || options.intent.trim().length === 0) {
    return failure('PLAN_SCHEMA', ['intent 必须为非空字符串'], candidate);
  }
  if (!isSentinelTarget(options.to)) {
    return failure('PLAN_SCHEMA', ['plan 提交的 to 必须为 {device:"__plan__",agent:"__plan__"}'], candidate);
  }
  return serializeSubmit(`${candidate.planId}#${candidate.version}`, () => submitTaskPlanUnlocked(options, candidate));
}

async function submitTaskPlanUnlocked(
  options: SubmitTaskPlanOptions,
  candidate: TaskPlan,
): Promise<SubmitTaskPlanResult> {
  const existing = await options.plans.list();
  const versions = existing.filter((plan) => plan.planId === candidate.planId);
  const parentPlan = candidate.parent === undefined
    ? undefined
    : existing.find((plan) => plan.planId === candidate.parent!.planId && plan.version === candidate.parent!.version);
  const states = await taskStatesOf(options.store);
  const stateById = new Map(states.map((state) => [state.taskId, state]));
  const parentTaskId = candidate.parent === undefined
    ? null
    : planTaskId(candidate.parent.planId, candidate.parent.version, candidate.parent.stepId);
  const parentTask = parentTaskId === null ? undefined : stateById.get(parentTaskId);
  const parentStepBudget = parentTask === undefined ? undefined : effectiveBudget(parentTask, stateById);
  const parentTaskState = parentTask === undefined ? undefined : { to: parentTask.to, status: parentTask.status };
  const existingVersion = versions.find((plan) => plan.version === candidate.version);
  // MR 唯一性优先：root planId 已存在任一 MR task 时禁止创建新版本（含重试）。
  if (candidate.parent === undefined && candidate.version > 1 && existingVersion === undefined
    && planMrTaskRefs(candidate.planId, versions, states).length > 0) {
    return failure('PLAN_MR', ['root plan 已存在 MR task，禁止创建新版本（MR 只允许一次）'], candidate);
  }
  const childRootExists = existingVersion !== undefined
    && stateById.has(planRootTaskId(candidate.planId, candidate.version));

  let validation;
  try {
    validation = validatePlan(candidate, {
      existingVersions: versions,
      ...(parentPlan !== undefined ? { parentPlan } : {}),
      ...(parentStepBudget !== undefined ? { parentStepBudget } : {}),
      ...(parentTaskState !== undefined ? { parentTaskState } : {}),
      ...(childRootExists ? { parentTaskAccepted: true } : {}),
      taskStates: states,
      caller: options.caller,
    });
  } catch (error) {
    if (error instanceof PlanValidationError) return failure(error.code, error.errors, candidate);
    throw error;
  }
  if (!validation.ok) return failure(validation.code, validation.errors, candidate);
  const plan: TaskPlan = validation.plan;

  let deduped = validation.deduped === true;
  if (!deduped) {
    try {
      const appended = await options.plans.append(plan);
      deduped = appended.replayed;
    } catch (error) {
      if (error instanceof PlanValidationError) return failure(error.code, error.errors, plan);
      throw error;
    }
  }

  try {
    await ensurePlanRootTask(plan, options.store, options.caller, { intent: options.intent });
  } catch (error) {
    if (error instanceof PlanValidationError) return failure(error.code, error.errors, plan);
    throw error;
  }
  const rootTaskId = planRootTaskId(plan.planId, plan.version);
  return {
    ok: true,
    planId: plan.planId,
    version: plan.version,
    rootTaskId,
    taskId: rootTaskId,
    rootTarget: { device: PLAN_SENTINEL, agent: PLAN_SENTINEL },
    ...(deduped ? { deduped: true as const } : {}),
  };
}
