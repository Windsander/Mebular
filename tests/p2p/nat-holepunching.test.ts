// C4 · 打洞（AutoNAT + DCUtR）：服务启用/软降级、直连观测 → 路径升级 direct、无升级则保留 relay 并退避
import { describe, it, expect, beforeEach } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { Libp2pProvider } from '../../src/p2p/transport/Libp2pProvider.js';
import { P2PNode } from '../../src/p2p/P2PNetwork.js';
import type { Connection, PeerId } from '../../src/p2p/P2PNetwork.js';
import { ConnectionManager } from '../../src/p2p/connection/ConnectionManager.js';
import { EndpointBook, InMemoryEndpointStore } from '../../src/p2p/connection/EndpointBook.js';
import { InMemoryHub } from '../../src/p2p/transport/InMemoryTransport.js';

const peerIdOf = (id: string): PeerId => ({ id, multihash: new TextEncoder().encode(id), pubKey: new TextEncoder().encode(id) });
const RELAY_ADDR = '/ip4/203.0.113.5/tcp/4001/p2p/relayZ/p2p-circuit/p2p/peer-A';

/** 假 libp2p 节点：记录 services 选项，支持 addEventListener 注入连接事件 */
function fakeNode() {
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  const node = {
    peerId: { toString: () => '12D3KooWSELF' },
    started: false,
    async start() { node.started = true; },
    async stop() { node.started = false; },
    async handle() { /* noop */ },
    async dialProtocol() { throw new Error('unused'); },
    async dial() { throw new Error('unused'); },
    getMultiaddrs: () => [] as Array<{ toString(): string }>,
    addEventListener(type: string, handler: (event: unknown) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), handler]);
    },
    emitConnection(remotePeer: unknown, remoteAddr: string) {
      for (const handler of listeners.get('connection:open') ?? []) handler({ detail: { remotePeer, remoteAddr: { toString: () => remoteAddr } } });
    },
  };
  return node;
}

const deviceKey = async () => {
  const { IdentityManager } = await import('@mebular/core');
  const im = new IdentityManager();
  const key = await im.generateDeviceKey('device-nat', 'nat');
  return { publicKey: key.publicKey, privateKey: key.privateKey };
};

interface NatCalls { services?: string[]; autonat?: number; dcutr?: number }
function modulesFor(node: unknown, calls: NatCalls) {
  return async (spec: string): Promise<Record<string, unknown>> => {
    if (spec === 'libp2p') return { createLibp2p: async (options: Record<string, unknown>) => { calls.services = Object.keys((options.services as Record<string, unknown>) ?? {}); return node; } };
    if (spec === '@libp2p/tcp') return { tcp: () => 'tcp' };
    if (spec === '@chainsafe/libp2p-noise') return { noise: () => 'noise' };
    if (spec === '@chainsafe/libp2p-yamux') return { yamux: () => 'yamux' };
    if (spec === '@libp2p/identify') return { identify: () => 'identify-service' };
    if (spec === '@libp2p/crypto/keys') return { generateKeyPairFromSeed: async () => ({}), publicKeyFromRaw: () => ({ type: 'Ed25519', raw: new Uint8Array(32) }) };
    if (spec === '@libp2p/peer-id') return { peerIdFromPublicKey: () => ({ toString: () => '12D3KooWSELF' }) };
    if (spec === '@multiformats/multiaddr') return { multiaddr: (value: string) => ({ toString: () => value }) };
    if (spec === '@libp2p/identify') return { identify: () => 'identify-service' };
    if (spec === '@libp2p/autonat') { calls.autonat = (calls.autonat ?? 0) + 1; return { autoNAT: () => 'autonat-service' }; }
    if (spec === '@libp2p/dcutr') { calls.dcutr = (calls.dcutr ?? 0) + 1; return { dcutr: () => 'dcutr-service' }; }
    throw new Error(`unexpected module ${spec}`);
    throw new Error(`unexpected module ${spec}`);
  };
}

