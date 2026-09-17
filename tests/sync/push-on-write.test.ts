// push-on-write（PLAN 1.4）：本地 append 成功后向订阅对端即时推送。
//
// 覆盖验收 4：写入后对端在阈值内收到（InMemoryHub 单进程双节点夹具）。
// 开关缺省关闭；节流把连续写入合并为一次推送；对端未订阅的分区不推送。

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Mebular } from '../../src/mebular.js';
import { IdentityManager } from '../../src/crypto/IdentityManager.js';
import { InMemoryHub } from '../../src/p2p/transport/InMemoryTransport.js';
import { SyncManager, type SyncResult } from '../../src/sync/syncmgr/SyncManager.js';
import { EventLog } from '../../src/eventlog/EventLog.js';
import { MemoryStorage } from '../../src/storage/MemoryStorage.js';

describe('push-on-write', () => {
  let dir: string;
  let masterKeys: { userMasterKey: Uint8Array; userMasterPrivateKey: CryptoKey };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mebular-push-'));
    const master = await new IdentityManager().generateUserMasterKey();
    masterKeys = { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey };
  });

  afterEach(async () => {
    // 后台推送/节流可能在本用例结束后仍落一次盘；rm 在并发遍历下可能 ENOTEMPTY，
    // 用 maxRetries 重试（Node 对 ENOTEMPTY 会线性退避重试）。仅测试清理，不涉语义。
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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

  it('双向（H）：响应方（device-B）写入，发起方（device-A）经 nudge 在阈值内收到', async () => {
    const hub = new InMemoryHub();
    const a = makeFacade('device-A', hub);
    const b = makeFacade('device-B', hub);
    await a.initialize();
    await b.initialize();
    await connectAndSettle(a, b);

    // 发起方 A 上的下一轮 sync-completed 只能是 B 发起 nudge 触发的会话
    const applied = new Promise<SyncResult>((resolve) => a.sync.once('sync-completed', resolve));
    const node = await b.graph.createNode('fact', { text: 'from-responder' }, [], { namespace: 'task' });
    await applied;

    expect(await a.graph.getNode(node.id)).not.toBeNull();

    await a.shutdown();
    await b.shutdown();
  });

  it('未授权不发（H）：本机写入未授权分区不触发对端同步', async () => {
    const hub = new InMemoryHub();
    // A 只授权 B 接收 taskA；写入 taskB 不应触发任何同步
    const a = makeFacade('device-A', hub, { peerNamespacePolicy: { 'device-B': ['taskA'] } });
    const b = makeFacade('device-B', hub);
    await a.initialize();
    await b.initialize();
    await connectAndSettle(a, b);

    const node = await a.graph.createNode('fact', { text: 'secret' }, [], { namespace: 'taskB' });
    await new Promise((r) => setTimeout(r, 200));
    expect(await b.graph.getNode(node.id)).toBeNull();

    await a.shutdown();
    await b.shutdown();
  });

  it('per-peer 在途上限 / 节流合并：同一窗口多次触发只投递一次', () => {
    jest.useFakeTimers();
    try {
      const storage = new MemoryStorage();
      const eventLog = new EventLog(storage, 'device-A');
      const sm = new SyncManager({
        eventLog,
        storage,
        deviceId: 'device-A',
        pushOnWrite: true,
        pushOnWriteThrottleMs: 50,
      });
      const entry = {
        peerId: { id: 'p1' },
        peer: { deviceId: 'device-B' },
        initiate: true,
        subscribeAll: true,
        namespaces: [],
        transport: { send: async () => undefined },
      };
      const deliver = jest
        .spyOn(sm as unknown as { deliverTrigger: () => void }, 'deliverTrigger')
        .mockImplementation(() => undefined);

      (sm as unknown as { scheduleSyncTrigger: (e: unknown) => void }).scheduleSyncTrigger(entry);
      (sm as unknown as { scheduleSyncTrigger: (e: unknown) => void }).scheduleSyncTrigger(entry);
      (sm as unknown as { scheduleSyncTrigger: (e: unknown) => void }).scheduleSyncTrigger(entry);
      jest.advanceTimersByTime(50);
      expect(deliver).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
});
