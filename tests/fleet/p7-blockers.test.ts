// P7 review blockers：B1-R 默认 MCP plan owner/MR 执行者；B2 内部端点契约只做回归锚点。
//
// 边界：本文件是 handler 级 E2E（直接调用 TASK_TOOLS handler + 真实 Mebular/store/materializer），
// 不经过真实 MCP stdio/HTTP transport；transport 级默认 plan 未在本轮新增，作为 P7 证据限制记录。
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  PlanValidationError,
  appendValidatedTaskPlanNode,
  loadToolConfig,
  offlineMebularOptions,
  onboardDevice,
  planRootTaskId,
  readMasterKeyFile,
  reduceTaskEvents,
  submitTaskPlan,
  toolByName,
  type AgentCapabilityCard,
  type PlanRoutingProvider,
  type TaskPlan,
  type ToolContext,
} from '../../packages/fleet/src/index.js';

const A = { device: 'device-A', agent: 'worker' };
const SENTINEL = { device: '__plan__', agent: '__plan__' };

/** 真实可执行 Agent：plan owner/MR 不能是 echo/board。 */
const realAgent = (name: string = A.agent) => ({ name, kind: 'command' as const, command: process.execPath });

function capability(device: string, agent: string): AgentCapabilityCard {
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
    cards: async () => [capability(A.device, A.agent)],
    authorized: () => ({ devices: [A.device] }),
    online: () => true,
    observations: () => [],
    namespace: 'tasks',
  };
}

