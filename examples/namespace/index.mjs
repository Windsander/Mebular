#!/usr/bin/env node
// 记忆分区（namespace）与默认拒绝授权示例（可执行）
//
// 演示：
//   1. A 只授权 B 接收 default 分区 → B 拿不到 private 分区的记忆；
//   2. 扩权回补：把 private 加进授权后，A 重启（水位从磁盘恢复），
//      B 自动拿到此前被跳过 private 的历史事件——不会永久缺失。
//
// 前置：先构建（npm run build）。
// 运行：node examples/namespace/index.mjs

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Mebular } from '../../dist/index.js';
import { InMemoryHub } from '../../dist/p2p/transport/InMemoryTransport.js';

const dir = await mkdtemp(join(tmpdir(), 'mebular-namespace-'));
const hub = new InMemoryHub();
const master = await Mebular.generateUserMasterKey();

// A 是数据持有者；这里按需改它对 B 的授权分区
const makeA = (authorizedNamespaces) =>
  new Mebular({
    storagePath: join(dir, 'device-A.jsonl'),
    deviceId: 'device-A',
    encryption: { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey },
    network: { enabled: true, provider: hub },
    sync: { autoSync: true, peerNamespacePolicy: { 'device-B': authorizedNamespaces } },
  });

const makeB = () =>
  new Mebular({
    storagePath: join(dir, 'device-B.jsonl'),
    deviceId: 'device-B',
    encryption: { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey },
    network: { enabled: true, provider: hub },
    sync: { autoSync: true, peerNamespacePolicy: { 'device-A': ['default'] } },
  });

async function waitForNode(app, nodeId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await app.graph.getNode(nodeId)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

let a = makeA(['default']);
let b = makeB();
await a.initialize();

// 1. 写入两条：一条 default，一条 private；B 上线时自动同步
const shared = await a.graph.createNode('fact', { text: '团队共享的记忆' });
const secret = await a.graph.createNode('fact', { text: '私有分区的记忆' }, undefined, {
  namespace: 'private',
});

await b.initialize();
await b.node.connectToPeer(a.node.peerId);
if (!(await waitForNode(b, shared.id))) throw new Error('default 分区未同步');
console.log('✓ default 分区已同步到 B');

// 给私有事件的发送留出窗口，再断言 B 侧不存在
await new Promise((r) => setTimeout(r, 500));
if (await b.graph.getNode(secret.id)) throw new Error('未授权分区竟然泄漏到了 B');
console.log('✓ private 分区被拒绝：B 侧不存在该记忆（默认拒绝生效）');

// 2. 扩权回补：A 授权 private 并重启（水位落盘，重启后按正确水位续传）。
//    存活侧（B）先断开旧连接——已知重连缺陷 F4（见 docs.design/local-verify-namespace-2026-09-16.md）。
await a.shutdown();
a = makeA(['default', 'private']);
await a.initialize();
await b.node.disconnectPeer(a.node.peerId);
await b.node.connectToPeer(a.node.peerId);

if (!(await waitForNode(b, secret.id))) throw new Error('扩权后历史事件未回补');
console.log('✓ 扩权回补：private 历史事件补发成功，B 现在拿到了它');

const nodes = await b.graph.listNodes({ type: 'fact' });
console.log(`B 当前可见 ${nodes.length} 条 fact：`);
for (const node of nodes) {
  console.log(`  - [${node.namespace ?? 'default'}] ${node.content.text}`);
}

await a.shutdown();
await b.shutdown();
await rm(dir, { recursive: true, force: true });
