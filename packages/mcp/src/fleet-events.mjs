// Fleet 事件流：把**真实任务事件**映射为 `/admin/events` 的 `fleet` 广播载荷。
//
// 任务事件以图示记忆节点（`type='task_event'`）承载；事件日志里对应
// `node_created` 事件（`data.node` 即任务节点）。本模块只做只读映射与接线：
//   - 本地写入：`eventLog.on('event-appended')`（仅本地 append 触发）
//   - 远端应用：`sync.on('events-applied')`（按 eventIds 回查 eventLog）
// 不写存储、不改任务/同步协议。无效事件一律返回 null / 静默跳过，不抛异常。

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** 任务事件节点的类型（`MebularTaskEventStore` 默认值）。 */
export const TASK_EVENT_NODE_TYPE = 'task_event';

/** 任务域默认 namespace（`fleet.config.json` 缺省 / 缺文件）。 */
export const TASK_NAMESPACE_DEFAULT = 'tasks';

/** 当前可广播的 TaskEvent 类型 → `fleet` 载荷的 `eventType`（先只保证 created）。 */
const FLEET_EVENT_TYPES = Object.freeze({
  created: 'created',
});

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmptyString = (value) => typeof value === 'string' && value.length > 0;

/**
 * 从事件日志事件中取任务节点。兼容三种形状：
 *   1) 日志事件：`{ type:'node_created', data:{ node:{ type:'task_event', ... } } }`
 *   2) 带 node 字段：`{ node:{ type:'task_event', ... } }`
 *   3) 裸任务节点：`{ type:'task_event', content:{...}, namespace }`
 */
function taskNodeOf(event) {
  if (!isRecord(event)) return null;
  const data = isRecord(event.data) ? event.data : null;
  const candidates = [
    data?.node,
    event.node,
    data && data.type === TASK_EVENT_NODE_TYPE ? data : null,
    event.type === TASK_EVENT_NODE_TYPE ? event : null,
  ];
  for (const candidate of candidates) {
    if (isRecord(candidate) && candidate.type === TASK_EVENT_NODE_TYPE) return candidate;
  }
  return null;
}

/** 事件的 namespace：节点优先；日志事件回退自身；缺失按 core 语义视为 `default`。 */
function namespaceOf(event, node) {
  if (nonEmptyString(node?.namespace)) return node.namespace;
  if (nonEmptyString(event?.namespace)) return event.namespace;
  if (nonEmptyString(event?.data?.namespace)) return event.data.namespace;
  return 'default';
}

/**
 * 纯映射：事件 → `fleet` SSE 载荷（无效 / 不属于任务域 / 非 created / 缺字段 → null）。
 *
 * 载荷契约（前端按此实现，勿改字段名）：
 * `{ at, fromDeviceId, toDeviceId, taskId, eventType:'created', namespace }`
 * `at` 为广播时刻（与本文件其它 SSE 事件一致）。
 *
 * @param {unknown} event 事件日志事件（或任务节点）
 * @param {{ namespace?: string, now?: (() => number) | number }} [options]
 */
export function fleetEventFromEvent(event, options = {}) {
  try {
    const namespace = nonEmptyString(options.namespace) ? options.namespace : TASK_NAMESPACE_DEFAULT;
    const node = taskNodeOf(event);
    if (!node) return null;
    if (namespaceOf(event, node) !== namespace) return null;

    const content = isRecord(node.content)
      ? node.content
      : (isRecord(event?.content) ? event.content : null);
    if (!content) return null;
    if (typeof content.type !== 'string') return null;

    const eventType = FLEET_EVENT_TYPES[content.type];
    if (!eventType) return null;

    const taskId = nonEmptyString(content.taskId) ? content.taskId : null;
    const fromDeviceId = nonEmptyString(content.actor?.device) ? content.actor.device : null;
    const toDeviceId = nonEmptyString(content.to?.device) ? content.to.device : null;
    if (!taskId || !fromDeviceId || !toDeviceId) return null;

    const now = typeof options.now === 'function' ? options.now() : options.now;
    const at = Number.isFinite(now) ? Number(now) : Date.now();

    return { at, fromDeviceId, toDeviceId, taskId, eventType, namespace };
  } catch {
    return null;
  }
}

