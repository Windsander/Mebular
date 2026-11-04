// P2 materializer：只按 plan + task 事件推进，不维护第二套持久状态机。
//
// 边界（P0 契约 §6.8）：
// - 只推进 ready step；step 必须有显式 `to` 才建 task（route 属 P3）。
// - 确定性 taskId `${planId}#${version}#${stepId}`；eventId `${taskId}#created`；append 幂等。
// - 不创建 join/reduce/mr task（P4）；这些 step 保持 pending/blocked，不伪造完成。
// - root task 由提交创建；materializer 只补缺、推进 queued→claimed→running；
//   root plan 在 MR 能力落地前不得 done。

import type { FleetEndpoint } from '../protocol/envelope.js';
import { PLAN_SENTINEL } from '../protocol/envelope.js';
import type { TaskEvent } from '../protocol/events.js';
import { reduceTaskEvents, type TaskState } from '../model.js';
import type { TaskEventStore } from '../store/file-store.js';
import type { TaskPlanStore } from '../store/plan-store.js';
import { admitCreated, effectiveBudget } from '../collab/tree.js';
import {
  PlanValidationError,
  planRootTaskId,
  planTaskId,
  validatePlan,
  derivePlanSteps,
  type TaskPlan,
} from '../plan.js';

export interface PlanMaterializerOptions {
  device: string;
  agent: string;
  plans: TaskPlanStore;
  store: TaskEventStore;
  /** 运行时并发上限（与 plan.policy.maxParallel 取较小值；默认 8）。 */
  maxParallel?: number;
  /** 断线/排障：允许非 owner 设备运行 coordinator（默认不改变正确性依赖）。 */
  coordinateForeignPlans?: boolean;
}

export interface PlanMaterializeResult {
  plans: number;
  rootsCreated: number;
  rootsAdvanced: number;
  tasksCreated: string[];
  completed: string[];
  failed: string[];
  invalid: Array<{ planId: string; version: number; code: string }>;
}

interface PlannedRootResult {
  created: boolean;
  taskId: string;
  state: TaskState | null;
}

// 同进程并发 materializer：同一 eventId 的“查重 + append”串行化；跨进程由 store eventId 去重。
const eventQueues = new Map<string, Promise<boolean>>();

function appendOnce(store: TaskEventStore, event: TaskEvent): Promise<boolean> {
  const previous = eventQueues.get(event.eventId) ?? Promise.resolve(false);
  const run = async (): Promise<boolean> => {
    const existing = await store.byTask(event.taskId);
    if (existing.some((entry) => entry.eventId === event.eventId)) return false;
    return store.append(event);
  };
  const next = previous.then(run, run);
  const tracked = next.catch(() => false);
  eventQueues.set(event.eventId, tracked);
  void tracked.finally(() => {
    if (eventQueues.get(event.eventId) === tracked) eventQueues.delete(event.eventId);
  });
  return next;
}

/** 父 step task 的派生 trace（sub-plan 的 root/step task 都必须由父 step task 派生）。 */
function derivedTrace(plan: TaskPlan, states: ReadonlyMap<string, TaskState>): { causedBy?: string; chain: string[] } {
  if (plan.parent === undefined) return { chain: [] };
  const parentTaskId = planTaskId(plan.parent.planId, plan.parent.version, plan.parent.stepId);
  const parent = states.get(parentTaskId);
  if (parent === undefined) {
    // B6：sub-plan 的 root/step 必须从真实父 step task 派生，不得伪造只含父 id 的 chain。
    throw new PlanValidationError('PLAN_STATE_INVALID', [`父 step task 不存在或尚未物化：${parentTaskId}`]);
  }
  return { causedBy: parentTaskId, chain: [...parent.trace.chain, parentTaskId] };
}

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

/**
 * 确保 root task 存在（提交与 materializer 共用）：
 * - root plan：`trace.chain=[]`；sub-plan：`causedBy=父 step taskId` + 父 chain。
 * - target 固定 sentinel，dispatch=root-only；任何 worker 都不执行它。
 * - 已存在则完全不写（幂等；eventId 兜底并发）。
 */
