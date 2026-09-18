// Fleet M4 · F-1：审查 DAG 端到端（两节点 + 记忆同步 + agent 路由）。
//
// 最小审查 DAG：root（planner）→ 两个子任务（echo）→ 汇总（root 终态即汇总）。
// 断言：全部可达节点终态才算完成 + 结果正确 + 每任务恰好执行一次；并加“子任务未终态→未完成”的
// 判别断言（破坏完成判定时该断言变红）。

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
  ExecutorRegistry,
  deriveEdges,
  detectCycle,
  dagCompletion,
  echoResultFor,
} from '../../packages/fleet/src/index.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fleet-dag-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn: () => Promise<boolean>, timeoutMs: number, pollMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(pollMs);
  }
  return fn();
}

describe('F-1 审查 DAG E2E（两节点）', () => {
  it('root → 子任务 → 汇总：全部可达终态才完成，结果正确且不重复执行', async () => {
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
        sync: {
          autoSync: true,
          pushOnWrite: true,
          pushOnWriteThrottleMs: 20,
          namespaces: ['tasks'],
          peerNamespacePolicy: policy,
          antiEntropy: { enabled: true, intervalMs: 3_600_000, jitterRatio: 0 },
        },
      });

    const a = make('device-A');
    const b = make('device-B');
    await a.initialize();
    await b.initialize();
    await b.node!.connectToPeer(a.node!.peerId);

    const aStore = new MebularTaskEventStore(a);
    const bStore = new MebularTaskEventStore(b);
    const transport = new NullTransport();
    const node = new FleetNode({ device: 'device-A', store: aStore, transport, quota: new LocalQuota({ limitPerDevice: 1000 }) });
    const registry = new ExecutorRegistry();
    registry.register('planner', new EchoExecutor());
    registry.register('echo', new EchoExecutor());
    const log = await ExecutionLog.open(join(dir, 'B.exec.jsonl'));
    const worker = new FleetWorker({ device: 'device-B', agent: 'worker', store: bStore, transport, registry, log });

    // 计划 → 分派：root 由 planner 执行；两个子任务由 echo 执行，causedBy=root。
    const root = (await node.submit({ intent: 'root', to: { device: 'device-B', agent: 'planner' } })).taskId!;
    const c1 = (await node.submit({ intent: 'c1', to: { device: 'device-B', agent: 'echo' }, trace: { causedBy: root, chain: [root] } })).taskId!;
    const c2 = (await node.submit({ intent: 'c2', to: { device: 'device-B', agent: 'echo' }, trace: { causedBy: root, chain: [root] } })).taskId!;
    const ids = [root, c1, c2];

    const done = await waitUntil(async () => {
      await a.sync.runAntiEntropyCycle();
      await b.sync.runAntiEntropyCycle();
      await worker.pollOnce();
      const states = await node.states();
      return states.length === ids.length && states.every((s) => s.terminal);
    }, 45000);
    expect(done).toBe(true);

    const states = await node.states();
    const edges = deriveEdges(states);
    expect(detectCycle(edges)).toBeNull(); // 禁环
    const terminal = (id: string) => states.find((s) => s.taskId === id)!.terminal;

    // 完成判定：可达全部终态 → complete
    const completion = dagCompletion(edges, terminal, root);
    expect(completion.reachable.sort()).toEqual([c1, c2, root].sort());
    expect(completion.pending).toEqual([]);
    expect(completion.complete).toBe(true);

    // 结果正确（每任务 echo:<intent>）
    for (const s of states) expect(s.status).toBe('done');
    expect(states.every((s) => s.resultRef === echoResultFor(s.intent))).toBe(true);

    // 每任务恰好执行一次
    const execTasks = log.all().map((e) => e.taskId);
    expect(execTasks.length).toBe(3);
    expect(new Set(execTasks).size).toBe(3);

    // 判别断言：把某一子任务视为未终态 → 不得判定完成（破坏完成判定时本断言变红）
    const notComplete = dagCompletion(edges, (id) => id !== c2 && terminal(id), root);
    expect(notComplete.complete).toBe(false);
    expect(notComplete.pending).toEqual([c2]);

    await a.shutdown();
    await b.shutdown();
  }, 60000);
});
