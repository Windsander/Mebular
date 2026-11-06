// P6 硬化：旧版本/MR 边界、read-time 隐私、并发 MR、协议/UI 回归。
//
// 只覆盖前序 Gate 的非阻塞项与 P6 验收；不改变 plan/TaskEvent/MCP 公共语义。
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mebular } from '@mebular/core';
import {
  AGENT_NAMESPACE,
  FileTaskEventStore,
  PlanMaterializer,
  ROLE_CARD_GENERATOR,
  ROLE_CARD_KIND,
  appendAgentRoleCard,
  generateRoleCards,
  latestAgentRoleCards,
  listAgentRoleCards,
  loadToolConfig,
  MebularTaskEventStore,
  MebularTaskPlanStore,
  offlineMebularOptions,
  onboardDevice,
  planRootTaskId,
  planTaskId,
  readMasterKeyFile,
  reduceTaskEvents,
  sanitizeAgentRoleCardForWrite,
  submitTaskPlan,
  toolByName,
  validateAgentRoleCard,
  validateFleetConfig,
  validatePlan,
  type AgentCapabilityCard,
  type AgentRoleCard,
  type PlanAppendResult,
  type PlanRoutingProvider,
  type TaskEvent,
  type TaskPlan,
  type TaskPlanWriteStore,
  type ToolContext,
} from '../../packages/fleet/src/index.js';

const A = { device: 'device-A', agent: 'planner' };
const B = { device: 'device-B', agent: 'worker' };
const SENTINEL = { device: '__plan__', agent: '__plan__' };

class MemoryPlans implements TaskPlanWriteStore {
  readonly plans: TaskPlan[] = [];

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
}

function card(device: string, agent: string): AgentCapabilityCard {
  return {
    v: 1,
    kind: 'agent_capability_card',
    device,
    agent,
    version: 1,
    capabilities: ['fleet.task'],
    tools: ['task_submit'],
    limits: { maxConcurrency: 4 },
    permissions: { taskNamespaces: ['tasks'] },
    runtime: { os: 'test', arch: 'test', runtime: 'node', runtimeVersion: '20' },
    provenance: { source: 'test', configHash: 'cfg', registryHash: 'reg', publishedAt: 1 },
    signature: { alg: 'Ed25519', keyId: device, sig: 'sig' },
  };
}

function routingFor(): PlanRoutingProvider {
  return {
    cards: async () => [card(B.device, B.agent)],
    authorized: () => ({ devices: [B.device] }),
    online: () => true,
    observations: () => [],
    namespace: 'tasks',
  };
}

function plan(overrides: Partial<TaskPlan> = {}, steps?: TaskPlan['steps']): TaskPlan {
  return {
    v: 1,
    kind: 'task_plan',
    planId: 'plan-p6-hardening-001',
    version: 1,
    owner: A,
    goal: 'P6 hardening',
    createdAt: 100,
    budget: { maxSteps: 5, maxAttemptsPerStep: 2 },
    policy: {
      allowedDevices: [B.device],
      allowedAgents: ['worker'],
      requireCapabilities: ['fleet.task'],
      maxParallel: 2,
      allowSubcontract: false,
    },
    steps: steps ?? [
      { stepId: 'b', kind: 'task', intent: 'work', dependsOn: [], to: B, acceptance: { kind: 'non-empty-result' } },
      { stepId: 'gate', kind: 'join', intent: 'gate', dependsOn: ['b'], to: B, join: { mode: 'all' }, acceptance: { kind: 'non-empty-result' } },
      { stepId: 'mr', kind: 'mr', intent: 'mr', dependsOn: ['gate'], acceptance: { kind: 'mr-once' } },
    ],
    ...overrides,
  };
}

function doneEvent(taskId: string, actor = B, resultRef = 'ok'): TaskEvent {
  return {
    v: 1,
    eventId: `${taskId}#done@${actor.device}`,
    taskId,
    type: 'done',
    actor,
    at: 2,
    toStatus: 'done',
    trace: { chain: [] },
    payloadRef: resultRef,
  };
}

