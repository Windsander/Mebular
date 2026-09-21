// C1 · 拨号策略引擎单测（ConnectionManager × EndpointBook）
// 判别性锚点：无显式地址 → 用簿内地址；首候选失败 → 次候选；relay→direct 升级；
// 全失败 → 指数退避重试；network 关闭 → no-op；hints 不改变授权。
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectionManager } from '../../src/p2p/connection/ConnectionManager.js';
import { EndpointBook, InMemoryEndpointStore, type PathState } from '../../src/p2p/connection/EndpointBook.js';
import { P2PNode } from '../../src/p2p/P2PNetwork.js';
import type { Connection, PeerId } from '../../src/p2p/P2PNetwork.js';
import type { ConnectionProvider } from '../../src/p2p/transport/InMemoryTransport.js';
import { Mebular } from '../../src/mebular.js';
import { IdentityManager } from '../../src/crypto/IdentityManager.js';
import { createTestIdentity, type TestIdentity } from './helpers.js';

/** 脚本化 provider：按地址决定成功/失败，并记录拨号序列（确定性、无网络）。 */
function scriptedProvider(peerId: PeerId, plan: { fail: Set<string>; dials: string[] }): ConnectionProvider {
  return {
    dial: async (_peer: PeerId, address?: string) => {
      const key = address ?? '<undefined>';
      plan.dials.push(key);
      if (plan.fail.has(key)) throw new Error(`dial failed: ${key}`);
      return {
        peerId,
        state: 'connected' as const,
        remoteAddress: key,
        send: async () => undefined,
        receive: async function* () { /* 空流 */ },
        close: async () => undefined,
        authenticate: async () => true,
        isAuthenticated: () => true,
      } as unknown as Connection;
    },
    onIncomingConnection: () => undefined,
  };
}

