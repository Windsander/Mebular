// MebularMessageStore：幂等 append / 过滤（namespace、形状）/ 确定序 / 默认 namespace。
// 用内存假 Mebular（仅 graph.listNodes/createNode）做 hermetic 单测。

import { describe, it, expect } from '@jest/globals';
import { MebularMessageStore } from '../../packages/fleet/src/store/message-store.js';

interface Msg {
  messageId: string;
  topic?: string;
}

function fakeMebular(initial: Array<{ type: string; namespace?: string; content: unknown }> = []): {
  mebular: never;
  nodes: Array<{ type: string; namespace?: string; content: unknown }>;
} {
  const nodes = [...initial];
  const mebular = {
    graph: {
      async listNodes({ type }: { type: string }) {
        return nodes.filter((n) => n.type === type).map((n, i) => ({ id: `n${i}`, ...n }));
      },
      async createNode(type: string, content: Record<string, unknown>, _edges: unknown, opts: { namespace?: string }) {
        nodes.push({ type, namespace: opts.namespace, content });
        return { id: `new${nodes.length}` };
      },
    },
  };
  return { mebular: mebular as never, nodes };
}

const store = (mebular: never, namespace?: string): MebularMessageStore<Msg> =>
  new MebularMessageStore<Msg>(mebular, {
    type: 'negotiation_message',
    ...(namespace !== undefined ? { namespace } : {}),
    validate: (input) => ({ ok: typeof input === 'object' && input !== null && typeof (input as Msg).messageId === 'string' }),
    idOf: (m) => m.messageId,
  });

describe('MebularMessageStore', () => {
  it('all：按 namespace/形状过滤 + messageId 去重 + id 字典序', async () => {
    const { mebular } = fakeMebular([
      { type: 'negotiation_message', namespace: 'tasks', content: { messageId: 'b' } },
      { type: 'negotiation_message', namespace: 'tasks', content: { messageId: 'a' } },
      { type: 'negotiation_message', namespace: 'tasks', content: { messageId: 'a' } }, // 重复
      { type: 'negotiation_message', namespace: 'other', content: { messageId: 'c' } }, // 错分区
      { type: 'negotiation_message', namespace: 'tasks', content: 'nope' }, // 非对象
      { type: 'negotiation_message', namespace: 'tasks', content: { nope: 1 } }, // 形状非法
      { type: 'other_type', namespace: 'tasks', content: { messageId: 'd' } }, // 错类型
    ]);
    const s = store(mebular, 'tasks');
    expect((await s.all()).map((m) => m.messageId)).toEqual(['a', 'b']);
  });

  it('默认 namespace=tasks；append 幂等 + createNode 落图', async () => {
    const { mebular, nodes } = fakeMebular();
    const s = store(mebular);
    expect(await s.append({ messageId: 'x' })).toBe(true);
    expect(await s.append({ messageId: 'x' })).toBe(false); // 幂等
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.namespace).toBe('tasks');
    await s.close();
  });
});