function localPlan(planId: string): TaskPlan {
  return {
    v: 1,
    kind: 'task_plan',
    planId,
    version: 1,
    owner: { device: A.device, agent: 'board' },
    goal: 'B1 default owner normalization',
    createdAt: 1,
    budget: { maxSteps: 4, maxAttemptsPerStep: 2 },
    policy: {
      allowedDevices: [A.device],
      allowedAgents: [A.agent],
      requireCapabilities: ['fleet.task'],
      maxParallel: 1,
      allowSubcontract: false,
    },
    steps: [
      { stepId: 'work', kind: 'task', intent: 'work', dependsOn: [], to: A, acceptance: { kind: 'non-empty-result' } },
      { stepId: 'gate', kind: 'join', intent: 'gate', dependsOn: ['work'], to: A, join: { mode: 'all' }, acceptance: { kind: 'non-empty-result' } },
      { stepId: 'mr', kind: 'mr', intent: 'mr', dependsOn: ['gate'], acceptance: { kind: 'mr-once' } },
    ],
  };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fleet-p7-blockers-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function openLive(): Promise<{ live: Mebular; store: MebularTaskEventStore; plans: MebularTaskPlanStore }> {
  const config = await loadToolConfig(dir);
  const live = new Mebular(offlineMebularOptions(config, await readMasterKeyFile(config.masterKeyFile)) as never);
  await live.initialize();
  return {
    live,
    store: new MebularTaskEventStore(live, { namespace: 'tasks' }),
    plans: new MebularTaskPlanStore(live, { namespace: 'tasks' }),
  };
}

describe('B1 默认 MCP plan owner/MR 执行者', () => {
  it('不显式传 agent：owner=board 归一化为第一个配置 Agent，MR 由其执行并 root done', async () => {
    await onboardDevice({ dir, device: A.device, agents: [realAgent()] });
    const { live, store, plans } = await openLive();
    const log = await ExecutionLog.open(join(dir, 'worker.exec.jsonl'));
    try {
      // 旧普通 task 默认 agent 仍是 board。
      const legacy = await toolByName('task_submit')!.handler(
        { intent: 'legacy task', to: { device: A.device, agent: A.agent } },
        { dir, mebular: live } as ToolContext,
      ) as { ok: boolean; from: { agent: string } };
      expect(legacy).toMatchObject({ ok: true, from: { agent: 'board' } });

      const submitted = await toolByName('task_submit')!.handler(
        { intent: 'B1 plan', to: SENTINEL, plan: localPlan('plan-p7-b1-default-001') },
        { dir, mebular: live } as ToolContext,
      ) as { ok: boolean; planId: string; version: number; rootTaskId: string };
      expect(submitted).toMatchObject({
        ok: true,
        planId: 'plan-p7-b1-default-001',
        version: 1,
        rootTaskId: planRootTaskId('plan-p7-b1-default-001', 1),
      });
      const stored = await plans.get('plan-p7-b1-default-001', 1);
      expect(stored?.owner).toEqual({ device: A.device, agent: A.agent });
      const root = reduceTaskEvents(await store.byTask(planRootTaskId('plan-p7-b1-default-001', 1)));
      expect(root?.from).toEqual({ device: A.device, agent: A.agent });

      const materializer = new PlanMaterializer({
        device: A.device,
        agent: A.agent,
        plans,
        store,
        routing: routingFor(),
      });
      const worker = new FleetWorker({
        device: A.device,
        agent: A.agent,
        store,
        transport: new NullTransport(),
        executor: new EchoExecutor(),
        log,
      });
      try {
        for (let i = 0; i < 8; i++) {
          await materializer.tick();
          await worker.pollOnce();
        }
        expect(reduceTaskEvents(await store.byTask(planRootTaskId('plan-p7-b1-default-001', 1)))?.status).toBe('done');
        const mrCreated = (await store.byTask('plan-p7-b1-default-001#1#mr')).filter((event) => event.type === 'created');
        expect(mrCreated).toHaveLength(1);
        expect(mrCreated[0]?.to).toEqual({ device: A.device, agent: A.agent });
        expect(mrCreated[0]?.actor).toEqual({ device: A.device, agent: A.agent });
      } finally {
        await worker.close();
      }
    } finally {
      await live.shutdown().catch(() => undefined);
    }
  });

  it('无可用 Agent：planAgent=board 且 config 无 board → PLAN_POLICY/PLAN_OWNER_UNEXECUTABLE，不写 plan/root', async () => {
    await onboardDevice({ dir, device: A.device, agents: [] });
    const { live, store, plans } = await openLive();
    try {
      const result = await toolByName('task_submit')!.handler(
        { intent: 'B1 no agent', to: SENTINEL, plan: localPlan('plan-p7-b1-none-001') },
        { dir, mebular: live } as ToolContext,
      ) as { ok: boolean; error: string; reason: string; errors: string[] };
      expect(result).toMatchObject({
        ok: false,
        error: 'PLAN_POLICY',
        reason: 'PLAN_OWNER_UNEXECUTABLE',
      });
      expect(result.errors.join(' ')).toContain('PLAN_OWNER_UNEXECUTABLE');
      expect(await plans.list()).toEqual([]);
      expect(await store.byTask(planRootTaskId('plan-p7-b1-none-001', 1))).toHaveLength(0);
    } finally {
      await live.shutdown().catch(() => undefined);
    }
  });

  it('defaultAgent 指向 ghost → 配置拒绝，plan/root 不写', async () => {
    await onboardDevice({ dir, device: A.device, agents: [realAgent()] });
    const { live, store, plans } = await openLive();
    try {
      const configPath = join(dir, 'fleet.config.json');
      const config = JSON.parse(await readFile(configPath, 'utf-8')) as Record<string, unknown>;
      config.defaultAgent = 'ghost-agent';
      await writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });

      await expect(toolByName('task_submit')!.handler(
        { intent: 'B1-R default ghost', to: SENTINEL, plan: localPlan('plan-p7-b1r-default-ghost-001') },
        { dir, mebular: live } as ToolContext,
      )).rejects.toThrow(/defaultAgent/);
      expect(await plans.list()).toEqual([]);
      expect(await store.byTask(planRootTaskId('plan-p7-b1r-default-ghost-001', 1))).toHaveLength(0);
    } finally {
      await live.shutdown().catch(() => undefined);
    }
  });

  it('ctx.agent 指向 ghost → PLAN_OWNER_UNEXECUTABLE，plan/root 不写', async () => {
    await onboardDevice({ dir, device: A.device, agents: [realAgent()] });
    const { live, store, plans } = await openLive();
    try {
      const result = await toolByName('task_submit')!.handler(
        { intent: 'B1-R ctx ghost', to: SENTINEL, plan: localPlan('plan-p7-b1r-ctx-ghost-001') },
        { dir, mebular: live, agent: 'ghost-agent' } as ToolContext,
      ) as { ok: boolean; error: string; reason: string; errors: string[] };
      expect(result).toMatchObject({ ok: false, error: 'PLAN_POLICY', reason: 'PLAN_OWNER_UNEXECUTABLE' });
      expect(result.errors.join(' ')).toContain('ghost-agent');
      expect(await plans.list()).toEqual([]);
      expect(await store.byTask(planRootTaskId('plan-p7-b1r-ctx-ghost-001', 1))).toHaveLength(0);
    } finally {
      await live.shutdown().catch(() => undefined);
    }
  });

  it('非 board ghost owner + ghost planAgent → 拒绝，不写 plan/root', async () => {
    await onboardDevice({ dir, device: A.device, agents: [realAgent()] });
    const { live, store, plans } = await openLive();
    try {
      const plan = localPlan('plan-p7-b1r-ghost-owner-001');
      plan.owner = { device: A.device, agent: 'ghost-agent' };
      const result = await toolByName('task_submit')!.handler(
        { intent: 'B1-R ghost owner', to: SENTINEL, plan },
        { dir, mebular: live, agent: 'ghost-agent' } as ToolContext,
      ) as { ok: boolean; error: string; reason: string };
      expect(result).toMatchObject({ ok: false, error: 'PLAN_POLICY', reason: 'PLAN_OWNER_UNEXECUTABLE' });
      expect(await plans.list()).toEqual([]);
      expect(await store.byTask(planRootTaskId('plan-p7-b1r-ghost-owner-001', 1))).toHaveLength(0);
    } finally {
      await live.shutdown().catch(() => undefined);
    }
  });

  it('非 board 显式 owner 仍必须等于 planAgent', async () => {
    await onboardDevice({ dir, device: A.device, agents: [realAgent()] });
    const { live } = await openLive();
    try {
      const plan = localPlan('plan-p7-b1-explicit-001');
      plan.owner = { device: A.device, agent: 'other-worker' };
      const result = await toolByName('task_submit')!.handler(
        { intent: 'B1 explicit owner', to: SENTINEL, plan },
        { dir, mebular: live } as ToolContext,
      ) as { ok: boolean; error: string };
      expect(result).toMatchObject({ ok: false, error: 'PLAN_POLICY' });
    } finally {
      await live.shutdown().catch(() => undefined);
    }
  });
});

