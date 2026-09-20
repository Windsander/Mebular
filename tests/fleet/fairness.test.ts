// W1 公平准入：轮转（单一发送方不能占满）、每 Agent 并发门、确定性。
import { describe, it, expect } from '@jest/globals';
import { fairOrder, admitByConcurrency } from '../../packages/fleet/src/index.js';
import type { TaskState } from '../../packages/fleet/src/model.js';

function st(taskId: string, device: string, agent = 'worker'): TaskState {
  return {
    taskId,
    from: { device, agent: 'board' },
    to: { device: 'device-B', agent },
    intent: taskId,
    status: 'queued',
    attempts: 0,
    trace: { chain: [] },
    terminal: false,
    lastEventId: `${taskId}#created`,
  };
}

describe('W1 公平准入', () => {
  it('轮转：A:5 B:1 → B 不被饿死（前两拍含 B）', () => {
    const pending = [
      st('a1', 'device-A'), st('a2', 'device-A'), st('a3', 'device-A'), st('a4', 'device-A'), st('a5', 'device-A'),
      st('b1', 'device-B-sender'),
    ];
    const order = fairOrder(pending);
    expect(order).toHaveLength(6);
    expect(order.slice(0, 2)).toContain('b1');
    // 任何前缀：在 B 仍有待处理时，A 的份额不超过 50%（即不能连续两拍都取 A）
    const idx = order.indexOf('b1');
    expect(idx).toBeLessThanOrEqual(1);
  });

  it('轮转：等量交替（确定序、与输入顺序无关）', () => {
    const x = [st('a1', 'device-A'), st('a2', 'device-A'), st('b1', 'device-B-sender'), st('b2', 'device-B-sender')];
    const a = fairOrder(x);
    const b = fairOrder([...x].reverse());
    expect(a).toEqual(b);
    expect(a[0]).not.toBe(a[1]);
  });

  it('每 Agent 并发默认 2 + 来源对配额', () => {
    const ordered = [st('t1', 'device-A'), st('t2', 'device-A'), st('t3', 'device-A'), st('t4', 'device-C')];
    const admitted = admitByConcurrency(ordered, { agent: new Map(), pair: new Map() }, { perAgent: 2 });
    expect(admitted).toEqual(['t1', 't2']);
    const pairAdmitted = admitByConcurrency(ordered, { agent: new Map(), pair: new Map() }, { perAgent: 5, perPair: 1 });
    expect(pairAdmitted).toEqual(['t1', 't4']);
  });
});
