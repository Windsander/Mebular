#!/usr/bin/env node
// 1d 验收：三形态接 live 通道，**真实 libp2p loopback** 双端（A 任务板 / B 执行端）。
//
//  1d-a 审查 DAG：root → 2 子任务 → 汇总；每任务恰好一次；负例成环被拒。
//  1d-b 有限协商：counter → accept → 完成；超限 → NEGOTIATION_LIMIT。
//  1d-c 配额制闲聊：配额内交换 / 超额 reject / 账本守恒。
//
// 前置：npm run build。摘要行 FLEET_SUMMARY（含 skipped）。

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
  negotiationMessageStore,
  chatterMessageStore,
  FleetChatter,
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

const root = await mkdtemp(join(tmpdir(), 'fleet-collab-verify-'));
let a;
let b;
try {
  console.log('== 1d：三形态 live（真实 libp2p loopback） ==');
  const master = await Mebular.generateUserMasterKey();
  const encryption = { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey };
  const mk = (deviceId, peer) =>
    new Mebular({
      storagePath: join(root, `${deviceId}.jsonl`),
      deviceId,
      encryption,
      network: { enabled: true, libp2p: { listen: ['/ip4/127.0.0.1/tcp/0'] } },
      sync: { autoSync: true, pushOnWrite: true, pushOnWriteThrottleMs: 20, namespaces: ['tasks'], peerNamespacePolicy: { [peer]: ['tasks'] } },
    });
  a = mk('device-A', 'device-B');
  b = mk('device-B', 'device-A');
  await a.initialize();
  await b.initialize();
  await b.node.connectToPeer(a.node.peerId, a.node.getLocalMultiaddrs()[0]);
  await sleep(200);
  check(
    'libp2p 双端已监听（loopback）',
    a.node.getLocalMultiaddrs().length > 0 && b.node.getLocalMultiaddrs().length > 0,
    { a: a.node.getLocalMultiaddrs()[0], b: b.node.getLocalMultiaddrs()[0] },
  );

  const storeA = new MebularTaskEventStore(a);
  const storeB = new MebularTaskEventStore(b);
  const makeWorker = async (extra) => {
    const registry = new ExecutorRegistry();
    registry.register('echo', new EchoExecutor());
    const log = await ExecutionLog.open(join(root, 'B.exec.jsonl'));
    const worker = new FleetWorker({ device: 'device-B', agent: 'worker', store: storeB, transport: new NullTransport(), registry, log, ...extra });
    return { worker, log };
  };
  const loop = (worker, iterations = 40000) => {
    let stop = false;
    const done = (async () => {
      for (let i = 0; i < iterations && !stop; i++) {
        // 确定性恢复：anti-entropy 兜底丢失的 push（慢 runner）
        await a.sync.runAntiEntropyCycle().catch(() => undefined);
        await b.sync.runAntiEntropyCycle().catch(() => undefined);
        await worker.pollOnce();
        await sleep(5);
      }
    })();
    return { stop: () => (stop = true), done };
  };
  const node = (negotiation) =>
    new FleetNode({
      device: 'device-A',
      store: storeA,
      transport: new NullTransport(),
      quota: new LocalQuota({ limitPerDevice: 1_000_000 }),
      ...(negotiation ? { negotiation } : {}),
    });

  // ---------------- 1d-a DAG ----------------
  const n1 = node();
  const { taskId: rootId } = await n1.submit({ intent: 'root', to: { device: 'device-B', agent: 'echo' } });
  const { worker: w1, log: log1 } = await makeWorker({ planner: mapPlanner({ root: [{ intent: 'child-0' }, { intent: 'child-1' }] }) });
  const l1 = loop(w1);
  const completion = await n1.waitForDagCompletion(rootId, { timeoutMs: 90000 });
  l1.stop();
  await l1.done;
  check('1d-a DAG 完成（全部可达终态）', completion.complete === true, { reachable: completion.reachable.length, pending: completion.pending });
  check('1d-a DAG 可达 = root + 2 子', JSON.stringify(completion.reachable) === JSON.stringify([rootId, childTaskId(rootId, 0), childTaskId(rootId, 1)].sort()), { reachable: completion.reachable });
  const summary = await n1.summarizeDag(rootId);
  check('1d-a 汇总含 3 条结果', summary.summary.split('|').length === 3 && summary.summary.includes(echoResultFor('root')), { summary: summary.summary });
  check('1d-a 每任务恰好一次', log1.size() === 3, { executed: log1.size() });

  const selfCycle = { plan: (state) => [{ intent: 'loop', taskId: state.taskId }] };
  const { taskId: badId } = await n1.submit({ intent: 'root-cycle', to: { device: 'device-B', agent: 'echo' } });
  const { worker: w2 } = await makeWorker({ planner: selfCycle });
  const l2 = loop(w2);
  await n1.waitForDagCompletion(badId, { timeoutMs: 90000 });
  l2.stop();
  await l2.done;
  const bad = await n1.stateOf(badId);
  check('1d-a 负例：成环被拒（DAG_CYCLE）', bad?.status === 'failed' && /^DAG_CYCLE: /.test(bad.reason ?? ''), { reason: bad?.reason });

  // ---------------- 1d-b 协商 ----------------
  const negB = negotiationMessageStore(b);
  const n2 = node({ store: negotiationMessageStore(a), maxRounds: 3, policy: 'accept' });
  const { taskId: nid } = await n2.submit({ intent: 'nego:x', to: { device: 'device-B', agent: 'echo' } });
  const { worker: w3 } = await makeWorker({ negotiation: { store: negB, maxRounds: 3, enabled: (s) => s.intent.startsWith('nego:') } });
  const l3 = loop(w3);
  const okNeg = await n2.waitForTerminal([nid], { timeoutMs: 90000 });
  l3.stop();
  await l3.done;
  const negState = await n2.stateOf(nid);
  check('1d-b 协商：counter → accept → 完成', okNeg && negState?.status === 'done', {
    okNeg,
    status: negState?.status,
    reason: negState?.reason,
    bKinds: (await negB.all()).map((m) => `${m.kind}#${m.round}@${m.from.device}`),
    aKinds: (await negotiationMessageStore(a).all()).map((m) => `${m.kind}#${m.round}@${m.from.device}`),
  });

  const n3 = node({ store: negotiationMessageStore(a), maxRounds: 1, policy: 'counter' });
  const { taskId: oid } = await n3.submit({ intent: 'nego:over', to: { device: 'device-B', agent: 'echo' } });
  const { worker: w4 } = await makeWorker({ negotiation: { store: negB, maxRounds: 1, enabled: (s) => s.intent.startsWith('nego:') } });
  const l4 = loop(w4);
  await n3.waitForTerminal([oid], { timeoutMs: 90000 });
  l4.stop();
  await l4.done;
  check('1d-b 超限 → failed NEGOTIATION_LIMIT', (await n3.stateOf(oid))?.reason === 'NEGOTIATION_LIMIT: 2>1', { reason: (await n3.stateOf(oid))?.reason });

  // ---------------- 1d-c 闲聊 ----------------
  const chatterA = new FleetChatter({ device: 'device-A', quota: new LocalQuota({ limitPerDevice: 2, onOverflow: 'reject' }), store: chatterMessageStore(a) });
  const chatterB = new FleetChatter({ device: 'device-B', quota: new LocalQuota({ limitPerDevice: 2 }), store: chatterMessageStore(b) });
  const msg = (i) => ({ v: 1, messageId: `chat-${i}@device-A`, from: { device: 'device-A', agent: 'board' }, topic: 'status', text: `m${i}` });
  check('1d-c 配额内 accepted', (await chatterA.send(msg(1))) === 'accepted' && (await chatterA.send(msg(2))) === 'accepted', {});
  check('1d-c 超额 reject', (await chatterA.send(msg(3))) === 'rejected', {});
  const la = chatterA.ledger().find((l) => l.device === 'device-A');
  check('1d-c 账本守恒', la.used + la.queued + la.rejected === 3 && la.rejected === 1, la);
  const got = await waitFor(async () => (await chatterB.inbox()).length >= 2, 15000);
  check('1d-c 收件（libp2p 同步）幂等且为 2 条', got && (await chatterB.inbox()).length === 2, { size: (await chatterB.inbox()).length });
} catch (error) {
  check('verify:fleet:collab 未抛异常', false, { error: error?.message || String(error) });
} finally {
  try {
    if (a) await a.shutdown();
    if (b) await b.shutdown();
  } catch {
    // ignore
  }
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

const failed = results.filter((r) => !r.ok);
console.log('== 摘要 ==');
const summary = { total: results.length, passed: results.length - failed.length, failed: failed.map((f) => f.name), skipped };
console.log(JSON.stringify(summary, null, 2));
console.log(`FLEET_SUMMARY ${JSON.stringify(summary)}`);
process.exit(failed.length === 0 ? 0 : 1);
