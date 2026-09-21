// C3 · LAN 自动发现与 LAN↔WAN 无感切换（确定式：注入假 bonjour factory）
// 判别性锚点：未配对不自动拨号（安全不变式）；已知对端发现 → LAN 候选 + 自动拨号 + 路径=lan；
// LAN 撤销 → 降级（清路径/移除候选）并回退 relay；发现关闭 → 降级；默认 factory 缺包 → 软降级。
import { describe, it, expect } from '@jest/globals';
import { EventEmitter } from 'events';
import { P2PNode } from '../../src/p2p/P2PNetwork.js';
import type { PeerId, Connection } from '../../src/p2p/P2PNetwork.js';
import { ConnectionManager } from '../../src/p2p/connection/ConnectionManager.js';
import { EndpointBook, InMemoryEndpointStore } from '../../src/p2p/connection/EndpointBook.js';
import type { BonjourService, BonjourServiceInstance, BonjourServiceFactory, ConnectionProvider } from '../../src/p2p/index.js';
import { createDefaultBonjourFactory } from '../../src/p2p/discovery/bonjourDefault.js';
import { createTestIdentity, type TestIdentity } from './helpers.js';

const peerIdOf = (id: string): PeerId => ({ id, multihash: new TextEncoder().encode(id), pubKey: new TextEncoder().encode(id) });

/**
 * 桩握手：让 P2PNode.connectToPeer 视为认证通过（协议层不在本测试范围），
 * 从而可断言「发现 → 自动拨号 → 路径状态」这条链路本身。
 */
class StubHandshake extends EventEmitter {
  async start(): Promise<void> { /* noop */ }
  async stop(): Promise<void> { /* noop */ }
  isRunning(): boolean { return true; }
  setUserMasterPublicKey(): void { /* noop */ }
  setUserMasterPrivateKey(): void { /* noop */ }
  setIdentity(): void { /* noop */ }
  setRevocationCheck(): void { /* noop */ }
  async createCertificate(): Promise<unknown> {
    return { deviceId: 'device-local', devicePublicKey: '', createdAt: 0, metadata: {}, signature: '' };
  }
  async initiateAuth(connection: Connection): Promise<{ peerId: PeerId; state: 'authenticated' }> {
    return { peerId: connection.peerId, state: 'authenticated' };
  }
  async acceptAuth(connection: Connection): Promise<{ peerId: PeerId; state: 'authenticated' }> {
    return { peerId: connection.peerId, state: 'authenticated' };
  }
  getSession(): null { return null; }
  removeSession(): void { /* noop */ }
}

/** 假 bonjour：publish 后可通过 emit 注入「发现到某服务」/「服务撤销」 */
function fakeBonjour() {
  const callbacks: Array<(svc: BonjourService) => void> = [];
  const instance: BonjourServiceInstance & {
    emitService: (svc: BonjourService) => void;
    published: BonjourService[];
  } = {
    publish: (options: Parameters<BonjourServiceInstance['publish']>[0]) => {
      instance.published.push(options as unknown as BonjourService);
    },
    find: (query: { type: string }, cb: (svc: BonjourService) => void) => {
      void query;
      callbacks.push(cb);
      return { stop: () => undefined };
    },
    destroy: () => undefined,
    emitService: (svc: BonjourService) => { for (const cb of callbacks) cb(svc); },
    published: [],
  } as never;
  const factory: BonjourServiceFactory = () => instance;
  return { factory, instance };
}

/** 按地址脚本化的拨号 provider（成功即记录地址；LAN 与 relay 地址分别可控） */
function scriptedProvider(plan: { dials: string[]; fail: Set<string> }) {
  return {
    dial: async (peer: PeerId, address?: string) => {
      const key = address ?? '<undefined>';
      plan.dials.push(key);
      if (plan.fail.has(key)) throw new Error(`dial failed: ${key}`);
      return {
        peerId: peer,
        state: 'connected' as const,
        remoteAddress: key,
        send: async () => undefined,
        receive: async function* () { /* 空 */ },
        close: async () => undefined,
        authenticate: async () => true,
        isAuthenticated: () => true,
      } as unknown as Connection;
    },
    onIncomingConnection: () => undefined,
  } as ConnectionProvider;
}

