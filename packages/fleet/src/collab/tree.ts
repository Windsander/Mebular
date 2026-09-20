// W1 任务树：**预算随树单调递减** + 链长/派发策略不变式 + 确定性摊派。
//
// 纯函数、无墙钟：同一批 `TaskState` 在任何端得到同一判定（全端一致）。
// 入口（node/worker 接收 `created`）与 reducer 不变式共用 `admitCreated` / `treeViolations`。

import type { TaskState } from '../model.js';
import type { TaskEvent } from '../protocol/events.js';
import { DEFAULT_ROOT_BUDGET, type TaskBudget, type TaskDispatch } from '../protocol/envelope.js';

export type TreeViolationReason =
  | 'BUDGET_EXCEEDED'
  | 'CHAIN_TOO_DEEP'
  | 'TOO_MANY_CHILDREN'
  | 'TOO_MANY_TASKS'
  | 'ROOT_ONLY';

export interface TreeViolation {
  taskId: string;
  reason: TreeViolationReason;
  detail?: string;
}

/** 父任务的“剩余预算”：每下一层 `maxDepth`/`maxTasks` 各减一（越深越小）。 */
export function remainingBudget(parent: TaskBudget): TaskBudget {
  return {
    maxDepth: Math.max(0, parent.maxDepth - 1),
    maxChildren: parent.maxChildren,
    maxTasks: Math.max(0, parent.maxTasks - 1),
  };
}

/** 子任务**实际生效**预算：声明值优先；未声明则按父剩余推导；root 无声明用默认。 */
export function effectiveBudget(state: TaskState, byId: ReadonlyMap<string, TaskState>, seen = new Set<string>()): TaskBudget {
  if (state.budget !== undefined) return state.budget;
  const parentId = state.trace.causedBy;
  if (parentId === undefined) return DEFAULT_ROOT_BUDGET;
  const parent = byId.get(parentId);
  if (parent === undefined || seen.has(parentId)) return DEFAULT_ROOT_BUDGET;
  seen.add(state.taskId);
  return remainingBudget(effectiveBudget(parent, byId, seen));
}

/** 深度（祖先数）：root=0；按 `causedBy` 递归（带环保护）。 */
export function depthOf(state: TaskState, byId: ReadonlyMap<string, TaskState>, seen = new Set<string>()): number {
  const parentId = state.trace.causedBy;
  if (parentId === undefined) return 0;
  if (seen.has(state.taskId)) return 0;
  const parent = byId.get(parentId);
  if (parent === undefined) return 1; // 父不在集合（尚未到达）：按一层看待
  seen.add(state.taskId);
  return 1 + depthOf(parent, byId, seen);
}

/** root 派发策略：沿 `causedBy` 找到 root 的 `dispatch`（缺省 `children-ok`）。 */
export function rootDispatch(state: TaskState, byId: ReadonlyMap<string, TaskState>): TaskDispatch {
  let current: TaskState | undefined = state;
  const seen = new Set<string>();
  while (current !== undefined && !seen.has(current.taskId)) {
    seen.add(current.taskId);
    if (current.trace.causedBy === undefined) return current.dispatch ?? 'children-ok';
    current = byId.get(current.trace.causedBy);
  }
  return 'children-ok';
}

function subtreeSize(rootId: string, childrenOf: ReadonlyMap<string, string[]>): number {
  let n = 0;
  const stack = [rootId];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    n += 1;
    for (const child of childrenOf.get(id) ?? []) stack.push(child);
  }
  return n;
}

