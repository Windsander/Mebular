#!/usr/bin/env node
// 授权即记忆（grant-as-memory）示例（可执行）
//
// 演示图上的授权生命周期，全部由签名事件驱动、无中心服务：
//   1. 默认拒绝：A 持有数据，B 未获授权 → 同步后 B 拿不到任何分区；
//   2. 授予：A `grantNamespaces` → B 收到授权事件并**补发历史**（扩权回补）；
//   3. 撤销：A `revokeGrant(grantId)` → A 的新写入不再发给 B（域收缩，不回撤已入图数据）；
//   4. 恢复：用**全新 grantId** 再授予 → B 补发拿到撤销期间的写入（R-d：恢复须用新 id）。
//
// 前置：先构建（npm run build）。
// 运行：node examples/authorization/index.mjs

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Mebular } from '../../dist/index.js';
import { InMemoryHub } from '../../dist/p2p/transport/InMemoryTransport.js';

const dir = await mkdtemp(join(tmpdir(), 'mebular-authorization-'));
const hub = new InMemoryHub();
const master = await Mebular.generateUserMasterKey();

// A 为引导签发者：可为任意分区签发授权（policyIssuers 各端保持一致）。
// 不配置 sync.peerNamespacePolicy：授权完全来自图上的 grant/revoke 事件（默认拒绝）。
const makeDevice = (deviceId) =>
  new Mebular({
    storagePath: join(dir, `${deviceId}.jsonl`),
    deviceId,
    encryption: { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey },
    network: { enabled: true, provider: hub },
    sync: {
      autoSync: true,
      policyIssuers: ['device-A'],
    },
  });

const a = makeDevice('device-A');
const b = makeDevice('device-B');
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

/** 重新握手触发一轮同步（autoSync 每连接一次），等待 A 侧会话完成 */
async function resync() {
  const done = waitForSync(a);
  await a.node.disconnectPeer(b.node.peerId).catch(() => undefined);
  await b.node.connectToPeer(a.node.peerId);
  await done;
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

try {
  // 1. 默认拒绝：B 未获授权
  const shared1 = await a.graph.createNode('fact', { name: 'shared-1' });
  const first = waitForSync(a);
  await b.node.connectToPeer(a.node.peerId);
  await first;
  console.log('✓ 首次同步完成');
  console.log('  A 对 B 的有效授权 =', await a.getEffectiveNamespaces('device-B'));
  console.log('  B 是否拿到 shared-1 =', Boolean(await b.graph.getNode(shared1.id)), '（默认拒绝 → 应为 false）');

  // 2. 授予 default：历史补发
  const grantEvent = await a.grantNamespaces({ subject: 'device-B', namespaces: ['default'], note: 'demo' });
  const grantId = grantEvent.data.grant.grantId;
  await resync();
  const got1 = await waitFor(() => b.graph.getNode(shared1.id).then(Boolean));
  console.log('✓ 授予后：B 补发拿到 shared-1 =', got1);
  console.log('  A 对 B 的有效授权 =', await a.getEffectiveNamespaces('device-B'));

  // 3. 撤销该 grant：新写入不再发送（已入图数据不回撤）
  const shared2 = await a.graph.createNode('fact', { name: 'shared-2' });
  await a.revokeGrant({ grantId, subject: 'device-B', note: 'demo revoke' });
  await resync();
  console.log('✓ 撤销后：A 对 B 的有效授权 =', await a.getEffectiveNamespaces('device-B'));
  console.log('  B 是否拿到撤销后的 shared-2 =', Boolean(await b.graph.getNode(shared2.id)), '（应为 false）');
  console.log('  B 是否仍持有已入图的 shared-1 =', Boolean(await b.graph.getNode(shared1.id)), '（撤销不回撤历史）');

  // 4. 恢复：必须使用全新 grantId
  await a.grantNamespaces({ subject: 'device-B', namespaces: ['default'], note: 'recovery' });
  await resync();
  const got2 = await waitFor(() => b.graph.getNode(shared2.id).then(Boolean));
  console.log('✓ 重新授予（新 grantId）：B 补发拿到 shared-2 =', got2);

  console.log('\n审计：被吊销设备 =', await a.getRevokedDevices(), '（本示例未做设备吊销）');
  const nodes = await b.graph.listNodes();
  console.log(`B 当前可见 ${nodes.length} 条记忆：${nodes.map((n) => n.content?.name ?? n.id).join(', ')}`);
} finally {
  await a.shutdown();
  await b.shutdown();
  await rm(dir, { recursive: true, force: true });
}
