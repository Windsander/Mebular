// P2 plan 提交 + materializer：幂等/冲突/root 补建、确定性 taskId、重复 tick、重启、
// root sentinel、旧 worker 执行普通 step task、task_status.plan、PLAN_RETRY_REQUIRED。
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mebular } from '@mebular/core';
import {
  EchoExecutor,
  ExecutionLog,
  FleetWorker,
  MebularTaskEventStore,
  MebularTaskPlanStore,
  NullTransport,
  PlanMaterializer,
  derivePlanProgress,
  loadToolConfig,
  offlineMebularOptions,
  onboardDevice,
  planRootTaskId,
  planTaskId,
  readMasterKeyFile,
  reduceTaskEvents,
  submitTaskPlan,
  toolByName,
  type PlanAppendResult,
  type TaskEvent,
  type TaskPlan,
  type TaskPlanWriteStore,
  type TaskState,
  type ToolContext,
} from '../../packages/fleet/src/index.js';

const A = { device: 'device-A', agent: 'planner' };
const B = { device: 'device-B', agent: 'worker' };
const SENTINEL = { device: '__plan__', agent: '__plan__' };

let dir: string;
let app: Mebular | null = null;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fleet-plan-runtime-'));
  await onboardDevice({ dir, device: 'device-A', agents: [{ name: 'worker', kind: 'echo' }] });
});