const LAN_A = '/ip4/192.168.77.10/tcp/4001/p2p/peer-known';
const LAN_A2 = '/ip4/192.168.77.11/tcp/4001/p2p/peer-known';
const RELAY_A = '/ip4/203.0.113.60/tcp/4001/p2p/relayX/p2p-circuit/p2p/peer-known';
const LAN_UNKNOWN = '/ip4/192.168.77.99/tcp/4001/p2p/peer-stranger';

async function makeNode(options: {
  book: EndpointBook;
  provider: ConnectionProvider;
  factory?: BonjourServiceFactory;
  lan?: { enabled?: boolean; autoDial?: boolean };
  peerAllowlist?: string[];
}) {
  const local: TestIdentity = await createTestIdentity('device-local');
  const warnings: string[] = [];
  const node = new P2PNode({
    identity: {
      deviceId: local.identity.deviceId,
      devicePublicKey: local.identity.devicePublicKey,
      devicePrivateKey: local.identity.devicePrivateKey,
      certificate: { deviceId: local.identity.deviceId, devicePublicKey: '', createdAt: 0, metadata: {}, signature: '' },
    },
    provider: options.provider,
    endpointBook: options.book,
    autoConnect: true,
    ...(options.lan !== undefined ? { lan: options.lan } : {}),
    ...(options.peerAllowlist !== undefined ? { peerAllowlist: options.peerAllowlist } : {}),
    ...(options.factory !== undefined ? { bonjourFactory: options.factory } : {}),
    handshake: new StubHandshake() as never,
    onWarn: (message: string) => warnings.push(message),
    config: { maxConnections: 8, listenPort: 4100 },
  });
  await node.start();
  return { node, warnings };
}

