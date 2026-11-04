// P2 Plan 节点（`task_plan`）：纯 schema / DAG / policy / 进度派生。
//
// 边界（P0 契约 §6 / §4.2）：
// - plan 是不可变的 internal 记忆节点；task 层只保留派生树，plan 依赖不是 TaskEvent 边。
// - 本模块不读写存储、不依赖墙钟；materializer 与 `task_status` 共用同一套派生逻辑。
// - 本期只实现 `join.mode="all"`（CR-001）；route/join/MR 执行属 P3/P4，这里只做校验与进度。

import { PLAN_SENTINEL, type FleetEndpoint, type TaskBudget } from './protocol/envelope.js';
import type { TaskState } from './model.js';

export const TASK_PLAN_KIND = 'task_plan' as const;
export const TASK_PLAN_NODE_TYPE = 'task_plan' as const;
export const TASK_PLAN_SCHEMA_VERSION = 1 as const;

export const PLAN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const PLAN_STEP_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
export const PLAN_VERSION_PATTERN = /^[1-9][0-9]*$/;

export type PlanErrorCode =
  | 'PLAN_SCHEMA'
  | 'PLAN_VERSION'
  | 'PLAN_DUP_STEP'
  | 'PLAN_MISSING_DEP'
  | 'PLAN_CYCLE'
  | 'PLAN_BUDGET'
  | 'PLAN_POLICY'
  | 'PLAN_JOIN'
  | 'PLAN_MR'
  | 'PLAN_ACCEPTANCE'
  | 'PLAN_REUSE'
  | 'PLAN_CONFLICT'
  | 'PLAN_STATE_INVALID';

export type PlanStepKind = 'task' | 'join' | 'reduce' | 'mr';

export interface PlanAcceptance {
  kind: 'non-empty-result' | 'contains' | 'mr-once';
  minBytes?: number;
  all?: string[];
}

export interface PlanRoute {
  require?: string[];
  prefer?: string[];
  strategy: 'deterministic';
}

export interface PlanStep {
  stepId: string;
  kind: PlanStepKind;
  intent: string;
  dependsOn: string[];
  to?: FleetEndpoint;
  route?: PlanRoute;
  acceptance: PlanAcceptance;
  join?: { mode: 'all' };
  reuse?: { version: number };
}

export interface PlanPolicy {
  allowedDevices?: string[];
  allowedAgents?: string[];
  requireCapabilities?: string[];
  maxParallel?: number;
  allowSubcontract?: boolean;
}

export interface PlanBudget {
  maxSteps: number;
  maxAttemptsPerStep: number;
}

export interface PlanParent {
  planId: string;
  version: number;
  stepId: string;
}

export interface TaskPlan {
  v: typeof TASK_PLAN_SCHEMA_VERSION;
  kind: typeof TASK_PLAN_KIND;
  planId: string;
  version: number;
  supersedesVersion?: number;
  retryOfStepId?: string;
  parent?: PlanParent;
  reason?: string;
  owner: FleetEndpoint;
  goal: string;
  createdAt: number;
  budget: PlanBudget;
  policy: PlanPolicy;
  steps: PlanStep[];
}

export interface PlanValidationContext {
  /** 同 planId 的已存在版本（用于版本单调 / supersedes / reuse / 幂等冲突）。 */
  existingVersions?: readonly TaskPlan[];
  /** 子 plan 的父 plan（已定位到 parent.version）。 */
  parentPlan?: TaskPlan;
  /** 父 step task 的有效 TaskBudget；子 plan 必须存在真实父 step task。 */
  parentStepBudget?: TaskBudget;
  /** 父 step task 的分配对象/状态；绑定 sub-plan 与真实父执行者。 */
  parentTaskState?: Pick<TaskState, 'to' | 'status'>;
  /**
   * 已接受 child（其确定性 root task 已存在）允许父 task 为 done 后继续物化；
   * 新提交 child 默认 false，父 task 必须仍为 active。
   */
  parentTaskAccepted?: boolean;
  /** 提交者；plan.owner 必须同时等于调用 device 与 agent。 */
  caller?: FleetEndpoint;
  /** 任务权威状态（用于 reuse 的旧结果校验；undefined = 跳过运行时存在性检查）。 */
  taskStates?: readonly TaskState[];
}

export type PlanValidationResult =
  | { ok: true; plan: TaskPlan; deduped?: boolean }
  | { ok: false; code: PlanErrorCode; errors: string[] };

/** 结构化 plan 校验失败（供 store / daemon 端点转 HTTP）。 */
export class PlanValidationError extends Error {
  readonly code: PlanErrorCode;
  readonly errors: string[];

