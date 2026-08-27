// P2P 网络端到端集成测试
//
// 两个真实 P2PNode（真实 Ed25519 身份与证书）在同进程内完成：
//   mDNS 互相发现 → 拨号连接 → 双向挑战-应答认证 → X25519+AES-GCM 加密通信
// 传输使用 InMemoryHub，mDNS 使用共享总线模拟——链路语义完整，无网络依赖。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { P2PNode } from '../../src/p2p/P2PNetwork.js';
import { InMemoryHub } from '../../src/p2p/transport/InMemoryTransport.js';
import type {
  BonjourService,
  BonjourServiceInstance,
} from '../../src/p2p/DeviceDiscovery.js';
import {
  createTestIdentity,
  generateMasterKeyPair,
  issueCertificate,
  masterPublicKeyBytes,
  waitFor,
  type TestIdentity,
} from '../p2p/helpers.js';

/** 共享 mDNS 总线：publish 的服务立即广播给所有 find 订阅者 */
class MockBonjourBus {
  private services: BonjourService[] = [];
  private finders: Array<(svc: BonjourService) => void> = [];

  createInstance(): BonjourServiceInstance {
    return {
      publish: (options) => {
        const service: BonjourService = {
          name: options.name,
          type: options.type,
          port: options.port,
          txt: options.txt ?? {},
          addresses: ['memory://local'],
        };
        this.services.push(service);
        for (const finder of [...this.finders]) {
          finder(service);
        }
      },
      find: (_query, callback) => {
        this.finders.push(callback);
        for (const service of this.services) {
          callback(service);
        }
        return {
          stop: () => {
            this.finders = this.finders.filter((f) => f !== callback);
          },
        };
      },
      destroy: () => {},
    };
  }
}

interface TestNode {
  node: P2PNode;
  identity: TestIdentity;
}

async function createNode(
  hub: InMemoryHub,
  bus: MockBonjourBus,
  deviceId: string,
  master: CryptoKeyPair,
  trustMaster: CryptoKeyPair,
): Promise<TestNode> {
  const identity = await createTestIdentity(deviceId);
  // 证书由「签发方」master 签署；节点信任「trustMaster」的主公钥
  await issueCertificate(master.privateKey, identity);
  const node = new P2PNode({
    identity: {
      deviceId: identity.identity.deviceId,
      devicePublicKey: identity.identity.devicePublicKey,
      devicePrivateKey: identity.identity.devicePrivateKey,
      certificate: identity.identity.certificate!,
    },
    userMasterPublicKey: await masterPublicKeyBytes(trustMaster),
    provider: hub,
    bonjourFactory: () => bus.createInstance(),
  });
  return { node, identity };
}

describe('P2P Network Integration', () => {
  let hub: InMemoryHub;
  let bus: MockBonjourBus;
  let master: CryptoKeyPair;
  let nodeA: TestNode;
  let nodeB: TestNode;

  beforeEach(async () => {
    hub = new InMemoryHub();
    bus = new MockBonjourBus();
    master = await generateMasterKeyPair();
    nodeA = await createNode(hub, bus, 'device-A', master, master);
    nodeB = await createNode(hub, bus, 'device-B', master, master);
  });

  afterEach(async () => {
    for (const { node } of [nodeA, nodeB]) {
      if (node.isRunning()) {
        await node.stop();
      }
    }
  });

  it('两个节点通过 mDNS 互相发现', async () => {
    await nodeA.node.start();
    await nodeB.node.start();

    await waitFor(() => nodeA.node.getDiscovery()?.getPeer(nodeB.node.peerId) != null);
    await waitFor(() => nodeB.node.getDiscovery()?.getPeer(nodeA.node.peerId) != null);

    const peerInfo = nodeA.node.getDiscovery()!.getPeer(nodeB.node.peerId)!;
    expect(peerInfo.name).toContain('mebular-device');
  });

  it('连接后完成双向认证，双端连接均标记已认证', async () => {
    await nodeA.node.start();
    await nodeB.node.start();

    const connA = await nodeA.node.connectToPeer(nodeB.node.peerId);
    expect(connA.isAuthenticated()).toBe(true);

    await waitFor(
      () => nodeB.node.getConnectionManager().getConnection(nodeA.node.peerId) != null,
    );
    const connB = nodeB.node.getConnectionManager().getConnection(nodeA.node.peerId)!;
    expect(connB.isAuthenticated()).toBe(true);
  });

  it('认证后双端加密收发消息', async () => {
    await nodeA.node.start();
    await nodeB.node.start();

    const connA = await nodeA.node.connectToPeer(nodeB.node.peerId);
    await waitFor(
      () => nodeB.node.getConnectionManager().getConnection(nodeA.node.peerId) != null,
    );
    const connB = nodeB.node.getConnectionManager().getConnection(nodeA.node.peerId)!;

    // A → B
    const iterB = nodeB.node.receiveMessage(connB)[Symbol.asyncIterator]();
    await nodeA.node.sendMessage(connA, new TextEncoder().encode('第一條記憶'));
    const first = await iterB.next();
    expect(new TextDecoder().decode(first.value)).toBe('第一條記憶');

    // B → A
    const iterA = nodeA.node.receiveMessage(connA)[Symbol.asyncIterator]();
    await nodeB.node.sendMessage(connB, new TextEncoder().encode('收到'));
    const reply = await iterA.next();
    expect(new TextDecoder().decode(reply.value)).toBe('收到');
  });

  it('证书由其他主密钥签发的节点无法通过认证', async () => {
    const otherMaster = await generateMasterKeyPair();
    // Eve 的证书由 otherMaster 签发（不属于本用户），但 Eve 自己信任 otherMaster
    const eve = await createNode(hub, bus, 'device-E', otherMaster, otherMaster);

    await nodeA.node.start();
    await eve.node.start();

    await expect(nodeA.node.connectToPeer(eve.node.peerId)).rejects.toThrow();

    await eve.node.stop();
  });

  it('未启动时主动操作报错', async () => {
    await expect(nodeA.node.connectToPeer(nodeB.node.peerId)).rejects.toThrow('not running');
  });

  it('stop 清理组件状态', async () => {
    await nodeA.node.start();
    await nodeB.node.start();
    await nodeA.node.connectToPeer(nodeB.node.peerId);

    await nodeA.node.stop();

    expect(nodeA.node.isRunning()).toBe(false);
    expect(nodeA.node.getConnectionManager().isRunning()).toBe(false);
    expect(nodeA.node.getHandshake().isRunning()).toBe(false);
    expect(nodeA.node.getDiscovery()?.isRunning() ?? false).toBe(false);
  });
});