/**
 * 读取本机任务域：优先 `fleet.config.json` 的 `namespace`；缺文件 / 解析失败时回退
 * 守护运行时的 namespace（`config.sync.namespaces[0]`，默认 `tasks`）。
 */
export async function resolveFleetNamespace({ home, fallback = TASK_NAMESPACE_DEFAULT } = {}) {
  const fallbackNamespace = nonEmptyString(fallback) ? fallback : TASK_NAMESPACE_DEFAULT;
  if (!nonEmptyString(home)) return fallbackNamespace;
  try {
    const raw = JSON.parse(await readFile(join(home, 'fleet.config.json'), 'utf-8'));
    return nonEmptyString(raw?.namespace) ? raw.namespace : fallbackNamespace;
  } catch {
    return fallbackNamespace;
  }
}

/**
 * 接线：把事件源接到 `send('fleet', payload)`，返回清理函数（移除监听、停止后续投递）。
 *
 * - 同一事件只广播一次：以日志事件 id + `taskId#eventType` 双键去重；
 *   本地 append 与远端应用的同一条事件共享日志 id，因此不会重复。
 * - 远端 `events-applied` 只拿到 eventIds，用 `eventLog.getEvent(id)` 回查完整事件。
 * - 去重集合有上界（默认 4096），按插入顺序淘汰最旧键，避免长连接无界增长。
 */
export function attachFleetEvents({
  eventLog,
  sync = null,
  namespace = TASK_NAMESPACE_DEFAULT,
  send,
  now = Date.now,
  dedupeLimit = 4096,
} = {}) {
  if (!eventLog || typeof eventLog.on !== 'function' || typeof send !== 'function') {
    return () => undefined;
  }
  const targetNamespace = nonEmptyString(namespace) ? namespace : TASK_NAMESPACE_DEFAULT;
  const limit = Number.isFinite(dedupeLimit) && dedupeLimit > 0 ? Math.floor(dedupeLimit) : 4096;
  const seen = new Set();
  let closed = false;

  const claim = (keys) => {
    const present = keys.filter(nonEmptyString);
    if (present.some((key) => seen.has(key))) return false;
    for (const key of present) {
      seen.add(key);
      if (seen.size > limit) {
        const oldest = seen.values().next().value;
        if (oldest !== undefined) seen.delete(oldest);
      }
    }
    return true;
  };

  const emit = (event) => {
    if (closed) return false;
    const payload = fleetEventFromEvent(event, { namespace: targetNamespace, now });
    if (!payload) return false;
    const keys = [];
    if (nonEmptyString(event?.id)) keys.push(`event:${event.id}`);
    keys.push(`task:${payload.taskId}#${payload.eventType}`);
    if (!claim(keys)) return false;
    try {
      send('fleet', payload);
    } catch {
      // 连接已断开：不抛出，继续等清理
    }
    return true;
  };

  const onAppended = (event) => {
    emit(event);
  };

  const onEventsApplied = (info) => {
    if (closed || typeof eventLog.getEvent !== 'function') return;
    const ids = Array.isArray(info?.eventIds) ? info.eventIds : [];
    if (ids.length === 0) return;
    void (async () => {
      for (const id of ids) {
        if (closed) return;
        let event = null;
        try {
          event = await eventLog.getEvent(id);
        } catch {
          continue;
        }
        if (event) emit(event);
      }
    })().catch(() => undefined);
  };

  eventLog.on('event-appended', onAppended);
  const removeApplied = () => {
    if (sync && typeof sync.off === 'function') sync.off('events-applied', onEventsApplied);
  };
  if (sync && typeof sync.on === 'function') sync.on('events-applied', onEventsApplied);

  return () => {
    if (closed) return;
    closed = true;
    try {
      if (typeof eventLog.off === 'function') eventLog.off('event-appended', onAppended);
      else if (typeof eventLog.removeListener === 'function') eventLog.removeListener('event-appended', onAppended);
    } catch {
      // ignore
    }
    try {
      removeApplied();
    } catch {
      // ignore
    }
  };
}
