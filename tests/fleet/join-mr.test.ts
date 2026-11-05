// P4 join + MR 门禁：
// - 三机 loopback：B/C/D 分支 → J all → pre-MR → MR(owner A) → root done，MR 恰好一次。
// - 分支失败 → 新 plan version + reuse：成功分支复用，失败分支与下游 join/MR 重建。
// - 重复 tick/重复投递/重启；MR 非终态等待；MR failed 不重试；旧 MR 存在时禁止重试版本。
// - plan 级 cancel 级联 / step 级 cancel 子树 / 已提交 MR 不撤销。
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mebular } from '@mebular/core';
import {
  AGENT_TASK_TOOL_NAMES,
  EchoExecutor,
  ExecutionLog,
  FleetWorker,
  MebularTaskEventStore,
  MebularTaskPlanStore,
  NullTransport,
  PlanMaterializer,
  admitCreated,
  derivePlanProgress,
  loadToolConfig,
  offlineMebularOptions,
  onboardDevice,
  planMrTaskRefs,
  planRootTaskId,
  planTaskId,
  readMasterKeyFile,
  reduceTaskEvents,
  submitTaskPlan,
  toolByName,
  validatePlan,
  type AgentCapabilityCard,
  type PlanAppendResult,
  type PlanRoutingProvider,
  type TaskEvent,
  type TaskExecutor,
  type TaskPlan,
  type TaskPlanWriteStore,
  type TaskState,
  type ToolContext,
} from '../../packages/fleet/src/index.js';

const A = { device: 'device-A', agent: 'planner' };
const B = { device: 'device-B', agent: 'worker' };
const C = { device: 'device-C', agent: 'worker' };
const D = { device: 'device-D', agent: 'worker' };
const J = { device: 'device-J', agent: 'worker' };
const SENTINEL = { device: '__plan__', agent: '__plan__' };

class MemoryPlans implements TaskPlanWriteStore {
  private readonly plans: TaskPlan[] = [];

  async list(): Promise<TaskPlan[]> {
    return [...this.plans];
  }

  async get(planId: string, version: number): Promise<TaskPlan | null> {
    return this.plans.find((plan) => plan.planId === planId && plan.version === version) ?? null;
  }

  async append(plan: TaskPlan | unknown): Promise<PlanAppendResult> {
    const stored = plan as TaskPlan;
    const existing = this.plans.find((entry) => entry.planId === stored.planId && entry.version === stored.version);
    if (existing !== undefined) {
      return { stored: false, replayed: true, plan: existing, nodeId: 'mem', createdBy: existing.owner.device };
    }
    this.plans.push(stored);
    return { stored: true, replayed: false, plan: stored, nodeId: `mem-${this.plans.length}`, createdBy: stored.owner.device };
  }

  async close(): Promise<void> {
    // memory
  }
}

function card(device: string, agent: string, capabilities: string[] = ['fleet.task']): AgentCapabilityCard {
  return {
    v: 1,
    kind: 'agent_capability_card',
    device,
    agent,
    version: 1,
    capabilities: [...capabilities],
    tools: [...AGENT_TASK_TOOL_NAMES],
    limits: { maxConcurrency: 4 },
    permissions: { taskNamespaces: ['tasks'] },
    runtime: { os: 'test', arch: 'test', runtime: 'node', runtimeVersion: '20' },
    provenance: { source: 'test', configHash: 'cfg', registryHash: 'reg', publishedAt: 1 },
    signature: { alg: 'Ed25519', keyId: device, sig: 'sig' },
  };
}

function routingFor(targets: Array<{ device: string; agent: string }>): PlanRoutingProvider {
  return {
    cards: async () => targets.map((target) => card(target.device, target.agent)),
    authorized: () => ({ devices: [...new Set(targets.map((target) => target.device))] }),
    online: () => true,
    observations: () => [],
    namespace: 'tasks',
  };
}

class FailMatcherExecutor implements TaskExecutor {
  constructor(private readonly matches: (task: TaskState) => boolean) {}

  async execute(task: TaskState): Promise<{ ok: boolean; resultRef?: string; reason?: string }> {
    if (this.matches(task)) return { ok: false, reason: `BOOM:${task.taskId}` };
    return { ok: true, resultRef: `ok:${task.taskId}` };
  }
}

function plan(overrides: Partial<TaskPlan> = {}, steps?: TaskPlan['steps']): TaskPlan {
  return {
    v: 1,
    kind: 'task_plan',
    planId: 'plan-join-mr-001',
    version: 1,
    owner: A,
    goal: 'join and MR gate',
    createdAt: 100,
    budget: { maxSteps: 8, maxAttemptsPerStep: 2 },
    policy: {
      allowedDevices: [B.device, C.device, D.device, J.device],
      allowedAgents: ['worker'],
      requireCapabilities: ['fleet.task'],
      maxParallel: 3,
      allowSubcontract: false,
    },
    steps: steps ?? [
      { stepId: 'b', kind: 'task', intent: 'branch-b', dependsOn: [], to: B, acceptance: { kind: 'non-empty-result' } },
      { stepId: 'c', kind: 'task', intent: 'branch-c', dependsOn: [], to: C, acceptance: { kind: 'non-empty-result' } },
      { stepId: 'd', kind: 'task', intent: 'branch-d', dependsOn: [], to: D, acceptance: { kind: 'non-empty-result' } },
      { stepId: 'j', kind: 'join', intent: 'join-all', dependsOn: ['b', 'c', 'd'], to: J, join: { mode: 'all' }, acceptance: { kind: 'non-empty-result' } },
      { stepId: 'pre-mr', kind: 'reduce', intent: 'pre-mr-gate', dependsOn: ['j'], to: J, join: { mode: 'all' }, acceptance: { kind: 'non-empty-result' } },
      { stepId: 'mr', kind: 'mr', intent: 'submit-mr', dependsOn: ['pre-mr'], to: A, acceptance: { kind: 'mr-once' } },
    ],
    ...overrides,
  };
}

