#!/usr/bin/env node
// 双设备同步示例（可执行）
//
// 演示四件事：
//   1. 两台设备共享同一用户主密钥（设备证书互验的前提）；
//   2. 默认拒绝：双方显式授予对方 default 分区，同步才会发生；
//   3. 在线增量同步：A 写入 → B 自动收敛；
//   4. 离线可用：B 停机期间 A 继续写入，B 重启后自动补同步。
//
// 前置：先构建（npm run build）。
// 运行：node examples/two-devices/index.mjs

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Mebular } from '../../dist/index.js';
import { InMemoryHub } from '../../dist/p2p/transport/InMemoryTransport.js';

const dir = await mkdtemp(join(tmpdir(), 'mebular-two-devices-'));
const hub = new InMemoryHub();
const master = await Mebular.generateUserMasterKey();

const makeDevice = (deviceId, peerDeviceId) =>
  new Mebular({
    storagePath: join(dir, `${deviceId}.jsonl`),
    deviceId,
    encryption: { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey },
    network: { enabled: true, provider: hub },
    // 默认拒绝：必须显式授权对端，否则提供端裁剪链解析为空、什么都不发
    sync: { autoSync: true, peerNamespacePolicy: { [peerDeviceId]: ['default'] } },
  });

async function waitForNode(app, nodeId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await app.graph.getNode(nodeId)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

let a = makeDevice('device-A', 'device-B');
let b = makeDevice('device-B', 'device-A');
await a.initialize();

// 1. 在线同步：B 加入前 A 先写入，B 上线握手时自动同步（autoSync）
const online = await a.graph.createNode('fact', { text: 'A 在线写入' });
await b.initialize();
await b.node.connectToPeer(a.node.peerId);
if (!(await waitForNode(b, online.id))) throw new Error('在线同步未收敛');
console.log('✓ 在线同步：B 已收到 A 的写入');

// 2. B 离线，A 继续写
await b.shutdown();
const offline = await a.graph.createNode('fact', { text: 'A 在 B 离线期间写入' });
console.log('· B 已停机；A 在离线期间写入一条记忆');

// 3. B 重启（同一存储与身份），重连后自动补同步
b = makeDevice('device-B', 'device-A');
await b.initialize();
await b.node.connectToPeer(a.node.peerId);
if (!(await waitForNode(b, offline.id))) throw new Error('重连后未补同步离线期间的写入');
console.log('✓ 重连补同步：B 重启后拿到离线期间的写入');

const nodes = await b.graph.listNodes({ type: 'fact' });
console.log(`B 当前共 ${nodes.length} 条 fact：`);
for (const node of nodes) {
  console.log(`  - [${node.namespace ?? 'default'}] ${node.content.text}`);
}

await a.shutdown();
await b.shutdown();
await rm(dir, { recursive: true, force: true });