  constructor(code: PlanErrorCode, errors: string[] = []) {
    super(`${code}${errors.length > 0 ? `: ${errors.join('; ')}` : ''}`);
    this.name = 'PlanValidationError';
    this.code = code;
    this.errors = errors;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isEndpoint(value: unknown): value is FleetEndpoint {
  if (!isRecord(value)) return false;
  return nonEmptyString(value.device) && nonEmptyString(value.agent);
}

function failure(code: PlanErrorCode, message: string): { ok: false; code: PlanErrorCode; errors: string[] } {
  return { ok: false, code, errors: [message] };
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (!nonEmptyString(item)) return null;
    out.push(item);
  }
  return out;
}

function uniqueValues(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function uniqueSorted(values: readonly string[]): string[] {
  return uniqueValues(values).sort();
}

/** 确定性 JSON：对象键递归排序、忽略 undefined。 */
function stableJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

/** 规范化内容：去掉 createdAt（审计字段），其余字段递归排序。 */
export function canonicalTaskPlan(plan: TaskPlan): string {
  const { createdAt: _createdAt, ...rest } = plan;
  return stableJson(rest);
}

function normalizeAcceptance(input: unknown): PlanAcceptance | null {
  if (!isRecord(input)) return null;
  const kind = input.kind;
  if (kind === 'non-empty-result') {
    const minBytes = input.minBytes;
    if (minBytes !== undefined && (!Number.isInteger(minBytes) || (minBytes as number) < 0)) return null;
    return { kind, ...(minBytes !== undefined ? { minBytes: minBytes as number } : {}) };
  }
  if (kind === 'contains') {
    const all = stringArray(input.all);
    if (all === null || all.length === 0) return null;
    const minBytes = input.minBytes;
    if (minBytes !== undefined && (!Number.isInteger(minBytes) || (minBytes as number) < 0)) return null;
    return { kind, all, ...(minBytes !== undefined ? { minBytes: minBytes as number } : {}) };
  }
  if (kind === 'mr-once') {
    if (input.minBytes !== undefined || input.all !== undefined) return null;
    return { kind };
  }
  return null;
}

function normalizeRoute(input: unknown): PlanRoute | null {
  if (!isRecord(input)) return null;
  if (input.strategy !== 'deterministic') return null;
  const require = input.require === undefined ? undefined : stringArray(input.require);
  const prefer = input.prefer === undefined ? undefined : stringArray(input.prefer);
  if (require === null || prefer === null) return null;
  return {
    ...(require !== undefined ? { require: uniqueValues(require) } : {}),
    ...(prefer !== undefined ? { prefer: [...prefer] } : {}),
    strategy: 'deterministic',
  };
}

function normalizePolicy(input: unknown): PlanPolicy | null {
  if (!isRecord(input)) return null;
  const policy: PlanPolicy = {};
  for (const key of ['allowedDevices', 'allowedAgents', 'requireCapabilities'] as const) {
    if (input[key] === undefined) continue;
    const values = stringArray(input[key]);
    if (values === null) return null;
    policy[key] = uniqueValues(values);
  }
  if (input.maxParallel !== undefined) {
    if (!Number.isInteger(input.maxParallel) || (input.maxParallel as number) < 1 || (input.maxParallel as number) > 16) return null;
    policy.maxParallel = input.maxParallel as number;
  }
  if (input.allowSubcontract !== undefined) {
    if (typeof input.allowSubcontract !== 'boolean') return null;
    policy.allowSubcontract = input.allowSubcontract;
  }
  return policy;
}

function normalizeStep(input: unknown): PlanStep | null {
  if (!isRecord(input)) return null;
  const stepId = input.stepId;
  if (!nonEmptyString(stepId) || stepId === 'root' || !PLAN_STEP_ID_PATTERN.test(stepId)) return null;
  const kind = input.kind === undefined ? 'task' : input.kind;
  if (kind !== 'task' && kind !== 'join' && kind !== 'reduce' && kind !== 'mr') return null;
  const intent = input.intent;
  if (!nonEmptyString(intent)) return null;
  const dependsOn = stringArray(input.dependsOn);
  if (dependsOn === null) return null;
  const to = input.to === undefined ? undefined : input.to;
  if (to !== undefined && !isEndpoint(to)) return null;
  if (to !== undefined && isEndpoint(to)
    && (to.device === PLAN_SENTINEL || to.agent === PLAN_SENTINEL)) return null;
  const route = input.route === undefined ? undefined : normalizeRoute(input.route);
  if (input.route !== undefined && route === null) return null;
  const acceptance = normalizeAcceptance(input.acceptance);
  if (acceptance === null) return null;
  let join: { mode: 'all' } | undefined;
  if (input.join !== undefined) {
    if (!isRecord(input.join)) return null;
    if (input.join.mode !== 'all') {
      return null;
    }
    join = { mode: 'all' };
  }
  if ((kind === 'join' || kind === 'reduce') && join === undefined) return null;
  if ((kind === 'task' || kind === 'mr') && join !== undefined) return null;
  let reuse: { version: number } | undefined;
  if (input.reuse !== undefined) {
    if (!isRecord(input.reuse) || !Number.isInteger(input.reuse.version) || (input.reuse.version as number) < 1) return null;
    reuse = { version: input.reuse.version as number };
  }
  return {
    stepId,
    kind,
    intent,
    dependsOn,
    ...(to !== undefined ? { to } : {}),
    ...(route !== null && route !== undefined ? { route } : {}),
    acceptance,
    ...(join !== undefined ? { join } : {}),
    ...(reuse !== undefined ? { reuse } : {}),
  };
}

function normalizeParent(input: unknown): PlanParent | null {
  if (!isRecord(input)) return null;
  const planId = input.planId;
  const stepId = input.stepId;
  if (!nonEmptyString(planId) || !PLAN_ID_PATTERN.test(planId)) return null;
  if (!Number.isInteger(input.version) || (input.version as number) < 1) return null;
  if (!nonEmptyString(stepId) || stepId === 'root' || !PLAN_STEP_ID_PATTERN.test(stepId)) return null;
  return { planId, version: input.version as number, stepId };
}

/** schema 形状校验 + 规范化（不读存储；不做完整 DAG/policy 语义）。 */
export function validatePlanShape(input: unknown): PlanValidationResult {
  if (!isRecord(input)) return failure('PLAN_SCHEMA', 'plan 必须是对象');
  if (input.v !== TASK_PLAN_SCHEMA_VERSION) return failure('PLAN_SCHEMA', `v 必须为 ${TASK_PLAN_SCHEMA_VERSION}`);
  if (input.kind !== TASK_PLAN_KIND) return failure('PLAN_SCHEMA', `kind 必须为 ${TASK_PLAN_KIND}`);
  if (!nonEmptyString(input.planId) || !PLAN_ID_PATTERN.test(input.planId)) return failure('PLAN_SCHEMA', 'planId 非法');
  if (!Number.isInteger(input.version) || (input.version as number) < 1) return failure('PLAN_SCHEMA', 'version 必须为 >=1 的整数');
  if (!isEndpoint(input.owner)) return failure('PLAN_SCHEMA', 'owner 必须为 {device,agent} 非空字符串');
  if (!nonEmptyString(input.goal)) return failure('PLAN_SCHEMA', 'goal 必须为非空字符串');
  if (typeof input.createdAt !== 'number' || !Number.isFinite(input.createdAt)) return failure('PLAN_SCHEMA', 'createdAt 必须为有限数字');
  if (!isRecord(input.budget)) return failure('PLAN_SCHEMA', 'budget 必须为对象');
  const maxSteps = input.budget.maxSteps;
  const maxAttemptsPerStep = input.budget.maxAttemptsPerStep;
  if (!Number.isInteger(maxSteps) || (maxSteps as number) < 1 || (maxSteps as number) > 256) {
    return failure('PLAN_BUDGET', 'budget.maxSteps 必须为 1..256 的整数');
  }
  if (!Number.isInteger(maxAttemptsPerStep) || (maxAttemptsPerStep as number) < 1 || (maxAttemptsPerStep as number) > 5) {
    return failure('PLAN_BUDGET', 'budget.maxAttemptsPerStep 必须为 1..5 的整数');
  }
  if (!isRecord(input.policy)) return failure('PLAN_SCHEMA', 'policy 必须为对象');
  const policy = normalizePolicy(input.policy);
  if (policy === null) return failure('PLAN_POLICY', 'policy 形状/范围非法');
  if (!Array.isArray(input.steps) || input.steps.length === 0) return failure('PLAN_SCHEMA', 'steps 必须为非空数组');
  if (input.steps.length > (maxSteps as number)) return failure('PLAN_BUDGET', 'steps.length 不得大于 budget.maxSteps');

  const steps: PlanStep[] = [];
  const seen = new Set<string>();
  for (const raw of input.steps) {
    const step = normalizeStep(raw);
    if (step === null) {
      if (isRecord(raw)) {
        const rawId = raw.stepId;
        if (rawId === 'root') return failure('PLAN_SCHEMA', 'stepId 不得为保留字 root');
        if (isEndpoint(raw.to) && (raw.to.device === PLAN_SENTINEL || raw.to.agent === PLAN_SENTINEL)) {
          return failure('PLAN_SCHEMA', `step to 不得使用保留 sentinel：${String(raw.stepId)}`);
        }
        if (nonEmptyString(rawId) && !PLAN_STEP_ID_PATTERN.test(rawId)) return failure('PLAN_DUP_STEP', `stepId 非法：${rawId}`);
        if (isRecord(raw.join) && raw.join.mode !== 'all') return failure('PLAN_JOIN', `join.mode 本期只允许 all：${String(raw.stepId)}`);
        if (raw.acceptance !== undefined && normalizeAcceptance(raw.acceptance) === null) {
          return failure('PLAN_ACCEPTANCE', `acceptance 非法：${String(raw.stepId)}`);
        }
        if (raw.reuse !== undefined) {
          if (!isRecord(raw.reuse) || !Number.isInteger(raw.reuse.version) || (raw.reuse.version as number) < 1) {
            return failure('PLAN_REUSE', `reuse 版本非法：${String(raw.stepId)}`);
          }
        }
      }
      return failure('PLAN_SCHEMA', 'step 形状非法');
    }
    if (seen.has(step.stepId)) return failure('PLAN_DUP_STEP', `stepId 重复：${step.stepId}`);
    seen.add(step.stepId);
    steps.push(step);
  }

  const version = input.version as number;
  let supersedesVersion: number | undefined;
  if (input.supersedesVersion !== undefined) {
    if (!Number.isInteger(input.supersedesVersion) || (input.supersedesVersion as number) !== version - 1 || version === 1) {
      return failure('PLAN_VERSION', 'supersedesVersion 必须等于 version-1；version=1 禁止');
    }
    supersedesVersion = input.supersedesVersion as number;
  } else if (version > 1) {
    return failure('PLAN_VERSION', 'version>1 必须提供 supersedesVersion=version-1');
  }
  let retryOfStepId: string | undefined;
  if (input.retryOfStepId !== undefined) {
    if (version === 1 || !nonEmptyString(input.retryOfStepId)) {
      return failure('PLAN_VERSION', 'retryOfStepId 仅允许 version>1 的非空字符串');
    }
    retryOfStepId = input.retryOfStepId;
  }
  let parent: PlanParent | undefined;
  if (input.parent !== undefined) {
    const normalized = normalizeParent(input.parent);
    if (normalized === null) return failure('PLAN_POLICY', 'parent 形状非法');
    parent = normalized;
  }
  if (input.reason !== undefined && !nonEmptyString(input.reason)) return failure('PLAN_SCHEMA', 'reason 若存在须为非空字符串');

  const plan: TaskPlan = {
    v: TASK_PLAN_SCHEMA_VERSION,
    kind: TASK_PLAN_KIND,
    planId: input.planId,
    version,
    ...(supersedesVersion !== undefined ? { supersedesVersion } : {}),
    ...(retryOfStepId !== undefined ? { retryOfStepId } : {}),
    ...(parent !== undefined ? { parent } : {}),
    ...(input.reason !== undefined ? { reason: input.reason as string } : {}),
    owner: { device: input.owner.device, agent: input.owner.agent },
    goal: input.goal,
    createdAt: input.createdAt as number,
    budget: { maxSteps: maxSteps as number, maxAttemptsPerStep: maxAttemptsPerStep as number },
    policy,
    steps,
  };
  return { ok: true, plan };
}

function validateDependencies(plan: TaskPlan): PlanValidationResult | null {
  const ids = new Set(plan.steps.map((step) => step.stepId));
  for (const step of plan.steps) {
    const seen = new Set<string>();
    for (const dep of step.dependsOn) {
      if (seen.has(dep)) return failure('PLAN_MISSING_DEP', `step ${step.stepId} 的 dependsOn 重复：${dep}`);
      seen.add(dep);
      if (dep === step.stepId) return failure('PLAN_MISSING_DEP', `step ${step.stepId} 不得自依赖`);
      if (!ids.has(dep)) return failure('PLAN_MISSING_DEP', `step ${step.stepId} 依赖不存在：${dep}`);
    }
    if ((step.kind === 'join' || step.kind === 'reduce') && step.dependsOn.length === 0) {
      return failure('PLAN_MISSING_DEP', `${step.kind} step ${step.stepId} 至少需要 1 个依赖`);
    }
  }
  return null;
}

function validateAcyclic(plan: TaskPlan): PlanValidationResult | null {
  const indegree = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const step of plan.steps) {
    indegree.set(step.stepId, step.dependsOn.length);
    for (const dep of step.dependsOn) {
      const list = children.get(dep);
      if (list) list.push(step.stepId);
      else children.set(dep, [step.stepId]);
    }
  }
  const ready = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id).sort();
  let processed = 0;
  while (ready.length > 0) {
    const id = ready.shift()!;
    processed += 1;
    for (const child of children.get(id) ?? []) {
      const next = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, next);
      if (next === 0) {
        ready.push(child);
        ready.sort();
      }
    }
  }
  if (processed !== plan.steps.length) return failure('PLAN_CYCLE', 'plan DAG 存在环');
  return null;
}

