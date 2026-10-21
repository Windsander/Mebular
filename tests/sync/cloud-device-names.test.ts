// 展示名（cloud_name / device_name）：纯推导测试。
//
// 口径：latest-writer-wins 严格按 vector clock/logical order（不用 issuedAt 墙钟）；
// device_name 只能改本人；最终 blocked 作者的事件不生效；非法名称/空事件安全回退。

import { describe, it, expect } from '@jest/globals';
import { derivePolicyState } from '../../src/sync/index.js';
import {
  CLOUD_NAME_EVENT,
  DEVICE_NAME_EVENT,
} from '../../src/sync/grantPolicy.js';
import { normalizeDisplayName } from '../../src/core/displayName.js';

type Entries = Parameters<typeof derivePolicyState>[0];
type Entry = Entries[number];

interface NameEntryInput {
  author: string;
  seq: number;
  logical?: number;
  id?: string;
  name?: string;
  subject?: string;
  issuedAt?: number;
  at?: number;
}

const cloud = (input: NameEntryInput): Entry => ({
  kind: 'cloud_name',
  author: input.author,
  seq: input.seq,
  logical: input.logical ?? input.seq,
  id: input.id ?? `c-${input.author}-${input.seq}`,
  at: input.at ?? input.seq,
  cloudName: { v: 1, name: input.name ?? `cloud-${input.author}`, issuedAt: input.issuedAt ?? input.seq },
});

const device = (input: NameEntryInput): Entry => ({
  kind: 'device_name',
  author: input.author,
  seq: input.seq,
  logical: input.logical ?? input.seq,
  id: input.id ?? `d-${input.author}-${input.seq}`,
  at: input.at ?? input.seq,
  deviceName: {
    v: 1,
    subject: input.subject ?? input.author,
    name: input.name ?? `device-${input.author}`,
    issuedAt: input.issuedAt ?? input.seq,
  },
});

const revoke = (author: string, subject: string, seq: number): Entry => ({
  kind: 'device',
  author,
  seq,
  logical: seq,
  id: `r-${author}-${subject}-${seq}`,
  at: seq,
  device: { subject, issuedAt: seq },
});

const restore = (author: string, subject: string, seq: number): Entry => ({
  kind: 'restore',
  author,
  seq,
  logical: seq,
  id: `e-${author}-${subject}-${seq}`,
  at: seq,
  restore: { subject, issuedAt: seq },
});

describe('cloud_name', () => {
  it('latest-writer-wins：按事件定序覆盖，不看 issuedAt 墙钟', () => {
    const state = derivePolicyState([
      // issuedAt 很大但定序在前（seq/logical 低）
      cloud({ author: 'device-A', seq: 1, logical: 1, name: '旧名', issuedAt: 9_999_999 }),
      cloud({ author: 'device-B', seq: 1, logical: 2, name: '新名', issuedAt: 1 }),
    ]);
    expect(state.cloudName?.name).toBe('新名');
    expect(state.cloudName?.author).toBe('device-B');
  });

  it('同作者后写覆盖前写（seq 定序）', () => {
    const state = derivePolicyState([
      cloud({ author: 'device-A', seq: 2, name: '第二次' }),
      cloud({ author: 'device-A', seq: 1, name: '第一次' }),
    ]);
    expect(state.cloudName?.name).toBe('第二次');
  });

  it('输入顺序不影响结果（确定性）', () => {
    const entries = [
      cloud({ author: 'device-A', seq: 1, logical: 2, name: 'A' }),
      cloud({ author: 'device-B', seq: 1, logical: 2, name: 'B' }),
      cloud({ author: 'device-C', seq: 1, logical: 1, name: 'C' }),
    ];
    const one = derivePolicyState(entries);
    const two = derivePolicyState([...entries].reverse());
    expect(one.cloudName).toEqual(two.cloudName);
    expect(one.cloudName?.name).toBe('B'); // logical 平局 → author 字典序大者
  });

  it('没有共享事件 → 不回退、不伪造：cloudName 缺省', () => {
    const state = derivePolicyState([]);
    expect(state.cloudName).toBeUndefined();
    expect(state.deviceNames?.size).toBe(0);
  });

  it('被移出作者的名字不生效（最终 blocked）', () => {
    const state = derivePolicyState([
      cloud({ author: 'device-A', seq: 1, name: '被移出者的名字' }),
      revoke('device-B', 'device-A', 1),
    ]);
    expect(state.cloudName).toBeUndefined();
  });

  it('非法名称忽略，其余 snapshot 不崩', () => {
    for (const bad of ['', '   ', 'a/b', 'a\\b', 'a..b', '忆'.repeat(25), '\u0000\u0001']) {
      const state = derivePolicyState([cloud({ author: 'device-A', seq: 1, name: bad })]);
      expect(state.cloudName).toBeUndefined();
      expect(state.converged).toBe(true);
    }
  });
});

