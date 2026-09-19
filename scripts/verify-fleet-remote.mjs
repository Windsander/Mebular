#!/usr/bin/env node
// M3 验收脚本：真实 libp2p 传输（loopback），任务经**记忆同步**传递。
//
// 覆盖：① M2 正确性集（N≥20 完成且结果匹配 / 重复投递不重复执行 / 配额账本守恒 /
//        expiresAt 仅本机展示 / 重启韧性）在真实传输上重跑
//       ② 授权负例：未授权设备看不到 tasks 分区（默认拒绝）
//       ③ 时延：任务写入 → 对端可见的 p50/p95（原始数据）
//
// 前置：`npm run build`（依赖 @mebular/core 与 packages/fleet/dist）。

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
  ExecutionLog,
  echoResultFor,
  isExpiredLocally,
} from '../packages/fleet/dist/index.js';

const N = 20;
const EXPIRE_COUNT = 5;
const QUOTA_LIMIT = 8;
const RESTART_AFTER = 8;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn, timeoutMs, pollMs = 10) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(pollMs);
  }
  return fn();
}
function percentile(values, p) {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
}

const dir = await mkdtemp(join(tmpdir(), 'fleet-remote-'));
const master = await Mebular.generateUserMasterKey();
const encryption = { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey };
const makeNode = (deviceId, peerNamespacePolicy) =>
  new Mebular({
    storagePath: join(dir, `${deviceId}.jsonl`),
    deviceId,
    encryption,
    network: { enabled: true, libp2p: { listen: ['/ip4/127.0.0.1/tcp/0'] } },
    sync: { autoSync: true, pushOnWrite: true, pushOnWriteThrottleMs: 20, namespaces: ['tasks'], peerNamespacePolicy },
  });

function waitBothSynced(a, b, timeoutMs = 10000) {
  return new Promise((resolve) => {
    let count = 0;
    let settled = false;
    const done = () => {
      if (settled) return;
      if (++count >= 2) {
        settled = true;
        resolve(true);
      }
    };
    a.sync.once('sync-completed', done);
    b.sync.once('sync-completed', done);
    setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(count >= 2);
      }
    }, timeoutMs);
  });
}

let A;
let B;
let B2 = null;
let worker;
let log;
let bStore;
const execLogPath = join(dir, 'B.exec.jsonl');