function validateMrShape(plan: TaskPlan): PlanValidationResult | null {
  const mrSteps = plan.steps.filter((step) => step.kind === 'mr');
  const isRoot = plan.parent === undefined;
  if (!isRoot) {
    if (mrSteps.length > 0) return failure('PLAN_MR', 'sub-plan 禁止 MR');
    const dependents = new Set(plan.steps.flatMap((step) => step.dependsOn));
    const sinks = plan.steps.filter((step) => !dependents.has(step.stepId));
    if (sinks.length !== 1) return failure('PLAN_MR', 'sub-plan 必须恰好一个 sink');
    return null;
  }
  if (mrSteps.length !== 1) return failure('PLAN_MR', 'root plan 必须恰好一个 kind=mr step');
  const mr = mrSteps[0]!;
  const dependents = new Set(plan.steps.flatMap((step) => step.dependsOn));
  const sinks = plan.steps.filter((step) => !dependents.has(step.stepId));
  if (sinks.length !== 1 || sinks[0]!.stepId !== mr.stepId) return failure('PLAN_MR', 'root plan 的唯一 sink 必须是 MR');
  if (dependents.has(mr.stepId)) return failure('PLAN_MR', 'MR 不得有后继 step');
  if (mr.dependsOn.length !== 1) return failure('PLAN_MR', 'MR 必须恰好依赖 1 个 join/reduce gate');
  const gate = plan.steps.find((step) => step.stepId === mr.dependsOn[0]);
  if (gate === undefined || (gate.kind !== 'join' && gate.kind !== 'reduce')) {
    return failure('PLAN_MR', 'MR 的直接依赖必须是 join/reduce gate');
  }
  if (gate.join?.mode !== 'all') return failure('PLAN_JOIN', 'MR gate 的 join.mode 必须为 all');
  return null;
}

