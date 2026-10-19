// 域公告（namespace_declare）：零门槛、自签名、随策略同步、目录可见 ≠ 可读。
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
const declare = (author: string, namespace: string, id = `d-${author}-${namespace}-${seq + 1}`): Entry =>
  E({ kind: 'declare', author, id, declaration: { namespace, issuedAt: seq + 1 } });
const revoke = (author: string, subject: string): Entry =>
  E({ kind: 'device', author, id: `r-${author}-${subject}-${seq + 1}`, device: { subject, issuedAt: seq + 1 } });
const restore = (author: string, subject: string): Entry =>
  E({ kind: 'restore', author, id: `e-${author}-${subject}-${seq + 1}`, restore: { subject, issuedAt: seq + 1 } });
const sub = (author: string, namespace: string, id = `s-${author}-${namespace}-${seq + 1}`): Entry =>
  E({ kind: 'subscription', author, id, subscription: { member: author, namespace, active: true, issuedAt: seq + 1 } });

describe('namespace_declare', () => {
  it('任何可信设备可建域（零门槛）', () => {
    reset();
    expect([...derivePolicyState([declare('A', 'ledger')]).declarations]).toEqual(['ledger']);
  });

  it('多个设备可公告同一域（去重）', () => {
    reset();
    expect([...derivePolicyState([declare('A', 'ledger'), declare('B', 'ledger')]).declarations]).toEqual(['ledger']);
  });

  it('重复公告同一域去重', () => {
    reset();
    expect([...derivePolicyState([declare('A', 'ledger'), declare('A', 'ledger')]).declarations]).toEqual(['ledger']);
  });

  it('域的可见性与订阅无关', () => {
    reset();
    const state = derivePolicyState([declare('A', 'ledger')]);
    expect(state.declarations.has('ledger')).toBe(true);
    expect(state.subscriptions.has('ledger')).toBe(false);
  });

  it('订阅不自动产生公告', () => {
    reset();
    const state = derivePolicyState([sub('A', 'ledger')]);
    expect(state.subscriptions.get('ledger')?.has('A')).toBe(true);
    expect(state.declarations.has('ledger')).toBe(false);
  });

  it('被移出作者的公告不采纳（R-b 含历史）', () => {
    reset();
    expect([...derivePolicyState([declare('B', 'ledger'), revoke('A', 'B')]).declarations]).toEqual([]);
  });

  it('恢复后旧纪元公告不复活（E-1）', () => {
    reset();
    const state = derivePolicyState([declare('B', 'ledger'), revoke('A', 'B'), restore('A', 'B')]);
    expect(state.declarations.has('ledger')).toBe(false);
  });

  it('公告进入策略哈希（跨端目录一致）', () => {
    reset();
    const one = derivePolicyState([declare('A', 'ledger')]);
    reset();
    const two = derivePolicyState([declare('A', 'other')]);
    expect(hashPolicyState(one)).not.toBe(hashPolicyState(two));
  });
});
