// W-B 端到端：订阅自主（greenfield）
// - 订阅即读：两台设备各自订阅后双向同步，全程零授权记录；
// - 域公告：任一设备声明新域，未订阅端目录可见；订阅后才可读；
// - 热生效：运行期订阅后下一轮同步即收到，无需重启。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mebular } from '../../src/mebular.js';
import { IdentityManager } from '../../src/crypto/IdentityManager.js';
import { InMemoryHub } from '../../src/p2p/transport/InMemoryTransport.js';
import { POLICY_NAMESPACE } from '../../src/sync/grantPolicy.js';

describe('订阅自主（订阅即读 + 域公告 + 热生效）', () => {
  let dir: string;
  let masterKeys: { userMasterKey: Uint8Array; userMasterPrivateKey: CryptoKey };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mebular-sub-autonomy-'));
    const master = await new IdentityManager().generateUserMasterKey();
    masterKeys = { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey };
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 });
  });

  function facade(deviceId: string, hub: InMemoryHub, namespaces: string[]): Mebular {
    return new Mebular({
      storagePath: join(dir, `${deviceId}.jsonl`),
      deviceId,
      encryption: masterKeys,
      network: { enabled: true, provider: hub },
      sync: { autoSync: true, pushOnWrite: true, pushOnWriteThrottleMs: 5, namespaces },
    });
  }

  async function syncBetween(a: Mebular, b: Mebular): Promise<void> {
    const doneA = new Promise((resolve) => a.sync.once('sync-completed', resolve));
    const doneB = new Promise((resolve) => b.sync.once('sync-completed', resolve));
    await b.node!.connectToPeer(a.node!.peerId);
    await Promise.all([doneA, doneB]);
  }

  it('两端各自订阅 → 双向可读；策略区零旧授权事件', async () => {
    const hub = new InMemoryHub();
    const a = facade('device-A', hub, ['notes']);
    const b = facade('device-B', hub, ['notes']);
    await a.initialize();
    await b.initialize();
    try {
      await a.subscribeNamespace('notes');
      await b.subscribeNamespace('notes');

      const fromA = await a.graph.createNode('fact', { text: 'from-A' }, [], { namespace: 'notes' });
      await syncBetween(a, b);
      expect((await b.graph.getNode(fromA.id))?.content).toEqual({ text: 'from-A' });

      const fromB = await b.graph.createNode('fact', { text: 'from-B' }, [], { namespace: 'notes' });
      await syncBetween(a, b);
      expect((await a.graph.getNode(fromB.id))?.content).toEqual({ text: 'from-B' });

      const policyTypes = (await a.eventLog.listEvents({ namespace: POLICY_NAMESPACE })).map((event) => event.type);
      expect(policyTypes).toContain('namespace_subscription');
      expect(policyTypes.some((type) => type.startsWith('namespace_g') || type.startsWith('policy_issuer'))).toBe(false);
      expect(await a.getSubscriptions('device-B')).toContain('notes');
      expect(await b.getSubscriptions('device-A')).toContain('notes');
    } finally {
      await a.shutdown();
      await b.shutdown();
    }
  });

  it('新域公告全网可见（未订阅也显示）；订阅后才可读', async () => {
    const hub = new InMemoryHub();
    const a = facade('device-A', hub, ['notes']);
    const b = facade('device-B', hub, ['notes']);
    await a.initialize();
    await b.initialize();
    try {
      await a.subscribeNamespace('notes');
      await b.subscribeNamespace('notes');
      await syncBetween(a, b);

      await a.subscribeNamespace('ledger');
      const node = await a.graph.createNode('fact', { text: 'ledger-1' }, [], { namespace: 'ledger' });
      await a.declareNamespace({ namespace: 'ledger', note: 'new domain' });
      await syncBetween(a, b);

      // 目录 = 公告 ∪ 本地节点：B 未订阅也能看到
      expect(await b.getNamespaceDirectory()).toContain('ledger');
      expect((await b.getNamespaceSubscriptions('ledger')).subscribers).not.toContain('device-B');
      expect(await b.graph.getNode(node.id)).toBeNull();

      // 订阅热生效：不重启，下一轮同步即收到
      await b.subscribeNamespace('ledger');
      await a.sync.runAntiEntropyCycle();
      await b.sync.runAntiEntropyCycle();
      await syncBetween(a, b);
      expect((await b.graph.getNode(node.id))?.content).toEqual({ text: 'ledger-1' });
    } finally {
      await a.shutdown();
      await b.shutdown();
    }
  });
});
