// Fleet M4 目标二单测：审查 DAG / 有限协商 / 配额制闲聊。

import { describe, it, expect } from '@jest/globals';
import {
  deriveEdges,
  detectCycle,
  wouldCreateCycle,
  assertAcyclicParent,
  dagCompletion,
  NegotiationTracker,
  negotiationDecision,
  validateNegotiationMessage,
  ChatterBox,
  validateChatterMessage,
  LocalQuota,
  reduceTaskEvents,
  type TaskState,
  type NegotiationMessage,
  type ChatterMessage,
} from '../../packages/fleet/src/index.js';
import { mkEvent, endpoint } from './helpers.js';

function task(id: string, parent?: string, terminal = false, agent = 'echo'): TaskState {
  const trace = parent !== undefined ? { causedBy: parent, chain: [parent] } : { chain: [] };
  const events = [mkEvent('created', id, { to: { device: 'device-B', agent }, intent: id, trace })];
  if (terminal) events.push(mkEvent('done', id, { eventId: `${id}#done`, payloadRef: id, trace }));
  return reduceTaskEvents(events)!;
}

describe('① 审查 DAG', () => {
  const states = [task('r', undefined, true), task('a', 'r', true), task('b', 'r', false), task('c', 'a', true)];
  const edges = deriveEdges(states);

  it('由 trace.causedBy 推导边（确定序）', () => {
    expect(edges).toEqual([
      { parent: 'a', child: 'c' },
      { parent: 'r', child: 'a' },
      { parent: 'r', child: 'b' },
    ]);
    expect(detectCycle(edges)).toBeNull();
  });

  it('完成判定：全部可达节点终态才算完成', () => {
    const isTerminal = (id: string) => states.find((s) => s.taskId === id)!.terminal;
    const partial = dagCompletion(edges, isTerminal, 'r');
    expect(partial.reachable).toEqual(['a', 'b', 'c', 'r']);
    expect(partial.pending).toEqual(['b']);
    expect(partial.complete).toBe(false);

    const all = [...states.filter((s) => s.taskId !== 'b'), task('b', 'r', true)];
    const done = dagCompletion(edges, (id) => all.find((s) => s.taskId === id)!.terminal, 'r');
    expect(done.complete).toBe(true);
    expect(done.pending).toEqual([]);
  });

  it('禁环：检测 + 创建守卫（负例）', () => {
    const cyclic = [
      { parent: 'a', child: 'b' },
      { parent: 'b', child: 'c' },
      { parent: 'c', child: 'a' },
    ];
    expect(detectCycle(cyclic)).not.toBeNull();
    expect(wouldCreateCycle([{ parent: 'b', child: 'c' }, { parent: 'c', child: 'a' }], 'a', 'b')).toBe(true);
    expect(wouldCreateCycle([], 'x', 'x')).toBe(true);
    expect(() => assertAcyclicParent([{ parent: 'b', child: 'c' }], 'a', 'b')).not.toThrow();
    expect(() => assertAcyclicParent([{ parent: 'b', child: 'c' }], 'c', 'b')).toThrow(/成环/);
    expect(() => assertAcyclicParent([{ parent: 'b', child: 'c' }, { parent: 'c', child: 'a' }], 'a', 'b')).toThrow(/成环/);
  });
});

function neg(over: Partial<NegotiationMessage> & Pick<NegotiationMessage, 'messageId' | 'round' | 'kind'>): NegotiationMessage {
  return { v: 1, taskId: 't1', from: endpoint('device-B', 'echo'), ...over };
}

