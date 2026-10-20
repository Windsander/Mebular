// 订阅策略矩阵（纯推导）：S-1 自声明 / R-b 作者级移出 / E-1 恢复纪元 / R-c 最新胜出。
import { describe, it, expect } from '@jest/globals';
import { derivePolicyState, hashPolicyState } from '../../src/sync/index.js';

type Entries = Parameters<typeof derivePolicyState>[0];
type Entry = Entries[number];

let seq = 0;
const reset = () => { seq = 0; };
function E(partial: Omit<Entry, 'seq' | 'logical' | 'order'>): Entry {
  seq += 1;
  return { ...partial, seq, logical: seq } as Entry;
}
function sub(author: string, ns: string, active = true, id = `s-${author}-${ns}-${seq + 1}`): Entry {
  return E({ kind: 'subscription', author, id, subscription: { member: author, namespace: ns, active, issuedAt: seq + 1 } });
}
function foreign(author: string, member: string, ns: string, id = `f-${author}-${member}-${seq + 1}`): Entry {
  return E({ kind: 'subscription', author, id, subscription: { member, namespace: ns, active: true, issuedAt: seq + 1 } });
}
function revoke(author: string, subject: string, id = `r-${author}-${subject}-${seq + 1}`): Entry {
  return E({ kind: 'device', author, id, device: { subject, issuedAt: seq + 1 } });
}
function restore(author: string, subject: string, id = `e-${author}-${subject}-${seq + 1}`): Entry {
  return E({ kind: 'restore', author, id, restore: { subject, issuedAt: seq + 1 } });
}
function declare(author: string, ns: string, id = `d-${author}-${ns}-${seq + 1}`): Entry {
  return E({ kind: 'declare', author, id, declaration: { namespace: ns, issuedAt: seq + 1 } });
}
const members = (state: ReturnType<typeof derivePolicyState>, ns: string) => [...(state.subscriptions.get(ns) ?? [])].sort();

