// push-on-write（PLAN 1.4）：本地 append 成功后向订阅对端即时推送。
//
// 覆盖验收 4：写入后对端在阈值内收到（InMemoryHub 单进程双节点夹具）。
// 开关缺省关闭；节流把连续写入合并为一次推送；对端未订阅的分区不推送。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Mebular } from '../../src/mebular.js';
import { IdentityManager } from '../../src/crypto/IdentityManager.js';
import { InMemoryHub } from '../../src/p2p/transport/InMemoryTransport.js';
import type { SyncResult } from '../../src/sync/syncmgr/SyncManager.js';

describe('push-on-write', () => {
  let dir: string;
  let masterKeys: { userMasterKey: Uint8Array; userMasterPrivateKey: CryptoKey };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mebular-push-'));
    const master = await new IdentityManager().generateUserMasterKey();
    masterKeys = { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makeFacade(
    deviceId: string,
    hub: InMemoryHub,
    sync: Record<string, unknown> = {},
  ): Mebular {
    return new Mebular({
      storagePath: join(dir, `${deviceId}.jsonl`),
      deviceId,
      encryption: masterKeys,
      network: { enabled: true, provider: hub },
      sync: {
        autoSync: true,
        pushOnWrite: true,
        pushOnWriteThrottleMs: 20,
        // 默认拒绝：显式授权对端；具体订阅由各用例的 namespaces 决定
        peerNamespacePolicy: {
          'device-A': ['default', 'task', 'taskA', 'taskB'],
          'device-B': ['default', 'task', 'taskA', 'taskB'],
        },
        ...sync,
      },
    });
  }

  /** 等待双端首次自动同步完成 */
  async function connectAndSettle(a: Mebular, b: Mebular): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const both = new Promise<void>((resolve, reject) => {
      let count = 0;
      const onDone = (): void => {
        count += 1;
        if (count === 2) resolve();
      };
      a.sync.on('sync-completed', onDone);
      b.sync.on('sync-completed', onDone);
      timer = setTimeout(() => reject(new Error('首次同步超时')), 5000);
    });
    try {
      await b.node!.connectToPeer(a.node!.peerId);
      await both;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  it('本地写入后，对端在阈值内收到（无需手动 sync）', async () => {
    const hub = new InMemoryHub();
    // device-A < device-B：A 是发起方角色，可主动推送
    const a = makeFacade('device-A', hub);
    const b = makeFacade('device-B', hub);
    await a.initialize();
    await b.initialize();
    await connectAndSettle(a, b);

    const applied = new Promise<SyncResult>((resolve) => b.sync.once('sync-completed', resolve));
    const node = await a.graph.createNode('fact', { text: 'push me' }, [], { namespace: 'task' });
    await applied;

    const received = await b.graph.getNode(node.id);
    expect(received).not.toBeNull();
    expect(received?.namespace).toBe('task');

    await a.shutdown();
    await b.shutdown();
  });

  it('节流合并：连续多次写入合并推送，对端最终全部收到', async () => {
    const hub = new InMemoryHub();
    const a = makeFacade('device-A', hub);
    const b = makeFacade('device-B', hub);
    await a.initialize();
    await b.initialize();
    await connectAndSettle(a, b);

    const created = [];
    for (let i = 0; i < 5; i++) {
      created.push(await a.graph.createNode('fact', { text: `burst-${i}` }));
    }

    // 轮询等待对端收敛（push 已被节流合并）
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const count = (await b.graph.listNodes()).length;
      if (count === created.length) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const bIds = (await b.graph.listNodes()).map((n) => n.id).sort();
    expect(bIds).toEqual(created.map((n) => n.id).sort());

    await a.shutdown();
    await b.shutdown();
  });

  it('对端未订阅的分区不触发推送', async () => {
    const hub = new InMemoryHub();
    const a = makeFacade('device-A', hub);
    const b = makeFacade('device-B', hub, { namespaces: ['taskA'] });
    await a.initialize();
    await b.initialize();
    await connectAndSettle(a, b);

    const node = await a.graph.createNode('fact', { text: 'not subscribed' }, [], { namespace: 'taskB' });
    await new Promise((r) => setTimeout(r, 200));

    expect(await b.graph.getNode(node.id)).toBeNull();

    await a.shutdown();
    await b.shutdown();
  });
});
