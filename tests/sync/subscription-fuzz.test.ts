// 订阅策略 fuzz（确定性、无网络）：
// - 排列不变：同一输入任意顺序 → 同一 PolicyState；
// - 幂等：重复推导一致；
// - 无授权轴：输出只有 subscriptions/blocked/declarations/security。
import { describe, it, expect } from '@jest/globals';
import { derivePolicyState, hashPolicyState } from '../../src/sync/index.js';

type Entries = Parameters<typeof derivePolicyState>[0];
type Entry = Entries[number];

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function makeEntries(seed: number): Entries {
  const rand = rng(seed);
  const entries: Entries = [];
  const devices = ['A', 'B', 'C', 'D'];
  const namespaces = ['nsA', 'nsB', 'nsC'];
  let seq = 0;
  const next = () => (seq += 1);
  const push = (entry: Omit<Entry, 'seq' | 'logical' | 'order'>) => {
    const s = next();
    entries.push({ ...entry, seq: s, logical: s } as Entry);
  };
  const count = 6 + Math.floor(rand() * 10);
  for (let i = 0; i < count; i += 1) {
    const kind = rand();
    const author = devices[Math.floor(rand() * devices.length)]!;
    const ns = namespaces[Math.floor(rand() * namespaces.length)]!;
    if (kind < 0.5) {
      push({ kind: 'subscription', author, id: `s-${seed}-${i}`, subscription: { member: author, namespace: ns, active: rand() > 0.25, issuedAt: i } });
    } else if (kind < 0.65) {
      const member = devices[Math.floor(rand() * devices.length)]!;
      push({ kind: 'subscription', author, id: `f-${seed}-${i}`, subscription: { member, namespace: ns, active: true, issuedAt: i } });
    } else if (kind < 0.82) {
      const subject = devices[Math.floor(rand() * devices.length)]!;
      push({ kind: 'device', author, id: `r-${seed}-${i}`, device: { subject, issuedAt: i } });
    } else if (kind < 0.94) {
      const subject = devices[Math.floor(rand() * devices.length)]!;
      push({ kind: 'restore', author, id: `e-${seed}-${i}`, restore: { subject, issuedAt: i } });
    } else {
      push({ kind: 'declare', author, id: `d-${seed}-${i}`, declaration: { namespace: ns, issuedAt: i } });
    }
  }
  return entries;
}

function snapshot(state: ReturnType<typeof derivePolicyState>) {
  const subscriptions: Record<string, string[]> = {};
  for (const [ns, set] of [...state.subscriptions].sort()) subscriptions[ns] = [...set].sort();
  const records: Record<string, string[]> = {};
  for (const [ns, set] of [...state.subscriptionRecords].sort()) records[ns] = [...set].sort();
  return {
    subscriptions,
    records,
    subscriptionNamespaces: [...state.subscriptionNamespaces].sort(),
    blocked: [...state.blocked].sort(),
    declarations: [...state.declarations].sort(),
    restoreAt: [...state.restoreAt.entries()].sort(),
    security: state.security ?? null,
  };
}

describe('订阅策略 fuzz（60 个确定性种子）', () => {
  const seeds = Array.from({ length: 60 }, (_, index) => index + 1);
  it.each(seeds)('seed=%i：排列不变 + 幂等 + 无授权轴', (seed) => {
    const entries = makeEntries(seed);
    const base = derivePolicyState(entries);
    const reversed = derivePolicyState([...entries].reverse());
    const rotated = derivePolicyState([...entries.slice(3), ...entries.slice(0, 3)]);
    expect(snapshot(reversed)).toEqual(snapshot(base));
    expect(snapshot(rotated)).toEqual(snapshot(base));
    expect(hashPolicyState(reversed)).toBe(hashPolicyState(base));
    expect('authorized' in base).toBe(false);
    expect('issuers' in base).toBe(false);
    expect('members' in base).toBe(false);
    expect(base.converged).toBe(true);
    expect(base.iterations).toBeGreaterThan(0);
  });
});
