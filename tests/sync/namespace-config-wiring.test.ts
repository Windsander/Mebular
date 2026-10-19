// namespace 配置在 Mebular 门面上的装配（sync.namespaces 热订阅）。
//
// 校验 mebular.ts 把配置正确透传到 SyncManager，并端到端生效。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Mebular } from '../../src/mebular.js';
import { IdentityManager } from '../../src/crypto/IdentityManager.js';
import { InMemoryHub } from '../../src/p2p/transport/InMemoryTransport.js';
import type { SyncResult } from '../../src/sync/syncmgr/SyncManager.js';

describe('namespace 配置装配', () => {
  let dir: string;
  let masterKeys: { userMasterKey: Uint8Array; userMasterPrivateKey: CryptoKey };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mebular-ns-config-'));
    const master = await new IdentityManager().generateUserMasterKey();
    masterKeys = { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makeFacade(deviceId: string, hub: InMemoryHub, sync: Record<string, unknown> = {}): Mebular {
    return new Mebular({
      storagePath: join(dir, `${deviceId}.jsonl`),
      deviceId,
      encryption: masterKeys,
      network: { enabled: true, provider: hub },
      sync: { autoSync: true, ...sync },
    });
  }

  async function syncBetween(a: Mebular, b: Mebular): Promise<[SyncResult, SyncResult]> {
    const aSynced = new Promise<SyncResult>((resolve) => a.sync.once('sync-completed', resolve));
    const bSynced = new Promise<SyncResult>((resolve) => b.sync.once('sync-completed', resolve));
    await b.node!.connectToPeer(a.node!.peerId);
    return Promise.all([aSynced, bSynced]);
  }

  it('sync.namespaces：对端订阅只影响收到的分区', async () => {
    const hub = new InMemoryHub();
    const a = makeFacade('device-A', hub, { namespaces: ['nsA', 'nsB'] });
    const b = makeFacade('device-B', hub, { namespaces: ['nsA'] });
    await a.initialize();
    await b.initialize();
    await a.graph.createNode('fact', { text: 'a' }, [], { namespace: 'nsA' });
    await a.graph.createNode('fact', { text: 'b' }, [], { namespace: 'nsB' });

    await syncBetween(a, b);

    expect((await b.graph.listNodes()).map((n) => n.namespace)).toEqual(['nsA']);
    await a.shutdown();
    await b.shutdown();
  });

  it('本机订阅：供给端只发自己订阅的分区', async () => {
    const hub = new InMemoryHub();
    const a = makeFacade('device-A', hub, { namespaces: ['nsA'] });
    const b = makeFacade('device-B', hub);
    await a.initialize();
    await b.initialize();
    await a.graph.createNode('fact', { text: 'a' }, [], { namespace: 'nsA' });
    await a.graph.createNode('fact', { text: 'b' }, [], { namespace: 'nsB' });

    await syncBetween(a, b);

    expect((await b.graph.listNodes()).map((n) => n.namespace)).toEqual(['nsA']);
    await a.shutdown();
    await b.shutdown();
  });

  it('同版本两端在显式授权 + 显式订阅下正常同步（端到端互通）', async () => {
    const hub = new InMemoryHub();
    const a = makeFacade('device-A', hub, {
      namespaces: ['nsA', 'nsB'],
    });
    const b = makeFacade('device-B', hub, {
      namespaces: ['nsA', 'nsB'],
    });
    await a.initialize();
    await b.initialize();
    await a.graph.createNode('fact', { text: 'a-nsA' }, [], { namespace: 'nsA' });
    await a.graph.createNode('fact', { text: 'a-nsB' }, [], { namespace: 'nsB' });
    await b.graph.createNode('fact', { text: 'b-nsA' }, [], { namespace: 'nsA' });

    const [resultA, resultB] = await syncBetween(a, b);

    const bNamespaces = (await b.graph.listNodes()).map((n) => n.namespace).sort();
    const aNamespaces = (await a.graph.listNodes()).map((n) => n.namespace).sort();
    expect(bNamespaces).toEqual(['nsA', 'nsA', 'nsB']);
    expect(aNamespaces).toEqual(bNamespaces);
    expect(resultA.noSubscriptionOverlap).toBe(false);
    expect(resultB.noSubscriptionOverlap).toBe(false);

    await a.shutdown();
    await b.shutdown();
  });

  it('facade.resetPeerWatermarks 暴露：可按对端 / 全部清空水位（F3）', async () => {
    const hub = new InMemoryHub();
    const a = makeFacade('device-A', hub);
    const b = makeFacade('device-B', hub);
    await a.initialize();
    await b.initialize();
    await a.graph.createNode('fact', { text: 'x' });
    await syncBetween(a, b);

    await expect(a.resetPeerWatermarks('device-B')).resolves.toBeUndefined();
    await expect(a.resetPeerWatermarks()).resolves.toBeUndefined();

    await a.shutdown();
    await b.shutdown();
  });
});
