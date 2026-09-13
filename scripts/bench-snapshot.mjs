#!/usr/bin/env node
// G4 初始同步基准：全量事件重放 vs 物化快照（KR「初始同步在大图下不全量重放，有基准数字」）
//
// 用法：npm run bench:snapshot
//       N=5000 node scripts/bench-snapshot.mjs
//
// 前置：npm run build。默认在内存 hub 上跑，不依赖真实网络。

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

const mebular = await import(join(rootDir, 'dist', 'index.js'));
const { Mebular, IdentityManager, InMemoryHub } = mebular;

const N = Number(process.env.N ?? 2000);
const dir = await mkdtemp(join(tmpdir(), 'mebular-bench-'));
const hub = new InMemoryHub();
const master = await new IdentityManager().generateUserMasterKey();
const masterKeys = { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey };

const make = (deviceId, extra = {}) =>
  new Mebular({
    storagePath: join(dir, `${deviceId}.jsonl`),
    deviceId,
    encryption: masterKeys,
    network: { enabled: true, provider: hub },
    sync: { autoSync: true, ...extra },
  });

const waitSync = (app, timeoutMs = 60000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('sync timeout')), timeoutMs);
    app.sync.once('sync-completed', (r) => {
      clearTimeout(timer);
      resolve(r);
    });
  });

const syncTo = async (from, to) => {
  const p = waitSync(to);
  const q = waitSync(from);
  await to.node.connectToPeer(from.node.peerId);
  const [fromResult, toResult] = await Promise.all([q, p]);
  return { fromResult, toResult };
};

console.log(`G4 初始同步基准（N=${N}，in-memory hub）`);
console.log('====================================');

const seed = async (app) => {
  const start = Date.now();
  for (let i = 0; i < N; i++) {
    await app.graph.createNode('fact', { text: `memory-${i}` });
  }
  return Date.now() - start;
};

try {
  // 路径 1：全量事件重放（发起方无阈值；device-M < device-N 故 M 发起并发送）
  const senderFull = make('device-M');
  await senderFull.initialize();
  const seedMs = await seed(senderFull);
  const events = await senderFull.eventLog.listEvents();
  const eventBytes = JSON.stringify(events).length;

  const receiverFull = make('device-N');
  await receiverFull.initialize();
  const tFull = Date.now();
  const fullRun = await syncTo(senderFull, receiverFull);
  const fullMs = Date.now() - tFull;
  const fullPeerReceived = fullRun.toResult.receivedEvents;

  // 路径 2：物化快照（发起方阈值 50；device-A < device-Z 故 A 发起并发送快照）
  const senderSnap = make('device-A', { snapshotThreshold: 50 });
  await senderSnap.initialize();
  await seed(senderSnap);
  const nodes = await senderSnap.graph.listNodes();
  const snapshotBytes = JSON.stringify({
    nodes,
    edges: [],
    clock: senderSnap.sync.getLocalVectorClock().toJSON(),
  }).length;

  const receiverSnap = make('device-Z');
  await receiverSnap.initialize();
  const tSnap = Date.now();
  const snapRun = await syncTo(senderSnap, receiverSnap);
  const snapResult = snapRun.fromResult;
  const snapMs = Date.now() - tSnap;

  const format = (n) => n.toLocaleString('en-US');
  const byteReduction = eventBytes > 0 ? 1 - snapshotBytes / eventBytes : 0;
  const ok = fullPeerReceived >= N && snapResult.snapshotSent >= N && snapResult.sentEvents === 0;

  console.log(`写入 ${N} 节点 / ${events.length} 事件，用时 ${seedMs}ms`);
  console.log(`事件流字节 ≈ ${format(eventBytes)}；快照字节 ≈ ${format(snapshotBytes)}（减少 ${(byteReduction * 100).toFixed(1)}%）`);
  console.log(`全量重放：对端收事件 ${fullPeerReceived}，用时 ${fullMs}ms`);
  console.log(`物化快照：发实体 ${snapResult.snapshotSent}，发事件 ${snapResult.sentEvents}，用时 ${snapMs}ms`);
  console.log(`快照/重放 用时比 ≈ ${(snapMs / Math.max(fullMs, 1)).toFixed(2)}`);
  console.log('结果：' + (ok ? '✓ 快照路径成立' : '✗ 不符合预期'));

  await senderFull.shutdown();
  await receiverFull.shutdown();
  await senderSnap.shutdown();
  await receiverSnap.shutdown();
  process.exit(ok ? 0 : 1);
} catch (error) {
  console.log('✗ 基准异常：', String(error?.stack ?? error).substring(0, 600));
  process.exit(1);
} finally {
  await rm(dir, { recursive: true, force: true });
}