/** 全树不变式：返回违规列表（按 taskId 确定序；空 = 全部合法）。 */
export function treeViolations(states: readonly TaskState[]): TreeViolation[] {
  const byId = new Map(states.map((s) => [s.taskId, s]));
  const childrenOf = new Map<string, string[]>();
  for (const s of states) {
    const parent = s.trace.causedBy;
    if (parent === undefined) continue;
    const list = childrenOf.get(parent);
    if (list) list.push(s.taskId);
    else childrenOf.set(parent, [s.taskId]);
  }
  for (const list of childrenOf.values()) list.sort();

  const violations: TreeViolation[] = [];
  for (const state of [...states].sort((a, b) => (a.taskId < b.taskId ? -1 : 1))) {
    const parentId = state.trace.causedBy;
    if (parentId === undefined) continue; // root：默认预算已上界，无需逐条判定
    const parent = byId.get(parentId);
    if (parent === undefined) continue; // 父未知：无法判定（到达后重估）
    const parentEff = effectiveBudget(parent, byId);
    const remain = remainingBudget(parentEff);
    const childEff = effectiveBudget(state, byId);
    if (childEff.maxDepth > remain.maxDepth || childEff.maxTasks > remain.maxTasks || childEff.maxChildren > remain.maxChildren) {
      violations.push({ taskId: state.taskId, reason: 'BUDGET_EXCEEDED', detail: `${JSON.stringify(childEff)} > ${JSON.stringify(remain)}` });
    }
    const rootState = rootOf(state, byId);
    const rootEff = rootState !== undefined ? effectiveBudget(rootState, byId) : DEFAULT_ROOT_BUDGET;
    if (depthOf(state, byId) > rootEff.maxDepth) {
      violations.push({ taskId: state.taskId, reason: 'CHAIN_TOO_DEEP', detail: `depth=${depthOf(state, byId)} > ${rootEff.maxDepth}` });
    }
    if (rootDispatch(state, byId) === 'root-only') {
      violations.push({ taskId: state.taskId, reason: 'ROOT_ONLY', detail: 'dispatch=root-only' });
    }
    const direct = childrenOf.get(parentId)?.length ?? 0;
    if (direct > parentEff.maxChildren) {
      violations.push({ taskId: parentId, reason: 'TOO_MANY_CHILDREN', detail: `${direct} > ${parentEff.maxChildren}` });
    }
  }
  // 子树总量：对每个 root 检查
  for (const s of states) {
    if (s.trace.causedBy !== undefined) continue;
    const eff = effectiveBudget(s, byId);
    const size = subtreeSize(s.taskId, childrenOf);
    if (size > eff.maxTasks) violations.push({ taskId: s.taskId, reason: 'TOO_MANY_TASKS', detail: `${size} > ${eff.maxTasks}` });
  }
  // 去重（同一 taskId+reason）
  const seen = new Set<string>();
  return violations.filter((v) => {
    const key = `${v.taskId}|${v.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function rootOf(state: TaskState, byId: ReadonlyMap<string, TaskState>): TaskState | undefined {
  let current: TaskState | undefined = state;
  const seen = new Set<string>();
  while (current !== undefined && !seen.has(current.taskId)) {
    seen.add(current.taskId);
    if (current.trace.causedBy === undefined) return current;
    current = byId.get(current.trace.causedBy);
  }
  return undefined;
}

/**
 * 权威视图的**可采纳任务集**：剔除违反树不变式的任务（越预算/越链长/root-only…）。
 * node/worker 的 `states()` 用它过滤，使经**记忆同步**到达的无效 `created` 也不进入权威视图
 * （与传输入口拒收共用同一纯函数，全端一致）。
 */
export function admissibleTaskIds(states: readonly TaskState[]): Set<string> {
  const bad = new Set(treeViolations(states).map((v) => v.taskId));
  return new Set(states.map((s) => s.taskId).filter((id) => !bad.has(id)));
}

/**
 * 入口准入：把一个候选事件并入后，树不变式是否仍成立（仅 `created` 需判定）。
 * 返回 `{ok:false, reason}` 时，调用方**不得入库**（无效事件）。
 */
export function admitCreated(
  event: TaskEvent,
  states: readonly TaskState[],
  reduceOne: (events: TaskEvent[]) => TaskState | null,
): { ok: true } | { ok: false; reason: TreeViolationReason; detail?: string } {
  if (event.type !== 'created') return { ok: true };
  const state = reduceOne([event]);
  if (state === null) return { ok: false, reason: 'CHAIN_TOO_DEEP', detail: 'created 事件无法归约' };
  const violations = treeViolations([...states, state]).filter((v) => v.taskId === event.taskId);
  if (violations.length === 0) return { ok: true };
  const first = violations[0]!;
  return { ok: false, reason: first.reason, ...(first.detail !== undefined ? { detail: first.detail } : {}) };
}

/** 确定性摊派：等价目标间按 `hash(taskId) mod N`（稳定字典序）。 */
export function deterministicTarget(taskId: string, targets: readonly string[]): string | null {
  if (targets.length === 0) return null;
  const sorted = [...targets].sort();
  let h = 2166136261;
  for (let i = 0; i < taskId.length; i++) {
    h ^= taskId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return sorted[Math.abs(h) % sorted.length]!;
}
