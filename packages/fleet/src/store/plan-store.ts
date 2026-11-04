// P2 plan 节点存储：embedded（本地 Mebular graph）与 daemon（/app/plans）共用同一套
// 创建/版本/幂等/作者校验语义。plan 是 `tasks` namespace 的 internal 记忆节点：
//   metadata.internal = true, metadata.internalObject.kind = "task_plan"
// 不新增公共 MCP 方法或人类 UI；daemon 端点只服务 fleet 内部 coordinator。

import type { Mebular } from '@mebular/core';
import { validateTaskEvent, type TaskEvent } from '../protocol/events.js';
import { dedupeEvents, reduceTaskEvents, type TaskState } from '../model.js';
import { effectiveBudget } from '../collab/tree.js';
import type { TaskPlan } from '../plan.js';
import {
  PlanValidationError,
  TASK_PLAN_KIND,
  TASK_PLAN_NODE_TYPE,
  canonicalTaskPlan,
  planTaskId,
  validatePlan,
  validatePlanShape,
} from '../plan.js';
import { DaemonStoreOptions, readDaemonToken, requestDaemonJson } from './daemon-store.js';

type PlanGraph = Pick<Mebular, 'graph'>;
type PlanWriter = Pick<Mebular, 'graph' | 'deviceId'>;

export interface TaskPlanStore {
  list(): Promise<TaskPlan[]>;
  get(planId: string, version: number): Promise<TaskPlan | null>;
  /** 作者信息（B2）：daemon/embedded 都保留 node.createdBy。 */
  listStored?(): Promise<StoredTaskPlan[]>;
  close?(): Promise<void>;
}

export interface TaskPlanWriteStore extends TaskPlanStore {
  append(plan: TaskPlan | unknown): Promise<PlanAppendResult>;
}

export interface PlanAppendResult {
  stored: boolean;
  replayed: boolean;
  plan: TaskPlan;
  nodeId: string | null;
  createdBy: string;
}

export interface StoredTaskPlan {
  plan: TaskPlan;
  nodeId: string;
  createdBy: string;
}

export interface TaskPlanNodeOptions {
  namespace?: string;
  nodeType?: string;
}

