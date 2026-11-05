#!/usr/bin/env node
// Fleet 黑盒编排演示：用户只对 A 说一句需求，A 通过 task_submit.plan 拆解、
// 按能力路由到 B/C/D，J 做全量汇合，最后由 A 提交一次 MR。
//
// 这是一个可运行的“产品故事”工装，不是新的协议/接口：
// - 使用真实 Fleet plan / materializer / routing / join / MR 代码；
// - 使用 in-process Mebular + InMemoryHub 隔离网络抖动（P6 E2E 同一边界）；
// - 只打印设备/Agent、step 状态、why 和最终结果，不打印 intent 原文/凭据。
//
// 运行：npm run build && node scripts/fleet-blackbox-demo.mjs

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mebular } from '@mebular/core';
import { InMemoryHub } from '../dist/p2p/transport/InMemoryTransport.js';
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
  derivePlanProgress,
  embeddedRoutingProvider,
  latestCapabilityCards,
  listCapabilityCards,
  planMrTaskRefs,
  planTaskId,
  publishFleetCards,
  reduceTaskEvents,
  toolByName,
} from '../packages/fleet/dist/index.js';

const A = { device: 'device-A', agent: 'planner' };
const B = { device: 'device-B', agent: 'worker' };
const C = { device: 'device-C', agent: 'worker' };
const D = { device: 'device-D', agent: 'worker' };
const J = { device: 'device-J', agent: 'worker' };
const PLAN_SENTINEL = { device: '__plan__', agent: '__plan__' };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fleetConfig(dir, device, agents, peers = []) {
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

function storyPlan(planId) {
  return {
    v: 1,
    kind: 'task_plan',
    planId,
    version: 1,
    owner: A,
    goal: '把 X 模块重构、补测试、更新文档，最后提交一次 MR',
    createdAt: 1,
    budget: { maxSteps: 8, maxAttemptsPerStep: 2 },
    policy: {
      allowedDevices: [B.device, C.device, D.device, J.device],
      allowedAgents: ['worker'],
      requireCapabilities: ['fleet.task'],
      maxParallel: 3,
      allowSubcontract: false,
    },
    steps: [
      {
        stepId: 'code',
        kind: 'task',
        intent: '重构 X 模块',
        dependsOn: [],
        route: { require: ['code.write'], prefer: [], strategy: 'deterministic' },
        acceptance: { kind: 'non-empty-result' },
      },
      {
        stepId: 'tests',
        kind: 'task',
        intent: '补齐测试',
        dependsOn: [],
        route: { require: ['test'], prefer: [], strategy: 'deterministic' },
        acceptance: { kind: 'non-empty-result' },
      },
      {
        stepId: 'docs',
        kind: 'task',
        intent: '更新文档',
        dependsOn: [],
        route: { require: ['docs'], prefer: [], strategy: 'deterministic' },
        acceptance: { kind: 'non-empty-result' },
      },
      {
        stepId: 'gate',
        kind: 'reduce',
        intent: '汇总所有分支',
        dependsOn: ['code', 'tests', 'docs'],
        to: J,
        join: { mode: 'all' },
        acceptance: { kind: 'non-empty-result' },
      },
      {
        stepId: 'mr',
        kind: 'mr',
        intent: '提交一次 MR',
        dependsOn: ['gate'],
        acceptance: { kind: 'mr-once' },
      },
    ],
  };
}

async function syncAll(nodes) {
  for (const node of nodes) {
    await node.sync.runAntiEntropyCycle().catch(() => undefined);
    await sleep(10);
  }
}

async function waitFor(fn, timeoutMs = 30_000, pollMs = 40) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(pollMs);
  }
  return fn();
}

function stepLine(step, stateById) {
  const state = step.taskId === undefined ? undefined : stateById.get(step.taskId);
  const chosen = state?.to ?? step.why?.ranking?.[0];
  const target = chosen === undefined ? 'unassigned' : `${chosen.device}/${chosen.agent}`;
  const reason = step.why?.code ?? step.status;
  return `  ${step.stepId.padEnd(5)} ${step.status.padEnd(9)} -> ${target.padEnd(22)} why=${reason}`;
}

