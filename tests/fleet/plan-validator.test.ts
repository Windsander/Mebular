// P2 plan schema/validator：正负例（DAG、join、MR、sub-plan policy/budget、版本/幂等）。
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  canonicalTaskPlan,
  validatePlan,
  validatePlanShape,
  planTaskId,
  parsePlanTaskId,
  acceptancePasses,
  derivePlanProgress,
  type TaskPlan,
  type TaskState,
} from '../../packages/fleet/src/index.js';

const A = { device: 'device-A', agent: 'planner' };
const B = { device: 'device-B', agent: 'worker' };
const C = { device: 'device-C', agent: 'worker' };

function parentTaskState(overrides: Partial<Pick<TaskState, 'to' | 'status'>> = {}): Pick<TaskState, 'to' | 'status'> {
  return { to: B, status: 'queued', ...overrides };
}

function rootPlan(overrides: Partial<TaskPlan> = {}): TaskPlan {
  return {
    v: 1,
    kind: 'task_plan',
    planId: 'plan-demo-001',
    version: 1,
    owner: A,
    goal: 'demo',
    createdAt: 1,
    budget: { maxSteps: 8, maxAttemptsPerStep: 2 },
    policy: { allowedDevices: ['device-B'], allowedAgents: ['worker'], maxParallel: 2, allowSubcontract: false },
    steps: [
      { stepId: 'collect', kind: 'task', intent: 'collect', dependsOn: [], to: B, acceptance: { kind: 'non-empty-result' } },
      { stepId: 'gate', kind: 'reduce', intent: 'gate', dependsOn: ['collect'], join: { mode: 'all' }, acceptance: { kind: 'non-empty-result' } },
      { stepId: 'mr', kind: 'mr', intent: 'mr', dependsOn: ['gate'], acceptance: { kind: 'mr-once' } },
    ],
    ...overrides,
  };
}

function childPlan(parent: TaskPlan, overrides: Partial<TaskPlan> = {}): TaskPlan {
  return {
    v: 1,
    kind: 'task_plan',
    planId: 'plan-demo-001-child',
    version: 1,
    parent: { planId: parent.planId, version: parent.version, stepId: 'delegate' },
    owner: B,
    goal: 'child',
    createdAt: 2,
    budget: { maxSteps: 2, maxAttemptsPerStep: 1 },
    policy: { allowedDevices: ['device-B'], allowedAgents: ['worker'], requireCapabilities: ['fleet.task'], maxParallel: 1, allowSubcontract: false },
    steps: [
      { stepId: 'work', kind: 'task', intent: 'work', dependsOn: [], to: B, acceptance: { kind: 'non-empty-result' } },
    ],
    ...overrides,
  };
}

function parentPlan(overrides: Partial<TaskPlan> = {}): TaskPlan {
  return rootPlan({
    planId: 'plan-parent-001',
    goal: 'parent',
    policy: {
      allowedDevices: ['device-B', 'device-C'],
      allowedAgents: ['worker'],
      requireCapabilities: ['fleet.task'],
      maxParallel: 2,
      allowSubcontract: true,
    },
    steps: [
      { stepId: 'delegate', kind: 'task', intent: 'delegate', dependsOn: [], to: B, acceptance: { kind: 'non-empty-result' } },
      { stepId: 'gate', kind: 'reduce', intent: 'gate', dependsOn: ['delegate'], join: { mode: 'all' }, acceptance: { kind: 'non-empty-result' } },
      { stepId: 'mr', kind: 'mr', intent: 'mr', dependsOn: ['gate'], acceptance: { kind: 'mr-once' } },
    ],
    ...overrides,
  });
}