interface PlanNodeLike {
  id: string;
  type?: string;
  namespace?: string;
  createdBy?: string;
  deletedAt?: number;
  content?: string | Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function planKey(plan: Pick<TaskPlan, 'planId' | 'version'>): string {
  return `${plan.planId}#${plan.version}`;
}

function isTaskPlanNode(node: PlanNodeLike, nodeType: string): boolean {
  if (node.type !== nodeType) return false;
  const metadata = node.metadata;
  if (!isRecord(metadata) || metadata.internal !== true) return false;
  const internalObject = metadata.internalObject;
  return isRecord(internalObject) && internalObject.kind === TASK_PLAN_KIND;
}

/** 读取 plan 节点：过滤 deleted/internal/namespace/作者不等于 owner.device；同 key 取规范内容较大者。 */
export async function listTaskPlanNodes(
  mebular: PlanGraph,
  options: TaskPlanNodeOptions = {},
): Promise<StoredTaskPlan[]> {
  const namespace = options.namespace ?? 'tasks';
  const nodeType = options.nodeType ?? TASK_PLAN_NODE_TYPE;
  const nodes = await mebular.graph.listNodes({ type: nodeType });
  const byKey = new Map<string, StoredTaskPlan>();
  for (const raw of nodes) {
    const node = raw as unknown as PlanNodeLike;
    if (node.deletedAt !== undefined) continue;
    if (node.namespace !== namespace) continue;
    if (!isTaskPlanNode(node, nodeType)) continue;
    const content = node.content;
    if (!isRecord(content)) continue;
    const shape = validatePlanShape(content);
    if (!shape.ok) continue;
    const plan = shape.plan;
    // 节点作者必须等于 plan.owner.device（B2）；否则不是可信 plan。
    if (node.createdBy !== plan.owner.device) continue;
    const key = planKey(plan);
    const existing = byKey.get(key);
    if (existing === undefined || canonicalTaskPlan(plan) > canonicalTaskPlan(existing.plan)) {
      byKey.set(key, { plan, nodeId: node.id, createdBy: node.createdBy });
    }
  }
  return [...byKey.values()].sort((a, b) => {
    if (a.plan.planId !== b.plan.planId) return a.plan.planId < b.plan.planId ? -1 : 1;
    return a.plan.version - b.plan.version;
  });
}

export async function listTaskPlans(
  mebular: PlanGraph,
  options: TaskPlanNodeOptions = {},
): Promise<TaskPlan[]> {
  return (await listTaskPlanNodes(mebular, options)).map((entry) => entry.plan);
}

async function taskStatesOf(mebular: PlanWriter, namespace: string): Promise<TaskState[]> {
  const nodes = await mebular.graph.listNodes({ type: 'task_event' });
  const events: TaskEvent[] = [];
  for (const node of nodes) {
    if (node.deletedAt !== undefined) continue;
    if (node.namespace !== namespace) continue;
    const candidate = node.content;
    if (typeof candidate !== 'object' || candidate === null) continue;
    if (!validateTaskEvent(candidate).ok) continue;
    events.push(candidate as unknown as TaskEvent);
  }
  const byTask = new Map<string, TaskEvent[]>();
  for (const event of dedupeEvents(events)) {
    const list = byTask.get(event.taskId);
    if (list) list.push(event);
    else byTask.set(event.taskId, [event]);
  }
  return [...byTask.keys()].sort()
    .map((taskId) => reduceTaskEvents(byTask.get(taskId)!))
    .filter((state): state is TaskState => state !== null);
}

// 同进程串行化 plan 写入：list→check→create 不是原子操作；同一 app（MCP live / daemon
// 端点 / CLI）并发提交同版本时按队列串行，后到者命中 replay，不写第二个节点。
const planWriteQueues = new WeakMap<object, Promise<unknown>>();

function serializePlanWrite<T>(key: object, run: () => Promise<T>): Promise<T> {
  const previous = planWriteQueues.get(key) ?? Promise.resolve();
  const next = previous.then(run, run);
  planWriteQueues.set(key, next.catch(() => undefined));
  return next;
}

/**
 * shape + 作者 + 版本幂等 append。完整 plan 语义校验见 appendValidatedTaskPlanNode；
 * submitTaskPlan 已先做完整校验，此处仍校验节点作者（B2）。
 */
export async function appendTaskPlanNode(
  mebular: PlanWriter,
  input: unknown,
  options: TaskPlanNodeOptions = {},
): Promise<PlanAppendResult> {
  const shape = validatePlanShape(input);
  if (!shape.ok) throw new PlanValidationError(shape.code, shape.errors);
  const plan = shape.plan;
  if (plan.owner.device !== mebular.deviceId) {
    throw new PlanValidationError('PLAN_POLICY', [
      `plan.owner.device 必须是写入设备：${plan.owner.device} != ${mebular.deviceId}`,
    ]);
  }
  return serializePlanWrite(mebular, async () => {
    const existing = await listTaskPlanNodes(mebular, options);
    const same = existing.find((entry) => planKey(entry.plan) === planKey(plan));
    if (same !== undefined) {
      if (canonicalTaskPlan(same.plan) === canonicalTaskPlan(plan)) {
        return { stored: false, replayed: true, plan: same.plan, nodeId: same.nodeId, createdBy: same.createdBy };
      }
      throw new PlanValidationError('PLAN_CONFLICT', [
        `planId+version 已存在且内容不同：${planKey(plan)}`,
      ]);
    }
    const versions = existing.filter((entry) => entry.plan.planId === plan.planId).map((entry) => entry.plan.version);
    const maxVersion = versions.length === 0 ? 0 : Math.max(...versions);
    if (plan.version <= maxVersion) {
      throw new PlanValidationError('PLAN_VERSION', [`version 必须单调递增：${planKey(plan)} <= ${maxVersion}`]);
    }
    if (plan.version > 1 && !versions.includes(plan.version - 1)) {
      throw new PlanValidationError('PLAN_VERSION', [`上一版本不存在：${plan.planId}#${plan.version - 1}`]);
    }
    const namespace = options.namespace ?? 'tasks';
    const node = await mebular.graph.createNode(
      options.nodeType ?? TASK_PLAN_NODE_TYPE,
      plan as unknown as Record<string, unknown>,
      [],
      {
        namespace,
        metadata: {
          internal: true,
          internalObject: { kind: TASK_PLAN_KIND },
        },
      },
    );
    return { stored: true, replayed: false, plan, nodeId: node.id, createdBy: mebular.deviceId };
  });
}

/**
 * daemon `/app/plans` 写入路径：完整 validatePlan（existingVersions / parent / taskStates /
 * owner / parentStepBudget）+ 版本幂等。不能只用 shape 校验（B5）。
 */
export async function appendValidatedTaskPlanNode(
  mebular: PlanWriter,
  input: unknown,
  options: TaskPlanNodeOptions = {},
): Promise<PlanAppendResult> {
  const shape = validatePlanShape(input);
  if (!shape.ok) throw new PlanValidationError(shape.code, shape.errors);
  const candidate = shape.plan;
  if (candidate.owner.device !== mebular.deviceId) {
    throw new PlanValidationError('PLAN_POLICY', [
      `plan.owner.device 必须是写入设备：${candidate.owner.device} != ${mebular.deviceId}`,
    ]);
  }
  const namespace = options.namespace ?? 'tasks';
  const existing = await listTaskPlans(mebular, options);
  const versions = existing.filter((plan) => plan.planId === candidate.planId);
  const parentPlan = candidate.parent === undefined
    ? undefined
    : existing.find((plan) => plan.planId === candidate.parent!.planId && plan.version === candidate.parent!.version);
  const taskStates = await taskStatesOf(mebular, namespace);
  const stateById = new Map(taskStates.map((state) => [state.taskId, state]));
  const parentTaskId = candidate.parent === undefined
    ? null
    : planTaskId(candidate.parent.planId, candidate.parent.version, candidate.parent.stepId);
  const parentTask = parentTaskId === null ? undefined : stateById.get(parentTaskId);
  const parentStepBudget = parentTask === undefined ? undefined : effectiveBudget(parentTask, stateById);
  const parentTaskState = parentTask === undefined ? undefined : { to: parentTask.to, status: parentTask.status };

  const validation = validatePlan(candidate, {
    existingVersions: versions,
    ...(parentPlan !== undefined ? { parentPlan } : {}),
    ...(parentStepBudget !== undefined ? { parentStepBudget } : {}),
    ...(parentTaskState !== undefined ? { parentTaskState } : {}),
    taskStates,
    caller: candidate.owner,
  });
  if (!validation.ok) throw new PlanValidationError(validation.code, validation.errors);
  return appendTaskPlanNode(mebular, validation.plan, options);
}

/** embedded（本地 Mebular）plan store。 */
export class MebularTaskPlanStore implements TaskPlanWriteStore {
  private readonly mebular: PlanWriter;
  private readonly options: TaskPlanNodeOptions;

