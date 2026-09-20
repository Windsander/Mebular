#!/usr/bin/env node
// W1 验收：Agent 任务面 + 反滥用（预算递减 / 链长越界拒收 / 公平轮转 / 目录→targets）。
// 真实 libp2p loopback 双端（A 任务板 / B 执行端）+ 确定性 echo 执行器。
// 前置：npm run build。摘要行 FLEET_SUMMARY。

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mebular } from '@mebular/core';
import {
  MebularTaskEventStore,
  NullTransport,
  FleetNode,
  FleetWorker,
  LocalQuota,
  EchoExecutor,
  ExecutorRegistry,
  ExecutionLog,
  echoResultFor,
  mapPlanner,
  childTaskId,
  agentDirectoryStore,
  expandTargets,
  toolCliTable,
} from '../packages/fleet/dist/index.js';

const results = [];
const skipped = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, pollMs = 20) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(pollMs);
  }
  return fn();
}

const root = await mkdtemp(join(tmpdir(), 'fleet-tasks-verify-'));
let a;
let b;
try {
  console.log('== W1：任务树预算 / 拒收 / 公平 / 目录（真实 libp2p loopback） ==');
  const master = await Mebular.generateUserMasterKey();
  const encryption = { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey };
  const mk = (deviceId, peer) =>
    new Mebular({
      storagePath: join(root, `${deviceId}.jsonl`),
      deviceId,
      encryption,
      network: { enabled: true, libp2p: { listen: ['/ip4/127.0.0.1/tcp/0'] } },
      sync: { autoSync: true, pushOnWrite: true, pushOnWriteThrottleMs: 20, namespaces: ['tasks', 'agents'], peerNamespacePolicy: { [peer]: ['tasks', 'agents'] } },
    });
  a = mk('device-A', 'device-B');
  b = mk('device-B', 'device-A');
  await a.initialize();
  await b.initialize();
  await b.node.connectToPeer(a.node.peerId, a.node.getLocalMultiaddrs()[0]);
  await sleep(200);
  check('libp2p 双端已监听（loopback）', a.node.getLocalMultiaddrs().length > 0 && b.node.getLocalMultiaddrs().length > 0, {});

  const storeA = new MebularTaskEventStore(a);
  const storeB = new MebularTaskEventStore(b);
  const loop = (worker) => {
    let stop = false;
    const done = (async () => {
      for (let i = 0; i < 60000 && !stop; i++) {
        if (i % 20 === 1) await b.node.connectToPeer(a.node.peerId, a.node.getLocalMultiaddrs()[0]).catch(() => undefined);
        else if (i % 20 === 11) await a.node.connectToPeer(b.node.peerId, b.node.getLocalMultiaddrs()[0]).catch(() => undefined);
        await a.sync.runAntiEntropyCycle().catch(() => undefined);
        await b.sync.runAntiEntropyCycle().catch(() => undefined);
        if (worker) await worker.pollOnce();
        await sleep(5);
      }
    })();
    return { stop: () => (stop = true), done };
  };
  const nodeOn = (store) =>
    new FleetNode({ device: 'device-A', store, transport: new NullTransport(), quota: new LocalQuota({ limitPerDevice: 1_000_000 }) });
  const workerFor = async (planner) => {
    const registry = new ExecutorRegistry();
    registry.register('echo', new EchoExecutor());
    const log = await ExecutionLog.open(join(root, `B-${Date.now()}-${Math.random().toString(36).slice(2)}.exec.jsonl`));
    const worker = new FleetWorker({ device: 'device-B', agent: 'worker', store: storeB, transport: new NullTransport(), registry, log, ...(planner ? { planner } : {}) });
    return { worker, log };
  };

  // ---- ① 预算内派生 + 汇总 ----
  const n1 = nodeOn(storeA);
  const { taskId: root1 } = await n1.submit({
    intent: 'root',
    to: { device: 'device-B', agent: 'echo' },
    budget: { maxDepth: 2, maxChildren: 4, maxTasks: 8 },
    dispatch: 'children-ok',
  });
  const { worker: w1 } = await workerFor(mapPlanner({ root: [{ intent: 'child-0' }, { intent: 'child-1' }] }));
  const l1 = loop(w1);
  const completion1 = await n1.waitForDagCompletion(root1, { timeoutMs: 90000 });
  l1.stop();
  await l1.done;
  const reach1 = [root1, childTaskId(root1, 0), childTaskId(root1, 1)].sort();
  check('W1 root（带预算）→ 2 子任务 → 汇总完成', completion1.complete === true && JSON.stringify(completion1.reachable) === JSON.stringify(reach1), { reachable: completion1.reachable.length });
  const summary1 = await n1.summarizeDag(root1);
  check('汇总含 3 条结果且前缀正确', summary1.summary.split('|').length === 3 && summary1.summary.includes(echoResultFor('root')), {});

  // ---- ② 链长越界：maxDepth=1 下孙任务被拒收（权威视图剔除） ----
  const n2 = nodeOn(storeA);
  const { taskId: root2 } = await n2.submit({ intent: 'r2', to: { device: 'device-B', agent: 'echo' }, budget: { maxDepth: 1, maxChildren: 4, maxTasks: 8 } });
  const { worker: w2 } = await workerFor(mapPlanner({ r2: [{ intent: 'c' }], c: [{ intent: 'g' }] }));
  const l2 = loop(w2);
  // 等到 root2 完成（子任务 c 完成）
  const completion2 = await n2.waitForDagCompletion(root2, { timeoutMs: 60000 });
  l2.stop();
  await l2.done;
  const grand2 = childTaskId(childTaskId(root2, 0), 0);
  const statesB2 = await w2.statesView();
  check('链长越界：孙任务不进入权威视图（拒收）', statesB2.every((s) => s.taskId !== grand2) && (await storeB.byTask(grand2)).length >= 1, {
    grandInStore: (await storeB.byTask(grand2)).length,
    grandInView: statesB2.some((s) => s.taskId === grand2),
  });
  check('链长越界：root2 仍可在子任务层完成', completion2.reachable.every((id) => id !== grand2), { reachable: completion2.reachable.length });

  // ---- ③ 超预算：伪造越预算 created 事件 → B 权威视图剔除 ----
  const root3 = `task-A-budget-${Date.now().toString(36)}`;
  await storeA.append({
    v: 1, eventId: `${root3}#created`, taskId: root3, type: 'created',
    actor: { device: 'device-A', agent: 'board' }, at: Date.now(), toStatus: 'queued',
    trace: { chain: [] }, to: { device: 'device-B', agent: 'echo' }, intent: 'r3',
    budget: { maxDepth: 2, maxChildren: 4, maxTasks: 8 },
  });
  const badChild = `${root3}~c0`;
  await storeA.append({
    v: 1, eventId: `${badChild}#created`, taskId: badChild, type: 'created',
    actor: { device: 'device-B', agent: 'worker' }, at: Date.now(), toStatus: 'queued',
    trace: { causedBy: root3, chain: [root3] }, to: { device: 'device-B', agent: 'echo' }, intent: 'bad',
    budget: { maxDepth: 2, maxChildren: 4, maxTasks: 7 }, // maxDepth 2 > 父剩余 1
  });
  const l3 = loop();
  const synced = await waitFor(async () => (await storeB.byTask(badChild)).length >= 1, 30000);
  l3.stop();
  await l3.done;
  const statesB3 = await new FleetWorker({ device: 'device-B', agent: 'worker', store: storeB, transport: new NullTransport(), registry: (() => { const r = new ExecutorRegistry(); r.register('echo', new EchoExecutor()); return r; })(), log: await ExecutionLog.open(join(root, 'admit.exec.jsonl')) }).statesView();
  check('超预算：越界 created 同步到达但被权威视图剔除', synced && statesB3.every((s) => s.taskId !== badChild), { synced, inView: statesB3.some((s) => s.taskId === badChild) });

  // ---- ④ 公平轮转：A:4 + B:2 → 前两拍含 B ----
  const nB = new FleetNode({ device: 'device-B', store: storeB, transport: new NullTransport(), quota: new LocalQuota({ limitPerDevice: 1_000_000 }) });
  const fairTag = `fair-${Date.now().toString(36)}`;
  const aIds = [];
  for (let i = 0; i < 4; i++) {
    const { taskId } = await n1.submit({ intent: `${fairTag}-a${i}`, to: { device: 'device-B', agent: 'echo' } });
    aIds.push(taskId);
  }
  const bIds = [];
  for (let i = 0; i < 2; i++) {
    const { taskId } = await nB.submit({ intent: `${fairTag}-b${i}`, to: { device: 'device-B', agent: 'echo' } });
    bIds.push(taskId);
  }
  const l4 = loop();
  await waitFor(async () => (await storeB.all()).filter((e) => e.type === 'created' && (aIds.includes(e.taskId) || bIds.includes(e.taskId))).length === 6, 30000);
  l4.stop();
  await l4.done;
  const { worker: w4, log: log4 } = await workerFor();
  await w4.pollOnce(2); // 单轮只执行 2 个 → 观察轮转
  const firstTwo = log4.all().slice(0, 2).map((e) => e.taskId);
  check('公平轮转：前两拍含 B 发送的任务（单一发送方未占满）', firstTwo.some((id) => bIds.includes(id)), { firstTwo, bIds });

  // ---- ⑤ 目录 → targets（授权 ∩ 目录） ----
  await agentDirectoryStore(b, 'agents').append({
    v: 1, device: 'device-B', updatedAt: Date.now(), version: 1,
    agents: [{ name: 'echo', kind: 'echo' }, { name: 'hermes', kind: 'hermes' }],
  });
  const l5 = loop();
  const syncedDir = await waitFor(async () => (await agentDirectoryStore(a, 'agents').all()).some((e) => e.device === 'device-B'), 30000);
  l5.stop();
  await l5.done;
  const entriesA = await agentDirectoryStore(a, 'agents').all();
  const targets = expandTargets(entriesA, ['device-B']);
  check('目录 → targets：授权对端 ∩ 目录 (device,agent)', syncedDir && targets.some((t) => t.device === 'device-B' && t.agent === 'echo') && targets.some((t) => t.agent === 'hermes'), { targets });
  check('目录 → targets：未授权设备被排除（默认拒绝）', expandTargets(entriesA, []).length === 0, {});

  // ---- ⑥ 工具 ↔ CLI 对等表 ----
  const table = toolCliTable();
  check('工具面 16 项且 CLI 对等（1:1）', table.length === 16 && new Set(table.map((t) => t.tool)).size === 16 && new Set(table.map((t) => t.cli)).size === 16, { count: table.length });
} finally {
  await a?.shutdown().catch(() => undefined);
  await b?.shutdown().catch(() => undefined);
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok).map((r) => r.name);
console.log('== verify:fleet:tasks ==');
console.log(`FLEET_SUMMARY ${JSON.stringify({ total: results.length, passed, failed, skipped })}`);
process.exit(failed.length === 0 ? 0 : 1);
