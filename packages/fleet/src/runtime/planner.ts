// 任务派生计划（1d-a 审查 DAG）：worker 执行任务后可按**确定性计划**派生**子任务**。
//
// 计划是纯数据/纯函数，便于夹具驱动与确定性 E2E；子任务以既有 `created` 事件承载，
// `trace.causedBy` 指向父任务、`chain` 为祖先链（禁环由创建守卫保证）。

import type { FleetEndpoint } from '../protocol/envelope.js';
import type { TaskState } from '../model.js';

/** 计划中的一个子任务。 */
export interface PlannedChild {
  intent: string;
  /** 目标端（缺省 = 父任务的 to） */
  to?: FleetEndpoint;
  /** 显式 taskId（缺省 = `<parent>~c<index>`，确定）；**负例**可用它构造环以触发守卫 */
  taskId?: string;
  payloadRef?: string;
}

/** 计划器：由父任务与执行结果派生直接子任务。 */
export interface TaskPlanner {
  plan(state: TaskState, outcome: { ok: boolean; resultRef?: string }): PlannedChild[];
}

/** 确定性子任务 id（无显式 taskId 时使用）。 */
export function childTaskId(parent: string, index: number): string {
  return `${parent}~c${index}`;
}

/** 由 `intent → 子任务[]` 映射构造计划器（缺省 = 无子任务）。 */
export function mapPlanner(plan: Readonly<Record<string, PlannedChild[]>>): TaskPlanner {
  return {
    plan(state) {
      return (plan[state.intent] ?? []).map((child) => ({ ...child }));
    },
  };
}
