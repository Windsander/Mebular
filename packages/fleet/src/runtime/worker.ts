// Fleet worker（M2）：订阅任务分区 → 拾取发往本端（device/agent）的任务 → 执行 → 写回状态/结果。
//
// 幂等与韧性：
// - 事件按 `eventId` 幂等落库（重复投递不重复应用）；
// - 执行按 `taskId` 至多一次（`ExecutionLog` 持久化），重复投递/重启都不重复执行；
// - 启动即 reconcile：对「已执行未回写」补回写、对「未执行」补执行（不丢不重）。

import { randomUUID } from 'node:crypto';
import type { FleetEndpoint } from '../protocol/envelope.js';
import type { TaskEvent } from '../protocol/events.js';
import { reduceTaskEvents, type TaskState } from '../model.js';
import type { TaskEventStore } from '../store/file-store.js';
import type { TaskTransport } from '../transport/types.js';
import { executeOnce, type ExecutionLog, type TaskExecutor } from './executor.js';

export interface FleetWorkerOptions {
  device: string;
  agent: string;
  store: TaskEventStore;
  transport: TaskTransport;
  executor: TaskExecutor;
  log: ExecutionLog;
}

export interface PollOutcome {
  /** 本次新并入的事件数 */
  applied: number;
  /** 本次真实执行的次数（新增执行记录） */
  executed: number;
}

export class FleetWorker {
  readonly endpoint: FleetEndpoint;
  private readonly store: TaskEventStore;
  private readonly transport: TaskTransport;
  private readonly executor: TaskExecutor;
  private readonly log: ExecutionLog;
  private stopped = false;

  constructor(options: FleetWorkerOptions) {
    this.endpoint = { device: options.device, agent: options.agent };
    this.store = options.store;
    this.transport = options.transport;
    this.executor = options.executor;
    this.log = options.log;
  }

  private targetsMe(state: TaskState): boolean {
    return (
      state.to.device === this.endpoint.device &&
      (state.to.agent === this.endpoint.agent || state.to.agent === '*')
    );
  }

  private async emit(event: TaskEvent, to: FleetEndpoint): Promise<void> {
    await this.store.append(event);
    await this.transport.publish({ msgId: randomUUID(), from: this.endpoint, to, event });
  }

  private baseEvent(state: TaskState): Omit<TaskEvent, 'eventId' | 'type' | 'toStatus'> {
    return {
      v: 1,
      taskId: state.taskId,
      actor: this.endpoint,
      at: Date.now(),
      trace: state.trace,
    };
  }

  private async complete(state: TaskState, resultRef: string | undefined, ok: boolean, reason?: string): Promise<void> {
    const base = this.baseEvent(state);
    const dev = this.endpoint.device;
    await this.emit({ ...base, eventId: `${state.taskId}#claimed@${dev}`, type: 'claimed', toStatus: 'claimed' }, state.from);
    await this.emit({ ...base, eventId: `${state.taskId}#running@${dev}`, type: 'running', toStatus: 'running' }, state.from);
    if (ok) {
      await this.emit(
        { ...base, eventId: `${state.taskId}#done@${dev}`, type: 'done', toStatus: 'done', ...(resultRef !== undefined ? { payloadRef: resultRef } : {}) },
        state.from,
      );
    } else {
      await this.emit(
        { ...base, eventId: `${state.taskId}#failed@${dev}`, type: 'failed', toStatus: 'failed', ...(reason !== undefined ? { reason } : {}) },
        state.from,
      );
    }
  }

  /** 处理发往本端、尚未终态的任务（幂等；可安全重复调用）。`maxTasks` 限制单轮真实执行数。 */
  async processPending(maxTasks = Number.POSITIVE_INFINITY): Promise<number> {
    const events = await this.store.all();
    const byTask = new Map<string, TaskEvent[]>();
    for (const event of events) {
      const list = byTask.get(event.taskId);
      if (list) list.push(event);
      else byTask.set(event.taskId, [event]);
    }
    let executed = 0;
    for (const taskId of [...byTask.keys()].sort()) {
      if (executed >= maxTasks) break;
      const state = reduceTaskEvents(byTask.get(taskId)!);
      if (state === null || state.terminal || !this.targetsMe(state)) continue;

      const before = this.log.size();
      const outcome = await executeOnce(state, this.executor, this.log);
      if (this.log.size() > before) executed += 1;
      await this.complete(state, outcome.resultRef, outcome.ok, outcome.reason);
    }
    return executed;
  }

  /** 处理收件箱 + 推进本地任务。`maxTasks` 限制单轮真实执行数（默认不限）。 */
  async pollOnce(maxTasks = Number.POSITIVE_INFINITY): Promise<PollOutcome> {
    const messages = await this.transport.drain(this.endpoint);
    let applied = 0;
    for (const message of messages) {
      if (await this.store.append(message.event)) applied += 1;
    }
    const executed = await this.processPending(maxTasks);
    return { applied, executed };
  }

  /** 启动即对账（重启韧性）。 */
  async reconcile(): Promise<number> {
    return this.processPending();
  }

  /** 持续轮询直到 `signal` 中止。 */
  async run(options: { intervalMs?: number; signal?: AbortSignal } = {}): Promise<void> {
    const intervalMs = options.intervalMs ?? 5;
    while (!this.stopped) {
      if (options.signal?.aborted) break;
      await this.pollOnce();
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  stop(): void {
    this.stopped = true;
  }

  async close(): Promise<void> {
    this.stop();
    await this.transport.close();
    await this.store.close();
  }
}
