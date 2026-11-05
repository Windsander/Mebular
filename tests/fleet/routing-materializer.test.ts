// P3 materializer 接入：route → 创建 step task；显式 to 硬过滤不改派；NO_TARGET/POLICY_DENIED
// 不建 task；P2 幂等/确定性 taskId 不变；不创建 join/MR。
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mebular } from '@mebular/core';
import {
  AGENT_TASK_TOOL_NAMES,
  FileTaskEventStore,
  MebularTaskEventStore,
  MebularTaskPlanStore,
  PlanMaterializer,
  TASK_TOOLS,
  appendCapabilityCard,
  compileCapabilityCards,
  daemonRoutingProvider,
  derivePlanProgress,
  loadToolConfig,
  offlineMebularOptions,
  onboardDevice,
  planRootTaskId,
  planTaskId,
  readMasterKeyFile,
  reduceTaskEvents,
  signAgentCapabilityCard,
  toolByName,
  type AgentCapabilityCard,
  type PlanAppendResult,
  type PlanRoutingProvider,
  type TaskEvent,
  type TaskPlan,
  type TaskPlanWriteStore,
  type TaskState,
  type ToolContext,
} from '../../packages/fleet/src/index.js';

const A = { device: 'device-A', agent: 'planner' };
const B = { device: 'device-B', agent: 'worker' };
const C = { device: 'device-C', agent: 'worker' };
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
    this.plans.push(stored);
    return { stored: true, replayed: false, plan: stored, nodeId: `mem-${this.plans.length}`, createdBy: stored.owner.device };
  }

  async close(): Promise<void> {
    // memory
  }
}

function card(device: string, agent: string, capabilities: string[]): AgentCapabilityCard {
  return {
    v: 1,
    kind: 'agent_capability_card',
    device,
    agent,
    version: 1,
    capabilities: ['fleet.task', ...capabilities],
    tools: [...AGENT_TASK_TOOL_NAMES],
    limits: { maxConcurrency: 2 },
    permissions: { taskNamespaces: ['tasks'] },
    runtime: { os: 'test', arch: 'test', runtime: 'node', runtimeVersion: '20' },
    provenance: { source: 'test', configHash: 'cfg', registryHash: 'reg', publishedAt: 1 },
    signature: { alg: 'Ed25519', keyId: device, sig: 'sig' },
  };
}

function routing(overrides: Partial<PlanRoutingProvider> = {}): PlanRoutingProvider {
  return {
    cards: async () => [card(B.device, B.agent, ['api']), card(C.device, C.agent, ['ui'])],
    authorized: () => ({ devices: [B.device, C.device] }),
    online: () => true,
    observations: () => [],
    namespace: 'tasks',
    ...overrides,
  };
}

function plan(overrides: Partial<TaskPlan> = {}, steps?: TaskPlan['steps']): TaskPlan {
  return {
    v: 1,
    kind: 'task_plan',
    planId: 'plan-route-materializer-001',
    version: 1,
    owner: A,
    goal: 'route materializer',
    createdAt: 1,
    budget: { maxSteps: 4, maxAttemptsPerStep: 2 },
    policy: {
      allowedDevices: [B.device, C.device],
      allowedAgents: ['worker'],
      requireCapabilities: ['fleet.task'],
      maxParallel: 2,
      allowSubcontract: false,
    },
    steps: steps ?? [
      {
        stepId: 'api',
        kind: 'task',
        intent: 'api-work',
        dependsOn: [],
        route: { require: ['api'], prefer: [], strategy: 'deterministic' },
        acceptance: { kind: 'non-empty-result' },
      },
      { stepId: 'gate', kind: 'reduce', intent: 'gate', dependsOn: ['api'], join: { mode: 'all' }, acceptance: { kind: 'non-empty-result' } },
      { stepId: 'mr', kind: 'mr', intent: 'mr', dependsOn: ['gate'], acceptance: { kind: 'mr-once' } },
    ],
    ...overrides,
  };
}

async function statesOf(store: FileTaskEventStore): Promise<TaskState[]> {
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

let dir: string;
let store: FileTaskEventStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fleet-routing-materializer-'));
  store = await FileTaskEventStore.open(join(dir, 'events.jsonl'));
});

