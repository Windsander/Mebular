// W1 公平准入（本地、确定性、无墙钟）：收件按 `(from.device, 逻辑序)` 轮转；
// 有其它待处理发送方时，单一发送方**份额 ≤ 50%**；`(来源设备, 目标 Agent)` 准入配额；
// 每 Agent 并发默认 2。全部为纯函数，便于判别性测试与全端一致。

import type { TaskState } from '../model.js';

export interface FairOrderOptions {
  /** 单一发送方份额上限（有其它待处理发送方时）；默认 0.5 */
  shareCap?: number;
}

/**
 * 轮转序：每一步选「已服务次数最少」的发送方（tie：剩余最多 → device 字典序），
 * 组内按 `taskId` 逻辑序。返回 taskId 的确定序。
 */
export function fairOrder(pending: readonly TaskState[], options: FairOrderOptions = {}): string[] {
  const shareCap = options.shareCap ?? 0.5;
  const groups = new Map<string, TaskState[]>();
  for (const state of pending) {
    const list = groups.get(state.from.device);
    if (list) list.push(state);
    else groups.set(state.from.device, [state]);
  }
  for (const list of groups.values()) list.sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));

  const served = new Map<string, number>();
  for (const device of groups.keys()) served.set(device, 0);
  const order: string[] = [];
  const total = pending.length;

  while (order.length < total) {
    const active = [...groups.keys()]
      .filter((d) => (groups.get(d)?.length ?? 0) > 0)
      .sort((a, b) => {
        const sa = served.get(a)!;
        const sb = served.get(b)!;
        if (sa !== sb) return sa - sb;
        const ra = groups.get(a)!.length;
        const rb = groups.get(b)!.length;
        if (ra !== rb) return rb - ra;
        return a < b ? -1 : a > b ? 1 : 0;
      });
    if (active.length === 0) break;
    let pick = active[0]!;
    // 份额上限：若选它会让其份额 > cap 且还有尚未达到同等优先级的其它活跃发送方 → 换下一个
    const cap = shareCap * (order.length + 1);
    if (served.get(pick)! + 1 > cap) {
      const alternative = active.find((d) => served.get(d)! + 1 <= cap);
      if (alternative !== undefined) pick = alternative;
    }
    const list = groups.get(pick)!;
    const next = list.shift()!;
    order.push(next.taskId);
    served.set(pick, served.get(pick)! + 1);
  }
  return order;
}

export interface AgentConcurrencyOptions {
  /** 每个目标 Agent 的并发上限（默认 2；仅本地调度门，无全局账本） */
  perAgent?: number;
  /** `(来源设备, 目标 Agent)` 准入配额（默认 Infinity = 不限） */
  perPair?: number;
}

/**
 * 在某轮内按「目标 Agent 并发 + (来源设备,目标 Agent) 配额」过滤可执行 taskId（保序）。
 * `inFlight` 为已在途/已执行的计数（本地记账；调用方维护）。
 */
export function admitByConcurrency(
  ordered: readonly TaskState[],
  inFlight: { agent: ReadonlyMap<string, number>; pair: ReadonlyMap<string, number> },
  options: AgentConcurrencyOptions = {},
): string[] {
  const perAgent = options.perAgent ?? 2;
  const perPair = options.perPair ?? Number.POSITIVE_INFINITY;
  const agentCount = new Map(inFlight.agent);
  const pairCount = new Map(inFlight.pair);
  const admitted: string[] = [];
  for (const state of ordered) {
    const agent = state.to.agent;
    const pair = `${state.from.device}->${agent}`;
    if ((agentCount.get(agent) ?? 0) >= perAgent) continue;
    if ((pairCount.get(pair) ?? 0) >= perPair) continue;
    agentCount.set(agent, (agentCount.get(agent) ?? 0) + 1);
    pairCount.set(pair, (pairCount.get(pair) ?? 0) + 1);
    admitted.push(state.taskId);
  }
  return admitted;
}