function validateAcceptance(plan: TaskPlan): PlanValidationResult | null {
  for (const step of plan.steps) {
    if (step.kind === 'mr') {
      if (step.acceptance.kind !== 'mr-once') return failure('PLAN_ACCEPTANCE', `MR step ${step.stepId} 的 acceptance 必须为 mr-once`);
    } else if (step.acceptance.kind === 'mr-once') {
      return failure('PLAN_ACCEPTANCE', `非 MR step ${step.stepId} 禁止 mr-once`);
    }
  }
  return null;
}

function stepWithoutReuse(step: PlanStep): Omit<PlanStep, 'reuse'> {
  const { reuse: _reuse, ...rest } = step;
  return rest;
}

function validateReuse(plan: TaskPlan, context: PlanValidationContext): PlanValidationResult | null {
  const versions = context.existingVersions ?? [];
  const states = context.taskStates;
  const stateById = states === undefined ? undefined : new Map(states.map((state) => [state.taskId, state]));
  for (const step of plan.steps) {
    if (step.reuse === undefined) continue;
    if (step.kind === 'mr') return failure('PLAN_REUSE', 'MR 不得 reuse');
    if (plan.version <= 1) return failure('PLAN_REUSE', 'reuse 仅允许新版本');
    const oldVersion = versions.find((entry) => entry.version === step.reuse!.version);
    if (oldVersion === undefined || step.reuse.version >= plan.version) {
      return failure('PLAN_REUSE', `reuse 引用的版本不存在或非法：${step.reuse.version}`);
    }
    const oldShape = validatePlanShape(oldVersion);
    if (!oldShape.ok) return failure('PLAN_REUSE', `reuse 旧版本非法：${step.reuse.version}`);
    const oldStep = oldShape.plan.steps.find((candidate) => candidate.stepId === step.stepId);
    if (oldStep === undefined) return failure('PLAN_REUSE', `旧版本缺少 step ${step.stepId}`);
    if (stableJson(stepWithoutReuse(oldStep)) !== stableJson(stepWithoutReuse(step))) {
      return failure('PLAN_REUSE', `reuse step 定义与旧版本不一致：${step.stepId}`);
    }
    if (stateById !== undefined) {
      const oldTask = stateById.get(planTaskId(plan.planId, step.reuse.version, step.stepId));
      if (oldTask === undefined || oldTask.status !== 'done') {
        return failure('PLAN_REUSE', `reuse 旧任务未完成：${step.stepId}`);
      }
      if (!acceptancePasses(step.acceptance, oldTask.resultRef)) {
        return failure('PLAN_REUSE', `reuse 旧任务未通过 acceptance：${step.stepId}`);
      }
    }
  }
  return null;
}

function normalizePolicyForReplay(plan: TaskPlan, context: PlanValidationContext): TaskPlan {
  if (plan.parent === undefined || context.parentPlan === undefined) return plan;
  const childPolicy = effectiveChildPolicy(plan.policy, effectiveParentPolicy(context.parentPlan.policy));
  return childPolicy === null ? plan : { ...plan, policy: childPolicy };
}

