// F-W2-1 判别性锚点：worker.reconcile **重发终态事件**（修复「已执行并本地落 done、但崩溃在发布前」的丢包窗口）。
import { describe, it, expect, jest } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FleetWorker } from '../../packages/fleet/src/runtime/worker.js';
import { ExecutionLog, EchoExecutor } from '../../packages/fleet/src/runtime/executor.js';
import { ExecutorRegistry } from '../../packages/fleet/src/runtime/agent.js';
import type { TaskEventStore } from '../../packages/fleet/src/store/file-store.js';
import type { FleetMessage, TaskTransport } from '../../packages/fleet/src/transport/types.js';
import type { TaskEvent } from '../../packages/fleet/src/protocol/events.js';

jest.setTimeout(30000);

const TASK = 'task-A-x';
const event = (type: TaskEvent['type'], toStatus: TaskEvent['toStatus'], actorDevice: string, extra: Partial<TaskEvent> = {}): TaskEvent => ({
  v: 1,
  eventId: `${TASK}#${type}@${actorDevice}`,
  taskId: TASK,
  type,
  actor: { device: actorDevice, agent: actorDevice === 'device-A' ? 'board' : 'worker' },
  at: 0,
  toStatus,
  trace: { chain: [] },
  ...(type === 'created' ? { to: { device: 'device-B', agent: 'echo' }, intent: 'x' } : {}),
  ...(type === 'done' ? { payloadRef: 'echo:x' } : {}),
  ...extra,
});

class MemStore implements TaskEventStore {
  constructor(private readonly events: TaskEvent[]) {}
  async append(e: TaskEvent): Promise<boolean> {
    if (this.events.some((x) => x.eventId === e.eventId)) return false;
    this.events.push(e);
    return true;
  }
  async all(): Promise<TaskEvent[]> {
    return [...this.events];
  }
  async byTask(taskId: string): Promise<TaskEvent[]> {
    return this.events.filter((e) => e.taskId === taskId);
  }
  async close(): Promise<void> {}
}

class CaptureTransport implements TaskTransport {
  readonly published: FleetMessage[] = [];
  async publish(m: FleetMessage): Promise<void> {
    this.published.push(m);
  }
  async drain(): Promise<FleetMessage[]> {
    return [];
  }
  async close(): Promise<void> {}
}

describe('F-W2-1 worker 终态补发', () => {
  it('reconcile：本地已 done 但未发布 → 重发 done 给来源设备（幂等）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'worker-repub-'));
    try {
      const store = new MemStore([
        event('created', 'queued', 'device-A'),
        event('claimed', 'claimed', 'device-B'),
        event('running', 'running', 'device-B'),
        event('done', 'done', 'device-B'),
      ]);
      const transport = new CaptureTransport();
      const registry = new ExecutorRegistry();
      registry.register('echo', new EchoExecutor());
      const log = await ExecutionLog.open(join(dir, 'exec.jsonl'));
      const worker = new FleetWorker({ device: 'device-B', agent: 'worker', store, transport, registry, log });
      await worker.reconcile();
      const republished = transport.published.find((m) => m.event.eventId === `${TASK}#done@device-B`);
      expect(republished).toBeDefined();
      expect(republished!.to.device).toBe('device-A');
      expect(republished!.event.toStatus).toBe('done');
      await worker.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