describe('C3 LAN 自动发现', () => {
  it('已知对端（地址簿 paired）被发现 → 记录 LAN 候选 + 自动拨号 + 路径=lan', async () => {
    const book = new EndpointBook({ store: new InMemoryEndpointStore() });
    await book.upsert('peer-known', [RELAY_A], 'paired'); // 先只有 relay 候选
    const plan = { dials: [] as string[], fail: new Set<string>() };
    const { factory, instance } = fakeBonjour();
    const { node } = await makeNode({ book, provider: scriptedProvider(plan), factory });

    instance.emitService({ name: 'mebular-known', type: '_mebular._tcp', port: 4001, txt: { id: 'peer-known', addrs: LAN_A } });
    await new Promise((r) => setTimeout(r, 50));

    expect(book.addresses('peer-known')).toContain(LAN_A);
    expect(plan.dials).toContain(LAN_A);
    expect(node.getPath(peerIdOf('peer-known'))).toMatchObject({ kind: 'lan', address: LAN_A });
    expect(node.getLanStatus()).toMatchObject({ enabled: true, running: true, autoDial: true, lanCandidates: 1, ignoredUnknown: 0 });
    await node.stop();
  });

  it('未配对/未白名单设备被发现 → 不记录候选、不拨号（安全不变式）', async () => {
    const book = new EndpointBook({ store: new InMemoryEndpointStore() });
    const plan = { dials: [] as string[], fail: new Set<string>() };
    const { factory, instance } = fakeBonjour();
    const { node } = await makeNode({ book, provider: scriptedProvider(plan), factory });

    instance.emitService({ name: 'mebular-stranger', type: '_mebular._tcp', port: 4001, txt: { id: 'peer-stranger', addrs: LAN_UNKNOWN } });
    await new Promise((r) => setTimeout(r, 50));

    expect(book.addresses('peer-stranger')).toEqual([]);
    expect(plan.dials).toEqual([]);
    expect(node.getLanStatus()).toMatchObject({ lanCandidates: 0, ignoredUnknown: 1 });
    await node.stop();
  });

  it('白名单对端（不在地址簿）被发现 → 允许自动拨号', async () => {
    const book = new EndpointBook({ store: new InMemoryEndpointStore() });
    const plan = { dials: [] as string[], fail: new Set<string>() };
    const { factory, instance } = fakeBonjour();
    const { node } = await makeNode({ book, provider: scriptedProvider(plan), factory, peerAllowlist: ['peer-allow'] });

    instance.emitService({ name: 'mebular-allow', type: '_mebular._tcp', port: 4001, txt: { id: 'peer-allow', addrs: '/ip4/192.168.77.20/tcp/4001/p2p/peer-allow' } });
    await new Promise((r) => setTimeout(r, 50));

    expect(plan.dials).toContain('/ip4/192.168.77.20/tcp/4001/p2p/peer-allow');
    expect(node.getPath(peerIdOf('peer-allow'))).toMatchObject({ kind: 'lan' });
    await node.stop();
  });

  it('LAN 消失（mDNS 撤销）→ 移除 LAN 候选、清路径并降级回退 relay', async () => {
    const book = new EndpointBook({ store: new InMemoryEndpointStore() });
    await book.upsert('peer-known', [RELAY_A], 'paired');
    const plan = { dials: [] as string[], fail: new Set<string>() };
    const { factory, instance } = fakeBonjour();
    const { node } = await makeNode({ book, provider: scriptedProvider(plan), factory });

    instance.emitService({ name: 'mebular-known', type: '_mebular._tcp', port: 4001, txt: { id: 'peer-known', addrs: LAN_A } });
    await new Promise((r) => setTimeout(r, 50));
    expect(node.getPath(peerIdOf('peer-known'))?.kind).toBe('lan');

    // 模拟发现层撤销（DeviceDiscovery.removePeer 会 emit peer-removed）
    const discovery = (node as unknown as { discovery: { removePeer: (p: PeerId) => boolean } }).discovery;
    discovery.removePeer(peerIdOf('peer-known'));
    await new Promise((r) => setTimeout(r, 60));

    expect(book.addresses('peer-known')).not.toContain(LAN_A);
    expect(book.addresses('peer-known')).toContain(RELAY_A);
    // 降级重试：回退到 relay 候选
    expect(plan.dials).toContain(RELAY_A);
    expect(node.getPath(peerIdOf('peer-known'))).toMatchObject({ kind: 'relay' });
    await node.stop();
  });

  it('discovery 重报同地址 → 保持 LAN 路径（无抖动）；换成另一 LAN 地址 → 切到新候选', async () => {
    const book = new EndpointBook({ store: new InMemoryEndpointStore() });
    await book.upsert('peer-known', [RELAY_A], 'paired');
    const plan = { dials: [] as string[], fail: new Set<string>() };
    const { factory, instance } = fakeBonjour();
    const { node } = await makeNode({ book, provider: scriptedProvider(plan), factory });

    instance.emitService({ name: 'k', type: '_mebular._tcp', port: 4001, txt: { id: 'peer-known', addrs: LAN_A } });
    await new Promise((r) => setTimeout(r, 40));
    const since = node.getPath(peerIdOf('peer-known'))?.since;
    instance.emitService({ name: 'k', type: '_mebular._tcp', port: 4001, txt: { id: 'peer-known', addrs: LAN_A } });
    await new Promise((r) => setTimeout(r, 40));
    expect(node.getPath(peerIdOf('peer-known'))?.since).toBe(since); // 未重复切换

    instance.emitService({ name: 'k', type: '_mebular._tcp', port: 4001, txt: { id: 'peer-known', addrs: LAN_A2 } });
    await new Promise((r) => setTimeout(r, 40));
    expect(book.addresses('peer-known')).toContain(LAN_A2);
    await node.stop();
  });

  it('已连 relay 时发现到新 LAN 候选 → 无感升级到 lan（断开重连）', async () => {
    const book = new EndpointBook({ store: new InMemoryEndpointStore() });
    await book.upsert('peer-known', [RELAY_A], 'paired');
    const plan = { dials: [] as string[], fail: new Set<string>() };
    const { factory, instance } = fakeBonjour();
    const { node } = await makeNode({ book, provider: scriptedProvider(plan), factory });

    // 先经 relay 连上（簿内只有 relay 候选）
    await node.connectToPeer(peerIdOf('peer-known'));
    expect(node.getPath(peerIdOf('peer-known'))?.kind).toBe('relay');

    // 发现到 LAN → 自动断开并升级
    instance.emitService({ name: 'k', type: '_mebular._tcp', port: 4001, txt: { id: 'peer-known', addrs: LAN_A } });
    await new Promise((r) => setTimeout(r, 80));
    expect(plan.dials).toEqual([RELAY_A, LAN_A]);
    expect(node.getPath(peerIdOf('peer-known'))).toMatchObject({ kind: 'lan', address: LAN_A });
    await node.stop();
  });

  it('network.lan.enabled=false → 不装配发现层（不 publish、不拨号）；network 关闭 no-op', async () => {
    const book = new EndpointBook({ store: new InMemoryEndpointStore() });
    const plan = { dials: [] as string[], fail: new Set<string>() };
    const { factory, instance } = fakeBonjour();
    const { node } = await makeNode({ book, provider: scriptedProvider(plan), factory, lan: { enabled: false } });
    expect(instance.published).toEqual([]);
    expect(node.getLanStatus()).toMatchObject({ enabled: false, running: false, lanCandidates: 0 });
    await node.stop();
  });

  it('默认 bonjour factory：缺包/导出不符 → null + 告警（软降级，不 panic）', () => {
    const warnings: string[] = [];
    const missing = createDefaultBonjourFactory({ loadModule: () => { throw new Error("Cannot find module 'bonjour'"); }, onWarn: (m) => warnings.push(m) });
    expect(missing()).toBeNull();
    expect(warnings[0]).toContain('bonjour 不可用');

    const badExport = createDefaultBonjourFactory({ loadModule: () => ({ nope: true }), onWarn: (m) => warnings.push(m) });
    expect(badExport()).toBeNull();
    expect(warnings[1]).toContain('导出非函数');

    const ok = createDefaultBonjourFactory({
      loadModule: () => () => ({ publish: () => undefined, find: () => ({ stop: () => undefined }), destroy: () => undefined }),
    });
    expect(ok()).not.toBeNull();
  });
});