describe('C4 · Libp2pProvider（NAT 服务与直连观测）', () => {
  it('可选依赖在场：启用 autoNAT + dcutr 服务；circuit 连接计数、直连触发升级回调（peerId 映射）', async () => {
    const node = fakeNode();
    const calls: NatCalls = {};
    const provider = await Libp2pProvider.create(
      { deviceKey: await deviceKey(), listen: ['/ip4/127.0.0.1/tcp/0'], relayServer: false },
      modulesFor(node, calls) as never,
    );
    await provider.start();
    expect(calls.services).toContain('autoNAT');
    expect(calls.services).toContain('dcutr');
    expect(provider.getNatStatus()).toMatchObject({ autonatEnabled: true, dcutrEnabled: true, loadError: null });

    const upgrades: Array<{ peer: string; address: string }> = [];
    provider.onDirectUpgrade((peer, address) => upgrades.push({ peer, address }));
    node.emitConnection({ toString: () => '12D3KooWPEER' }, RELAY_ADDR);
    expect(provider.getNatStatus().relayConnections).toBe(1);
    node.emitConnection({ toString: () => '12D3KooWPEER' }, '/ip4/198.51.100.9/tcp/4001/p2p/12D3KooWPEER');
    expect(provider.getNatStatus().directUpgrades).toBe(1);
    expect(upgrades).toHaveLength(1);
    expect(upgrades[0]!.address).toContain('198.51.100.9');
    await provider.stop();
  });

  it('缺可选依赖：软降级（不打洞、不抛错）+ loadError 可读', async () => {
    const node = fakeNode();
    const base = modulesFor(node, {});
    const provider = await Libp2pProvider.create(
      { deviceKey: await deviceKey(), listen: ['/ip4/127.0.0.1/tcp/0'] },
      (async (spec: string) => base(spec)) as never,
    );
    // 用只缺 NAT 两包的 importer 重建
    const failing = async (spec: string): Promise<Record<string, unknown>> => {
      if (spec === '@libp2p/autonat' || spec === '@libp2p/dcutr') throw new Error(`Cannot find module '${spec}'`);
      return base(spec);
    };
    const degraded = await Libp2pProvider.create(
      { deviceKey: await deviceKey(), listen: ['/ip4/127.0.0.1/tcp/0'] },
      failing as never,
    );
    await degraded.start();
    expect(degraded.getNatStatus()).toMatchObject({ autonatEnabled: false, dcutrEnabled: false });
    expect(String(degraded.getNatStatus().loadError)).toContain('AutoNAT/DCUtR');
    await degraded.stop();
    await provider.stop().catch(() => undefined);
  });
});

/** 桩握手：把链路聚焦在 NAT/路径语义上 */
class StubHandshake extends EventEmitter {
  async start() { /* noop */ }
  async stop() { /* noop */ }
  isRunning() { return true; }
  setUserMasterPublicKey() { /* noop */ }
  setUserMasterPrivateKey() { /* noop */ }
  setIdentity() { /* noop */ }
  setRevocationCheck() { /* noop */ }
  async createCertificate() { return { deviceId: 'device-local', devicePublicKey: '', createdAt: 0, metadata: {}, signature: '' }; }
  async initiateAuth(connection: Connection) { return { peerId: connection.peerId, state: 'authenticated' }; }
  async acceptAuth(connection: Connection) { return { peerId: connection.peerId, state: 'authenticated' }; }
  getSession() { return null; }
  removeSession() { /* noop */ }
}

const scriptedProvider = (plan: { dials: string[]; fail: Set<string> }) => ({
  dial: async (peer: PeerId, address?: string) => {
    const key = address ?? '<undefined>';
    plan.dials.push(key);
    if (plan.fail.has(key)) throw new Error(`dial failed: ${key}`);
    return {
      peerId: peer, state: 'connected' as const, remoteAddress: key,
      send: async () => undefined, receive: async function* () { /* 空 */ },
      close: async () => undefined, authenticate: async () => true, isAuthenticated: () => true,
    } as unknown as Connection;
  },
  onIncomingConnection: () => undefined,
});

