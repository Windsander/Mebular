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