function smallPlan(overrides: Partial<TaskPlan> = {}): TaskPlan {
  return plan({
    planId: 'plan-join-mr-small-001',
    budget: { maxSteps: 4, maxAttemptsPerStep: 2 },
    policy: {
      allowedDevices: [B.device, C.device, J.device],
      allowedAgents: ['worker'],
      requireCapabilities: ['fleet.task'],
      maxParallel: 2,
      allowSubcontract: false,
    },
    ...overrides,
  }, [
    { stepId: 'b', kind: 'task', intent: 'branch-b', dependsOn: [], to: B, acceptance: { kind: 'non-empty-result' } },
    { stepId: 'c', kind: 'task', intent: 'branch-c', dependsOn: [], to: C, acceptance: { kind: 'non-empty-result' } },
    { stepId: 'j', kind: 'join', intent: 'join-all', dependsOn: ['b', 'c'], to: J, join: { mode: 'all' }, acceptance: { kind: 'non-empty-result' } },
    { stepId: 'mr', kind: 'mr', intent: 'submit-mr', dependsOn: ['j'], to: A, acceptance: { kind: 'mr-once' } },
  ]);
}

async function openIsolated(device: string, file: string): Promise<Mebular> {
  const master = await Mebular.generateUserMasterKey();
  const live = new Mebular({
    storagePath: join(dir, file),
    deviceId: device,
    encryption: { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey },
    network: { enabled: false },
  } as never);
  await live.initialize();
  return live;
}

async function statesOf(store: MebularTaskEventStore | { all(): Promise<TaskEvent[]> }): Promise<TaskState[]> {
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

async function executeTargets(workers: readonly FleetWorker[]): Promise<void> {
  for (const worker of workers) await worker.pollOnce();
}

async function drive(
  materializer: PlanMaterializer,
  workers: readonly FleetWorker[],
  rounds = 12,
): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await materializer.tick();
    await executeTargets(workers);
  }
  await materializer.tick();
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fleet-join-mr-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function openWorkers(store: MebularTaskEventStore, overrides: Partial<Record<string, TaskExecutor>> = {}): Promise<FleetWorker[]> {
  const workers: FleetWorker[] = [];
  for (const [index, endpoint] of [B, C, D, J, A].entries()) {
    workers.push(new FleetWorker({
      device: endpoint.device,
      agent: endpoint.agent,
      store,
      transport: new NullTransport(),
      executor: overrides[endpoint.device] ?? new EchoExecutor(),
      log: await ExecutionLog.open(join(dir, `exec-${index}.jsonl`)),
    }));
  }
  return workers;
}

