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

  async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 10_000, pollMs = 100): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return true;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return predicate();
  }

  async function syncOnce(a: Mebular, b: Mebular, timeoutMs = 3_000): Promise<void> {
    let doneA: () => void = () => undefined;
    let doneB: () => void = () => undefined;
    const completedA = new Promise<void>((resolve) => { doneA = resolve; });
    const completedB = new Promise<void>((resolve) => { doneB = resolve; });
    a.sync.once('sync-completed', doneA);
    b.sync.once('sync-completed', doneB);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // 有在线 peer 时由 anti-entropy 触发；离线时 connectToPeer 建连触发。
      await a.sync.runAntiEntropyCycle();
      await b.sync.runAntiEntropyCycle();
      await b.node!.connectToPeer(a.node!.peerId);
      await Promise.race([
        Promise.all([completedA, completedB]),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      a.sync.removeListener('sync-completed', doneA);
      b.sync.removeListener('sync-completed', doneB);
    }
  }

  async function syncUntil(a: Mebular, b: Mebular, predicate: () => Promise<boolean>, timeoutMs = 15_000): Promise<boolean> {
    return waitFor(async () => {
      // 每轮都显式建/复连并完成一轮同步；不依赖常驻连接是否仍被保留。
      await syncOnce(a, b);
      return predicate();
    }, timeoutMs, 150);
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

      // 目录 = 公告 ∪ 本地节点：B 未订阅也能看到。
      // 单次 sync-completed 不代表该轮公告已应用；有界重试直到目录收敛。
      const announced = await syncUntil(a, b, async () => (await b.getNamespaceDirectory()).includes('ledger'), 15_000);
      expect(announced).toBe(true);
      expect((await b.getNamespaceSubscriptions('ledger')).subscribers).not.toContain('device-B');
      expect(await b.graph.getNode(node.id)).toBeNull();

      // 订阅热生效：策略记录必须先到 A；每轮显式同步，避免依赖 nudge 已在 CI 慢时序下送达。
      await b.subscribeNamespace('ledger');
      const policyArrived = await waitFor(async () => {
        await syncOnce(a, b);
        return (await a.getSubscriptions('device-B')).includes('ledger');
      }, 10_000, 200);
      if (!policyArrived) throw new Error(`B 的 ledger 订阅未到达 A：${JSON.stringify(await a.getSubscriptions('device-B'))}`);

      const delivered = await syncUntil(a, b, async () => (await b.graph.getNode(node.id)) !== null, 15_000);
      if (!delivered) throw new Error('ledger-1 未在超时内送达 B（检查订阅热生效/nudge）');
      expect((await b.graph.getNode(node.id))?.content).toEqual({ text: 'ledger-1' });
    } finally {
      await a.shutdown();
      await b.shutdown();
    }
  }, 30_000);
});
