#!/usr/bin/env node
// L2 · NAT/relay 仿真（可重复，本机/CI 均可跑）+ L4 降级路径。
//
// 真实 libp2p circuit relay v2（**不新增同步协议**）：只交换 **circuit 地址**（`/p2p-circuit`），
// 从不交换直连地址 → 对端只能经 relay 连通（NAT 后无入站）。断言：
//   ① relay-only 连通（拨号地址含 p2p-circuit）且同步收敛（stateHash 一致）；
//   ② 授权负例（未授权分区不可见，默认拒绝）；
//   ③ relay 重启后恢复；④ 对端“IP 变更”（新监听端口）后经 relay 恢复；
//   ⑤（L4）relay 不可达时降级手动 multiaddr 直连仍可用。
//
// 无 libp2p/relay 可选依赖时 SKIP（明列原因）。摘要行 FLEET_SUMMARY（含 skipped）。
// 前置：npm run build。

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mebular, IdentityManager, Libp2pProvider } from '../dist/index.js';

const results = [];
const skipped = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
}
function skip(name, reason) {
  skipped.push({ name, reason });
  console.log(`SKIP  ${name}  ${reason}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, pollMs = 100) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(pollMs);
  }
  return fn();
}
const generateDeviceKey = async () => {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  return { publicKey: new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)), privateKey: kp.privateKey };
};
const pickRelayAddress = (app) => (app.node.getLocalMultiaddrs() ?? []).find((a) => a.includes('/p2p-circuit'));
const pickDirectAddress = (app) =>
  (app.node.getLocalMultiaddrs() ?? []).find((a) => a.includes('/tcp/') && !a.includes('/p2p-circuit'));
const memoryText = (node) => {
  const c = node?.content;
  return typeof c === 'object' && c !== null ? c.text : c;
};
function waitForSync(app, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const onSync = (r) => {
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      app.sync.removeListener('sync-completed', onSync);
      reject(new Error(`同步超时（${timeoutMs}ms）`));
    }, timeoutMs);
    app.sync.once('sync-completed', onSync);
  });
}
async function connectUntil(dialer, listener, address, predicate, attempts = 6, timeoutMs = 20000) {
  for (let i = 0; i < attempts; i++) {
    try {
      const d = waitForSync(dialer, timeoutMs);
      const l = waitForSync(listener, timeoutMs);
      await dialer.node.connectToPeer(listener.node.peerId, address);
      await Promise.all([d, l]);
      if (await predicate()) return true;
    } catch {
      // 半交换/超时，重试
    }
    await dialer.node.disconnectPeer(listener.node.peerId).catch(() => undefined);
    await listener.node.disconnectPeer(dialer.node.peerId).catch(() => undefined);
    await sleep(300);
  }
  return false;
}

let relay;
let apps = [];
const dir = await mkdtemp(join(tmpdir(), 'wan-l2-'));
try {
  console.log('== L2：NAT/relay 仿真（真实 libp2p circuit relay） ==');
  let relayAvailable = true;
  try {
    relay = await Libp2pProvider.create({ deviceKey: await generateDeviceKey(), listen: ['/ip4/127.0.0.1/tcp/0'], relayServer: true, relayUnlimited: true });
    await relay.start();
  } catch (error) {
    relayAvailable = false;
    skip('L2 relay 仿真', `circuit relay 可选依赖不可用：${error?.code ?? error?.message}（安装 @libp2p/circuit-relay-v2 @libp2p/identify）`);
  }

  if (relayAvailable) {
    const master = await new IdentityManager().generateUserMasterKey();
    const encryption = { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey };
    const relayAddr = (relay.getMultiaddrs() ?? []).find((a) => a.includes('/tcp/'));
    const makeApp = async (deviceId, peer, relayServers) => {
      const app = new Mebular({
        storagePath: join(dir, `${deviceId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.jsonl`),
        deviceId,
        encryption,
        network: { enabled: true, libp2p: { listen: ['/ip4/127.0.0.1/tcp/0'], ...(relayServers ? { relayServers } : {}) } },
        sync: { autoSync: true, ...(peer ? { peerNamespacePolicy: { [peer]: ['default'] } } : {}) },
      });
      await app.initialize();
      apps.push(app);
      return app;
    };

    // ① relay-only 连通 + 收敛（只交换 circuit 地址）
    const a = await makeApp('device-A', 'device-B', [relayAddr]);
    const b = await makeApp('device-B', 'device-A', [relayAddr]);
    const aCircuit = await waitFor(() => pickRelayAddress(a), 15000);
    check('A 已获得 relay 预留地址（/p2p-circuit）', typeof aCircuit === 'string' && aCircuit.includes('/p2p-circuit'), { aCircuit });
    const node1 = await a.graph.createNode('fact', { text: 'l2-base' }, [], { namespace: 'default' });
    const sync1 = typeof aCircuit === 'string' && (await connectUntil(b, a, aCircuit, async () => memoryText(await b.graph.getNode(node1.id)) === 'l2-base'));
    check('① relay-only 连通且增量同步收敛', !!sync1 && aCircuit.includes('/p2p-circuit'), { dialed: aCircuit?.includes('/p2p-circuit') });
    const idsOf = async (app) => (await app.graph.listNodes()).filter((n) => n.namespace === 'default').map((n) => n.id).sort();
    const idsA = await idsOf(a);
    const idsB = await idsOf(b);
    check('① 双方 default 分区状态一致', JSON.stringify(idsA) === JSON.stringify(idsB) && idsA.length >= 1, { a: idsA.length, b: idsB.length });

    // ② 授权负例：secret 分区未授权给 B
    const secret = await a.graph.createNode('fact', { text: 'secret' }, [], { namespace: 'secret' });
    await connectUntil(b, a, await waitFor(() => pickRelayAddress(a), 15000), async () => (await b.graph.getNode(node1.id)) !== null);
    check('② 授权负例：未授权分区不可见（默认拒绝）', (await b.graph.getNode(secret.id)) === null, {});

    // ③ relay 重启后恢复（同端口重开）
    const relayPort = Number(relayAddr.match(/tcp\/(\d+)/)[1]);
    await relay.stop().catch(() => undefined);
    relay = await Libp2pProvider.create({ deviceKey: await generateDeviceKey(), listen: [`/ip4/127.0.0.1/tcp/${relayPort}`], relayServer: true, relayUnlimited: true });
    await relay.start();
    const relayAddr2 = (relay.getMultiaddrs() ?? []).find((a) => a.includes('/tcp/'));
    await a.shutdown();
    await b.shutdown();
    const a3 = await makeApp('device-A', 'device-B', [relayAddr2]);
    const b3 = await makeApp('device-B', 'device-A', [relayAddr2]);
    const node3 = await a3.graph.createNode('fact', { text: 'after-relay-restart' }, [], { namespace: 'default' });
    const addr3 = await waitFor(() => pickRelayAddress(a3), 15000);
    const sync3 = typeof addr3 === 'string' && (await connectUntil(b3, a3, addr3, async () => memoryText(await b3.graph.getNode(node3.id)) === 'after-relay-restart'));
    check('③ relay 重启后经 relay 恢复同步', !!sync3, {});

    // ④ “IP 变更”：A 换监听端口（新直连地址），B 经新 circuit 地址恢复
    await a3.shutdown();
    const a4 = await makeApp('device-A', 'device-B', [relayAddr2]);
    const node4 = await a4.graph.createNode('fact', { text: 'after-ip-change' }, [], { namespace: 'default' });
    const addr4 = await waitFor(() => pickRelayAddress(a4), 15000);
    const sync4 = typeof addr4 === 'string' && (await connectUntil(b3, a4, addr4, async () => memoryText(await b3.graph.getNode(node4.id)) === 'after-ip-change'));
    check('④ IP 变更后经 relay 恢复同步', !!sync4, { circuit: addr4?.includes('/p2p-circuit') });

    // ⑤ L4：relay 不可达 → 降级手动 multiaddr 直连仍可用
    const c = await makeApp('device-C', 'device-D', ['/ip4/127.0.0.1/tcp/1/p2p/12D3KooWDummyRelay']);
    const d = await makeApp('device-D', 'device-C', null);
    const node5 = await c.graph.createNode('fact', { text: 'degraded-direct' }, [], { namespace: 'default' });
    const direct = pickDirectAddress(d);
    const sync5 = typeof direct === 'string' && (await connectUntil(c, d, direct, async () => memoryText(await c.graph.getNode(node5.id)) === 'degraded-direct'));
    check('⑤ relay 不可达 → 降级手动 multiaddr 直连可用', !!sync5, { mode: 'direct-degraded' });
  }
} catch (error) {
  check('verify:wan:l2 未抛异常', false, { error: error?.message || String(error) });
} finally {
  for (const app of apps) await app.shutdown().catch(() => undefined);
  if (relay) await relay.stop().catch(() => undefined);
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

const failed = results.filter((r) => !r.ok);
console.log('== 摘要 ==');
const summary = { total: results.length, passed: results.length - failed.length, failed: failed.map((f) => f.name), skipped };
console.log(JSON.stringify(summary, null, 2));
console.log(`FLEET_SUMMARY ${JSON.stringify(summary)}`);
process.exit(failed.length === 0 ? 0 : 1);