describe('P4 join + MR gate', () => {
  it('三机 loopback：B/C/D → J all → pre-MR → MR(owner A) → root done；MR 恰好一次', async () => {
    const p = plan();
    const plans = new MemoryPlans();
    await plans.append(p);
    const live = await openIsolated(A.device, 'a.jsonl');
    const store = new MebularTaskEventStore(live);
    const materializer = new PlanMaterializer({ device: A.device, agent: A.agent, plans, store, routing: routingFor([B, C, D, J]) });
    const workers = await openWorkers(store);

    try {
      const first = await materializer.tick();
      expect(first.tasksCreated).toEqual([
        planTaskId(p.planId, 1, 'b'),
        planTaskId(p.planId, 1, 'c'),
        planTaskId(p.planId, 1, 'd'),
      ]);
      // join 未提前创建；root 不 done。
      expect(await store.byTask(planTaskId(p.planId, 1, 'j'))).toHaveLength(0);
      expect(reduceTaskEvents(await store.byTask(planRootTaskId(p.planId, 1)))?.status).toBe('running');
      expect(derivePlanProgress(p, await statesOf(store), [p]).status).not.toBe('done');

      // B/C/D 完成 → 下一 tick 才创建 join。
      await executeTargets(workers);
      const second = await materializer.tick();
      expect(second.tasksCreated).toEqual([planTaskId(p.planId, 1, 'j')]);
      expect(await store.byTask(planTaskId(p.planId, 1, 'pre-mr'))).toHaveLength(0);
      expect(await store.byTask(planTaskId(p.planId, 1, 'mr'))).toHaveLength(0);

      // J 执行 join → 创建 pre-MR；再执行 → 所有非 MR step complete 后创建 MR。
      await executeTargets(workers);
      const third = await materializer.tick();
      expect(third.tasksCreated).toEqual([planTaskId(p.planId, 1, 'pre-mr')]);
      await executeTargets(workers);
      const fourth = await materializer.tick();
      const mrTaskId = planTaskId(p.planId, 1, 'mr');
      expect(fourth.tasksCreated).toEqual([mrTaskId]);
      const mrCreated = (await store.byTask(mrTaskId)).filter((event) => event.type === 'created');
      expect(mrCreated).toHaveLength(1);
      expect(mrCreated[0]).toMatchObject({
        eventId: `${mrTaskId}#created`,
        to: A,
        dispatch: 'root-only',
        trace: { chain: [] },
      });
      expect(mrCreated[0]?.trace.causedBy).toBeUndefined();
      // MR dispatch=root-only：任何派生 created 都被入口准入拒绝（不创建子任务）。
      const childCandidate: TaskEvent = {
        v: 1,
        eventId: `${mrTaskId}~c0#created`,
        taskId: `${mrTaskId}~c0`,
        type: 'created',
        actor: A,
        at: Date.now(),
        toStatus: 'queued',
        trace: { causedBy: mrTaskId, chain: [mrTaskId] },
        to: A,
        intent: 'mr-child',
      };
      expect(admitCreated(childCandidate, await statesOf(store), reduceTaskEvents)).toMatchObject({
        ok: false,
        reason: 'ROOT_ONLY',
      });
      expect(await store.byTask(childCandidate.taskId)).toHaveLength(0);

      // MR 非终态：重复 tick/重启 materializer 不再创建 MR；root 仍不 done。
      const restarted = new PlanMaterializer({ device: A.device, agent: A.agent, plans, store, routing: routingFor([B, C, D, J]) });
      expect((await restarted.tick()).tasksCreated).toEqual([]);
      expect((await materializer.tick()).tasksCreated).toEqual([]);
      expect((await store.byTask(mrTaskId)).filter((event) => event.type === 'created')).toHaveLength(1);
      expect(reduceTaskEvents(await store.byTask(planRootTaskId(p.planId, 1)))?.status).toBe('running');
      expect(derivePlanProgress(p, await statesOf(store), [p]).mr).toEqual({ submitted: true });
      expect(derivePlanProgress(p, await statesOf(store), [p]).status).not.toBe('done');

      // A 执行 MR → root done；plan done。
      await executeTargets(workers);
      const fifth = await materializer.tick();
      expect(fifth.completed).toEqual([planRootTaskId(p.planId, 1)]);
      const root = reduceTaskEvents(await store.byTask(planRootTaskId(p.planId, 1)));
      expect(root?.status).toBe('done');
      const progress = derivePlanProgress(p, await statesOf(store), [p]);
      expect(progress.status).toBe('done');
      expect(progress.steps.map((step) => [step.stepId, step.status])).toEqual([
        ['b', 'done'], ['c', 'done'], ['d', 'done'], ['j', 'done'], ['pre-mr', 'done'], ['mr', 'done'],
      ]);

      // MR 恰好一次：跨 tick/重启/重复投递都只有一个 created 事件。
      const mrRefs = planMrTaskRefs(p.planId, [p], await statesOf(store));
      expect(mrRefs).toHaveLength(1);
      expect(mrRefs[0]!.state.status).toBe('done');
      const duplicate = (await store.byTask(mrTaskId))[0]!;
      expect(await store.append({ ...duplicate })).toBe(false);
      expect((await store.byTask(mrTaskId)).filter((event) => event.type === 'created')).toHaveLength(1);

      // 只存在 plan root + step task；没有额外的角色卡/状态 task。
      const createdIds = new Set((await store.all()).filter((event) => event.type === 'created').map((event) => event.taskId));
      expect([...createdIds].sort()).toEqual([
        planRootTaskId(p.planId, 1),
        ...p.steps.map((step) => planTaskId(p.planId, 1, step.stepId)),
      ].sort());
    } finally {
      for (const worker of workers) await worker.close();
      await live.shutdown();
    }
  });

  it('join/reduce：route 目标成功；无 target / 硬过滤失败 blocked，不建 task、不提前 MR', async () => {
    const steps = (jStep: TaskPlan['steps'][number]): TaskPlan['steps'] => [
      { stepId: 'b', kind: 'task', intent: 'branch-b', dependsOn: [], to: B, acceptance: { kind: 'non-empty-result' } },
      { stepId: 'c', kind: 'task', intent: 'branch-c', dependsOn: [], to: C, acceptance: { kind: 'non-empty-result' } },
      jStep,
      { stepId: 'mr', kind: 'mr', intent: 'submit-mr', dependsOn: ['j'], to: A, acceptance: { kind: 'mr-once' } },
    ];
    const routed = smallPlan({
      planId: 'plan-join-route-001',
      steps: steps({
        stepId: 'j', kind: 'join', intent: 'join-all', dependsOn: ['b', 'c'],
        route: { require: ['gate'], prefer: [], strategy: 'deterministic' },
        join: { mode: 'all' }, acceptance: { kind: 'non-empty-result' },
      }),
    });
    const noTarget = smallPlan({
      planId: 'plan-join-no-target-001',
      createdAt: 101,
      steps: steps({
        stepId: 'j', kind: 'join', intent: 'join-all', dependsOn: ['b', 'c'],
        join: { mode: 'all' }, acceptance: { kind: 'non-empty-result' },
      }),
    });
    const filtered = smallPlan({
      planId: 'plan-join-filtered-001',
      createdAt: 102,
      steps: steps({
        stepId: 'j', kind: 'join', intent: 'join-all', dependsOn: ['b', 'c'],
        to: J,
        route: { require: ['gpu'], prefer: [], strategy: 'deterministic' },
        join: { mode: 'all' }, acceptance: { kind: 'non-empty-result' },
      }),
    });
    const plans = new MemoryPlans();
    await plans.append(routed);
    await plans.append(noTarget);
    await plans.append(filtered);
    const live = await openIsolated(A.device, 'join-target-a.jsonl');
    const store = new MebularTaskEventStore(live);
    const routing: PlanRoutingProvider = {
      cards: async () => [card(B.device, B.agent), card(C.device, C.agent), card(J.device, J.agent, ['fleet.task', 'gate'])],
      authorized: () => ({ devices: [B.device, C.device, J.device] }),
      online: () => true,
      observations: () => [],
      namespace: 'tasks',
    };
    const materializer = new PlanMaterializer({ device: A.device, agent: A.agent, plans, store, routing });
    const workers = await openWorkers(store);
    try {
      await materializer.tick();
      await executeTargets(workers);
      const tick = await materializer.tick();
      // route join 按能力卡选中 J；no-target / 硬过滤失败保持 blocked。
      expect(tick.tasksCreated).toEqual([planTaskId(routed.planId, 1, 'j')]);
      expect(tick.assignments).toEqual([expect.objectContaining({
        planId: routed.planId,
        stepId: 'j',
        chosen: J,
      })]);
      expect(await store.byTask(planTaskId(noTarget.planId, 1, 'j'))).toHaveLength(0);
      expect(await store.byTask(planTaskId(filtered.planId, 1, 'j'))).toHaveLength(0);
      expect(tick.blocked).toEqual(expect.arrayContaining([
        expect.objectContaining({ planId: filtered.planId, stepId: 'j', blockedBy: ['MISSING_CAPABILITY'] }),
      ]));
      const noTargetProgress = derivePlanProgress(noTarget, await statesOf(store), [noTarget]);
      expect(noTargetProgress.steps.find((step) => step.stepId === 'j')).toMatchObject({
        status: 'blocked',
        blockedBy: ['NO_TARGET'],
      });
      const filteredProgress = derivePlanProgress(filtered, await statesOf(store), [filtered]);
      expect(filteredProgress.steps.find((step) => step.stepId === 'j')).toMatchObject({
        status: 'pending',
      });
      expect(await store.byTask(planTaskId(noTarget.planId, 1, 'mr'))).toHaveLength(0);
      expect(await store.byTask(planTaskId(filtered.planId, 1, 'mr'))).toHaveLength(0);

      // routed join 完成 → MR 才创建。
      const jWorkers = workers.filter((worker) => worker.endpoint.device === J.device || worker.endpoint.device === A.device);
      await executeTargets(jWorkers);
      const mrTick = await materializer.tick();
      expect(mrTick.tasksCreated).toEqual([planTaskId(routed.planId, 1, 'mr')]);
    } finally {
      for (const worker of workers) await worker.close();
      await live.shutdown();
    }
  });

  it('acceptance 失败 → step failed、root failed、MR 不提交', async () => {
    const p = smallPlan({
      planId: 'plan-join-acceptance-001',
      steps: [
        { stepId: 'b', kind: 'task', intent: 'branch-b', dependsOn: [], to: B, acceptance: { kind: 'non-empty-result' } },
        { stepId: 'c', kind: 'task', intent: 'branch-c', dependsOn: [], to: C, acceptance: { kind: 'non-empty-result' } },
        { stepId: 'j', kind: 'join', intent: 'join-all', dependsOn: ['b', 'c'], to: J, join: { mode: 'all' }, acceptance: { kind: 'contains', all: ['GATE_OK'] } },
        { stepId: 'mr', kind: 'mr', intent: 'submit-mr', dependsOn: ['j'], to: A, acceptance: { kind: 'mr-once' } },
      ],
    });
    const plans = new MemoryPlans();
    await plans.append(p);
    const live = await openIsolated(A.device, 'acceptance-a.jsonl');
    const store = new MebularTaskEventStore(live);
    const materializer = new PlanMaterializer({ device: A.device, agent: A.agent, plans, store, routing: routingFor([B, C, J]) });
    const workers = await openWorkers(store);
    try {
      await materializer.tick();
      await executeTargets(workers);
      await materializer.tick();
      const jTaskId = planTaskId(p.planId, 1, 'j');
      expect((await store.byTask(jTaskId)).filter((event) => event.type === 'created')).toHaveLength(1);
      await executeTargets(workers);
      const failed = await materializer.tick();
      expect(failed.failed).toEqual([planRootTaskId(p.planId, 1)]);
      expect(reduceTaskEvents(await store.byTask(planRootTaskId(p.planId, 1)))).toMatchObject({
        status: 'failed',
        reason: 'STEP_ACCEPTANCE_FAILED:j',
      });
      expect(await store.byTask(planTaskId(p.planId, 1, 'mr'))).toHaveLength(0);
      expect(derivePlanProgress(p, await statesOf(store), [p]).status).toBe('failed');
    } finally {
      for (const worker of workers) await worker.close();
      await live.shutdown();
    }
  });

  it('分支失败 → v2 reuse 重试：成功分支复用，失败分支/join/MR 重建；旧 MR 存在时禁止新版本', async () => {
    const p = smallPlan({ planId: 'plan-join-mr-retry-001' });
    const plans = new MemoryPlans();
    await plans.append(p);
    const live = await openIsolated(A.device, 'retry-a.jsonl');
    const store = new MebularTaskEventStore(live);
    const materializer = new PlanMaterializer({ device: A.device, agent: A.agent, plans, store, routing: routingFor([B, C, J]) });
    const failingC = new FailMatcherExecutor((task) => task.taskId === planTaskId(p.planId, 1, 'c'));
    const workers = await openWorkers(store, { [C.device]: failingC });

    try {
      await materializer.tick();
      await executeTargets(workers);
      const failedTick = await materializer.tick();
      expect(failedTick.failed).toEqual([planRootTaskId(p.planId, 1)]);
      const root1 = reduceTaskEvents(await store.byTask(planRootTaskId(p.planId, 1)));
      expect(root1).toMatchObject({ status: 'failed', reason: 'STEP_FAILED:c' });
      expect(await store.byTask(planTaskId(p.planId, 1, 'j'))).toHaveLength(0);
      expect(await store.byTask(planTaskId(p.planId, 1, 'mr'))).toHaveLength(0);
      const failedProgress = derivePlanProgress(p, await statesOf(store), [p]);
      expect(failedProgress.status).toBe('failed');
      expect(failedProgress.mr).toEqual({ submitted: false });

      // 新版本：复用已完成的 b，重建 c/join/MR。
      const v2: TaskPlan = {
        ...p,
        version: 2,
        supersedesVersion: 1,
        retryOfStepId: 'c',
        createdAt: 200,
        steps: p.steps.map((step) => step.stepId === 'b' ? { ...step, reuse: { version: 1 } } : step),
      };
      const submitted = await submitTaskPlan({
        plan: v2,
        intent: 'retry c',
        to: SENTINEL,
        caller: A,
        plans,
        store,
      });
      expect(submitted).toMatchObject({ ok: true, version: 2, rootTaskId: planRootTaskId(p.planId, 2) });

      const retryTick = await materializer.tick();
      expect(retryTick.tasksCreated).toEqual([planTaskId(p.planId, 2, 'c')]);
      expect(await store.byTask(planTaskId(p.planId, 2, 'b'))).toHaveLength(0);
      expect(await store.byTask(planTaskId(p.planId, 1, 'j'))).toHaveLength(0);
      expect(await store.byTask(planTaskId(p.planId, 1, 'mr'))).toHaveLength(0);

      // 重试分支成功后，join/MR 全部使用新 version taskId。
      await executeTargets(workers.filter((worker) => worker.endpoint.device !== C.device));
      const retryC = new FleetWorker({
        device: C.device,
        agent: C.agent,
        store,
        transport: new NullTransport(),
        executor: new EchoExecutor(),
        log: await ExecutionLog.open(join(dir, 'retry-c-ok.jsonl')),
      });
      await retryC.pollOnce();
      await retryC.close();

      const joinTick = await materializer.tick();
      expect(joinTick.tasksCreated).toEqual([planTaskId(p.planId, 2, 'j')]);
      await executeTargets(workers.filter((worker) => worker.endpoint.device !== C.device));
      const mrTick = await materializer.tick();
      expect(mrTick.tasksCreated).toEqual([planTaskId(p.planId, 2, 'mr')]);
      await executeTargets(workers);
      const doneTick = await materializer.tick();
      expect(doneTick.completed).toEqual([planRootTaskId(p.planId, 2)]);

      const v2Progress = derivePlanProgress(v2, await statesOf(store), await plans.list());
      expect(v2Progress.status).toBe('done');
      expect(v2Progress.steps.find((step) => step.stepId === 'b')).toMatchObject({
        status: 'done',
        via: 'reuse',
        sourceTaskId: planTaskId(p.planId, 1, 'b'),
      });
      expect(v2Progress.steps.find((step) => step.stepId === 'c')).toMatchObject({
        status: 'done',
        via: 'task',
        taskId: planTaskId(p.planId, 2, 'c'),
      });

      // MR 唯一性优先：已有 MR task 时禁止创建 retry 版本。
      const v3: TaskPlan = {
        ...v2,
        version: 3,
        supersedesVersion: 2,
        createdAt: 300,
        steps: v2.steps.map((step) => step.stepId === 'b' ? step : { ...step }),
      };
      const denied = await submitTaskPlan({ plan: v3, intent: 'retry again', to: SENTINEL, caller: A, plans, store });
      expect(denied).toMatchObject({ ok: false, error: 'PLAN_MR', created: [] });
      expect((await plans.list()).some((entry) => entry.version === 3)).toBe(false);

      const allMr = planMrTaskRefs(p.planId, await plans.list(), await statesOf(store));
      expect(allMr.filter((ref) => ref.state.status === 'done')).toHaveLength(1);
      expect((await store.byTask(planTaskId(p.planId, 2, 'j'))).filter((event) => event.type === 'created')).toHaveLength(1);
      expect(await store.byTask(planTaskId(p.planId, 1, 'j'))).toHaveLength(0);
    } finally {
      for (const worker of workers) await worker.close();
      await live.shutdown();
    }
  });

  it('sub-plan 失败 = 父 step 失败；重试必须走父 plan 新版本/新父 step task', async () => {
    const parent: TaskPlan = {
      v: 1,
      kind: 'task_plan',
      planId: 'plan-sub-fail-parent-001',
      version: 1,
      owner: A,
      goal: 'parent with sub-plan',
      createdAt: 600,
      budget: { maxSteps: 4, maxAttemptsPerStep: 2 },
      policy: {
        allowedDevices: [B.device, C.device, J.device],
        allowedAgents: ['worker'],
        requireCapabilities: ['fleet.task'],
        maxParallel: 2,
        allowSubcontract: true,
      },
      steps: [
        { stepId: 'delegate', kind: 'task', intent: 'delegate', dependsOn: [], to: B, acceptance: { kind: 'non-empty-result' } },
        { stepId: 'gate', kind: 'reduce', intent: 'gate', dependsOn: ['delegate'], to: J, join: { mode: 'all' }, acceptance: { kind: 'non-empty-result' } },
        { stepId: 'mr', kind: 'mr', intent: 'mr', dependsOn: ['gate'], to: A, acceptance: { kind: 'mr-once' } },
      ],
    };
    const child = (version: number, parentVersion: number): TaskPlan => ({
      v: 1,
      kind: 'task_plan',
      planId: 'plan-sub-fail-child-001',
      version,
      ...(version > 1 ? { supersedesVersion: version - 1, retryOfStepId: 'work' } : {}),
      parent: { planId: parent.planId, version: parentVersion, stepId: 'delegate' },
      owner: B,
      goal: 'child work',
      createdAt: 610 + version,
      budget: { maxSteps: 1, maxAttemptsPerStep: 2 },
      policy: {
        allowedDevices: [C.device],
        allowedAgents: ['worker'],
        requireCapabilities: ['fleet.task'],
        maxParallel: 1,
        allowSubcontract: false,
      },
      steps: [{ stepId: 'work', kind: 'task', intent: 'child-work', dependsOn: [], to: C, acceptance: { kind: 'non-empty-result' } }],
    });
    const plans = new MemoryPlans();
    await plans.append(parent);
    const live = await openIsolated(A.device, 'sub-fail-a.jsonl');
    const store = new MebularTaskEventStore(live);
    const parentMaterializer = new PlanMaterializer({ device: A.device, agent: A.agent, plans, store, routing: routingFor([B, C, J]) });
    const childMaterializer = new PlanMaterializer({ device: B.device, agent: B.agent, plans, store, routing: routingFor([C]) });
    const childTaskId = (version: number, stepId: string): string => planTaskId('plan-sub-fail-child-001', version, stepId);
    const failingWork = new FailMatcherExecutor((task) => task.taskId === childTaskId(1, 'work'));
    const workers = await openWorkers(store, { [C.device]: failingWork });
    const bWorker = new FleetWorker({
      device: B.device,
      agent: B.agent,
      store,
      transport: new NullTransport(),
      executor: new EchoExecutor(),
      log: await ExecutionLog.open(join(dir, 'sub-fail-b.jsonl')),
    });

    try {
      await parentMaterializer.tick();
      const delegate1 = planTaskId(parent.planId, 1, 'delegate');
      expect(reduceTaskEvents(await store.byTask(delegate1))?.status).toBe('queued');

      const child1 = await submitTaskPlan({ plan: child(1, 1), intent: 'child', to: SENTINEL, caller: B, plans, store });
      expect(child1).toMatchObject({ ok: true, rootTaskId: planRootTaskId('plan-sub-fail-child-001', 1) });
      expect(reduceTaskEvents(await store.byTask(planRootTaskId('plan-sub-fail-child-001', 1)))?.trace)
        .toEqual({ causedBy: delegate1, chain: [delegate1] });

      await childMaterializer.tick();
      expect((await store.byTask(childTaskId(1, 'work'))).filter((event) => event.type === 'created')).toHaveLength(1);
      // B 完成 delegate，C 的 child work 失败。
      await bWorker.pollOnce();
      await executeTargets(workers.filter((worker) => worker.endpoint.device === C.device));
      await childMaterializer.tick();
      expect(reduceTaskEvents(await store.byTask(planRootTaskId('plan-sub-fail-child-001', 1)))).toMatchObject({
        status: 'failed',
        reason: 'STEP_FAILED:work',
      });
      await parentMaterializer.tick();
      expect(reduceTaskEvents(await store.byTask(planRootTaskId(parent.planId, 1)))).toMatchObject({
        status: 'failed',
        reason: 'STEP_FAILED:delegate',
      });
      expect(await store.byTask(planTaskId(parent.planId, 1, 'mr'))).toHaveLength(0);

      // 不允许在旧父 step task 下提交 child 重试版本。
      const underOldParent = await submitTaskPlan({ plan: child(2, 1), intent: 'child retry', to: SENTINEL, caller: B, plans, store });
      expect(underOldParent).toMatchObject({ ok: false, error: 'PLAN_STATE_INVALID', created: [] });

      // 父 plan 新版本 → 新 delegate task → child v2 只能在它下面派生。
      const parentV2: TaskPlan = {
        ...parent,
        version: 2,
        supersedesVersion: 1,
        retryOfStepId: 'delegate',
        createdAt: 700,
      };
      const parentRetry = await submitTaskPlan({ plan: parentV2, intent: 'retry delegate', to: SENTINEL, caller: A, plans, store });
      expect(parentRetry).toMatchObject({ ok: true, rootTaskId: planRootTaskId(parent.planId, 2) });
      await parentMaterializer.tick();
      const delegate2 = planTaskId(parent.planId, 2, 'delegate');
      expect(reduceTaskEvents(await store.byTask(delegate2))?.status).toBe('queued');

      const underNewParent = await submitTaskPlan({ plan: child(2, 2), intent: 'child retry', to: SENTINEL, caller: B, plans, store });
      expect(underNewParent).toMatchObject({ ok: true, rootTaskId: planRootTaskId('plan-sub-fail-child-001', 2) });
      expect(reduceTaskEvents(await store.byTask(planRootTaskId('plan-sub-fail-child-001', 2)))?.trace)
        .toEqual({ causedBy: delegate2, chain: [delegate2] });
    } finally {
      await bWorker.close();
      for (const worker of workers) await worker.close();
      await live.shutdown();
    }
  });

  it('MR failed 不重试；旧 MR 非终态等待；done 后 root done 且不创建新 MR', async () => {
    const p = smallPlan({ planId: 'plan-join-mr-mr-state-001' });
    const plans = new MemoryPlans();
    await plans.append(p);
    const live = await openIsolated(A.device, 'mr-state-a.jsonl');
    const store = new MebularTaskEventStore(live);
    const materializer = new PlanMaterializer({ device: A.device, agent: A.agent, plans, store, routing: routingFor([B, C, J]) });
    const failingMr = new FailMatcherExecutor((task) => task.taskId === planTaskId(p.planId, 1, 'mr'));
    const workers = await openWorkers(store, { [A.device]: failingMr });

    try {
      await drive(materializer, workers, 2);
      // 让 MR 创建后失败。
      const mrTaskId = planTaskId(p.planId, 1, 'mr');
      for (let i = 0; i < 6 && (await store.byTask(mrTaskId)).length === 0; i++) {
        await materializer.tick();
        await executeTargets(workers);
      }
      await executeTargets(workers);
      const failedTick = await materializer.tick();
      expect(failedTick.failed).toContain(planRootTaskId(p.planId, 1));
      const root = reduceTaskEvents(await store.byTask(planRootTaskId(p.planId, 1)));
      expect(root).toMatchObject({ status: 'failed', reason: 'MR_FAILED' });
      expect(reduceTaskEvents(await store.byTask(mrTaskId))?.status).toBe('failed');
      expect(derivePlanProgress(p, await statesOf(store), [p]).status).toBe('failed');

      // MR failed 后禁止新版本（不重试 MR）。
      const v2: TaskPlan = {
        ...p,
        version: 2,
        supersedesVersion: 1,
        retryOfStepId: 'b',
        createdAt: 200,
        steps: p.steps.map((step) => step.stepId === 'b' ? { ...step, reuse: { version: 1 } } : step),
      };
      const denied = await submitTaskPlan({ plan: v2, intent: 'retry after MR', to: SENTINEL, caller: A, plans, store });
      expect(denied).toMatchObject({ ok: false, error: 'PLAN_MR', created: [] });

      // 即使旧版本被直接写入（绕过提交门禁），materializer 也不会重建 MR。
      await plans.append(v2);
      const tick = await materializer.tick();
      expect(tick.tasksCreated).toEqual([]);
      expect(await store.byTask(planTaskId(p.planId, 2, 'c'))).toHaveLength(0);
      expect(planMrTaskRefs(p.planId, await plans.list(), await statesOf(store))).toHaveLength(1);
    } finally {
      for (const worker of workers) await worker.close();
      await live.shutdown();
    }

    // 非终态等待：旧 MR 未终止时，新版本不创建自己的 MR；旧 MR done 后根直接 done。
    const waitPlan = smallPlan({ planId: 'plan-join-mr-wait-001', createdAt: 400 });
    const waitPlans = new MemoryPlans();
    await waitPlans.append(waitPlan);
    const waitLive = await openIsolated(A.device, 'mr-wait-a.jsonl');
    const waitStore = new MebularTaskEventStore(waitLive);
    const waitMaterializer = new PlanMaterializer({
      device: A.device,
      agent: A.agent,
      plans: waitPlans,
      store: waitStore,
      routing: routingFor([B, C, J]),
    });
    const waitWorkers = await openWorkers(waitStore);
    try {
      // 跑到 MR 创建但暂不执行 A。
      for (let i = 0; i < 8; i++) {
        await waitMaterializer.tick();
        await executeTargets(waitWorkers.filter((worker) => worker.endpoint.device !== A.device));
        if ((await waitStore.byTask(planTaskId(waitPlan.planId, 1, 'mr'))).length > 0) break;
      }
      const v2Wait: TaskPlan = {
        ...waitPlan,
        version: 2,
        supersedesVersion: 1,
        createdAt: 500,
        steps: waitPlan.steps.map((step) => step.stepId === 'b' || step.stepId === 'j'
          ? { ...step, reuse: { version: 1 } }
          : step),
      };
      // 强制写入（模拟旧数据/绕过提交门禁）；materializer 必须等待旧 MR。
      await waitPlans.append(v2Wait);
      const waiting = await waitMaterializer.tick();
      expect(waiting.tasksCreated).toEqual([]);
      expect(await waitStore.byTask(planTaskId(waitPlan.planId, 2, 'mr'))).toHaveLength(0);
      expect(planMrTaskRefs(waitPlan.planId, await waitPlans.list(), await statesOf(waitStore))).toHaveLength(1);

      // 旧 MR done → v2 root done；仍然只有一个 MR。
      await executeTargets(waitWorkers);
      await waitMaterializer.tick();
      expect(reduceTaskEvents(await waitStore.byTask(planRootTaskId(waitPlan.planId, 2)))?.status).toBe('done');
      expect(await waitStore.byTask(planTaskId(waitPlan.planId, 2, 'mr'))).toHaveLength(0);
      expect(planMrTaskRefs(waitPlan.planId, await waitPlans.list(), await statesOf(waitStore))).toHaveLength(1);
    } finally {
      for (const worker of waitWorkers) await worker.close();
      await waitLive.shutdown();
    }
  });
});

