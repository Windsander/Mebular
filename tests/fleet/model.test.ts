// Fleet 模型（M1）单元测试：镜像 PROTOCOL-INVARIANTS.md 的性质 ①..⑤。

import { describe, it, expect } from '@jest/globals';
import {
  reduceTaskEvents,
  dedupeEvents,
  IdempotentTaskApplier,
  validateTaskTransition,
  assertTaskTransition,
  isExpiredLocally,
  validateTaskEvent,
  STATUS_RANK,
} from '../../packages/fleet/src/index.js';
import { mkEvent, lifecycle, shuffle, mulberry32 } from './helpers.js';

describe('① 至少一次投递 + 幂等应用', () => {
  it('重复投递不改变状态、不重复执行', () => {
    const events = lifecycle('t1');
    const applier = new IdempotentTaskApplier();
    for (const e of events) expect(applier.apply(e).applied).toBe(true);

    const settled = applier.state('t1')!;
    expect(settled.status).toBe('done');
    expect(settled.attempts).toBe(1);

    // 再次投递同一批（重复交付）
    for (const e of events) {
      const outcome = applier.apply(e);
      expect(outcome.applied).toBe(false);
      expect(outcome.state).toEqual(settled);
    }
    // shouldExecute：重复事件不得再执行
    expect(applier.shouldExecute(events[1]!)).toBe(false);
    expect(applier.hasApplied('t1', events[1]!.eventId)).toBe(true);
  });

  it('reducer 对重复事件幂等（去重）', () => {
    const events = lifecycle('t2', { claims: 2 });
    const withDups = [...events, ...events, events[0]!];
    expect(reduceTaskEvents(withDups)).toEqual(reduceTaskEvents(events));
    expect(dedupeEvents(withDups)).toHaveLength(events.length);
    expect(reduceTaskEvents(withDups)!.attempts).toBe(2);
  });
});

describe('② 因果链可追（trace/chain）', () => {
  it('causedBy 与 chain 保留且去重排序', () => {
    const parent = lifecycle('parent');
    const child = mkEvent('created', 'child', {
      trace: { causedBy: 'parent', chain: ['root', 'parent'] },
    });
    const parentState = reduceTaskEvents(parent)!;
    const childState = reduceTaskEvents([child])!;
    expect(parentState.taskId).toBe('parent');
    expect(childState.trace.causedBy).toBe('parent');
    expect(childState.trace.chain).toEqual(['parent', 'root']); // 去重+排序
    expect(childState.trace.chain).toContain('parent'); // 指向存在的父任务
  });
});

describe('④ expiresAt 只影响本机展示，不影响跨端状态', () => {
  it('权威状态与 at / expiresAt / now 无关', () => {
    const base = lifecycle('t4', { expiresAt: 100 });
    const laterAt = base.map((e) => ({ ...e, at: 9_999_999 }));
    expect(reduceTaskEvents(laterAt)).toEqual(reduceTaskEvents(base));

    const state = reduceTaskEvents(base)!;
    expect(state.status).toBe('done');
    expect(isExpiredLocally(state.expiresAt, 50)).toBe(false);
    expect(isExpiredLocally(state.expiresAt, 100)).toBe(true);
    expect(isExpiredLocally(undefined, 10 ** 12)).toBe(false);
    // 展示层判定不影响权威状态
    expect(reduceTaskEvents(base)!.status).toBe(state.status);
  });
});

describe('⑤ 非法迁移 / 非法输入必须拒绝（负例）', () => {
  it('迁移表拒绝非法与跳级', () => {
    expect(validateTaskTransition('queued', 'claimed')).toBe(true);
    expect(validateTaskTransition('queued', 'running')).toBe(false); // 不可跳级
    expect(validateTaskTransition('done', 'running')).toBe(false);
    expect(validateTaskTransition('failed', 'done')).toBe(false);
    expect(validateTaskTransition('running', 'running')).toBe(true); // 幂等自迁移
    expect(() => assertTaskTransition('done', 'running')).toThrow(/非法任务状态迁移/);
  });

  it('事件校验拒绝类型/状态不一致与缺失字段', () => {
    expect(validateTaskEvent(mkEvent('claimed', 't5')).ok).toBe(true);
    // toStatus 与 type 不一致
    expect(validateTaskEvent({ ...mkEvent('claimed', 't5'), toStatus: 'done' }).ok).toBe(false);
    // created 缺 to / intent
    const noTo = { ...mkEvent('created', 't5') } as Record<string, unknown>;
    delete noTo.to;
    expect(validateTaskEvent(noTo).ok).toBe(false);
    // 非法 type / 非有限 at / 负 attempt 不适用（事件无 attempts）
    expect(validateTaskEvent({ ...mkEvent('claimed', 't5'), type: 'bogus' }).ok).toBe(false);
    expect(validateTaskEvent({ ...mkEvent('claimed', 't5'), at: Number.NaN }).ok).toBe(false);
    expect(validateTaskEvent(null).ok).toBe(false);
  });
});

describe('确定性收敛（顺序无关 + 终态裁决）', () => {
  it('任意排列得到同一权威状态', () => {
    const events = lifecycle('t6', { claims: 2 });
    const rng = mulberry32(0x5eed);
    const ref = reduceTaskEvents(events);
    for (let i = 0; i < 20; i++) {
      expect(reduceTaskEvents(shuffle(events, rng))).toEqual(ref);
      expect(reduceTaskEvents([...shuffle(events, rng), ...events])).toEqual(ref); // 洗牌+重复
    }
  });

  it('并发 done vs failed：终态平局裁决（failed 优先），与顺序无关', () => {
    const events = [
      mkEvent('created', 't7'),
      mkEvent('failed', 't7', { at: 1, reason: 'boom' }),
      mkEvent('done', 't7', { at: 2, payloadRef: 'r' }),
    ];
    const a = reduceTaskEvents(events)!;
    const b = reduceTaskEvents([...events].reverse())!;
    expect(a.status).toBe('failed');
    expect(b.status).toBe('failed');
    expect(STATUS_RANK[a.status]).toBe(3);
  });

  it('缺少 created → null（未知任务）', () => {
    expect(reduceTaskEvents([])).toBeNull();
    expect(reduceTaskEvents([mkEvent('claimed', 'x')])).toBeNull();
  });
});
