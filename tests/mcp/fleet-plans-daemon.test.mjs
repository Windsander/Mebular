// P2 daemon /app/plans：internal plan 节点写入/读取、幂等/冲突、embedded 一致性、
// 记忆列表/域计数/SSE 不暴露 plan；/app/nodes 仍拒绝 task_plan。
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mebular, MemoryService } from '@mebular/core';
import { startHttpServer } from '../../packages/mcp/src/serve.mjs';
import { fleetEventFromEvent } from '../../packages/mcp/src/fleet-events.mjs';

const fleet = await import('../../packages/fleet/dist/index.js');

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
});