describe('device_name', () => {
  it('只能改本人：伪造 subject 被忽略', () => {
    const state = derivePolicyState([
      device({ author: 'device-A', seq: 1, subject: 'device-B', name: '冒名' }),
    ]);
    expect(state.deviceNames?.get('device-B')).toBeUndefined();
    expect(state.deviceNames?.get('device-A')).toBeUndefined();
  });

  it('本人记录按 latest-writer-wins 生效', () => {
    const state = derivePolicyState([
      device({ author: 'device-A', seq: 1, name: '甲' }),
      device({ author: 'device-A', seq: 2, name: '甲的笔记本' }),
    ]);
    expect(state.deviceNames?.get('device-A')?.name).toBe('甲的笔记本');
  });

  it('不同设备各自独立，互不覆盖', () => {
    const state = derivePolicyState([
      device({ author: 'device-A', seq: 1, name: 'A 的名字' }),
      device({ author: 'device-B', seq: 1, name: 'B 的名字' }),
    ]);
    expect(state.deviceNames?.get('device-A')?.name).toBe('A 的名字');
    expect(state.deviceNames?.get('device-B')?.name).toBe('B 的名字');
  });

  it('被移出设备改名不生效', () => {
    const state = derivePolicyState([
      device({ author: 'device-A', seq: 2, name: '被移出后改名' }),
      revoke('device-B', 'device-A', 1),
    ]);
    expect(state.deviceNames?.get('device-A')).toBeUndefined();
  });

  it('恢复后旧纪元名字不复活（E-1），恢复后的新名字生效', () => {
    const state = derivePolicyState([
      device({ author: 'device-A', seq: 1, name: '旧纪元' }),
      revoke('device-B', 'device-A', 1),
      restore('device-B', 'device-A', 2),
      // 真实场景中恢复后的改名事件已看到 B 的时钟（logical 更大），定序在恢复之后。
      device({ author: 'device-A', seq: 2, logical: 5, name: '新纪元' }),
    ]);
    expect(state.deviceNames?.get('device-A')?.name).toBe('新纪元');
  });
});

describe('normalizeDisplayName', () => {
  it('去控制字符 / trim；1–24 Unicode 字符', () => {
    expect(normalizeDisplayName('  工作室  ')).toBe('工作室');
    expect(normalizeDisplayName('a\u0000b')).toBe('ab');
    expect(normalizeDisplayName('😀'.repeat(24))).toBe('😀'.repeat(24));
    expect(normalizeDisplayName('😀'.repeat(25))).toBeNull();
    expect(normalizeDisplayName('/')).toBeNull();
    expect(normalizeDisplayName('..')).toBeNull();
    expect(normalizeDisplayName('')).toBeNull();
  });
});

describe('event type constants', () => {
  it('沿用 __policy__ 元数据通道的稳定事件名', () => {
    expect(CLOUD_NAME_EVENT).toBe('cloud_name');
    expect(DEVICE_NAME_EVENT).toBe('device_name');
  });
});
