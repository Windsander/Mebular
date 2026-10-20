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
// F-FLAKE-2：TS 版条件驱动有界等待 + 谓词（与 `scripts/lib/acceptance-conditions.mjs` 同语义；
// .mjs 为脚本侧单一真源，jest 走 ts-jest/CJS 转换无法加载 ESM，故在 TS 侧镜像，见 helpers.ts 注释）。
import { dagCycleRejected, negotiationDone, negotiationLimit, waitForTaskState } from './helpers.js';

jest.setTimeout(120000);
// live 同步 E2E 对 runner 负载敏感：允许重试以吸收慢 runner 抖动（本地/CI 双跑均稳定）
jest.retryTimes(2, { logErrorsBeforeRetry: true });

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
    a = facade('device-A');
    b = facade('device-B');
    await a.initialize();
    await b.initialize();
    await b.node!.connectToPeer(a.node!.peerId);
    await sleep(50); // 建立常驻连接（push-on-write 目标）
    // 确定性“同步兜底”：周期触发 anti-entropy（存在 pending 才开会话）——消除 push 合并抖动。
    // 不重复 connectToPeer：重复建连会拆掉常驻会话，反而丢推送（与稳定的 dag-e2e 同构）。
    let stop = false;
    const done = (async () => {
      while (!stop) {
        // F-FLAKE-2：单次异常不得杀死同步驱动（否则同步静默停摆 → 等待超时）；吞掉后继续下一轮。
        await a.sync.runAntiEntropyCycle().catch(() => undefined);
        await b.sync.runAntiEntropyCycle().catch(() => undefined);
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

  function facade(deviceId: string): Mebular {
    return new Mebular({
      storagePath: join(dir, `${deviceId}.jsonl`),
      deviceId,
      encryption: masterKeys,
      network: { enabled: true, provider: hub },
      sync: {
        autoSync: true, pushOnWrite: true, pushOnWriteThrottleMs: 5, namespaces: ['tasks'],
        // 与 dag-e2e 同构：反熵**由 kicker 显式驱动**。这里**关闭**周期反熵（而非设超长 intervalMs）：
        // `recordSyncOutcome` 仅在 enabled 时记退避，且**退避基数 = intervalMs** ⇒ 开着并把 intervalMs
        // 设长时，一次会话失败就会把反熵兜底封停到远超 90s（F-FLAKE-2 根因：1d-a 负例/1d-b 收到 queued）。
        // enabled=false：退避不生效、也没有会在 shutdown 后触发的定时器；常驻收发循环由 pushOnWrite 保证。
        antiEntropy: { enabled: false },
        // F-FLAKE-2：卡住的会话默认 30s 才超时；收紧到 5s，使「卡住→重试」远小于 90s 验收预算。
        syncTimeout: 5000,
      },
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
  function startLoop(worker: FleetWorker, intervalMs = 3): { stop: () => void; done: Promise<void> } {
    let stop = false;
    const done = (async () => {
      while (!stop) {
        // F-FLAKE-2：worker 轮询单次异常不得杀死驱动（否则任务永不推进 → 等待超时）。
        await worker.pollOnce().catch(() => undefined);
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
    // F-FLAKE-2：精确断言谓词 + 条件驱动有界等待（旧版 `waitForDagCompletion` 超时后**单次读** → 抖动）。
    // `dagCompletion.complete` 要求 root 终态 ⇒ 无「提前完成、bad 尚 queued」的缝；真因是投递停滞 → 等待超时。
    const bad = await waitForTaskState(node, badId!, dagCycleRejected);
    const badCompletion = await node.waitForDagCompletion(badId!, { timeoutMs: 90000 }); // 已终态 → 首轮即返回
    loop2.stop();
    await loop2.done;
    expect(bad.ok).toBe(true);
    expect(bad.state?.status).toBe('failed');
    expect(bad.state?.reason).toMatch(/^DAG_CYCLE: /);
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
    // F-FLAKE-2：按精确谓词（status==='done'）有界等待，而非「等终态后单次读」。
    const doneWait = await waitForTaskState(node, taskId!, negotiationDone);
    loop.stop();
    await loop.done;
    expect(doneWait.ok).toBe(true);
    expect(doneWait.state?.status).toBe('done');
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
    // F-FLAKE-2：按精确谓词（reason==='NEGOTIATION_LIMIT: 2>1'）有界等待。
    const over = await waitForTaskState(node2, overId!, negotiationLimit);
    loop2.stop();
    await loop2.done;
    expect(over.ok).toBe(true);
    expect(over.state?.status).toBe('failed');
    expect(over.state?.reason).toBe('NEGOTIATION_LIMIT: 2>1');

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