describe('C4 · 路径升级与失败保留', () => {
  let book: EndpointBook;
  beforeEach(() => { book = new EndpointBook({ store: new InMemoryEndpointStore() }); });

  it('打洞/直连成功 → noteDirectConnection 升级路径为 direct（候选入库）', async () => {
    const plan = { dials: [] as string[], fail: new Set<string>() };
    const node = new P2PNode({
      identity: { deviceId: 'device-local', devicePublicKey: new Uint8Array([1]), devicePrivateKey: null as never, certificate: { deviceId: 'device-local', devicePublicKey: '', createdAt: 0, metadata: {}, signature: '' } },
      provider: scriptedProvider(plan), endpointBook: book, handshake: new StubHandshake() as never,
      config: { maxConnections: 4 },
    });
    await node.start();
    try {
      await book.upsert('peer-A', [RELAY_ADDR], 'paired');
      await node.connectToPeer(peerIdOf('peer-A'));
      expect(node.getPath(peerIdOf('peer-A'))?.kind).toBe('relay');
      // 模拟 DCUtR 成功后的直连观测
      node.noteDirectConnection('peer-A', '/ip4/198.51.100.9/tcp/4001/p2p/peer-A');
      expect(node.getPath(peerIdOf('peer-A'))).toMatchObject({ kind: 'direct', address: '/ip4/198.51.100.9/tcp/4001/p2p/peer-A' });
      expect(book.addresses('peer-A')).toContain('/ip4/198.51.100.9/tcp/4001/p2p/peer-A');
    } finally {
      await node.stop();
    }
  });

  it('未见直连（打洞未成功）→ 保持 relay；relay 失效则按候选策略退避（不静默升级）', async () => {
    const plan = { dials: [] as string[], fail: new Set<string>([RELAY_ADDR]) };
    const manager = new ConnectionManager({ endpointBook: book, connectTimeout: 200, dialBackoffBaseMs: 20, dialBackoffMaxMs: 40, keepAliveInterval: 60000, heartbeatTimeout: 60000 });
    manager.setConnectionProvider(scriptedProvider(plan) as never);
    await book.upsert('peer-B', [RELAY_ADDR], 'paired');
    await manager.start();
    try {
      await expect(manager.connect(peerIdOf('peer-B'))).rejects.toThrow(/dial failed/);
      expect(manager.getPath(peerIdOf('peer-B'))?.kind).not.toBe('direct');
      expect(manager.getBackoff(peerIdOf('peer-B'))).toMatchObject({ attempts: 1, pending: true });
    } finally {
      await manager.stop();
    }
  });

  it('noteDirectConnection 忽略 circuit 地址与空键（不自欺）', async () => {
    const hub = new InMemoryHub();
    const plan = { dials: [] as string[], fail: new Set<string>() };
    const node = new P2PNode({
      identity: { deviceId: 'device-local', devicePublicKey: new Uint8Array([1]), devicePrivateKey: null as never, certificate: { deviceId: 'device-local', devicePublicKey: '', createdAt: 0, metadata: {}, signature: '' } },
      provider: hub.forPeer(peerIdOf('device-local')), endpointBook: book, handshake: new StubHandshake() as never,
      config: { maxConnections: 4 },
    });
    await node.start();
    try {
      node.noteDirectConnection('peer-C', RELAY_ADDR);
      node.noteDirectConnection('', '/ip4/198.51.100.9/tcp/4001/p2p/peer-C');
      expect(node.getPath(peerIdOf('peer-C'))).toBeNull();
      void plan;
    } finally {
      await node.stop();
    }
  });
});
