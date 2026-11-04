// P3 三机 embedded loopback E2E：A 发布 plan，按三机能力卡路由到 B/C；
// 显式 to 不满足硬过滤时 blocked 且不改派；任务经记忆同步执行；task_status.plan 可解释。
import { describe, it, expect } from '@jest/globals';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mebular } from '@mebular/core';
import { InMemoryHub } from '../../src/p2p/transport/InMemoryTransport.js';
import {
  AGENT_NAMESPACE,
  EchoExecutor,
  ExecutionLog,
  FleetWorker,
  MebularTaskEventStore,
  MebularTaskPlanStore,
  NullTransport,
  PlanMaterializer,
  activeCapabilityCards,
  embeddedRoutingProvider,
  latestCapabilityCards,
  listCapabilityCards,
  planRootTaskId,
  planTaskId,
  publishFleetCards,
  reduceTaskEvents,
  submitTaskPlan,
  toolByName,
  type FleetAgentConfig,
  type FleetConfig,
  type TaskPlan,
} from '../../packages/fleet/src/index.js';
import { useHeavyTimeout } from '../helpers/timeouts.js';

useHeavyTimeout();

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const A = { device: 'device-A', agent: 'planner' };
const B = { device: 'device-B', agent: 'worker' };
const C = { device: 'device-C', agent: 'worker' };
const SENTINEL = { device: '__plan__', agent: '__plan__' };

function fleetConfig(dir: string, device: string, capabilities: string[], peers: string[] = []): FleetConfig {
  const agents: FleetAgentConfig[] = [{ name: 'worker', kind: 'echo', capabilities }];
  return {
    v: 1,
    device,
    dir,
    storagePath: join(dir, `${device}.jsonl`),
    masterKeyFile: join(dir, 'master-key.json'),
    namespace: 'tasks',
    listen: '/ip4/127.0.0.1/tcp/0',
    peers: peers.map((peer) => ({ device: peer })),
    agents,
  };
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 20_000, pollMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(pollMs);
  }
  return predicate();
}

const plan = (overrides: Partial<TaskPlan> = {}): TaskPlan => ({
  v: 1,
  kind: 'task_plan',
  planId: 'plan-route-e2e-001',
  version: 1,
  owner: A,
  goal: 'route across three devices',
  createdAt: 1,
  budget: { maxSteps: 5, maxAttemptsPerStep: 2 },
  policy: {
    allowedDevices: [B.device, C.device],
    allowedAgents: ['worker'],
    requireCapabilities: ['fleet.task'],
    maxParallel: 2,
    allowSubcontract: false,
  },
  steps: [
    { stepId: 'api', kind: 'task', intent: 'api work', dependsOn: [], route: { require: ['api'], prefer: ['ui'], strategy: 'deterministic' }, acceptance: { kind: 'non-empty-result' } },
    { stepId: 'ui', kind: 'task', intent: 'ui work', dependsOn: [], route: { require: ['ui'], prefer: [], strategy: 'deterministic' }, acceptance: { kind: 'non-empty-result' } },
    // C 没有 api 能力：显式 to 必须 blocked，且绝不改派给有 api 的 B。
    { stepId: 'explicit', kind: 'task', intent: 'explicit should not move', dependsOn: [], to: C, route: { require: ['api'], prefer: [], strategy: 'deterministic' }, acceptance: { kind: 'non-empty-result' } },
    { stepId: 'gate', kind: 'reduce', intent: 'gate', dependsOn: ['api', 'ui', 'explicit'], join: { mode: 'all' }, acceptance: { kind: 'non-empty-result' } },
    { stepId: 'mr', kind: 'mr', intent: 'mr', dependsOn: ['gate'], acceptance: { kind: 'mr-once' } },
  ],
  ...overrides,
});

