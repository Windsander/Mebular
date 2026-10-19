// 订阅自主策略不变量（greenfield）：
// - 排列不变 / 幂等；
// - S-1 自声明（author === member）；
// - R-b 作者级移出（含历史）；
// - E-1 恢复纪元（恢复前策略记录不复活）；
// - 无授权轴（PolicyState 没有 authorized/issuers/members）。
//
// 纯推导用例直接构造 ParsedEntry，不依赖加密/同步。

import { describe, it, expect } from '@jest/globals';
import { derivePolicyState, hashPolicyState } from '../../src/sync/index.js';

type Entries = Parameters<typeof derivePolicyState>[0];
type Entry = Entries[number];

let seq = 0;
function entry(partial: Omit<Entry, 'seq' | 'logical' | 'order'>): Entry {
  seq += 1;
  return { ...partial, seq, logical: seq } as Entry;
}

function reset(): void {
  seq = 0;
}

function sub(author: string, namespace: string, active = true, id = `s-${author}-${namespace}-${seq + 1}`): Entry {
  return entry({ kind: 'subscription', author, id, subscription: { member: author, namespace, active, issuedAt: seq + 1 } });
}

function foreign(author: string, member: string, namespace: string, id = `f-${author}-${member}-${seq + 1}`): Entry {
  return entry({ kind: 'subscription', author, id, subscription: { member, namespace, active: true, issuedAt: seq + 1 } });
}

function revoke(author: string, subject: string, id = `r-${author}-${subject}-${seq + 1}`): Entry {
  return entry({ kind: 'device', author, id, device: { subject, issuedAt: seq + 1 } });
}

function restore(author: string, subject: string, id = `e-${author}-${subject}-${seq + 1}`): Entry {
  return entry({ kind: 'restore', author, id, restore: { subject, issuedAt: seq + 1 } });
}

function declare(author: string, namespace: string, id = `d-${author}-${namespace}-${seq + 1}`): Entry {
  return entry({ kind: 'declare', author, id, declaration: { namespace, issuedAt: seq + 1 } });
}

function snapshot(state: ReturnType<typeof derivePolicyState>) {
  const subscriptions: Record<string, string[]> = {};
  for (const [ns, members] of [...state.subscriptions].sort()) subscriptions[ns] = [...members].sort();
  return {
    subscriptions,
    subscriptionNamespaces: [...state.subscriptionNamespaces].sort(),
    blocked: [...state.blocked].sort(),
    declarations: [...state.declarations].sort(),
    restoreAt: [...state.restoreAt.entries()].sort(),
  };
}

describe('订阅策略不变量', () => {
  it('排列不变：打乱输入顺序，订阅/移出/公告/纪元完全一致', () => {
    reset();
    const entries: Entries = [
      sub('A', 'nsA'),
      sub('B', 'nsA'),
      sub('B', 'nsB'),
      revoke('A', 'C'),
      restore('B', 'C'),
      declare('C', 'nsC'),
      sub('C', 'nsC'),
    ];
    const base = snapshot(derivePolicyState(entries));
    const shuffled = [entries[4]!, entries[1]!, entries[6]!, entries[0]!, entries[3]!, entries[5]!, entries[2]!];
    expect(snapshot(derivePolicyState(shuffled))).toEqual(base);
    expect(snapshot(derivePolicyState(entries))).toEqual(base); // 幂等
  });

  it('S-1：author !== member 的替他人声明不采纳，并进拒绝诊断', () => {
    reset();
    const state = derivePolicyState([
      sub('A', 'nsA'),
      foreign('A', 'B', 'nsA'),
    ]);
    expect([...(state.subscriptions.get('nsA') ?? [])]).toEqual(['A']);
    expect(state.security?.rejections ?? []).toContainEqual(
      expect.objectContaining({ reason: 'foreign-subscription' }),
    );
  });

  it('R-b：被移出作者的历史订阅/公告不采纳；移出只作用于本人', () => {
    reset();
    const state = derivePolicyState([
      sub('B', 'nsA'),
      declare('B', 'nsB'),
      revoke('A', 'B'),
      sub('C', 'nsA'),
    ]);
    expect([...(state.subscriptions.get('nsA') ?? [])]).toEqual(['C']);
    expect(state.declarations.has('nsB')).toBe(false);
    expect([...state.blocked]).toEqual(['B']);
  });

  it('E-1：恢复后旧纪元订阅不复活；恢复后的新订阅才生效', () => {
    reset();
    const oldSub = sub('B', 'nsA', true, 'old-sub');
    const state = derivePolicyState([
      oldSub,
      revoke('A', 'B'),
      restore('A', 'B'),
    ]);
    expect([...(state.subscriptions.get('nsA') ?? [])]).toEqual([]);
    expect(state.blocked.has('B')).toBe(false);
    expect(state.restoreAt.has('B')).toBe(true);

    reset();
    const oldSub2 = sub('B', 'nsA', true, 'old-sub');
    const revokeEntry = revoke('A', 'B');
    const restoreEntry = restore('A', 'B');
    const newSub = sub('B', 'nsA', true, 'new-sub');
    const after = derivePolicyState([oldSub2, revokeEntry, restoreEntry, newSub]);
    expect([...(after.subscriptions.get('nsA') ?? [])]).toEqual(['B']);
  });

  it('恢复前的移出记录不复活：恢复 A 后 A 旧纪元发出的 device_revoke 失效', () => {
    reset();
    const state = derivePolicyState([
      revoke('A', 'X'),
      revoke('B', 'A'),
      restore('C', 'A'),
    ]);
    // A 被 B 移出后由 C 恢复；A 的旧移出记录属于旧纪元，不应继续压制 X
    expect(state.blocked.has('A')).toBe(false);
    expect(state.blocked.has('X')).toBe(false);
  });

  it('自移出 / 自恢复不采纳', () => {
    reset();
    const state = derivePolicyState([revoke('A', 'A'), restore('A', 'A')]);
    expect(state.blocked.has('A')).toBe(false);
    expect(state.restoreAt.has('A')).toBe(false);
  });

  it('无授权轴：PolicyState 没有 authorized/issuers/members；哈希仅随订阅/移出/安全档变化', () => {
    reset();
    const state = derivePolicyState([sub('A', 'nsA'), declare('A', 'nsA')]);
    expect('authorized' in state).toBe(false);
    expect('issuers' in state).toBe(false);
    expect('members' in state).toBe(false);
    expect(hashPolicyState(state)).toBe(hashPolicyState(derivePolicyState([sub('A', 'nsA'), declare('A', 'nsA')])));
  });
});
