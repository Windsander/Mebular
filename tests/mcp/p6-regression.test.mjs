// P6 UI/API 回归：无新导航/页面；plan/card/role 不进记忆列表/搜索/域计数/星图 SSE；
// MCP 16 方法名称与必填字段冻结；旧 task_submit 显式 to 仍正常。
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Mebular, MemoryService } from '@mebular/core';
import { fleetEventFromEvent } from '../../packages/mcp/src/fleet-events.mjs';
import {
  onboardDevice,
  toolByName,
  TASK_TOOLS,
  AGENT_TASK_TOOL_NAMES,
} from '../../packages/fleet/dist/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const REQUIRED = Object.freeze({
  task_submit: ['intent', 'to'],
  task_submit_batch: ['tasks'],
  task_cancel: ['taskId'],
  task_retry: ['taskId'],
  task_status: ['taskId'],
  task_list: [],
  task_history: ['taskId'],
  task_children: ['taskId'],
  task_summarize: ['taskId'],
  task_subscribe: [],
  task_negotiate: ['taskId', 'kind', 'round'],
  chatter_send: ['topic', 'text'],
  chatter_inbox: [],
  task_quota: [],
  task_targets: [],
  board_create: ['name'],
});

describe('P6 UI 回归：导航/页面无新增入口', () => {
  it('Console 仍只有 星图/共享/记忆/审计/运行时 五个视图，无 Fleet/Advanced/plan 面板', async () => {
    const html = await readFile(join(ROOT, 'packages/console/index.html'), 'utf-8');
    const views = [...html.matchAll(/data-view="([^"]+)"/g)].map((match) => match[1]);
    expect(views).toEqual(['map', 'domains', 'memories', 'audit', 'runtime']);
    expect(views).not.toContain('fleet');
    expect(views).not.toContain('advanced');
    expect(views).not.toContain('plan');
    expect(html).not.toMatch(/data-view="[^"]*(fleet|advanced|plan)[^"]*"/i);
  });
});

