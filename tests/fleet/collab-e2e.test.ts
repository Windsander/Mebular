// 1d：三种协作形态接 **live 通道**（两 Mebular 门面 + 真实记忆同步 + FleetNode/FleetWorker）。
//  - 1d-a 审查 DAG：worker 计划派生 → 全部可达终态才完成 + 汇总；负例：成环被拒。
//  - 1d-b 有限协商：counter → accept → 完成；超限 → failed NEGOTIATION_LIMIT；messageId 幂等。
//  - 1d-c 配额制闲聊：本地配额 accepted/queued/rejected；账本守恒；收件幂等。
// 全程确定性（轮询到条件或超时），fake executor（EchoExecutor）。

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mebular } from '@mebular/core';
import { IdentityManager } from '../../src/crypto/IdentityManager.js';
import { InMemoryHub } from '../../src/p2p/transport/InMemoryTransport.js';
import {
  MebularTaskEventStore,
  NullTransport,
  FleetNode,
  FleetWorker,
  LocalQuota,
  EchoExecutor,
  ExecutorRegistry,
  ExecutionLog,
  echoResultFor,
  mapPlanner,
  childTaskId,
  negotiationMessageStore,
  chatterMessageStore,
  FleetChatter,
  validateNegotiationMessage,
  type NegotiationMessage,
  type ChatterMessage,
  type TaskPlanner,
  type TaskState,
  type FleetWorkerOptions,
} from '../../packages/fleet/src/index.js';

jest.setTimeout(120000);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => Promise<boolean>, timeoutMs: number, pollMs = 20): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(pollMs);
  }
  return fn();
}

