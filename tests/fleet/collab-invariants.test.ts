// Fleet M4 目标二随机 harness：审查 DAG / 有限协商 / 配额制闲聊。
//
// 固定种子、可复现。每组断言：确定性（顺序无关）/ 幂等 / 守恒，并做 oracle-free 扰动
// （删叶子子树、删重复消息）——只用输入与输出，不依赖实现内部。

import { describe, it, expect } from '@jest/globals';
import {
  deriveEdges,
  detectCycle,
  dagCompletion,
  NegotiationTracker,
  negotiationDecision,
  ChatterBox,
  LocalQuota,
  reduceTaskEvents,
  type TaskState,
  type DagEdge,
  type NegotiationMessage,
  type ChatterMessage,
  type NegotiationKind,
} from '../../packages/fleet/src/index.js';
import { mkEvent, endpoint, mulberry32, shuffle } from './helpers.js';

const SCENARIOS = 200;
const KINDS: NegotiationKind[] = ['clarify', 'counter', 'accept', 'reject'];

describe('fleet 协作形态随机不变量（固定种子）', () => {
  it(`${SCENARIOS} 组：DAG 禁环/完成、协商幂等/超限、闲聊配额/去重`, () => {
    const rng = mulberry32(0xc011ab);
    let anomalies = 0;
    let dags = 0;
    let nego = 0;
    let chats = 0;
    const fail = (msg: string): never => {
      anomalies += 1;
      throw new Error(msg);
    };

    // 独立可达性（oracle-free 交叉检查）
    const reach = (edges: DagEdge[], root: string): string[] => {
      const children = new Map<string, string[]>();
      for (const e of edges) children.set(e.parent, [...(children.get(e.parent) ?? []), e.child]);
      const seen = new Set<string>();
      const stack = [root];
      while (stack.length) {
        const n = stack.pop()!;
        if (seen.has(n)) continue;
        seen.add(n);
        for (const c of children.get(n) ?? []) stack.push(c);
      }
      return [...seen].sort();
    };

    for (let scenario = 0; scenario < SCENARIOS; scenario++) {
      // ---------- ① 审查 DAG ----------
      const n = 1 + Math.floor(rng() * 6);
      const ids = Array.from({ length: n }, (_, i) => `s${scenario}-${i}`);
      const states: TaskState[] = [];
      for (let i = 0; i < n; i++) {
        const parent = i > 0 && rng() < 0.6 ? ids[Math.floor(rng() * i)]! : undefined;
        const trace = parent !== undefined ? { causedBy: parent, chain: [parent] } : { chain: [] };
        const events = [mkEvent('created', ids[i]!, { to: { device: 'device-B', agent: 'echo' }, intent: ids[i]!, trace })];
        if (rng() < 0.6) events.push(mkEvent('done', ids[i]!, { eventId: `${ids[i]}#done`, trace }));
        states.push(reduceTaskEvents(events)!);
      }
      dags += 1;
      const edges = deriveEdges(states);
      if (detectCycle(edges) !== null) fail(`构造的森林不应有环 @${scenario}`);

      const terminal = (id: string) => states.find((s) => s.taskId === id)!.terminal;
      const roots = ids.filter((id) => !states.find((s) => s.taskId === id)!.trace.causedBy);
      for (const root of roots) {
        const c1 = dagCompletion(edges, terminal, root);
        const c2 = dagCompletion(edges, terminal, root);
        if (JSON.stringify(c1) !== JSON.stringify(c2)) fail(`DAG 完成判定不确定 @${scenario}`);
        if (JSON.stringify(c1.reachable) !== JSON.stringify(reach(edges, root))) {
          fail(`DAG reachable 与独立可达性不一致 @${scenario}`);
        }
      }
      // 顺序无关：打乱 states 后 deriveEdges 不变
      const reshuffled = deriveEdges(shuffle(states, rng));
      if (JSON.stringify(reshuffled) !== JSON.stringify(edges)) fail(`DAG 边顺序无关失败 @${scenario}`);

      // oracle-free 扰动：删除一个叶子节点后，不含该叶子的 root 完成判定不变
      const childSet = new Set(edges.map((e) => e.child));
      const leaf = ids.find((id) => !childSet.has(id));
      if (leaf !== undefined) {
        const reduced = states.filter((s) => s.taskId !== leaf);
        for (const root of roots) {
          if (reach(edges, root).includes(leaf)) continue;
          const before = dagCompletion(edges, terminal, root);
          const after = dagCompletion(deriveEdges(reduced), (id) => reduced.find((s) => s.taskId === id)!.terminal, root);
          if (JSON.stringify(before) !== JSON.stringify(after)) fail(`删叶子 ${leaf} 改变了 root ${root} @${scenario}`);
        }
      }

      // ---------- ② 有限协商 ----------
      const maxRounds = 1 + Math.floor(rng() * 4);
      const count = Math.floor(rng() * 6);
      const messages: NegotiationMessage[] = [];
      for (let j = 0; j < count; j++) {
        messages.push({
          v: 1,
          messageId: `s${scenario}-m${j}`,
          taskId: `s${scenario}-t`,
          round: Math.floor(rng() * (maxRounds + 2)),
          from: endpoint('device-B', 'echo'),
          kind: KINDS[Math.floor(rng() * KINDS.length)]!,
        });
      }
      if (messages.length > 0) {
        nego += 1;
        // 顺序无关 + 幂等：随机顺序 + 重复应用 == 去重后按序应用
        const shuffled = [...shuffle(messages, rng), ...messages]; // 叠加重复
        const t1 = new NegotiationTracker(`s${scenario}-t`, { maxRounds });
        for (const m of shuffled) t1.apply(m);
        const canonical = [...new Map(messages.map((m) => [m.messageId, m])).values()];
        const t2 = new NegotiationTracker(`s${scenario}-t`, { maxRounds });
        for (const m of canonical) t2.apply(m);
        if (JSON.stringify(t1.messages()) !== JSON.stringify(t2.messages())) fail(`协商顺序无关/幂等失败 @${scenario}`);
        if (JSON.stringify(t1.status()) !== JSON.stringify(t2.status())) fail(`协商状态不确定 @${scenario}`);
        const d1 = negotiationDecision(t1.status());
        const d2 = negotiationDecision(t1.status());
        if (JSON.stringify(d1) !== JSON.stringify(d2)) fail(`协商裁定不确定 @${scenario}`);

        // oracle-free 扰动：删除重复投递（每 id 只留一条）不改变结果
        const t3 = new NegotiationTracker(`s${scenario}-t`, { maxRounds });
        for (const m of canonical) t3.apply(m);
        if (JSON.stringify(t3.status()) !== JSON.stringify(t2.status())) fail(`协商去重扰动失败 @${scenario}`);
      }

      // ---------- ③ 配额制闲聊 ----------
      {
        const limit = 1 + Math.floor(rng() * 3);
        const mode = rng() < 0.5 ? 'queue' : 'reject';
        const box = new ChatterBox(new LocalQuota({ limitPerDevice: limit, onOverflow: mode }));
        const devices = ['device-A', 'device-B'];
        const sends = Math.floor(rng() * 6);
        const tap = new Map<string, { accepted: number; queued: number; rejected: number }>();
        const counts = new Map<string, number>();
        for (let j = 0; j < sends; j++) {
          const device = devices[Math.floor(rng() * devices.length)]!;
          const decision = box.send({ v: 1, messageId: `s${scenario}-c${j}`, from: endpoint(device, 'a'), topic: 't', text: 'x' });
          const t = tap.get(device) ?? { accepted: 0, queued: 0, rejected: 0 };
          t[decision] += 1;
          tap.set(device, t);
          counts.set(device, (counts.get(device) ?? 0) + 1);
        }
        // 独立账本口径（不依赖实现内部）：每设备 accepted=min(c,limit)，余量按策略 queue/reject。
        for (const [device, c] of counts) {
          const expected = {
            accepted: Math.min(c, limit),
            queued: mode === 'queue' ? Math.max(0, c - limit) : 0,
            rejected: mode === 'reject' ? Math.max(0, c - limit) : 0,
          };
          const got = tap.get(device)!;
          if (JSON.stringify(got) !== JSON.stringify(expected)) fail(`闲聊账本不守恒 @${scenario} device=${device}`);
          if (got.accepted + got.queued + got.rejected !== c) fail(`闲聊账本总和不等于发送数 @${scenario}`);
        }
        // 接收幂等 + 顺序无关
        const recvs: ChatterMessage[] = [];
        const rcount = Math.floor(rng() * 6);
        for (let j = 0; j < rcount; j++) {
          recvs.push({ v: 1, messageId: `s${scenario}-r${j}`, from: endpoint('device-A', 'a'), topic: `t${j % 2}`, text: 'x' });
        }
        for (const m of [...shuffle(recvs, rng), ...recvs]) box.receive(m); // 叠加重复
        const dedup = [...new Map(recvs.map((m) => [m.messageId, m])).values()];
        const box2 = new ChatterBox(new LocalQuota({ limitPerDevice: 100 }));
        for (const m of shuffle(dedup, rng)) box2.receive(m);
        if (JSON.stringify(box.inbox()) !== JSON.stringify(box2.inbox())) fail(`闲聊收件顺序无关/幂等失败 @${scenario}`);
        chats += 1;
      }
    }

    // eslint-disable-next-line no-console
    console.log(
      `[fleet-collab] scenarios=${SCENARIOS} dagScenarios=${dags} negotiation=${nego} chatter=${chats} anomalies=${anomalies}`,
    );
    expect(anomalies).toBe(0);
  }, 60000);
});
