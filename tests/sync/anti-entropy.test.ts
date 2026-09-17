// C · 周期 anti-entropy：core 默认关、无 pending 短路、jitter 界内、失败退避。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { GraphStore } from '../../src/core/GraphStore.js';
import { EventLog } from '../../src/eventlog/EventLog.js';
import { MemoryStorage } from '../../src/storage/MemoryStorage.js';
import { SyncManager, computeAntiEntropyDelay } from '../../src/sync/syncmgr/SyncManager.js';
import { ConfigNamespacePolicy } from '../../src/sync/namespacePolicy.js';

describe('computeAntiEntropyDelay', () => {
  it('jitter 落界内（±jitterRatio）', () => {
    expect(computeAntiEntropyDelay(1000, 0.2, () => 0)).toBe(800);
    expect(computeAntiEntropyDelay(1000, 0.2, () => 1)).toBe(1200);
    expect(computeAntiEntropyDelay(1000, 0.2, () => 0.5)).toBe(1000);
    expect(computeAntiEntropyDelay(50, 2, () => 0)).toBe(0); // 不落负
  });
});

describe('anti-entropy（C）', () => {
  let storage: MemoryStorage;
  let eventLog: EventLog;
  let store: GraphStore;

  beforeEach(() => {
    storage = new MemoryStorage();
    eventLog = new EventLog(storage, 'device-A');
    store = new GraphStore({ storage, author: 'device-A', eventLog });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function makeManager(antiEntropy?: { enabled?: boolean; intervalMs?: number; jitterRatio?: number }): SyncManager {
    return new SyncManager({
      eventLog,
      storage,
      deviceId: 'device-A',
      namespacePolicy: new ConfigNamespacePolicy({ 'device-B': ['nsA'] }),
      ...(antiEntropy ? { antiEntropy } : {}),
    });
  }

  it('core 默认关闭；显式开启才生效', () => {
    expect(makeManager().antiEntropyEnabled).toBe(false);
    expect(makeManager({ enabled: true }).antiEntropyEnabled).toBe(true);
  });

  it('无 pending 短路跳过；有已授权分区的 pending 才为 true', async () => {
    const sm = makeManager({ enabled: true, intervalMs: 1_000_000 });
    expect(await sm.shouldAntiEntropySync('device-B')).toBe(false); // 无事件

    await store.createNode('fact', { text: 'x' }, [], { namespace: 'nsB' }); // 未授权分区
    expect(await sm.shouldAntiEntropySync('device-B')).toBe(false);

    await store.createNode('fact', { text: 'y' }, [], { namespace: 'nsA' }); // 已授权
    expect(await sm.shouldAntiEntropySync('device-B')).toBe(true);
  });

  it('会话在途 → 跳过', async () => {
    const sm = makeManager({ enabled: true, intervalMs: 1_000_000 });
    await store.createNode('fact', { text: 'y' }, [], { namespace: 'nsA' });
    (sm as unknown as { syncing: boolean }).syncing = true;
    expect(await sm.shouldAntiEntropySync('device-B')).toBe(false);
  });

  it('失败退避：连续失败后跳过，成功后复位', async () => {
    const sm = makeManager({ enabled: true, intervalMs: 1_000_000 });
    await store.createNode('fact', { text: 'y' }, [], { namespace: 'nsA' });
    expect(await sm.shouldAntiEntropySync('device-B')).toBe(true);

    (sm as unknown as { recordSyncOutcome: (p: string, ok: boolean) => void }).recordSyncOutcome('device-B', false);
    expect(await sm.shouldAntiEntropySync('device-B')).toBe(false);

    (sm as unknown as { recordSyncOutcome: (p: string, ok: boolean) => void }).recordSyncOutcome('device-B', true);
    expect(await sm.shouldAntiEntropySync('device-B')).toBe(true);
  });

  it('开启后按定时器触发周期；无 pending 不发起、有 pending 才触发', async () => {
    jest.useFakeTimers();
    const sm = makeManager({ enabled: true, intervalMs: 1000, jitterRatio: 0 });
    const entry = {
      peerId: { id: 'p1' },
      peer: { deviceId: 'device-B' },
      initiate: true,
      subscribeAll: true,
      namespaces: [],
      transport: { send: async () => undefined },
    };
    (sm as unknown as { onlinePeers: Map<string, unknown> }).onlinePeers.set('p1', entry);
    const trigger = jest
      .spyOn(sm as unknown as { scheduleSyncTrigger: () => void }, 'scheduleSyncTrigger')
      .mockImplementation(() => undefined);

    await jest.advanceTimersByTimeAsync(1000);
    expect(trigger).not.toHaveBeenCalled(); // 无 pending → 不发起

    await store.createNode('fact', { text: 'y' }, [], { namespace: 'nsA' });
    await jest.advanceTimersByTimeAsync(1000);
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it('定时器在 jitter 界内反复重排（防齐步走）', async () => {
    jest.useFakeTimers();
    const sm = makeManager({ enabled: true, intervalMs: 1000, jitterRatio: 0 });
    // 用 mock 替换 cycle，保留真实的重排逻辑（jitter 界内由 computeAntiEntropyDelay 单测覆盖）
    const reschedule = (sm as unknown as { scheduleAntiEntropy: () => void }).scheduleAntiEntropy.bind(sm);
    const spy = jest
      .spyOn(sm as unknown as { runAntiEntropyCycle: () => Promise<void> }, 'runAntiEntropyCycle')
      .mockImplementation(async () => {
        reschedule();
      });
    await jest.advanceTimersByTimeAsync(1000);
    expect(spy).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1000);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