function validateParent(plan: TaskPlan, context: PlanValidationContext): PlanValidationResult | null {
  if (plan.parent === undefined) return null;
  if (context.caller !== undefined
    && (plan.owner.device !== context.caller.device || plan.owner.agent !== context.caller.agent)) {
    return failure('PLAN_POLICY', 'plan owner 必须同时等于提交设备与 Agent');
  }
  const parent = context.parentPlan;
  if (parent === undefined) return failure('PLAN_POLICY', 'parent plan 不存在');
  if (parent.planId === plan.planId) return failure('PLAN_POLICY', 'sub-plan 必须使用新 planId');
  if (parent.version !== plan.parent.version) return failure('PLAN_POLICY', 'parent version 不匹配');
  if (parent.policy.allowSubcontract !== true) return failure('PLAN_POLICY', '父 plan policy 禁止分包');
  const parentStep = parent.steps.find((step) => step.stepId === plan.parent!.stepId);
  if (parentStep === undefined) return failure('PLAN_POLICY', 'parent step 不存在');
  if (parentStep.kind !== 'task') {
    return failure('PLAN_POLICY', `只有 kind=task 的父 step 可以派生 sub-plan（当前 ${parentStep.kind}）`);
  }

  const parentTask = context.parentTaskState;
  if (parentTask === undefined) {
    return failure('PLAN_STATE_INVALID', '父 step task 不存在或尚未物化');
  }
  if (parentTask.status === 'done') {
    // 已接受 child（root 已存在）允许父 task 完成后继续/收尾；新 child 必须父 active。
    if (context.parentTaskAccepted !== true) {
      return failure('PLAN_STATE_INVALID', '父 step task 已 done；新 sub-plan 不能在该父 task 下创建');
    }
  } else if (parentTask.status !== 'queued' && parentTask.status !== 'claimed' && parentTask.status !== 'running') {
    return failure('PLAN_STATE_INVALID', `父 step task 已失败，不能派生或继续 sub-plan：${parentTask.status}`);
  }
  if (parentTask.to.device !== plan.owner.device || parentTask.to.agent !== plan.owner.agent) {
    return failure('PLAN_POLICY', '父 step task 的分配对象必须等于 sub-plan owner');
  }

  const parentPolicy = effectiveParentPolicy(parent.policy);
  const childPolicy = effectiveChildPolicy(plan.policy, parentPolicy);
  if (childPolicy === null) return failure('PLAN_POLICY', '子 plan policy 不得放宽父 plan');
  plan.policy = childPolicy;
  if (plan.budget.maxSteps > parent.budget.maxSteps) {
    return failure('PLAN_BUDGET', '子 plan budget.maxSteps 不得大于父 plan');
  }
  if (context.parentStepBudget === undefined) {
    return failure('PLAN_STATE_INVALID', '父 step task 不存在或尚未物化');
  }
  const required = plan.budget.maxSteps + 1;
  if (context.parentStepBudget.maxTasks < required) {
    return failure('PLAN_BUDGET', `父 step task 剩余 maxTasks 不足（${context.parentStepBudget.maxTasks} < ${required}）`);
  }
  if (context.parentStepBudget.maxChildren < required) {
    return failure('PLAN_BUDGET', `父 step task 剩余 maxChildren 不足（${context.parentStepBudget.maxChildren} < ${required}）`);
  }
  return null;
}

function effectiveParentPolicy(policy: PlanPolicy): Required<Pick<PlanPolicy, 'maxParallel' | 'allowSubcontract'>> & PlanPolicy {
  return {
    ...policy,
    maxParallel: policy.maxParallel ?? 8,
    allowSubcontract: policy.allowSubcontract ?? false,
  };
}

function effectiveChildPolicy(child: PlanPolicy, parent: PlanPolicy): PlanPolicy | null {
  const parentDevices = parent.allowedDevices;
  const parentAgents = parent.allowedAgents;
  const parentCaps = parent.requireCapabilities ?? [];
  const parentParallel = parent.maxParallel ?? 8;
  const parentSubcontract = parent.allowSubcontract ?? false;

  const devices = child.allowedDevices === undefined
    ? (parentDevices !== undefined ? [...parentDevices] : undefined)
    : child.allowedDevices;
  if (devices !== undefined && parentDevices !== undefined && devices.some((device) => !parentDevices.includes(device))) return null;
  const agents = child.allowedAgents === undefined
    ? (parentAgents !== undefined ? [...parentAgents] : undefined)
    : child.allowedAgents;
  if (agents !== undefined && parentAgents !== undefined && agents.some((agent) => !parentAgents.includes(agent))) return null;
  const caps = child.requireCapabilities === undefined ? [...parentCaps] : child.requireCapabilities;
  if (parentCaps.some((capability) => !caps.includes(capability))) return null;
  const maxParallel = child.maxParallel ?? parentParallel;
  if (maxParallel > parentParallel) return null;
  const allowSubcontract = child.allowSubcontract ?? false;
  if (allowSubcontract && !parentSubcontract) return null;

  return {
    ...(devices !== undefined ? { allowedDevices: uniqueValues(devices) } : {}),
    ...(agents !== undefined ? { allowedAgents: uniqueValues(agents) } : {}),
    ...(caps.length > 0 ? { requireCapabilities: uniqueValues(caps) } : {}),
    maxParallel,
    allowSubcontract,
  };
}

/**
 * 完整 plan 校验（纯函数）：schema → 版本/幂等 → DAG → budget → policy → join → MR →
 * acceptance → reuse。调用方负责把已存在的 plan/task 上下文传入。
 */