describe('C3 LAN↔WAN 切换（ConnectionManager 候选与路径）', () => {
  it('LAN 优先于 relay：簿内同时有 lan/relay 时拨 lan；LAN 失败回退 relay（降级）', async () => {
    const book = new EndpointBook({ store: new InMemoryEndpointStore() });
    await book.upsert('peer-x', [RELAY_A, LAN_A], 'paired');
    const plan = { dials: [] as string[], fail: new Set<string>([LAN_A]) };
    const manager = new ConnectionManager({ endpointBook: book, connectTimeout: 300, dialBackoffBaseMs: 0, keepAliveInterval: 60000, heartbeatTimeout: 60000 });
    manager.setConnectionProvider(scriptedProvider(plan));
    await manager.start();
    try {
      await manager.connect(peerIdOf('peer-x'));
      expect(plan.dials).toEqual([LAN_A, RELAY_A]); // LAN 优先，失败即回退 relay
      expect(manager.getPath(peerIdOf('peer-x'))).toMatchObject({ kind: 'relay' });
    } finally {
      await manager.stop();
    }
  });

  it('LAN 恢复（新候选加入）→ 下一次拨号升回 lan（升级）', async () => {
    const book = new EndpointBook({ store: new InMemoryEndpointStore() });
    await book.upsert('peer-y', [RELAY_A], 'paired');
    const plan = { dials: [] as string[], fail: new Set<string>() };
    const manager = new ConnectionManager({ endpointBook: book, connectTimeout: 300, dialBackoffBaseMs: 0, keepAliveInterval: 60000, heartbeatTimeout: 60000 });
    manager.setConnectionProvider(scriptedProvider(plan));
    await manager.start();
    try {
      await manager.connect(peerIdOf('peer-y'));
      expect(manager.getPath(peerIdOf('peer-y'))?.kind).toBe('relay');
      await manager.disconnect(peerIdOf('peer-y'));
      await book.upsert('peer-y', [LAN_A], 'learned'); // 发现层补上 LAN 候选
      await manager.connect(peerIdOf('peer-y'));
      expect(plan.dials).toEqual([RELAY_A, LAN_A]);
      expect(manager.getPath(peerIdOf('peer-y'))).toMatchObject({ kind: 'lan' });
    } finally {
      await manager.stop();
    }
  });
});
