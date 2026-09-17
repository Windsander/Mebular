// Fleet M3（进程内）：任务事件作为记忆节点，经 core 同步在两节点间传递。
//
// 用 InMemoryHub 做确定性传输；验证 MebularTaskEventStore + NullTransport + runtime
// 的端到端一致性，以及**授权负例**（未授权设备看不到 tasks 分区）。真实 libp2p 见
// scripts/verify-fleet-remote.mjs。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mebular } from '@mebular/core';
import { InMemoryHub } from '../../src/p2p/transport/InMemoryTransport.js';
import {
  MebularTaskEventStore,
  NullTransport,
  FleetNode,
  FleetWorker,
  LocalQuota,
  EchoExecutor,
  ExecutionLog,
  echoResultFor,
  dedupeEvents,
} from '../../packages/fleet/src/index.js';
import { mkEvent } from './helpers.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fleet-msync-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitUntil(fn: () => Promise<boolean>, timeoutMs = 8000, pollMs = 25): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(pollMs);
  }
  return fn();
}

describe('M3 任务经记忆同步（两节点 + 授权）', () => {
  it('A 派 3 任务 → 经同步到 B → 执行 → 结果回传 A；未授权 C 看不到', async () => {
    const master = await Mebular.generateUserMasterKey();
    const encryption = { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey };
    const hub = new InMemoryHub();
    const policy = { 'device-A': ['tasks'], 'device-B': ['tasks'] };

    const make = (deviceId: string) =>
      new Mebular({
        storagePath: join(dir, `${deviceId}.jsonl`),
        deviceId,
        encryption,
        network: { enabled: true, provider: hub },
        sync: { autoSync: true, pushOnWrite: true, pushOnWriteThrottleMs: 20, namespaces: ['tasks'], peerNamespacePolicy: policy },
      });

    const a = make('device-A');
    const b = make('device-B');
    const c = make('device-C'); // 未被 A 授权 → 默认拒绝
    await a.initialize();
    await b.initialize();
    await c.initialize();

    await b.node!.connectToPeer(a.node!.peerId);
    await c.node!.connectToPeer(a.node!.peerId);
    await sleep(300); // 让首轮同步/授权协商完成

    const aStore = new MebularTaskEventStore(a);
    const bStore = new MebularTaskEventStore(b);
    const cStore = new MebularTaskEventStore(c);
    const transport = new NullTransport();
    const node = new FleetNode({ device: 'device-A', store: aStore, transport, quota: new LocalQuota({ limitPerDevice: 1000 }) });
    const log = await ExecutionLog.open(join(dir, 'B.exec.jsonl'));
    const worker = new FleetWorker({ device: 'device-B', agent: 'echo', store: bStore, transport, executor: new EchoExecutor(), log });

    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { taskId } = await node.submit({ intent: `sync-${i}`, to: { device: 'device-B', agent: '*' } });
      ids.push(taskId!);
    }

    const done = await waitUntil(async () => {
      await worker.pollOnce();
      const states = await node.states();
      return states.length === ids.length && states.every((s) => s.terminal);
    }, 12000);
    expect(done).toBe(true);
    const states = await node.states();
    expect(states.every((s) => s.status === 'done' && s.resultRef === echoResultFor(s.intent))).toBe(true);
    expect(log.size()).toBe(3); // 每任务执行一次

    // 授权负例：C 未被授权 tasks → 看不到任何任务事件
    await sleep(300);
    expect(await cStore.all()).toHaveLength(0);

    await a.shutdown();
    await b.shutdown();
    await c.shutdown();
  }, 30000);

  it('MebularTaskEventStore：噪音节点过滤 + 同 eventId 冲突与 reducer 同语义去重', async () => {
    const master = await Mebular.generateUserMasterKey();
    const m = new Mebular({
      storagePath: join(dir, 'store-only.jsonl'),
      deviceId: 'device-S',
      encryption: { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey },
      network: { enabled: false },
    });
    await m.initialize();
    const store = new MebularTaskEventStore(m);

    const valid = mkEvent('created', 't-store');
    expect(await store.append(valid)).toBe(true);
    expect(await store.append(valid)).toBe(false); // 同 eventId 重复 append 拒绝

    // 噪音：非同分区 / 非对象内容 / schema 不合法 → 一律忽略
    await m.graph.createNode('task_event', valid as unknown as Record<string, unknown>, [], {
      namespace: 'other',
    });
    await m.graph.createNode('task_event', 'not-an-object' as unknown as Record<string, unknown>, [], {
      namespace: 'tasks',
    });
    await m.graph.createNode('task_event', { nonsense: true }, [], { namespace: 'tasks' });
    expect(await store.all()).toHaveLength(1);

    // 同 eventId 冲突但内容不同：store 复用 reducer 的确定性裁决（稳定序列化较大者胜）
    const t = 't-store-dup';
    const doneA = mkEvent('done', t, { eventId: `${t}#dup`, payloadRef: 'payload-A' });
    const doneB = mkEvent('done', t, { eventId: `${t}#dup`, payloadRef: 'payload-B' });
    await m.graph.createNode('task_event', doneA as unknown as Record<string, unknown>, [], {
      namespace: 'tasks',
    });
    await m.graph.createNode('task_event', doneB as unknown as Record<string, unknown>, [], {
      namespace: 'tasks',
    });

    const dup = (await store.all()).filter((e) => e.eventId === `${t}#dup`);
    expect(dup).toHaveLength(1);
    expect(dup[0]).toEqual(dedupeEvents([doneA, doneB])[0]);
    expect((dup[0] as { payloadRef?: string }).payloadRef).toBe('payload-B');

    await m.shutdown();
  }, 20000);
});
