// 初始同步快照（G4）：大图下用物化快照替代全量事件重放。
//
// 对照两条路径：
//   - 无阈值：新对端逐事件接收（receivedEvents = 事件数）；
//   - 有阈值且对端空时钟：发送物化快照（sentEvents = 0，snapshotSent/Applied = 实体数）。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Mebular } from '../../src/mebular.js';
import { IdentityManager } from '../../src/crypto/IdentityManager.js';
import { InMemoryHub } from '../../src/p2p/transport/InMemoryTransport.js';
import type { SyncResult } from '../../src/sync/syncmgr/SyncManager.js';

describe('G4 初始同步快照', () => {
  let dir: string;
  let hub: InMemoryHub;
  let masterKeys: { userMasterKey: Uint8Array; userMasterPrivateKey: CryptoKey };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mebular-snapshot-'));
    hub = new InMemoryHub();
    const master = await new IdentityManager().generateUserMasterKey();
    masterKeys = { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makeFacade(deviceId: string, snapshotThreshold?: number): Mebular {
    return new Mebular({
      storagePath: join(dir, `${deviceId}.jsonl`),
      deviceId,
      encryption: masterKeys,
      network: { enabled: true, provider: hub },
      sync: { autoSync: true, ...(snapshotThreshold !== undefined ? { snapshotThreshold } : {}) },
    });
  }

  async function seed(app: Mebular, count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      await app.graph.createNode('fact', { text: `m${i}` });
    }
  }

  async function syncBetween(a: Mebular, b: Mebular): Promise<{ aResult: SyncResult; bResult: SyncResult }> {
    const aSynced = new Promise<SyncResult>((resolve) => a.sync.once('sync-completed', resolve));
    const bSynced = new Promise<SyncResult>((resolve) => b.sync.once('sync-completed', resolve));
    await b.node!.connectToPeer(a.node!.peerId);
    const [aResult, bResult] = await Promise.all([aSynced, bSynced]);
    return { aResult, bResult };
  }

  it('达阈值时走快照：sentEvents=0、snapshotSent/Applied=实体数、对端视图完整', async () => {
    const a = makeFacade('device-A', 50);
    const b = makeFacade('device-B');
    await a.initialize();
    await b.initialize();
    await seed(a, 120);

    const { aResult, bResult } = await syncBetween(a, b);

    expect(await b.graph.listNodes()).toHaveLength(120);
    expect(aResult.snapshotSent).toBe(120);
    expect(aResult.sentEvents).toBe(0);
    expect(bResult.snapshotApplied).toBe(120);
    expect(bResult.receivedEvents).toBe(0);

    await a.shutdown();
    await b.shutdown();
  });

  it('未达阈值/未启用时仍走事件流（对照）', async () => {
    const a = makeFacade('device-A');
    const c = makeFacade('device-C');
    await a.initialize();
    await c.initialize();
    await seed(a, 30);

    const { aResult, bResult } = await syncBetween(a, c);

    expect(await c.graph.listNodes()).toHaveLength(30);
    expect(aResult.snapshotSent).toBeUndefined();
    expect(aResult.sentEvents).toBe(30);
    expect(bResult.receivedEvents).toBe(30);

    await a.shutdown();
    await c.shutdown();
  });
});