const rootDir = await mkdtemp(join(tmpdir(), 'fleet-blackbox-demo-'));
const nodes = [];
let workers = [];
try {
  const dir = join(rootDir, 'home');
  await mkdir(dir, { recursive: true });
  const master = await Mebular.generateUserMasterKey();
  const encryption = { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey };
  const hub = new InMemoryHub();
  const mkNode = (device) => new Mebular({
    storagePath: join(dir, `${device}.jsonl`),
    deviceId: device,
    encryption,
    network: { enabled: true, provider: hub },
    sync: {
      autoSync: true,
      pushOnWrite: false,
      namespaces: ['tasks', AGENT_NAMESPACE],
      antiEntropy: { enabled: true, intervalMs: 3_600_000, jitterRatio: 0 },
    },
  });
  const [a, b, c, d, j] = [A, B, C, D, J].map((endpoint) => mkNode(endpoint.device));
  nodes.push(a, b, c, d, j);
  await Promise.all(nodes.map((node) => node.initialize()));
  for (let i = 0; i < nodes.length; i += 1) {
    for (let k = 0; k < nodes.length; k += 1) {
      if (i === k) continue;
      await nodes[i].node.connectToPeer(nodes[k].node.peerId).catch(() => undefined);
    }
  }
  await waitFor(async () => {
    await syncAll(nodes);
    return a.sync.getOnlinePeers().length >= 4;
  });

  for (const node of nodes) {
    await node.subscribeNamespace('tasks');
    await node.subscribeNamespace(AGENT_NAMESPACE);
  }

  for (const [node, endpoint, capabilities] of [
    [b, B, ['code.write', 'review']],
    [c, C, ['test', 'ci']],
    [d, D, ['docs', 'review']],
    [j, J, ['review', 'gate']],
  ]) {
    const published = await publishFleetCards({
      mebular: node,
      config: fleetConfig(dir, endpoint.device, [
        { name: 'worker', kind: 'command', command: process.execPath, capabilities },
      ], [A.device]),
      now: 1,
    });
    if (published.errors.length > 0) throw new Error(`publish cards ${endpoint.device}: ${published.errors.join('; ')}`);
  }

  const configA = fleetConfig(dir, A.device, [
    { name: 'planner', kind: 'command', command: process.execPath },
  ], [B.device, C.device, D.device, J.device]);
  await writeFile(join(dir, 'fleet.config.json'), JSON.stringify(configA), { mode: 0o600 });

  const cardsVisible = await waitFor(async () => {
    await syncAll(nodes);
    const cards = activeCapabilityCards(latestCapabilityCards(await listCapabilityCards(a)));
    return [B, C, D, J].every((endpoint) => cards.some((card) => card.device === endpoint.device));
  }, 30_000);
  if (!cardsVisible) throw new Error('worker capability cards did not converge');

  const storeA = new MebularTaskEventStore(a, { namespace: 'tasks' });
  const plansA = new MebularTaskPlanStore(a, { namespace: 'tasks' });
  const stores = new Map([
    [A.device, storeA],
    [B.device, new MebularTaskEventStore(b, { namespace: 'tasks' })],
    [C.device, new MebularTaskEventStore(c, { namespace: 'tasks' })],
    [D.device, new MebularTaskEventStore(d, { namespace: 'tasks' })],
    [J.device, new MebularTaskEventStore(j, { namespace: 'tasks' })],
  ]);

  const planId = 'plan-demo-blackbox-001';
  const plan = storyPlan(planId);
  const submitted = await toolByName('task_submit').handler(
    { intent: '把 X 模块重构、补测试、更新文档，最后提交一次 MR', to: PLAN_SENTINEL, plan },
    { dir, mebular: a, agent: A.agent },
  );
  if (submitted.ok !== true) throw new Error(`plan submit failed: ${JSON.stringify(submitted)}`);

  console.log('用户 → A: “把 X 模块重构、补测试、更新文档，最后提个 MR。”');
  console.log(`A → Fleet: task_submit.plan  planId=${submitted.planId} version=${submitted.version}`);
  console.log(`Fleet → A: rootTaskId=${submitted.rootTaskId}`);
  console.log('');

  const workerFor = async (endpoint) => new FleetWorker({
    device: endpoint.device,
    agent: endpoint.agent,
    store: stores.get(endpoint.device),
    transport: new NullTransport(),
    executor: new EchoExecutor(),
    log: await ExecutionLog.open(join(dir, `exec-${endpoint.device}-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`)),
  });
  workers = await Promise.all([A, B, C, D, J].map(workerFor));

  const materializer = new PlanMaterializer({
    device: A.device,
    agent: A.agent,
    plans: plansA,
    store: storeA,
    routing: embeddedRoutingProvider({ mebular: a, config: configA, store: storeA }),
  });

  const runWorkers = async () => {
    for (const worker of workers) await worker.pollOnce().catch(() => undefined);
  };
  const bridgeTaskEvents = async () => {
    const all = [];
    for (const store of stores.values()) all.push(...await store.all());
    for (const store of stores.values()) {
      for (const event of all) await store.append(event);
    }
  };

  const rootTaskId = submitted.rootTaskId;
  await waitFor(async () => {
    await materializer.tick();
    await runWorkers();
    await bridgeTaskEvents();
    await runWorkers();
    return reduceTaskEvents(await storeA.byTask(rootTaskId))?.status === 'done';
  }, 90_000);

  const states = (await storeA.all()).reduce((acc, event) => {
    const list = acc.get(event.taskId) ?? [];
    list.push(event);
    acc.set(event.taskId, list);
    return acc;
  }, new Map());
  const derived = [...states.keys()].sort()
    .map((taskId) => reduceTaskEvents(states.get(taskId)))
    .filter((state) => state !== null);
  const progress = derivePlanProgress(plan, derived, [plan]);
  const status = await toolByName('task_status').handler(
    { taskId: rootTaskId },
    { dir, mebular: a, agent: A.agent },
  );

  const mrTaskId = planTaskId(planId, 1, 'mr');
  const mrCreated = (await storeA.byTask(mrTaskId)).filter((event) => event.type === 'created');
  const mrCount = planMrTaskRefs(planId, [plan], derived).length;

  const stateById = new Map(derived.map((state) => [state.taskId, state]));
  console.log('A 的计划（内部可见，人类 UI 不显示）:');
  console.log('  step   status    chosen                 why');
  for (const step of status.plan?.steps ?? []) console.log(stepLine(step, stateById));
  console.log('');
  console.log('实际执行结果:');
  console.log(`  plan status: ${progress.status}`);
  console.log(`  root status: ${derived.find((state) => state.taskId === rootTaskId)?.status ?? 'missing'}`);
  console.log(`  MR created: ${mrCreated.length}（跨版本引用 ${mrCount}）`);
  console.log(`  task_status.plan: ${status.ok === true ? 'readable' : 'unavailable'}`);
  console.log('');
  console.log('用户看到的结果: 任务完成；MR 只提交一次；没有打开 plan 页面或配置卡片。');
} finally {
  await Promise.all(workers.map((worker) => worker.close?.().catch(() => undefined)));
  await Promise.all(nodes.map((node) => node.shutdown().catch(() => undefined)));
  await rm(rootDir, { recursive: true, force: true });
}
