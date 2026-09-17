// Fleet 事件校验（M1）：`validateTaskEvent` / `isTaskEvent` 的字段级负例。

import { describe, it, expect } from '@jest/globals';
import {
  validateTaskEvent,
  isTaskEvent,
  isTaskEventType,
  EVENT_TO_STATUS,
  TASK_EVENT_TYPES,
} from '../../packages/fleet/src/index.js';
import { mkEvent } from './helpers.js';

describe('任务事件校验', () => {
  const base = mkEvent('claimed', 't1', { eventId: 'e1' });

  it('合法事件通过', () => {
    expect(validateTaskEvent(base)).toEqual({ ok: true, errors: [] });
    expect(isTaskEvent(base)).toBe(true);
  });

  it('类型守卫与映射', () => {
    expect(TASK_EVENT_TYPES.every((t) => isTaskEventType(t))).toBe(true);
    expect(isTaskEventType('bogus')).toBe(false);
    expect(isTaskEventType(1)).toBe(false);
    expect(EVENT_TO_STATUS.created).toBe('queued');
    expect(EVENT_TO_STATUS.done).toBe('done');
  });

  it('逐字段负例被拒绝', () => {
    const bad: Array<[string, unknown]> = [
      ['非对象', null],
      ['数组', []],
      ['v 错误', { ...base, v: 2 }],
      ['eventId 空', { ...base, eventId: '' }],
      ['taskId 空', { ...base, taskId: '' }],
      ['type 非法', { ...base, type: 'nope' }],
      ['actor 非法', { ...base, actor: { device: '', agent: 'a' } }],
      ['at 非有限', { ...base, at: Number.POSITIVE_INFINITY }],
      ['toStatus 非法', { ...base, toStatus: 'nope' }],
      ['toStatus 与 type 不一致', { ...base, toStatus: 'done' }],
      ['trace 缺失', { ...base, trace: null }],
      ['causedBy 非法', { ...base, trace: { causedBy: 1, chain: [] } }],
      ['chain 非数组', { ...base, trace: { chain: 'x' } }],
      ['chain 元素非字符串', { ...base, trace: { chain: [1] } }],
      ['payloadRef 非法', { ...base, payloadRef: 1 }],
      ['reason 非法', { ...base, reason: 1 }],
      ['非 created 的 expiresAt 非法', { ...base, expiresAt: Number.NaN }],
    ];
    for (const [label, value] of bad) {
      const result = validateTaskEvent(value);
      expect([label, result.ok]).toEqual([label, false]);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(isTaskEvent(value)).toBe(false);
    }
  });

  it('created 必填 to / intent，可选 expiresAt 须有限', () => {
    const noTo = { ...mkEvent('created', 't2') } as Record<string, unknown>;
    delete noTo.to;
    expect(validateTaskEvent(noTo).ok).toBe(false);
    const noIntent = { ...mkEvent('created', 't2') } as Record<string, unknown>;
    delete noIntent.intent;
    expect(validateTaskEvent(noIntent).ok).toBe(false);
    expect(validateTaskEvent({ ...mkEvent('created', 't2'), expiresAt: 5 }).ok).toBe(true);
    expect(validateTaskEvent({ ...mkEvent('created', 't2'), expiresAt: 'soon' }).ok).toBe(false);
  });
});