describe('WS4b plan owner/MR 必须是真实可执行 Agent', () => {
  it('config 只有 board:echo → PLAN_OWNER_UNEXECUTABLE，不写 plan/root；普通 task 仍可用 board', async () => {
    await onboardDevice({ dir, device: A.device, agents: [{ name: 'board', kind: 'echo' }] });
    const { live, store, plans } = await openLive();
    try {
      // 普通 task 的 to.agent=board 占位语义不受影响。
      const legacy = await toolByName('task_submit')!.handler(
        { intent: 'legacy board task', to: { device: A.device, agent: 'board' } },
        { dir, mebular: live } as ToolContext,
      ) as { ok: boolean; from: { agent: string } };
      expect(legacy).toMatchObject({ ok: true, from: { agent: 'board' } });

      const result = await toolByName('task_submit')!.handler(
        { intent: 'board plan', to: SENTINEL, plan: localPlan('plan-ws4b-board-001') },
        { dir, mebular: live } as ToolContext,
      ) as { ok: boolean; error: string; reason: string; errors: string[] };
      expect(result).toMatchObject({
        ok: false,
        error: 'PLAN_POLICY',
        reason: 'PLAN_OWNER_UNEXECUTABLE',
      });
      expect(result.errors.join(' ')).toMatch(/echo\/board.*demo\/看板/);
      expect(await plans.list()).toEqual([]);
      expect(await store.byTask(planRootTaskId('plan-ws4b-board-001', 1))).toHaveLength(0);
    } finally {
      await live.shutdown().catch(() => undefined);
    }
  });

  it('echo kind 的非 board 名字同样是 PLAN_OWNER_UNEXECUTABLE', async () => {
    await onboardDevice({ dir, device: A.device, agents: [{ name: A.agent, kind: 'echo' }] });
    const { live, store, plans } = await openLive();
    try {
      const plan = localPlan('plan-ws4b-echo-kind-001');
      plan.owner = A;
      const result = await toolByName('task_submit')!.handler(
        { intent: 'echo kind plan', to: SENTINEL, plan },
        { dir, mebular: live, agent: A.agent } as ToolContext,
      ) as { ok: boolean; error: string; reason: string; errors: string[] };
      expect(result).toMatchObject({
        ok: false,
        error: 'PLAN_POLICY',
        reason: 'PLAN_OWNER_UNEXECUTABLE',
      });
      expect(result.errors.join(' ')).toContain(`planAgent="${A.agent}"`);
      expect(await plans.list()).toEqual([]);
      expect(await store.byTask(planRootTaskId('plan-ws4b-echo-kind-001', 1))).toHaveLength(0);
    } finally {
      await live.shutdown().catch(() => undefined);
    }
  });

  it('board 即使配置为 command 也仍是保留看板名 → 拒绝', async () => {
    await onboardDevice({
      dir,
      device: A.device,
      agents: [{ name: 'board', kind: 'command', command: process.execPath }],
    });
    const { live, plans } = await openLive();
    try {
      const result = await toolByName('task_submit')!.handler(
        { intent: 'board command plan', to: SENTINEL, plan: localPlan('plan-ws4b-board-command-001') },
        { dir, mebular: live } as ToolContext,
      ) as { ok: boolean; error: string; reason: string };
      expect(result).toMatchObject({
        ok: false,
        error: 'PLAN_POLICY',
        reason: 'PLAN_OWNER_UNEXECUTABLE',
      });
      expect(await plans.list()).toEqual([]);
    } finally {
      await live.shutdown().catch(() => undefined);
    }
  });

  it('daemon /app/plans 写入路径同样拒绝 board owner，并透传 reason', async () => {
    await onboardDevice({ dir, device: A.device, agents: [realAgent()] });
    const { live, plans } = await openLive();
    try {
      const plan = localPlan('plan-ws4b-daemon-board-001');
      plan.owner = { device: A.device, agent: 'board' };
      await expect(appendValidatedTaskPlanNode(live, plan, { namespace: 'tasks' }) as Promise<unknown>)
        .rejects.toMatchObject({
          name: 'PlanValidationError',
          code: 'PLAN_POLICY',
          reason: 'PLAN_OWNER_UNEXECUTABLE',
        });
      await expect(appendValidatedTaskPlanNode(live, { ...plan, owner: { device: A.device, agent: 'echo' } }, { namespace: 'tasks' }) as Promise<unknown>)
        .rejects.toBeInstanceOf(PlanValidationError);
      expect(await plans.list()).toEqual([]);

      // 已记录缺口：daemon home 只有 board:echo 占位配置，没有 fleet.config.json 的 agent kind
      // 信息；因此像 `{name:"worker",kind:"echo"}` 这类“非保留名的 echo kind”无法在
      // /app/plans 直写路径识别。正常 fleet 客户端在 MCP 提交阶段已被 surface guard 拦截。
      const echoAlias = { ...plan, planId: 'plan-ws4b-daemon-echo-alias-001', owner: { device: A.device, agent: 'worker' } };
      await expect(appendValidatedTaskPlanNode(live, echoAlias, { namespace: 'tasks' }) as Promise<unknown>).resolves.toMatchObject({ stored: true });
    } finally {
      await live.shutdown().catch(() => undefined);
    }
  });
});

describe('B1 direct submit（非 MCP 路径）保持 caller 显式', () => {
  it('submitTaskPlan 仍要求 caller 与 owner 一致；caller=planAgent 可用', async () => {
    await onboardDevice({ dir, device: A.device, agents: [realAgent()] });
    const { live, store, plans } = await openLive();
    try {
      const plan = localPlan('plan-p7-b1-direct-001');
      plan.owner = { device: A.device, agent: A.agent };
      await expect(submitTaskPlan({
        plan,
        intent: 'direct',
        to: SENTINEL,
        caller: { device: A.device, agent: 'other' },
        plans,
        store,
      })).resolves.toMatchObject({ ok: false, error: 'PLAN_POLICY' });
      await expect(submitTaskPlan({
        plan,
        intent: 'direct',
        to: SENTINEL,
        caller: A,
        plans,
        store,
      })).resolves.toMatchObject({ ok: true });
    } finally {
      await live.shutdown().catch(() => undefined);
    }
  });
});