  constructor(mebular: PlanWriter, options: TaskPlanNodeOptions = {}) {
    this.mebular = mebular;
    this.options = { ...options };
  }

  listStored(): Promise<StoredTaskPlan[]> {
    return listTaskPlanNodes(this.mebular, this.options);
  }

  async list(): Promise<TaskPlan[]> {
    return (await this.listStored()).map((entry) => entry.plan);
  }

  async get(planId: string, version: number): Promise<TaskPlan | null> {
    return (await this.list()).find((plan) => plan.planId === planId && plan.version === version) ?? null;
  }

  append(plan: TaskPlan | unknown): Promise<PlanAppendResult> {
    return appendTaskPlanNode(this.mebular, plan, this.options);
  }

  async close(): Promise<void> {
    // 存储生命周期由 Mebular 实例管理。
  }
}

interface DaemonPlanNode {
  id: string;
  type?: string;
  namespace?: string;
  createdBy?: string;
  deletedAt?: number;
  content?: TaskPlan;
  metadata?: Record<string, unknown>;
}

interface DaemonPlansReply {
  ok: boolean;
  error?: string;
  errors?: string[];
  count?: number;
  plans?: TaskPlan[];
  nodes?: DaemonPlanNode[];
  replayed?: boolean;
  plan?: TaskPlan;
  nodeId?: string | null;
  createdBy?: string;
}

/** daemon（/app/plans）plan store；无本地 Mebular/libp2p。 */
export class DaemonTaskPlanStore implements TaskPlanWriteStore {
  private readonly endpoint: string;
  private readonly namespace: string;
  private readonly token: string | undefined;
  private readonly timeoutMs: number;