describe('P6 MCP 回归：16 方法冻结', () => {
  it('名称、必填字段与旧调用显式 to 均不变；无 plan_*/agent_card_*', async () => {
    expect(TASK_TOOLS).toHaveLength(16);
    expect([...TASK_TOOLS.map((tool) => tool.name)].sort()).toEqual([...Object.keys(REQUIRED)].sort());
    expect([...AGENT_TASK_TOOL_NAMES].sort()).toEqual([...Object.keys(REQUIRED)].sort());
    for (const tool of TASK_TOOLS) {
      expect({ name: tool.name, required: tool.inputSchema?.required ?? [] }).toEqual({
        name: tool.name,
        required: REQUIRED[tool.name],
      });
      expect(tool.name).not.toMatch(/^(plan|agent_card|role_card)_/);
    }

    const dir = await mkdtemp(join(tmpdir(), 'p6-mcp-regression-'));
    try {
      await onboardDevice({ dir, device: 'device-A', agents: [{ name: 'planner', kind: 'echo' }] });
      const submitted = await toolByName('task_submit').handler(
        { intent: 'legacy explicit to', to: { device: 'device-B', agent: 'worker' } },
        { dir, agent: 'planner' },
      );
      expect(submitted).toMatchObject({ ok: true });
      expect(submitted.state.to).toEqual({ device: 'device-B', agent: 'worker' });
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});

describe('P6 internal 可见性与星图 SSE', () => {
  let dir;
  let app;
  let service;
  const planGoal = 'P6 unique plan goal 7f4c2b';

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'p6-visibility-'));
    const master = await Mebular.generateUserMasterKey();
    app = new Mebular({
      storagePath: join(dir, 'store.jsonl'),
      deviceId: 'device-A',
      encryption: { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey },
      network: { enabled: false },
      sync: { autoSync: false, namespaces: ['tasks', 'agents'] },
    });
    await app.initialize();
    service = new MemoryService(app);
    await service.write([{ type: 'fact', content: 'ordinary p6 memory', metadata: { namespace: 'tasks' } }]);
    await app.graph.createNode('task_plan', {
      v: 1,
      kind: 'task_plan',
      planId: 'p6-visible-plan',
      version: 1,
      owner: { device: 'device-A', agent: 'planner' },
      goal: planGoal,
      createdAt: 1,
      budget: { maxSteps: 1, maxAttemptsPerStep: 1 },
      policy: {},
      steps: [],
    }, [], {
      namespace: 'tasks',
      metadata: { internal: true, internalObject: { kind: 'task_plan' } },
    });
    await app.graph.createNode('agent_capability_card', {
      v: 1,
      kind: 'agent_capability_card',
      device: 'device-A',
      agent: 'worker',
      version: 1,
      capabilities: ['fleet.task'],
      tools: ['task_submit'],
      limits: { maxConcurrency: 1 },
      permissions: { taskNamespaces: ['tasks'] },
      runtime: { os: 'test', arch: 'test', runtime: 'node', runtimeVersion: '20' },
      provenance: { source: 'test', configHash: 'x', registryHash: 'y', publishedAt: 1 },
      signature: { alg: 'Ed25519', keyId: 'device-A', sig: 'sig' },
    }, [], {
      namespace: 'agents',
      metadata: { internal: true, internalObject: { kind: 'agent_capability_card' } },
    });
    await app.graph.createNode('agent_role_card', {
      v: 1,
      kind: 'agent_role_card',
      device: 'device-A',
      agent: 'worker',
      version: 1,
      summary: 'worker: 1 sample',
      strengths: [],
      preferredIntents: [],
      avoid: [],
      confidence: 0.1,
      evidenceRefs: [],
      shadow: true,
      provenance: { source: 'task-history', sampleSize: 1, generatedAt: 1, generator: 'fleet-role-rules-v1' },
    }, [], {
      namespace: 'agents',
      metadata: { internal: true, internalObject: { kind: 'agent_role_card' } },
    });
  });

  afterAll(async () => {
    await app?.shutdown().catch(() => undefined);
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('记忆列表/搜索/域计数默认隐藏 plan/card/role', async () => {
    const records = await service.listRecords({ namespace: 'tasks' });
    expect(records.total).toBe(1);
    expect(records.nodes.map((node) => node.type)).not.toContain('task_plan');

    const search = await service.search({ query: planGoal });
    expect(search.memories).toHaveLength(0);
    const internalSearch = await service.search({ query: planGoal, types: ['task_plan'] });
    expect(internalSearch.memories).toHaveLength(0);

    const tasks = (await service.namespaceStats()).find((entry) => entry.domain === 'tasks');
    expect(tasks).toMatchObject({ count: 1, memoryRecords: 1, internalObjects: 1 });
    expect(tasks.internalKinds).toMatchObject({ task_plan: 1 });
    const agents = (await service.namespaceStats()).find((entry) => entry.domain === 'agents');
    expect(agents).toMatchObject({ count: 0, memoryRecords: 0, internalObjects: 2 });
    expect(agents.internalKinds).toMatchObject({ agent_capability_card: 1, agent_role_card: 1 });
  });

  it('fleet SSE 只映射真实 task created；plan/card/role 与非 created 均为 null', () => {
    const node = (type, content, namespace = 'tasks') => ({
      type: 'node_created',
      namespace,
      data: { node: { type, namespace, content } },
    });
    expect(fleetEventFromEvent(node('task_plan', { type: 'created', planId: 'p' }))).toBeNull();
    expect(fleetEventFromEvent(node('agent_capability_card', { type: 'created' }, 'agents'))).toBeNull();
    expect(fleetEventFromEvent(node('agent_role_card', { type: 'created' }, 'agents'))).toBeNull();
    expect(fleetEventFromEvent(node('task_event', {
      v: 1, eventId: 't1#done', taskId: 't1', type: 'done', actor: { device: 'device-A', agent: 'planner' },
      to: { device: 'device-B', agent: 'worker' }, at: 1, toStatus: 'done', trace: { chain: [] },
    }))).toBeNull();
    expect(fleetEventFromEvent(node('task_event', {
      v: 1, eventId: 't1#created', taskId: 't1', type: 'created', actor: { device: 'device-A', agent: 'planner' },
      to: { device: 'device-B', agent: 'worker' }, at: 1, toStatus: 'queued', trace: { chain: [] },
    }), { now: 100 })).toEqual({
      at: 100,
      fromDeviceId: 'device-A',
      toDeviceId: 'device-B',
      taskId: 't1',
      eventType: 'created',
      namespace: 'tasks',
    });
  });
});