afterEach(async () => {
  await store.close();
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe('P3 materializer route', () => {
  it('route step：解析 chosen 后创建确定性 task；why 可解释；重复 tick 不重复', async () => {
    const p = plan();
    const plans = new MemoryPlans();
    await plans.append(p);
    const materializer = new PlanMaterializer({ device: A.device, agent: A.agent, plans, store, routing: routing() });

    const first = await materializer.tick();
    const taskId = planTaskId(p.planId, 1, 'api');
    expect(first.tasksCreated).toEqual([taskId]);
    expect(first.assignments).toEqual([expect.objectContaining({
      planId: p.planId,
      version: 1,
      stepId: 'api',
      taskId,
      chosen: B,
      why: expect.objectContaining({
        code: 'ASSIGNED',
        hardFilters: ['authorized', 'policy', 'executable', 'health', 'capability', 'payload', 'online', 'capacity'],
        tieBreak: 'rendezvous-sha256',
        roleCard: 'disabled',
      }),
    })]);
    expect(first.assignments[0]!.why.ranking[0]).toMatchObject({ device: B.device, agent: B.agent });
    expect((await store.byTask(taskId))[0]).toMatchObject({
      eventId: `${taskId}#created`,
      type: 'created',
      to: B,
      trace: { chain: [] },
    });
    expect(await store.byTask(planTaskId(p.planId, 1, 'gate'))).toHaveLength(0);
    expect(await store.byTask(planTaskId(p.planId, 1, 'mr'))).toHaveLength(0);

    const second = await materializer.tick();
    expect(second.tasksCreated).toEqual([]);
    expect((await store.byTask(taskId)).length).toBe(1);

    const progress = derivePlanProgress(p, await statesOf(store), [p]);
    expect(progress.steps.find((step) => step.stepId === 'api')?.status).toBe('dispatched');
  });

  it('B1 route：同 tick 两个 ready step、唯一候选容量 1 → 只建 1 个，另一个 AT_CAPACITY', async () => {
    const p = plan({
      planId: 'plan-route-materializer-capacity-route-001',
      policy: { allowedDevices: [B.device], allowedAgents: ['worker'], requireCapabilities: ['fleet.task'], maxParallel: 2, allowSubcontract: false },
    }, [
      { stepId: 'a', kind: 'task', intent: 'a', dependsOn: [], route: { require: ['api'], prefer: [], strategy: 'deterministic' }, acceptance: { kind: 'non-empty-result' } },
      { stepId: 'b', kind: 'task', intent: 'b', dependsOn: [], route: { require: ['api'], prefer: [], strategy: 'deterministic' }, acceptance: { kind: 'non-empty-result' } },
      { stepId: 'gate', kind: 'reduce', intent: 'gate', dependsOn: ['a', 'b'], join: { mode: 'all' }, acceptance: { kind: 'non-empty-result' } },
      { stepId: 'mr', kind: 'mr', intent: 'mr', dependsOn: ['gate'], acceptance: { kind: 'mr-once' } },
    ]);
    const plans = new MemoryPlans();
    await plans.append(p);
    const limited = card(B.device, B.agent, ['api']);
    limited.limits = { maxConcurrency: 1 };
    const materializer = new PlanMaterializer({
      device: A.device,
      agent: A.agent,
      plans,
      store,
      routing: routing({ cards: async () => [limited], authorized: () => ({ devices: [B.device] }) }),
    });
    const tick = await materializer.tick();
    expect(tick.tasksCreated).toEqual([planTaskId(p.planId, 1, 'a')]);
    expect(tick.assignments).toEqual([expect.objectContaining({ stepId: 'a', chosen: B })]);
    expect(tick.blocked).toEqual([expect.objectContaining({
      stepId: 'b',
      code: 'NO_TARGET',
      blockedBy: ['AT_CAPACITY'],
    })]);
    expect(await store.byTask(planTaskId(p.planId, 1, 'b'))).toHaveLength(0);
    expect(await store.byTask(planTaskId(p.planId, 1, 'gate'))).toHaveLength(0);
    expect(await store.byTask(planTaskId(p.planId, 1, 'mr'))).toHaveLength(0);
  });

  it('B1 显式 to：同 tick 两个 ready step、容量 1 → 只建 1 个，另一个 AT_CAPACITY', async () => {
    const p = plan({
      planId: 'plan-route-materializer-capacity-explicit-001',
      policy: { allowedDevices: [B.device], allowedAgents: ['worker'], requireCapabilities: ['fleet.task'], maxParallel: 2, allowSubcontract: false },
    }, [
      { stepId: 'a', kind: 'task', intent: 'a', dependsOn: [], to: B, acceptance: { kind: 'non-empty-result' } },
      { stepId: 'b', kind: 'task', intent: 'b', dependsOn: [], to: B, acceptance: { kind: 'non-empty-result' } },
      { stepId: 'gate', kind: 'reduce', intent: 'gate', dependsOn: ['a', 'b'], join: { mode: 'all' }, acceptance: { kind: 'non-empty-result' } },
      { stepId: 'mr', kind: 'mr', intent: 'mr', dependsOn: ['gate'], acceptance: { kind: 'mr-once' } },
    ]);
    const plans = new MemoryPlans();
    await plans.append(p);
    const limited = card(B.device, B.agent, ['api']);
    limited.limits = { maxConcurrency: 1 };
    const materializer = new PlanMaterializer({
      device: A.device,
      agent: A.agent,
      plans,
      store,
      routing: routing({ cards: async () => [limited], authorized: () => ({ devices: [B.device] }) }),
    });
    const tick = await materializer.tick();
    expect(tick.tasksCreated).toEqual([planTaskId(p.planId, 1, 'a')]);
    expect(tick.blocked).toEqual([expect.objectContaining({ stepId: 'b', blockedBy: ['AT_CAPACITY'] })]);
    expect(await store.byTask(planTaskId(p.planId, 1, 'b'))).toHaveLength(0);
  });

  it('B2 daemon 授权：B 有可验证卡但未订阅 tasks → 不建 task；订阅后才路由', async () => {
    const p = plan({
      planId: 'plan-route-materializer-daemon-auth-001',
      policy: { allowedDevices: [B.device], allowedAgents: ['worker'], requireCapabilities: ['fleet.task'], maxParallel: 1, allowSubcontract: false },
    }, [
      { stepId: 'api', kind: 'task', intent: 'api', dependsOn: [], route: { require: ['api'], prefer: [], strategy: 'deterministic' }, acceptance: { kind: 'non-empty-result' } },
      { stepId: 'gate', kind: 'reduce', intent: 'gate', dependsOn: ['api'], join: { mode: 'all' }, acceptance: { kind: 'non-empty-result' } },
      { stepId: 'mr', kind: 'mr', intent: 'mr', dependsOn: ['gate'], acceptance: { kind: 'mr-once' } },
    ]);
    const plans = new MemoryPlans();
    await plans.append(p);
    const subscribed = new Set<string>();
    const routingProvider = daemonRoutingProvider({
      backend: {
        listCards: async () => [card(B.device, B.agent, ['api'])],
        getSubscriptions: async (device: string) => (subscribed.has(device) ? ['tasks'] : []),
      },
      config: { device: A.device, namespace: 'tasks', peers: [{ device: B.device }] },
      store,
      online: () => true,
    });
    const materializer = new PlanMaterializer({ device: A.device, agent: A.agent, plans, store, routing: routingProvider });

    const before = await materializer.tick();
    expect(before.tasksCreated).toEqual([]);
    expect(before.blocked).toEqual([expect.objectContaining({
      planId: p.planId,
      stepId: 'api',
      code: 'NO_TARGET',
      blockedBy: ['NO_CANDIDATES'],
    })]);
    expect(await store.byTask(planTaskId(p.planId, 1, 'api'))).toHaveLength(0);

    subscribed.add(B.device);
    const after = await materializer.tick();
    expect(after.tasksCreated).toEqual([planTaskId(p.planId, 1, 'api')]);
    expect(after.assignments).toEqual([expect.objectContaining({ stepId: 'api', chosen: B })]);
    expect((await store.byTask(planTaskId(p.planId, 1, 'api')))[0]?.to).toEqual(B);
  });

  it('显式 to 通过硬过滤 → 创建且 chosen 仍是该目标', async () => {
    const p = plan({
      planId: 'plan-route-materializer-explicit-ok-001',
    }, [
      { stepId: 'api', kind: 'task', intent: 'api', dependsOn: [], to: B, route: { require: ['api'], prefer: [], strategy: 'deterministic' }, acceptance: { kind: 'non-empty-result' } },
      { stepId: 'gate', kind: 'reduce', intent: 'gate', dependsOn: ['api'], join: { mode: 'all' }, acceptance: { kind: 'non-empty-result' } },
      { stepId: 'mr', kind: 'mr', intent: 'mr', dependsOn: ['gate'], acceptance: { kind: 'mr-once' } },
    ]);
    const plans = new MemoryPlans();
    await plans.append(p);
    const materializer = new PlanMaterializer({ device: A.device, agent: A.agent, plans, store, routing: routing() });
    const tick = await materializer.tick();
    const taskId = planTaskId(p.planId, 1, 'api');
    expect(tick.tasksCreated).toEqual([taskId]);
    expect(tick.assignments).toEqual([expect.objectContaining({ stepId: 'api', chosen: B })]);
    expect((await store.byTask(taskId))[0]?.to).toEqual(B);
  });

  it('显式 to 越 policy → 不建 task、不改派；进度 blocked/POLICY_DENIED', async () => {
    const p = plan({
      planId: 'plan-route-materializer-policy-001',
      policy: { allowedDevices: [B.device], allowedAgents: ['worker'], requireCapabilities: ['fleet.task'], maxParallel: 1, allowSubcontract: false },
    }, [
      { stepId: 'api', kind: 'task', intent: 'api-work', dependsOn: [], to: C, acceptance: { kind: 'non-empty-result' } },
      { stepId: 'gate', kind: 'reduce', intent: 'gate', dependsOn: ['api'], join: { mode: 'all' }, acceptance: { kind: 'non-empty-result' } },
      { stepId: 'mr', kind: 'mr', intent: 'mr', dependsOn: ['gate'], acceptance: { kind: 'mr-once' } },
    ]);
    const plans = new MemoryPlans();
    await plans.append(p);
    const materializer = new PlanMaterializer({ device: A.device, agent: A.agent, plans, store, routing: routing({ cards: async () => [card(C.device, C.agent, ['api'])] }) });

    const tick = await materializer.tick();
    expect(tick.tasksCreated).toEqual([]);
    expect(await store.byTask(planTaskId(p.planId, 1, 'api'))).toHaveLength(0);
    const progress = derivePlanProgress(p, await statesOf(store), [p]);
    expect(progress.steps.find((step) => step.stepId === 'api')).toMatchObject({
      status: 'blocked',
      blockedBy: ['POLICY_DENIED'],
    });
  });

  it('显式 to 缺 route.require 能力 → blocked/MISSING_CAPABILITY，不建 task、不改派', async () => {
    const p = plan({
      planId: 'plan-route-materializer-explicit-001',
    }, [
      {
        stepId: 'api',
        kind: 'task',
        intent: 'api-work',
        dependsOn: [],
        to: C,
        route: { require: ['api'], prefer: [], strategy: 'deterministic' },
        acceptance: { kind: 'non-empty-result' },
      },
      { stepId: 'gate', kind: 'reduce', intent: 'gate', dependsOn: ['api'], join: { mode: 'all' }, acceptance: { kind: 'non-empty-result' } },
      { stepId: 'mr', kind: 'mr', intent: 'mr', dependsOn: ['gate'], acceptance: { kind: 'mr-once' } },
    ]);
    const plans = new MemoryPlans();
    await plans.append(p);
    const materializer = new PlanMaterializer({ device: A.device, agent: A.agent, plans, store, routing: routing() });
    const tick = await materializer.tick();
    expect(tick.tasksCreated).toEqual([]);
    expect(tick.assignments).toEqual([]);
    expect(tick.blocked).toEqual([expect.objectContaining({
      planId: p.planId,
      stepId: 'api',
      code: 'NO_TARGET',
      blockedBy: ['MISSING_CAPABILITY'],
      rejected: [{ device: C.device, agent: C.agent, code: 'MISSING_CAPABILITY', detail: 'api' }],
    })]);
    expect(await store.byTask(planTaskId(p.planId, 1, 'api'))).toHaveLength(0);
    expect(await store.byTask(planTaskId(p.planId, 1, 'gate'))).toHaveLength(0);
  });

  it('route 无候选 → blocked/NO_TARGET；无 route/to → blocked/NO_TARGET；都不建 task', async () => {
    const noCandidate = plan({
      planId: 'plan-route-materializer-none-001',
    }, [
      { stepId: 'api', kind: 'task', intent: 'api', dependsOn: [], route: { require: ['gpu'], prefer: [], strategy: 'deterministic' }, acceptance: { kind: 'non-empty-result' } },
      { stepId: 'gate', kind: 'reduce', intent: 'gate', dependsOn: ['api'], join: { mode: 'all' }, acceptance: { kind: 'non-empty-result' } },
      { stepId: 'mr', kind: 'mr', intent: 'mr', dependsOn: ['gate'], acceptance: { kind: 'mr-once' } },
    ]);
    const noTarget = plan({
      planId: 'plan-route-materializer-no-target-001',
    }, [
      { stepId: 'api', kind: 'task', intent: 'api', dependsOn: [], acceptance: { kind: 'non-empty-result' } },
      { stepId: 'gate', kind: 'reduce', intent: 'gate', dependsOn: ['api'], join: { mode: 'all' }, acceptance: { kind: 'non-empty-result' } },
      { stepId: 'mr', kind: 'mr', intent: 'mr', dependsOn: ['gate'], acceptance: { kind: 'mr-once' } },
    ]);
    const plans = new MemoryPlans();
    await plans.append(noCandidate);
    const materializer = new PlanMaterializer({ device: A.device, agent: A.agent, plans, store, routing: routing() });
    const none = await materializer.tick();
    expect(none.tasksCreated).toEqual([]);
    expect(none.blocked).toEqual([expect.objectContaining({ planId: noCandidate.planId, stepId: 'api', blockedBy: ['MISSING_CAPABILITY'] })]);

    await plans.append(noTarget);
    const materializer2 = new PlanMaterializer({ device: A.device, agent: A.agent, plans, store, routing: routing() });
    const blocked = await materializer2.tick();
    expect(blocked.tasksCreated).toEqual([]);
    expect(await store.byTask(planTaskId(noTarget.planId, 1, 'api'))).toHaveLength(0);
    const progress = derivePlanProgress(noTarget, await statesOf(store), [noTarget]);
    expect(progress.steps.find((step) => step.stepId === 'api')).toMatchObject({ status: 'blocked', blockedBy: ['NO_TARGET'] });
  });

  it('routing provider 卡片读取失败 → fail-closed（显式 to 也不建 task）', async () => {
    const p = plan({
      planId: 'plan-route-materializer-failclosed-001',
    }, [
      { stepId: 'api', kind: 'task', intent: 'api', dependsOn: [], to: B, acceptance: { kind: 'non-empty-result' } },
      { stepId: 'gate', kind: 'reduce', intent: 'gate', dependsOn: ['api'], join: { mode: 'all' }, acceptance: { kind: 'non-empty-result' } },
      { stepId: 'mr', kind: 'mr', intent: 'mr', dependsOn: ['gate'], acceptance: { kind: 'mr-once' } },
    ]);
    const plans = new MemoryPlans();
    await plans.append(p);
    const materializer = new PlanMaterializer({
      device: A.device,
      agent: A.agent,
      plans,
      store,
      routing: routing({ cards: async () => { throw new Error('unavailable'); } }),
    });
    const tick = await materializer.tick();
    expect(tick.tasksCreated).toEqual([]);
    expect(tick.blocked).toEqual([expect.objectContaining({ stepId: 'api', blockedBy: ['MISSING_CAPABILITY'] })]);
    expect(await store.byTask(planTaskId(p.planId, 1, 'api'))).toHaveLength(0);
  });

  it('无 routing provider：route 与显式 to 都 fail-closed，不建 task', async () => {
    const routePlan = plan({ planId: 'plan-route-materializer-legacy-001' });
    const explicitPlan = plan({
      planId: 'plan-route-materializer-legacy-explicit-001',
    }, [
      { stepId: 'api', kind: 'task', intent: 'api', dependsOn: [], to: B, acceptance: { kind: 'non-empty-result' } },
      { stepId: 'gate', kind: 'reduce', intent: 'gate', dependsOn: ['api'], join: { mode: 'all' }, acceptance: { kind: 'non-empty-result' } },
      { stepId: 'mr', kind: 'mr', intent: 'mr', dependsOn: ['gate'], acceptance: { kind: 'mr-once' } },
    ]);
    const plans = new MemoryPlans();
    await plans.append(routePlan);
    await plans.append(explicitPlan);
    const materializer = new PlanMaterializer({ device: A.device, agent: A.agent, plans, store });
    const tick = await materializer.tick();
    expect(tick.tasksCreated).toEqual([]);
    expect(tick.blocked).toEqual([
      expect.objectContaining({ planId: routePlan.planId, stepId: 'api', detail: 'routing-unavailable' }),
      expect.objectContaining({ planId: explicitPlan.planId, stepId: 'api', detail: 'routing-unavailable' }),
    ]);
    expect(await store.byTask(planTaskId(routePlan.planId, 1, 'api'))).toHaveLength(0);
    expect(await store.byTask(planTaskId(explicitPlan.planId, 1, 'api'))).toHaveLength(0);
  });

  it('旧 task_submit 不变；MCP 16 方法不变；不创建 join/MR', async () => {
    expect(TASK_TOOLS).toHaveLength(16);
    expect(new Set(TASK_TOOLS.map((tool) => tool.name)).size).toBe(16);
    expect(TASK_TOOLS.some((tool) => tool.name.startsWith('plan_') || tool.name.startsWith('agent_card_'))).toBe(false);

    // 旧路径（显式 to、无 plan）仍只写普通 task，不经过 route/materializer。
    await onboardDevice({ dir, device: A.device, agents: [{ name: 'worker', kind: 'echo' }] });
    const config = await loadToolConfig(dir);
    const live = new Mebular(offlineMebularOptions(config, await readMasterKeyFile(config.masterKeyFile)) as never);
    await live.initialize();
    try {
      const ctx: ToolContext = { dir, mebular: live, agent: A.agent };
      const result = await toolByName('task_submit')!.handler({ intent: 'plain', to: B }, ctx) as { ok: boolean; taskId: string };
      expect(result).toMatchObject({ ok: true });
      expect(result.taskId).toMatch(/^task-device-A-/);
      const status = await toolByName('task_status')!.handler({ taskId: result.taskId }, ctx) as Record<string, unknown>;
      expect(status).toMatchObject({ ok: true });
      expect(status.plan).toBeUndefined();
    } finally {
      await live.shutdown();
    }
  });
});

describe('P3 task_status.plan why', () => {
  let live: Mebular | null = null;

  afterEach(async () => {
    await live?.shutdown().catch(() => undefined);
    live = null;
  });

  it('route NO_TARGET 在 task_status.plan step 上 additive 返回 why/blockedBy', async () => {
    await onboardDevice({ dir, device: A.device, agents: [{ name: 'planner', kind: 'command', command: process.execPath }], peerDevice: B.device });
    const config = await loadToolConfig(dir);
    const encryption = await readMasterKeyFile(config.masterKeyFile);
    live = new Mebular(offlineMebularOptions(config, encryption) as never);
    await live.initialize();

    const b = new Mebular({
      storagePath: join(dir, 'device-B.jsonl'),
      deviceId: B.device,
      encryption,
      network: { enabled: false },
    });
    await b.initialize();
    try {
      const draft = compileCapabilityCards({
        config: { device: B.device, namespace: 'tasks', agents: [{ name: 'worker', kind: 'dsh', capabilities: ['api'] }] },
        now: 1,
      })[0]!;
      const signed = await signAgentCapabilityCard(b, draft);
      const nodeId = await appendCapabilityCard(live, signed);
      await live.graph.updateNode(nodeId, { createdBy: B.device });
      const bPublicKey = b.identity.getDeviceKey(B.device)!.publicKey;

      const fake = {
        deviceId: A.device,
        graph: live.graph,
        identity: live.identity,
        sync: {
          getPeerPublicKey: (device: string) => (device === B.device ? bPublicKey : undefined),
          getOnlinePeers: () => [{ deviceId: B.device, peerId: 'peer-B' }],
        },
        getSubscriptions: async (device: string) => (device === B.device ? ['tasks'] : []),
        getPeerPath: (device: string) => (device === B.device ? { kind: 'direct', address: 'test', since: 1 } : null),
        shutdown: async () => undefined,
      };
      const p: TaskPlan = {
        v: 1,
        kind: 'task_plan',
        planId: 'plan-status-why-001',
        version: 1,
        owner: A,
        goal: 'why',
        createdAt: 1,
        budget: { maxSteps: 3, maxAttemptsPerStep: 1 },
        policy: { allowedDevices: [B.device], allowedAgents: ['worker'], requireCapabilities: ['fleet.task'], maxParallel: 1, allowSubcontract: false },
        steps: [
          { stepId: 'api', kind: 'task', intent: 'api', dependsOn: [], route: { require: ['gpu'], prefer: [], strategy: 'deterministic' }, acceptance: { kind: 'non-empty-result' } },
          { stepId: 'gate', kind: 'reduce', intent: 'gate', dependsOn: ['api'], join: { mode: 'all' }, acceptance: { kind: 'non-empty-result' } },
          { stepId: 'mr', kind: 'mr', intent: 'mr', dependsOn: ['gate'], acceptance: { kind: 'mr-once' } },
        ],
      };
      const ctx = { dir, agent: A.agent, mebular: fake as never };
      const submitted = await toolByName('task_submit')!.handler(
        { intent: 'submit', to: SENTINEL, plan: p },
        ctx,
      ) as Record<string, unknown>;
      expect(submitted).toMatchObject({ ok: true, rootTaskId: planRootTaskId(p.planId, 1) });
      const materializer = new PlanMaterializer({
        device: A.device,
        agent: A.agent,
        plans: new MebularTaskPlanStore(live),
        store: new MebularTaskEventStore(live),
      });
      const tick = await materializer.tick();
      expect(tick.tasksCreated).toEqual([]);
      expect(tick.blocked).toEqual([expect.objectContaining({ stepId: 'api', detail: 'routing-unavailable' })]);

      const status = await toolByName('task_status')!.handler(
        { taskId: planRootTaskId(p.planId, 1) },
        ctx,
      ) as {
        ok: boolean;
        state: { status: string };
        plan: { status: string; steps: Array<{ stepId: string; status: string; blockedBy?: string[]; why?: { code: string; hardFilters: string[]; ranking: unknown[]; rejected?: unknown } }>; blockedBy: string[] };
      };
      expect(status.ok).toBe(true);
      expect(status.state.status).toBe('running');
      const step = status.plan.steps.find((entry) => entry.stepId === 'api')!;
      expect(step).toMatchObject({
        status: 'blocked',
        blockedBy: ['MISSING_CAPABILITY'],
        why: {
          code: 'NO_TARGET',
          hardFilters: ['authorized', 'policy', 'executable', 'health', 'capability', 'payload', 'online', 'capacity'],
          tieBreak: 'rendezvous-sha256',
          roleCard: 'disabled',
        },
      });
      expect(step.why?.ranking).toEqual([]);
      expect(step.why).not.toHaveProperty('rejected');
      expect(status.plan.status).toBe('blocked');
      expect(status.plan.blockedBy).toContain('MISSING_CAPABILITY');
      expect(JSON.stringify(status)).not.toMatch(/api-work|prompt|command|token|secret/i);
    } finally {
      await b.shutdown();
    }
  });
});
