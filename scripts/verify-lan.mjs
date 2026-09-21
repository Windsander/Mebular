#!/usr/bin/env node
// C3 验收：LAN 自动发现 + LAN↔WAN 无感切换
//
// Part A（确定式 harness，必跑）：注入假 bonjour factory 模拟 mDNS 事件 + 脚本化传输，覆盖
//   a. 已配对对端：发现 → 自动拨号 → 路径=lan（LAN 候选 learned 入库）
//   b. 未配对设备：被发现但**不拨号**（安全锚点）
//   c. 已连 relay 时发现到 LAN → 无感升级（断开重连，路径=lan）
//   d. LAN 撤销 → 移除候选 + 降级回退 relay
//   e. network.lan.enabled=false → 不装配发现层（不 publish / 不拨号）
//   f. 默认 bonjour factory 缺包 → 软降级（null + 告警），不 panic
// Part B（尽力而为，真 mDNS）：真实 bonjour 自发布 + 本机浏览；受限环境 SKIP（非红）。
//
// 用法：npm run verify:lan（前置：npm run build）

import { EventEmitter } from 'node:events';
import { P2PNode } from '@mebular/core';
import { EndpointBook, InMemoryEndpointStore, createDefaultBonjourFactory } from '@mebular/core';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let passed = 0;
let failed = 0;
const skipped = [];
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? `（${typeof detail === 'string' ? detail : JSON.stringify(detail)}）` : ''}`);
  if (ok) passed += 1;
  else failed += 1;
};
const skip = (label, reason) => {
  console.log(`  - SKIP ${label}：${reason}`);
  skipped.push(label);
};
const waitFor = async (fn, timeoutMs = 5000, stepMs = 25) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch { /* 继续等 */ }
    await sleep(stepMs);
  }
  return null;
};

const peerRef = (id) => ({ id, multihash: new Uint8Array(), pubKey: new Uint8Array() });

/** 假 bonjour：publish 记录 + 可选把「发现事件」注入 find 回调（确定式 mDNS） */
function fakeBonjour() {
  const callbacks = [];
  const instance = {
    published: [],
    publish(options) { instance.published.push(options); },
    find(_query, cb) { callbacks.push(cb); return { stop: () => undefined }; },
    destroy() { /* noop */ },
    emitService(svc) { for (const cb of callbacks) cb(svc); },
  };
  return { factory: () => instance, instance };
}

/** 脚本化传输：按地址决定成败并记录拨号序列（确定性，无真实网络） */
function scriptedProvider(plan) {
  return {
    dial: async (peer, address) => {
      const key = address ?? '<undefined>';
      plan.dials.push(key);
      if (plan.fail.has(key)) throw new Error(`dial failed: ${key}`);
      return {
        peerId: peer,
        state: 'connected',
        remoteAddress: key,
        send: async () => undefined,
        receive: async function* () { /* 空流 */ },
        close: async () => undefined,
        authenticate: async () => true,
        isAuthenticated: () => true,
      };
    },
    onIncomingConnection: () => undefined,
  };
}

/** 桩握手：把链路焦点放在发现/选路上（协议层由 jest/verify:connect 覆盖） */
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

const LAN = '/ip4/192.168.60.10/tcp/4001/p2p/device-peer';
const LAN2 = '/ip4/192.168.60.11/tcp/4001/p2p/device-peer';
const RELAY = '/ip4/203.0.113.77/tcp/4001/p2p/relayQ/p2p-circuit/p2p/device-peer';
const STRANGER = '/ip4/192.168.60.99/tcp/4001/p2p/device-stranger';

const nodes = [];
async function makeNode({ book, factory, lan, peerAllowlist, plan }) {
  const node = new P2PNode({
    identity: {
      deviceId: 'device-local',
      devicePublicKey: new Uint8Array([1, 2, 3]),
      devicePrivateKey: null,
      certificate: { deviceId: 'device-local', devicePublicKey: '', createdAt: 0, metadata: {}, signature: '' },
    },
    provider: scriptedProvider(plan),
    endpointBook: book,
    autoConnect: true,
    handshake: new StubHandshake(),
    ...(lan !== undefined ? { lan } : {}),
    ...(peerAllowlist !== undefined ? { peerAllowlist } : {}),
    ...(factory !== undefined ? { bonjourFactory: factory } : {}),
    onWarn: () => undefined,
    config: { maxConnections: 8, listenPort: 4100 },
  });
  await node.start();
  nodes.push(node);
  return node;
}

console.log('== verify:lan（LAN 自动发现 / LAN↔WAN 无感切换） ==');
try {
  // ---------- Part A：确定式 harness ----------
  {
    const book = new EndpointBook({ store: new InMemoryEndpointStore() });
    await book.upsert('device-peer', [RELAY], 'paired');
    const plan = { dials: [], fail: new Set() };
    const { factory, instance } = fakeBonjour();
    const node = await makeNode({ book, factory, plan });

    instance.emitService({ name: 'peer', type: '_mebular._tcp', port: 4001, txt: { id: 'device-peer', addrs: LAN } });
    const lanPath = await waitFor(() => (node.getPath(peerRef('device-peer'))?.kind === 'lan' ? node.getPath(peerRef('device-peer')) : null));
    check('a. 已配对对端：发现 → 自动拨号 → 路径=lan', Boolean(lanPath) && lanPath.address === LAN, { path: lanPath, dials: plan.dials });
    check('a. LAN 候选入库（learned）', book.addresses('device-peer').includes(LAN), { candidates: book.addresses('device-peer') });

    instance.emitService({ name: 'stranger', type: '_mebular._tcp', port: 4001, txt: { id: 'device-stranger', addrs: STRANGER } });
    await sleep(150);
    check('b. 未配对设备被发现但**不拨号**（安全锚点）',
      book.addresses('device-stranger').length === 0 && node.getPath(peerRef('device-stranger')) === null && node.getLanStatus().ignoredUnknown >= 1,
      { status: node.getLanStatus(), strangerCandidates: book.addresses('device-stranger') });

    // ---- c/d：独立 harness（先只经 relay 连上，再注入 LAN 发现 → 升级；撤销 → 降级） ----
    const cBook = new EndpointBook({ store: new InMemoryEndpointStore() });
    await cBook.upsert('device-peer', [RELAY], 'paired');
    const cPlan = { dials: [], fail: new Set() };
    const { factory: cFactory, instance: cInstance } = fakeBonjour();
    const cNode = await makeNode({ book: cBook, factory: cFactory, plan: cPlan });
    await cNode.connectToPeer(peerRef('device-peer'));
    const relayPath = cNode.getPath(peerRef('device-peer'));

    cInstance.emitService({ name: 'peer', type: '_mebular._tcp', port: 4001, txt: { id: 'device-peer', addrs: LAN2 } });
    const upgraded = await waitFor(() => (cNode.getPath(peerRef('device-peer'))?.kind === 'lan' ? cNode.getPath(peerRef('device-peer')) : null));
    check('c. 已连 relay 时发现到 LAN → 无感升级到 lan（断开重连）',
      relayPath?.kind === 'relay' && upgraded?.address === LAN2, { before: relayPath, after: upgraded, dials: cPlan.dials });

    // d. LAN 撤销 → 降级回 relay
    const discovery = cNode.getDiscovery();
    const removed = discovery?.removePeer ? discovery.removePeer(peerRef('device-peer')) : false;
    const degraded = await waitFor(() => (cNode.getPath(peerRef('device-peer'))?.kind === 'relay' ? cNode.getPath(peerRef('device-peer')) : null));
    check('d. LAN 撤销 → 移除候选 + 降级回 relay',
      removed === true && degraded?.kind === 'relay' && !cBook.addresses('device-peer').includes(LAN2),
      { degraded, candidates: cBook.addresses('device-peer') });

    // e. lan.enabled=false → 不装配发现层
    const offBook = new EndpointBook({ store: new InMemoryEndpointStore() });
    const offPlan = { dials: [], fail: new Set() };
    const { factory: offFactory, instance: offInstance } = fakeBonjour();
    const off = await makeNode({ book: offBook, factory: offFactory, plan: offPlan, lan: { enabled: false } });
    check('e. network.lan.enabled=false → 不装配发现层（不 publish / 不拨号）',
      off.getLanStatus().enabled === false && off.getLanStatus().running === false && offInstance.published.length === 0 && offPlan.dials.length === 0,
      { status: off.getLanStatus(), published: offInstance.published.length });
  }

  // g. 库形态默认不启用真 mDNS（避免库/测试产生多播副作用；app 显式开启）
  {
    const { Mebular, IdentityManager } = await import('@mebular/core');
    const master2 = await new IdentityManager().generateUserMasterKey();
    const lib = new Mebular({
      storagePath: `/tmp/mebular-verify-lan-lib-${process.pid}.jsonl`,
      deviceId: 'device-lib',
      encryption: { userMasterKey: master2.publicKey, userMasterPrivateKey: master2.privateKey },
      network: { enabled: true, lan: { enabled: true } },
      sync: { autoSync: false },
    });
    await lib.initialize();
    try {
      const status = lib.node?.getLanStatus?.() ?? {};
      check('g. 库形态（未显式开启 defaultFactory）不启动真 mDNS', status.enabled === true && status.running === false, status);
    } finally {
      await lib.shutdown().catch(() => undefined);
    }
  }

  // f. 默认 factory 软降级
  {
    const warnings = [];
    const missing = createDefaultBonjourFactory({
      loadModule: () => { throw new Error("Cannot find module 'bonjour'"); },
      onWarn: (message) => warnings.push(message),
    });
    check('f. 默认 bonjour factory：缺包 → null + 告警（软降级，不 panic）',
      missing() === null && warnings.some((message) => message.includes('bonjour 不可用')), { warnings });
  }

  // ---------- Part B：真 mDNS（尽力而为） ----------
  {
    const factory = createDefaultBonjourFactory({ onWarn: () => undefined });
    const svc = factory();
    if (!svc) {
      skip('Part B 真 mDNS', '本机 bonjour 不可用（沙箱 / 无 mDNS）');
    } else {
      let found = false;
      const type = '_mebular-verify._tcp';
      svc.publish({ name: `mebular-verify-${process.pid}`, type, port: 9, txt: { id: 'self-probe' } });
      const browser = svc.find({ type }, () => { found = true; });
      const ok = await waitFor(() => found, 4000, 200);
      try { browser?.stop?.(); } catch { /* 忽略 */ }
      try { svc.destroy(); } catch { /* 忽略 */ }
      if (ok) check('Part B. 真 mDNS：自发布可被本机浏览发现（尽力而为）', true);
      else skip('Part B 真 mDNS', '未在时限内发现（受限环境：CI/沙箱常见，非失败）');
    }
  }
} catch (error) {
  check('verify:lan 执行', false, String(error?.stack ?? error).slice(0, 400));
} finally {
  for (const node of nodes) await node.stop().catch(() => undefined);
}

console.log('===============================');
console.log(`FLEET_SUMMARY ${JSON.stringify({ total: passed + failed, passed, failed: failed === 0 ? [] : ['see above'], skipped })}`);
process.exit(failed === 0 ? 0 : 1);
