// L4/L5：WAN 准备——确定性故障注入（拨号丢包/延迟）+ 加固（对端白名单）。
// 不依赖真实网络：复用 InMemoryHub（ConnectionProvider 接缝）；丢包/延迟按确定性计数注入。
// 连接数上限、帧大小上限的既有测试见 tests/p2p/ConnectionManager.test.ts 与 Libp2pProvider.test.ts。

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mebular } from '../../src/mebular.js';
import { IdentityManager } from '../../src/crypto/IdentityManager.js';
import { InMemoryHub } from '../../src/p2p/transport/InMemoryTransport.js';
import type { Connection, PeerId } from '../../src/p2p/P2PNetwork.js';
import type { ConnectionProvider } from '../../src/p2p/transport/InMemoryTransport.js';

jest.setTimeout(30000);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => Promise<boolean>, timeoutMs: number, pollMs = 15): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(pollMs);
  }
  return fn();
}

/** 确定性故障注入：每 `failEvery` 次拨号丢一次；每次拨号前延迟 `delayMs`。 */
class LossyProvider implements ConnectionProvider {
  readonly stats = { dials: 0, drops: 0 };
  constructor(private readonly inner: ConnectionProvider, private readonly failEvery: number, private readonly delayMs = 0) {}
  /** 支持 InMemoryHub 的按身份绑定（bindProvider 会优先调用 forPeer）。 */
  forPeer(peerId: PeerId): ConnectionProvider {
    const inner = (this.inner as ConnectionProvider & { forPeer?: (id: PeerId) => ConnectionProvider }).forPeer?.(peerId) ?? this.inner;
    const bound = new LossyProvider(inner, this.failEvery, this.delayMs);
    // 共享计数器（绑定视图被 ConnectionManager 实际使用）
    (bound as unknown as { stats: { dials: number; drops: number } }).stats = this.stats;
    return bound;
  }
  async dial(peerId: PeerId, address?: string): Promise<Connection> {
    this.stats.dials += 1;
    if (this.delayMs > 0) await sleep(this.delayMs);
    if ((this.stats.dials - 1) % this.failEvery === 0) {
      this.stats.drops += 1;
      throw new Error('injected dial loss');
    }
    return this.inner.dial(peerId, address);
  }
  onIncomingConnection(callback: (conn: Connection) => void): void {
    this.inner.onIncomingConnection(callback);
  }
}

describe('L4/L5 WAN 加固与故障注入', () => {
  let dir: string;
  let masterKeys: { userMasterKey: Uint8Array; userMasterPrivateKey: CryptoKey };
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mebular-wan-harden-'));
    const master = await new IdentityManager().generateUserMasterKey();
    masterKeys = { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey };
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 });
  });

  function facade(deviceId: string, provider: ConnectionProvider, sync: Record<string, unknown> = {}): Mebular {
    return new Mebular({
      storagePath: join(dir, `${deviceId}.jsonl`),
      deviceId,
      encryption: masterKeys,
      network: { enabled: true, provider },
      sync: { autoSync: true, ...sync },
    });
  }

  it('L4 故障注入：确定性拨号丢包/延迟下仍在有界时间内收敛；丢包可观测', async () => {
    const hub = new InMemoryHub();
    const lossy = new LossyProvider(hub, 3, 5); // 每 3 次丢 1 次
    const a = facade('device-A', lossy, { peerNamespacePolicy: { 'device-B': ['default'] } });
    const b = facade('device-B', hub, { peerNamespacePolicy: { 'device-A': ['default'] } });
    await a.initialize();
    await b.initialize();
    const node = await a.graph.createNode('fact', { text: 'under-loss' }, [], { namespace: 'default' });

    // 有界重试直到收敛（丢包被观测，不能静默）
    let synced = false;
    for (let attempt = 0; attempt < 10 && !synced; attempt++) {
      try {
        const aSynced = new Promise((r) => a.sync.once('sync-completed', r));
        const bSynced = new Promise((r) => b.sync.once('sync-completed', r));
        await a.node!.connectToPeer(b.node!.peerId);
        await Promise.all([aSynced, bSynced]);
      } catch {
        // 注入的拨号失败：重试
      }
      synced = await waitFor(async () => (await b.graph.getNode(node.id)) !== null, 2000);
    }
    expect(synced).toBe(true);
    expect(lossy.stats.drops).toBeGreaterThan(0); // 丢包确实发生且被观测
    expect(lossy.stats.dials).toBeLessThan(30); // 有界
    await a.shutdown();
    await b.shutdown();
  });

  it('L5 加固：sync.peerWhitelist 拒绝未列白名单的对端（默认拒绝）', async () => {
    const hub = new InMemoryHub();
    // A 只允许 device-C；device-B 不在白名单 → 会话被忽略
    const a = facade('device-A', hub, { peerNamespacePolicy: { 'device-B': ['default'] }, peerWhitelist: ['device-C'] });
    const b = facade('device-B', hub, { peerNamespacePolicy: { 'device-A': ['default'] } });
    await a.initialize();
    await b.initialize();
    const node = await a.graph.createNode('fact', { text: 'blocked' }, [], { namespace: 'default' });
    await b.node!.connectToPeer(a.node!.peerId);
    const leaked = await waitFor(async () => (await b.graph.getNode(node.id)) !== null, 1500);
    expect(leaked).toBe(false);
    await a.shutdown();
    await b.shutdown();
  });

  it('L5 加固：白名单包含对端时正常同步（对照）', async () => {
    const hub = new InMemoryHub();
    const a = facade('device-A', hub, { peerNamespacePolicy: { 'device-B': ['default'] }, peerWhitelist: ['device-B'] });
    const b = facade('device-B', hub, { peerNamespacePolicy: { 'device-A': ['default'] } });
    await a.initialize();
    await b.initialize();
    const node = await a.graph.createNode('fact', { text: 'allowed' }, [], { namespace: 'default' });
    const aSynced = new Promise((r) => a.sync.once('sync-completed', r));
    const bSynced = new Promise((r) => b.sync.once('sync-completed', r));
    await b.node!.connectToPeer(a.node!.peerId);
    await Promise.all([aSynced, bSynced]);
    expect(await b.graph.getNode(node.id)).not.toBeNull();
    await a.shutdown();
    await b.shutdown();
  });
});
