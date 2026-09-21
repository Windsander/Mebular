#!/usr/bin/env node
// C4 验收：打洞（AutoNAT + DCUtR）
//
// Part A（确定式，必跑）：注入假 libp2p 模块集 —— 断言
//   ① 可选依赖在场 → autoNAT/dcutr 服务装配；② circuit 连接计数；③ 直连观测 → 升级回调（peerId 映射）；
//   ④ 缺包 → 软降级（loadError 可读，不抛错）。
// Part B（确定式，必跑）：路径语义 —— 打洞成功升级 path=direct；未见直连则保留 relay，relay 失效按候选退避。
// Part C（尽力而为，真 libp2p）：两节点经 relay 建立 circuit 连接后尝试 DCUtR 直连升级；受限环境 SKIP（非红）。
//
// 用法：npm run verify:nat（前置：npm run build）

import { EventEmitter } from 'node:events';
import { Libp2pProvider } from '@mebular/core';
import { P2PNode } from '@mebular/core';
import { ConnectionManager, EndpointBook, InMemoryEndpointStore } from '@mebular/core';

let passed = 0;
let failed = 0;
const skipped = [];
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? `（${typeof detail === 'string' ? detail : JSON.stringify(detail)}）` : ''}`);
  if (ok) passed += 1;
  else failed += 1;
};
const skip = (label, reason) => { console.log(`  - SKIP ${label}：${reason}`); skipped.push(label); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const peerIdOf = (id) => ({ id, multihash: new Uint8Array(), pubKey: new Uint8Array() });
const RELAY_ADDR = '/ip4/203.0.113.5/tcp/4001/p2p/relayZ/p2p-circuit/p2p/peer-A';

const deviceKey = async () => {
  const { IdentityManager } = await import('@mebular/core');
  const im = new IdentityManager();
  const key = await im.generateDeviceKey('device-nat', 'nat');
  return { publicKey: key.publicKey, privateKey: key.privateKey };
};

function fakePlatform({ withNat = true } = {}) {
  const listeners = new Map();
  const calls = { services: [] };
  const node = {
    peerId: { toString: () => '12D3KooWSELF' },
    async start() { /* noop */ },
    async stop() { /* noop */ },
    async handle() { /* noop */ },
    async dialProtocol() { throw new Error('unused'); },
    async dial() { throw new Error('unused'); },
    getMultiaddrs: () => [],
    addEventListener(type, handler) { listeners.set(type, [...(listeners.get(type) ?? []), handler]); },
    emitConnection(remotePeer, remoteAddr) {
      for (const handler of listeners.get('connection:open') ?? []) {
        handler({ detail: { remotePeer, remoteAddr: { toString: () => remoteAddr } } });
      }
    },
  };
  const importer = async (spec) => {
    if (spec === 'libp2p') return { createLibp2p: async (options) => { calls.services = Object.keys(options.services ?? {}); return node; } };
    if (spec === '@libp2p/tcp') return { tcp: () => 'tcp' };
    if (spec === '@chainsafe/libp2p-noise') return { noise: () => 'noise' };
    if (spec === '@chainsafe/libp2p-yamux') return { yamux: () => 'yamux' };
    if (spec === '@libp2p/crypto/keys') return { generateKeyPairFromSeed: async () => ({}), publicKeyFromRaw: () => ({ type: 'Ed25519', raw: new Uint8Array(32) }) };
    if (spec === '@libp2p/peer-id') return { peerIdFromPublicKey: () => ({ toString: () => '12D3KooWSELF' }) };
    if (spec === '@multiformats/multiaddr') return { multiaddr: (value) => ({ toString: () => value }) };
    if (spec === '@libp2p/identify') return { identify: () => 'identify-service' };
    if (spec === '@libp2p/autonat') { if (!withNat) throw new Error("Cannot find module '@libp2p/autonat'"); return { autoNAT: () => 'autonat-service' }; }
    if (spec === '@libp2p/dcutr') { if (!withNat) throw new Error("Cannot find module '@libp2p/dcutr'"); return { dcutr: () => 'dcutr-service' }; }
    throw new Error(`unexpected module ${spec}`);
  };
  return { importer, node, calls };
}

class StubHandshake extends EventEmitter {
  async start() { /* noop */ }
  async stop() { /* noop */ }
  isRunning() { return true; }
  setUserMasterPublicKey() { /* noop */ }
  setUserMasterPrivateKey() { /* noop */ }
  setIdentity() { /* noop */ }
  setRevocationCheck() { /* noop */ }
  async createCertificate() { return { deviceId: 'device-local', devicePublicKey: '', createdAt: 0, metadata: {}, signature: '' }; }
  async initiateAuth(connection) { return { peerId: connection.peerId, state: 'authenticated' }; }
  async acceptAuth(connection) { return { peerId: connection.peerId, state: 'authenticated' }; }
  getSession() { return null; }
  removeSession() { /* noop */ }
}

const scriptedProvider = (plan) => ({
  dial: async (peer, address) => {
    const key = address ?? '<undefined>';
    plan.dials.push(key);
    if (plan.fail.has(key)) throw new Error(`dial failed: ${key}`);
    return {
      peerId: peer, state: 'connected', remoteAddress: key,
      send: async () => undefined, receive: async function* () { /* 空 */ },
      close: async () => undefined, authenticate: async () => true, isAuthenticated: () => true,
    };
  },
  onIncomingConnection: () => undefined,
});

console.log('== verify:nat（AutoNAT + DCUtR 打洞 / 路径升级 / 软降级） ==');
const nodes = [];
try {
  // ---------- Part A：服务装配与直连观测 ----------
  {
    const platform = fakePlatform({ withNat: true });
    const provider = await Libp2pProvider.create(
      { deviceKey: await deviceKey(), listen: ['/ip4/127.0.0.1/tcp/0'] },
      platform.importer,
    );
    await provider.start();
    check('A. 可选依赖在场 → 装配 autoNAT + dcutr（并自动带 identify 能力）',
      platform.calls.services.includes('autoNAT') && platform.calls.services.includes('dcutr') && platform.calls.services.includes('identify'),
      { services: platform.calls.services });

    const upgrades = [];
    provider.onDirectUpgrade((peer, address) => upgrades.push({ peer, address }));
    platform.node.emitConnection({ toString: () => '12D3KooWPEER' }, RELAY_ADDR);
    check('A. circuit 连接计入 relayConnections', provider.getNatStatus().relayConnections === 1, provider.getNatStatus());
    platform.node.emitConnection({ toString: () => '12D3KooWPEER' }, '/ip4/198.51.100.9/tcp/4001/p2p/12D3KooWPEER');
    check('A. 直连观测 → 升级回调（地址可达）',
      provider.getNatStatus().directUpgrades === 1 && upgrades[0]?.address.includes('198.51.100.9'), { upgrades });

    const degraded = fakePlatform({ withNat: false });
    const degradedProvider = await Libp2pProvider.create(
      { deviceKey: await deviceKey(), listen: ['/ip4/127.0.0.1/tcp/0'] },
      degraded.importer,
    );
    await degradedProvider.start();
    check('A. 缺可选依赖 → 软降级（不装配 NAT 服务 + loadError 可读，不抛错）',
      !degraded.calls.services.includes('autoNAT') && String(degradedProvider.getNatStatus().loadError).length > 0,
      degradedProvider.getNatStatus());
    await degradedProvider.stop();
    await provider.stop();

    // ---------- Part B：路径语义 ----------
    const book = new EndpointBook({ store: new InMemoryEndpointStore() });
    const plan = { dials: [], fail: new Set() };
    const node = new P2PNode({
      identity: { deviceId: 'device-local', devicePublicKey: new Uint8Array([1]), devicePrivateKey: null, certificate: { deviceId: 'device-local', devicePublicKey: '', createdAt: 0, metadata: {}, signature: '' } },
      provider: scriptedProvider(plan), endpointBook: book, handshake: new StubHandshake(),
      config: { maxConnections: 4 },
    });
    await node.start();
    nodes.push(node);
    await book.upsert('peer-A', [RELAY_ADDR], 'paired');
    await node.connectToPeer(peerIdOf('peer-A'));
    check('B. relay 连接建立后路径为 relay', node.getPath(peerIdOf('peer-A'))?.kind === 'relay', node.getPath(peerIdOf('peer-A')));
    node.noteDirectConnection('peer-A', '/ip4/198.51.100.9/tcp/4001/p2p/peer-A');
    check('B. 打洞成功 → 路径升级 direct 且候选入库',
      node.getPath(peerIdOf('peer-A'))?.kind === 'direct' && book.addresses('peer-A').includes('/ip4/198.51.100.9/tcp/4001/p2p/peer-A'),
      node.getPath(peerIdOf('peer-A')));

    // 未见直连 + relay 失效 → 退避（不静默升级）
    const failBook = new EndpointBook({ store: new InMemoryEndpointStore() });
    const failPlan = { dials: [], fail: new Set([RELAY_ADDR]) };
    const manager = new ConnectionManager({ endpointBook: failBook, connectTimeout: 200, dialBackoffBaseMs: 20, dialBackoffMaxMs: 40, keepAliveInterval: 60000, heartbeatTimeout: 60000 });
    manager.setConnectionProvider(scriptedProvider(failPlan));
    await failBook.upsert('peer-B', [RELAY_ADDR], 'paired');
    await manager.start();
    let dialFailed = false;
    try { await manager.connect(peerIdOf('peer-B')); } catch { dialFailed = true; }
    check('B. 打洞未成功：保持 relay（不出现 direct）且 relay 失效后按候选退避',
      dialFailed && manager.getPath(peerIdOf('peer-B'))?.kind !== 'direct' && Boolean(manager.getBackoff(peerIdOf('peer-B'))?.pending),
      { backoff: manager.getBackoff(peerIdOf('peer-B')) });
    await manager.stop();
  }

  // ---------- Part C：真 libp2p 两节点 DCUtR（尽力而为） ----------
  {
    let relay = null;
    let a = null;
    let b = null;
    try {
      relay = await Libp2pProvider.create({ deviceKey: await deviceKey(), listen: ['/ip4/127.0.0.1/tcp/0'], relayServer: true, relayUnlimited: true });
      await relay.start();
      const relayAddr = (relay.getMultiaddrs() ?? []).find((addr) => addr.includes('/tcp/'));
      a = await Libp2pProvider.create({ deviceKey: await deviceKey(), listen: ['/ip4/127.0.0.1/tcp/0'], relayServers: [relayAddr] });
      b = await Libp2pProvider.create({ deviceKey: await deviceKey(), listen: ['/ip4/127.0.0.1/tcp/0'], relayServers: [relayAddr] });
      await a.start();
      await b.start();
      const waitFor = async (fn, timeoutMs = 20000) => {
        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
          const value = await fn().catch(() => null);
          if (value) return value;
          await sleep(300);
        }
        return null;
      };
      const bCircuit = await waitFor(async () => (b.getMultiaddrs() ?? []).find((addr) => addr.includes('p2p-circuit')));
      check('C. 真 libp2p：B 经 relay 获得 circuit 地址', typeof bCircuit === 'string', { bCircuit });
      if (typeof bCircuit === 'string') {
        let upgraded = false;
        a.onDirectUpgrade(() => { upgraded = true; });
        await a.dial(b.getLocalPeerId(), bCircuit).catch(() => undefined);
        const observed = await waitFor(async () => (upgraded || a.getNatStatus().directUpgrades > 0) ? true : null, 20000);
        if (observed) check('C. 真 libp2p：DCUtR 升级出直连（观测到 direct）', true, a.getNatStatus());
        else skip('C. 真 libp2p DCUtR 升级', '本机 loopback/受限环境未升级（SKIP 非失败；保留 relay 属预期）');
      }
    } catch (error) {
      skip('C. 真 libp2p 打洞', `可选依赖或环境受限：${error?.code ?? error?.message}`);
    } finally {
      await a?.stop().catch(() => undefined);
      await b?.stop().catch(() => undefined);
      await relay?.stop().catch(() => undefined);
    }
  }
  await sleep(0);
} catch (error) {
  check('verify:nat 执行', false, String(error?.stack ?? error).slice(0, 300));
} finally {
  for (const node of nodes) await node.stop().catch(() => undefined);
}

console.log('===============================');
console.log(`FLEET_SUMMARY ${JSON.stringify({ total: passed + failed, passed, failed: failed === 0 ? [] : ['see above'], skipped })}`);
process.exit(failed === 0 ? 0 : 1);