export function validatePlan(input: unknown, context: PlanValidationContext = {}): PlanValidationResult {
  const shape = validatePlanShape(input);
  if (!shape.ok) return shape;
  const plan = shape.plan;

  // owner=提交者（device+agent）：必须先于幂等返回，避免别的设备/Agent 重放同一 plan。
  if (context.caller !== undefined
    && (plan.owner.device !== context.caller.device || plan.owner.agent !== context.caller.agent)) {
    return failure('PLAN_POLICY', 'plan owner 必须同时等于提交设备与 Agent');
  }

  const existing = context.existingVersions ?? [];
  const sameVersion = existing.find((entry) => entry.version === plan.version);
  // B10：sub-plan 的父 task 状态/绑定必须先于 dedupe 检查；否则 rootless replay 会绕过
  // late-child 拒绝并在后续补建 root。已接受 child（parentTaskAccepted=true）仍可通过。
  if (sameVersion !== undefined && plan.parent !== undefined) {
    const parentGate = validateParent(plan, context);
    if (parentGate !== null) return parentGate;
  }
  if (sameVersion !== undefined) {
    // existing 可能来自 fixture/旧节点（未规范化）；比较前统一 shape 规范化。
    const sameShape = validatePlanShape(sameVersion);
    const samePlan = sameShape.ok ? normalizePolicyForReplay(sameShape.plan, context) : sameVersion;
    // 子 plan 的 policy 会按父 plan 继承/收紧后落库；replay 时也要用同一规范化比较。
    const replayPlan = normalizePolicyForReplay(plan, context);
    if (canonicalTaskPlan(samePlan) === canonicalTaskPlan(replayPlan)) {
      return { ok: true, plan: samePlan, deduped: true };
    }
    return failure('PLAN_CONFLICT', `planId+version 已存在且内容不同：${plan.planId}#${plan.version}`);
  }

  if (plan.version > 1) {
    const previous = existing.find((entry) => entry.version === plan.version - 1);
    if (previous === undefined) return failure('PLAN_VERSION', `上一版本不存在：${plan.planId}#${plan.version - 1}`);
    if (existing.some((entry) => entry.version > plan.version)) return failure('PLAN_VERSION', 'version 必须单调递增');
    if (plan.retryOfStepId !== undefined) {
      const retryStep = previous.steps.find((step) => step.stepId === plan.retryOfStepId);
      if (retryStep === undefined) return failure('PLAN_VERSION', `retryOfStepId 不在上一版本：${plan.retryOfStepId}`);
      if (retryStep.kind === 'mr') return failure('PLAN_VERSION', 'retryOfStepId 不得指向 MR');
      // attempts = 初始版本 1 + 已存在的显式 retry 版本数 + 本次 retry。
      const nextAttempts = 2 + existing.filter((entry) => entry.retryOfStepId === plan.retryOfStepId).length;
      if (nextAttempts > plan.budget.maxAttemptsPerStep) {
        return failure('PLAN_BUDGET', `step ${plan.retryOfStepId} 重试次数超过 maxAttemptsPerStep`);
      }
    }
  } else if (existing.length > 0) {
    return failure('PLAN_VERSION', 'version=1 已存在更高版本');
  }

  const deps = validateDependencies(plan);
  if (deps !== null) return deps;
  const acyclic = validateAcyclic(plan);
  if (acyclic !== null) return acyclic;
  const acceptance = validateAcceptance(plan);
  if (acceptance !== null) return acceptance;
  const mr = validateMrShape(plan);
  if (mr !== null) return mr;
  const parent = validateParent(plan, context);
  if (parent !== null) return parent;
  const reuse = validateReuse(plan, context);
  if (reuse !== null) return reuse;

  return { ok: true, plan };
}

/** 确定性 plan taskId：root `${planId}#${version}#root`；step `${planId}#${version}#${stepId}`。 */
export function planTaskId(planId: string, version: number, stepId: string): string {
  return `${planId}#${version}#${stepId}`;
}

export function planRootTaskId(planId: string, version: number): string {
  return planTaskId(planId, version, 'root');
}

export interface ParsedPlanTaskId {
  planId: string;
  version: number;
  /** `root` 时为 null；否则为 stepId。 */
  stepId: string | null;
  root: boolean;
}

/** 解析 plan-owned taskId；非 plan 命名返回 null（不猜测）。 */
export function parsePlanTaskId(taskId: string): ParsedPlanTaskId | null {
  const first = taskId.indexOf('#');
  if (first <= 0) return null;
  const second = taskId.indexOf('#', first + 1);
  if (second < 0) return null;
  if (taskId.indexOf('#', second + 1) >= 0) return null;
  const planId = taskId.slice(0, first);
  const versionText = taskId.slice(first + 1, second);
  const stepId = taskId.slice(second + 1);
  if (!PLAN_ID_PATTERN.test(planId) || !PLAN_VERSION_PATTERN.test(versionText)) return null;
  const version = Number(versionText);
  if (!Number.isSafeInteger(version) || version < 1) return null;
  if (stepId === 'root') return { planId, version, stepId: null, root: true };
  if (!PLAN_STEP_ID_PATTERN.test(stepId)) return null;
  return { planId, version, stepId, root: false };
}

/** acceptance 的最小确定性求值（只读 resultRef；P4 可扩展证据类型）。 */
export function acceptancePasses(acceptance: PlanAcceptance, resultRef: string | undefined): boolean {
  if (acceptance.kind === 'mr-once') return typeof resultRef === 'string' && resultRef.length > 0;
  const text = resultRef ?? '';
  const bytes = Buffer.byteLength(text, 'utf-8');
  if (bytes < (acceptance.minBytes ?? 1)) return false;
  if (acceptance.kind === 'contains') return (acceptance.all ?? []).every((needle) => text.includes(needle));
  return bytes > 0;
}

export type PlanStepProgressStatus = 'pending' | 'blocked' | 'dispatched' | 'done' | 'failed';
export type PlanProgressStatus = 'planned' | 'running' | 'blocked' | 'done' | 'failed' | 'cancelled';

export interface DerivedPlanStep {
  step: PlanStep;
  status: PlanStepProgressStatus;
  via?: 'task' | 'reuse';
  taskId?: string;
  sourceTaskId?: string;
  blockedBy?: string[];
  complete: boolean;
  failed: boolean;
  taskState?: TaskState;
}

