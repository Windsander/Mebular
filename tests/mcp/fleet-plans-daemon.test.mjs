// P2 daemon /app/plans：internal plan 节点写入/读取、幂等/冲突、embedded 一致性、
// 记忆列表/域计数/SSE 不暴露 plan；/app/nodes 仍拒绝 task_plan。
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mebular, MemoryService } from '@mebular/core';
import { startHttpServer, hashToken } from '../../packages/mcp/src/serve.mjs';
import { fleetEventFromEvent } from '../../packages/mcp/src/fleet-events.mjs';

const fleet = await import('../../packages/fleet/src/index.ts');
const execFileAsync = promisify(execFile);

let home;
let app;
let service;
let server;
let base;

async function request(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, body: json };
}

function plan(overrides = {}) {
  return {
    v: 1,
    kind: 'task_plan',
    planId: 'plan-daemon-001',
    version: 1,
    owner: { device: 'device-A', agent: 'planner' },
    goal: 'daemon plan',
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
      { stepId: 'work', kind: 'task', intent: 'work', dependsOn: [], to: { device: 'device-B', agent: 'worker' }, acceptance: { kind: 'non-empty-result' } },
      { stepId: 'gate', kind: 'reduce', intent: 'gate', dependsOn: ['work'], join: { mode: 'all' }, acceptance: { kind: 'non-empty-result' } },
      { stepId: 'mr', kind: 'mr', intent: 'mr', dependsOn: ['gate'], acceptance: { kind: 'mr-once' } },
    ],
    ...overrides,
  };
}

function parentPlan(overrides = {}) {
  return plan({
    planId: 'plan-daemon-parent-001',
    goal: 'daemon parent',
    policy: {
      allowedDevices: ['device-A', 'device-B'],
      allowedAgents: ['planner', 'worker'],
      requireCapabilities: ['fleet.task'],
      maxParallel: 2,
      allowSubcontract: true,
    },
    steps: [
      { stepId: 'work', kind: 'task', intent: 'work', dependsOn: [], to: { device: 'device-A', agent: 'planner' }, acceptance: { kind: 'non-empty-result' } },
      { stepId: 'gate', kind: 'reduce', intent: 'gate', dependsOn: ['work'], join: { mode: 'all' }, acceptance: { kind: 'non-empty-result' } },
      { stepId: 'mr', kind: 'mr', intent: 'mr', dependsOn: ['gate'], acceptance: { kind: 'mr-once' } },
    ],
    ...overrides,
  });
}

function childPlan(parentId, overrides = {}) {
  return {
    v: 1,
    kind: 'task_plan',
    planId: 'plan-daemon-child-001',
    version: 1,
    parent: { planId: parentId, version: 1, stepId: 'work' },
    owner: { device: 'device-A', agent: 'planner' },
    goal: 'daemon child',
    createdAt: 300,
    budget: { maxSteps: 2, maxAttemptsPerStep: 1 },
    policy: {
      allowedDevices: ['device-A'],
      allowedAgents: ['planner'],
      requireCapabilities: ['fleet.task'],
      maxParallel: 1,
      allowSubcontract: false,
    },
    steps: [
      { stepId: 'child-work', kind: 'task', intent: 'child-work', dependsOn: [], to: { device: 'device-A', agent: 'planner' }, acceptance: { kind: 'non-empty-result' } },
    ],
    ...overrides,
  };
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'fleet-daemon-plans-'));
  const master = await Mebular.generateUserMasterKey();
  app = new Mebular({
    storagePath: join(home, 'store.jsonl'),
    deviceId: 'device-A',
    encryption: { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey },
    network: { enabled: false },
    sync: { autoSync: false },
  });
  await app.initialize();
  service = new MemoryService(app);
  server = await startHttpServer({
    home,
    app,
    service,
    config: {
      deviceId: 'device-A',
      sync: { namespaces: ['tasks', 'agents'] },
      mcp: { http: { host: '127.0.0.1', port: 0, auth: 'none' } },
    },
    buildServer: () => ({ connect: async () => undefined, close: async () => undefined }),
    host: '127.0.0.1',
    port: 0,
    auth: 'none',
    deviceId: 'device-A',
    namespace: 'tasks',
    writesEnabled: true,
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server?.close().catch(() => undefined);
  await app?.shutdown().catch(() => undefined);
  if (home) await rm(home, { recursive: true, force: true });
});