afterEach(async () => {
  await app?.shutdown().catch(() => undefined);
  app = null;
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function openApp(): Promise<Mebular> {
  const config = await loadToolConfig(dir);
  const encryption = await readMasterKeyFile(config.masterKeyFile);
  const instance = new Mebular(offlineMebularOptions(config, encryption) as never);
  await instance.initialize();
  app = instance;
  return instance;
}

function plan(overrides: Partial<TaskPlan> = {}): TaskPlan {
  return {
    v: 1,
    kind: 'task_plan',
    planId: 'plan-runtime-001',
    version: 1,
    owner: A,
    goal: 'runtime plan',
    createdAt: 100,
    budget: { maxSteps: 4, maxAttemptsPerStep: 2 },
    policy: {
      allowedDevices: ['device-B'],
      allowedAgents: ['worker'],
      requireCapabilities: ['fleet.task'],
      maxParallel: 2,
      allowSubcontract: false,
    },
    steps: [
      { stepId: 'work', kind: 'task', intent: 'do-work', dependsOn: [], to: B, acceptance: { kind: 'non-empty-result' } },
      { stepId: 'gate', kind: 'reduce', intent: 'gate', dependsOn: ['work'], join: { mode: 'all' }, acceptance: { kind: 'non-empty-result' } },
      { stepId: 'mr', kind: 'mr', intent: 'mr', dependsOn: ['gate'], acceptance: { kind: 'mr-once' } },
    ],
    ...overrides,
  };
}

function ctx(extra: Partial<ToolContext> = {}): ToolContext {
  return { dir, agent: 'planner', ...extra };
}

async function statesOf(store: MebularTaskEventStore): Promise<TaskState[]> {
  const byTask = new Map<string, TaskEvent[]>();
  for (const event of await store.all()) {
    const list = byTask.get(event.taskId);
    if (list) list.push(event);
    else byTask.set(event.taskId, [event]);
  }
  return [...byTask.keys()].sort()
    .map((taskId) => reduceTaskEvents(byTask.get(taskId)!))
    .filter((state): state is TaskState => state !== null);
}

async function submit(planInput: unknown, extra: Partial<ToolContext> = {}): Promise<Record<string, unknown>> {
  return await toolByName('task_submit')!.handler(
    { intent: 'submit plan', to: SENTINEL, plan: planInput },
    ctx(extra),
  ) as Record<string, unknown>;
}

describe('P2 task_submit.plan + materializer', () => {
  it('提交/幂等/PLAN_CONFLICT/确定性 taskId/root sentinel', async () => {
    const p = plan();
    const first = await submit(p);
    expect(first).toMatchObject({
      ok: true,
      planId: p.planId,
      version: 1,
      rootTaskId: planRootTaskId(p.planId, 1),
      taskId: planRootTaskId(p.planId, 1),
      rootTarget: SENTINEL,
    });
    expect(first.deduped).toBeUndefined();

    const replay = await submit(plan({ createdAt: 999 }));
    expect(replay).toMatchObject({ ok: true, deduped: true, rootTaskId: planRootTaskId(p.planId, 1) });

    // B1：同一 device、不同 agent 不能提交/重放。
    const wrongAgent = await submit(plan({ createdAt: 1000 }), { agent: 'other' });
    expect(wrongAgent).toMatchObject({ ok: false, error: 'PLAN_POLICY' });

    const conflict = await submit(plan({ goal: 'different' }));
    expect(conflict).toMatchObject({ ok: false, error: 'PLAN_CONFLICT' });

    const live = await openApp();
    const planStore = new MebularTaskPlanStore(live);
    const plans = await planStore.list();
    expect(plans).toHaveLength(1);
    expect((await planStore.listStored())[0]).toMatchObject({ createdBy: 'device-A' });

    // B2：写入设备 ≠ owner.device 拒绝；作者不匹配的节点不进入 list。
    await expect(planStore.append(plan({ planId: 'plan-author-mismatch-001', owner: B })))
      .rejects.toMatchObject({ code: 'PLAN_POLICY' });
    expect(plans[0]!.steps[0]!.kind).toBe('task');
    const nodes = await live.graph.listNodes({ type: 'task_plan' });
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.metadata).toMatchObject({ internal: true, internalObject: { kind: 'task_plan' } });

    const forged = plan({ planId: 'plan-forged-author-001', owner: B });
    await live.graph.createNode('task_plan', forged as unknown as Record<string, unknown>, [], {
      namespace: 'tasks',
      metadata: { internal: true, internalObject: { kind: 'task_plan' } },
    });
    expect((await planStore.list()).some((entry) => entry.planId === forged.planId)).toBe(false);

    const store = new MebularTaskEventStore(live);
    const rootEvents = await store.byTask(planRootTaskId(p.planId, 1));
    expect(rootEvents).toHaveLength(1);
    expect(rootEvents[0]).toMatchObject({
      eventId: `${planRootTaskId(p.planId, 1)}#created`,
      type: 'created',
      to: SENTINEL,
      dispatch: 'root-only',
      trace: { chain: [] },
    });
    expect((await store.byTask(planTaskId(p.planId, 1, 'work'))).length).toBe(0);
  });

  it('root 缺失补建一次（重复提交返回已有，不重复写 plan/root）', async () => {
    const p = plan({ planId: 'plan-root-repair-001', createdAt: 1 });
    const live = await openApp();
    await new MebularTaskPlanStore(live).append(p);
    expect(await new MebularTaskEventStore(live).byTask(planRootTaskId(p.planId, 1))).toHaveLength(0);
    await live.shutdown();
    app = null;

    const submitted = await submit(p);
    expect(submitted).toMatchObject({ ok: true, deduped: true, rootTaskId: planRootTaskId(p.planId, 1) });
    const replay = await submit(plan({ planId: p.planId, createdAt: 2 }));
    expect(replay).toMatchObject({ ok: true, deduped: true });

    const live2 = await openApp();
    const roots = await new MebularTaskEventStore(live2).byTask(planRootTaskId(p.planId, 1));
    expect(roots).toHaveLength(1);
    expect(roots[0]!.eventId).toBe(`${planRootTaskId(p.planId, 1)}#created`);
    expect(await new MebularTaskPlanStore(live2).list()).toHaveLength(1);
  });

  it('materializer：只建 ready 显式 to step；重复 tick/重启不重复；旧 worker 执行普通 step；root 不可 done', async () => {
    const p = plan({ planId: 'plan-runtime-002' });
    await submit(p);
    const live = await openApp();
    const store = new MebularTaskEventStore(live);
    const plans = new MebularTaskPlanStore(live);
    const materializer = new PlanMaterializer({ device: 'device-A', agent: 'planner', plans, store });
    const log = await ExecutionLog.open(join(dir, 'exec.jsonl'));
    const worker = new FleetWorker({
      device: 'device-B',
      agent: 'worker',
      store,
      transport: new NullTransport(),
      executor: new EchoExecutor(),
      log,
    });

    const first = await materializer.tick();
    expect(first.tasksCreated).toEqual([planTaskId(p.planId, 1, 'work')]);
    expect(first.rootsAdvanced).toBeGreaterThanOrEqual(1);
    const rootId = planRootTaskId(p.planId, 1);
    const workId = planTaskId(p.planId, 1, 'work');
    expect((await store.byTask(workId))[0]).toMatchObject({
      eventId: `${workId}#created`,
      type: 'created',
      to: B,
      trace: { chain: [] },
    });
    expect((await store.byTask(planTaskId(p.planId, 1, 'gate'))).length).toBe(0);
    expect((await store.byTask(planTaskId(p.planId, 1, 'mr'))).length).toBe(0);
    expect(reduceTaskEvents(await store.byTask(rootId))!.status).toBe('running');

    const second = await materializer.tick();
    expect(second.tasksCreated).toEqual([]);
    const allTaskIds = (await store.all()).map((event) => event.taskId);
    expect(allTaskIds.filter((id) => id === workId)).toHaveLength(1);

    // 旧 worker 只看到普通 step task；root sentinel 明确跳过（不写 failed/UNKNOWN_AGENT）。
    await worker.pollOnce();
    await worker.pollOnce();
    expect(reduceTaskEvents(await store.byTask(workId))!.status).toBe('done');
    expect(reduceTaskEvents(await store.byTask(rootId))!.status).toBe('running');
    expect(log.size()).toBe(1);

    await materializer.tick();
    const progress = derivePlanProgress(p, await statesOf(store), [p]);
    const work = progress.steps.find((step) => step.stepId === 'work');
    expect(work).toMatchObject({ status: 'done', via: 'task', taskId: workId });
    expect(progress.steps.find((step) => step.stepId === 'gate')?.status).toBe('blocked');
    expect(progress.status).not.toBe('done');
    expect((await store.byTask(planTaskId(p.planId, 1, 'mr'))).length).toBe(0);

    // task_status.plan：旧 state 保留，plan 进度 additive；plan 节点不被改写。
    const status = await toolByName('task_status')!.handler({ taskId: rootId }, ctx({ mebular: live })) as {
      ok: boolean;
      state: { status: string };
      plan: { status: string; steps: Array<{ stepId: string; status: string }>; mr: { submitted: boolean }; blockedBy: string[] };
    };
    expect(status.ok).toBe(true);
    expect(status.state.status).toBe('running');
    expect(status.plan.status).not.toBe('done');
    expect(status.plan.mr).toEqual({ submitted: false });
    expect(status.plan.steps.find((step) => step.stepId === 'work')?.status).toBe('done');
    expect(status.plan.steps.find((step) => step.stepId === 'mr')?.status).toBe('pending');
    const workStatus = await toolByName('task_status')!.handler({ taskId: workId }, ctx({ mebular: live })) as {
      ok: boolean;
      plan: { planId: string; version: number; steps: Array<{ stepId: string; status: string; via?: string }> };
    };
    expect(workStatus.ok).toBe(true);
    expect(workStatus.plan).toMatchObject({ planId: p.planId, version: 1 });
    expect(workStatus.plan.steps.find((step) => step.stepId === 'work')).toMatchObject({ status: 'done', via: 'task' });
    const planNodesAfter = await live.graph.listNodes({ type: 'task_plan' });
    expect(planNodesAfter).toHaveLength(1);
    expect((planNodesAfter[0]!.content as unknown as TaskPlan).createdAt).toBe(p.createdAt);

    // PLAN_RETRY_REQUIRED：root/step/MR 都不创建新任务；普通 task 旧 retry 不变。
    const before = (await store.all()).length;
    for (const taskId of [
      rootId,
      workId,
      planTaskId(p.planId, 1, 'mr'),
      // B3：plan 节点未同步/不存在也必须 fail closed。
      'plan-missing#1#root',
      'plan-missing#1#work',
      'plan-missing#1#mr',
    ]) {
      const retry = await toolByName('task_retry')!.handler({ taskId }, ctx({ mebular: live })) as Record<string, unknown>;
      expect(retry).toMatchObject({ ok: false, taskId, error: 'PLAN_RETRY_REQUIRED' });
    }
    expect((await store.all()).length).toBe(before);

    const ordinary = await toolByName('task_submit')!.handler(
      { intent: 'plain', to: B },
      ctx({ mebular: live }),
    ) as { ok: boolean; taskId: string };
    expect(ordinary.ok).toBe(true);
    expect(ordinary.taskId).toMatch(/^task-device-A-/);
    await worker.pollOnce();
    expect(reduceTaskEvents(await store.byTask(ordinary.taskId))!.status).toBe('done');
    const ordinaryRetry = await toolByName('task_retry')!.handler({ taskId: ordinary.taskId }, ctx({ mebular: live })) as { ok: boolean; retryOf: string };
    expect(ordinaryRetry).toMatchObject({ ok: true, retryOf: ordinary.taskId });

    // kill/restart：新 materializer 从 plan + task 事件恢复，不重复建 task。
    await worker.close();
    await live.shutdown();
    app = null;
    const live2 = await openApp();
    const store2 = new MebularTaskEventStore(live2);
    const materializer2 = new PlanMaterializer({
      device: 'device-A',
      agent: 'planner',
      plans: new MebularTaskPlanStore(live2),
      store: store2,
    });
    const beforeRestart = (await store2.byTask(workId)).length;
    const afterRestart = await materializer2.tick();
    expect(afterRestart.tasksCreated).toEqual([]);
    expect((await store2.byTask(workId)).length).toBe(beforeRestart);
    expect((await store2.byTask(planTaskId(p.planId, 1, 'gate'))).length).toBe(0);
    expect((await store2.byTask(planTaskId(p.planId, 1, 'mr'))).length).toBe(0);
  });

  it('无显式 to 的 step → blocked，不建 task；plan 进度给出 NO_TARGET', async () => {
    const p = plan({
      planId: 'plan-no-target-001',
      steps: [
        { stepId: 'collect', kind: 'task', intent: 'collect', dependsOn: [], acceptance: { kind: 'non-empty-result' } },
        { stepId: 'gate', kind: 'reduce', intent: 'gate', dependsOn: ['collect'], join: { mode: 'all' }, acceptance: { kind: 'non-empty-result' } },
        { stepId: 'mr', kind: 'mr', intent: 'mr', dependsOn: ['gate'], acceptance: { kind: 'mr-once' } },
      ],
    });
    expect((await submit(p)).ok).toBe(true);
    const live = await openApp();
    const store = new MebularTaskEventStore(live);
    const materializer = new PlanMaterializer({
      device: 'device-A',
      agent: 'planner',
      plans: new MebularTaskPlanStore(live),
      store,
    });
    const result = await materializer.tick();
    expect(result.tasksCreated).toEqual([]);
    expect((await store.byTask(planTaskId(p.planId, 1, 'collect'))).length).toBe(0);
    const progress = derivePlanProgress(p, [], [p]);
    expect(progress.steps.find((step) => step.stepId === 'collect')).toMatchObject({ status: 'blocked', blockedBy: ['NO_TARGET'] });
  });

  it('B6：父 step task 未物化时拒绝 sub-plan，不写 plan/root', async () => {
    const parent = plan({
      planId: 'plan-parent-missing-task-001',
      policy: {
        allowedDevices: ['device-B'],
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
    });
    expect((await submit(parent)).ok).toBe(true);
    const live = await openApp();
    const store = new MebularTaskEventStore(live);
    const plans = new MebularTaskPlanStore(live);
    expect(await store.byTask(planTaskId(parent.planId, 1, 'delegate'))).toHaveLength(0);
    const child: TaskPlan = {
      v: 1,
      kind: 'task_plan',
      planId: 'plan-child-missing-parent-task-001',
      version: 1,
      parent: { planId: parent.planId, version: 1, stepId: 'delegate' },
      owner: A,
      goal: 'child',
      createdAt: 200,
      budget: { maxSteps: 2, maxAttemptsPerStep: 1 },
      policy: {
        allowedDevices: ['device-B'],
        allowedAgents: ['worker'],
        requireCapabilities: ['fleet.task'],
        maxParallel: 1,
        allowSubcontract: false,
      },
      steps: [{ stepId: 'work', kind: 'task', intent: 'child-work', dependsOn: [], to: B, acceptance: { kind: 'non-empty-result' } }],
    };
    const denied = await submitTaskPlan({ plan: child, intent: 'submit child', to: SENTINEL, caller: A, plans, store });
    expect(denied).toMatchObject({ ok: false, error: 'PLAN_STATE_INVALID', created: [] });
    expect((await plans.list()).map((entry) => entry.planId)).toEqual([parent.planId]);
    expect(await store.byTask(planRootTaskId(child.planId, 1))).toHaveLength(0);

    // materializer 也不得为缺失父 task 的 sub-plan 创建 root/plan task。
    const orphanPlans: TaskPlan[] = [parent, child];
    const readOnlyPlans: TaskPlanWriteStore = {
      async list() { return [...orphanPlans]; },
      async get(planId, version) { return orphanPlans.find((entry) => entry.planId === planId && entry.version === version) ?? null; },
      async append() { throw new Error('read-only'); },
      async close() {},
    };
    const materializer = new PlanMaterializer({ device: 'device-A', agent: 'planner', plans: readOnlyPlans, store });
    const tick = await materializer.tick();
    expect(tick.invalid.some((entry) => entry.planId === child.planId && entry.code === 'PLAN_STATE_INVALID')).toBe(true);
    expect(await store.byTask(planRootTaskId(child.planId, 1))).toHaveLength(0);
  });

  it('sub-plan：owner=提交者、policy 衰减、root/step 由父 step task 派生', async () => {
    const parent = plan({
      planId: 'plan-parent-runtime-001',
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
    });
    await submit(parent);
    const live = await openApp();
    const store = new MebularTaskEventStore(live);
    const plans = new MebularTaskPlanStore(live);
    const materializer = new PlanMaterializer({ device: 'device-A', agent: 'planner', plans, store });
    await materializer.tick();
    const delegateTaskId = planTaskId(parent.planId, 1, 'delegate');
    expect(reduceTaskEvents(await store.byTask(delegateTaskId))?.status).toBe('queued');

    const child: TaskPlan = {
      v: 1,
      kind: 'task_plan',
      planId: 'plan-child-runtime-001',
      version: 1,
      parent: { planId: parent.planId, version: 1, stepId: 'delegate' },
      owner: B,
      goal: 'child',
      createdAt: 200,
      budget: { maxSteps: 2, maxAttemptsPerStep: 1 },
      policy: {
        allowedDevices: ['device-B'],
        allowedAgents: ['worker'],
        requireCapabilities: ['fleet.task'],
        maxParallel: 1,
        allowSubcontract: false,
      },
      steps: [
        { stepId: 'work', kind: 'task', intent: 'child-work', dependsOn: [], to: B, acceptance: { kind: 'non-empty-result' } },
      ],
    };
    // 用内存 plan store 模拟 B 设备（作者为 B）；父 plan 从 A 同步而来。
    const childPlans: TaskPlan[] = await plans.list();
    const childPlanStore: TaskPlanWriteStore = {
      async list() { return [...childPlans]; },
      async get(planId, version) { return childPlans.find((entry) => entry.planId === planId && entry.version === version) ?? null; },
      async append(input): Promise<PlanAppendResult> {
        const plan = input as TaskPlan;
        const existing = childPlans.find((entry) => entry.planId === plan.planId && entry.version === plan.version);
        if (existing !== undefined) return { stored: false, replayed: true, plan: existing, nodeId: 'mem', createdBy: existing.owner.device };
        childPlans.push(plan);
        return { stored: true, replayed: false, plan, nodeId: `mem-${childPlans.length}`, createdBy: plan.owner.device };
      },
      async close() {},
    };
    const submitted = await submitTaskPlan({
      plan: child,
      intent: 'submit child',
      to: SENTINEL,
      caller: B,
      plans: childPlanStore,
      store,
    });
    expect(submitted).toMatchObject({ ok: true, planId: child.planId, version: 1 });
    const childRootId = planRootTaskId(child.planId, 1);
    const childRoot = reduceTaskEvents(await store.byTask(childRootId));
    expect(childRoot?.trace).toEqual({ causedBy: delegateTaskId, chain: [delegateTaskId] });

    const childMaterializer = new PlanMaterializer({ device: 'device-B', agent: 'worker', plans: childPlanStore, store });
    const childTick = await childMaterializer.tick();
    expect(childTick.tasksCreated).toEqual([planTaskId(child.planId, 1, 'work')]);
    const childWork = reduceTaskEvents(await store.byTask(planTaskId(child.planId, 1, 'work')));
    expect(childWork?.trace).toEqual({ causedBy: delegateTaskId, chain: [delegateTaskId] });

    const widened = { ...child, planId: 'plan-child-runtime-002', owner: B, policy: { ...child.policy, allowedDevices: ['device-D'] } };
    const denied = await submitTaskPlan({ plan: widened, intent: 'bad child', to: SENTINEL, caller: B, plans: childPlanStore, store });
    expect(denied).toMatchObject({ ok: false, error: 'PLAN_POLICY' });
  });

  it('B8：child 绑定父 task 的 to/active 状态；done 父 task 拒绝新 child', async () => {
    const parent = plan({
      planId: 'plan-parent-b8-001',
      policy: {
        allowedDevices: ['device-A', 'device-B'],
        allowedAgents: ['planner', 'worker'],
        requireCapabilities: ['fleet.task'],
        maxParallel: 2,
        allowSubcontract: true,
      },
      steps: [
        { stepId: 'delegate', kind: 'task', intent: 'delegate', dependsOn: [], to: A, acceptance: { kind: 'non-empty-result' } },
        { stepId: 'gate', kind: 'reduce', intent: 'gate', dependsOn: ['delegate'], join: { mode: 'all' }, acceptance: { kind: 'non-empty-result' } },
        { stepId: 'mr', kind: 'mr', intent: 'mr', dependsOn: ['gate'], acceptance: { kind: 'mr-once' } },
      ],
    });
    await submit(parent);
    const live = await openApp();
    const store = new MebularTaskEventStore(live);
    const plans = new MebularTaskPlanStore(live);
    const materializer = new PlanMaterializer({ device: 'device-A', agent: 'planner', plans, store });
    await materializer.tick();
    const delegateTaskId = planTaskId(parent.planId, 1, 'delegate');
    expect(reduceTaskEvents(await store.byTask(delegateTaskId))?.to).toEqual(A);

    const child: TaskPlan = {
      v: 1,
      kind: 'task_plan',
      planId: 'plan-child-b8-001',
      version: 1,
      parent: { planId: parent.planId, version: 1, stepId: 'delegate' },
      owner: A,
      goal: 'child',
      createdAt: 400,
      budget: { maxSteps: 1, maxAttemptsPerStep: 1 },
      policy: {
        allowedDevices: ['device-A'],
        allowedAgents: ['planner'],
        requireCapabilities: ['fleet.task'],
        maxParallel: 1,
        allowSubcontract: false,
      },
      steps: [{ stepId: 'work', kind: 'task', intent: 'child-work', dependsOn: [], to: A, acceptance: { kind: 'non-empty-result' } }],
    };
    const submitted = await submitTaskPlan({ plan: child, intent: 'child', to: SENTINEL, caller: A, plans, store });
    expect(submitted).toMatchObject({ ok: true, rootTaskId: planRootTaskId(child.planId, 1) });
    const childRoot = reduceTaskEvents(await store.byTask(planRootTaskId(child.planId, 1)));
    expect(childRoot?.trace).toEqual({ causedBy: delegateTaskId, chain: [delegateTaskId] });

    await store.append({
      v: 1,
      eventId: `${delegateTaskId}#done@device-A`,
      taskId: delegateTaskId,
      type: 'done',
      actor: A,
      at: Date.now(),
      toStatus: 'done',
      trace: { chain: [] },
      payloadRef: 'delegate-result',
    });
    expect(reduceTaskEvents(await store.byTask(delegateTaskId))?.status).toBe('done');
    const rejected = await submitTaskPlan({
      plan: { ...child, planId: 'plan-child-b8-002', createdAt: 401 },
      intent: 'child after done',
      to: SENTINEL,
      caller: A,
      plans,
      store,
    });
    expect(rejected).toMatchObject({ ok: false, error: 'PLAN_STATE_INVALID', created: [] });
    expect(await store.byTask(planRootTaskId('plan-child-b8-002', 1))).toHaveLength(0);

    // B9：已接受 child（root 已存在）可幂等 replay，父 done 不阻塞 materializer。
    const replay = await submitTaskPlan({ plan: child, intent: 'child', to: SENTINEL, caller: A, plans, store });
    expect(replay).toMatchObject({ ok: true, deduped: true, rootTaskId: planRootTaskId(child.planId, 1) });

    const childTick = await materializer.tick();
    const childWorkId = planTaskId(child.planId, 1, 'work');
    expect(childTick.invalid).toEqual([]);
    expect(childTick.tasksCreated).toContain(childWorkId);
    expect(reduceTaskEvents(await store.byTask(delegateTaskId))?.status).toBe('done');
    let parentProgress = derivePlanProgress(parent, await statesOf(store), await plans.list());
    expect(parentProgress.steps.find((step) => step.stepId === 'delegate')?.status).toBe('dispatched');

    const log = await ExecutionLog.open(join(dir, 'b8-exec.jsonl'));
    const worker = new FleetWorker({
      device: 'device-A', agent: 'planner', store, transport: new NullTransport(), executor: new EchoExecutor(), log,
    });
    await worker.pollOnce();
    expect(reduceTaskEvents(await store.byTask(childWorkId))?.status).toBe('done');
    await materializer.tick();
    await materializer.tick();
    parentProgress = derivePlanProgress(parent, await statesOf(store), await plans.list());
    expect(parentProgress.steps.find((step) => step.stepId === 'delegate')?.status).toBe('done');
    expect(reduceTaskEvents(await store.byTask(delegateTaskId))?.status).toBe('done');
    await worker.close();
  });

  it('新版本 reuse：旧任务 done+acceptance 通过则不建新 task；root 使用新 version', async () => {
    const v1 = plan({ planId: 'plan-reuse-runtime-001' });
    await submit(v1);
    const live = await openApp();
    const store = new MebularTaskEventStore(live);
    const plans = new MebularTaskPlanStore(live);
    const materializer = new PlanMaterializer({ device: 'device-A', agent: 'planner', plans, store });
    await materializer.tick();
    const log = await ExecutionLog.open(join(dir, 'reuse-exec.jsonl'));
    const worker = new FleetWorker({
      device: 'device-B', agent: 'worker', store, transport: new NullTransport(), executor: new EchoExecutor(), log,
    });
    await worker.pollOnce();
    const oldWorkId = planTaskId(v1.planId, 1, 'work');
    expect(reduceTaskEvents(await store.byTask(oldWorkId))?.status).toBe('done');

    const v2: TaskPlan = {
      ...v1,
      version: 2,
      supersedesVersion: 1,
      createdAt: 300,
      steps: v1.steps.map((step) => step.stepId === 'work' ? { ...step, reuse: { version: 1 } } : step),
    };
    const submitted = await submitTaskPlan({ plan: v2, intent: 'retry plan', to: SENTINEL, caller: A, plans, store });
    expect(submitted).toMatchObject({ ok: true, version: 2, rootTaskId: planRootTaskId(v2.planId, 2) });
    const secondTick = await materializer.tick();
    expect(secondTick.tasksCreated).toEqual([]);
    expect((await store.byTask(planTaskId(v2.planId, 2, 'work'))).length).toBe(0);
    const progress = derivePlanProgress(v2, await statesOf(store), await plans.list());
    expect(progress.steps.find((step) => step.stepId === 'work')).toMatchObject({
      status: 'done',
      via: 'reuse',
      sourceTaskId: oldWorkId,
    });
    await worker.close();
  });

  it('并发 materializer 同 eventId 串行：root/step task 都只写一次', async () => {
    const p = plan({ planId: 'plan-concurrent-materializer-001' });
    await submit(p);
    const live = await openApp();
    const store = new MebularTaskEventStore(live);
    const plans = new MebularTaskPlanStore(live);
    const one = new PlanMaterializer({ device: 'device-A', agent: 'planner', plans, store });
    const two = new PlanMaterializer({ device: 'device-A', agent: 'planner', plans, store });
    const [a, b] = await Promise.all([one.tick(), two.tick()]);
    expect([...a.tasksCreated, ...b.tasksCreated]).toEqual([planTaskId(p.planId, 1, 'work')]);
    const workId = planTaskId(p.planId, 1, 'work');
    expect((await store.byTask(workId)).length).toBe(1);
    const rootEvents = await store.byTask(planRootTaskId(p.planId, 1));
    expect(rootEvents.filter((event) => event.type === 'created')).toHaveLength(1);
  });

  it('materializer 在 plan 存在但 root 缺失时补建 root（不经过 MCP）', async () => {
    const p = plan({ planId: 'plan-materializer-root-001' });
    const live = await openApp();
    await new MebularTaskPlanStore(live).append(p);
    const store = new MebularTaskEventStore(live);
    expect((await store.byTask(planRootTaskId(p.planId, 1))).length).toBe(0);
    const materializer = new PlanMaterializer({
      device: 'device-A',
      agent: 'planner',
      plans: new MebularTaskPlanStore(live),
      store,
    });
    const result = await materializer.tick();
    expect(result.rootsCreated).toBe(1);
    const root = reduceTaskEvents(await store.byTask(planRootTaskId(p.planId, 1)));
    expect(root).toMatchObject({ to: SENTINEL, status: 'running', trace: { chain: [] } });
  });
});
