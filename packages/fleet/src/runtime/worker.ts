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
import type { MebularMessageStore } from '../store/message-store.js';
import type { TaskTransport } from '../transport/types.js';
import type { ExecutorRegistry } from './agent.js';
import { executeOnce, type ExecutionLog, type TaskExecutor } from './executor.js';
import { assertAcyclicParent, deriveEdges } from '../collab/dag.js';
import { childTaskId, type PlannedChild, type TaskPlanner } from './planner.js';
import {
  NegotiationTracker,
  negotiationDecision,
  validateNegotiationMessage,
  type NegotiationMessage,
} from '../collab/negotiation.js';

export interface FleetWorkerOptions {
  device: string;
  /** 本 worker 标识（注册表模式下作为端标识；单执行器模式下用于 agent 匹配） */
  agent: string;
  store: TaskEventStore;
  transport: TaskTransport;
  /** 单执行器模式（旧）：本 worker 只服务该 agent 名 / `'*'` */
  executor?: TaskExecutor;
  /** 注册表模式：按 `to.agent` 选执行器；未知 agent → 任务 `failed`（UNKNOWN_AGENT） */
  registry?: ExecutorRegistry;
  log: ExecutionLog;
  /** 1d-a：执行成功后的**派生计划**（审查 DAG）；缺省不派生 */
  planner?: TaskPlanner;
  /**
   * 1d-b：有限协商（可选）。启用判定为真的任务在**执行前**走协商：
   * 未接受则发出下一轮 `counter`，超 `maxRounds` → `failed`（NEGOTIATION_LIMIT）；
   * 收到 `accept` → 继续执行。消息按 `messageId` 幂等。
   */
  negotiation?: {
    store: MebularMessageStore<NegotiationMessage>;
    maxRounds: number;
    enabled: (state: TaskState) => boolean;
  };
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
  private readonly executor: TaskExecutor | null;
  private readonly registry: ExecutorRegistry | null;
  private readonly log: ExecutionLog;
  private readonly planner: TaskPlanner | null;
  private readonly negotiation: FleetWorkerOptions['negotiation'] | null;
  private stopped = false;

  constructor(options: FleetWorkerOptions) {
    this.endpoint = { device: options.device, agent: options.agent };
    this.store = options.store;
    this.transport = options.transport;
    this.executor = options.executor ?? null;
    this.registry = options.registry ?? null;
    if (this.executor === null && this.registry === null) {
      throw new Error('FleetWorker 需要 executor（单执行器）或 registry（按 agent 路由）之一');
    }
    this.log = options.log;
    this.planner = options.planner ?? null;
    this.negotiation = options.negotiation ?? null;
  }

