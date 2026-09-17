#!/usr/bin/env node
// M4 目标一验收：真实 libp2p 上按 **agent 名字**路由到可插拔执行器。
//
// B 注册多个 agent 执行器（echo / fake / slow / fail / big），A 派活到**指定 agent 名**，
// 校验每类语义：成功结果 / 超时 / 非零退出 / 输出截断 / 未知 agent 显式失败。
// 默认用确定性 fake agent（CI 自洽）；`--with-hermes` 额外注册真实 Hermes agent 并派活。
//
// 前置：npm run build。

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Mebular } from '@mebular/core';
import {
  MebularTaskEventStore,
  NullTransport,
  FleetNode,
  FleetWorker,
  LocalQuota,
  EchoExecutor,
  ExecutionLog,
  ExecutorRegistry,
  CommandAgent,
  HermesAgent,
  echoResultFor,
} from '../packages/fleet/dist/index.js';

const FIXTURE = fileURLToPath(new URL('../tests/fleet/fixtures/fake-agent.mjs', import.meta.url));
const WITH_HERMES = process.argv.includes('--with-hermes');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn, timeoutMs, pollMs = 20) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(pollMs);
  }
  return fn();
}
const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
}

const dir = await mkdtemp(join(tmpdir(), 'fleet-agents-'));
const master = await Mebular.generateUserMasterKey();
const encryption = { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey };
const makeNode = (deviceId, policy) =>
  new Mebular({
    storagePath: join(dir, `${deviceId}.jsonl`),
    deviceId,
    encryption,
    network: { enabled: true, libp2p: { listen: ['/ip4/127.0.0.1/tcp/0'] } },
    sync: { autoSync: true, pushOnWrite: true, pushOnWriteThrottleMs: 20, namespaces: ['tasks'], peerNamespacePolicy: policy },
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
let worker;
try {
  console.log(`== M4 目标一：agent 路由（真实 libp2p loopback${WITH_HERMES ? ' + 真实 Hermes' : ''}） ==`);
  A = makeNode('device-A', { 'device-B': ['tasks'] });
  B = makeNode('device-B', { 'device-A': ['tasks'] });
  await A.initialize();
  await B.initialize();
  const addrA = A.node.getLocalMultiaddrs()[0];
  const synced = waitBothSynced(A, B);
  await B.node.connectToPeer(A.node.peerId, addrA);
  check('前置：A/B 初始同步完成', await synced);

  const registry = new ExecutorRegistry();
  registry.register('echo', new EchoExecutor());
  registry.register('fake', new CommandAgent({ command: process.execPath, baseArgs: [FIXTURE] }));
  registry.register('slow', new CommandAgent({ command: process.execPath, baseArgs: [FIXTURE, '--mode', 'sleep', '--sleep', '5000'], timeoutMs: 400 }));
  registry.register('fail', new CommandAgent({ command: process.execPath, baseArgs: [FIXTURE, '--mode', 'fail', '--exit', '3', '--stderr', 'agent-down'] }));
  registry.register('big', new CommandAgent({ command: process.execPath, baseArgs: [FIXTURE, '--mode', 'large', '--bytes', '100000'], maxOutputBytes: 1000 }));
  if (WITH_HERMES) registry.register('hermes', new HermesAgent({ timeoutMs: 180000, maxOutputBytes: 2000 }));

  const aStore = new MebularTaskEventStore(A);
  const bStore = new MebularTaskEventStore(B);
  const transport = new NullTransport();
  const node = new FleetNode({ device: 'device-A', store: aStore, transport, quota: new LocalQuota({ limitPerDevice: 1000 }) });
  const log = await ExecutionLog.open(join(dir, 'B.exec.jsonl'));
  worker = new FleetWorker({ device: 'device-B', agent: 'worker', store: bStore, transport, registry, log });

  const plan = [
    { agent: 'echo', expect: 'done', resultRef: echoResultFor('a-echo') },
    { agent: 'fake', expect: 'done', resultRef: 'FAKE:a-fake' },
    { agent: 'slow', expect: 'failed', reasonMatch: /^TIMEOUT/ },
    { agent: 'fail', expect: 'failed', reasonMatch: /EXIT_3/ },
    { agent: 'big', expect: 'done', resultRefMatch: /\[truncated \d+ bytes\]/ },
    { agent: 'nope', expect: 'failed', reasonMatch: /^UNKNOWN_AGENT: nope$/ },
  ];
  if (WITH_HERMES) plan.push({ agent: 'hermes', expect: 'done', resultRef: 'FLEET_HERMES_OK' });

  const ids = [];
  for (const p of plan) {
    const intent = `a-${p.agent}`;
    const { taskId } = await node.submit({ intent, to: { device: 'device-B', agent: p.agent } });
    ids.push({ taskId, ...p, intent });
  }

  const ok = await waitUntil(async () => {
    await worker.pollOnce();
    const states = await node.states();
    return ids.every((x) => states.find((s) => s.taskId === x.taskId)?.terminal);
  }, WITH_HERMES ? 200000 : 30000);
  check('全部任务到达终态', ok);

  const states = await node.states();
  const byId = new Map(states.map((s) => [s.taskId, s]));
  for (const x of ids) {
    const st = byId.get(x.taskId);
    if (x.expect === 'done') {
      const match = st?.status === 'done' && (x.resultRef !== undefined ? st.resultRef === x.resultRef : true) && (x.resultRefMatch ? x.resultRefMatch.test(st.resultRef ?? '') : true);
      check(`agent=${x.agent} → done 且结果正确`, match, { status: st?.status, resultRef: st?.resultRef });
    } else {
      const match = st?.status === 'failed' && !!x.reasonMatch?.test(st.reason ?? '');
      check(`agent=${x.agent} → failed 语义正确`, match, { status: st?.status, reason: st?.reason });
    }
  }
  check('未知 agent 不执行（exec log 不含 nope 任务）', log.all().every((e) => byId.get(e.taskId)?.to.agent !== 'nope'));
} finally {
  for (const m of [A, B]) {
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
console.log(JSON.stringify({ total: results.length, passed: results.length - failed.length, failed: failed.map((f) => f.name) }, null, 2));
process.exit(failed.length === 0 ? 0 : 1);
