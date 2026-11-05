#!/usr/bin/env node
// P6 验收：三机（A/B/C/D/J）embedded loopback plan E2E + 双 daemon 卡片/plan 协同。
//
// 覆盖：A 提交 plan → B/C/D 分支 → J join → pre-MR reduce → MR(owner A) → root done；
// 重复投递/重启/取消/失败重试 v2 reuse；daemon 内部 verified peer 公钥读路径、卡片同步、
// daemon CLI plan submit/status 与远端路由。前置：npm run build。
// 不记录 intent 原文/对话/command/env/凭据；只输出计数、状态与原因码。

import { execFile } from 'node:child_process';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { IdentityManager, Mebular } from '@mebular/core';
import {
  AGENT_NAMESPACE,
  DaemonAgentBackend,
  DaemonTaskEventStore,
  DaemonTaskPlanStore,
  EchoExecutor,
  ExecutionLog,
  FleetWorker,
  MebularTaskEventStore,
  MebularTaskPlanStore,
  NullTransport,
  PlanMaterializer,
  compileCapabilityCards,
  daemonRoutingProvider,
  derivePlanProgress,
  embeddedRoutingProvider,
  identityPublicKeyForStorage,
  planMrTaskRefs,
  planRootTaskId,
  planTaskId,
  publishFleetCards,
  reduceTaskEvents,
  submitTaskPlan,
  toolByName,
  activeCapabilityCards,
  latestCapabilityCards,
  listCapabilityCards,
} from '../packages/fleet/dist/index.js';
import { fleetEventFromEvent } from '../packages/mcp/src/fleet-events.mjs';
import { InMemoryHub } from '../dist/p2p/transport/InMemoryTransport.js';

const MCP = fileURLToPath(new URL('../packages/mcp/bin/mebular.mjs', import.meta.url));
const FLEET_CLI = fileURLToPath(new URL('../packages/fleet/dist/cli.js', import.meta.url));
const execFileAsync = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const skipped = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
}
async function waitFor(fn, timeoutMs, pollMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(pollMs);
  }
  return fn();
}
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}
async function statesOf(store) {
  const byTask = new Map();
  for (const event of await store.all()) {
    const list = byTask.get(event.taskId);
    if (list) list.push(event);
    else byTask.set(event.taskId, [event]);
  }
  return [...byTask.keys()].sort()
    .map((taskId) => reduceTaskEvents(byTask.get(taskId)))
    .filter((state) => state !== null);
}

