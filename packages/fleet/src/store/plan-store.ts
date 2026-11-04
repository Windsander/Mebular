// P2 plan 节点存储：embedded（本地 Mebular graph）与 daemon（/app/plans）共用同一套
// 创建/版本/幂等语义。plan 是 `tasks` namespace 的 internal 记忆节点：
//   metadata.internal = true, metadata.internalObject.kind = "task_plan"
// 不新增公共 MCP 方法或人类 UI；daemon 端点只服务 fleet 内部 coordinator。

import type { Mebular } from '@mebular/core';
import type { TaskPlan } from '../plan.js';
import {
  PlanValidationError,
  TASK_PLAN_KIND,
  TASK_PLAN_NODE_TYPE,
  canonicalTaskPlan,
  validatePlanShape,
} from '../plan.js';
import { DaemonStoreOptions, readDaemonToken, requestDaemonJson } from './daemon-store.js';

export interface TaskPlanStore {
  list(): Promise<TaskPlan[]>;
  get(planId: string, version: number): Promise<TaskPlan | null>;
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
}

export interface StoredTaskPlan {
  plan: TaskPlan;
  nodeId: string;
}

export interface TaskPlanNodeOptions {
  namespace?: string;
  nodeType?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function planKey(plan: Pick<TaskPlan, 'planId' | 'version'>): string {
  return `${plan.planId}#${plan.version}`;
}

function isTaskPlanNode(node: { type?: string; metadata?: Record<string, unknown> }, nodeType: string): boolean {
  if (node.type !== nodeType) return false;
  const metadata = node.metadata;
  if (!isRecord(metadata) || metadata.internal !== true) return false;
  const internalObject = metadata.internalObject;
  return isRecord(internalObject) && internalObject.kind === TASK_PLAN_KIND;
}

/** 读取 plan 节点（含重复同步副本的确定性合并；同 key 冲突时取规范内容较大者）。 */
export async function listTaskPlanNodes(
  mebular: Pick<Mebular, 'graph'>,
  options: TaskPlanNodeOptions = {},
): Promise<StoredTaskPlan[]> {
  const namespace = options.namespace ?? 'tasks';
  const nodeType = options.nodeType ?? TASK_PLAN_NODE_TYPE;
  const nodes = await mebular.graph.listNodes({ type: nodeType });
  const byKey = new Map<string, StoredTaskPlan>();
  for (const node of nodes) {
    if (node.namespace !== namespace) continue;
    if (!isTaskPlanNode(node, nodeType)) continue;
    const content = node.content;
    if (!isRecord(content)) continue;
    const shape = validatePlanShape(content);
    if (!shape.ok) continue;
    const plan = shape.plan;
    const key = planKey(plan);
    const existing = byKey.get(key);
    if (existing === undefined || canonicalTaskPlan(plan) > canonicalTaskPlan(existing.plan)) {
      byKey.set(key, { plan, nodeId: node.id });
    }
  }
  return [...byKey.values()].sort((a, b) => {
    if (a.plan.planId !== b.plan.planId) return a.plan.planId < b.plan.planId ? -1 : 1;
    return a.plan.version - b.plan.version;
  });
}

export async function listTaskPlans(
  mebular: Pick<Mebular, 'graph'>,
  options: TaskPlanNodeOptions = {},
): Promise<TaskPlan[]> {
  return (await listTaskPlanNodes(mebular, options)).map((entry) => entry.plan);
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
 * 幂等 append：同 planId+version+规范化内容返回已有节点；内容不同 `PLAN_CONFLICT`；
 * version 必须紧邻已存在版本。embedded 与 daemon 端点都走这里。
 */
export async function appendTaskPlanNode(
  mebular: Pick<Mebular, 'graph'>,
  input: unknown,
  options: TaskPlanNodeOptions = {},
): Promise<PlanAppendResult> {
  const shape = validatePlanShape(input);
  if (!shape.ok) throw new PlanValidationError(shape.code, shape.errors);
  const plan = shape.plan;
  return serializePlanWrite(mebular, async () => {
    const existing = await listTaskPlanNodes(mebular, options);
    const same = existing.find((entry) => planKey(entry.plan) === planKey(plan));
    if (same !== undefined) {
      if (canonicalTaskPlan(same.plan) === canonicalTaskPlan(plan)) {
        return { stored: false, replayed: true, plan: same.plan, nodeId: same.nodeId };
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
    return { stored: true, replayed: false, plan, nodeId: node.id };
  });
}

/** embedded（本地 Mebular）plan store。 */
export class MebularTaskPlanStore implements TaskPlanWriteStore {
  private readonly mebular: Pick<Mebular, 'graph'>;
  private readonly options: TaskPlanNodeOptions;

  constructor(mebular: Pick<Mebular, 'graph'>, options: TaskPlanNodeOptions = {}) {
    this.mebular = mebular;
    this.options = { ...options };
  }

  list(): Promise<TaskPlan[]> {
    return listTaskPlans(this.mebular, this.options);
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

interface DaemonPlansReply {
  ok: boolean;
  error?: string;
  errors?: string[];
  count?: number;
  plans?: TaskPlan[];
  replayed?: boolean;
  plan?: TaskPlan;
  nodeId?: string | null;
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

  async list(): Promise<TaskPlan[]> {
    const url = `${this.endpoint}/app/plans?namespace=${encodeURIComponent(this.namespace)}`;
    const { status, json } = await requestDaemonJson<DaemonPlansReply>(url, 'GET', this.token, undefined, this.timeoutMs);
    if (status !== 200 || json.ok !== true) throw new Error(`守护 listPlans 失败（HTTP ${status}）：${json.error ?? '未知'}`);
    return json.plans ?? [];
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
      return {
        stored: json.replayed !== true,
        replayed: json.replayed === true,
        plan: json.plan,
        nodeId: json.nodeId ?? null,
      };
    }
    const code = json.error;
    if (code === 'PLAN_CONFLICT' || code === 'PLAN_VERSION' || code === 'PLAN_SCHEMA'
      || code === 'PLAN_BUDGET' || code === 'PLAN_POLICY' || code === 'PLAN_JOIN'
      || code === 'PLAN_MR' || code === 'PLAN_ACCEPTANCE' || code === 'PLAN_REUSE'
      || code === 'PLAN_DUP_STEP' || code === 'PLAN_MISSING_DEP' || code === 'PLAN_CYCLE') {
      throw new PlanValidationError(code, json.errors ?? []);
    }
    throw new Error(`守护 appendPlan 失败（HTTP ${status}）：${code ?? '未知'}`);
  }

  async close(): Promise<void> {
    // 按需 HTTP；无持久资源。
  }
}
