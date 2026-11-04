// P2/P3/P4 materializer：只按 plan + task 事件推进，不维护第二套持久状态机。
//
// 边界（P0 契约 §6.8 / §7 / §8）：
// - 只推进 ready step；P3 route step 由 routing provider 解析，显式 `to` 也必须过硬过滤。
// - 确定性 taskId `${planId}#${version}#${stepId}`；eventId `${taskId}#created`；append 幂等。
// - P4：join/reduce 只在全部依赖 complete 后创建；MR 按 root planId 跨版本唯一，
//   target 固定 plan.owner + dispatch=root-only；root plan 只在 MR done 后 done。
// - 失败/取消：root failed 明确 reason，best-effort 取消该 version 非终态 step task 及派生树。
// - root task 由提交创建；materializer 只补缺、推进 queued→claimed→running。

import type { FleetEndpoint } from '../protocol/envelope.js';
import { PLAN_SENTINEL } from '../protocol/envelope.js';
import type { TaskEvent } from '../protocol/events.js';
import { reduceTaskEvents, type TaskState } from '../model.js';
import type { TaskEventStore } from '../store/file-store.js';
import type { TaskPlanStore } from '../store/plan-store.js';
import { admitCreated, effectiveBudget } from '../collab/tree.js';
import {
  PlanValidationError,
  acceptancePasses,
  planMrTaskRefs,
  planRootTaskId,
  planTaskId,
  taskSubtreeCompletion,
  validatePlan,
  derivePlanSteps,
  type DerivedPlanStep,
  type TaskPlan,
} from '../plan.js';
import { cancelPlanVersionTasks } from './plan-control.js';
import {
  ROUTE_STATUS_TTL_MS,
  loadRouteContext,
  resolvePlanStepRoute,
  routeInputFromContext,
  type AgentStatusView,
  type PlanRoutingProvider,
  type RouteContext,
  type RouteDecision,
} from '../routing.js';

export interface PlanMaterializerOptions {
  device: string;
  agent: string;
  plans: TaskPlanStore;
  store: TaskEventStore;
  /** 运行时并发上限（与 plan.policy.maxParallel 取较小值；默认 8）。 */
  maxParallel?: number;
  /** 断线/排障：允许非 owner 设备运行 coordinator（默认不改变正确性依赖）。 */
  coordinateForeignPlans?: boolean;
  /**
   * P3 route provider。提供时显式 `to` 也走完整硬过滤（授权/policy/能力卡/payload/在线/容量），
   * `route` step 自动解析目标。缺省保留 P2 行为（仅显式 `to` + policy 形状检查），
   * 生产入口（CLI embedded/daemon）必须显式提供；daemon 无法验证远端卡时 fail-closed。
   */
  routing?: PlanRoutingProvider;
}

export interface PlanMaterializeAssignment {
  planId: string;
  version: number;
  stepId: string;
  taskId: string;
  chosen: FleetEndpoint;
  why: RouteDecision['why'];
  rejected: RouteDecision['rejected'];
}

export interface PlanMaterializeBlocked {
  planId: string;
  version: number;
  stepId: string;
  code: string;
  blockedBy: string[];
  detail?: string;
  why?: RouteDecision['why'];
  rejected?: RouteDecision['rejected'];
}

