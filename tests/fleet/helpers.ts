// Fleet 测试构造器（非 test 文件，不被 jest 当套件收集）。

import {
  EVENT_TO_STATUS,
  type FleetEndpoint,
  type FleetTrace,
  type TaskEvent,
  type TaskEventType,
} from '../../packages/fleet/src/index.js';

export function endpoint(device: string, agent: string): FleetEndpoint {
  return { device, agent };
}

export interface MkEventOptions {
  eventId?: string;
  actor?: FleetEndpoint;
  at?: number;
  trace?: FleetTrace;
  to?: FleetEndpoint;
  intent?: string;
  expiresAt?: number;
  payloadRef?: string;
  reason?: string;
  toStatus?: TaskEvent['toStatus'];
}

/** 构造一个合法 `TaskEvent`（默认值确保通过 `validateTaskEvent`）。 */
export function mkEvent(type: TaskEventType, taskId: string, opts: MkEventOptions = {}): TaskEvent {
  const event: TaskEvent = {
    v: 1,
    eventId: opts.eventId ?? `${taskId}#${type}`,
    taskId,
    type,
    actor: opts.actor ?? endpoint('device-A', 'planner'),
    at: opts.at ?? 0,
    toStatus: opts.toStatus ?? EVENT_TO_STATUS[type],
    trace: opts.trace ?? { chain: [] },
  };
  if (opts.to !== undefined) event.to = opts.to;
  if (opts.intent !== undefined) event.intent = opts.intent;
  if (opts.expiresAt !== undefined) event.expiresAt = opts.expiresAt;
  if (opts.payloadRef !== undefined) event.payloadRef = opts.payloadRef;
  if (opts.reason !== undefined) event.reason = opts.reason;
  if (type === 'created') {
    if (event.to === undefined) event.to = endpoint('device-B', '*');
    if (event.intent === undefined) event.intent = 'do-work';
  }
  return event;
}

/** 一条合法生命周期（created → ... → 终态之一），事件 id 唯一。 */
export function lifecycle(taskId: string, opts: { fail?: boolean; claims?: number; trace?: FleetTrace; expiresAt?: number } = {}): TaskEvent[] {
  const trace = opts.trace ?? { chain: [] };
  const events: TaskEvent[] = [mkEvent('created', taskId, { trace, ...(opts.expiresAt !== undefined ? { expiresAt: opts.expiresAt } : {}) })];
  const claims = opts.claims ?? 1;
  for (let i = 0; i < claims; i++) {
    events.push(mkEvent('claimed', taskId, { eventId: `${taskId}#claimed-${i}`, trace }));
  }
  if (opts.fail) {
    events.push(mkEvent('failed', taskId, { trace, reason: 'boom' }));
  } else {
    events.push(mkEvent('running', taskId, { trace }));
    events.push(mkEvent('done', taskId, { trace, payloadRef: `${taskId}-result` }));
  }
  return events;
}

/** 确定性 PRNG（mulberry32）。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates 洗牌（用给定 rng）。 */
export function shuffle<T>(input: readonly T[], rng: () => number): T[] {
  const out = [...input];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

// ---------------------------------------------------------------------------
// F-FLAKE-2：TS 版「精确断言谓词 + 条件驱动有界等待」
//
// 与 `scripts/lib/acceptance-conditions.mjs` **同语义**（后者是 .mjs 脚本侧的单一真源；jest 走
// ts-jest/CJS 转换，无法 import ESM，故在 TS 侧镜像）。**只等、不放宽**：谓词为真即返回，
// 超时后返回最后一次观测，由调用方以原断言判定；`pollMs` 仅作轮询节奏（非固定 sleep）。
// ---------------------------------------------------------------------------

export interface TaskStateLike {
  status?: string;
  reason?: string;
}

/** collab 1d-b 协商成功：任务到达 `done`。 */
export const negotiationDone = (state: TaskStateLike | null | undefined): boolean => state?.status === 'done';

/** collab 1d-b 超限：reason 恰为 `NEGOTIATION_LIMIT: 2>1`。 */
export const negotiationLimit = (state: TaskStateLike | null | undefined): boolean =>
  state?.reason === 'NEGOTIATION_LIMIT: 2>1';

/** collab 1d-a 负例：自环被拒 → `failed` 且 reason 形如 `DAG_CYCLE: …`。 */
export const dagCycleRejected = (state: TaskStateLike | null | undefined): boolean =>
  state?.status === 'failed' && /^DAG_CYCLE: /.test(state.reason ?? '');

interface DrivableNode<S> {
  pollOnce(): Promise<unknown>;
  applyNegotiationPolicy(): Promise<unknown>;
  stateOf(taskId: string): Promise<S | null>;
}

/**
 * 条件驱动的有界等待：轮询期间**保持节点驱动**（`pollOnce` + `applyNegotiationPolicy`，
 * 与 `waitForTerminal`/`waitForDagCompletion` 同语义；被动读会让任务不推进）。
 */
export async function waitForTaskState<S>(
  node: DrivableNode<S>,
  taskId: string,
  predicate: (state: S | null) => boolean,
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<{ ok: boolean; state: S | null }> {
  const { timeoutMs = 90000, pollMs = 10 } = options;
  const deadline = Date.now() + timeoutMs;
  const drive = async (): Promise<void> => {
    await node.pollOnce();
    await node.applyNegotiationPolicy();
  };
  await drive();
  let state = await node.stateOf(taskId);
  while (!predicate(state) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    await drive();
    state = await node.stateOf(taskId);
  }
  return { ok: predicate(state), state };
}