describe('1d 三形态 live E2E（真实记忆同步）', () => {
  let dir: string;
  let masterKeys: { userMasterKey: Uint8Array; userMasterPrivateKey: CryptoKey };
  let hub: InMemoryHub;
  let a: Mebular;
  let b: Mebular;
  let kicker: { stop: () => void; done: Promise<void> };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fleet-collab-'));
    const master = await new IdentityManager().generateUserMasterKey();
    masterKeys = { userMasterKey: master.publicKey, userMasterPrivateKey: master.privateKey };
    hub = new InMemoryHub();
    a = facade('device-A', { 'device-B': ['tasks'] });
    b = facade('device-B', { 'device-A': ['tasks'] });
    await a.initialize();
    await b.initialize();
    await b.node!.connectToPeer(a.node!.peerId);
    // 反向也建常驻：确保 A→B 能 push（协商 accept / 子任务）；只需一次，避免会话 churn
    await a.node!.connectToPeer(b.node!.peerId).catch(() => undefined);
    await sleep(50); // 建立常驻连接（push-on-write 目标）
    // 确定性“同步兜底”：周期触发 anti-entropy（存在 pending 才开会话）——消除 push 合并抖动
    let stop = false;
    const done = (async () => {
      while (!stop) {
        // 确定性兜底：保持常驻链路 + 触发 anti-entropy（有 pending 才开会话），消除 push 合并/断链抖动
        await a.sync.runAntiEntropyCycle();
        await b.sync.runAntiEntropyCycle();
        await sleep(25);
      }
    })();
    kicker = { stop: () => (stop = true), done };
  });
  afterEach(async () => {
    kicker.stop();
    await kicker.done;
    await a.shutdown();
    await b.shutdown();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 });
  });

  function facade(deviceId: string, peerNamespacePolicy: Record<string, string[]>): Mebular {
    return new Mebular({
      storagePath: join(dir, `${deviceId}.jsonl`),
      deviceId,
      encryption: masterKeys,
      network: { enabled: true, provider: hub },
      sync: { autoSync: true, pushOnWrite: true, pushOnWriteThrottleMs: 5, namespaces: ['tasks'], peerNamespacePolicy },
    });
  }
  function makeNode(negotiation?: { policy: 'accept' | 'counter'; maxRounds: number }): FleetNode {
    const store = new MebularTaskEventStore(a);
    return new FleetNode({
      device: 'device-A',
      store,
      transport: new NullTransport(),
      quota: new LocalQuota({ limitPerDevice: 1_000_000 }),
      ...(negotiation !== undefined
        ? { negotiation: { store: negotiationMessageStore(a), maxRounds: negotiation.maxRounds, policy: negotiation.policy } }
        : {}),
    });
  }
  async function makeWorker(extra: Partial<FleetWorkerOptions>): Promise<{ worker: FleetWorker; log: ExecutionLog }> {
    const store = new MebularTaskEventStore(b);
    const registry = new ExecutorRegistry();
    registry.register('echo', new EchoExecutor());
    const log = await ExecutionLog.open(join(dir, 'B.exec.jsonl'));
    const worker = new FleetWorker({ device: 'device-B', agent: 'worker', store, transport: new NullTransport(), registry, log, ...extra });
    return { worker, log };
  }
  function startLoop(worker: FleetWorker, iterations = 15000, intervalMs = 3): { stop: () => void; done: Promise<void> } {
    let stop = false;
    const done = (async () => {
      for (let i = 0; i < iterations && !stop; i++) {
        await worker.pollOnce();
        await sleep(intervalMs);
      }
    })();
    return { stop: () => (stop = true), done };
  }

  it('1d-a DAG：root → 2 子任务 → 汇总；每任务恰好一次；禁环负例', async () => {
    const node = makeNode();
    const { taskId: rootId } = await node.submit({ intent: 'root', to: { device: 'device-B', agent: 'echo' } });
    const { worker, log } = await makeWorker({ planner: mapPlanner({ root: [{ intent: 'child-0' }, { intent: 'child-1' }] }) });
    const loop = startLoop(worker);
    const completion = await node.waitForDagCompletion(rootId!, { timeoutMs: 90000 });
    loop.stop();
    await loop.done;

    expect(completion.complete).toBe(true);
    expect(completion.reachable).toEqual([rootId, childTaskId(rootId!, 0), childTaskId(rootId!, 1)].sort());
    expect(completion.pending).toEqual([]);
    const summary = await node.summarizeDag(rootId!);
    expect(summary.summary.split('|')).toHaveLength(3);
    expect(summary.summary).toContain(echoResultFor('root'));
    expect(summary.summary).toContain(echoResultFor('child-0'));
    expect(log.size()).toBe(3); // 每任务恰好执行一次

    // 负例：计划让子任务 taskId = 父 taskId（自环）→ 父任务显式失败 DAG_CYCLE，子任务不存在
    const selfCycle: TaskPlanner = { plan: (state) => [{ intent: 'loop', taskId: state.taskId }] };
    const { taskId: badId } = await node.submit({ intent: 'root-cycle', to: { device: 'device-B', agent: 'echo' } });
    const { worker: worker2 } = await makeWorker({ planner: selfCycle });
    const loop2 = startLoop(worker2);
    const badCompletion = await node.waitForDagCompletion(badId!, { timeoutMs: 90000 });
    loop2.stop();
    await loop2.done;
    const badState = await node.stateOf(badId!);
    expect(badState?.status).toBe('failed');
    expect(badState?.reason).toMatch(/^DAG_CYCLE: /);
    expect(badCompletion.reachable).toEqual([badId]);
  });

  it('1d-b 协商：counter → accept → 完成；超限 → NEGOTIATION_LIMIT；messageId 幂等', async () => {
    const negB = negotiationMessageStore(b);
    const node = makeNode({ policy: 'accept', maxRounds: 3 });

    const { taskId } = await node.submit({ intent: 'nego:please', to: { device: 'device-B', agent: 'echo' } });
    const { worker } = await makeWorker({
      negotiation: { store: negB, maxRounds: 3, enabled: (s: TaskState) => s.intent.startsWith('nego:') },
    });
    const loop = startLoop(worker);
    const ok = await node.waitForTerminal([taskId!], { timeoutMs: 90000 });
    loop.stop();
    await loop.done;
    expect(ok).toBe(true);
    expect((await node.stateOf(taskId!))?.status).toBe('done');
    const msgs = await negB.all();
    expect(msgs.some((m) => m.kind === 'counter')).toBe(true);
    expect(msgs.some((m) => m.kind === 'accept')).toBe(true);

    // 超限：node 不响应，worker maxRounds=1 → 发到 2 轮 → NEGOTIATION_LIMIT
    const node2 = makeNode({ policy: 'counter', maxRounds: 1 });
    const { taskId: overId } = await node2.submit({ intent: 'nego:over', to: { device: 'device-B', agent: 'echo' } });
    const { worker: worker2 } = await makeWorker({
      negotiation: { store: negB, maxRounds: 1, enabled: (s: TaskState) => s.intent.startsWith('nego:') },
    });
    const loop2 = startLoop(worker2);
    const terminal = await node2.waitForTerminal([overId!], { timeoutMs: 90000 });
    loop2.stop();
    await loop2.done;
    expect(terminal).toBe(true);
    const overState = await node2.stateOf(overId!);
    expect(overState?.status).toBe('failed');
    expect(overState?.reason).toBe('NEGOTIATION_LIMIT: 2>1');

    // messageId 幂等
    const before = (await negB.all()).length;
    const first = (await negB.all())[0]! as NegotiationMessage;
    expect(validateNegotiationMessage(first).ok).toBe(true);
    expect(await negB.append(first)).toBe(false);
    expect((await negB.all()).length).toBe(before);
  });

  it('1d-c 闲聊：配额内交换；reject/queue 两策略一致；账本守恒；收件幂等', async () => {
    const quotaA = new LocalQuota({ limitPerDevice: 2, onOverflow: 'reject' });
    const chatterA = new FleetChatter({ device: 'device-A', quota: quotaA, store: chatterMessageStore(a) });
    const msg = (i: number): ChatterMessage => ({ v: 1, messageId: `chat-${i}@device-A`, from: { device: 'device-A', agent: 'board' }, topic: 'status', text: `m${i}` });

    expect(await chatterA.send(msg(1))).toBe('accepted');
    expect(await chatterA.send(msg(2))).toBe('accepted');
    expect(await chatterA.send(msg(3))).toBe('rejected');
    const ledger = chatterA.ledger().find((l) => l.device === 'device-A')!;
    expect(ledger.used + ledger.queued + ledger.rejected).toBe(3);
    expect(ledger.rejected).toBe(1);

    // 收件（同步到 B）幂等：2 条 accepted
    const chatB = new FleetChatter({ device: 'device-B', quota: new LocalQuota({ limitPerDevice: 2 }), store: chatterMessageStore(b) });
    const received = await waitFor(async () => (await chatB.inbox()).length >= 2, 15000);
    expect(received).toBe(true);
    expect((await chatB.inbox()).length).toBe(2);
    const first = (await chatB.inbox())[0]!;
    expect(await chatterMessageStore(b).append(first)).toBe(false);

    // queue 策略：2 accepted + 1 queued
    const quotaQ = new LocalQuota({ limitPerDevice: 2, onOverflow: 'queue' });
    const chatterQ = new FleetChatter({ device: 'device-Q', quota: quotaQ, store: chatterMessageStore(b) });
    expect(await chatterQ.send(msg(1))).toBe('accepted');
    expect(await chatterQ.send(msg(2))).toBe('accepted');
    expect(await chatterQ.send(msg(3))).toBe('queued');
    const lq = chatterQ.ledger().find((l) => l.device === 'device-A')!;
    expect(lq.used + lq.queued + lq.rejected).toBe(3);
    expect(lq.queued).toBe(1);
  });
});
