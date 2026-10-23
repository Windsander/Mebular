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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn: () => Promise<boolean>, timeoutMs: number, pollMs = 20): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(pollMs);
  }
  return fn();
}

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

  it('F-FLAKE-1 回归：会话进行中到达的 nudge 不丢失（B 写入后 A 仅靠该唤醒收敛）', async () => {
    const hub = new InMemoryHub();
    const a = makeFacade('device-A', hub, { antiEntropy: { enabled: false } });
    const b = makeFacade('device-B', hub, { antiEntropy: { enabled: false } });
    await a.initialize();
    await b.initialize();
    try {
      await connectAndSettle(a, b);
      // 等 A（发起方）回到空闲：发起方在两次会话之间不持有 syncing（响应方旧实现的
      // 「空闲即 syncing」与本节要验证的 nudge 丢失无关，不在此断言）。
      expect(await waitFor(async () => !(await a.sync.getSyncStatus()).isSyncing, 5000)).toBe(true);

      // 测试钩子：把 A（发起方）的帧路由标记为「会话进行中」，精确复现
      // 「B 的 nudge 在 A 的会话期间到达」的时序。只改 PeerFrames 的会话标记，
      // 不注入消息、不改 store、不伪造协商轮次；写入仍由 B 真实 append + pushOnWrite 发出。
      const onlinePeers = (a.sync as unknown as {
        onlinePeers: Map<string, {
          initiate: boolean;
          frames?: { setSessionActive(active: boolean): void; readonly hasPendingNudge?: boolean };
        }>;
      }).onlinePeers;
      const entry = [...onlinePeers.values()].find((candidate) => candidate.initiate);
      expect(entry?.frames).toBeDefined();
      entry!.frames!.setSessionActive(true);

      const node = await b.graph.createNode('fact', { text: 'nudge-during-session' }, [], { namespace: 'task' });
      // 确定性钩子：等到 B 的 nudge **确实已在会话进行中抵达**（新实现的诊断位，
      // 不注入任何业务消息/状态）。旧实现会话中直接丢弃、也没有该状态位 → 这里超时，
      // 从而排除“nudge 恰好晚到、旧实现也能过”的假通过。
      const arrivedDuringSession = await waitFor(
        async () => entry!.frames!.hasPendingNudge === true,
        3000,
      );
      // 不在这里提前失败：旧实现没有该状态位，仍继续走下面的行为断言，
      // 让红灯首先来自“会话结束后仍收不到”，而不是“只缺一个新 getter”。
      // 会话内没有会话在跑：A 此时不应已有该节点（证明下面不是 push 已直接送达）
      expect(await a.graph.getNode(node.id)).toBeNull();

      // 会话结束：修复后补发一次 onNudge → A 的发起方循环开会话 → 拉取 B 的新节点。
      // 旧实现无补发；A 无本地 pending、B 也无新写入 ⇒ 节点永远到不了 A。
      entry!.frames!.setSessionActive(false);
      const received = await waitFor(async () => (await a.graph.getNode(node.id)) !== null, 5000);
      expect(received).toBe(true);
      expect(await a.graph.getNode(node.id)).not.toBeNull();
      // 确定性：nudge 必须是在会话进行中抵达的（排除“晚到后被空闲路径接住”的假通过）。
      expect(arrivedDuringSession).toBe(true);
    } finally {
      await a.shutdown();
      await b.shutdown();
    }
  }, 20000);

  it('未订阅不发（H）：本机写入未订阅分区不供给对端', async () => {
    const hub = new InMemoryHub();
    // A 只订阅 taskA；写入 taskB 不会供给给 B
    const a = makeFacade('device-A', hub, { namespaces: ['taskA'] });
    const b = makeFacade('device-B', hub, { namespaces: ['taskA', 'taskB'] });
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