describe('C1 拨号策略', () => {
  let peer: TestIdentity;
  let target: PeerId;

  beforeEach(async () => {
    peer = await createTestIdentity('device-remote');
    target = peer.peerId;
  });

  it('无显式地址 → 使用簿内地址（direct 优先）', async () => {
    const book = new EndpointBook({ store: new InMemoryEndpointStore() });
    await book.upsert(target.id, [
      '/ip4/203.0.113.9/tcp/4001/p2p-circuit/p2p/r',
      '/ip4/198.51.100.7/tcp/4001/p2p/' + target.id,
    ], 'paired');
    const plan = { fail: new Set<string>(), dials: [] as string[] };
    const manager = new ConnectionManager({ endpointBook: book, connectTimeout: 500, keepAliveInterval: 60000, heartbeatTimeout: 60000 });
    manager.setConnectionProvider(scriptedProvider(target, plan));
    await manager.start();
    try {
      await manager.connect(target);
      expect(plan.dials).toEqual(['/ip4/198.51.100.7/tcp/4001/p2p/' + target.id]);
      expect(manager.getPath(target)).toMatchObject({ kind: 'direct' });
    } finally {
      await manager.stop();
    }
  });

  it('首候选失败 → 自动尝试次候选并记录路径（path/changed）', async () => {
    const book = new EndpointBook({ store: new InMemoryEndpointStore() });
    const first = '/ip4/198.51.100.1/tcp/4001/p2p/' + target.id;
    const second = '/ip4/192.168.1.30/tcp/4001/p2p/' + target.id;
    await book.upsert(target.id, [first, second], 'paired');
    const plan = { fail: new Set<string>([first]), dials: [] as string[] };
    const manager = new ConnectionManager({ endpointBook: book, connectTimeout: 500, keepAliveInterval: 60000, heartbeatTimeout: 60000 });
    manager.setConnectionProvider(scriptedProvider(target, plan));
    const paths: Array<PathState | null> = [];
    book.on('path-changed', ({ path }) => paths.push(path));
    await manager.start();
    try {
      await manager.connect(target);
      expect(plan.dials).toEqual([first, second]);
      expect(book.getCandidate(target.id, first)?.lastError).toBe(`dial failed: ${first}`);
      expect(manager.getPath(target)).toMatchObject({ address: second, kind: 'lan' });
      expect(paths.some((p) => p?.address === second)).toBe(true);
    } finally {
      await manager.stop();
    }
  });

  it('relay 成功后 direct 可达 → 路径升级为 direct', async () => {
    const book = new EndpointBook({ store: new InMemoryEndpointStore() });
    const relay = '/ip4/198.51.100.9/tcp/4001/p2p/relay/p2p-circuit/p2p/' + target.id;
    const direct = '/ip4/203.0.113.10/tcp/4001/p2p/' + target.id;
    await book.upsert(target.id, [relay], 'paired');
    const plan = { fail: new Set<string>(), dials: [] as string[] };
    const manager = new ConnectionManager({ endpointBook: book, connectTimeout: 500, keepAliveInterval: 60000, heartbeatTimeout: 60000 });
    manager.setConnectionProvider(scriptedProvider(target, plan));
    await manager.start();
    try {
      await manager.connect(target);
      expect(manager.getPath(target)?.kind).toBe('relay');
      await manager.disconnect(target);

      await book.upsert(target.id, [direct], 'learned');
      await manager.connect(target);
      expect(plan.dials).toEqual([relay, direct]);
      expect(manager.getPath(target)).toMatchObject({ kind: 'direct', address: direct });
    } finally {
      await manager.stop();
    }
  });

  it('全候选失败 → 指数退避重试（timer 到期后自动重拨成功）', async () => {
    const book = new EndpointBook({ store: new InMemoryEndpointStore() });
    const bad = '/ip4/198.51.100.1/tcp/4001/p2p/' + target.id;
    const good = '/ip4/198.51.100.2/tcp/4001/p2p/' + target.id;
    await book.upsert(target.id, [bad], 'paired');
    const plan = { fail: new Set<string>([bad]), dials: [] as string[] };
    const manager = new ConnectionManager({
      endpointBook: book,
      connectTimeout: 200,
      dialBackoffBaseMs: 20,
      dialBackoffMaxMs: 40,
      keepAliveInterval: 60000,
      heartbeatTimeout: 60000,
    });
    manager.setConnectionProvider(scriptedProvider(target, plan));
    await manager.start();
    try {
      await expect(manager.connect(target)).rejects.toThrow('dial failed');
      const backoff = manager.getBackoff(target);
      expect(backoff).toMatchObject({ attempts: 1, pending: true });

      // 退避到期前补上可用候选：重试应自动成功并清空退避
      await book.upsert(target.id, [good], 'learned');
      await new Promise((resolve) => setTimeout(resolve, 80));
      // 重试时新加入的 good 候选（更晚 addedAt）优先于旧 bad → 直接成功
      expect(plan.dials).toEqual([bad, good]);
      expect(manager.getBackoff(target)).toBeNull();
      expect(manager.getPath(target)).toMatchObject({ address: good });
    } finally {
      await manager.stop();
    }
  });

  it('dialBackoffBaseMs=0 → 全失败不自动重试', async () => {
    const book = new EndpointBook({ store: new InMemoryEndpointStore() });
    const bad = '/ip4/198.51.100.1/tcp/4001/p2p/' + target.id;
    await book.upsert(target.id, [bad], 'paired');
    const plan = { fail: new Set<string>([bad]), dials: [] as string[] };
    const manager = new ConnectionManager({ endpointBook: book, connectTimeout: 200, dialBackoffBaseMs: 0, keepAliveInterval: 60000, heartbeatTimeout: 60000 });
    manager.setConnectionProvider(scriptedProvider(target, plan));
    await manager.start();
    try {
      await expect(manager.connect(target)).rejects.toThrow('dial failed');
      expect(manager.getBackoff(target)).toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(plan.dials).toEqual([bad]);
    } finally {
      await manager.stop();
    }
  });

  it('无端点簿时保持历史行为（单地址拨号，含 undefined）', async () => {
    const plan = { fail: new Set<string>(), dials: [] as string[] };
    const manager = new ConnectionManager({ connectTimeout: 500, keepAliveInterval: 60000, heartbeatTimeout: 60000 });
    manager.setConnectionProvider(scriptedProvider(target, plan));
    await manager.start();
    try {
      await manager.connect(target);
      expect(plan.dials).toEqual(['<undefined>']);
      await manager.disconnect(target);
      await manager.connect(target, '/ip4/198.51.100.3/tcp/4001/p2p/x');
      expect(plan.dials).toEqual(['<undefined>', '/ip4/198.51.100.3/tcp/4001/p2p/x']);
    } finally {
      await manager.stop();
    }
  });
});