interface SubtreeCompletion {
  complete: boolean;
  failed: boolean;
}

function subtreeCompletion(taskId: string, byId: ReadonlyMap<string, TaskState>): SubtreeCompletion {
  const children = new Map<string, string[]>();
  for (const state of byId.values()) {
    const parent = state.trace.causedBy;
    if (parent === undefined) continue;
    const list = children.get(parent);
    if (list) list.push(state.taskId);
    else children.set(parent, [state.taskId]);
  }
  let complete = true;
  let failed = false;
  const stack = [...(children.get(taskId) ?? [])];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const state = byId.get(id);
    if (state === undefined) continue;
    if (!state.terminal) complete = false;
    else if (state.status !== 'done') failed = true;
    for (const child of children.get(id) ?? []) stack.push(child);
  }
  return { complete, failed };
}

function stepDependsOnView(step: PlanStep, byId: ReadonlyMap<string, TaskState>, plan: TaskPlan, memo: Map<string, DerivedPlanStep>): DerivedPlanStep[] {
  return step.dependsOn.map((dep) => {
    const existing = memo.get(dep);
    if (existing !== undefined) return existing;
    const depStep = plan.steps.find((candidate) => candidate.stepId === dep);
    if (depStep === undefined) {
      return {
        step: { stepId: dep, kind: 'task', intent: '', dependsOn: [], acceptance: { kind: 'non-empty-result' } },
        status: 'failed',
        blockedBy: ['MISSING_DEP'],
        complete: false,
        failed: true,
      };
    }
    return deriveOneStep(plan, depStep, byId, memo);
  });
}

function deriveOneStep(
  plan: TaskPlan,
  step: PlanStep,
  byId: ReadonlyMap<string, TaskState>,
  memo: Map<string, DerivedPlanStep>,
): DerivedPlanStep {
  const existing = memo.get(step.stepId);
  if (existing !== undefined) return existing;
  // DAG 已在写入前校验；这里用占位防递归（异常 plan 不崩溃）。
  const placeholder: DerivedPlanStep = { step, status: 'pending', complete: false, failed: false };
  memo.set(step.stepId, placeholder);

  const taskId = planTaskId(plan.planId, plan.version, step.stepId);
  const taskState = byId.get(taskId);
  const deps = stepDependsOnView(step, byId, plan, memo);

  if (step.reuse !== undefined) {
    const oldTaskId = planTaskId(plan.planId, step.reuse.version, step.stepId);
    const oldTask = byId.get(oldTaskId);
    if (oldTask !== undefined && oldTask.status === 'done' && acceptancePasses(step.acceptance, oldTask.resultRef)) {
      const result: DerivedPlanStep = {
        step,
        status: 'done',
        via: 'reuse',
        sourceTaskId: oldTaskId,
        complete: true,
        failed: false,
        taskState: oldTask,
      };
      memo.set(step.stepId, result);
      return result;
    }
    const depFailure = deps.find((dep) => dep.failed);
    const blockedBy = depFailure !== undefined
      ? [depFailure.step.stepId]
      : deps.filter((dep) => !dep.complete).map((dep) => dep.step.stepId);
    if (depFailure === undefined && blockedBy.length === 0) blockedBy.push('REUSE_NOT_READY');
    const result: DerivedPlanStep = {
      step,
      status: depFailure !== undefined ? 'failed' : 'pending',
      ...(blockedBy.length > 0 ? { blockedBy } : {}),
      complete: false,
      failed: depFailure !== undefined,
      ...(oldTask !== undefined ? { taskState: oldTask } : {}),
    };
    memo.set(step.stepId, result);
    return result;
  }

  if (taskState !== undefined) {
    const subtree = subtreeCompletion(taskId, byId);
    if (taskState.status === 'failed' || subtree.failed) {
      const result: DerivedPlanStep = {
        step,
        status: 'failed',
        via: 'task',
        taskId,
        ...(taskState.status === 'failed' && taskState.reason !== undefined ? { blockedBy: [taskState.reason] } : {}),
        complete: false,
        failed: true,
        taskState,
      };
      memo.set(step.stepId, result);
      return result;
    }
    if (taskState.status === 'done') {
      if (!subtree.complete) {
        const result: DerivedPlanStep = {
          step,
          status: 'dispatched',
          via: 'task',
          taskId,
          complete: false,
          failed: false,
          taskState,
        };
        memo.set(step.stepId, result);
        return result;
      }
      if (!acceptancePasses(step.acceptance, taskState.resultRef)) {
        const result: DerivedPlanStep = {
          step,
          status: 'failed',
          via: 'task',
          taskId,
          blockedBy: ['ACCEPTANCE_FAILED'],
          complete: false,
          failed: true,
          taskState,
        };
        memo.set(step.stepId, result);
        return result;
      }
      const result: DerivedPlanStep = {
        step,
        status: 'done',
        via: 'task',
        taskId,
        complete: true,
        failed: false,
        taskState,
      };
      memo.set(step.stepId, result);
      return result;
    }
    const result: DerivedPlanStep = {
      step,
      status: 'dispatched',
      via: 'task',
      taskId,
      complete: false,
      failed: false,
      taskState,
    };
    memo.set(step.stepId, result);
    return result;
  }

  const failedDep = deps.find((dep) => dep.failed);
  if (failedDep !== undefined) {
    const result: DerivedPlanStep = {
      step,
      status: 'failed',
      blockedBy: [failedDep.step.stepId],
      complete: false,
      failed: true,
    };
    memo.set(step.stepId, result);
    return result;
  }
  const unmet = deps.filter((dep) => !dep.complete).map((dep) => dep.step.stepId).sort();
  if (unmet.length > 0) {
    const result: DerivedPlanStep = {
      step,
      status: 'pending',
      blockedBy: unmet,
      complete: false,
      failed: false,
    };
    memo.set(step.stepId, result);
    return result;
  }
  if (step.kind === 'join' || step.kind === 'reduce' || step.kind === 'mr') {
    // P2 不创建 join/reduce/mr task（P4）；不伪造完成。
    const result: DerivedPlanStep = {
      step,
      status: 'blocked',
      blockedBy: [],
      complete: false,
      failed: false,
    };
    memo.set(step.stepId, result);
    return result;
  }
  if (step.to === undefined) {
    const result: DerivedPlanStep = {
      step,
      status: 'blocked',
      blockedBy: ['NO_TARGET'],
      complete: false,
      failed: false,
    };
    memo.set(step.stepId, result);
    return result;
  }
  if (!stepTargetAllowed(plan, step.to)) {
    const result: DerivedPlanStep = {
      step,
      status: 'blocked',
      blockedBy: ['POLICY_DENIED'],
      complete: false,
      failed: false,
    };
    memo.set(step.stepId, result);
    return result;
  }
  const result: DerivedPlanStep = {
    step,
    status: 'pending',
    complete: false,
    failed: false,
  };
  memo.set(step.stepId, result);
  return result;
}

