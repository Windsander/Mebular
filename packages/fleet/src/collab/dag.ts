// Fleet 协作形态 ①：审查 DAG（M4 目标二）。
//
// 任务派生为有向无环图（计划→分派→审查→汇总），父子关系由 `trace.causedBy` 表达。本模块只做
// **纯模型**：由任务状态推导边、禁环（检测 + 创建守卫）、完成判定（从 root 可达的全部节点终态）。
// 不引入调度语义、不触碰 core。

import type { TaskState } from '../model.js';

/** DAG 边：parent → child（child 由 parent 派生）。 */
export interface DagEdge {
  parent: string;
  child: string;
}

/** 由任务状态推导父子边（`child.trace.causedBy → parent`），确定序。 */
export function deriveEdges(states: readonly TaskState[]): DagEdge[] {
  const edges: DagEdge[] = [];
  for (const state of states) {
    const parent = state.trace.causedBy;
    if (parent !== undefined && parent !== state.taskId) edges.push({ parent, child: state.taskId });
  }
  edges.sort((a, b) =>
    a.parent === b.parent ? (a.child < b.child ? -1 : a.child > b.child ? 1 : 0) : a.parent < b.parent ? -1 : 1,
  );
  return edges;
}

/** 检测有向环；返回一条环路径（首尾同节点）或 null。确定序（按节点/邻接字典序 DFS）。 */
export function detectCycle(edges: readonly DagEdge[]): string[] | null {
  const children = new Map<string, string[]>();
  const nodes = new Set<string>();
  for (const edge of edges) {
    nodes.add(edge.parent);
    nodes.add(edge.child);
    const list = children.get(edge.parent);
    if (list) list.push(edge.child);
    else children.set(edge.parent, [edge.child]);
  }
  for (const list of children.values()) list.sort();

  const stateOf = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  let cycle: string[] | null = null;
  const visit = (node: string): boolean => {
    stateOf.set(node, 1);
    stack.push(node);
    for (const child of children.get(node) ?? []) {
      const st = stateOf.get(child) ?? 0;
      if (st === 1) {
        const start = stack.indexOf(child);
        cycle = [...stack.slice(start), child];
        return true;
      }
      if (st === 0 && visit(child)) return true;
    }
    stateOf.set(node, 2);
    stack.pop();
    return false;
  };
  for (const node of [...nodes].sort()) {
    if ((stateOf.get(node) ?? 0) === 0 && visit(node)) break;
  }
  return cycle;
}

/** 新增 `parent → child` 是否会成环（`parent === child`，或 child 已是 parent 的祖先）。 */
export function wouldCreateCycle(edges: readonly DagEdge[], parent: string, child: string): boolean {
  if (parent === child) return true;
  const parentOf = new Map<string, string>();
  for (const edge of edges) parentOf.set(edge.child, edge.parent);
  let current: string | undefined = parent;
  const seen = new Set<string>();
  while (current !== undefined && !seen.has(current)) {
    if (current === child) return true;
    seen.add(current);
    current = parentOf.get(current);
  }
  return false;
}

/** 创建子任务的守卫：成环则抛错（负例测试）。 */
export function assertAcyclicParent(edges: readonly DagEdge[], parent: string, child: string): void {
  if (wouldCreateCycle(edges, parent, child)) {
    throw new Error(`DAG 成环：${parent} → ${child}`);
  }
}

/** 完成判定结果。 */
export interface DagCompletion {
  root: string;
  /** 从 root 可达的全部节点（含 root），字典序 */
  reachable: string[];
  /** 其中尚未终态的节点，字典序 */
  pending: string[];
  /** 全部可达节点终态 = 完成（即所有子任务终态且 root 已汇总为终态） */
  complete: boolean;
}

/** 从 `root` 可达子图的完成判定。 */
export function dagCompletion(
  edges: readonly DagEdge[],
  isTerminal: (id: string) => boolean,
  root: string,
): DagCompletion {
  const children = new Map<string, string[]>();
  for (const edge of edges) {
    const list = children.get(edge.parent);
    if (list) list.push(edge.child);
    else children.set(edge.parent, [edge.child]);
  }
  for (const list of children.values()) list.sort();

  const reachable = new Set<string>();
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (reachable.has(node)) continue;
    reachable.add(node);
    for (const child of children.get(node) ?? []) stack.push(child);
  }
  const sorted = [...reachable].sort();
  const pending = sorted.filter((id) => !isTerminal(id));
  return { root, reachable: sorted, pending, complete: pending.length === 0 };
}