describe('C1 端点簿接缝 · P2PNode', () => {
  it('P2PNode 暴露 getPath/getCandidates，并把 book 转交 ConnectionManager', async () => {
    const local = await createTestIdentity('device-local');
    const book = new EndpointBook({ store: new InMemoryEndpointStore() });
    await book.upsert('device-remote-key', ['/ip4/198.51.100.4/tcp/4001/p2p/peer'], 'paired');
    const node = new P2PNode({
      identity: {
        deviceId: local.identity.deviceId,
        devicePublicKey: local.identity.devicePublicKey,
        devicePrivateKey: local.identity.devicePrivateKey,
        certificate: { deviceId: local.identity.deviceId, devicePublicKey: '', createdAt: 0, metadata: {}, signature: '' },
      },
      endpointBook: book,
      autoConnect: true,
      config: { maxConnections: 2 },
    });
    expect(node.getEndpointBook()).toBe(book);
    expect(node.getConnectionManager().getEndpointBook()).toBe(book);
    expect(node.getCandidates({ multihash: new Uint8Array(), pubKey: new Uint8Array(), id: 'device-remote-key' })).toHaveLength(1);
    expect(node.getPath({ multihash: new Uint8Array(), pubKey: new Uint8Array(), id: 'device-remote-key' })).toBeNull();
  });
});

describe('C1 门面（Mebular）· 离线 no-op 与授权不变', () => {
  let dir: string;
  let master: { publicKey: Uint8Array; privateKey: CryptoKey };
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mebular-connect-'));
    master = await new IdentityManager().generateUserMasterKey();
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it('network 关闭 → 地址簿 no-op（不加载/不落盘/不写 hints）', async () => {
    const store = new InMemoryEndpointStore();
    const m = new Mebular({
      storagePath: join(dir, 'store.jsonl'),
      deviceId: 'device-off',
      encryption: { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey },
      network: { enabled: false, endpoints: { 'device-B': ['/ip4/198.51.100.9/tcp/4001/p2p/b'] }, endpointStore: store },
      sync: { autoSync: false },
    });
    await m.initialize();
    try {
      expect(m.endpointBook).toBeNull();
      expect(m.getPeerPath('device-B')).toBeNull();
      expect(await m.addPeerEndpoints('device-B', ['/ip4/198.51.100.9/tcp/4001/p2p/b'], 'paired')).toBe(0);
      expect(await store.load()).toEqual({});
    } finally {
      await m.shutdown();
    }
  });

  it('network.endpoints 注入不改变授权（hints 只是候选地址）', async () => {
    // 避免真实 libp2p 依赖：直接注入 InMemoryHub 作为 provider（等价传输）
    const { InMemoryHub } = await import('../../src/p2p/transport/InMemoryTransport.js');
    const hub = new InMemoryHub();
    const m = new Mebular({
      storagePath: join(dir, 'store.jsonl'),
      deviceId: 'device-hints',
      encryption: { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey },
      network: {
        enabled: true,
        provider: hub.forPeer({ multihash: new Uint8Array(), pubKey: new Uint8Array(), id: 'local' } as PeerId),
        endpoints: { 'device-B': ['/ip4/198.51.100.9/tcp/4001/p2p/b'] },
        endpointStore: new InMemoryEndpointStore(),
      },
      sync: { autoSync: false },
    });
    await m.initialize();
    try {
      // hints 进了地址簿（配对来源）……
      expect(m.getPeerPath('device-B')).toBeNull();
      expect(m.endpointBook).not.toBeNull();
      // ……但完全不影响授权判定：未授权设备仍为空集（默认拒绝）
      expect(await m.getEffectiveNamespaces('device-B')).toEqual([]);
    } finally {
      await m.shutdown();
    }
  });
});