export async function ensurePlanRootTask(
  plan: TaskPlan,
  store: TaskEventStore,
  endpoint: FleetEndpoint,
  options: { intent?: string } = {},
): Promise<PlannedRootResult> {
  const taskId = planRootTaskId(plan.planId, plan.version);
  const current = reduceTaskEvents(await store.byTask(taskId));
  if (current !== null) return { created: false, taskId, state: current };
  const allStates = new Map((await statesOf(store)).map((state) => [state.taskId, state]));
  if (plan.parent !== undefined) {
    const parentTaskId = planTaskId(plan.parent.planId, plan.parent.version, plan.parent.stepId);
    const parent = allStates.get(parentTaskId);
    if (parent === undefined) {
      throw new PlanValidationError('PLAN_STATE_INVALID', [`父 step task 不存在或尚未物化：${parentTaskId}`]);
    }
    // B10：root 缺失时，终态父 task 不得补建 root；未来调用点也不能绕过。
    if (parent.status === 'done' || parent.status === 'failed') {
      throw new PlanValidationError('PLAN_STATE_INVALID', [
        `root task 缺失且父 step task 已终态（${parent.status}）：${parentTaskId}`,
      ]);
    }
  }
  const trigger = derivedTrace(plan, allStates);
  const event: TaskEvent = {
    v: 1,
    eventId: `${taskId}#created`,
    taskId,
    type: 'created',
    actor: endpoint,
    at: Date.now(),
    toStatus: 'queued',
    trace: trigger,
    to: { device: PLAN_SENTINEL, agent: PLAN_SENTINEL },
    intent: options.intent !== undefined && options.intent.length > 0 ? options.intent : plan.goal,
    dispatch: 'root-only',
  };
  const created = await appendOnce(store, event);
  return { created, taskId, state: reduceTaskEvents(await store.byTask(taskId)) };
}

/** 按 plan 推进的 coordinator/materializer。无缓存权威状态；每轮从 plan + task 事件重算。 */
export class PlanMaterializer {
  private readonly endpoint: FleetEndpoint;
  private readonly plans: TaskPlanStore;
  private readonly store: TaskEventStore;
  private readonly maxParallel: number;
  private readonly coordinateForeignPlans: boolean;

  constructor(options: PlanMaterializerOptions) {
    this.endpoint = { device: options.device, agent: options.agent };
    this.plans = options.plans;
    this.store = options.store;
    this.maxParallel = Math.max(1, options.maxParallel ?? 8);
    this.coordinateForeignPlans = options.coordinateForeignPlans ?? false;
  }

  private async appendRootEvent(
    state: TaskState,
    type: 'claimed' | 'running' | 'done' | 'failed',
    reason?: string,
  ): Promise<boolean> {
    const event: TaskEvent = {
      v: 1,
      eventId: type === 'failed'
        ? `${state.taskId}#failed@${this.endpoint.device}`
        : `${state.taskId}#${type}@${this.endpoint.device}`,
      taskId: state.taskId,
      type,
      actor: this.endpoint,
      at: Date.now(),
      toStatus: type === 'claimed' ? 'claimed' : type === 'running' ? 'running' : type === 'done' ? 'done' : 'failed',
      trace: state.trace,
      ...(type === 'failed' && reason !== undefined ? { reason } : {}),
    };
    return appendOnce(this.store, event);
  }

  private async advanceRoot(state: TaskState): Promise<number> {
    let advanced = 0;
    let current = state;
    if (current.status === 'queued') {
      if (await this.appendRootEvent(current, 'claimed')) advanced += 1;
      current = reduceTaskEvents(await this.store.byTask(state.taskId)) ?? current;
    }
    if (current.status === 'claimed') {
      if (await this.appendRootEvent(current, 'running')) advanced += 1;
      current = reduceTaskEvents(await this.store.byTask(state.taskId)) ?? current;
    }
    return advanced;
  }

  private latestPlans(all: readonly TaskPlan[]): TaskPlan[] {
    const latest = new Map<string, TaskPlan>();
    for (const plan of all) {
      const current = latest.get(plan.planId);
      if (current === undefined || plan.version > current.version) latest.set(plan.planId, plan);
    }
    return [...latest.values()].sort((a, b) => (a.planId < b.planId ? -1 : a.planId > b.planId ? 1 : 0));
  }