describe('P3 三机 capability route E2E', () => {
  it('A 按卡片路由 B/C、显式 to 不改派、任务执行、why 可解释、tie-break 恒定', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-route-e2e-'));
    const master = await Mebular.generateUserMasterKey();
    const encryption = { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey };
    const hub = new InMemoryHub();
    const mk = (device: string) => new Mebular({
      storagePath: join(dir, `${device}.jsonl`),
      deviceId: device,
      encryption,
      network: { enabled: true, provider: hub },
      sync: {
        autoSync: true,
        pushOnWrite: true,
        pushOnWriteThrottleMs: 20,
        namespaces: ['tasks', AGENT_NAMESPACE],
        antiEntropy: { enabled: true, intervalMs: 3_600_000, jitterRatio: 0 },
      },
    });
    const a = mk(A.device);
    const b = mk(B.device);
    const c = mk(C.device);
    const syncAll = async () => {
      await Promise.all([a.sync.runAntiEntropyCycle(), b.sync.runAntiEntropyCycle(), c.sync.runAntiEntropyCycle()]);
    };
    try {
      await a.initialize();
      await b.initialize();
      await c.initialize();
      await b.node!.connectToPeer(a.node!.peerId);
      await c.node!.connectToPeer(a.node!.peerId);
      await c.node!.connectToPeer(b.node!.peerId);
      await a.node!.connectToPeer(b.node!.peerId);
      await a.node!.connectToPeer(c.node!.peerId);
      await b.node!.connectToPeer(c.node!.peerId);

      // 订阅任务域 + Agent 域（L1 授权的来源）；策略事件随 sync 传播。
      for (const mebular of [a, b, c]) {
        await mebular.subscribeNamespace('tasks');
        await mebular.subscribeNamespace(AGENT_NAMESPACE);
      }
      for (const [mebular, device, capabilities] of [
        [b, B.device, ['api', 'review']],
        [c, C.device, ['ui', 'review']],
      ] as const) {
        const published = await publishFleetCards({
          mebular,
          config: fleetConfig(dir, device, [...capabilities]),
          now: 100,
        });
        expect(published.errors).toEqual([]);
      }

      // A 必须同时看到 B/C 卡片与 tasks 订阅，才允许进入路由。
      const visible = await waitFor(async () => {
        await syncAll();
        const cards = activeCapabilityCards(latestCapabilityCards(await listCapabilityCards(a)));
        const bSubs = await a.getSubscriptions(B.device);
        const cSubs = await a.getSubscriptions(C.device);
        return cards.some((entry) => entry.device === B.device)
          && cards.some((entry) => entry.device === C.device)
          && bSubs.includes('tasks')
          && cSubs.includes('tasks');
      });
      expect(visible).toBe(true);

      const storeA = new MebularTaskEventStore(a, { namespace: 'tasks' });
      const plansA = new MebularTaskPlanStore(a, { namespace: 'tasks' });
      const p = plan();
      const submitted = await submitTaskPlan({ plan: p, intent: 'submit route plan', to: SENTINEL, caller: A, plans: plansA, store: storeA });
      expect(submitted).toMatchObject({ ok: true, planId: p.planId, version: 1, rootTaskId: planRootTaskId(p.planId, 1) });

      // 写入 A 的 fleet.config.json（task_status 的 route 解释复用同一配置）。
      await writeFile(join(dir, 'fleet.config.json'), JSON.stringify({
        ...fleetConfig(dir, A.device, ['planner'], [B.device, C.device]),
        agents: [{ name: 'planner', kind: 'echo' }],
      }), { mode: 0o600 });

      const provider = embeddedRoutingProvider({ mebular: a, config: fleetConfig(dir, A.device, ['planner'], [B.device, C.device]), store: storeA });
      const materializer = new PlanMaterializer({ device: A.device, agent: A.agent, plans: plansA, store: storeA, routing: provider });
      const first = await materializer.tick();
      const apiTaskId = planTaskId(p.planId, 1, 'api');
      const uiTaskId = planTaskId(p.planId, 1, 'ui');
      const explicitTaskId = planTaskId(p.planId, 1, 'explicit');
      expect(first.tasksCreated).toEqual([apiTaskId, uiTaskId]);
      expect(first.assignments.map((entry) => [entry.stepId, entry.chosen])).toEqual([
        ['api', B],
        ['ui', C],
      ]);
      expect(first.assignments[0]!.why.ranking[0]).toMatchObject({ device: B.device, agent: B.agent });
      expect(first.blocked).toEqual([expect.objectContaining({
        planId: p.planId,
        stepId: 'explicit',
        code: 'NO_TARGET',
        blockedBy: ['MISSING_CAPABILITY'],
      })]);
      expect(await storeA.byTask(explicitTaskId)).toHaveLength(0);
      expect(await storeA.byTask(planTaskId(p.planId, 1, 'gate'))).toHaveLength(0);
      expect(await storeA.byTask(planTaskId(p.planId, 1, 'mr'))).toHaveLength(0);

      // 同输入重复 tick 不重复建 task / 不改派。
      const second = await materializer.tick();
      expect(second.tasksCreated).toEqual([]);
      expect((await storeA.byTask(apiTaskId)).length).toBe(1);
      expect((await storeA.byTask(uiTaskId)).length).toBe(1);

      // B/C 各自同步到任务后执行；B 只拿到 api，C 只拿到 ui。
      const storeB = new MebularTaskEventStore(b, { namespace: 'tasks' });
      const storeC = new MebularTaskEventStore(c, { namespace: 'tasks' });
      const logB = await ExecutionLog.open(join(dir, 'b-exec.jsonl'));
      const logC = await ExecutionLog.open(join(dir, 'c-exec.jsonl'));
      const workerB = new FleetWorker({ device: B.device, agent: B.agent, store: storeB, transport: new NullTransport(), executor: new EchoExecutor(), log: logB });
      const workerC = new FleetWorker({ device: C.device, agent: C.agent, store: storeC, transport: new NullTransport(), executor: new EchoExecutor(), log: logC });

      const bHasApi = await waitFor(async () => {
        await syncAll();
        return (await storeB.byTask(apiTaskId)).length > 0;
      });
      expect(bHasApi).toBe(true);
      const cHasUi = await waitFor(async () => {
        await syncAll();
        return (await storeC.byTask(uiTaskId)).length > 0;
      });
      expect(cHasUi).toBe(true);

      await workerB.pollOnce();
      await workerC.pollOnce();
      expect(reduceTaskEvents(await storeB.byTask(apiTaskId))?.status).toBe('done');
      expect(reduceTaskEvents(await storeC.byTask(uiTaskId))?.status).toBe('done');
      // 任务事件全 namespace 同步，但 worker 只执行 targetsMe 的任务。
      expect(reduceTaskEvents(await storeB.byTask(uiTaskId))?.status).not.toBe('done');
      expect(reduceTaskEvents(await storeC.byTask(apiTaskId))?.status).not.toBe('done');
      expect(logB.size()).toBe(1);
      expect(logC.size()).toBe(1);

      const backToA = await waitFor(async () => {
        await syncAll();
        return reduceTaskEvents(await storeA.byTask(apiTaskId))?.status === 'done'
          && reduceTaskEvents(await storeA.byTask(uiTaskId))?.status === 'done';
      });
      expect(backToA).toBe(true);
      expect(reduceTaskEvents(await storeA.byTask(planRootTaskId(p.planId, 1)))?.status).toBe('running');

      // task_status.plan：已完成 step + blocked 的显式 step 都有可解释信息。
      const status = await toolByName('task_status')!.handler(
        { taskId: planRootTaskId(p.planId, 1) },
        { dir, agent: A.agent, mebular: a },
      ) as {
        ok: boolean;
        state: { status: string };
        plan: {
          status: string;
          steps: Array<{ stepId: string; status: string; blockedBy?: string[]; why?: { code: string; ranking: Array<{ device: string; agent: string }> } }>;
        };
      };
      expect(status.ok).toBe(true);
      expect(status.plan.steps.find((step) => step.stepId === 'api')).toMatchObject({ status: 'done' });
      expect(status.plan.steps.find((step) => step.stepId === 'ui')).toMatchObject({ status: 'done' });
      // P6 additive：已物化步骤也返回确定性 route 审计（why），但不含 intent/原文。
      expect(status.plan.steps.find((step) => step.stepId === 'api')?.why).toMatchObject({
        code: 'ASSIGNED',
        policy: 'inherited',
      });
      const explicit = status.plan.steps.find((step) => step.stepId === 'explicit')!;
      expect(explicit).toMatchObject({
        status: 'blocked',
        blockedBy: ['MISSING_CAPABILITY'],
        why: { code: 'NO_TARGET' },
      });
      expect(explicit.why?.ranking).toEqual([]);
      expect(status.plan.steps.find((step) => step.stepId === 'mr')?.status).toBe('pending');
      expect(JSON.stringify(status)).not.toMatch(/api work|explicit should|prompt|command|token|secret/i);

      // 同 plan/step + 同候选/卡片 → tie-break 恒定（另建 materializer 不改变 chosen）。
      const rerouted = await new PlanMaterializer({
        device: A.device,
        agent: A.agent,
        plans: plansA,
        store: storeA,
        routing: provider,
      }).tick();
      expect(rerouted.tasksCreated).toEqual([]);
      expect(rerouted.assignments).toEqual([]);

      await workerB.close();
      await workerC.close();
      await storeA.close();
      await storeB.close();
      await storeC.close();
    } finally {
      await a.shutdown().catch(() => undefined);
      await b.shutdown().catch(() => undefined);
      await c.shutdown().catch(() => undefined);
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});
