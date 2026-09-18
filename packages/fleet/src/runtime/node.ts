// Fleet 节点（M2）：任务板 + 发起端。写入任务（created 事件）→ 投递 → 收集结果事件 → 观察收敛。

import { randomUUID } from 'node:crypto';
import type { FleetEndpoint, FleetTrace } from '../protocol/envelope.js';
import type { TaskEvent } from '../protocol/events.js';
import { reduceTaskEvents, type TaskState } from '../model.js';
import type { LocalQuota, QuotaDecision } from '../quota.js';
import type { TaskEventStore } from '../store/file-store.js';
import type { TaskTransport } from '../transport/types.js';

export interface FleetNodeOptions {
  device: string;
  /** 发起端 Agent 名（默认 `board`） */
  agent?: string;
  store: TaskEventStore;
  transport: TaskTransport;
  quota: LocalQuota;
}

export interface SubmitRequest {
  intent: string;
  to: FleetEndpoint;
  payloadRef?: string;
  expiresAt?: number;
  /** 因果链（默认空；用于 DAG 派生：`causedBy` 指向父任务） */
  trace?: FleetTrace;
  /** 重复投递该 created 事件（同 eventId、不同 msgId）以验证幂等（默认 1） */
  deliveries?: number;
}

export interface SubmitResult {
  taskId: string | null;
  decision: QuotaDecision;
}

export class FleetNode {
  readonly endpoint: FleetEndpoint;
  private readonly store: TaskEventStore;
  private readonly transport: TaskTransport;
  private readonly quota: LocalQuota;

  constructor(options: FleetNodeOptions) {
    this.endpoint = { device: options.device, agent: options.agent ?? 'board' };
    this.store = options.store;
    this.transport = options.transport;
    this.quota = options.quota;
  }

  private async emit(event: TaskEvent, to: FleetEndpoint, deliveries = 1): Promise<void> {
    await this.store.append(event);
    for (let i = 0; i < deliveries; i++) {
      await this.transport.publish({ msgId: randomUUID(), from: this.endpoint, to, event });
    }
  }

  /** 提交任务：本地配额判定 → 写 `created` 事件 → 投递（可重复投递）。 */
  async submit(request: SubmitRequest): Promise<SubmitResult> {
    const decision = this.quota.decide(this.endpoint.device);
    if (decision === 'rejected') return { taskId: null, decision };

    const taskId = `task-${this.endpoint.device}-${randomUUID().slice(0, 8)}`;
    const event: TaskEvent = {
      v: 1,
      eventId: `${taskId}#created`,
      taskId,
      type: 'created',
      actor: this.endpoint,
      at: Date.now(),
      toStatus: 'queued',
      trace: request.trace ?? { chain: [] },
      to: request.to,
      intent: request.intent,
    };
    if (request.payloadRef !== undefined) event.payloadRef = request.payloadRef;
    if (request.expiresAt !== undefined) event.expiresAt = request.expiresAt;
    await this.emit(event, request.to, request.deliveries ?? 1);
    return { taskId, decision };
  }

  /** 处理收件箱：把收到的状态事件幂等并入本地存储。返回本次新并入的事件数。 */
  async pollOnce(): Promise<number> {
    const messages = await this.transport.drain(this.endpoint);
    let applied = 0;
    for (const message of messages) {
      if (await this.store.append(message.event)) applied += 1;
    }
    return applied;
  }

  /** 当前所有任务的权威状态（按 taskId 排序）。 */
  async states(): Promise<TaskState[]> {
    const events = await this.store.all();
    const byTask = new Map<string, TaskEvent[]>();
    for (const event of events) {
      const list = byTask.get(event.taskId);
      if (list) list.push(event);
      else byTask.set(event.taskId, [event]);
    }
    const out: TaskState[] = [];
    for (const taskId of [...byTask.keys()].sort()) {
      const state = reduceTaskEvents(byTask.get(taskId)!);
      if (state) out.push(state);
    }
    return out;
  }

  async stateOf(taskId: string): Promise<TaskState | null> {
    return reduceTaskEvents(await this.store.byTask(taskId));
  }

  /** 轮询直到给定任务全部终态（或超时）。返回是否全部终态。 */
  async waitForTerminal(
    taskIds: readonly string[],
    options: { timeoutMs: number; pollMs?: number },
  ): Promise<boolean> {
    const pollMs = options.pollMs ?? 10;
    const deadline = Date.now() + options.timeoutMs;
    const pending = new Set(taskIds);
    while (Date.now() < deadline) {
      await this.pollOnce();
      const states = await this.states();
      for (const state of states) if (state.terminal) pending.delete(state.taskId);
      if (pending.size === 0) return true;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return pending.size === 0;
  }

  /** 清空收件箱（把当前待处理消息并入存储）。便于测试可控推进。 */
  async settle(): Promise<number> {
    let total = 0;
    let n = await this.pollOnce();
    while (n > 0) {
      total += n;
      n = await this.pollOnce();
    }
    return total;
  }

  async close(): Promise<void> {
    await this.transport.close();
    await this.store.close();
  }
}