  /**
   * 一轮 materialize。可安全重复调用；kill/restart 后从 plan + task 事件恢复。
   */
  async tick(): Promise<PlanMaterializeResult> {
    const result: PlanMaterializeResult = {
      plans: 0,
      rootsCreated: 0,
      rootsAdvanced: 0,
      tasksCreated: [],
      completed: [],
      failed: [],
      invalid: [],
    };
    const allPlans = await this.plans.list();
    const versionsByPlan = new Map<string, TaskPlan[]>();
    for (const plan of allPlans) {
      const list = versionsByPlan.get(plan.planId);
      if (list) list.push(plan);
      else versionsByPlan.set(plan.planId, [plan]);
    }
    for (const latest of this.latestPlans(allPlans)) {
      if (!this.coordinateForeignPlans && latest.owner.device !== this.endpoint.device) continue;
      result.plans += 1;
      const versions = (versionsByPlan.get(latest.planId) ?? []).filter((plan) => plan.version !== latest.version);
      let states = await statesOf(this.store);
      const stateById = new Map(states.map((state) => [state.taskId, state]));
      const parentPlan = latest.parent === undefined
        ? undefined
        : allPlans.find((plan) => plan.planId === latest.parent!.planId && plan.version === latest.parent!.version);
      const parentTaskId = latest.parent === undefined
        ? null
        : planTaskId(latest.parent.planId, latest.parent.version, latest.parent.stepId);
      const parentTask = parentTaskId === null ? undefined : stateById.get(parentTaskId);
      const parentStepBudget = parentTask === undefined ? undefined : effectiveBudget(parentTask, stateById);
      const parentTaskState = parentTask === undefined ? undefined : { to: parentTask.to, status: parentTask.status };
      const childRootExists = stateById.has(planRootTaskId(latest.planId, latest.version));
      const validation = validatePlan(latest, {
        existingVersions: versions,
        ...(parentPlan !== undefined ? { parentPlan } : {}),
        ...(parentStepBudget !== undefined ? { parentStepBudget } : {}),
        ...(parentTaskState !== undefined ? { parentTaskState } : {}),
        ...(childRootExists ? { parentTaskAccepted: true } : {}),
        taskStates: states,
        caller: latest.owner,
      });
      if (!validation.ok) {
        result.invalid.push({ planId: latest.planId, version: latest.version, code: validation.code });
        continue;
      }
      const plan = validation.plan;

      let root: PlannedRootResult;
      try {
        root = await ensurePlanRootTask(plan, this.store, this.endpoint);
      } catch (error) {
        if (error instanceof PlanValidationError) {
          result.invalid.push({ planId: plan.planId, version: plan.version, code: error.code });
          continue;
        }
        throw error;
      }
      if (root.created) result.rootsCreated += 1;
      states = await statesOf(this.store);
      let rootState = states.find((state) => state.taskId === planRootTaskId(plan.planId, plan.version));

      if (rootState === undefined) {
        result.invalid.push({ planId: plan.planId, version: plan.version, code: 'PLAN_STATE_INVALID' });
        continue;
      }
      if (rootState.status === 'failed') {
        result.failed.push(planRootTaskId(plan.planId, plan.version));
        continue;
      }

      const advanced = await this.advanceRoot(rootState);
      if (advanced > 0) {
        result.rootsAdvanced += advanced;
        states = await statesOf(this.store);
        rootState = states.find((state) => state.taskId === planRootTaskId(plan.planId, plan.version)) ?? rootState;
      }

      const derived = derivePlanSteps(plan, states);
      const failedStep = derived.find((entry) => entry.failed);
      if (failedStep !== undefined) {
        if (!rootState.terminal) {
          await this.appendRootEvent(rootState, 'failed', `STEP_FAILED:${failedStep.step.stepId}`);
          result.failed.push(planRootTaskId(plan.planId, plan.version));
        }
        continue;
      }

      // sub-plan 完成：唯一 sink complete 后 root done。root plan 的 done 必须等 MR（P4）。
      if (plan.parent !== undefined) {
        const dependents = new Set(plan.steps.flatMap((step) => step.dependsOn));
        const sinks = plan.steps.filter((step) => !dependents.has(step.stepId));
        const sink = sinks.length === 1 ? derived.find((entry) => entry.step.stepId === sinks[0]!.stepId) : undefined;
        if (sink?.complete === true) {
          if (!rootState.terminal) {
            await this.appendRootEvent(rootState, 'done');
            result.completed.push(planRootTaskId(plan.planId, plan.version));
          }
          continue;
        }
      }

      if (rootState.terminal) continue;

      const parallel = Math.min(this.maxParallel, plan.policy.maxParallel ?? 8);
      let busy = derived.filter((entry) => entry.status === 'dispatched').length;
      if (busy >= parallel) continue;
      const ready = derived
        .filter((entry) => entry.status === 'pending'
          && (entry.blockedBy === undefined || entry.blockedBy.length === 0)
          && entry.step.kind === 'task'
          && entry.step.to !== undefined)
        .sort((a, b) => (a.step.stepId < b.step.stepId ? -1 : a.step.stepId > b.step.stepId ? 1 : 0));
      const stateMap = new Map(states.map((state) => [state.taskId, state]));
      const trigger = derivedTrace(plan, stateMap);
      for (const entry of ready) {
        if (busy >= parallel) break;
        const step = entry.step;
        const to = step.to;
        if (to === undefined) continue;
        const taskId = planTaskId(plan.planId, plan.version, step.stepId);
        if (stateMap.has(taskId)) continue;
        if ((await this.store.byTask(taskId)).length > 0) continue;
        const event: TaskEvent = {
          v: 1,
          eventId: `${taskId}#created`,
          taskId,
          type: 'created',
          actor: this.endpoint,
          at: Date.now(),
          toStatus: 'queued',
          trace: trigger,
          to,
          intent: step.intent,
        };
        // 运行时 TaskBudget/tree 不变式兜底：超预算不建 task（下一步 tick 再评估）。
        if (!admitCreated(event, [...stateMap.values()], reduceTaskEvents).ok) continue;
        if (await appendOnce(this.store, event)) {
          result.tasksCreated.push(taskId);
          stateMap.set(taskId, reduceTaskEvents([event])!);
          busy += 1;
        }
      }
    }
    return result;
  }
}