  /** 全部任务权威状态（按 taskId 排序；供 DAG 推导）。 */
  private async states(): Promise<TaskState[]> {
    const byTask = new Map<string, TaskEvent[]>();
    for (const event of await this.store.all()) {
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

  /**
   * 1d-b：执行前的有限协商。返回 `proceed`（可执行）或 `handled`（已回写/失败）。
   * 未接受：发下一轮 `counter`（直到超过 `maxRounds` → `NEGOTIATION_LIMIT`）。
   */
  private async handleNegotiation(state: TaskState): Promise<'proceed' | 'handled'> {
    const negotiation = this.negotiation!;
    const tracker = new NegotiationTracker(state.taskId, { maxRounds: negotiation.maxRounds });
    for (const message of await negotiation.store.all()) {
      if (message.taskId === state.taskId && validateNegotiationMessage(message).ok) tracker.apply(message);
    }
    const decision = negotiationDecision(tracker.status());
    if (decision.action === 'proceed') return 'proceed';
    if (decision.action === 'fail') {
      await this.complete(state, undefined, false, decision.reason);
      return 'handled';
    }
    // 轮次：**轮到本端**才发起下一轮 counter（避免空转刷轮次）。对方已回复（或首发）→ 本端回合。
    const messages = tracker.messages();
    const status = tracker.status();
    const last = messages[messages.length - 1];
    const ourTurn = last === undefined || last.from.device !== this.endpoint.device;
    const nextRound = status.rounds + 1;
    if (ourTurn && nextRound <= negotiation.maxRounds + 1) {
      const message: NegotiationMessage = {
        v: 1,
        messageId: `${state.taskId}#neg#${nextRound}@${this.endpoint.device}`,
        taskId: state.taskId,
        round: nextRound,
        from: this.endpoint,
        kind: 'counter',
        text: 'need more detail',
      };
      await negotiation.store.append(message);
    }
    return 'handled';
  }

  /**
   * 1d-a：派生直接子任务（`created` 事件）。禁环守卫先行；成环则返回错误原因（不静默）。
   */
  private async emitChildren(state: TaskState, children: readonly PlannedChild[]): Promise<string | null> {
    let edges = deriveEdges(await this.states());
    const planned: Array<{ child: PlannedChild; childId: string }> = [];
    for (let i = 0; i < children.length; i++) {
      const child = children[i]!;
      const childId = child.taskId ?? childTaskId(state.taskId, i);
      try {
        assertAcyclicParent(edges, state.taskId, childId);
      } catch {
        return `DAG_CYCLE: ${state.taskId}→${childId}`;
      }
      edges = [...edges, { parent: state.taskId, child: childId }];
      planned.push({ child, childId });
    }
    for (const { child, childId } of planned) {
      const to = child.to ?? state.to;
      await this.emit(
        {
          v: 1,
          eventId: `${childId}#created`,
          taskId: childId,
          type: 'created',
          actor: this.endpoint,
          at: Date.now(),
          toStatus: 'queued',
          trace: { causedBy: state.taskId, chain: [...state.trace.chain, state.taskId] },
          to,
          intent: child.intent,
          ...(child.payloadRef !== undefined ? { payloadRef: child.payloadRef } : {}),
        },
        to,
      );
    }
    return null;
  }

  /** 注册表模式：按设备职责认领（agent 由注册表解析）；单执行器模式：设备 + agent 匹配。 */
  private targetsMe(state: TaskState): boolean {
    if (state.to.device !== this.endpoint.device) return false;
    if (this.registry !== null) return true;
    return state.to.agent === this.endpoint.agent || state.to.agent === '*';
  }

  /** 解析执行器；注册表模式下未知 agent 返回 null（须显式失败）。 */
  private executorFor(state: TaskState): TaskExecutor | null {
    if (this.registry !== null) return this.registry.resolve(state.to.agent);
    return this.executor;
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
    let executed = 0;
    for (const state of await this.states()) {
      if (executed >= maxTasks) break;
      if (state.terminal || !this.targetsMe(state)) continue;

      // 1d-b：有限协商（可选）——未接受前不执行
      if (this.negotiation && this.negotiation.enabled(state)) {
        const decided = await this.handleNegotiation(state);
        if (decided === 'handled') continue;
      }

      const executor = this.executorFor(state);
      if (executor === null) {
        // 未知 agent：显式失败（绝不静默回退）。
        await this.complete(state, undefined, false, `UNKNOWN_AGENT: ${state.to.agent}`);
        continue;
      }
      const before = this.log.size();
      const outcome = await executeOnce(state, executor, this.log);
      if (this.log.size() > before) executed += 1;

      // 1d-a：执行成功按计划派生子任务；成环 → 父任务显式失败（不静默）
      if (outcome.ok && this.planner) {
        const children = this.planner.plan(state, {
          ok: outcome.ok,
          ...(outcome.resultRef !== undefined ? { resultRef: outcome.resultRef } : {}),
        });
        if (children.length > 0) {
          const cycle = await this.emitChildren(state, children);
          if (cycle !== null) {
            await this.complete(state, outcome.resultRef, false, cycle);
            continue;
          }
        }
      }
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
