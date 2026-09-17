// Fleet 随机化不变量 harness（M1）：固定种子、可复现。
//
// 对每组随机任务生命周期断言：
//  - 顺序无关收敛（多次洗牌结果一致）
//  - 幂等（叠加重复事件结果不变；applier 重复投递 applied=false）
//  - 至少一次投递 + 幂等应用（随机顺序应用后终态一致，且每个事件恰好应用一次）
//  - 因果可追（causedBy 指向存在的父任务且在 chain 中）
//  - 墙钟无关（改 at 不改变权威状态）
//  - **oracle-free 扰动**：删掉某终态任务的全部事件，其它任务状态不变

import { describe, it, expect } from '@jest/globals';
import {
  reduceTaskEvents,
  IdempotentTaskApplier,
  isExpiredLocally,
  type TaskEvent,
  type TaskState,
} from '../../packages/fleet/src/index.js';
import { lifecycle, mkEvent, shuffle, mulberry32, endpoint } from './helpers.js';

const SCENARIOS = 300;

function groupByTask(events: readonly TaskEvent[]): Map<string, TaskEvent[]> {
  const map = new Map<string, TaskEvent[]>();
  for (const e of events) {
    const list = map.get(e.taskId);
    if (list) list.push(e);
    else map.set(e.taskId, [e]);
  }
  return map;
}

function statesOf(events: readonly TaskEvent[]): Map<string, TaskState | null> {
  const out = new Map<string, TaskState | null>();
  for (const [taskId, list] of groupByTask(events)) out.set(taskId, reduceTaskEvents(list));
  return out;
}

describe('fleet 随机化不变量（固定种子）', () => {
  it(`${SCENARIOS} 组随机生命周期：顺序无关 / 幂等 / 因果 / 墙钟无关 / 扰动不变`, () => {
    const rng = mulberry32(0xfeef);
    let anomalies = 0;
    let taskCount = 0;
    let sample = '';
    const fail = (msg: string): never => {
      anomalies += 1;
      throw new Error(msg);
    };

    for (let scenario = 0; scenario < SCENARIOS; scenario++) {
      const nTasks = 1 + Math.floor(rng() * 4);
      const taskIds: string[] = [];
      let events: TaskEvent[] = [];
      const parentOf = new Map<string, string>();

      for (let i = 0; i < nTasks; i++) {
        const taskId = `s${scenario}-t${i}`;
        taskIds.push(taskId);
        const claims = 1 + Math.floor(rng() * 3);
        const failTask = rng() < 0.35;
        const expiresAt = rng() < 0.5 ? Math.floor(rng() * 1000) : undefined;
        const parent = taskIds.length > 1 && rng() < 0.5 ? taskIds[Math.floor(rng() * (taskIds.length - 1))]! : undefined;
        const trace = parent !== undefined ? { causedBy: parent, chain: ['root', parent] } : { chain: ['root'] };
        if (parent !== undefined) parentOf.set(taskId, parent);
        const at = Math.floor(rng() * 1_000_000);
        events = events.concat(
          lifecycle(taskId, { fail: failTask, claims, trace, ...(expiresAt !== undefined ? { expiresAt } : {}) }).map((e) => ({ ...e, at })),
        );
      }
      taskCount += nTasks;

      const ref = statesOf(events);
      const refTask0 = reduceTaskEvents(groupByTask(events).get(taskIds[0]!)!);

      // 顺序无关收敛（多次洗牌 + 叠加重复）
      for (let k = 0; k < 3; k++) {
        const perm = statesOf(shuffle(events, rng));
        for (const id of taskIds) {
          const a = JSON.stringify(ref.get(id));
          const b = JSON.stringify(perm.get(id));
          if (a !== b) fail(`顺序无关失败 @scenario ${scenario} task ${id}`);
        }
      }
      const withDups = [...events, ...shuffle(events, rng)];
      for (const id of taskIds) {
        if (JSON.stringify(ref.get(id)) !== JSON.stringify(statesOf(withDups).get(id))) {
          fail(`幂等失败 @scenario ${scenario} task ${id}`);
        }
      }

      // 至少一次 + 幂等应用（随机顺序应用）
      const applier = new IdempotentTaskApplier();
      let applied = 0;
      for (const e of shuffle(events, rng)) {
        if (applier.apply(e).applied) applied += 1;
      }
      if (applied !== new Set(events.map((e) => e.eventId)).size) fail(`应用计数失败 @scenario ${scenario}`);
      for (const id of taskIds) {
        if (JSON.stringify(applier.state(id)) !== JSON.stringify(ref.get(id))) {
          fail(`applier 终态不一致 @scenario ${scenario} task ${id}`);
        }
      }
      // 再次投递全部：不得重复应用
      for (const e of events) if (applier.apply(e).applied) fail(`重复投递被再次应用 @scenario ${scenario}`);

      // 因果可追
      for (const id of taskIds) {
        const st = ref.get(id);
        if (st?.trace.causedBy !== undefined) {
          if (!taskIds.includes(st.trace.causedBy)) fail(`causedBy 指向不存在任务 @scenario ${scenario}`);
          if (!st.trace.chain.includes(st.trace.causedBy)) fail(`chain 缺 causedBy @scenario ${scenario}`);
        }
        void parentOf;
      }

      // 墙钟无关：改 at 不改变权威状态
      const atMutated = events.map((e) => ({ ...e, at: e.at + 777 }));
      for (const id of taskIds) {
        if (JSON.stringify(statesOf(atMutated).get(id)) !== JSON.stringify(ref.get(id))) {
          fail(`墙钟影响了权威状态 @scenario ${scenario} task ${id}`);
        }
      }
      // isExpiredLocally 只影响展示（不抛错即可；其值随 now 变化而状态不变）
      void isExpiredLocally(refTask0?.expiresAt, 0);

      // oracle-free 扰动：删掉一个终态任务的全部事件 → 其它任务状态不变
      const terminalId = taskIds.find((id) => ref.get(id)?.terminal);
      if (terminalId !== undefined) {
        const survivors = events.filter((e) => e.taskId !== terminalId);
        const after = statesOf(survivors);
        for (const id of taskIds) {
          if (id === terminalId) continue;
          if (JSON.stringify(after.get(id)) !== JSON.stringify(ref.get(id))) {
            fail(`删除终态任务 ${terminalId} 改变了其它任务 ${id} @scenario ${scenario}`);
            if (!sample) sample = `${terminalId}@${scenario}`;
          }
        }
      }
    }

    // eslint-disable-next-line no-console
    console.log(
      `[fleet-invariants] scenarios=${SCENARIOS} tasks=${taskCount} anomalies=${anomalies}${sample ? ` sample=${sample}` : ''}`,
    );
    expect(anomalies).toBe(0);
    expect(taskCount).toBeGreaterThanOrEqual(SCENARIOS);
  }, 60000);

  it('fixture envelope 事件流可被 reducer 消费（跨夹具一致性）', () => {
    const created = mkEvent('created', 'fx-1', {
      actor: endpoint('device-A', 'planner'),
      to: endpoint('device-B', '*'),
      intent: 'summarize',
      trace: { chain: [] },
    });
    const done = mkEvent('done', 'fx-1', { eventId: 'fx-1#done', payloadRef: 'node-abc123' });
    const state = reduceTaskEvents([done, created])!;
    expect(state.status).toBe('done');
    expect(state.resultRef).toBe('node-abc123');
  });
});
