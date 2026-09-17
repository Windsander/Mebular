// Fleet runtime（M2）：FleetNode + FleetWorker 的进程内集成（spool + file store + exec log）。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FleetNode,
  FleetWorker,
  FileTaskEventStore,
  SpoolTransport,
  LocalQuota,
  EchoExecutor,
  ExecutionLog,
  echoResultFor,
  isExpiredLocally,
  reduceTaskEvents,
} from '../../packages/fleet/src/index.js';
import { mkEvent } from './helpers.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fleet-rt-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function makeNode(device: string, limit = 1000, mode: 'queue' | 'reject' = 'queue') {
  const store = await FileTaskEventStore.open(join(dir, `${device}.jsonl`));
  const transport = new SpoolTransport(join(dir, 'spool'));
  const node = new FleetNode({ device, store, transport, quota: new LocalQuota({ limitPerDevice: limit, onOverflow: mode }) });
  return node;
}

async function makeWorker(device: string, agent = 'echo') {
  const store = await FileTaskEventStore.open(join(dir, `${device}.jsonl`));
  const transport = new SpoolTransport(join(dir, 'spool'));
  const log = await ExecutionLog.open(join(dir, `${device}.exec.jsonl`));
  const worker = new FleetWorker({ device, agent, store, transport, executor: new EchoExecutor(), log });
  return { worker, store, log };
}

