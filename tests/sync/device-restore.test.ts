// W-B：移出 / 恢复 / 恢复纪元 E-1（端到端）
// - 移出只作用于本人：A 移出 B 后不再向 B 供给，B 的署名事件在 A 入站被隔离；
// - 恢复：device_restore 后 B 重新可取策略事件；
// - E-1：B 在恢复前的订阅不复活，必须重新订阅；之后数据恢复流动。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mebular } from '../../src/mebular.js';
import { IdentityManager } from '../../src/crypto/IdentityManager.js';
import { InMemoryHub } from '../../src/p2p/transport/InMemoryTransport.js';

describe('移出 / 恢复 / E-1', () => {
  let dir: string;
  let masterKeys: { userMasterKey: Uint8Array; userMasterPrivateKey: CryptoKey };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mebular-restore-'));
    const master = await new IdentityManager().generateUserMasterKey();
    masterKeys = { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey };
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 });
  });

  function facade(deviceId: string, hub: InMemoryHub): Mebular {
    return new Mebular({
      storagePath: join(dir, `${deviceId}.jsonl`),
      deviceId,
      encryption: masterKeys,
      network: { enabled: true, provider: hub },
      sync: { autoSync: true, pushOnWrite: true, pushOnWriteThrottleMs: 5, namespaces: ['notes'] },
    });
  }

  async function syncBetween(a: Mebular, b: Mebular): Promise<void> {
    const doneA = new Promise((resolve) => a.sync.once('sync-completed', resolve));
    const doneB = new Promise((resolve) => b.sync.once('sync-completed', resolve));
    await b.node!.connectToPeer(a.node!.peerId);
    await Promise.all([doneA, doneB]);
  }

  it('移出 B → B 停止供给；restore 后旧订阅不复活，重新订阅后恢复', async () => {
    const hub = new InMemoryHub();
    const a = facade('device-A', hub);
    const b = facade('device-B', hub);
    await a.initialize();
    await b.initialize();
    try {
      await a.subscribeNamespace('notes');
      await b.subscribeNamespace('notes');
      const first = await a.graph.createNode('fact', { text: 'before-remove' }, [], { namespace: 'notes' });
      await syncBetween(a, b);
      expect(await b.graph.getNode(first.id)).not.toBeNull();

      // 移出 B（作者级）
      await a.revokeDevice({ subject: 'device-B', note: 'test remove' });
      await syncBetween(a, b);
      expect(await a.getBlockedDevices()).toContain('device-B');
      expect(await b.getBlockedDevices()).toContain('device-B');

      const hidden = await a.graph.createNode('fact', { text: 'while-removed' }, [], { namespace: 'notes' });
      await a.sync.runAntiEntropyCycle();
      await b.sync.runAntiEntropyCycle();
      await syncBetween(a, b);
      expect(await b.graph.getNode(hidden.id)).toBeNull();

      // B 在移出期间写入：A 入站隔离（不入库）
      const bEvent = await b.graph.createNode('fact', { text: 'from-removed-B' }, [], { namespace: 'notes' });
      await syncBetween(a, b);
      expect(await a.graph.getNode(bEvent.id)).toBeNull();

      // 恢复 B；旧订阅处于恢复位次之前 → E-1 不复活
      await a.restoreDevice({ subject: 'device-B', note: 'test restore' });
      await syncBetween(a, b);
      expect(await a.getBlockedDevices()).not.toContain('device-B');
      expect(await b.getBlockedDevices()).not.toContain('device-B');
      expect(await a.getNamespaceSubscriptions('notes')).toMatchObject({ active: true });
      expect((await a.getNamespaceSubscriptions('notes')).subscribers).not.toContain('device-B');

      // 重新订阅后恢复供给
      await b.subscribeNamespace('notes');
      await syncBetween(a, b);
      expect((await a.getNamespaceSubscriptions('notes')).subscribers).toContain('device-B');
      expect(await b.graph.getNode(hidden.id)).not.toBeNull();
    } finally {
      await a.shutdown();
      await b.shutdown();
    }
  });
});