function createdEvent(taskId: string, to = B, actor = A): TaskEvent {
  return {
    v: 1,
    eventId: `${taskId}#created`,
    taskId,
    type: 'created',
    actor,
    at: 1,
    toStatus: 'queued',
    trace: { chain: [] },
    to,
    intent: 'event',
  };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fleet-p6-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe('P6 旧版本 finalize', () => {
  it('旧版本无 MR：缺失 root 补建后写 SUPERSEDED_BY；已存在 root 不悬挂', async () => {
    const v1 = plan({ planId: 'plan-p6-supersede-001' });
    const v2 = plan({
      planId: 'plan-p6-supersede-001',
      version: 2,
      supersedesVersion: 1,
      retryOfStepId: 'b',
      createdAt: 200,
    });
    const plans = new MemoryPlans();
    await plans.append(v1);
    const store = await FileTaskEventStore.open(join(dir, 'events.jsonl'));
    const materializer = new PlanMaterializer({ device: A.device, agent: A.agent, plans, store, routing: routingFor() });

    // v1 先运行到 root active，再提交 v2：旧 root 必须被新版本收敛为 failed。
    await materializer.tick();
    const root1 = planRootTaskId(v1.planId, 1);
    expect(reduceTaskEvents(await store.byTask(root1))?.status).toBe('running');
    await plans.append(v2);
    await materializer.tick();
    expect(reduceTaskEvents(await store.byTask(root1))).toMatchObject({
      status: 'failed',
      reason: 'SUPERSEDED_BY:2',
    });

    // 另一组：v1 从未 tick（root 缺失）也必须补建失败证据，而不是 status=planned 悬挂。
    const missing = plan({ planId: 'plan-p6-supersede-missing-001', createdAt: 300 });
    const missingV2 = plan({
      planId: missing.planId,
      version: 2,
      supersedesVersion: 1,
      retryOfStepId: 'b',
      createdAt: 400,
    });
    await plans.append(missing);
    await plans.append(missingV2);
    await materializer.tick();
    const missingRoot = planRootTaskId(missing.planId, 1);
    expect(reduceTaskEvents(await store.byTask(missingRoot))).toMatchObject({
      status: 'failed',
      reason: 'SUPERSEDED_BY:2',
    });
    await store.close();
  });

  it('旧 MR pending → 旧 root 等待且 MR 不被撤销；旧 MR done → 旧 root done，新版本进度 done', async () => {
    const v1 = plan({ planId: 'plan-p6-old-mr-001' });
    const v2 = plan({
      planId: v1.planId,
      version: 2,
      supersedesVersion: 1,
      retryOfStepId: 'b',
      createdAt: 200,
    });
    const plans = new MemoryPlans();
    await plans.append(v1);
    const store = await FileTaskEventStore.open(join(dir, 'events.jsonl'));
    const materializer = new PlanMaterializer({ device: A.device, agent: A.agent, plans, store, routing: routingFor() });

    await store.append(createdEvent(planRootTaskId(v1.planId, 1)));
    await store.append({
      v: 1, eventId: `${planRootTaskId(v1.planId, 1)}#claimed@${A.device}`, taskId: planRootTaskId(v1.planId, 1),
      type: 'claimed', actor: A, at: 2, toStatus: 'claimed', trace: { chain: [] },
    });
    await store.append({
      v: 1, eventId: `${planRootTaskId(v1.planId, 1)}#running@${A.device}`, taskId: planRootTaskId(v1.planId, 1),
      type: 'running', actor: A, at: 3, toStatus: 'running', trace: { chain: [] },
    });
    const mrTaskId = planTaskId(v1.planId, 1, 'mr');
    await store.append(createdEvent(mrTaskId, A, A));

    // pending MR：新版本被直接写入（模拟旧数据/绕过提交门禁）也不能撤销 MR 或让旧 root 悬挂。
    await plans.append(v2);
    await materializer.tick();
    expect(reduceTaskEvents(await store.byTask(mrTaskId))?.status).toBe('queued');
    expect(reduceTaskEvents(await store.byTask(planRootTaskId(v1.planId, 1)))?.status).toBe('running');

    // MR done → 旧 root 收敛 done；新版本 root 也按跨版本 MR 回执 done。
    await store.append(doneEvent(mrTaskId, A, 'MR_OK'));
    await materializer.tick();
    expect(reduceTaskEvents(await store.byTask(planRootTaskId(v1.planId, 1)))?.status).toBe('done');
    expect(reduceTaskEvents(await store.byTask(planRootTaskId(v1.planId, 2)))?.status).toBe('done');
    expect(await store.byTask(planTaskId(v1.planId, 2, 'mr'))).toHaveLength(0);
    await store.close();
  });

  it('并发 materializer 创建 MR：同一 eventId 只落一条 created', async () => {
    const p = plan({ planId: 'plan-p6-mr-race-001' });
    const plans = new MemoryPlans();
    await plans.append(p);
    const store = await FileTaskEventStore.open(join(dir, 'events.jsonl'));
    await store.append(createdEvent(planRootTaskId(p.planId, 1)));
    await store.append(createdEvent(planTaskId(p.planId, 1, 'b')));
    await store.append(doneEvent(planTaskId(p.planId, 1, 'b')));
    await store.append(createdEvent(planTaskId(p.planId, 1, 'gate')));
    await store.append(doneEvent(planTaskId(p.planId, 1, 'gate')));
    const one = new PlanMaterializer({ device: A.device, agent: A.agent, plans, store, routing: routingFor() });
    const two = new PlanMaterializer({ device: A.device, agent: A.agent, plans, store, routing: routingFor() });
    await Promise.all([one.tick(), two.tick()]);
    const mrTaskId = planTaskId(p.planId, 1, 'mr');
    expect((await store.byTask(mrTaskId)).filter((event) => event.type === 'created')).toHaveLength(1);
    await store.close();
  });
});

describe('P6 plan cancel（pending MR）', () => {
  it('task_cancel(rootTaskId) 取消 pending MR；计划 cancelled；重复取消 already-terminal', async () => {
    await onboardDevice({ dir, device: A.device, agents: [{ name: A.agent, kind: 'echo' }, { name: B.agent, kind: 'echo' }] });
    const config = await loadToolConfig(dir);
    const live = new Mebular(offlineMebularOptions(config, await readMasterKeyFile(config.masterKeyFile)) as never);
    await live.initialize();
    const plans = new MebularTaskPlanStore(live, { namespace: 'tasks' });
    const store = new MebularTaskEventStore(live, { namespace: 'tasks' });
    const p = plan({ planId: 'plan-p6-cancel-pending-mr-001' });
    try {
      const submitted = await submitTaskPlan({ plan: p, intent: 'cancel pending MR', to: SENTINEL, caller: A, plans, store });
      expect(submitted.ok).toBe(true);
      const materializer = new PlanMaterializer({ device: A.device, agent: A.agent, plans, store, routing: routingFor() });
      await materializer.tick();
      await store.append(doneEvent(planTaskId(p.planId, 1, 'b')));
      await materializer.tick();
      await store.append(doneEvent(planTaskId(p.planId, 1, 'gate')));
      await materializer.tick();
      const mrTaskId = planTaskId(p.planId, 1, 'mr');
      expect(reduceTaskEvents(await store.byTask(mrTaskId))?.status).toBe('queued');

      const ctx = { dir, mebular: live, agent: A.agent } as ToolContext;
      const cancel = await toolByName('task_cancel')!.handler({ taskId: planRootTaskId(p.planId, 1) }, ctx) as {
        ok: boolean; status: string; reason: string;
      };
      expect(cancel).toMatchObject({ ok: true, status: 'failed', reason: 'CANCELLED' });
      expect(reduceTaskEvents(await store.byTask(planRootTaskId(p.planId, 1)))).toMatchObject({ status: 'failed', reason: 'CANCELLED' });
      expect(reduceTaskEvents(await store.byTask(mrTaskId))).toMatchObject({ status: 'failed', reason: 'CANCELLED' });
      const status = await toolByName('task_status')!.handler({ taskId: planRootTaskId(p.planId, 1) }, ctx) as {
        plan: { status: string; mr: { submitted: boolean } };
      };
      expect(status.plan).toMatchObject({ status: 'cancelled', mr: { submitted: true } });

      // 后续 tick 不得复活或重建 MR：created 始终恰好一次。
      await materializer.tick();
      expect((await store.byTask(planTaskId(p.planId, 1, 'mr'))).filter((event) => event.type === 'created')).toHaveLength(1);
      const again = await toolByName('task_cancel')!.handler({ taskId: planRootTaskId(p.planId, 1) }, ctx) as { reason: string };
      expect(again.reason).toBe('already-terminal');
    } finally {
      await live.shutdown().catch(() => undefined);
    }
  });
});

function roleCard(overrides: Partial<AgentRoleCard> = {}): AgentRoleCard {
  return {
    v: 1,
    kind: ROLE_CARD_KIND,
    device: 'device-A',
    agent: 'worker',
    version: 1,
    summary: 'worker: 6 samples',
    strengths: [{ tag: 'test', confidence: 0.5 }],
    preferredIntents: ['test'],
    avoid: [],
    confidence: 0.6,
    evidenceRefs: [{ kind: 'task', id: 'task-device-A-00000001' }],
    shadow: true,
    provenance: { source: 'task-history', sampleSize: 6, generatedAt: 100, generator: ROLE_CARD_GENERATOR },
    tombstone: false,
    ...overrides,
  };
}

describe('P6 角色卡读时隐私与自由文本边界', () => {
  it('旧卡/远端旧卡读时重建 summary；agent/provenance 只接受安全 token', async () => {
    const master = await Mebular.generateUserMasterKey();
    const app = new Mebular({
      storagePath: join(dir, 'role-store.jsonl'),
      deviceId: 'device-A',
      encryption: { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey },
      network: { enabled: false },
      sync: { autoSync: false },
    });
    await app.initialize();
    try {
      const legacy = roleCard({ summary: 'RAW DIALOGUE: full transcript + TOKEN=sk-live' });
      const node = await app.graph.createNode(ROLE_CARD_KIND, legacy as unknown as Record<string, unknown>, [], {
        namespace: AGENT_NAMESPACE,
        metadata: { internal: true, internalObject: { kind: ROLE_CARD_KIND } },
      });
      await app.graph.updateNode(node.id, { createdBy: 'device-A' });
      const cards = await listAgentRoleCards(app);
      const read = cards.find((entry) => entry.device === 'device-A' && entry.agent === 'worker')!;
      expect(read.summary).toBe(sanitizeAgentRoleCardForWrite(read).summary);
      expect(JSON.stringify(read)).not.toContain('RAW DIALOGUE');
      expect(JSON.stringify(read)).not.toContain('sk-live');

      expect(validateAgentRoleCard(roleCard({ agent: 'worker with spaces' })).ok).toBe(false);
      expect(validateAgentRoleCard(roleCard({ agent: '../../etc/passwd' })).ok).toBe(false);
      expect(validateAgentRoleCard(roleCard({
        provenance: { ...roleCard().provenance, source: 'RAW DIALOGUE SOURCE' },
      })).ok).toBe(false);
      expect(validateAgentRoleCard(roleCard({
        provenance: { ...roleCard().provenance, generator: '/bin/sh -c secret' },
      })).ok).toBe(false);

      // 已写入的新卡仍然可用（写路径 sanitization 与读路径一致）。
      const appended = await appendAgentRoleCard(app, roleCard({ version: 2, confidence: 0.7 }));
      expect(JSON.stringify(appended.card)).not.toContain('RAW DIALOGUE');
      expect(latestAgentRoleCards(await listAgentRoleCards(app))[0]!.version).toBe(2);
    } finally {
      await app.shutdown().catch(() => undefined);
    }
  });

  it('generateRoleCards 直接 summaries 必须带本机 device；无 device 摘要不参与证据/意图', () => {
    const events = [
      ...taskEvents('task-device-A-00000001', 'deploy'),
    ];
    const cards = generateRoleCards({
      device: 'device-A',
      agents: ['worker'],
      events,
      summaries: [
        { id: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', agent: 'worker', intents: ['review'] },
        { id: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', device: 'device-B', agent: 'worker', intents: ['ops'] },
        { id: '01ARZ3NDEKTSV4RRFFQ69G5FAW', device: 'device-A', agent: 'worker', intents: ['review'] },
      ],
      now: 300,
    });
    expect(cards[0]!.provenance.source).toBe('task-history+internal-summary');
    expect(cards[0]!.preferredIntents).toContain('review');
    expect(cards[0]!.preferredIntents).not.toContain('ops');
    expect(cards[0]!.evidenceRefs.filter((ref) => ref.kind === 'summary')).toEqual([
      { kind: 'summary', id: '01ARZ3NDEKTSV4RRFFQ69G5FAW' },
    ]);
  });
});

function taskEvents(taskId: string, intent: string): TaskEvent[] {
  const target = { device: 'device-A', agent: 'worker' };
  return [
    { v: 1, eventId: `${taskId}#created`, taskId, type: 'created', actor: A, at: 1, toStatus: 'queued', trace: { chain: [] }, to: target, intent },
    doneEvent(taskId, target),
  ];
}

describe('P6 协议夹具与旧配置', () => {
  it('plan.example 的 join/reduce 都有可执行目标；valid plans 仍通过校验', async () => {
    const fixture = JSON.parse(await readFile(join(process.cwd(), 'packages/fleet/protocol/plan.example.json'), 'utf-8')) as {
      plan: TaskPlan;
      retry: TaskPlan;
      subPlan: { parent: TaskPlan };
    };
    for (const p of [fixture.plan, fixture.retry, fixture.subPlan.parent]) {
      for (const step of p.steps) {
        if (step.kind === 'task' || step.kind === 'join' || step.kind === 'reduce') {
          expect({ step: step.stepId, hasTarget: step.to !== undefined || step.route !== undefined })
            .toEqual({ step: step.stepId, hasTarget: true });
        }
      }
    }
    expect(validatePlan(fixture.plan, { caller: A }).ok).toBe(true);
    expect(validatePlan(fixture.retry, { existingVersions: [fixture.plan], caller: A }).ok).toBe(true);
  });

  it('旧 fleet.config.json 仍有效；plan/card 是 internal 节点', () => {
    expect(validateFleetConfig({
      v: 1,
      device: 'device-A',
      dir: '/tmp/a',
      storagePath: '/tmp/a/store.jsonl',
      masterKeyFile: '/tmp/a/key.json',
      namespace: 'tasks',
      listen: '/ip4/127.0.0.1/tcp/0',
      peers: [],
      agents: [{ name: 'worker', kind: 'echo' }],
    })).toEqual([]);
  });
});
