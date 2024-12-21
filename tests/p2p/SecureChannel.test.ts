// 加密信道单元测试：真实 X25519 + AES-GCM + 内存连接对

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { SecureChannelImpl } from '../../src/p2p/secure/SecureChannelImpl.js';
import { InMemoryHub, InMemoryConnection } from '../../src/p2p/transport/InMemoryTransport.js';
import { createTestIdentity, waitFor, type TestIdentity } from './helpers.js';

describe('SecureChannelImpl', () => {
  let hub: InMemoryHub;
  let alice: TestIdentity;
  let bob: TestIdentity;
  let connA: InMemoryConnection;
  let connB: InMemoryConnection;
  let chA: SecureChannelImpl;
  let chB: SecureChannelImpl;

  beforeEach(async () => {
    hub = new InMemoryHub();
    alice = await createTestIdentity('device-alice');
    bob = await createTestIdentity('device-bob');
    [connA, connB] = hub.createLinkedPair(alice.peerId, bob.peerId);

    chA = new SecureChannelImpl(connA, { sessionKeyRotation: false });
    chB = new SecureChannelImpl(connB, { sessionKeyRotation: false });
    await Promise.all([chA.start(), chB.start()]);
  });

  afterEach(async () => {
    await Promise.all([chA.close(), chB.close()]);
  });

  it('双端协商出相同密钥指纹（32 字节 SHA-256，而非密钥本体）', () => {
    const fpA = chA.getSessionKey();
    const fpB = chB.getSessionKey();
    expect(fpA).toBeInstanceOf(Uint8Array);
    expect(fpA!.length).toBe(32);
    expect(Buffer.from(fpA!).equals(Buffer.from(fpB!))).toBe(true);
  });

  it('加密收发往返一致', async () => {
    const message = new TextEncoder().encode('hello mebular');
    const iter = chB.receive()[Symbol.asyncIterator]();

    await chA.send(message);
    const received = await iter.next();
    expect(new Uint8Array(received.value)).toEqual(message);
  });

  it('多条消息保持顺序', async () => {
    const iter = chB.receive()[Symbol.asyncIterator]();

    for (let i = 0; i < 5; i++) {
      await chA.send(new Uint8Array([i]));
    }
    for (let i = 0; i < 5; i++) {
      const received = await iter.next();
      expect(Array.from(new Uint8Array(received.value))).toEqual([i]);
    }
  });

  it('双向同时收发互不干扰', async () => {
    const iterB = chB.receive()[Symbol.asyncIterator]();
    const iterA = chA.receive()[Symbol.asyncIterator]();

    await Promise.all([
      chA.send(new TextEncoder().encode('from A')),
      chB.send(new TextEncoder().encode('from B')),
    ]);

    expect(new TextDecoder().decode((await iterB.next()).value)).toBe('from A');
    expect(new TextDecoder().decode((await iterA.next()).value)).toBe('from B');
  });

  it('密钥轮换产生真正不同的密钥且通信不中断', async () => {
    const before = chA.getSessionKey()!;

    await chA.rotateSessionKey();

    const after = chA.getSessionKey()!;
    expect(chA.getCurrentEpoch()).toBe(2);
    expect(Buffer.from(before).equals(Buffer.from(after))).toBe(false);

    // 对端也随之进入新世代
    await waitFor(() => chB.getCurrentEpoch() === 2);
    expect(Buffer.from(chB.getSessionKey()!).equals(Buffer.from(after))).toBe(true);

    const iter = chB.receive()[Symbol.asyncIterator]();
    await chA.send(new Uint8Array([42]));
    expect(Array.from(new Uint8Array((await iter.next()).value))).toEqual([42]);
  });

  it('重放旧帧被拒绝', async () => {
    const sentFrames: Uint8Array[] = [];
    const originalSend = connA.send.bind(connA);
    connA.send = async (data: Uint8Array) => {
      sentFrames.push(new Uint8Array(data));
      return originalSend(data);
    };

    const iter = chB.receive()[Symbol.asyncIterator]();
    await chA.send(new Uint8Array([7, 7, 7]));
    await iter.next(); // 正常收到第一帧

    // 攻击者原样重放同一帧
    connB.deliver(sentFrames[sentFrames.length - 1]!);
    await expect(iter.next()).rejects.toThrow(/replay/i);
  });

  it('密文篡改导致解密失败', async () => {
    // 截获发送但不转发，只把篡改后的帧交给对端
    const sentFrames: Uint8Array[] = [];
    connA.send = async (data: Uint8Array) => {
      sentFrames.push(new Uint8Array(data));
    };

    const iter = chB.receive()[Symbol.asyncIterator]();
    await chA.send(new Uint8Array([1, 2, 3]));

    const forged = new Uint8Array(sentFrames[sentFrames.length - 1]!);
    forged[forged.length - 1] = forged[forged.length - 1]! ^ 0xff;
    connB.deliver(forged);

    await expect(iter.next()).rejects.toThrow(/decryption failed/i);
  });

  it('帧头篡改（计数器）因 AAD 校验而失败', async () => {
    const sentFrames: Uint8Array[] = [];
    connA.send = async (data: Uint8Array) => {
      sentFrames.push(new Uint8Array(data));
    };

    const iter = chB.receive()[Symbol.asyncIterator]();
    await chA.send(new Uint8Array([5]));

    // 把计数器改成未来的值：绕过重放检查，但 AAD 校验必须失败
    const forged = new Uint8Array(sentFrames[sentFrames.length - 1]!);
    forged[12] = forged[12]! + 1;
    connB.deliver(forged);

    await expect(iter.next()).rejects.toThrow(/decryption failed/i);
  });

  it('未启动时发送抛错', async () => {
    const [rawA] = hub.createLinkedPair(alice.peerId, bob.peerId);
    const cold = new SecureChannelImpl(rawA);
    await expect(cold.send(new Uint8Array([1]))).rejects.toThrow('not running');
  });
});