describe('M2 runtime：派活 → 执行 → 结果回传', () => {
  it('N 个任务全部完成且结果匹配', async () => {
    const node = await makeNode('device-A');
    const { worker, log } = await makeWorker('device-B');
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const { taskId } = await node.submit({ intent: `t-${i}`, to: { device: 'device-B', agent: '*' } });
      ids.push(taskId!);
    }
    await worker.pollOnce();
    const ok = await node.waitForTerminal(ids, { timeoutMs: 2000, pollMs: 2 });
    expect(ok).toBe(true);
    const states = await node.states();
    expect(states.every((s) => s.status === 'done' && s.resultRef === echoResultFor(s.intent))).toBe(true);
    expect(log.size()).toBe(5);
  });

  it('重复投递不重复执行', async () => {
    const node = await makeNode('device-A');
    const { worker, log } = await makeWorker('device-B');
    const { taskId } = await node.submit({
      intent: 'dup',
      to: { device: 'device-B', agent: '*' },
      deliveries: 3, // 同 eventId、不同 msgId 投递三次
    });
    await worker.pollOnce();
    await worker.pollOnce(); // 再来一轮（收件箱可能重投）
    await node.waitForTerminal([taskId!], { timeoutMs: 2000, pollMs: 2 });
    expect(log.size()).toBe(1); // 只执行一次
  });

  it('配额：queue 超额排队、reject 超额拒绝，账本守恒', async () => {
    const node = await makeNode('device-A', 2, 'queue');
    const d = { accepted: 0, queued: 0, rejected: 0 };
    for (let i = 0; i < 5; i++) d[(await node.submit({ intent: 'q', to: { device: 'device-B', agent: '*' } })).decision] += 1;
    expect(d).toEqual({ accepted: 2, queued: 3, rejected: 0 });

    const node2 = await makeNode('device-C', 1, 'reject');
    const d2 = { accepted: 0, queued: 0, rejected: 0 };
    for (let i = 0; i < 3; i++) d2[(await node2.submit({ intent: 'q', to: { device: 'device-B', agent: '*' } })).decision] += 1;
    expect(d2).toEqual({ accepted: 1, queued: 0, rejected: 2 });
  });

  it('expiresAt 只影响本机展示，不影响状态收敛', async () => {
    const node = await makeNode('device-A');
    const { worker } = await makeWorker('device-B');
    const { taskId } = await node.submit({
      intent: 'exp',
      to: { device: 'device-B', agent: '*' },
      expiresAt: 100,
    });
    await worker.pollOnce();
    await node.waitForTerminal([taskId!], { timeoutMs: 2000, pollMs: 2 });
    const state = (await node.stateOf(taskId!))!;
    expect(state.status).toBe('done');
    expect(state.expiresAt).toBe(100);
    expect(isExpiredLocally(state.expiresAt, 10_000)).toBe(true);
  });

  it('重启对账：已执行未回写 → 补回写且不重复执行', async () => {
    const { worker, store, log } = await makeWorker('device-B');
    const created = mkEvent('created', 'crash-1', { to: { device: 'device-B', agent: '*' }, intent: 'boom', trace: { chain: [] } });
    await store.append(created);
    await log.record('crash-1', 'echo:boom'); // 模拟「已执行、未回写」后崩溃

    const executed = await worker.reconcile();
    expect(executed).toBe(0); // 不重复执行
    const state = reduceTaskEvents(await store.byTask('crash-1'))!;
    expect(state.status).toBe('done');
    expect(state.resultRef).toBe('echo:boom');
    // 再对账仍幂等
    expect(await worker.reconcile()).toBe(0);
  });

  it('未执行的任务在重启对账时被续跑（不丢）', async () => {
    const { worker, store } = await makeWorker('device-B');
    await store.append(mkEvent('created', 'resume-1', { to: { device: 'device-B', agent: '*' }, intent: 'go', trace: { chain: [] } }));
    expect(await worker.reconcile()).toBe(1);
    expect(reduceTaskEvents(await store.byTask('resume-1'))!.status).toBe('done');
  });

  it('定向 agent：不匹配的 worker 不拾取', async () => {
    const node = await makeNode('device-A');
    const { worker, log } = await makeWorker('device-B', 'other');
    const { taskId } = await node.submit({ intent: 'x', to: { device: 'device-B', agent: 'echo' } });
    await worker.pollOnce();
    expect(log.size()).toBe(0);
    expect((await node.stateOf(taskId!))!.status).toBe('queued');
  });

  it('设备不匹配的 worker 不拾取', async () => {
    const node = await makeNode('device-A');
    const { worker, log } = await makeWorker('device-C', 'echo');
    await node.submit({ intent: 'x', to: { device: 'device-B', agent: '*' } });
    await worker.pollOnce();
    expect(log.size()).toBe(0);
  });

  it('执行失败 → failed 终态（reason）', async () => {
    const node = await makeNode('device-A');
    const store = await FileTaskEventStore.open(join(dir, 'device-B.jsonl'));
    const transport = new SpoolTransport(join(dir, 'spool'));
    const log = await ExecutionLog.open(join(dir, 'B.exec.jsonl'));
    const worker = new FleetWorker({
      device: 'device-B',
      agent: 'echo',
      store,
      transport,
      executor: { execute: async () => ({ ok: false, reason: 'kaboom' }) },
      log,
    });
    const { taskId } = await node.submit({ intent: 'f', to: { device: 'device-B', agent: '*' } });
    await worker.pollOnce();
    await node.waitForTerminal([taskId!], { timeoutMs: 2000, pollMs: 2 });
    const st = (await node.stateOf(taskId!))!;
    expect(st.status).toBe('failed');
    expect(st.reason).toBe('kaboom');
    expect(log.size()).toBe(0); // 失败不记录执行
  });

  it('执行器 ok 但无 resultRef → done 且无结果引用', async () => {
    const node = await makeNode('device-A');
    const store = await FileTaskEventStore.open(join(dir, 'device-B.jsonl'));
    const transport = new SpoolTransport(join(dir, 'spool'));
    const log = await ExecutionLog.open(join(dir, 'B.exec.jsonl'));
    const worker = new FleetWorker({
      device: 'device-B',
      agent: 'echo',
      store,
      transport,
      executor: { execute: async () => ({ ok: true }) },
      log,
    });
    const { taskId } = await node.submit({ intent: 'nr', to: { device: 'device-B', agent: '*' } });
    await worker.pollOnce();
    await node.waitForTerminal([taskId!], { timeoutMs: 2000, pollMs: 2 });
    const st = (await node.stateOf(taskId!))!;
    expect(st.status).toBe('done');
    expect(st.resultRef).toBeUndefined();
  });

  it('node.settle 排空收件箱；waitForTerminal 超时返回 false', async () => {
    const node = await makeNode('device-A');
    const { worker } = await makeWorker('device-B');
    const { taskId } = await node.submit({ intent: 's', to: { device: 'device-B', agent: '*' } });
    await worker.pollOnce();
    expect(await node.settle()).toBeGreaterThan(0);
    expect(await node.waitForTerminal([taskId!], { timeoutMs: 500, pollMs: 2 })).toBe(true);

    const { taskId: pending } = await node.submit({ intent: 'p', to: { device: 'device-nowhere', agent: '*' } });
    expect(await node.waitForTerminal([pending!], { timeoutMs: 50, pollMs: 2 })).toBe(false);
  });

  it('worker.run 轮询 + abort + close', async () => {
    const node = await makeNode('device-A');
    const { worker, log } = await makeWorker('device-B');
    await node.submit({ intent: 'r', to: { device: 'device-B', agent: '*' } });
    const controller = new AbortController();
    const running = worker.run({ intervalMs: 1, signal: controller.signal });
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && log.size() === 0) await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    await running;
    expect(log.size()).toBe(1);
    await worker.close();
  });
});
