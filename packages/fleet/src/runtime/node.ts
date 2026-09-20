// Fleet 节点（M2）：任务板 + 发起端。写入任务（created 事件）→ 投递 → 收集结果事件 → 观察收敛。

import { randomUUID } from 'node:crypto';
import type { FleetEndpoint, FleetTrace, TaskBudget, TaskDispatch } from '../protocol/envelope.js';
import type { TaskEvent } from '../protocol/events.js';
import { reduceTaskEvents, type TaskState } from '../model.js';
import type { LocalQuota, QuotaDecision } from '../quota.js';
import type { TaskEventStore } from '../store/file-store.js';
import type { MebularMessageStore } from '../store/message-store.js';
import type { TaskTransport } from '../transport/types.js';
import { dagCompletion, deriveEdges, type DagCompletion } from '../collab/dag.js';
import { NegotiationTracker, validateNegotiationMessage, type NegotiationMessage } from '../collab/negotiation.js';
import { admitCreated, admissibleTaskIds } from '../collab/tree.js';

export interface FleetNodeOptions {
  device: string;
  /** 发起端 Agent 名（默认 `board`） */
  agent?: string;
  store: TaskEventStore;
  transport: TaskTransport;
  quota: LocalQuota;
  /**
   * 1d-b：有限协商（可选）。`respond=true` 时，发起端对未终态任务的协商消息
   * **自动接受**（确定性策略）——使 `clarify/counter → accept → 执行` 的 E2E 可自动推进。
   */
  negotiation?: {
    store: MebularMessageStore<NegotiationMessage>;
    maxRounds: number;
    /** 发起端策略：`accept`（默认）接受；`counter` 反提案（与 worker 交替直到超限） */
    policy?: 'accept' | 'counter';
  };
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
  /** **W1**：root 子树预算（缺省=默认上界）；子任务应 ≤ 父剩余（入口不变式判定） */
  budget?: TaskBudget;
  /** **W1**：root 派发策略（缺省 `children-ok`） */
  dispatch?: TaskDispatch;
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
  private readonly negotiation: FleetNodeOptions['negotiation'] | null;

  constructor(options: FleetNodeOptions) {
    this.endpoint = { device: options.device, agent: options.agent ?? 'board' };
    this.store = options.store;
    this.transport = options.transport;
    this.quota = options.quota;
    this.negotiation = options.negotiation ?? null;
  }

  /**
   * 1d-b：对未终态任务应用发起端协商策略——未接受且未超限时**接受**
   * （确定性；`messageId` 幂等去重保证只发一次）。
   */
  async applyNegotiationPolicy(): Promise<number> {
    if (!this.negotiation) return 0;
    const policy = this.negotiation.policy ?? 'accept';
    const all = await this.negotiation.store.all();
    let responded = 0;
    for (const state of await this.states()) {
      if (state.terminal) continue;
      const tracker = new NegotiationTracker(state.taskId, { maxRounds: this.negotiation.maxRounds });
      for (const message of all) {
        if (message.taskId === state.taskId && validateNegotiationMessage(message).ok) tracker.apply(message);
      }
      const status = tracker.status();
      if (status.accepted || status.rejected || status.exceeded) continue;
      const messages = tracker.messages();
      const last = messages[messages.length - 1];
      // 只在对端（worker）发言后回应，避免自我循环
      if (last === undefined || last.from.device === this.endpoint.device) continue;
      const reply: NegotiationMessage =
        policy === 'accept'
          ? { v: 1, messageId: `${state.taskId}#accept@${this.endpoint.device}`, taskId: state.taskId, round: status.rounds, from: this.endpoint, kind: 'accept', text: 'accepted' }
          : { v: 1, messageId: `${state.taskId}#neg#${status.rounds + 1}@${this.endpoint.device}`, taskId: state.taskId, round: status.rounds + 1, from: this.endpoint, kind: 'counter', text: 'counter' };
      if (await this.negotiation.store.append(reply)) responded += 1;
    }
    return responded;
  }

  /**
   * 1d-a：等待从 `rootTaskId` 可达的**全部节点终态**（dagCompletion）。
   * 返回完成判定（含可达/待决节点），便于断言与汇总。
   */
  async waitForDagCompletion(
    rootTaskId: string,
    options: { timeoutMs: number; pollMs?: number },
  ): Promise<DagCompletion> {
    const pollMs = options.pollMs ?? 10;
    const deadline = Date.now() + options.timeoutMs;
    let completion: DagCompletion = dagCompletion([], () => false, rootTaskId);
    for (;;) {
      await this.pollOnce();
      await this.applyNegotiationPolicy();
      const states = await this.states();
      const terminal = new Set(states.filter((s) => s.terminal).map((s) => s.taskId));
      completion = dagCompletion(deriveEdges(states), (id) => terminal.has(id), rootTaskId);
      if (completion.complete || Date.now() >= deadline) return completion;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  /** 1d-a：审查 DAG 汇总——从 root 可达且终态的节点结果按 taskId 确定序拼接。 */
  async summarizeDag(rootTaskId: string): Promise<{ root: string; reachable: string[]; pending: string[]; summary: string }> {
    const states = await this.states();
    const terminal = new Set(states.filter((s) => s.terminal).map((s) => s.taskId));
    const completion = dagCompletion(deriveEdges(states), (id) => terminal.has(id), rootTaskId);
    const byId = new Map(states.map((s) => [s.taskId, s]));
    const summary = completion.reachable
      .filter((id) => terminal.has(id))
      .map((id) => `${id}=${byId.get(id)?.resultRef ?? ''}`)
      .join('|');
    return { root: completion.root, reachable: completion.reachable, pending: completion.pending, summary };
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
    if (request.budget !== undefined) event.budget = request.budget;
    if (request.dispatch !== undefined) event.dispatch = request.dispatch;
    await this.emit(event, request.to, request.deliveries ?? 1);
    return { taskId, decision };
  }

  /** 处理收件箱：把收到的状态事件幂等并入本地存储。返回本次新并入的事件数。 */
  async pollOnce(): Promise<number> {
    const messages = await this.transport.drain(this.endpoint);
    let applied = 0;
    let states = await this.states();
    for (const message of messages) {
      const event = message.event;
      // W1 入口拒收：越预算/越链长/root-only 的 created 不入库（纯函数、全端一致）
      if (event.type === 'created') {
        const verdict = admitCreated(event, states, reduceTaskEvents);
        if (!verdict.ok) continue;
      }
      if (await this.store.append(event)) {
        applied += 1;
        const reduced = reduceTaskEvents(await this.store.byTask(event.taskId));
        if (reduced !== null) states = states.filter((s) => s.taskId !== reduced.taskId).concat(reduced);
      }
    }
    return applied;
  }

  /** 权威任务视图（已剔除违反树不变式的任务）；供 DAG/汇总与验收读取。 */
  async statesView(): Promise<TaskState[]> {
    return this.states();
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
    // W1：权威视图剔除违反树不变式的任务（经记忆同步到达的无效 created 亦生效）
    const admissible = admissibleTaskIds(out);
    return out.filter((s) => admissible.has(s.taskId));
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
      await this.applyNegotiationPolicy();
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