export interface PlanMaterializeResult {
  plans: number;
  rootsCreated: number;
  rootsAdvanced: number;
  tasksCreated: string[];
  completed: string[];
  failed: string[];
  invalid: Array<{ planId: string; version: number; code: string }>;
  assignments: PlanMaterializeAssignment[];
  blocked: PlanMaterializeBlocked[];
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

/** 永久失败的 root reason：明确到 step/acceptance；MR 单独标记，便于区分“MR 失败不重试”。 */
function failureReason(entry: DerivedPlanStep): string {
  const acceptanceFailed = (entry.blockedBy ?? []).includes('ACCEPTANCE_FAILED');
  if (entry.step.kind === 'mr') return acceptanceFailed ? 'MR_ACCEPTANCE_FAILED' : 'MR_FAILED';
  return acceptanceFailed ? `STEP_ACCEPTANCE_FAILED:${entry.step.stepId}` : `STEP_FAILED:${entry.step.stepId}`;
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
  private readonly routing: PlanRoutingProvider | undefined;

  constructor(options: PlanMaterializerOptions) {
    this.endpoint = { device: options.device, agent: options.agent };
    this.plans = options.plans;
    this.store = options.store;
    this.maxParallel = Math.max(1, options.maxParallel ?? 8);
    this.coordinateForeignPlans = options.coordinateForeignPlans ?? false;
    this.routing = options.routing;
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

  /** best-effort；单个取消失败不影响 tick，下一轮会再次尝试。 */
  private async cleanupVersion(planId: string, version: number): Promise<void> {
    try {
      await cancelPlanVersionTasks(this.store, planId, version, this.endpoint, 'CANCELLED');
    } catch {
      // 清理失败不得让已 failed/cancelled 的 plan 复活。
    }
  }

  /**
   * 新版本接管后，旧版本不再推进：root 写 failed(SUPERSEDED_BY) 并清理未终态 step task。
   *
   * MR 唯一性优先，但不能让旧 root 永久悬挂：
   * - 旧版本拥有非终态 MR → 只等待，不清理（避免撤销已创建的 MR）。
   * - 旧版本拥有终态 MR → 按 MR 回执把旧 root 收敛到 done/failed；已终态 MR 永不撤销。
   * - 旧版本没有 MR（或从未创建 root）→ 补建缺失 root 后写 SUPERSEDED_BY，并清理该版本。
   */
  private async finalizeOlderVersions(latest: TaskPlan, versions: readonly TaskPlan[]): Promise<void> {
    const older = versions
      .filter((plan) => plan.version < latest.version)
      .sort((a, b) => a.version - b.version);
    if (older.length === 0) return;
    const states = await statesOf(this.store);
    const mrRefs = planMrTaskRefs(latest.planId, [latest, ...versions], states);
    for (const plan of older) {
      const rootTaskId = planRootTaskId(plan.planId, plan.version);
      let rootState = states.find((state) => state.taskId === rootTaskId);
      const mrStep = plan.steps.find((step) => step.kind === 'mr');
      const mrRef = mrStep === undefined
        ? undefined
        : mrRefs.find((ref) => ref.version === plan.version);
      if (mrRef !== undefined) {
        if (rootState === undefined) {
          try {
            rootState = (await ensurePlanRootTask(plan, this.store, this.endpoint)).state ?? undefined;
          } catch (error) {
            if (error instanceof PlanValidationError) continue;
            throw error;
          }
        }
        // MR 是 root plan 的唯一完成回执；pending 时旧 root 必须保持 active 等待。
        if (!mrRef.state.terminal) continue;
        if (mrRef.state.status === 'done') {
          const subtree = taskSubtreeCompletion(mrRef.taskId, states);
          if (!subtree.complete) continue;
          const accepted = !subtree.failed
            && acceptancePasses(mrStep!.acceptance, mrRef.state.resultRef);
          if (rootState !== undefined && !rootState.terminal) {
            if (accepted) await this.appendRootEvent(rootState, 'done');
            else await this.appendRootEvent(rootState, 'failed', 'MR_ACCEPTANCE_FAILED');
          }
          if (!accepted) await this.cleanupVersion(plan.planId, plan.version);
          continue;
        }
        // MR terminal failed：不重试，旧 root 保留失败证据并清理残留非终态任务。
        if (rootState !== undefined && !rootState.terminal) {
          await this.appendRootEvent(rootState, 'failed', 'MR_FAILED');
        }
        await this.cleanupVersion(plan.planId, plan.version);
        continue;
      }

      // 没有 MR 的旧版本：补建缺失 root（保留失败证据），再标记被新版本取代。
      if (rootState === undefined) {
        try {
          rootState = (await ensurePlanRootTask(plan, this.store, this.endpoint)).state ?? undefined;
        } catch (error) {
          if (error instanceof PlanValidationError) continue;
          throw error;
        }
      }
      if (rootState !== undefined && !rootState.terminal) {
        await this.appendRootEvent(rootState, 'failed', `SUPERSEDED_BY:${latest.version}`);
      }
      await this.cleanupVersion(plan.planId, plan.version);
    }
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
      assignments: [],
      blocked: [],
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

      await this.finalizeOlderVersions(plan, versions);
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
        // 永久失败/取消：每轮 best-effort 重试清理未终态 step task 及派生树（§8.6）。
        await this.cleanupVersion(plan.planId, plan.version);
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
          await this.appendRootEvent(rootState, 'failed', failureReason(failedStep));
          result.failed.push(planRootTaskId(plan.planId, plan.version));
        }
        await this.cleanupVersion(plan.planId, plan.version);
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

      // root plan：MR 是唯一 sink 与最后门禁；root done 只在 MR done + acceptance 后。
      if (plan.parent === undefined && !rootState.terminal) {
        const mrStep = plan.steps.find((step) => step.kind === 'mr');
        if (mrStep !== undefined) {
          const allVersions = versionsByPlan.get(plan.planId) ?? [plan];
          const mrRefs = planMrTaskRefs(plan.planId, allVersions, states);
          // MR 按 root planId 跨版本唯一：非终态等待；done 完成；failed 永久失败（不重试）。
          const pendingMr = mrRefs.find((ref) => !ref.state.terminal);
          if (pendingMr !== undefined) continue;
          const doneMr = mrRefs.find((ref) => ref.state.status === 'done');
          if (doneMr !== undefined) {
            const doneVersion = allVersions.find((version) => version.version === doneMr.version);
            const doneStep = doneVersion?.steps.find((step) => step.kind === 'mr');
            const subtree = taskSubtreeCompletion(doneMr.taskId, states);
            if (subtree.failed) {
              await this.appendRootEvent(rootState, 'failed', 'MR_FAILED');
              result.failed.push(planRootTaskId(plan.planId, plan.version));
              await this.cleanupVersion(plan.planId, plan.version);
              continue;
            }
            if (!subtree.complete) continue;
            if (doneStep !== undefined && acceptancePasses(doneStep.acceptance, doneMr.state.resultRef)) {
              await this.appendRootEvent(rootState, 'done');
              result.completed.push(planRootTaskId(plan.planId, plan.version));
            } else {
              await this.appendRootEvent(rootState, 'failed', 'MR_ACCEPTANCE_FAILED');
              result.failed.push(planRootTaskId(plan.planId, plan.version));
              await this.cleanupVersion(plan.planId, plan.version);
            }
            continue;
          }
          const failedMr = mrRefs.find((ref) => ref.state.status === 'failed');
          if (failedMr !== undefined) {
            await this.appendRootEvent(rootState, 'failed', 'MR_FAILED');
            result.failed.push(planRootTaskId(plan.planId, plan.version));
            await this.cleanupVersion(plan.planId, plan.version);
            continue;
          }

          const gate = plan.steps.find((step) => step.stepId === mrStep.dependsOn[0]);
          const gateEntry = derived.find((entry) => entry.step.stepId === mrStep.dependsOn[0]);
          const gateReady = gate !== undefined
            && (gate.kind === 'join' || gate.kind === 'reduce')
            && gate.join?.mode === 'all'
            && gateEntry?.complete === true;
          const allNonMrComplete = derived
            .filter((entry) => entry.step.kind !== 'mr')
            .every((entry) => entry.complete);
          if (gateReady && allNonMrComplete) {
            const taskId = planTaskId(plan.planId, plan.version, mrStep.stepId);
            const stateById = new Map(states.map((state) => [state.taskId, state]));
            if (!stateById.has(taskId)) {
              const event: TaskEvent = {
                v: 1,
                eventId: `${taskId}#created`,
                taskId,
                type: 'created',
                actor: this.endpoint,
                at: Date.now(),
                toStatus: 'queued',
                trace: { chain: [] },
                to: { device: plan.owner.device, agent: plan.owner.agent },
                intent: mrStep.intent,
                dispatch: 'root-only',
              };
              if (admitCreated(event, [...stateById.values()], reduceTaskEvents).ok) {
                if (await appendOnce(this.store, event)) result.tasksCreated.push(taskId);
              }
            }
            continue;
          }
        }
      }

      if (rootState.terminal) continue;

      const parallel = Math.min(this.maxParallel, plan.policy.maxParallel ?? 8);
      let busy = derived.filter((entry) => entry.status === 'dispatched').length;
      if (busy >= parallel) continue;
      let routeContext: RouteContext | null = null;
      const ready = derived
        .filter((entry) => entry.status === 'pending'
          && (entry.blockedBy === undefined || entry.blockedBy.length === 0)
          && (entry.step.kind === 'task' || entry.step.kind === 'join' || entry.step.kind === 'reduce')
          && (entry.step.to !== undefined || entry.step.route !== undefined))
        .sort((a, b) => (a.step.stepId < b.step.stepId ? -1 : a.step.stepId > b.step.stepId ? 1 : 0));
      if (this.routing !== undefined && ready.length > 0) {
        // 一轮只取一次快照：卡片/授权/状态都在 tick 内保持同一视图，排序可解释且可复现。
        routeContext = await loadRouteContext(this.routing, {
          states,
          events: await this.store.all(),
          asOf: Date.now(),
          computedBy: this.endpoint.device,
        });
      }
      // B1：同 tick 内每成功建一个 task，实时递增该目标的 inflight；
      // 后续 step（含显式 to）看到的是同一目标的最新容量，不会把多个 task 塞给 capacity=1 的目标。
      const liveStatus: AgentStatusView[] = routeContext === null
        ? []
        : routeContext.status.map((view) => ({ ...view }));
      const stateMap = new Map(states.map((state) => [state.taskId, state]));
      const trigger = derivedTrace(plan, stateMap);
      for (const entry of ready) {
        if (busy >= parallel) break;
        const step = entry.step;
        if (routeContext === null) {
          // P3：无 routing provider 一律 fail-closed；不走 P2 无硬过滤路径。
          result.blocked.push({
            planId: plan.planId,
            version: plan.version,
            stepId: step.stepId,
            code: 'NO_TARGET',
            blockedBy: ['NO_TARGET'],
            detail: 'routing-unavailable',
          });
          continue;
        }
        const decision = resolvePlanStepRoute(plan, step, routeInputFromContext({
          ...routeContext,
          status: liveStatus,
        }));
        if (decision.decision !== 'assigned' || decision.chosen === null) {
          result.blocked.push({
            planId: plan.planId,
            version: plan.version,
            stepId: step.stepId,
            code: decision.why.code,
            blockedBy: decision.blockedBy.length > 0 ? decision.blockedBy : ['NO_TARGET'],
            why: decision.why,
            ...(decision.rejected.length > 0 ? { rejected: decision.rejected } : {}),
          });
          continue;
        }
        // 显式 to 绝不被改派：resolver 保证 chosen===to；这里再做运行时兜底。
        if (step.to !== undefined
          && (decision.chosen.device !== step.to.device || decision.chosen.agent !== step.to.agent)) {
          result.blocked.push({
            planId: plan.planId,
            version: plan.version,
            stepId: step.stepId,
            code: 'NO_TARGET',
            blockedBy: ['NO_TARGET'],
            detail: 'explicit-target-mismatch',
          });
          continue;
        }
        const to = decision.chosen;
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
          result.assignments.push({
            planId: plan.planId,
            version: plan.version,
            stepId: step.stepId,
            taskId,
            chosen: to,
            why: decision.why,
            rejected: decision.rejected,
          });
          const live = liveStatus.find((view) => view.device === to.device && view.agent === to.agent);
          if (live !== undefined) {
            live.inflight = Math.max(0, Math.trunc(live.inflight)) + 1;
          } else {
            liveStatus.push({
              v: 1,
              kind: 'agent_status_view',
              device: to.device,
              agent: to.agent,
              online: true,
              inflight: 1,
              capacity: 1,
              asOf: Date.now(),
              ttlMs: ROUTE_STATUS_TTL_MS,
              computedBy: this.endpoint.device,
            });
          }
        }
      }
    }
    return result;
  }
}