describe('P2 plan schema/validator', () => {
  it('合法 root plan：规范化、canonical 忽略 createdAt', () => {
    const plan = rootPlan();
    expect(validatePlanShape(plan)).toMatchObject({ ok: true });
    const a = validatePlan(plan, { caller: A });
    const b = validatePlan(rootPlan({ createdAt: 999 }), { caller: A });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(canonicalTaskPlan(a.plan)).toBe(canonicalTaskPlan(b.plan));
  });

  it('planId / stepId / root 保留字 / 重复 step / 缺依赖 / 环', () => {
    expect(validatePlanShape(rootPlan({ planId: 'bad#id' })).ok).toBe(false);
    expect(validatePlan(rootPlan({
      steps: [
        { stepId: 'root', kind: 'task', intent: 'x', dependsOn: [], acceptance: { kind: 'non-empty-result' } },
        { stepId: 'gate', kind: 'reduce', intent: 'g', dependsOn: [], join: { mode: 'all' }, acceptance: { kind: 'non-empty-result' } },
        { stepId: 'mr', kind: 'mr', intent: 'm', dependsOn: ['gate'], acceptance: { kind: 'mr-once' } },
      ],
    }), { caller: A })).toMatchObject({ ok: false, code: 'PLAN_SCHEMA' });

    const dup = rootPlan({
      steps: [
        { stepId: 'a', kind: 'task', intent: 'a', dependsOn: [], acceptance: { kind: 'non-empty-result' } },
        { stepId: 'a', kind: 'task', intent: 'a2', dependsOn: [], acceptance: { kind: 'non-empty-result' } },
        { stepId: 'gate', kind: 'reduce', intent: 'g', dependsOn: ['a'], join: { mode: 'all' }, acceptance: { kind: 'non-empty-result' } },
        { stepId: 'mr', kind: 'mr', intent: 'm', dependsOn: ['gate'], acceptance: { kind: 'mr-once' } },
      ],
    });
    expect(validatePlan(dup, { caller: A })).toMatchObject({ ok: false, code: 'PLAN_DUP_STEP' });

    const missing = rootPlan({
      steps: [
        { stepId: 'a', kind: 'task', intent: 'a', dependsOn: ['nope'], acceptance: { kind: 'non-empty-result' } },
        { stepId: 'gate', kind: 'reduce', intent: 'g', dependsOn: ['a'], join: { mode: 'all' }, acceptance: { kind: 'non-empty-result' } },
        { stepId: 'mr', kind: 'mr', intent: 'm', dependsOn: ['gate'], acceptance: { kind: 'mr-once' } },
      ],
    });
    expect(validatePlan(missing, { caller: A })).toMatchObject({ ok: false, code: 'PLAN_MISSING_DEP' });

    const cycle = rootPlan({
      steps: [
        { stepId: 'a', kind: 'task', intent: 'a', dependsOn: ['b'], acceptance: { kind: 'non-empty-result' } },
        { stepId: 'b', kind: 'task', intent: 'b', dependsOn: ['a'], acceptance: { kind: 'non-empty-result' } },
        { stepId: 'gate', kind: 'reduce', intent: 'g', dependsOn: ['a'], join: { mode: 'all' }, acceptance: { kind: 'non-empty-result' } },
        { stepId: 'mr', kind: 'mr', intent: 'm', dependsOn: ['gate'], acceptance: { kind: 'mr-once' } },
      ],
    });
    expect(validatePlan(cycle, { caller: A })).toMatchObject({ ok: false, code: 'PLAN_CYCLE' });
  });

  it('join 仅 all；root MR 唯一 sink + join/reduce gate；acceptance', () => {
    const anyGate = rootPlan({
      steps: [
        { stepId: 'collect', kind: 'task', intent: 'c', dependsOn: [], acceptance: { kind: 'non-empty-result' } },
        { stepId: 'gate', kind: 'join', intent: 'g', dependsOn: ['collect'], join: { mode: 'any' as never }, acceptance: { kind: 'non-empty-result' } },
        { stepId: 'mr', kind: 'mr', intent: 'm', dependsOn: ['gate'], acceptance: { kind: 'mr-once' } },
      ],
    });
    expect(validatePlan(anyGate, { caller: A })).toMatchObject({ ok: false, code: 'PLAN_JOIN' });

    const twoSinks = rootPlan({
      steps: [
        { stepId: 'a', kind: 'task', intent: 'a', dependsOn: [], acceptance: { kind: 'non-empty-result' } },
        { stepId: 'gate', kind: 'reduce', intent: 'g', dependsOn: ['a'], join: { mode: 'all' }, acceptance: { kind: 'non-empty-result' } },
        { stepId: 'mr', kind: 'mr', intent: 'm', dependsOn: ['gate'], acceptance: { kind: 'mr-once' } },
        { stepId: 'extra', kind: 'task', intent: 'extra', dependsOn: ['gate'], acceptance: { kind: 'non-empty-result' } },
      ],
    });
    expect(validatePlan(twoSinks, { caller: A })).toMatchObject({ ok: false, code: 'PLAN_MR' });

    const mrGateTask = rootPlan({
      steps: [
        { stepId: 'collect', kind: 'task', intent: 'c', dependsOn: [], acceptance: { kind: 'non-empty-result' } },
        { stepId: 'mr', kind: 'mr', intent: 'm', dependsOn: ['collect'], acceptance: { kind: 'mr-once' } },
      ],
    });
    expect(validatePlan(mrGateTask, { caller: A })).toMatchObject({ ok: false, code: 'PLAN_MR' });

    const badAcceptance = rootPlan({
      steps: [
        { stepId: 'collect', kind: 'task', intent: 'c', dependsOn: [], acceptance: { kind: 'mr-once' } },
        { stepId: 'gate', kind: 'reduce', intent: 'g', dependsOn: ['collect'], join: { mode: 'all' }, acceptance: { kind: 'non-empty-result' } },
        { stepId: 'mr', kind: 'mr', intent: 'm', dependsOn: ['gate'], acceptance: { kind: 'mr-once' } },
      ],
    });
    expect(validatePlan(badAcceptance, { caller: A })).toMatchObject({ ok: false, code: 'PLAN_ACCEPTANCE' });
  });

  it('B7：普通 step to 不得使用 __plan__ sentinel', () => {
    const sentinelStep = rootPlan({
      steps: [
        { stepId: 'collect', kind: 'task', intent: 'collect', dependsOn: [], to: { device: '__plan__', agent: '__plan__' }, acceptance: { kind: 'non-empty-result' } },
        { stepId: 'gate', kind: 'reduce', intent: 'gate', dependsOn: ['collect'], join: { mode: 'all' }, acceptance: { kind: 'non-empty-result' } },
        { stepId: 'mr', kind: 'mr', intent: 'mr', dependsOn: ['gate'], acceptance: { kind: 'mr-once' } },
      ],
    });
    expect(validatePlan(sentinelStep, { caller: A })).toMatchObject({ ok: false, code: 'PLAN_SCHEMA' });
  });

  it('子 plan：禁止 MR、唯一 sink、policy 逐字段衰减、owner、父 step 预算', () => {
    const parent = parentPlan();
    const child = childPlan(parent);
    const ok = validatePlan(child, {
      parentPlan: parent,
      caller: B,
      parentStepBudget: { maxDepth: 3, maxChildren: 3, maxTasks: 3 },
      parentTaskState: parentTaskState(),
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.plan.policy.allowedDevices).toEqual(['device-B']);
      expect(ok.plan.policy.maxParallel).toBe(1);
    }

    const withMr = childPlan(parent, {
      steps: [
        { stepId: 'work', kind: 'task', intent: 'w', dependsOn: [], to: B, acceptance: { kind: 'non-empty-result' } },
        { stepId: 'mr', kind: 'mr', intent: 'm', dependsOn: ['work'], acceptance: { kind: 'mr-once' } },
      ],
    });
    expect(validatePlan(withMr, { parentPlan: parent, caller: B })).toMatchObject({ ok: false, code: 'PLAN_MR' });

    const widen = childPlan(parent, {
      policy: { allowedDevices: ['device-C'], allowedAgents: ['worker'], requireCapabilities: [], maxParallel: 2, allowSubcontract: false },
    });
    expect(validatePlan(widen, { parentPlan: parent, caller: B, parentTaskState: parentTaskState() })).toMatchObject({ ok: false, code: 'PLAN_POLICY' });

    const denySubcontract = validatePlan(childPlan(parent), {
      parentPlan: parentPlan({ policy: { ...parent.policy, allowSubcontract: false } }),
      caller: B,
    });
    expect(denySubcontract).toMatchObject({ ok: false, code: 'PLAN_POLICY' });

    const wrongOwner = validatePlan(childPlan(parent, { owner: { device: 'device-C', agent: 'worker' } }), {
      parentPlan: parent,
      caller: B,
    });
    expect(wrongOwner).toMatchObject({ ok: false, code: 'PLAN_POLICY' });

    // B1：同一 device、不同 agent 也不得提交/重放。
    const sameDeviceWrongAgent = validatePlan(childPlan(parent, { owner: { device: 'device-B', agent: 'other' } }), {
      parentPlan: parent,
      caller: B,
      parentStepBudget: { maxDepth: 3, maxChildren: 3, maxTasks: 3 },
    });
    expect(sameDeviceWrongAgent).toMatchObject({ ok: false, code: 'PLAN_POLICY' });

    const overBudget = validatePlan(childPlan(parent, { budget: { maxSteps: 9, maxAttemptsPerStep: 1 } }), {
      parentPlan: parent,
      caller: B,
      parentTaskState: parentTaskState(),
    });
    expect(overBudget).toMatchObject({ ok: false, code: 'PLAN_BUDGET' });

    const tooSmall = validatePlan(childPlan(parent), {
      parentPlan: parent,
      caller: B,
      parentStepBudget: { maxDepth: 3, maxChildren: 2, maxTasks: 2 },
      parentTaskState: parentTaskState(),
    });
    expect(tooSmall).toMatchObject({ ok: false, code: 'PLAN_BUDGET' });

    // 子 plan 省略 policy 字段时按父 plan 继承后落库；replay 仍需幂等。
    const minimal = childPlan(parent, { policy: {} });
    const budget = { maxDepth: 3, maxChildren: 3, maxTasks: 3 };
    const first = validatePlan(minimal, { parentPlan: parent, caller: B, parentStepBudget: budget, parentTaskState: parentTaskState() });
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.plan.policy).toMatchObject({
        allowedDevices: ['device-B', 'device-C'],
        allowedAgents: ['worker'],
        maxParallel: 2,
        allowSubcontract: false,
      });
      const replay = validatePlan(minimal, { parentPlan: parent, caller: B, parentStepBudget: budget, parentTaskState: parentTaskState(), existingVersions: [first.plan] });
      expect(replay.ok).toBe(true);
      if (replay.ok) expect(replay.deduped).toBe(true);
    }

    // B6：父 step task 未物化（无 parentStepBudget）→ 拒绝，不创建 plan。
    expect(validatePlan(childPlan(parent), { parentPlan: parent, caller: B }))
      .toMatchObject({ ok: false, code: 'PLAN_STATE_INVALID' });
  });

  it('B8：sub-plan 绑定父 step 的执行者/活动状态/kind', () => {
    const parent = parentPlan();
    const budget = { maxDepth: 3, maxChildren: 3, maxTasks: 3 };
    const base = {
      parentPlan: parent,
      caller: B,
      parentStepBudget: budget,
      parentTaskState: parentTaskState(),
    };
    for (const status of ['queued', 'claimed', 'running'] as const) {
      expect(validatePlan(childPlan(parent), { ...base, parentTaskState: parentTaskState({ status }) }).ok).toBe(true);
    }
    // B9：新 child 的 done 父 task 拒绝；已接受 child 允许 done；failed 始终拒绝。
    expect(validatePlan(childPlan(parent), { ...base, parentTaskState: parentTaskState({ status: 'done' }) }))
      .toMatchObject({ ok: false, code: 'PLAN_STATE_INVALID' });
    expect(validatePlan(childPlan(parent), {
      ...base,
      parentTaskState: parentTaskState({ status: 'done' }),
      parentTaskAccepted: true,
    }).ok).toBe(true);
    expect(validatePlan(childPlan(parent), {
      ...base,
      parentTaskState: parentTaskState({ status: 'failed' }),
      parentTaskAccepted: true,
    })).toMatchObject({ ok: false, code: 'PLAN_STATE_INVALID' });

    // 父 step task 分配给 B，C 提交 child → 拒绝。
    const byC = childPlan(parent, { owner: { device: 'device-C', agent: 'worker' } });
    expect(validatePlan(byC, { ...base, caller: C })).toMatchObject({ ok: false, code: 'PLAN_POLICY' });
    // 父 task 分配对象与 child owner 不一致。
    expect(validatePlan(childPlan(parent), {
      ...base,
      parentTaskState: parentTaskState({ to: { device: 'device-C', agent: 'worker' } }),
    })).toMatchObject({ ok: false, code: 'PLAN_POLICY' });

    for (const kind of ['join', 'reduce', 'mr'] as const) {
      const forbiddenParent: TaskPlan = {
        ...parent,
        steps: parent.steps.map((step) => step.stepId === 'delegate'
          ? { ...step, kind, ...((kind === 'join' || kind === 'reduce') ? { join: { mode: 'all' as const } } : {}) }
          : step),
      };
      expect(validatePlan(childPlan(parent), {
        ...base,
        parentPlan: forbiddenParent,
      })).toMatchObject({ ok: false, code: 'PLAN_POLICY' });
    }

    // B10：同版本 dedupe 也不能绕过父 task 终态检查（rootless replay）。
    const storedChild = childPlan(parent);
    expect(validatePlan(storedChild, {
      ...base,
      existingVersions: [storedChild],
      parentTaskState: parentTaskState({ status: 'done' }),
    })).toMatchObject({ ok: false, code: 'PLAN_STATE_INVALID' });
    expect(validatePlan(storedChild, {
      ...base,
      existingVersions: [storedChild],
      parentTaskState: parentTaskState({ status: 'failed' }),
      parentTaskAccepted: true,
    })).toMatchObject({ ok: false, code: 'PLAN_STATE_INVALID' });
    expect(validatePlan(storedChild, {
      ...base,
      existingVersions: [storedChild],
      parentTaskState: parentTaskState({ status: 'done' }),
      parentTaskAccepted: true,
    })).toMatchObject({ ok: true, deduped: true });
  });

  it('版本：>1 必须 supersedes=version-1 且上一版本存在；同版本冲突/幂等', () => {
    const v1 = rootPlan();
    const v2 = rootPlan({ version: 2, supersedesVersion: 1, retryOfStepId: 'collect', createdAt: 10 });
    expect(validatePlan(v2, { existingVersions: [v1], caller: A }).ok).toBe(true);
    expect(validatePlan(rootPlan({ version: 2, retryOfStepId: 'collect' }), { existingVersions: [v1], caller: A }))
      .toMatchObject({ ok: false, code: 'PLAN_VERSION' });
    expect(validatePlan(v2, { existingVersions: [], caller: A })).toMatchObject({ ok: false, code: 'PLAN_VERSION' });
    expect(validatePlan(rootPlan({ version: 1, supersedesVersion: 0 as never }), { existingVersions: [], caller: A }))
      .toMatchObject({ ok: false, code: 'PLAN_VERSION' });

    // maxAttemptsPerStep=1：首次 retry 就会超过；=2 时第二次 retry 超过。
    const noRetryBudget = rootPlan({ budget: { maxSteps: 8, maxAttemptsPerStep: 1 } });
    const retryOnce = rootPlan({ version: 2, supersedesVersion: 1, retryOfStepId: 'collect', budget: { maxSteps: 8, maxAttemptsPerStep: 1 }, createdAt: 11 });
    expect(validatePlan(retryOnce, { existingVersions: [noRetryBudget], caller: A }))
      .toMatchObject({ ok: false, code: 'PLAN_BUDGET' });
    const twoAttempts = rootPlan({ budget: { maxSteps: 8, maxAttemptsPerStep: 2 } });
    const retry2 = rootPlan({ version: 2, supersedesVersion: 1, retryOfStepId: 'collect', budget: { maxSteps: 8, maxAttemptsPerStep: 2 }, createdAt: 12 });
    expect(validatePlan(retry2, { existingVersions: [twoAttempts], caller: A }).ok).toBe(true);
    const retry3 = rootPlan({ version: 3, supersedesVersion: 2, retryOfStepId: 'collect', budget: { maxSteps: 8, maxAttemptsPerStep: 2 }, createdAt: 13 });
    expect(validatePlan(retry3, { existingVersions: [twoAttempts, retry2], caller: A }))
      .toMatchObject({ ok: false, code: 'PLAN_BUDGET' });

    const replay = validatePlan(rootPlan({ createdAt: 42 }), { existingVersions: [v1], caller: A });
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.deduped).toBe(true);
    expect(validatePlan(rootPlan({ createdAt: 42 }), { existingVersions: [v1], caller: B }))
      .toMatchObject({ ok: false, code: 'PLAN_POLICY' });
    expect(validatePlan(rootPlan({ goal: 'different' }), { existingVersions: [v1], caller: A }))
      .toMatchObject({ ok: false, code: 'PLAN_CONFLICT' });
  });

  it('协议夹具 plan.example.json：valid 通过、invalid 错误码匹配', () => {
    const fixture = JSON.parse(readFileSync(join(process.cwd(), 'packages/fleet/protocol/plan.example.json'), 'utf-8')) as {
      plan: TaskPlan;
      retry: TaskPlan;
      subPlan: { parent: TaskPlan; child: TaskPlan; parentStepTaskBudget: { maxDepth: number; maxChildren: number; maxTasks: number } };
      invalid: Record<string, { expectedError: string; plan?: TaskPlan; parent?: TaskPlan; child?: TaskPlan; parentStepTaskBudget?: { maxDepth: number; maxChildren: number; maxTasks: number } }>;
    };
    expect(validatePlan(fixture.plan, { caller: A }).ok).toBe(true);
    expect(validatePlan(fixture.retry, { existingVersions: [fixture.plan], caller: A }).ok).toBe(true);
    expect(validatePlan(fixture.subPlan.child, {
      parentPlan: fixture.subPlan.parent,
      caller: B,
      parentStepBudget: fixture.subPlan.parentStepTaskBudget,
      parentTaskState: { to: B, status: 'queued' },
    }).ok).toBe(true);
    for (const [name, entry] of Object.entries(fixture.invalid)) {
      const input = entry.plan ?? entry.child!;
      const context = entry.plan === undefined
        ? {
            parentPlan: entry.parent ?? fixture.subPlan.parent,
            caller: B,
            ...(entry.parentStepTaskBudget !== undefined ? { parentStepBudget: entry.parentStepTaskBudget } : {}),
            parentTaskState: { to: B, status: 'queued' as const },
          }
        : { caller: A };
      expect({ name, result: validatePlan(input, context) }).toMatchObject({
        name,
        result: { ok: false, code: entry.expectedError },
      });
    }
  });

  it('mr.submitted 按 kind=mr step 计算，不硬编码 stepId "mr"', () => {
    const plan = rootPlan({
      steps: [
        { stepId: 'collect', kind: 'task', intent: 'c', dependsOn: [], acceptance: { kind: 'non-empty-result' } },
        { stepId: 'gate', kind: 'reduce', intent: 'g', dependsOn: ['collect'], join: { mode: 'all' }, acceptance: { kind: 'non-empty-result' } },
        { stepId: 'ship', kind: 'mr', intent: 'm', dependsOn: ['gate'], acceptance: { kind: 'mr-once' } },
      ],
    });
    const mrState: TaskState = {
      taskId: planTaskId(plan.planId, 1, 'ship'),
      from: A,
      to: B,
      intent: 'm',
      status: 'queued',
      attempts: 0,
      trace: { chain: [] },
      terminal: false,
      lastEventId: 'mr-created',
    };
    expect(derivePlanProgress(plan, [mrState], [plan]).mr).toEqual({ submitted: true });
  });

  it('taskId 解析/acceptance 最小求值', () => {
    expect(parsePlanTaskId('plan-a#2#root')).toEqual({ planId: 'plan-a', version: 2, stepId: null, root: true });
    expect(parsePlanTaskId('plan-a#2#build-ui')).toMatchObject({ stepId: 'build-ui', root: false });
    expect(parsePlanTaskId('task-device-A-123')).toBeNull();
    expect(parsePlanTaskId('plan-a#01#root')).toBeNull();
    expect(planTaskId('plan-a', 2, 'build-ui')).toBe('plan-a#2#build-ui');
    expect(acceptancePasses({ kind: 'non-empty-result' }, 'ok')).toBe(true);
    expect(acceptancePasses({ kind: 'non-empty-result' }, '')).toBe(false);
    expect(acceptancePasses({ kind: 'contains', all: ['API_OK'] }, 'x API_OK y')).toBe(true);
    expect(acceptancePasses({ kind: 'contains', all: ['API_OK'] }, 'no')).toBe(false);
  });
});
