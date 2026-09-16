// InMemoryHub 连接语义：关闭必须传播到对端（F4 的传输层根因）。
//
// 旧实现把关闭回调挂在自己身上且闭包操作自己，导致一方 close 后另一方
// 永远停在 connected——重连时会拿到/复用已死连接与陈旧会话。

import { describe, it, expect } from '@jest/globals';
import { InMemoryHub, type InMemoryConnection } from '../../src/p2p/transport/InMemoryTransport.js';
import type { PeerId } from '../../src/p2p/P2PNetwork.js';

function makePeerId(id: string): PeerId {
  const key = new Uint8Array(32).fill(id.length);
  return { multihash: key, pubKey: key, id };
}

describe('InMemoryHub 连接关闭传播（F4）', () => {
  it('A close → B 状态变 closed 且发送报错、接收流结束', async () => {
    const hub = new InMemoryHub();
    const [a, b] = hub.createLinkedPair(makePeerId('device-A'), makePeerId('device-B'));
    expect(a.state).toBe('connected');
    expect(b.state).toBe('connected');

    await a.close();
    expect(a.state).toBe('closed');
    expect(b.state).toBe('closed');
    await expect(b.send(new Uint8Array([1]))).rejects.toThrow('Connection closed');

    const iterator = b.receive()[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it('反向同样成立：B close → A 状态变 closed', async () => {
    const hub = new InMemoryHub();
    const [a, b] = hub.createLinkedPair(makePeerId('device-A'), makePeerId('device-B'));

    await b.close();
    expect(b.state).toBe('closed');
    expect(a.state).toBe('closed');
    await expect(a.send(new Uint8Array([1]))).rejects.toThrow('Connection closed');
  });

  it('dialFrom 建立的连接关闭后同样传播', async () => {
    const hub = new InMemoryHub();
    const a = makePeerId('device-A');
    const b = makePeerId('device-B');
    const boundA = hub.forPeer(a);
    const boundB = hub.forPeer(b);

    let incoming: InMemoryConnection | null = null;
    boundB.onIncomingConnection((conn) => {
      incoming = conn as InMemoryConnection;
    });

    const outgoing = await boundA.dial(b);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(incoming).not.toBeNull();

    await outgoing.close();
    expect(outgoing.state).toBe('closed');
    expect(incoming!.state).toBe('closed');
  });
});