describe('订阅矩阵', () => {
  const subscriptionCases: Array<[string, boolean, string[]]> = [
    ['A 自声明 active', true, ['A']],
    ['B 自声明 active', true, ['B']],
    ['A 自声明 inactive', false, []],
    ['B 自声明 inactive', false, []],
    ['A/B 同时 active', true, ['A', 'B']],
  ];
  it.each(subscriptionCases)('自声明：%s', (_label, active, expected) => {
    reset();
    const entries = expected.length === 2
      ? [sub('A', 'ns', true), sub('B', 'ns', true)]
      : [sub(expected[0] ?? 'A', 'ns', active)];
    expect(members(derivePolicyState(entries), 'ns')).toEqual(expected);
  });

  it.each([
    ['foreign A→B ignored', ['A', 'B'], ['A']],
    ['foreign B→A ignored', ['B', 'A'], ['B']],
  ])('S-1：%s', (_label, [author, member], expected) => {
    reset();
    const state = derivePolicyState([sub(author as string, 'ns'), foreign(author as string, member as string, 'ns')]);
    expect(members(state, 'ns')).toEqual(expected);
    expect(state.security?.rejections ?? []).toEqual(
      expect.arrayContaining([expect.objectContaining({ reason: 'foreign-subscription' })]),
    );
  });

  it.each([
    ['active→inactive', [true, false], []],
    ['inactive→active', [false, true], ['A']],
    ['active→inactive→active', [true, false, true], ['A']],
  ])('R-c 最新胜出：%s', (_label, flags, expected) => {
    reset();
    const entries = flags.map((active, index) => sub('A', 'ns', active, `s-${index}`));
    expect(members(derivePolicyState(entries), 'ns')).toEqual(expected);
  });

  it.each([
    ['被移出作者的订阅不采纳', () => [sub('B', 'ns'), revoke('A', 'B')], []],
    ['被移出成员的订阅不采纳', () => [sub('B', 'ns'), revoke('A', 'B')], []],
    ['其他作者不受影响', () => [sub('B', 'ns'), sub('C', 'ns'), revoke('A', 'B')], ['C']],
    ['重复移出不改变结果', () => [sub('B', 'ns'), revoke('A', 'B'), revoke('A', 'B')], []],
  ])('R-b：%s', (_label, build, expected) => {
    reset();
    expect(members(derivePolicyState(build()), 'ns')).toEqual(expected);
  });

  it.each([
    ['恢复后旧订阅不复活', () => [sub('B', 'ns'), revoke('A', 'B'), restore('A', 'B')], []],
  ])('E-1：%s', (_label, build, expected) => {
    reset();
    expect(members(derivePolicyState(build()), 'ns')).toEqual(expected);
  });

  it('E-1：恢复后的新订阅生效', () => {
    reset();
    const old = sub('B', 'ns', true, 'old');
    const rv = revoke('A', 'B');
    const rs = restore('A', 'B');
    const fresh = sub('B', 'ns', true, 'fresh');
    expect(members(derivePolicyState([old, rv, rs, fresh]), 'ns')).toEqual(['B']);
  });

  it('E-1：恢复前的移出记录不复活', () => {
    reset();
    const state = derivePolicyState([revoke('A', 'X'), revoke('B', 'A'), restore('C', 'A')]);
    expect(state.blocked.has('A')).toBe(false);
    expect(state.blocked.has('X')).toBe(false);
  });

  it.each([
    ['未移出设备的 restore 是 no-op', () => [restore('A', 'B')], false],
    ['自恢复不采纳', () => [restore('A', 'A')], false],
    ['自移出不采纳', () => [revoke('A', 'A')], false],
  ])('%s', (_label, build, blocked) => {
    reset();
    expect(derivePolicyState(build()).blocked.has('A')).toBe(blocked);
  });

  it.each([
    ['A 公告可见', () => [declare('A', 'ns')], ['ns']],
    ['被移出作者的公告不可见', () => [declare('B', 'ns'), revoke('A', 'B')], []],
    ['重复公告去重', () => [declare('A', 'ns'), declare('A', 'ns')], ['ns']],
  ])('域公告：%s', (_label, build, expected) => {
    reset();
    expect([...derivePolicyState(build()).declarations].sort()).toEqual(expected);
  });

  it('subscriptionRecords 记录 active 与 inactive', () => {
    reset();
    const state = derivePolicyState([sub('A', 'ns', true), sub('B', 'ns', false)]);
    expect([...(state.subscriptionRecords.get('ns') ?? [])].sort()).toEqual(['A', 'B']);
  });

  it('空输入收敛且无安全子对象', () => {
    const state = derivePolicyState([]);
    expect(state.converged).toBe(true);
    expect(state.security).toBeUndefined();
    expect(state.blocked.size).toBe(0);
  });

  it('策略哈希：订阅/移出/安全档变化 → 不同；同状态 → 相同', () => {
    reset();
    const base = derivePolicyState([sub('A', 'ns'), declare('A', 'ns')]);
    reset();
    const same = derivePolicyState([sub('A', 'ns'), declare('A', 'ns')]);
    expect(hashPolicyState(base)).toBe(hashPolicyState(same));
    reset();
    const subject = derivePolicyState([sub('B', 'ns'), declare('A', 'ns')]);
    expect(hashPolicyState(base)).not.toBe(hashPolicyState(subject));
    reset();
    const blocked = derivePolicyState([sub('A', 'ns'), revoke('B', 'A'), declare('A', 'ns')]);
    expect(hashPolicyState(base)).not.toBe(hashPolicyState(blocked));
    reset();
    const secure = derivePolicyState([sub('A', 'ns'), E({ kind: 'tier', author: 'A', id: 't', tier: { level: 'medium', nonce: 'n', issuedAt: 1 } })]);
    expect(hashPolicyState(base)).not.toBe(hashPolicyState(secure));
  });
});
