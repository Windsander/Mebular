// multiaddr 发现桥接单元测试（phase-6-plan 6.4，解除 D19 限制）
//
// 无真实广域网依赖：mock Bonjour 服务 + 假 provider 验证
// 发布侧（TXT addrs）与解析侧（PeerInfo.addresses 优先 multiaddr）。

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import {
  DeviceDiscovery,
  type BonjourService,
  type BonjourServiceInstance,
} from '../../src/p2p/DeviceDiscovery.js';
import { P2PNode, type PeerId } from '../../src/p2p/P2PNetwork.js';
import type { ConnectionProvider } from '../../src/p2p/transport/InMemoryTransport.js';
import { createTestIdentity, generateMasterKeyPair, issueCertificate } from './helpers.js';

function createPeerId(id: string): PeerId {
  return {
    id,
    multihash: new TextEncoder().encode(id),
    pubKey: new TextEncoder().encode(id),
  } as PeerId;
}

interface MockBonjour extends BonjourServiceInstance {
  _addDiscoveredService: (svc: BonjourService) => void;
  _getPublishedServices: () => BonjourService[];
}

function createMockBonjourService(): MockBonjour {
  const discoveredServices: BonjourService[] = [];
  const publishedServices: BonjourService[] = [];
  const callbacks: ((svc: BonjourService) => void)[] = [];
  return {
    publish: jest.fn((options) => {
      publishedServices.push(options as unknown as BonjourService);
    }),
    find: jest.fn((_query: { type: string }, callback: (svc: BonjourService) => void) => {
      callbacks.push(callback);
      discoveredServices.forEach((svc) => callback(svc));
      return { stop: jest.fn() };
    }),
    destroy: jest.fn(),
    _addDiscoveredService: (svc) => {
      discoveredServices.push(svc);
      callbacks.forEach((cb) => cb(svc));
    },
    _getPublishedServices: () => publishedServices,
  };
}

describe('DeviceDiscovery multiaddr 桥接', () => {
  let discovery: DeviceDiscovery;
  let mockService: MockBonjour;
  const localId = createPeerId('local-peer');

  beforeEach(() => {
    mockService = createMockBonjourService();
    discovery = new DeviceDiscovery({ interval: 100, createBonjourService: () => mockService });
  });

  afterEach(async () => {
    if (discovery.isRunning()) await discovery.stop();
  });

  it('发布侧：带 multiaddr 时 TXT 携带逗号分隔 addrs；不带时省略该键', async () => {
    // 带 multiaddr（libp2p 场景）
    discovery.setLocalInfo(localId, 40000, [
      '/ip4/192.168.1.2/tcp/4001/p2p/local-peer',
      '/ip4/10.0.0.5/tcp/4001/p2p/local-peer',
    ]);
    await discovery.start();
    let published = mockService._getPublishedServices();
    expect(published[0]!.txt.addrs).toBe(
      '/ip4/192.168.1.2/tcp/4001/p2p/local-peer,/ip4/10.0.0.5/tcp/4001/p2p/local-peer',
    );
    await discovery.stop();

    // 不带 multiaddr（legacy 场景）：TXT 无 addrs 键，向后兼容
    mockService = createMockBonjourService();
    discovery = new DeviceDiscovery({ interval: 100, createBonjourService: () => mockService });
    discovery.setLocalInfo(localId, 40000);
    await discovery.start();
    published = mockService._getPublishedServices();
    expect(published[0]!.txt.addrs).toBeUndefined();
  });

  it('解析侧：TXT addrs 优先于 mDNS 裸 IP；缺省回退 service.addresses', async () => {
    discovery.setLocalInfo(localId, 40000);
    await discovery.start();

    // 携带 multiaddr 的对端
    mockService._addDiscoveredService({
      name: 'peer-a',
      type: '_mebular._tcp',
      port: 4001,
      txt: { id: 'peer-a', addrs: '/ip4/1.2.3.4/tcp/4001/p2p/peer-a' },
      addresses: ['1.2.3.4'],
    });
    const peerA = discovery.getPeer(createPeerId('peer-a'));
    expect(peerA!.addresses).toEqual(['/ip4/1.2.3.4/tcp/4001/p2p/peer-a']);

    // legacy 对端：无 TXT addrs → 回退裸 IP
    mockService._addDiscoveredService({
      name: 'peer-b',
      type: '_mebular._tcp',
      port: 4002,
      txt: { id: 'peer-b' },
      addresses: ['5.6.7.8'],
    });
    const peerB = discovery.getPeer(createPeerId('peer-b'));
    expect(peerB!.addresses).toEqual(['5.6.7.8']);
  });

  it('重复发现刷新地址（对端重签多地址场景）', async () => {
    discovery.setLocalInfo(localId, 40000);
    await discovery.start();

    mockService._addDiscoveredService({
      name: 'peer-a',
      type: '_mebular._tcp',
      port: 4001,
      txt: { id: 'peer-a', addrs: '/ip4/1.2.3.4/tcp/4001/p2p/peer-a' },
    });
    mockService._addDiscoveredService({
      name: 'peer-a',
      type: '_mebular._tcp',
      port: 4001,
      txt: { id: 'peer-a', addrs: '/ip4/9.9.9.9/tcp/4001/p2p/peer-a' },
    });
    expect(discovery.getDiscoveredPeerCount()).toBe(1);
    expect(discovery.getPeer(createPeerId('peer-a'))!.addresses).toEqual([
      '/ip4/9.9.9.9/tcp/4001/p2p/peer-a',
    ]);
  });
});

describe('P2PNode：provider multiaddr 自动桥接到发现层', () => {
  it('Libp2p 形态 provider 的监听地址随 mDNS TXT 发布；无该能力的 provider 传空', async () => {
    // 带 getMultiaddrs 的假 provider（鸭子类型，同 Libp2pProvider 接缝）
    const addrs = ['/ip4/127.0.0.1/tcp/41001/p2p/node-a'];
    const libp2pLike: ConnectionProvider & { getMultiaddrs(): string[] } = {
      dial: () => Promise.reject(new Error('测试不拨号')),
      onIncomingConnection: () => undefined,
      getMultiaddrs: () => addrs,
    };
    const plainProvider: ConnectionProvider = {
      dial: () => Promise.reject(new Error('测试不拨号')),
      onIncomingConnection: () => undefined,
    };

    const master = await generateMasterKeyPair();
    for (const [provider, expected] of [
      [libp2pLike as ConnectionProvider, addrs.join(',')],
      [plainProvider, undefined],
    ] as const) {
      const mock = createMockBonjourService();
      const testIdentity = await createTestIdentity(`node-${Math.random().toString(36).slice(2)}`);
      await issueCertificate(master.privateKey, testIdentity);
      const node = new P2PNode({
        identity: {
          deviceId: testIdentity.identity.deviceId,
          devicePublicKey: testIdentity.identity.devicePublicKey,
          devicePrivateKey: testIdentity.identity.devicePrivateKey,
          certificate: testIdentity.identity.certificate!,
        },
        provider,
        bonjourFactory: () => mock,
      });
      await node.start();
      try {
        const published = mock._getPublishedServices();
        expect(published).toHaveLength(1);
        expect(published[0]!.txt.addrs).toBe(expected);
      } finally {
        await node.stop();
      }
    }
  });
});