  constructor(options: DaemonStoreOptions) {
    if (typeof options.endpoint !== 'string' || options.endpoint.length === 0) {
      throw new Error('DaemonTaskPlanStore 需要 endpoint');
    }
    this.endpoint = options.endpoint.replace(/\/+$/, '');
    this.namespace = options.namespace ?? 'tasks';
    this.token = readDaemonToken(options);
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async listStored(): Promise<StoredTaskPlan[]> {
    const url = `${this.endpoint}/app/plans?namespace=${encodeURIComponent(this.namespace)}`;
    const { status, json } = await requestDaemonJson<DaemonPlansReply>(url, 'GET', this.token, undefined, this.timeoutMs);
    if (status !== 200 || json.ok !== true) throw new Error(`守护 listPlans 失败（HTTP ${status}）：${json.error ?? '未知'}`);
    const out: StoredTaskPlan[] = [];
    for (const node of json.nodes ?? []) {
      if (node.deletedAt !== undefined) continue;
      const content = node.content;
      if (typeof content !== 'object' || content === null) continue;
      const shape = validatePlanShape(content);
      if (!shape.ok) continue;
      const plan = shape.plan;
      // 作者信任：daemon 返回 createdBy，必须等于 owner.device。
      if (node.createdBy !== plan.owner.device) continue;
      out.push({ plan, nodeId: node.id, createdBy: node.createdBy });
    }
    return out.sort((a, b) => {
      if (a.plan.planId !== b.plan.planId) return a.plan.planId < b.plan.planId ? -1 : 1;
      return a.plan.version - b.plan.version;
    });
  }

  async list(): Promise<TaskPlan[]> {
    return (await this.listStored()).map((entry) => entry.plan);
  }

  async get(planId: string, version: number): Promise<TaskPlan | null> {
    return (await this.list()).find((plan) => plan.planId === planId && plan.version === version) ?? null;
  }

  async append(plan: TaskPlan | unknown): Promise<PlanAppendResult> {
    const { status, json } = await requestDaemonJson<DaemonPlansReply>(
      `${this.endpoint}/app/plans`,
      'POST',
      this.token,
      { plan, namespace: this.namespace },
      this.timeoutMs,
    );
    if (status === 200 && json.ok === true && json.plan !== undefined) {
      const returned = json.plan;
      if (json.createdBy !== undefined && json.createdBy !== returned.owner.device) {
        throw new PlanValidationError('PLAN_POLICY', ['daemon 返回的 plan 作者与 owner.device 不一致']);
      }
      return {
        stored: json.replayed !== true,
        replayed: json.replayed === true,
        plan: returned,
        nodeId: json.nodeId ?? null,
        createdBy: json.createdBy ?? returned.owner.device,
      };
    }
    const code = json.error;
    if (code === 'PLAN_CONFLICT' || code === 'PLAN_VERSION' || code === 'PLAN_SCHEMA'
      || code === 'PLAN_BUDGET' || code === 'PLAN_POLICY' || code === 'PLAN_JOIN'
      || code === 'PLAN_MR' || code === 'PLAN_ACCEPTANCE' || code === 'PLAN_REUSE'
      || code === 'PLAN_DUP_STEP' || code === 'PLAN_MISSING_DEP' || code === 'PLAN_CYCLE'
      || code === 'PLAN_STATE_INVALID') {
      throw new PlanValidationError(code, json.errors ?? []);
    }
    throw new Error(`守护 appendPlan 失败（HTTP ${status}）：${code ?? '未知'}`);
  }

  async close(): Promise<void> {
    // 按需 HTTP；无持久资源。
  }
}