describe('P2 daemon /app/plans', () => {
  it('POST 写 internal task_plan 节点；GET 读回；embedded 一致', async () => {
    const p = plan();
    const created = await request('/app/plans', { method: 'POST', body: { plan: p, namespace: 'tasks' } });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ ok: true, replayed: false, plan: { planId: p.planId, version: 1 } });
    expect(typeof created.body.nodeId).toBe('string');

    const listed = await request('/app/plans?namespace=tasks');
    expect(listed.status).toBe(200);
    expect(listed.body.ok).toBe(true);
    expect(listed.body.count).toBe(1);
    expect(listed.body.plans[0]).toMatchObject({ planId: p.planId, version: 1 });

    const node = (await app.graph.listNodes({ type: 'task_plan' }))[0];
    expect(node.metadata).toMatchObject({ internal: true, internalObject: { kind: 'task_plan' } });
    expect(node.namespace).toBe('tasks');

    const embedded = await new fleet.MebularTaskPlanStore(app).list();
    const daemon = await new fleet.DaemonTaskPlanStore({ endpoint: base, namespace: 'tasks' }).list();
    expect(embedded).toEqual(daemon);

    // internal 可见性：普通记忆列表 / 域普通计数 / SSE 都不返回 plan。
    const records = await service.listRecords({ namespace: 'tasks' });
    expect(records.total).toBe(0);
    const stats = (await service.namespaceStats()).find((entry) => entry.domain === 'tasks');
    expect(stats).toMatchObject({ count: 0, internalObjects: 1 });
    expect(stats.internalKinds).toMatchObject({ task_plan: 1 });
    expect(fleetEventFromEvent({
      type: 'node_created',
      namespace: 'tasks',
      data: { node: { type: 'task_plan', namespace: 'tasks', content: p } },
    })).toBeNull();

    // /app/nodes 不重新打开 plan 白名单。
    const forged = await request('/app/nodes', {
      method: 'POST',
      body: {
        type: 'task_plan',
        namespace: 'tasks',
        content: plan({ planId: 'plan-forged' }),
        metadata: { internal: true, internalObject: { kind: 'task_plan' } },
      },
    });
    expect(forged.status).toBe(403);
    expect(forged.body.error).toBe('internal_object_write_forbidden');
  });

  it('WS4b：/app/plans 拒绝 board/echo owner，并透传 PLAN_OWNER_UNEXECUTABLE', async () => {
    const before = (await app.graph.listNodes({ type: 'task_plan' })).length;
    for (const agent of ['board', 'echo']) {
      const reply = await request('/app/plans', {
        method: 'POST',
        body: {
          plan: plan({ planId: `plan-daemon-unexecutable-${agent}`, owner: { device: 'device-A', agent } }),
          namespace: 'tasks',
        },
      });
      expect(reply.status).toBe(422);
      expect(reply.body).toMatchObject({
        ok: false,
        error: 'PLAN_POLICY',
        reason: 'PLAN_OWNER_UNEXECUTABLE',
      });
      expect(reply.body.errors.join(' ')).toContain('PLAN_OWNER_UNEXECUTABLE');
    }
    expect((await app.graph.listNodes({ type: 'task_plan' })).length).toBe(before);

    // 记录缺口：daemon home 没有 fleet.config.json 的 agent kind 信息，无法识别
    // “非保留名的 echo kind”（如 {name:"worker",kind:"echo"}）；正常 fleet 客户端
    // 在 MCP 提交阶段已被 surface guard 拒绝，因此这里只保证保留名 fail-closed。
  });

  it('DaemonTaskPlanStore：同版本同内容幂等；内容不同 PLAN_CONFLICT；版本单调', async () => {
    const store = new fleet.DaemonTaskPlanStore({ endpoint: base, namespace: 'tasks' });
    const replay = await store.append(plan({ createdAt: 999 }));
    expect(replay.replayed).toBe(true);
    expect(replay.stored).toBe(false);
    expect((await app.graph.listNodes({ type: 'task_plan' })).length).toBe(1);

    let conflict = null;
    try {
      await store.append(plan({ goal: 'different' }));
    } catch (error) {
      conflict = error;
    }
    expect(conflict?.code).toBe('PLAN_CONFLICT');
    expect((await app.graph.listNodes({ type: 'task_plan' })).length).toBe(1);

    const v2 = plan({ version: 2, supersedesVersion: 1, createdAt: 200, reason: 'next' });
    const appended = await store.append(v2);
    expect(appended.stored).toBe(true);
    expect(appended.plan.version).toBe(2);
    expect((await store.list()).map((entry) => entry.version).sort()).toEqual([1, 2]);

    const httpConflict = await request('/app/plans', {
      method: 'POST',
      body: { plan: plan({ goal: 'http conflict' }), namespace: 'tasks' },
    });
    expect(httpConflict.status).toBe(409);
    expect(httpConflict.body).toMatchObject({ ok: false, error: 'PLAN_CONFLICT' });

    // 并发同版本：串行化后一个 stored、一个 replay，节点只写一次。
    const concurrent = plan({ planId: 'plan-daemon-concurrent-001', createdAt: 500 });
    const results = await Promise.all([
      store.append(concurrent),
      store.append(concurrent),
    ]);
    expect(results.filter((entry) => entry.replayed)).toHaveLength(1);
    const nodes = (await app.graph.listNodes({ type: 'task_plan' }))
      .filter((node) => node.content?.planId === concurrent.planId);
    expect(nodes).toHaveLength(1);
  });

  it('B2/B5：作者、createdBy、namespace、完整 DAG/MR/policy 校验', async () => {
    const store = new fleet.DaemonTaskPlanStore({ endpoint: base, namespace: 'tasks' });

    // createdBy：GET + daemon store 保留作者。
    const listed = await request('/app/plans?namespace=tasks&planId=plan-daemon-001');
    expect(listed.status).toBe(200);
    expect(listed.body.nodes[0].createdBy).toBe('device-A');
    expect((await store.listStored()).find((entry) => entry.plan.planId === 'plan-daemon-001'))
      .toMatchObject({ createdBy: 'device-A' });

    // B2：写入设备 ≠ owner.device。
    const wrongOwner = plan({ planId: 'plan-daemon-author-mismatch-001', owner: { device: 'device-B', agent: 'worker' } });
    const byOwner = await request('/app/plans', { method: 'POST', body: { plan: wrongOwner, namespace: 'tasks' } });
    expect(byOwner.status).toBe(422);
    expect(byOwner.body).toMatchObject({ ok: false, error: 'PLAN_POLICY' });
    await expect(store.append(wrongOwner)).rejects.toMatchObject({ code: 'PLAN_POLICY' });
    expect((await app.graph.listNodes({ type: 'task_plan' }))
      .some((node) => node.content?.planId === wrongOwner.planId)).toBe(false);

    // B5：namespace 只能是任务板 namespace。
    const badNs = await request('/app/plans', {
      method: 'POST',
      body: { plan: plan({ planId: 'plan-daemon-bad-namespace-001' }), namespace: 'other' },
    });
    expect(badNs.status).toBe(400);
    expect(badNs.body.error).toBe('namespace_invalid');
    const badNsGet = await request('/app/plans?namespace=other');
    expect(badNsGet.status).toBe(400);
    expect(badNsGet.body.error).toBe('namespace_invalid');

    // B5：非法 DAG / MR / sentinel 都必须走完整 validatePlan。
    const cycle = plan({
      planId: 'plan-daemon-bad-cycle-001',
      steps: [
        { stepId: 'a', kind: 'task', intent: 'a', dependsOn: ['b'], acceptance: { kind: 'non-empty-result' } },
        { stepId: 'b', kind: 'task', intent: 'b', dependsOn: ['a'], acceptance: { kind: 'non-empty-result' } },
        { stepId: 'gate', kind: 'reduce', intent: 'g', dependsOn: ['a'], join: { mode: 'all' }, acceptance: { kind: 'non-empty-result' } },
        { stepId: 'mr', kind: 'mr', intent: 'm', dependsOn: ['gate'], acceptance: { kind: 'mr-once' } },
      ],
    });
    const cycleReply = await request('/app/plans', { method: 'POST', body: { plan: cycle, namespace: 'tasks' } });
    expect(cycleReply.status).toBe(422);
    expect(cycleReply.body.error).toBe('PLAN_CYCLE');

    const noMr = plan({
      planId: 'plan-daemon-bad-mr-001',
      steps: [
        { stepId: 'work', kind: 'task', intent: 'w', dependsOn: [], to: { device: 'device-B', agent: 'worker' }, acceptance: { kind: 'non-empty-result' } },
      ],
    });
    const noMrReply = await request('/app/plans', { method: 'POST', body: { plan: noMr, namespace: 'tasks' } });
    expect(noMrReply.status).toBe(422);
    expect(noMrReply.body.error).toBe('PLAN_MR');

    const sentinel = plan({
      planId: 'plan-daemon-bad-sentinel-001',
      steps: [
        { stepId: 'work', kind: 'task', intent: 'w', dependsOn: [], to: { device: '__plan__', agent: '__plan__' }, acceptance: { kind: 'non-empty-result' } },
        { stepId: 'gate', kind: 'reduce', intent: 'g', dependsOn: ['work'], join: { mode: 'all' }, acceptance: { kind: 'non-empty-result' } },
        { stepId: 'mr', kind: 'mr', intent: 'm', dependsOn: ['gate'], acceptance: { kind: 'mr-once' } },
      ],
    });
    const sentinelReply = await request('/app/plans', { method: 'POST', body: { plan: sentinel, namespace: 'tasks' } });
    expect(sentinelReply.status).toBe(422);
    expect(sentinelReply.body.error).toBe('PLAN_SCHEMA');

    // B5/B6：子 plan 父 task 缺失 → PLAN_STATE_INVALID；TaskBudget 不足 → PLAN_BUDGET；policy 放宽 → PLAN_POLICY。
    const parent = parentPlan();
    expect((await request('/app/plans', { method: 'POST', body: { plan: parent, namespace: 'tasks' } })).status).toBe(200);
    const missingTaskChild = childPlan(parent.planId, { planId: 'plan-daemon-child-missing-task-001' });
    const missingTaskReply = await request('/app/plans', { method: 'POST', body: { plan: missingTaskChild, namespace: 'tasks' } });
    expect(missingTaskReply.status).toBe(409);
    expect(missingTaskReply.body.error).toBe('PLAN_STATE_INVALID');

    const tasks = new fleet.DaemonTaskEventStore({ endpoint: base, namespace: 'tasks' });
    const parentStepTaskId = `${parent.planId}#1#work`;
    expect(await tasks.append({
      v: 1,
      eventId: `${parentStepTaskId}#created`,
      taskId: parentStepTaskId,
      type: 'created',
      actor: { device: 'device-A', agent: 'planner' },
      at: 1,
      toStatus: 'queued',
      trace: { chain: [] },
      to: { device: 'device-A', agent: 'planner' },
      intent: 'parent-work',
      budget: { maxDepth: 3, maxChildren: 2, maxTasks: 3 },
    })).toBe(true);

    const rootlessChild = childPlan(parent.planId, {
      planId: 'plan-daemon-child-rootless-001',
      budget: { maxSteps: 1, maxAttemptsPerStep: 1 },
    });
    expect((await request('/app/plans', { method: 'POST', body: { plan: rootlessChild, namespace: 'tasks' } })).status).toBe(200);
    expect((await new fleet.DaemonTaskEventStore({ endpoint: base, namespace: 'tasks' })
      .byTask(`${rootlessChild.planId}#1#root`))).toHaveLength(0);

    const budgetChild = childPlan(parent.planId, { planId: 'plan-daemon-child-budget-001' });
    const budgetReply = await request('/app/plans', { method: 'POST', body: { plan: budgetChild, namespace: 'tasks' } });
    expect(budgetReply.status).toBe(422);
    expect(budgetReply.body.error).toBe('PLAN_BUDGET');

    const policyChild = childPlan(parent.planId, {
      planId: 'plan-daemon-child-policy-001',
      policy: { ...childPlan(parent.planId).policy, allowedDevices: ['device-C'] },
    });
    const policyReply = await request('/app/plans', { method: 'POST', body: { plan: policyChild, namespace: 'tasks' } });
    expect(policyReply.status).toBe(422);
    expect(policyReply.body.error).toBe('PLAN_POLICY');

    const okChild = childPlan(parent.planId, {
      planId: 'plan-daemon-child-ok-001',
      budget: { maxSteps: 1, maxAttemptsPerStep: 1 },
    });
    const okReply = await request('/app/plans', { method: 'POST', body: { plan: okChild, namespace: 'tasks' } });
    expect(okReply.status).toBe(200);
    expect(okReply.body.plan.policy).toMatchObject({ allowedDevices: ['device-A'], maxParallel: 1 });

    // 已接受 child：root task 已存在后，父 done 仍允许幂等 replay。
    const okChildRootId = `${okChild.planId}#1#root`;
    expect(await tasks.append({
      v: 1,
      eventId: `${okChildRootId}#created`,
      taskId: okChildRootId,
      type: 'created',
      actor: { device: 'device-A', agent: 'planner' },
      at: 2,
      toStatus: 'queued',
      trace: { causedBy: parentStepTaskId, chain: [parentStepTaskId] },
      to: { device: '__plan__', agent: '__plan__' },
      intent: 'child root',
      dispatch: 'root-only',
    })).toBe(true);

    // B8/B9：新 child 在父 done 后拒绝；已接受 child replay 仍可用。
    expect(await tasks.append({
      v: 1,
      eventId: `${parentStepTaskId}#done@device-A`,
      taskId: parentStepTaskId,
      type: 'done',
      actor: { device: 'device-A', agent: 'planner' },
      at: 3,
      toStatus: 'done',
      trace: { chain: [] },
      payloadRef: 'parent-result',
    })).toBe(true);
    const afterDone = await request('/app/plans', {
      method: 'POST',
      body: { plan: childPlan(parent.planId, { planId: 'plan-daemon-child-after-done-001' }), namespace: 'tasks' },
    });
    expect(afterDone.status).toBe(409);
    expect(afterDone.body.error).toBe('PLAN_STATE_INVALID');

    const acceptedReplay = await request('/app/plans', { method: 'POST', body: { plan: okChild, namespace: 'tasks' } });
    expect(acceptedReplay.status).toBe(200);
    expect(acceptedReplay.body).toMatchObject({ ok: true, replayed: true });

    // B10：rootless child replay 即使内容相同也不得 dedupe/补 root。
    const rootlessReplay = await request('/app/plans', { method: 'POST', body: { plan: rootlessChild, namespace: 'tasks' } });
    expect(rootlessReplay.status).toBe(409);
    expect(rootlessReplay.body).toMatchObject({ ok: false, error: 'PLAN_STATE_INVALID' });
    expect(await tasks.byTask(`${rootlessChild.planId}#1#root`)).toHaveLength(0);
  });

  it('B4：daemon CLI 提交 plan → 同一 daemon materializer → task_status.plan', async () => {
    const cliHome = await mkdtemp(join(tmpdir(), 'fleet-daemon-plans-cli-'));
    await writeFile(join(cliHome, 'fleet.config.json'), JSON.stringify({
      v: 1,
      device: 'device-A',
      dir: cliHome,
      storagePath: join(cliHome, 'store.jsonl'),
      masterKeyFile: join(cliHome, 'master-key.json'),
      namespace: 'tasks',
      listen: '/ip4/127.0.0.1/tcp/0',
      peers: [],
      agents: [{ name: 'worker', kind: 'command', command: process.execPath }, { name: 'planner', kind: 'command', command: process.execPath }],
      store: 'daemon',
      daemon: { endpoint: base },
    }), { mode: 0o600 });
    try {
      const p = plan({ planId: 'plan-daemon-cli-001' });
      // 真实 CLI 进程：验证 `--plan '<json>'` 与 daemon store 选择，不只走 handler。
      const { stdout: cliOut } = await execFileAsync(process.execPath, [
        join(process.cwd(), 'packages', 'fleet', 'dist', 'cli.js'),
        'task_submit',
        '--dir', cliHome,
        '--agent', 'planner',
        '--intent', 'daemon cli plan',
        '--to', JSON.stringify({ device: '__plan__', agent: '__plan__' }),
        '--plan', JSON.stringify(p),
      ], { encoding: 'utf-8' });
      const submitted = JSON.parse(cliOut);
      expect(submitted).toMatchObject({ ok: true, planId: p.planId, version: 1, rootTaskId: `${p.planId}#1#root` });
      expect(existsSync(join(cliHome, 'store.jsonl'))).toBe(false);

      const plans = new fleet.DaemonTaskPlanStore({ endpoint: base, namespace: 'tasks' });
      const tasks = new fleet.DaemonTaskEventStore({ endpoint: base, namespace: 'tasks' });
      const routingCards = fleet.compileCapabilityCards({
        config: { device: 'device-B', namespace: 'tasks', agents: [{ name: 'worker', kind: 'command', command: process.execPath }] },
        now: 1,
      }).map((card) => ({ ...card, limits: { ...card.limits, maxConcurrency: 8 } }));
      const materializer = new fleet.PlanMaterializer({
        device: 'device-A',
        agent: 'planner',
        plans,
        store: tasks,
        routing: {
          cards: async () => routingCards,
          authorized: () => ({ devices: ['device-B'] }),
          online: () => true,
          observations: () => [],
          namespace: 'tasks',
        },
      });
      const tick = await materializer.tick();
      expect(tick.tasksCreated).toContain(`${p.planId}#1#work`);

      const status = await fleet.toolByName('task_status').handler(
        { taskId: `${p.planId}#1#root` },
        { dir: cliHome, agent: 'planner' },
      );
      expect(status).toMatchObject({
        ok: true,
        state: { status: 'running' },
        plan: {
          planId: p.planId,
          version: 1,
          rootTaskId: `${p.planId}#1#root`,
          mr: { submitted: false },
        },
      });
      expect(status.plan.steps.find((step) => step.stepId === 'work')).toMatchObject({
        status: 'dispatched',
        taskId: `${p.planId}#1#work`,
      });
      expect(status.plan.mr).toEqual({ submitted: false });

      const retryMissing = await fleet.toolByName('task_retry').handler(
        { taskId: 'plan-not-synced#1#work' },
        { dir: cliHome, agent: 'planner' },
      );
      expect(retryMissing).toMatchObject({ ok: false, error: 'PLAN_RETRY_REQUIRED' });
    } finally {
      await rm(cliHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it('P6：daemon CLI plan cancel（pending MR/步骤级联）与 task_status', async () => {
    const cliHome = await mkdtemp(join(tmpdir(), 'fleet-daemon-plans-cancel-'));
    await writeFile(join(cliHome, 'fleet.config.json'), JSON.stringify({
      v: 1,
      device: 'device-A',
      dir: cliHome,
      storagePath: join(cliHome, 'store.jsonl'),
      masterKeyFile: join(cliHome, 'master-key.json'),
      namespace: 'tasks',
      listen: '/ip4/127.0.0.1/tcp/0',
      peers: [],
      agents: [{ name: 'worker', kind: 'command', command: process.execPath }, { name: 'planner', kind: 'command', command: process.execPath }],
      store: 'daemon',
      daemon: { endpoint: base },
    }), { mode: 0o600 });
    try {
      const p = plan({ planId: 'plan-daemon-cli-cancel-001' });
      const cli = (args) => execFileAsync(process.execPath, [
        join(process.cwd(), 'packages', 'fleet', 'dist', 'cli.js'),
        ...args,
        '--dir', cliHome,
        '--agent', 'planner',
      ], { encoding: 'utf-8' });
      const { stdout: submitOut } = await cli([
        'task_submit',
        '--intent', 'daemon cli cancel plan',
        '--to', JSON.stringify({ device: '__plan__', agent: '__plan__' }),
        '--plan', JSON.stringify(p),
      ]);
      expect(JSON.parse(submitOut)).toMatchObject({ ok: true, rootTaskId: `${p.planId}#1#root` });

      const plans = new fleet.DaemonTaskPlanStore({ endpoint: base, namespace: 'tasks' });
      const tasks = new fleet.DaemonTaskEventStore({ endpoint: base, namespace: 'tasks' });
      const routingCards = fleet.compileCapabilityCards({
        config: { device: 'device-B', namespace: 'tasks', agents: [{ name: 'worker', kind: 'command', command: process.execPath }] },
        now: 1,
      }).map((card) => ({ ...card, limits: { ...card.limits, maxConcurrency: 8 } }));
      const materializer = new fleet.PlanMaterializer({
        device: 'device-A',
        agent: 'planner',
        plans,
        store: tasks,
        routing: {
          cards: async () => routingCards,
          authorized: () => ({ devices: ['device-B'] }),
          online: () => true,
          observations: () => [],
          namespace: 'tasks',
        },
      });
      await materializer.tick();
      expect(await tasks.byTask(`${p.planId}#1#work`)).not.toHaveLength(0);

      const { stdout: cancelOut } = await cli(['task_cancel', '--taskId', `${p.planId}#1#root`]);
      expect(JSON.parse(cancelOut)).toMatchObject({ ok: true, status: 'failed', reason: 'CANCELLED' });

      const { stdout: statusOut } = await cli(['task_status', '--taskId', `${p.planId}#1#root`]);
      const status = JSON.parse(statusOut);
      expect(status).toMatchObject({ ok: true, plan: { status: 'cancelled', mr: { submitted: false } } });
      expect(status.plan.steps.find((step) => step.stepId === 'work')).toMatchObject({
        status: 'failed',
        blockedBy: ['CANCELLED'],
      });
      await materializer.tick();
      expect(await tasks.byTask(`${p.planId}#1#mr`)).toHaveLength(0);
    } finally {
      await rm(cliHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it('/app/plans 过滤 deletedAt；auth/read-only 负例', async () => {
    const p = plan({ planId: 'plan-daemon-deleted-001' });
    const created = await request('/app/plans', { method: 'POST', body: { plan: p, namespace: 'tasks' } });
    expect(created.status).toBe(200);
    const node = (await app.graph.listNodes({ type: 'task_plan' }))
      .find((entry) => entry.content?.planId === p.planId);
    expect(node).toBeTruthy();
    await app.graph.updateNode(node.id, { deletedAt: Date.now() });
    const listed = await request(`/app/plans?namespace=tasks&planId=${encodeURIComponent(p.planId)}`);
    expect(listed.body.count).toBe(0);
    expect((await new fleet.DaemonTaskPlanStore({ endpoint: base }).list())
      .some((entry) => entry.planId === p.planId)).toBe(false);

    // read-only：关闭写入后 POST 403，GET 仍可读。
    const readonlyServer = await startHttpServer({
      home,
      app,
      service,
      config: { deviceId: 'device-A', sync: { namespaces: ['tasks', 'agents'] }, mcp: { http: { host: '127.0.0.1', port: 0, auth: 'none' } } },
      buildServer: () => ({ connect: async () => undefined, close: async () => undefined }),
      host: '127.0.0.1',
      port: 0,
      auth: 'none',
      deviceId: 'device-A',
      namespace: 'tasks',
      writesEnabled: false,
    });
    try {
      const readonlyBase = `http://127.0.0.1:${readonlyServer.port}`;
      const write = await fetch(`${readonlyBase}/app/plans`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ plan: plan({ planId: 'plan-daemon-readonly-001' }), namespace: 'tasks' }),
      });
      expect(write.status).toBe(403);
      expect((await write.json()).error).toBe('read_only');
      const read = await fetch(`${readonlyBase}/app/plans?namespace=tasks`);
      expect(read.status).toBe(200);
    } finally {
      await readonlyServer.close().catch(() => undefined);
    }

    // auth/token：无 token 401；memory.read-only 403；memory.write 可写；read token 可读。
    const authHome = await mkdtemp(join(tmpdir(), 'fleet-daemon-plans-auth-'));
    const tokensFile = join(authHome, 'tokens.json');
    const readToken = 'plan-read-token';
    const writeToken = 'plan-write-token';
    await writeFile(tokensFile, JSON.stringify({
      tokens: [
        { id: 'read', sha256: hashToken(readToken), scope: ['memory.read'], revoked: false },
        { id: 'write', sha256: hashToken(writeToken), scope: ['memory.write'], revoked: false },
      ],
    }));
    const authServer = await startHttpServer({
      home: authHome,
      app,
      service,
      config: { deviceId: 'device-A', sync: { namespaces: ['tasks', 'agents'] }, mcp: { http: { host: '127.0.0.1', port: 0, auth: 'bearer' } } },
      buildServer: () => ({ connect: async () => undefined, close: async () => undefined }),
      host: '127.0.0.1',
      port: 0,
      auth: 'bearer',
      tokensFile,
      deviceId: 'device-A',
      namespace: 'tasks',
      writesEnabled: true,
    });
    try {
      const authBase = `http://127.0.0.1:${authServer.port}`;
      const payload = JSON.stringify({ plan: plan({ planId: 'plan-daemon-auth-001' }), namespace: 'tasks' });
      const noAuth = await fetch(`${authBase}/app/plans`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload });
      expect(noAuth.status).toBe(401);
      const readOnly = await fetch(`${authBase}/app/plans`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${readToken}` },
        body: payload,
      });
      expect(readOnly.status).toBe(403);
      const writeOk = await fetch(`${authBase}/app/plans`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${writeToken}` },
        body: payload,
      });
      expect(writeOk.status).toBe(200);
      const readOk = await fetch(`${authBase}/app/plans?namespace=tasks`, {
        headers: { authorization: `Bearer ${readToken}` },
      });
      expect(readOk.status).toBe(200);
    } finally {
      await authServer.close().catch(() => undefined);
      await rm(authHome, { recursive: true, force: true });
    }
  });
});
