// W1 入口拒收：越预算/越链长/root-only 的 `created` 事件不落库（node/worker 摄取路径）。
import { describe, it, expect } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FleetNode } from '../../packages/fleet/src/runtime/node.js';
import { FleetWorker } from '../../packages/fleet/src/runtime/worker.js';
import { LocalQuota } from '../../packages/fleet/src/quota.js';
import { FileTaskEventStore } from '../../packages/fleet/src/store/file-store.js';
import { ExecutionLog } from '../../packages/fleet/src/runtime/executor.js';
import { EchoExecutor, ExecutorRegistry } from '../../packages/fleet/src/index.js';
import type { FleetMessage, TaskTransport } from '../../packages/fleet/src/transport/types.js';
import type { TaskEvent } from '../../packages/fleet/src/protocol/events.js';
import type { TaskBudget, TaskDispatch } from '../../packages/fleet/src/protocol/envelope.js';

class QueueTransport implements TaskTransport {
  private queue: FleetMessage[] = [];
  async publish(message: FleetMessage): Promise<void> {
    this.queue.push(message);
  }
  async drain(): Promise<FleetMessage[]> {
    const out = this.queue;
    this.queue = [];
    return out;
  }
  async close(): Promise<void> {}
}

const REMOTE = { device: 'device-A', agent: 'board' };

function created(taskId: string, opts: { causedBy?: string; chain?: string[]; budget?: TaskBudget; dispatch?: TaskDispatch }): TaskEvent {
  return {
    v: 1,
    eventId: `${taskId}#created`,
    taskId,
    type: 'created',
    actor: opts.causedBy !== undefined ? { device: 'device-B', agent: 'worker' } : REMOTE,
    at: 0,
    toStatus: 'queued',
    trace: { ...(opts.causedBy !== undefined ? { causedBy: opts.causedBy } : {}), chain: opts.chain ?? [] },
    to: { device: 'device-B', agent: 'worker' },
    intent: taskId,
    ...(opts.budget !== undefined ? { budget: opts.budget } : {}),
    ...(opts.dispatch !== undefined ? { dispatch: opts.dispatch } : {}),
  };
}
const env = (taskId: string) => `${taskId}#created`;

describe('W1 入口拒收（node 摄取）', () => {
  it('越预算 / 越链长 / root-only 的 created 不入库；合法子任务入库', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-admit-'));
    try {
      const store = await FileTaskEventStore.open(join(dir, 'node.jsonl'));
      const transport = new QueueTransport();
      const node = new FleetNode({ device: 'device-B', store, transport, quota: new LocalQuota({ limitPerDevice: 1000 }) });

      // root（预算 maxDepth=1）先入库
      await store.append(created('r', { budget: { maxDepth: 1, maxChildren: 4, maxTasks: 8 } }));
      // 越预算：子声明 maxDepth=2 > 父剩余 1
      await transport.publish({ msgId: 'm1', from: REMOTE, to: { device: 'device-B', agent: 'worker' }, event: created('r~bad', { causedBy: 'r', chain: ['r'], budget: { maxDepth: 2, maxChildren: 4, maxTasks: 7 } }) });
      // 合法子：maxDepth=1
      await transport.publish({ msgId: 'm2', from: REMOTE, to: { device: 'device-B', agent: 'worker' }, event: created('r~ok', { causedBy: 'r', chain: ['r'], budget: { maxDepth: 0, maxChildren: 4, maxTasks: 7 } }) });
      // 越链长：孙（深度 2 > root.maxDepth 1）
      await transport.publish({ msgId: 'm3', from: REMOTE, to: { device: 'device-B', agent: 'worker' }, event: created('r~ok~c0', { causedBy: 'r~ok', chain: ['r', 'r~ok'] }) });
      // root-only：另起一棵 root-only 树 + 子
      await store.append(created('ro', { dispatch: 'root-only', budget: { maxDepth: 3, maxChildren: 4, maxTasks: 8 } }));
      await transport.publish({ msgId: 'm4', from: REMOTE, to: { device: 'device-B', agent: 'worker' }, event: created('ro~c0', { causedBy: 'ro', chain: ['ro'] }) });

      await node.pollOnce();
      const ids = (await store.all()).map((e) => env(e.taskId));
      expect(ids).toContain(env('r'));
      expect(ids).toContain(env('r~ok'));
      expect(ids).not.toContain(env('r~bad'));
      expect(ids).not.toContain(env('r~ok~c0'));
      expect(ids).not.toContain(env('ro~c0'));
      await node.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('worker 摄取同样拒收（同一纯函数）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-admit-w-'));
    try {
      const store = await FileTaskEventStore.open(join(dir, 'w.jsonl'));
      const transport = new QueueTransport();
      const log = await ExecutionLog.open(join(dir, 'exec.jsonl'));
      const registry = new ExecutorRegistry();
      registry.register('worker', new EchoExecutor());
      const worker = new FleetWorker({ device: 'device-B', agent: 'worker', store, transport, registry, log });
      await store.append(created('r', { budget: { maxDepth: 0, maxChildren: 4, maxTasks: 8 } }));
      await transport.publish({ msgId: 'x', from: REMOTE, to: { device: 'device-B', agent: 'worker' }, event: created('r~x', { causedBy: 'r', chain: ['r'] }) });
      await worker.pollOnce();
      expect((await store.all()).map((e) => e.taskId)).not.toContain('r~x');
      await worker.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