describe('P4 cancel', () => {
  async function openLive(): Promise<{ live: Mebular; store: MebularTaskEventStore; plans: MebularTaskPlanStore }> {
    await onboardDevice({
      dir,
      device: A.device,
      agents: [
        { name: A.agent, kind: 'command', command: process.execPath },
        { name: 'worker', kind: 'command', command: process.execPath },
      ],
    });
    const config = await loadToolConfig(dir);
    const live = new Mebular(offlineMebularOptions(config, await readMasterKeyFile(config.masterKeyFile)) as never);
    await live.initialize();
    return { live, store: new MebularTaskEventStore(live), plans: new MebularTaskPlanStore(live) };
  }

  async function submit(live: Mebular, p: TaskPlan): Promise<void> {
    const result = await toolByName('task_submit')!.handler(
      { intent: 'submit join plan', to: SENTINEL, plan: p },
      { dir, mebular: live, agent: A.agent } as ToolContext,
    ) as { ok: boolean };
    expect(result.ok).toBe(true);
  }

  it('plan cancel：root failed(CANCELLED) 级联取消所有非终态 step + 派生树；停止新物化', async () => {
    const { live, store, plans } = await openLive();
    const p = smallPlan({ planId: 'plan-cancel-root-001' });
    try {
      await submit(live, p);
      const workers = await openWorkers(store);
      const materializer = new PlanMaterializer({ device: A.device, agent: A.agent, plans, store, routing: routingFor([B, C, J]) });
      await materializer.tick();
      const bTaskId = planTaskId(p.planId, 1, 'b');
      const cTaskId = planTaskId(p.planId, 1, 'c');
      expect(reduceTaskEvents(await store.byTask(bTaskId))?.status).toBe('queued');

      // task_status.plan 正确派生 join/MR 待决状态，且不返回 plan 定义。
      const runningStatus = await toolByName('task_status')!.handler(
        { taskId: planRootTaskId(p.planId, 1) },
        { dir, mebular: live, agent: A.agent } as ToolContext,
      ) as {
        plan: { status: string; steps: Array<Record<string, unknown>>; mr: { submitted: boolean } };
      };
      expect(runningStatus.plan.status).toBe('running');
      expect(runningStatus.plan.mr).toEqual({ submitted: false });
      const joinStep = runningStatus.plan.steps.find((step) => step.stepId === 'j')!;
      const mrStep = runningStatus.plan.steps.find((step) => step.stepId === 'mr')!;
      expect(joinStep).toMatchObject({ status: 'pending', blockedBy: ['b', 'c'] });
      expect(mrStep).toMatchObject({ status: 'pending', blockedBy: ['j'] });
      for (const step of runningStatus.plan.steps) {
        expect(step).not.toHaveProperty('intent');
        expect(step).not.toHaveProperty('dependsOn');
        expect(step).not.toHaveProperty('acceptance');
      }

      // b 的派生普通子任务（模拟执行者派生）必须随 plan cancel 一并取消。
      const childId = `${bTaskId}~c0`;
      await store.append({
        v: 1,
        eventId: `${childId}#created`,
        taskId: childId,
        type: 'created',
        actor: B,
        at: Date.now(),
        toStatus: 'queued',
        trace: { causedBy: bTaskId, chain: [bTaskId] },
        to: C,
        intent: 'child',
      });

      const cancel = await toolByName('task_cancel')!.handler(
        { taskId: planRootTaskId(p.planId, 1) },
        { dir, mebular: live, agent: A.agent } as ToolContext,
      ) as { ok: boolean; status: string; reason: string };
      expect(cancel).toMatchObject({ ok: true, status: 'failed', reason: 'CANCELLED' });
      expect(reduceTaskEvents(await store.byTask(planRootTaskId(p.planId, 1)))).toMatchObject({
        status: 'failed',
        reason: 'CANCELLED',
      });
      for (const taskId of [bTaskId, cTaskId, childId]) {
        expect(reduceTaskEvents(await store.byTask(taskId))).toMatchObject({ status: 'failed', reason: 'CANCELLED' });
      }
      expect(derivePlanProgress(p, await statesOf(store), [p]).status).toBe('cancelled');
      const cancelledStatus = await toolByName('task_status')!.handler(
        { taskId: planRootTaskId(p.planId, 1) },
        { dir, mebular: live, agent: A.agent } as ToolContext,
      ) as { plan: { status: string; mr: { submitted: boolean } } };
      expect(cancelledStatus.plan).toMatchObject({ status: 'cancelled', mr: { submitted: false } });

      // 后续 tick 不创建 join/MR，也不复活任何任务。
      const before = (await store.all()).length;
      await materializer.tick();
      await materializer.tick();
      expect(await store.byTask(planTaskId(p.planId, 1, 'j'))).toHaveLength(0);
      expect(await store.byTask(planTaskId(p.planId, 1, 'mr'))).toHaveLength(0);
      expect((await store.all()).length).toBe(before);
      expect(derivePlanProgress(p, await statesOf(store), [p]).status).toBe('cancelled');

      // 已终态 root：already-terminal，不再级联。
      const again = await toolByName('task_cancel')!.handler(
        { taskId: planRootTaskId(p.planId, 1) },
        { dir, mebular: live, agent: A.agent } as ToolContext,
      ) as { ok: boolean; reason: string };
      expect(again).toMatchObject({ ok: false, reason: 'already-terminal' });
      for (const worker of workers) await worker.close();
    } finally {
      await live.shutdown();
    }
  });

  it('已提交 MR 不撤销；step cancel 只取消该 step 子树并让 plan failed（非 cancelled）', async () => {
    const { live, store, plans } = await openLive();
    const submittedPlan = smallPlan({ planId: 'plan-cancel-mr-001', createdAt: 700 });
    try {
      await submit(live, submittedPlan);
      const workers = await openWorkers(store);
      const materializer = new PlanMaterializer({ device: A.device, agent: A.agent, plans, store, routing: routingFor([B, C, J]) });
      // 跑到 MR 创建、执行并 done，但先不 tick 让 root done。
      for (let i = 0; i < 10; i++) {
        await materializer.tick();
        await executeTargets(workers.filter((worker) => worker.endpoint.device !== A.device));
        if ((await store.byTask(planTaskId(submittedPlan.planId, 1, 'mr'))).length > 0) break;
      }
      const mrTaskId = planTaskId(submittedPlan.planId, 1, 'mr');
      await executeTargets(workers.filter((worker) => worker.endpoint.device === A.device));
      expect(reduceTaskEvents(await store.byTask(mrTaskId))?.status).toBe('done');
      expect(reduceTaskEvents(await store.byTask(planRootTaskId(submittedPlan.planId, 1)))?.status).toBe('running');

      const cancel = await toolByName('task_cancel')!.handler(
        { taskId: planRootTaskId(submittedPlan.planId, 1) },
        { dir, mebular: live, agent: A.agent } as ToolContext,
      ) as { ok: boolean; reason: string };
      expect(cancel).toMatchObject({ ok: true, reason: 'CANCELLED' });
      // 已提交 MR 不撤销；root 取消后不再提交新 MR。
      expect(reduceTaskEvents(await store.byTask(mrTaskId))?.status).toBe('done');
      expect(derivePlanProgress(submittedPlan, await statesOf(store), await plans.list()).status).toBe('cancelled');
      await materializer.tick();
      expect(planMrTaskRefs(submittedPlan.planId, await plans.list(), await statesOf(store))).toHaveLength(1);

      // step cancel：新 plan，取消 b 及其派生子树；plan 派生 failed 而非 cancelled。
      const stepPlan = smallPlan({ planId: 'plan-cancel-step-001', createdAt: 800 });
      await submit(live, stepPlan);
      const stepMaterializer = new PlanMaterializer({ device: A.device, agent: A.agent, plans, store, routing: routingFor([B, C, J]) });
      await stepMaterializer.tick();
      const bTaskId = planTaskId(stepPlan.planId, 1, 'b');
      const childId = `${bTaskId}~c0`;
      await store.append({
        v: 1,
        eventId: `${childId}#created`,
        taskId: childId,
        type: 'created',
        actor: B,
        at: Date.now(),
        toStatus: 'queued',
        trace: { causedBy: bTaskId, chain: [bTaskId] },
        to: C,
        intent: 'child',
      });
      const stepCancel = await toolByName('task_cancel')!.handler(
        { taskId: bTaskId },
        { dir, mebular: live, agent: A.agent } as ToolContext,
      ) as { ok: boolean; reason: string };
      expect(stepCancel).toMatchObject({ ok: true, reason: 'CANCELLED' });
      expect(reduceTaskEvents(await store.byTask(bTaskId))?.status).toBe('failed');
      expect(reduceTaskEvents(await store.byTask(childId))?.status).toBe('failed');
      await stepMaterializer.tick();
      const stepRoot = reduceTaskEvents(await store.byTask(planRootTaskId(stepPlan.planId, 1)));
      expect(stepRoot).toMatchObject({ status: 'failed', reason: 'STEP_FAILED:b' });
      expect(derivePlanProgress(stepPlan, await statesOf(store), await plans.list()).status).toBe('failed');
      expect(await store.byTask(planTaskId(stepPlan.planId, 1, 'j'))).toHaveLength(0);
      for (const worker of workers) await worker.close();
    } finally {
      await live.shutdown();
    }
  });
});

describe('P4 MR 形状校验', () => {
  it('MR step 的 to 必须等于 owner；禁止 route', () => {
    const wrongTo = smallPlan({
      planId: 'plan-mr-shape-wrong-to-001',
      steps: smallPlan().steps.map((step) => step.stepId === 'mr'
        ? { ...step, to: B }
        : step),
    });
    expect(validatePlan(wrongTo, { caller: A })).toMatchObject({ ok: false, code: 'PLAN_MR' });

    const withRoute = smallPlan({
      planId: 'plan-mr-shape-route-001',
      steps: smallPlan().steps.map((step) => step.stepId === 'mr'
        ? { ...step, route: { require: [], prefer: [], strategy: 'deterministic' as const } }
        : step),
    });
    expect(validatePlan(withRoute, { caller: A })).toMatchObject({ ok: false, code: 'PLAN_MR' });

    const ownerTo = smallPlan({ planId: 'plan-mr-shape-owner-001' });
    expect(validatePlan(ownerTo, { caller: A }).ok).toBe(true);
  });
});
