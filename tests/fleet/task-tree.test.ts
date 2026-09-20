// W1 任务树：预算递减 / 链长越界 / root-only / 确定性摊派（纯函数 + 夹具）。
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  admitCreated,
  remainingBudget,
  treeViolations,
  deterministicTarget,
  effectiveBudget,
} from '../../packages/fleet/src/index.js';
import { reduceTaskEvents } from '../../packages/fleet/src/model.js';
import { validateTaskEvent, type TaskEvent } from '../../packages/fleet/src/protocol/events.js';
import type { TaskBudget, TaskDispatch } from '../../packages/fleet/src/protocol/envelope.js';

function created(
  taskId: string,
  opts: { causedBy?: string; chain?: string[]; budget?: TaskBudget; dispatch?: TaskDispatch } = {},
): TaskEvent {
  return {
    v: 1,
    eventId: `${taskId}#created`,
    taskId,
    type: 'created',
    actor: { device: 'device-B', agent: 'worker' },
    at: 0,
    toStatus: 'queued',
    trace: { ...(opts.causedBy !== undefined ? { causedBy: opts.causedBy } : {}), chain: opts.chain ?? [] },
    to: { device: 'device-B', agent: 'worker' },
    intent: taskId,
    ...(opts.budget !== undefined ? { budget: opts.budget } : {}),
    ...(opts.dispatch !== undefined ? { dispatch: opts.dispatch } : {}),
  };
}
const state = (e: TaskEvent) => reduceTaskEvents([e])!;

describe('W1 任务树预算与不变式', () => {
  it('预算递减：子预算超过父剩余 → 拒绝（不变式 + 入口）', () => {
    const root = state(created('r', { budget: { maxDepth: 2, maxChildren: 4, maxTasks: 8 } }));
    // maxDepth 2 > 父剩余 1 → 越界
    const bad = created('r~c0', { causedBy: 'r', chain: ['r'], budget: { maxDepth: 2, maxChildren: 4, maxTasks: 7 } });
    expect(admitCreated(bad, [root], reduceTaskEvents)).toEqual({
      ok: false,
      reason: 'BUDGET_EXCEEDED',
      detail: expect.stringContaining('maxDepth'),
    });
    // 合法：maxDepth 1 ≤ 剩余 1
    const good = created('r~c1', { causedBy: 'r', chain: ['r'], budget: { maxDepth: 1, maxChildren: 4, maxTasks: 7 } });
    expect(admitCreated(good, [root], reduceTaskEvents)).toEqual({ ok: true });
    expect(remainingBudget({ maxDepth: 2, maxChildren: 4, maxTasks: 8 })).toEqual({ maxDepth: 1, maxChildren: 4, maxTasks: 7 });
  });

  it('链长越界：深度 > root.maxDepth → 拒绝（入口 + 不变式）', () => {
    const root = state(created('r', { budget: { maxDepth: 1, maxChildren: 4, maxTasks: 8 } }));
    const child = created('r~c0', { causedBy: 'r', chain: ['r'] });
    const childState = state(child);
    // 子(深度1)合法
    expect(admitCreated(child, [root], reduceTaskEvents)).toEqual({ ok: true });
    // 孙(深度2)越界
    const grand = created('r~c0~c0', { causedBy: 'r~c0', chain: ['r', 'r~c0'] });
    expect(admitCreated(grand, [root, childState], reduceTaskEvents).ok).toBe(false);
    const v = treeViolations([root, childState, state(grand)]).find((x) => x.taskId === 'r~c0~c0');
    expect(v?.reason).toBe('CHAIN_TOO_DEEP');
  });

  it('root-only：任何派生被拒', () => {
    const root = state(created('ro', { dispatch: 'root-only', budget: { maxDepth: 3, maxChildren: 4, maxTasks: 8 } }));
    const child = created('ro~c0', { causedBy: 'ro', chain: ['ro'] });
    expect(admitCreated(child, [root], reduceTaskEvents).ok).toBe(false);
    expect(treeViolations([root, state(child)]).some((x) => x.reason === 'ROOT_ONLY')).toBe(true);
  });

  it('夹具一致：task-tree.example.json 的 created 事件合法且预算语义可判定', () => {
    const path = join(process.cwd(), 'packages/fleet/protocol/task-tree.example.json');
    const fixture = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    const root = fixture.root as TaskEvent;
    expect(validateTaskEvent(root).ok).toBe(true);
    expect(root.budget).toEqual({ maxDepth: 2, maxChildren: 4, maxTasks: 8 });
    const within = fixture.childWithinBudget as TaskEvent;
    const over = fixture.childOverBudget as TaskEvent;
    expect(admitCreated(within, [state(root)], reduceTaskEvents)).toEqual({ ok: true });
    expect(admitCreated(over, [state(root)], reduceTaskEvents).ok).toBe(false);
    const roRoot = state(fixture.rootOnlyRoot as TaskEvent);
    expect(admitCreated(fixture.rootOnlyChild as TaskEvent, [roRoot], reduceTaskEvents).ok).toBe(false);
  });

  it('确定性摊派：同 taskId 恒定、与目标顺序无关', () => {
    const targets = ['device-B:echo', 'device-C:echo', 'device-D:echo'];
    const a = deterministicTarget('task-X', targets);
    expect(a).toBe(deterministicTarget('task-X', [...targets].reverse()));
    expect(a).not.toBeNull();
    expect(targets).toContain(a!);
  });

  it('effectiveBudget：未声明时按父剩余递归推导', () => {
    const root = state(created('r', { budget: { maxDepth: 3, maxChildren: 4, maxTasks: 9 } }));
    const c1 = state(created('r~c0', { causedBy: 'r', chain: ['r'] }));
    const c2 = state(created('r~c0~c0', { causedBy: 'r~c0', chain: ['r', 'r~c0'] }));
    const byId = new Map([root, c1, c2].map((s) => [s.taskId, s]));
    expect(effectiveBudget(c1, byId)).toEqual({ maxDepth: 2, maxChildren: 4, maxTasks: 8 });
    expect(effectiveBudget(c2, byId)).toEqual({ maxDepth: 1, maxChildren: 4, maxTasks: 7 });
  });
});