function stepTargetAllowed(plan: TaskPlan, to: FleetEndpoint): boolean {
  if (plan.policy.allowedDevices !== undefined && !plan.policy.allowedDevices.includes(to.device)) return false;
  if (plan.policy.allowedAgents !== undefined && !plan.policy.allowedAgents.includes(to.agent)) return false;
  return true;
}

/** 只派生 step 视图（materializer 用；不含 plan 级汇总）。 */
export function derivePlanSteps(plan: TaskPlan, states: readonly TaskState[]): DerivedPlanStep[] {
  const byId = new Map(states.map((state) => [state.taskId, state]));
  const memo = new Map<string, DerivedPlanStep>();
  return plan.steps.map((step) => deriveOneStep(plan, step, byId, memo));
}

export interface PlanStepProgress {
  stepId: string;
  status: PlanStepProgressStatus;
  via?: 'task' | 'reuse';
  taskId?: string;
  sourceTaskId?: string;
  blockedBy?: string[];
}

export interface PlanProgress {
  planId: string;
  version: number;
  rootTaskId: string;
  status: PlanProgressStatus;
  steps: PlanStepProgress[];
  blockedBy: string[];
  mr: { applicable?: false; submitted: boolean };
}

function stepProgress(derived: DerivedPlanStep): PlanStepProgress {
  return {
    stepId: derived.step.stepId,
    status: derived.status,
    ...(derived.via !== undefined ? { via: derived.via } : {}),
    ...(derived.taskId !== undefined ? { taskId: derived.taskId } : {}),
    ...(derived.sourceTaskId !== undefined ? { sourceTaskId: derived.sourceTaskId } : {}),
    ...(derived.blockedBy !== undefined && derived.blockedBy.length > 0 ? { blockedBy: derived.blockedBy } : {}),
  };
}

/** 从 plan + task 事件派生 plan 进度；plan 节点不被改写。 */
export function derivePlanProgress(
  plan: TaskPlan,
  states: readonly TaskState[],
  versions: readonly TaskPlan[] = [plan],
): PlanProgress {
  const byId = new Map(states.map((state) => [state.taskId, state]));
  const derived = derivePlanSteps(plan, states);
  const rootTaskId = planRootTaskId(plan.planId, plan.version);
  const root = byId.get(rootTaskId);
  const stepViews = derived.map(stepProgress);
  const blockedBy = uniqueSorted(derived.flatMap((entry) => entry.blockedBy ?? []));
  const anyFailed = derived.some((entry) => entry.failed);
  const anyDispatched = derived.some((entry) => entry.status === 'dispatched');
  const anyBlocked = derived.some((entry) => entry.status === 'blocked');
  const hasStepTask = plan.steps.some((step) => byId.has(planTaskId(plan.planId, plan.version, step.stepId)));
  const mrTaskSubmitted = versions.some((version) => {
    const mrStep = version.steps.find((step) => step.kind === 'mr');
    return mrStep !== undefined && byId.has(planTaskId(plan.planId, version.version, mrStep.stepId));
  });
  const mr = plan.parent === undefined
    ? { submitted: mrTaskSubmitted }
    : { applicable: false as const, submitted: false };

  // 优先级固定：cancelled/failed > done > planned（root 仍 queued 且无 step task）
  // > blocked（root 已推进但有 ready step 被阻塞）> running。
  let status: PlanProgressStatus;
  if (root?.status === 'failed' && root.reason === 'CANCELLED') {
    status = 'cancelled';
  } else if (root?.status === 'failed' || anyFailed) {
    status = 'failed';
  } else if (plan.parent === undefined) {
    // Root plan 只有 MR 完成才 done（MR 执行属 P4；P2 不伪造完成）。
    const mrStep = derived.find((entry) => entry.step.kind === 'mr');
    if (root?.status === 'done' && mrStep?.complete === true) status = 'done';
    else if (root === undefined) status = 'planned';
    else if (root.status === 'queued' && !hasStepTask) status = 'planned';
    else if (anyBlocked && !anyDispatched) status = 'blocked';
    else status = 'running';
  } else {
    const dependents = new Set(plan.steps.flatMap((step) => step.dependsOn));
    const sinks = plan.steps.filter((step) => !dependents.has(step.stepId));
    const sink = sinks.length === 1 ? derived.find((entry) => entry.step.stepId === sinks[0]!.stepId) : undefined;
    if (root?.status === 'done' && sink?.complete === true) status = 'done';
    else if (root === undefined) status = 'planned';
    else if (root.status === 'queued' && !hasStepTask) status = 'planned';
    else if (anyBlocked && !anyDispatched) status = 'blocked';
    else status = 'running';
  }

  return {
    planId: plan.planId,
    version: plan.version,
    rootTaskId,
    status,
    steps: stepViews,
    blockedBy,
    mr,
  };
}
