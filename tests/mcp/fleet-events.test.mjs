// Fleet 事件流：纯映射 + 事件接线（本地 event-appended / 远端 events-applied）。
//
// 只测只读广播，不涉及任务/同步协议写入。

import { describe, it, expect } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  attachFleetEvents,
  fleetEventFromEvent,
  resolveFleetNamespace,
  TASK_NAMESPACE_DEFAULT,
} from '../../packages/mcp/src/fleet-events.mjs';

const taskContent = (overrides = {}) => ({
  v: 1,
  eventId: 'task-a#created',
  taskId: 'task-a',
  type: 'created',
  actor: { device: 'device-a', agent: 'main' },
  at: 1_700_000_000_000,
  toStatus: 'queued',
  trace: { chain: [] },
  to: { device: 'device-b', agent: 'echo' },
  intent: 'run tests',
  ...overrides,
});

const logEvent = ({ id = 'evt-1', namespace = 'tasks', content = taskContent(), nodeType = 'task_event' } = {}) => ({
  id,
  type: 'node_created',
  timestamp: 1_700_000_000_000,
  namespace,
  data: {
    node: {
      id: 'node-1',
      type: nodeType,
      namespace,
      content,
    },
  },
});

const flush = async (times = 6) => {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

describe('fleetEventFromEvent：真实任务 created → fleet 载荷', () => {
  it('从事件日志 node_created 事件映射（字段名严格符合前端契约）', () => {
    const payload = fleetEventFromEvent(logEvent(), { namespace: 'tasks', now: () => 1_800_000_000_000 });
    expect(payload).toEqual({
      at: 1_800_000_000_000,
      fromDeviceId: 'device-a',
      toDeviceId: 'device-b',
      taskId: 'task-a',
      eventType: 'created',
      namespace: 'tasks',
    });
  });

  it('兼容裸任务节点（type=task_event + content）', () => {
    const payload = fleetEventFromEvent({
      type: 'task_event',
      namespace: 'tasks',
      content: taskContent(),
    }, { namespace: 'tasks', now: 42 });
    expect(payload).toMatchObject({
      at: 42,
      fromDeviceId: 'device-a',
      toDeviceId: 'device-b',
      taskId: 'task-a',
      eventType: 'created',
      namespace: 'tasks',
    });
  });

  it('自定义任务域只广播本域事件', () => {
    const payload = fleetEventFromEvent(logEvent({ namespace: 'board' }), { namespace: 'board', now: () => 1 });
    expect(payload?.namespace).toBe('board');
    expect(fleetEventFromEvent(logEvent({ namespace: 'board' }), { namespace: 'tasks' })).toBeNull();
  });

  it('拒绝非 task_event 节点', () => {
    expect(fleetEventFromEvent(logEvent({ nodeType: 'memory' }))).toBeNull();
  });

  it('拒绝非 created 事件（claimed/running/done/failed）', () => {
    for (const type of ['claimed', 'running', 'done', 'failed']) {
      expect(fleetEventFromEvent(logEvent({ content: taskContent({ type }) }))).toBeNull();
    }
  });

  it('缺 taskId / actor.device / to.device 时返回 null', () => {
    expect(fleetEventFromEvent(logEvent({ content: taskContent({ taskId: '' }) }))).toBeNull();
    expect(fleetEventFromEvent(logEvent({ content: taskContent({ actor: { agent: 'main' } }) }))).toBeNull();
    expect(fleetEventFromEvent(logEvent({ content: taskContent({ to: { agent: 'echo' } }) }))).toBeNull();
    expect(fleetEventFromEvent(logEvent({ content: taskContent({ to: undefined }) }))).toBeNull();
  });

  it('nonsense 输入不抛异常，返回 null', () => {
    for (const value of [null, undefined, 0, 'x', [], {}, { type: 'task_event' }, { data: { node: null } }]) {
      expect(() => fleetEventFromEvent(value)).not.toThrow();
      expect(fleetEventFromEvent(value)).toBeNull();
    }
  });
});

describe('resolveFleetNamespace：fleet.config.json 优先，缺省回退', () => {
  it('读取 fleet.config.json 的 namespace', async () => {
    const home = await mkdtemp(join(tmpdir(), 'fleet-events-ns-'));
    try {
      await writeFile(join(home, 'fleet.config.json'), JSON.stringify({ namespace: 'board' }));
      await expect(resolveFleetNamespace({ home, fallback: 'tasks' })).resolves.toBe('board');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('缺文件 / 解析失败 / 无 namespace 时回退', async () => {
    const home = await mkdtemp(join(tmpdir(), 'fleet-events-ns-'));
    try {
      await expect(resolveFleetNamespace({ home })).resolves.toBe(TASK_NAMESPACE_DEFAULT);
      await writeFile(join(home, 'fleet.config.json'), '{not json');
      await expect(resolveFleetNamespace({ home, fallback: 'board' })).resolves.toBe('board');
      await writeFile(join(home, 'fleet.config.json'), JSON.stringify({ device: 'x' }));
      await expect(resolveFleetNamespace({ home, fallback: 'board' })).resolves.toBe('board');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('attachFleetEvents：本地 + 远端接线、去重、清理', () => {
  const makeSources = () => {
    const eventLog = new EventEmitter();
    const sync = new EventEmitter();
    const events = new Map();
    eventLog.getEvent = async (id) => events.get(id) ?? null;
    return { eventLog, sync, events };
  };

  it('本地 append 广播一次；同一事件重复 append 不重复广播', async () => {
    const { eventLog, sync } = makeSources();
    const sent = [];
    const detach = attachFleetEvents({
      eventLog,
      sync,
      namespace: 'tasks',
      send: (name, payload) => sent.push({ name, payload }),
      now: () => 7,
    });
    try {
      const event = logEvent();
      eventLog.emit('event-appended', event);
      eventLog.emit('event-appended', event);
      await flush();
      expect(sent).toHaveLength(1);
      expect(sent[0]).toEqual({
        name: 'fleet',
        payload: {
          at: 7,
          fromDeviceId: 'device-a',
          toDeviceId: 'device-b',
          taskId: 'task-a',
          eventType: 'created',
          namespace: 'tasks',
        },
      });
    } finally {
      detach();
    }
  });

  it('远端 events-applied 按 eventIds 回查后广播，且与本地同一事件只发一次', async () => {
    const { eventLog, sync, events } = makeSources();
    const remote = { ...logEvent({ id: 'evt-remote' }), id: 'evt-remote' };
    events.set('evt-remote', remote);
    const sent = [];
    const detach = attachFleetEvents({
      eventLog,
      sync,
      namespace: 'tasks',
      send: (name, payload) => sent.push({ name, payload }),
      now: () => 9,
    });
    try {
      // 先远端应用，再本地看到同一条日志事件（模拟同步回灌）：去重键 event:evt-remote
      sync.emit('events-applied', { eventIds: ['evt-remote'], namespaces: ['tasks'] });
      await flush();
      eventLog.emit('event-appended', remote);
      await flush();
      expect(sent).toHaveLength(1);
      expect(sent[0].payload).toMatchObject({ taskId: 'task-a', fromDeviceId: 'device-a', toDeviceId: 'device-b' });
    } finally {
      detach();
    }
  });

  it('远端非任务域事件 / 缺失事件被忽略', async () => {
    const { eventLog, sync, events } = makeSources();
    events.set('evt-other', logEvent({ id: 'evt-other', namespace: 'other' }));
    const sent = [];
    const detach = attachFleetEvents({
      eventLog,
      sync,
      namespace: 'tasks',
      send: (name, payload) => sent.push({ name, payload }),
    });
    try {
      sync.emit('events-applied', { eventIds: ['evt-other', 'evt-missing'] });
      await flush();
      expect(sent).toEqual([]);
    } finally {
      detach();
    }
  });

  it('清理后移除两端监听，不再广播', async () => {
    const { eventLog, sync, events } = makeSources();
    events.set('evt-remote', logEvent({ id: 'evt-remote' }));
    const sent = [];
    const detach = attachFleetEvents({
      eventLog,
      sync,
      namespace: 'tasks',
      send: (name, payload) => sent.push({ name, payload }),
    });
    expect(eventLog.listenerCount('event-appended')).toBe(1);
    expect(sync.listenerCount('events-applied')).toBe(1);
    detach();
    expect(eventLog.listenerCount('event-appended')).toBe(0);
    expect(sync.listenerCount('events-applied')).toBe(0);
    eventLog.emit('event-appended', logEvent({ id: 'evt-after' }));
    sync.emit('events-applied', { eventIds: ['evt-remote'] });
    await flush();
    expect(sent).toEqual([]);
  });

  it('缺少事件源 / send 时返回空清理函数，不抛异常', () => {
    expect(() => attachFleetEvents()()).not.toThrow();
    expect(() => attachFleetEvents({ eventLog: new EventEmitter() })()).not.toThrow();
  });
});
