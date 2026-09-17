#!/usr/bin/env node
// 实时同步示例（可执行）：写入即推（含反向 nudge）
//
// 库/嵌入式形态默认**关闭**推送与兜底（连接 ≠ 持续同步）；本示例显式开启
// `pushOnWrite`，并演示修正后的双向实时性：
//   A 是发起方：A 写入后直接起一轮定向会话 → B 亚秒级可见；
//   B 是响应方：B 写入后在既有信道上发一个无载荷 `sync-nudge`，请 A 立刻起一轮 → A 亚秒级可见。
// 另附周期 anti-entropy 配置（默认 10 分钟 ±20%；此处缩到 1s 便于观察兜底触发）。
//
// 前置：先构建（npm run build）。
// 运行：node examples/realtime/index.mjs

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Mebular } from '../../dist/index.js';
import { InMemoryHub } from '../../dist/p2p/transport/InMemoryTransport.js';

const dir = await mkdtemp(join(tmpdir(), 'mebular-realtime-'));
const hub = new InMemoryHub();
const master = await Mebular.generateUserMasterKey();

const makeDevice = (deviceId, peerDeviceId) =>
  new Mebular({
    storagePath: join(dir, `${deviceId}.jsonl`),
    deviceId,
    encryption: { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey },
    network: { enabled: true, provider: hub },
    sync: {
      autoSync: true,
      peerNamespacePolicy: { [peerDeviceId]: ['default'] },
      pushOnWrite: true, // 库形态默认关；常驻（serve/MCP）默认开
      antiEntropy: { enabled: true, intervalMs: 1000, jitterRatio: 0 }, // 演示用短间隔
    },
  });

const a = makeDevice('device-A', 'device-B');
const b = makeDevice('device-B', 'device-A');
await a.initialize();
await b.initialize();

function waitForSync(app, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const onSync = (result) => {
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      app.sync.removeListener('sync-completed', onSync);
      reject(new Error('同步超时'));
    }, timeoutMs);
    app.sync.once('sync-completed', onSync);
  });
}

async function waitForNode(app, nodeId, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await app.graph.getNode(nodeId)) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

try {
  // 首次握手完成一次收敛（此后靠写入即推，不需重连/手动同步）
  const first = waitForSync(a);
  await b.node.connectToPeer(a.node.peerId);
  await first;

  // 1. 发起方写入：A → B（直接起定向会话）
  let started = Date.now();
  const fromA = await a.graph.createNode('fact', { name: 'A 写入（push）' });
  if (!(await waitForNode(b, fromA.id))) throw new Error('A→B 写入即推未生效');
  console.log(`✓ A 写入 → B 可见：${Date.now() - started}ms`);

  // 2. 响应方写入：B 发 nudge → A 起会话（双向实时，不再受字典序限制）
  started = Date.now();
  const fromB = await b.graph.createNode('fact', { name: 'B 写入（nudge）' });
  if (!(await waitForNode(a, fromB.id))) throw new Error('B→A nudge 未生效');
  console.log(`✓ B 写入 → A 可见：${Date.now() - started}ms`);

  console.log('\n说明：anti-entropy（1s 间隔）作为长连兜底——即使推送被跳过（会话中/离线重连），');
  console.log('      仍会在下一轮周期同步中收敛；库默认关，常驻入口默认开。');
} finally {
  await a.shutdown();
  await b.shutdown();
  await rm(dir, { recursive: true, force: true });
}
