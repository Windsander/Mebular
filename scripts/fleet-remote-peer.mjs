#!/usr/bin/env node
// Fleet 跨机 peer（M3）：真实 libp2p 传输；任务经**记忆同步**传递。供双机 runbook 使用。
//
// 角色：
//   keygen  生成用户主密钥文件（两台机器共用同一把，才能互信设备证书）
//   node    任务板/发起端：监听、可选拨号、提交 N 个任务、等待全部终态
//   worker  执行端：拨号到 node、订阅 tasks 分区、拾取并执行、回写状态/结果
//
// 前置：npm run build（依赖 @mebular/core 与 packages/fleet/dist）。

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
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
} from '../packages/fleet/dist/index.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const k = t.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[k] = true;
      else {
        args[k] = next;
        i++;
      }
    }
  }
  return args;
}
const str = (v, d) => (typeof v === 'string' ? v : d);
const num = (v, d) => (typeof v === 'string' && Number.isFinite(Number(v)) ? Number(v) : d);

async function keygen(args) {
  const out = str(args.out, 'fleet-key.json');
  const master = await Mebular.generateUserMasterKey();
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', master.privateKey));
  await mkdir(dirname(out), { recursive: true });
  await writeFile(
    out,
    JSON.stringify({ v: 1, alg: 'Ed25519', publicKey: Buffer.from(master.publicKey).toString('base64'), privateKeyPkcs8: Buffer.from(pkcs8).toString('base64') }),
    'utf-8',
  );
  console.log(JSON.stringify({ role: 'keygen', out }, null, 2));
}

async function loadKey(path) {
  const j = JSON.parse(await readFile(path, 'utf-8'));
  const publicKey = new Uint8Array(Buffer.from(j.publicKey, 'base64'));
  const privateKey = await crypto.subtle.importKey('pkcs8', Buffer.from(j.privateKeyPkcs8, 'base64'), { name: 'Ed25519' }, true, ['sign']);
  return { userMasterKey: publicKey, userMasterPrivateKey: privateKey };
}

function makeMebular(args, encryption) {
  const deviceId = str(args.device, 'device-A');
  const authorize = str(args.authorize, deviceId === 'device-A' ? 'device-B' : 'device-A');
  const listen = str(args.listen, '/ip4/0.0.0.0/tcp/0');
  const storage = str(args.storage, `./.fleet/${deviceId}.jsonl`);
  return new Mebular({
    storagePath: storage,
    deviceId,
    encryption,
    network: { enabled: true, libp2p: { listen: [listen] } },
    sync: { autoSync: true, pushOnWrite: true, pushOnWriteThrottleMs: 20, namespaces: ['tasks'], peerNamespacePolicy: { [authorize]: ['tasks'] } },
  });
}

async function waitSynced(mebular, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolve(true);
      }
    };
    mebular.sync.once('sync-completed', done);
    setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    }, timeoutMs);
  });
}

async function runNode(args) {
  const encryption = await loadKey(str(args.key, 'fleet-key.json'));
  const deviceId = str(args.device, 'device-A');
  const mebular = makeMebular(args, encryption);
  await mebular.initialize();
  const multiaddr = mebular.node.getLocalMultiaddrs()[0];
  const peerId = mebular.node.peerId.id;
  console.log(JSON.stringify({ role: 'node', event: 'listening', deviceId, multiaddr, peerId }, null, 2));
  if (typeof args.peer === 'string') await mebular.node.connectToPeer( mebular.node.peerId, args.peer);
  await waitSynced(mebular, num(args['sync-timeout-ms'], 20000));

  const store = new MebularTaskEventStore(mebular);
  const node = new FleetNode({ device: deviceId, store, transport: new NullTransport(), quota: new LocalQuota({ limitPerDevice: num(args['quota-limit'], 1000000), onOverflow: 'queue' }) });
  const n = num(args.submit, 0);
  const ids = [];
  const decisions = { accepted: 0, queued: 0, rejected: 0 };
  for (let i = 0; i < n; i++) {
    const { taskId, decision } = await node.submit({ intent: `remote-${i}`, to: { device: str(args['target-device'], 'device-B'), agent: str(args['target-agent'], '*') } });
    decisions[decision] += 1;
    if (taskId) ids.push(taskId);
  }
  const timeoutMs = num(args['timeout-ms'], 60000);
  const deadline = Date.now() + timeoutMs;
  let states = [];
  while (Date.now() < deadline) {
    states = await node.states();
    if (states.length === ids.length && states.every((s) => s.terminal)) break;
    await sleep(30);
  }
  const byId = new Map(states.map((s) => [s.taskId, s]));
  const done = states.filter((s) => s.status === 'done');
  const resultsMatch = ids.every((id) => byId.get(id)?.status === 'done' && byId.get(id).resultRef === echoResultFor(byId.get(id).intent));
  console.log(JSON.stringify({ role: 'node', submitted: ids.length, decisions, done: done.length, resultsMatch }, null, 2));
  await mebular.shutdown();
  process.exit(done.length === ids.length && resultsMatch ? 0 : 1);
}

async function runWorker(args) {
  const encryption = await loadKey(str(args.key, 'fleet-key.json'));
  const deviceId = str(args.device, 'device-B');
  const agent = str(args.agent, 'echo');
  const storage = str(args.storage, `./.fleet/${deviceId}.jsonl`);
  const mebular = makeMebular(args, encryption);
  await mebular.initialize();
  if (typeof args.peer === 'string') {
    if (typeof args['peer-id'] !== 'string') {
      console.error('worker 需要 --peer-id <nodePeerId> 与 --peer <multiaddr>。');
      process.exit(2);
    }
    await mebular.node.connectToPeer(
      { id: args['peer-id'], multihash: new Uint8Array(), pubKey: new Uint8Array() },
      args.peer,
    );
  }
  await waitSynced(mebular, num(args['sync-timeout-ms'], 20000));

  const store = new MebularTaskEventStore(mebular);
  const log = await ExecutionLog.open(str(args['exec-log'], `${storage}.exec.jsonl`));
  const worker = new FleetWorker({ device: deviceId, agent, store, transport: new NullTransport(), executor: new EchoExecutor(), log });
  await worker.reconcile();
  const timeoutMs = num(args['timeout-ms'], 60000);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await worker.pollOnce();
    await sleep(num(args['interval-ms'], 10));
  }
  console.log(JSON.stringify({ role: 'worker', deviceId, agent, executed: log.size(), taskIds: log.all().map((e) => e.taskId) }, null, 2));
  await mebular.shutdown();
  process.exit(0);
}

const args = parseArgs(process.argv.slice(2));
const role = str(args.role, '');
if (role === 'keygen') await keygen(args);
else if (role === 'node') await runNode(args);
else if (role === 'worker') await runWorker(args);
else {
  console.error('用法：node scripts/fleet-remote-peer.mjs --role keygen|node|worker …');
  process.exit(2);
}