try {
  console.log('== M3 fleet 真实 libp2p（loopback）验收 ==');
  A = makeNode('device-A', { 'device-B': ['tasks'] });
  B = makeNode('device-B', { 'device-A': ['tasks'] });
  await A.initialize();
  await B.initialize();
  const addrA = A.node.getLocalMultiaddrs()[0];
  check('前置：libp2p 监听地址可用', typeof addrA === 'string' && addrA.length > 0, { addrA });

  const synced = waitBothSynced(A, B);
  await B.node.connectToPeer(A.node.peerId, addrA);
  check('前置：A/B 初始同步完成', await synced);

  // 确定性恢复：触发 anti-entropy（有 pending 才开会话），兜底丢失的 push（慢 runner/丢帧）
  const kickSync = async () => {
    await A.sync.runAntiEntropyCycle().catch(() => undefined);
    await (B2 ?? B).sync.runAntiEntropyCycle().catch(() => undefined);
  };

  const aStore = new MebularTaskEventStore(A);
  bStore = new MebularTaskEventStore(B);
  const node = new FleetNode({
    device: 'device-A',
    store: aStore,
    transport: new NullTransport(),
    quota: new LocalQuota({ limitPerDevice: QUOTA_LIMIT, onOverflow: 'queue' }),
  });
  log = await ExecutionLog.open(execLogPath);
  worker = new FleetWorker({ device: 'device-B', agent: 'echo', store: bStore, transport: new NullTransport(), executor: new EchoExecutor(), log });

  // 提交 + 时延（写入 → 对端可见）
  const decisions = { accepted: 0, queued: 0, rejected: 0 };
  const ids = [];
  const latencies = [];
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    const request = { intent: `remote-${i}`, to: { device: 'device-B', agent: '*' } };
    if (i < EXPIRE_COUNT) request.expiresAt = Date.now() - 1_000; // 已过期（仅本机展示）
    const { taskId, decision } = await node.submit(request);
    decisions[decision] += 1;
    if (taskId === null) continue;
    ids.push(taskId);
    let visible = await waitUntil(async () => (await bStore.byTask(taskId)).length > 0, 30000, 5);
    if (!visible) {
      await kickSync();
      visible = await waitUntil(async () => (await bStore.byTask(taskId)).length > 0, 30000, 5);
    }
    latencies.push(performance.now() - t0);
  }

  // 驱动：worker 执行 + 中途重启 worker
  let restarted = false;
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    await worker.pollOnce();
    await kickSync();
    const states = await node.states();
    const terminal = states.filter((s) => s.terminal).length;

    if (!restarted && terminal >= RESTART_AFTER) {
      await B.shutdown();
      B2 = makeNode('device-B', { 'device-A': ['tasks'] });
      await B2.initialize();
      await B2.node.connectToPeer(A.node.peerId, addrA);
      await sleep(300);
      bStore = new MebularTaskEventStore(B2);
      log = await ExecutionLog.open(execLogPath);
      worker = new FleetWorker({ device: 'device-B', agent: 'echo', store: bStore, transport: new NullTransport(), executor: new EchoExecutor(), log });
      await worker.reconcile();
      restarted = true;
    }

    if (states.length === ids.length && terminal === ids.length) break;
    await sleep(25);
  }

  const states = await node.states();
  const byId = new Map(states.map((s) => [s.taskId, s]));
  const done = states.filter((s) => s.status === 'done');
  const resultsMatch = ids.every((id) => {
    const s = byId.get(id);
    return s && s.status === 'done' && s.resultRef === echoResultFor(s.intent);
  });
  const expiredSubmitted = states.filter((s) => s.expiresAt !== undefined).length;
  const expiredCompleted = states.filter((s) => s.expiresAt !== undefined && s.status === 'done').length;
  const advisoryOnly = expiredCompleted > 0 && isExpiredLocally(byId.get(ids[0])?.expiresAt, Date.now() + 10 ** 9);

  // 重复投递不重复执行：完成后再多轮 poll，执行数不变
  const execCountAtDone = log.size();
  for (let i = 0; i < 5; i++) await worker.pollOnce();
  const execCountAfter = log.size();
  const execTasks = log.all().map((e) => e.taskId);

  check('① 全部完成且结果匹配', done.length === N && resultsMatch, { done: done.length, resultsMatch });
  check('③ 配额账本守恒且超额排队', decisions.accepted + decisions.queued + decisions.rejected === N && decisions.queued >= 1, decisions);
  check('④ expiresAt 只影响本机展示', expiredSubmitted === EXPIRE_COUNT && expiredCompleted === EXPIRE_COUNT && advisoryOnly === true, {
    submitted: expiredSubmitted, completed: expiredCompleted,
  });
  check('⑤ 重启韧性（不丢）', restarted && done.length === N, { restarted, done: done.length });
  check('⑤ 重启韧性（不重）', execTasks.length === N && new Set(execTasks).size === N && execCountAfter === execCountAtDone, {
    executions: execTasks.length, distinct: new Set(execTasks).size, afterExtraPolls: execCountAfter,
  });
  check('① 重复投递不重复执行（额外轮询不增执行）', execCountAfter === N, { execCountAfter });

  // 授权负例：未授权 C 连上 A 后拿不到 tasks
  const C = makeNode('device-C', {});
  await C.initialize();
  await C.node.connectToPeer(A.node.peerId, addrA);
  await sleep(1200);
  const cStore = new MebularTaskEventStore(C);
  const seenByC = (await cStore.all()).length;
  check('② 授权负例：未授权设备看不到 tasks（默认拒绝）', seenByC === 0, { seenByC });
  await C.shutdown();

  // 时延统计（原始）
  const lat = { count: latencies.length, min: Math.min(...latencies), p50: percentile(latencies, 50), p95: percentile(latencies, 95), max: Math.max(...latencies) };
  console.log('== 时延（write → peer-visible, ms） ==');
  console.log(JSON.stringify({ ...lat, samples: latencies.map((x) => Math.round(x)) }, null, 2));
  check('③ 时延 p50/p95 有数据（loopback）', latencies.length === N && lat.p95 > 0, lat);
} finally {
  try {
    if (worker) await worker.close();
  } catch {
    /* ignore */
  }
  for (const m of [A, B, B2]) {
    try {
      if (m) await m.shutdown();
    } catch {
      /* ignore */
    }
  }
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

const failed = results.filter((r) => !r.ok);
console.log('== 摘要 ==');
const summary = { total: results.length, passed: results.length - failed.length, failed: failed.map((f) => f.name), skipped: [] };
console.log(JSON.stringify(summary, null, 2));
console.log(`FLEET_SUMMARY ${JSON.stringify(summary)}`);
process.exit(failed.length === 0 ? 0 : 1);