describe('② 有限协商', () => {
  it('幂等 + 顺序无关 + 超限失败', () => {
    const tracker = new NegotiationTracker('t1', { maxRounds: 2 });
    expect(tracker.apply(neg({ messageId: 'm1', round: 1, kind: 'clarify' }))).toBe(true);
    expect(tracker.apply(neg({ messageId: 'm1', round: 1, kind: 'clarify' }))).toBe(false); // 幂等
    tracker.apply(neg({ messageId: 'm2', round: 2, kind: 'counter' }));
    expect(negotiationDecision(tracker.status())).toEqual({ action: 'continue' });

    tracker.apply(neg({ messageId: 'm3', round: 3, kind: 'clarify' }));
    expect(tracker.status()).toMatchObject({ rounds: 3, exceeded: true });
    expect(negotiationDecision(tracker.status())).toEqual({ action: 'fail', reason: 'NEGOTIATION_LIMIT: 3>2' });

    // 顺序无关：反向应用得到同样的消息列表
    const reverse = new NegotiationTracker('t1', { maxRounds: 2 });
    for (const m of tracker.messages().reverse()) reverse.apply(m);
    expect(reverse.messages().map((m) => m.messageId)).toEqual(['m1', 'm2', 'm3']);
    expect(reverse.status()).toEqual(tracker.status());
  });

  it('accept → proceed；reject → fail', () => {
    const a = new NegotiationTracker('t1', { maxRounds: 5 });
    a.apply(neg({ messageId: 'a1', round: 1, kind: 'accept' }));
    expect(negotiationDecision(a.status())).toEqual({ action: 'proceed' });
    const r = new NegotiationTracker('t1', { maxRounds: 5 });
    r.apply(neg({ messageId: 'r1', round: 1, kind: 'reject' }));
    expect(negotiationDecision(r.status())).toEqual({ action: 'fail', reason: 'NEGOTIATION_REJECTED' });
  });

  it('校验与非法输入（负例）', () => {
    expect(validateNegotiationMessage(neg({ messageId: 'm', round: 0, kind: 'clarify' })).ok).toBe(true);
    expect(validateNegotiationMessage({ ...neg({ messageId: 'm', round: 0, kind: 'clarify' }), round: -1 }).ok).toBe(false);
    expect(validateNegotiationMessage({ ...neg({ messageId: 'm', round: 0, kind: 'clarify' }), kind: 'nope' } as unknown).ok).toBe(false);
    expect(validateNegotiationMessage(null).ok).toBe(false);
    expect(() => new NegotiationTracker('t1', { maxRounds: -1 })).toThrow(/maxRounds/);
    const t = new NegotiationTracker('t1', { maxRounds: 1 });
    expect(() => t.apply(neg({ messageId: 'x', round: 0, kind: 'clarify', taskId: 'other' }) as NegotiationMessage)).toThrow(/taskId/);
  });
});

function chat(over: Partial<ChatterMessage> & Pick<ChatterMessage, 'messageId' | 'topic'>): ChatterMessage {
  return { v: 1, from: endpoint('device-A', 'board'), text: 'hi', ...over };
}

describe('③ 配额制闲聊', () => {
  it('发送走本地配额、超额排队；接收幂等；收件确定性', () => {
    const box = new ChatterBox(new LocalQuota({ limitPerDevice: 2, onOverflow: 'queue' }));
    expect(box.send(chat({ messageId: 'c1', topic: 't' }))).toBe('accepted');
    expect(box.send(chat({ messageId: 'c2', topic: 't' }))).toBe('accepted');
    expect(box.send(chat({ messageId: 'c3', topic: 't' }))).toBe('queued'); // 超额本地排队

    expect(box.receive(chat({ messageId: 'c3', topic: 'b' }))).toBe(true);
    expect(box.receive(chat({ messageId: 'c3', topic: 'b' }))).toBe(false); // 幂等
    box.receive(chat({ messageId: 'c1', topic: 'a' }));
    expect(box.inbox().map((m) => m.messageId)).toEqual(['c1', 'c3']); // 按 topic,messageId
    expect(box.size()).toBe(2);
  });

  it('reject 策略 + 校验负例', () => {
    const box = new ChatterBox(new LocalQuota({ limitPerDevice: 1, onOverflow: 'reject' }));
    expect(box.send(chat({ messageId: 'c1', topic: 't' }))).toBe('accepted');
    expect(box.send(chat({ messageId: 'c2', topic: 't' }))).toBe('rejected');
    expect(validateChatterMessage(chat({ messageId: 'c', topic: 't' })).ok).toBe(true);
    expect(validateChatterMessage({ ...chat({ messageId: 'c', topic: 't' }), text: '' }).ok).toBe(false);
    expect(validateChatterMessage({ ...chat({ messageId: 'c', topic: 't' }), from: { device: '', agent: 'a' } }).ok).toBe(false);
  });
});