async function getJson(url, options) {
  const res = await fetch(url, options);
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
function startServe(home) {
  const child = spawn(process.execPath, [MCP, 'serve'], {
    env: { ...process.env, MEBULAR_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const state = { out: '', err: '' };
  child.stdout.on('data', (data) => (state.out += data));
  child.stderr.on('data', (data) => (state.err += data));
  return { child, state };
}

const A = { device: 'device-A', agent: 'planner' };
const B = { device: 'device-B', agent: 'worker' };
const C = { device: 'device-C', agent: 'worker' };
const D = { device: 'device-D', agent: 'worker' };
const J = { device: 'device-J', agent: 'worker' };
const SENTINEL = { device: '__plan__', agent: '__plan__' };

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

function plan(planId, version = 1, overrides = {}) {
  return {
    v: 1,
    kind: 'task_plan',
    planId,
    version,
    ...(version > 1 ? { supersedesVersion: version - 1, retryOfStepId: 'c' } : {}),
    owner: A,
    goal: 'P6 E2E plan',
    createdAt: 100 + version,
    budget: { maxSteps: 8, maxAttemptsPerStep: 2 },
    policy: {
      allowedDevices: [B.device, C.device, D.device, J.device],
      allowedAgents: ['worker'],
      requireCapabilities: ['fleet.task'],
      maxParallel: 3,
      allowSubcontract: false,
    },
    steps: [
      { stepId: 'b', kind: 'task', intent: 'branch b', dependsOn: [], to: B, acceptance: { kind: 'non-empty-result' } },
      { stepId: 'c', kind: 'task', intent: 'branch c', dependsOn: [], to: C, acceptance: { kind: 'non-empty-result' } },
      { stepId: 'd', kind: 'task', intent: 'branch d', dependsOn: [], to: D, acceptance: { kind: 'non-empty-result' } },
      { stepId: 'j', kind: 'join', intent: 'join all', dependsOn: ['b', 'c', 'd'], to: J, join: { mode: 'all' }, acceptance: { kind: 'non-empty-result' } },
      { stepId: 'pre-mr', kind: 'reduce', intent: 'pre mr', dependsOn: ['j'], to: J, join: { mode: 'all' }, acceptance: { kind: 'non-empty-result' } },
      { stepId: 'mr', kind: 'mr', intent: 'submit mr', dependsOn: ['pre-mr'], acceptance: { kind: 'mr-once' } },
    ],
    ...overrides,
  };
}

class FailV1CExecutor {
  constructor(planId) {
    this.planId = planId;
    this.inner = new EchoExecutor();
  }
  async execute(task) {
    if (task.taskId === planTaskId(this.planId, 1, 'c')) {
      return { ok: false, reason: 'P6_INJECTED_FAILURE' };
    }
    return this.inner.execute(task);
  }
}

const root = await mkdtemp(join(tmpdir(), 'fleet-p6-e2e-'));
const nodes = [];
const workers = [];
let serveA = null;
let serveB = null;
try {
  // =========================================================================
  // Part A：embedded loopback，A/B/C/D/J 五节点。
  // =========================================================================
  console.log('== P6-A：embedded loopback plan E2E ==');
  const dir = join(root, 'embedded');
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
      // 任务事件由确定性 loopback bridge 投递；卡片/订阅由显式 anti-entropy 同步，
      // 避免 shutdown 时仍有 pushOnWrite 回调在途（P6 工装稳定性）。
      pushOnWrite: false,
      namespaces: ['tasks', AGENT_NAMESPACE],
      antiEntropy: { enabled: true, intervalMs: 3_600_000, jitterRatio: 0 },
    },
  });
  const [a, b, c, d, j] = [A, B, C, D, J].map((endpoint) => mkNode(endpoint.device));
  nodes.push(a, b, c, d, j);
  await Promise.all(nodes.map((node) => node.initialize()));
  for (let i = 0; i < nodes.length; i++) {
    for (let k = 0; k < nodes.length; k++) {
      if (i === k) continue;
      await nodes[i].node.connectToPeer(nodes[k].node.peerId).catch(() => undefined);
    }
  }
  await waitFor(async () => {
    for (const node of nodes) await node.sync.runAntiEntropyCycle().catch(() => undefined);
    return a.sync.getOnlinePeers().length >= 4;
  }, 20_000);

  const storeA = new MebularTaskEventStore(a, { namespace: 'tasks' });
  const plansA = new MebularTaskPlanStore(a, { namespace: 'tasks' });
  const stores = new Map([
    [A.device, storeA],
    [B.device, new MebularTaskEventStore(b, { namespace: 'tasks' })],
    [C.device, new MebularTaskEventStore(c, { namespace: 'tasks' })],
    [D.device, new MebularTaskEventStore(d, { namespace: 'tasks' })],
    [J.device, new MebularTaskEventStore(j, { namespace: 'tasks' })],
  ]);

  for (const node of nodes) {
    await node.subscribeNamespace('tasks');
    await node.subscribeNamespace(AGENT_NAMESPACE);
  }
  for (const [node, endpoint, capabilities] of [
    [b, B, ['code.write', 'api']],
    [c, C, ['code.write', 'ui']],
    [d, D, ['review']],
    [j, J, ['review', 'gate']],
  ]) {
    const published = await publishFleetCards({
      mebular: node,
      // P6 编排工装用 EchoExecutor 提速，但目录/卡片必须声明真实可执行 kind，
      // 否则会被 0.3.2 的 executable/plan-owner 硬过滤正确拒绝。
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

  const syncAll = async () => {
    for (const node of nodes) {
      await node.sync.runAntiEntropyCycle().catch(() => undefined);
      // runAntiEntropyCycle 只调度会话；给同一轮的 push/offer 往返留出完成窗口，
      // 避免五节点连续调度造成会话重叠（P6 E2E 稳定性）。
      await sleep(10);
    }
  };
  // 三机 E2E 的确定性投递工装：把每个 device store 的 task 事件按 eventId 幂等复制到其它
  // device store，模拟 loopback 已收敛的同步结果。真实 libp2p/sync 仍由 verify:fleet:tasks、
  // routing-e2e 与 daemon cluster 覆盖；这里隔离 anti-entropy 调度抖动，只验证编排正确性，
  // 同时每一轮重复复制即覆盖 duplicate delivery 收敛。
  const bridgeTaskEvents = async () => {
    const storesList = [...stores.values()];
    const events = [];
    for (const store of storesList) events.push(...await store.all());
    for (const store of storesList) {
      for (const event of events) await store.append(event);
    }
  };

  const cardsVisible = await waitFor(async () => {
    await syncAll();
    const cards = activeCapabilityCards(latestCapabilityCards(await listCapabilityCards(a)));
    const devices = new Set(cards.map((card) => card.device));
    const subscribed = await Promise.all([B, C, D, J].map((endpoint) => a.getSubscriptions(endpoint.device)));
    return [B, C, D, J].every((endpoint) => devices.has(endpoint.device))
      && subscribed.every((namespaces) => namespaces.includes('tasks'));
  }, 30_000);
  check('三机/五节点：能力卡与 tasks 订阅互见', cardsVisible, {});

  const p = plan('plan-p6-e2e-001');
  const submitted = await toolByName('task_submit').handler(
    { intent: 'submit P6 E2E plan', to: SENTINEL, plan: p },
    { dir, mebular: a, agent: A.agent },
  );
  check('A 通过 task_submit.plan 提交完整 plan', submitted.ok === true
    && submitted.planId === p.planId
    && submitted.version === 1
    && submitted.rootTaskId === planRootTaskId(p.planId, 1), {
    rootTaskId: submitted.rootTaskId,
  });

  const workerFor = async (endpoint, executor = new EchoExecutor()) => new FleetWorker({
    device: endpoint.device,
    agent: endpoint.agent,
    store: stores.get(endpoint.device),
    transport: new NullTransport(),
    executor,
    log: await ExecutionLog.open(join(dir, `exec-${endpoint.device}-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`)),
  });
  let workerA = await workerFor(A);
  let workerB = await workerFor(B);
  let workerC = await workerFor(C);
  let workerD = await workerFor(D);
  let workerJ = await workerFor(J);
  workers.push(workerA, workerB, workerC, workerD, workerJ);
  const runWorkers = async () => {
    for (const worker of [workerA, workerB, workerC, workerD, workerJ]) {
      await worker.pollOnce().catch(() => undefined);
    }
  };

  let materializer = new PlanMaterializer({
    device: A.device,
    agent: A.agent,
    plans: plansA,
    store: storeA,
    routing: embeddedRoutingProvider({ mebular: a, config: configA, store: storeA }),
  });
  await materializer.tick();
  // kill/restart coordinator：丢弃实例后从 plan + task 事件恢复。
  materializer = new PlanMaterializer({
    device: A.device,
    agent: A.agent,
    plans: plansA,
    store: storeA,
    routing: embeddedRoutingProvider({ mebular: a, config: configA, store: storeA }),
  });

  const mainDone = await waitFor(async () => {
    await materializer.tick();
    await runWorkers();
    await bridgeTaskEvents();
    await runWorkers();
    return reduceTaskEvents(await storeA.byTask(planRootTaskId(p.planId, 1)))?.status === 'done';
  }, 90_000, 40);
  check('三机 E2E：B/C/D → J join all → pre-MR reduce → MR(A) → root done', mainDone, {});
  const progress = derivePlanProgress(p, await statesOf(storeA), [p]);
  const rootState = reduceTaskEvents(await storeA.byTask(planRootTaskId(p.planId, 1)));
  const mrTaskId = planTaskId(p.planId, 1, 'mr');
  const mrCreated = (await storeA.byTask(mrTaskId)).filter((event) => event.type === 'created');
  check('root done 且 plan/MR 状态正确；MR 恰好一次', rootState?.status === 'done'
    && progress.status === 'done'
    && progress.mr.submitted === true
    && mrCreated.length === 1
    && mrCreated[0]?.to?.device === A.device
    && mrCreated[0]?.dispatch === 'root-only', {
    planStatus: progress.status,
    mrCreated: mrCreated.length,
  });
  const createdIds = (await storeA.all()).filter((event) => event.type === 'created').map((event) => event.taskId).sort();
  const expectedIds = [
    planRootTaskId(p.planId, 1),
    ...p.steps.map((step) => planTaskId(p.planId, 1, step.stepId)),
  ].sort();
  check('任务图无环/无重复：root + 6 step，每个 created 恰好一次', JSON.stringify(createdIds) === JSON.stringify(expectedIds)
    && new Set(createdIds).size === createdIds.length, { created: createdIds.length });

  const status = await toolByName('task_status').handler(
    { taskId: planRootTaskId(p.planId, 1) },
    { dir, mebular: a, agent: A.agent },
  );
  const statusText = JSON.stringify(status);
  check('task_status.plan：why/blockedBy 可解释，且不含 intent/原文/command/env', status.ok === true
    && status.plan?.status === 'done'
    && status.plan.steps.find((step) => step.stepId === 'b')?.why?.code === 'ASSIGNED'
    && !/branch b|branch c|join all|pre mr|submit mr|prompt|command|token|secret|env/i.test(statusText), {
    steps: status.plan?.steps?.length,
  });

  // 重复投递/重复提交：不重复写 plan/root/MR。
  const duplicateMr = (await storeA.byTask(mrTaskId))[0];
  const duplicateAppend = await storeA.append({ ...duplicateMr });
  const replay = await submitTaskPlan({ plan: p, intent: 'replay', to: SENTINEL, caller: A, plans: plansA, store: storeA });
  check('重复投递/重复提交收敛：duplicate event=false，plan deduped', duplicateAppend === false
    && replay.ok === true
    && replay.deduped === true
    && (await plansA.list()).filter((entry) => entry.planId === p.planId).length === 1
    && (await storeA.byTask(mrTaskId)).filter((event) => event.type === 'created').length === 1, {});
  const restartedTick = await new PlanMaterializer({
    device: A.device,
    agent: A.agent,
    plans: plansA,
    store: storeA,
    routing: embeddedRoutingProvider({ mebular: a, config: configA, store: storeA }),
  }).tick();
  check('kill/restart 后不重复物化', restartedTick.tasksCreated.length === 0, { created: restartedTick.tasksCreated.length });

  // plan cancel：停止新物化并级联取消非终态 step；不得再创建 join/MR。
  const cancelPlan = plan('plan-p6-e2e-cancel-001');
  const cancelSubmit = await toolByName('task_submit').handler(
    { intent: 'submit cancel plan', to: SENTINEL, plan: cancelPlan },
    { dir, mebular: a, agent: A.agent },
  );
  await materializer.tick();
  const cancelResult = await toolByName('task_cancel').handler(
    { taskId: planRootTaskId(cancelPlan.planId, 1) },
    { dir, mebular: a, agent: A.agent },
  );
  await materializer.tick();
  const cancelledSteps = await Promise.all(['b', 'c', 'd'].map((stepId) => storeA.byTask(planTaskId(cancelPlan.planId, 1, stepId))));
  check('plan cancel：root failed CANCELLED，step 级联取消，不创建 join/MR', cancelSubmit.ok === true
    && cancelResult.ok === true
    && cancelResult.reason === 'CANCELLED'
    && cancelledSteps.every((events) => events.length > 0 && reduceTaskEvents(events)?.reason === 'CANCELLED')
    && (await storeA.byTask(planTaskId(cancelPlan.planId, 1, 'j'))).length === 0
    && (await storeA.byTask(planTaskId(cancelPlan.planId, 1, 'mr'))).length === 0, {
    reason: cancelResult.reason,
  });

  // 分支失败 → v2 reuse：C v1 失败，b/d 复用，c/join/pre-MR/MR 重建；MR 不提前。
  const retryPlan = plan('plan-p6-e2e-retry-001');
  const retrySubmit1 = await toolByName('task_submit').handler(
    { intent: 'submit retry plan v1', to: SENTINEL, plan: retryPlan },
    { dir, mebular: a, agent: A.agent },
  );
  workerC = await workerFor(C, new FailV1CExecutor(retryPlan.planId));
  workers.push(workerC);
  const failedV1 = await waitFor(async () => {
    await materializer.tick();
    await runWorkers();
    await bridgeTaskEvents();
    await runWorkers();
    return reduceTaskEvents(await storeA.byTask(planRootTaskId(retryPlan.planId, 1)))?.status === 'failed';
  }, 60_000, 40);
  const v1Root = reduceTaskEvents(await storeA.byTask(planRootTaskId(retryPlan.planId, 1)));
  check('分支失败：plan failed，MR 不提前提交', retrySubmit1.ok === true
    && failedV1
    && v1Root?.reason === 'STEP_FAILED:c'
    && (await storeA.byTask(planTaskId(retryPlan.planId, 1, 'mr'))).length === 0, { reason: v1Root?.reason });

  const retryV2 = plan(retryPlan.planId, 2, {
    steps: retryPlan.steps.map((step) => step.stepId === 'b' || step.stepId === 'd'
      ? { ...step, reuse: { version: 1 } }
      : step),
  });
  const retrySubmit2 = await toolByName('task_submit').handler(
    { intent: 'submit retry plan v2', to: SENTINEL, plan: retryV2 },
    { dir, mebular: a, agent: A.agent },
  );
  workerC = await workerFor(C, new EchoExecutor());
  workers.push(workerC);
  const retryDone = await waitFor(async () => {
    await materializer.tick();
    await runWorkers();
    await bridgeTaskEvents();
    await runWorkers();
    return reduceTaskEvents(await storeA.byTask(planRootTaskId(retryPlan.planId, 2)))?.status === 'done';
  }, 90_000, 40);
  const retryProgress = derivePlanProgress(retryV2, await statesOf(storeA), await plansA.list());
  const allMrRefs = planMrTaskRefs(retryPlan.planId, await plansA.list(), await statesOf(storeA));
  check('v2 retry + reuse：b/d 复用、c/join/MR 重建、MR 仍恰好一次', retrySubmit2.ok === true
    && retryDone
    && retryProgress.status === 'done'
    && retryProgress.steps.find((step) => step.stepId === 'b')?.via === 'reuse'
    && retryProgress.steps.find((step) => step.stepId === 'd')?.via === 'reuse'
    && retryProgress.steps.find((step) => step.stepId === 'c')?.via === 'task'
    && allMrRefs.length === 1
    && allMrRefs[0]?.version === 2, {
    planStatus: retryProgress.status,
    mrRefs: allMrRefs.length,
  });

  // internal 可见性由 P6 regression 测试覆盖；这里只确认 SSE 映射不吞真实 task created。
  const createdForSse = (await storeA.byTask(planTaskId(p.planId, 1, 'b')))[0];
  check('星图 SSE：真实 task created 可映射；plan 节点不可映射', fleetEventFromEvent({
    type: 'node_created',
    namespace: 'tasks',
    data: { node: { type: 'task_event', namespace: 'tasks', content: createdForSse } },
  })?.taskId === planTaskId(p.planId, 1, 'b')
    && fleetEventFromEvent({
      type: 'node_created',
      namespace: 'tasks',
      data: { node: { type: 'task_plan', namespace: 'tasks', content: p, metadata: { internal: true } } },
    }) === null, {});

  // 清理 embedded workers/stores。
  for (const worker of workers.splice(0)) await worker.close().catch(() => undefined);
  for (const node of nodes.splice(0)) await node.shutdown().catch(() => undefined);
  for (const store of stores.values()) await store.close().catch(() => undefined);
  await storeA.close().catch(() => undefined);

  // =========================================================================
  // Part B：双 daemon loopback（A 守护 + B 守护），卡片同步 + plan 协同。
  // =========================================================================
  console.log('== P6-B：双 daemon 卡片同步 + plan 协同 ==');
  const homeA = join(root, 'daemon-A');
  const homeB = join(root, 'daemon-B');
  await mkdir(homeA, { recursive: true });
  const portA = await freePort();
  const portB = await freePort();
  const joinPort = await freePort();
  const baseA = `http://127.0.0.1:${portA}`;
  const baseB = `http://127.0.0.1:${portB}`;

  const imA = new IdentityManager();
  const masterA = await imA.generateUserMasterKey();
  await imA.generateDeviceKey('device-A', 'A');
  await imA.issueDeviceCertificate('device-A');
  await writeFile(join(homeA, 'master-key.json'), JSON.stringify({
    publicKey: Buffer.from(masterA.publicKey).toString('base64'),
    privateKeyPkcs8: await IdentityManager.exportPrivateKey(masterA.privateKey),
  }, null, 2), { mode: 0o600 });
  await writeFile(join(homeA, 'config.json'), JSON.stringify({
    storagePath: join(homeA, 'store.jsonl'),
    deviceId: 'device-A',
    identity: { mode: 'root' },
    encryption: { level: 'none', keyFile: join(homeA, 'master-key.json') },
    network: { enabled: true, libp2p: { listen: ['/ip4/127.0.0.1/tcp/0'] } },
    sync: {
      autoSync: true,
      pushOnWrite: true,
      namespaces: ['tasks', 'agents'],
      antiEntropy: { enabled: true, intervalMs: 3600000, jitterRatio: 0 },
    },
    joinService: { enabled: true, bind: '127.0.0.1', port: joinPort },
    mcp: { http: { host: '127.0.0.1', port: portA, auth: 'none' } },
  }, null, 2), { mode: 0o600 });
  serveA = startServe(homeA);
  const aReady = await waitFor(() => /SERVE_READY/.test(serveA.state.out), 20_000);
  const aNet = await getJson(`${baseA}/app/network`);
  const aAddr = aNet.json?.multiaddrs?.[0];
  check('daemon A 就绪并暴露 loopback 地址', aReady && typeof aAddr === 'string' && aAddr.includes('/p2p/'), {});

  const invite = await getJson(`${baseA}/app/join/invite`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ namespace: 'tasks', ttlMs: 120_000 }),
  });
  const imB = new IdentityManager();
  const bKey = await imB.generateDeviceKey('device-B', 'B');
  const joined = await getJson(`http://127.0.0.1:${joinPort}/mebular/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: invite.json.token, deviceId: 'device-B', devicePublicKey: Buffer.from(bKey.publicKey).toString('hex') }),
  });
  await mkdir(homeB, { recursive: true });
  await writeFile(`${join(homeB, 'store.jsonl')}.identity.json`, JSON.stringify({
    deviceId: 'device-B',
    deviceName: 'B',
    publicKeyHex: Buffer.from(bKey.publicKey).toString('hex'),
    certificate: joined.json.certificate,
    certificateChain: joined.json.chain,
    createdAt: Date.now(),
    privateKeyPkcs8: await IdentityManager.exportPrivateKey(bKey.privateKey),
  }, null, 2), { mode: 0o600 });
  await writeFile(join(homeB, 'user-master-key.json'), JSON.stringify({
    publicKey: JSON.parse(readFileSync(join(homeA, 'master-key.json'), 'utf-8')).publicKey,
  }, null, 2), { mode: 0o600 });
  await writeFile(join(homeB, 'config.json'), JSON.stringify({
    storagePath: join(homeB, 'store.jsonl'),
    deviceId: 'device-B',
    identity: { mode: 'delegated' },
    encryption: { level: 'none', userMasterPublicKeyFile: join(homeB, 'user-master-key.json') },
    network: { enabled: true, libp2p: { listen: ['/ip4/127.0.0.1/tcp/0'] }, peers: [{ device: 'device-A', addr: aAddr }] },
    sync: {
      autoSync: true,
      pushOnWrite: true,
      namespaces: ['tasks', 'agents'],
      antiEntropy: { enabled: true, intervalMs: 3600000, jitterRatio: 0 },
    },
    mcp: { http: { host: '127.0.0.1', port: portB, auth: 'none' } },
  }, null, 2), { mode: 0o600 });
  serveB = startServe(homeB);
  const bReady = await waitFor(() => /SERVE_READY/.test(serveB.state.out), 20_000);
  check('daemon B 就绪（delegated）', bReady && joined.status === 200, {});

  for (const port of [portA, portB]) {
    await getJson(`http://127.0.0.1:${port}/app/policy/subscription`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ namespace: 'tasks', active: true }),
    });
    await getJson(`http://127.0.0.1:${port}/app/policy/subscription`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ namespace: 'agents', active: true }),
    });
  }

  const localKeyA = identityPublicKeyForStorage(join(homeA, 'store.jsonl'));
  const backendA = new DaemonAgentBackend({
    endpoint: baseA,
    namespace: AGENT_NAMESPACE,
    ...(localKeyA !== null ? { publicKeyFor: (device) => (device === 'device-A' ? localKeyA : undefined) } : {}),
  });
  const backendB = new DaemonAgentBackend({ endpoint: baseB, namespace: AGENT_NAMESPACE });
  const draftA = compileCapabilityCards({
    config: fleetConfig(homeA, 'device-A', [
      { name: 'planner', kind: 'command', command: process.execPath },
    ]),
    now: 1,
  })[0];
  const draftB = compileCapabilityCards({
    config: fleetConfig(homeB, 'device-B', [
      { name: 'worker', kind: 'command', command: process.execPath, capabilities: ['code.write'] },
    ]),
    now: 1,
  })[0];
  await backendA.signAndAppendCard(draftA);
  await backendB.signAndAppendCard(draftB);

  const peersVisible = await waitFor(async () => {
    const peers = await getJson(`${baseA}/app/peers`);
    const cards = await backendA.listCards();
    return (peers.json?.peers ?? []).some((peer) => peer.device === 'device-B')
      && cards.some((card) => card.device === 'device-B' && card.agent === 'worker');
  }, 30_000, 200);
  check('daemon 远端卡：/app/peers 已认证公钥验签通过', peersVisible, {});

  const subscriptionsVisible = await waitFor(async () => {
    try {
      return (await backendA.getSubscriptions('device-B')).includes('tasks');
    } catch {
      return false;
    }
  }, 20_000, 200);
  check('daemon 授权：B 的 tasks 订阅同步到 A', subscriptionsVisible, {});

  const daemonPlan = {
    ...plan('plan-p6-daemon-001'),
    steps: [
      { stepId: 'work', kind: 'task', intent: 'daemon work', dependsOn: [], to: B, acceptance: { kind: 'non-empty-result' } },
      { stepId: 'gate', kind: 'reduce', intent: 'daemon gate', dependsOn: ['work'], to: B, join: { mode: 'all' }, acceptance: { kind: 'non-empty-result' } },
      { stepId: 'mr', kind: 'mr', intent: 'daemon mr', dependsOn: ['gate'], acceptance: { kind: 'mr-once' } },
    ],
    budget: { maxSteps: 4, maxAttemptsPerStep: 2 },
  };
  const cliHome = join(root, 'daemon-cli-A');
  await mkdir(cliHome, { recursive: true });
  await writeFile(join(cliHome, 'fleet.config.json'), JSON.stringify({
    v: 1,
    device: 'device-A',
    dir: cliHome,
    storagePath: join(cliHome, 'store.jsonl'),
    masterKeyFile: join(cliHome, 'master-key.json'),
    namespace: 'tasks',
    listen: '/ip4/127.0.0.1/tcp/0',
    peers: [{ device: 'device-B' }],
    agents: [{ name: 'planner', kind: 'command', command: process.execPath }],
    store: 'daemon',
    daemon: { endpoint: baseA },
  }), { mode: 0o600 });
  const { stdout: submitOut } = await execFileAsync(process.execPath, [
    FLEET_CLI,
    'task_submit',
    '--dir', cliHome,
    '--agent', 'planner',
    '--intent', 'daemon plan submit',
    '--to', JSON.stringify(SENTINEL),
    '--plan', JSON.stringify(daemonPlan),
  ], { encoding: 'utf-8' });
  const daemonSubmitted = JSON.parse(submitOut);
  check('daemon CLI plan submit', daemonSubmitted.ok === true
    && daemonSubmitted.rootTaskId === planRootTaskId(daemonPlan.planId, 1), {});

  const daemonStoreA = new DaemonTaskEventStore({ endpoint: baseA, namespace: 'tasks' });
  const daemonPlansA = new DaemonTaskPlanStore({ endpoint: baseA, namespace: 'tasks' });
  const daemonStoreB = new DaemonTaskEventStore({ endpoint: baseB, namespace: 'tasks' });
  const daemonConfigA = {
    device: 'device-A',
    namespace: 'tasks',
    peers: [{ device: 'device-B' }],
    roleCards: { enabled: false },
  };
  const daemonMaterializer = new PlanMaterializer({
    device: 'device-A',
    agent: 'planner',
    plans: daemonPlansA,
    store: daemonStoreA,
    routing: daemonRoutingProvider({
      backend: backendA,
      config: daemonConfigA,
      store: daemonStoreA,
      onlineDevices: () => backendA.listOnlineDevices(),
    }),
  });
  const firstDaemonTick = await daemonMaterializer.tick();
  check('daemon materializer：远端卡片/在线/授权通过，work 路由到 B', firstDaemonTick.tasksCreated.includes(planTaskId(daemonPlan.planId, 1, 'work'))
    && firstDaemonTick.assignments.some((entry) => entry.stepId === 'work' && entry.chosen.device === 'device-B'), {
    created: firstDaemonTick.tasksCreated.length,
  });

  const daemonWorkerB = new FleetWorker({
    device: 'device-B',
    agent: 'worker',
    store: daemonStoreB,
    transport: new NullTransport(),
    executor: new EchoExecutor(),
    log: await ExecutionLog.open(join(homeB, 'daemon-worker.exec.jsonl')),
  });
  const daemonWorkerA = new FleetWorker({
    device: 'device-A',
    agent: 'planner',
    store: daemonStoreA,
    transport: new NullTransport(),
    executor: new EchoExecutor(),
    log: await ExecutionLog.open(join(homeA, 'daemon-planner.exec.jsonl')),
  });
  const daemonDone = await waitFor(async () => {
    await daemonWorkerB.pollOnce().catch(() => undefined);
    await daemonWorkerA.pollOnce().catch(() => undefined);
    await daemonMaterializer.tick();
    await daemonWorkerB.pollOnce().catch(() => undefined);
    await daemonWorkerA.pollOnce().catch(() => undefined);
    return reduceTaskEvents(await daemonStoreA.byTask(planRootTaskId(daemonPlan.planId, 1)))?.status === 'done';
  }, 90_000, 200);
  const daemonRoot = reduceTaskEvents(await daemonStoreA.byTask(planRootTaskId(daemonPlan.planId, 1)));
  const daemonMrId = planTaskId(daemonPlan.planId, 1, 'mr');
  const daemonMrCreated = (await daemonStoreA.byTask(daemonMrId)).filter((event) => event.type === 'created');
  const daemonProgress = derivePlanProgress(
    daemonPlan,
    await statesOf(daemonStoreA),
    await daemonPlansA.list(),
  );
  check('双 daemon plan 协同：root done，MR 恰好一次，所有 step done', daemonDone
    && daemonRoot?.status === 'done'
    && daemonProgress.status === 'done'
    && daemonMrCreated.length === 1
    && daemonProgress.steps.every((step) => step.status === 'done'), {
    planStatus: daemonProgress.status,
    mrCreated: daemonMrCreated.length,
  });

  const { stdout: statusOut } = await execFileAsync(process.execPath, [
    FLEET_CLI,
    'task_status',
    '--dir', cliHome,
    '--agent', 'planner',
    '--taskId', planRootTaskId(daemonPlan.planId, 1),
  ], { encoding: 'utf-8' });
  const daemonStatus = JSON.parse(statusOut);
  check('daemon CLI plan status', daemonStatus.ok === true
    && daemonStatus.plan?.status === 'done'
    && daemonStatus.plan?.mr?.submitted === true, {});

  const writtenRole = await getJson(`${baseA}/app/role-cards?namespace=agents`);
  const writtenPlan = await getJson(`${baseA}/app/plans?namespace=tasks&planId=${encodeURIComponent(daemonPlan.planId)}`);
  check('daemon 内部 role/plan 端点可读（不新增公共 MCP/UI）', writtenRole.status === 200
    && writtenRole.json?.ok === true
    && writtenPlan.status === 200
    && writtenPlan.json?.ok === true
    && writtenPlan.json?.count === 1, {});

  for (const worker of [daemonWorkerA, daemonWorkerB]) await worker.close().catch(() => undefined);
  await daemonStoreA.close().catch(() => undefined);
  await daemonStoreB.close().catch(() => undefined);
} catch (error) {
  console.error('P6 E2E 异常：', error?.stack ?? error);
  results.push({ name: 'P6 E2E 未抛异常', ok: false });
} finally {
  for (const worker of workers.splice(0)) await worker.close().catch(() => undefined);
  for (const node of nodes.splice(0)) await node.shutdown().catch(() => undefined);
  for (const server of [serveA, serveB]) {
    if (server) {
      try { server.child.kill('SIGKILL'); } catch { /* ignore */ }
    }
  }
  await sleep(200);
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

const passed = results.filter((entry) => entry.ok).length;
const failed = results.filter((entry) => !entry.ok).map((entry) => entry.name);
console.log('== verify:fleet:p6 ==');
console.log(`FLEET_SUMMARY ${JSON.stringify({ total: results.length, passed, failed, skipped })}`);
process.exit(failed.length === 0 ? 0 : 1);
