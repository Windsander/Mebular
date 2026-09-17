// Fleet 配额（M1）：性质 ③ 每设备本地记账、超额本地拒绝/排队（无全局协调）。

import { describe, it, expect } from '@jest/globals';
import { LocalQuota } from '../../packages/fleet/src/index.js';

describe('③ 本地配额账本', () => {
  it('按设备独立记账，超额按策略排队（默认 queue）', () => {
    const q = new LocalQuota({ limitPerDevice: 3 });
    expect(q.decide('device-A')).toBe('accepted');
    expect(q.decide('device-A', 2)).toBe('accepted');
    expect(q.decide('device-A')).toBe('queued'); // 3+1 > 3
    expect(q.used('device-A')).toBe(3);
    expect(q.queued('device-A')).toBe(1);

    // 其它设备不受影响（无全局账本）
    expect(q.decide('device-B')).toBe('accepted');
    expect(q.used('device-B')).toBe(1);
  });

  it('reject 策略：超额直接拒绝', () => {
    const q = new LocalQuota({ limitPerDevice: 1, onOverflow: 'reject' });
    expect(q.decide('device-A')).toBe('accepted');
    expect(q.decide('device-A')).toBe('rejected');
    expect(q.rejected('device-A')).toBe(1);
    expect(q.queued('device-A')).toBe(0);
  });

  it('账本守恒：accepted + queued + rejected == 请求总量', () => {
    const q = new LocalQuota({ limitPerDevice: 2 });
    let requested = 0;
    const amounts = [1, 1, 1, 2, 1];
    for (const a of amounts) {
      requested += a;
      q.decide('device-A', a);
    }
    const snap = q.snapshot().find((s) => s.device === 'device-A')!;
    expect(snap.used + snap.queued + snap.rejected).toBe(requested);
  });

  it('release / drainQueue 只在本地搬迁', () => {
    const q = new LocalQuota({ limitPerDevice: 2 });
    q.decide('device-A', 2);
    q.decide('device-A', 2); // queued=2
    expect(q.queued('device-A')).toBe(2);
    expect(q.drainQueue('device-A')).toBe(0); // 满容量，无可搬迁
    q.release('device-A', 2);
    expect(q.drainQueue('device-A')).toBe(2); // 搬迁入 used
    expect(q.used('device-A')).toBe(2);
    expect(q.queued('device-A')).toBe(0);
  });

  it('snapshot 按 device 字典序（确定性）', () => {
    const q = new LocalQuota({ limitPerDevice: 1 });
    q.decide('device-C');
    q.decide('device-A');
    q.decide('device-B');
    expect(q.snapshot().map((s) => s.device)).toEqual(['device-A', 'device-B', 'device-C']);
  });

  it('非法输入被拒绝（负例）', () => {
    expect(() => new LocalQuota({ limitPerDevice: 0 })).toThrow(/正整数/);
    const q = new LocalQuota({ limitPerDevice: 1 });
    expect(() => q.decide('device-A', 0)).toThrow(/正整数/);
    expect(() => q.decide('device-A', -1)).toThrow(/正整数/);
    expect(() => q.decide('device-A', 1.5)).toThrow(/正整数/);
    expect(() => q.drainQueue('device-A', -1)).toThrow(/capacity/);
  });
});
