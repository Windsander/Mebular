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

// 身份绑定（防握手后 MITM）：密钥交换帧附设备签名，验签失败一律拒绝
describe('SecureChannelImpl 身份绑定', () => {
  let hub: InMemoryHub;
  let alice: TestIdentity;
  let bob: TestIdentity;

  beforeEach(async () => {
    hub = new InMemoryHub();
    alice = await createTestIdentity('device-alice');
    bob = await createTestIdentity('device-bob');
  });

  function boundChannels(): {
    connA: InMemoryConnection;
    connB: InMemoryConnection;
    chA: SecureChannelImpl;
    chB: SecureChannelImpl;
  } {
    const [connA, connB] = hub.createLinkedPair(alice.peerId, bob.peerId);
    const chA = new SecureChannelImpl(connA, {
      sessionKeyRotation: false,
      devicePrivateKey: alice.identity.devicePrivateKey,
      peerDevicePublicKey: bob.identity.devicePublicKey,
    });
    const chB = new SecureChannelImpl(connB, {
      sessionKeyRotation: false,
      devicePrivateKey: bob.identity.devicePrivateKey,
      peerDevicePublicKey: alice.identity.devicePublicKey,
    });
    return { connA, connB, chA, chB };
  }

  /** 手工构造一帧密钥交换消息（可指定签名密钥与是否带签名） */
  async function forgeKeyFrame(
    epoch: number,
    x25519Public: Uint8Array,
    signingKey: CryptoKey | null,
  ): Promise<Uint8Array> {
    const base = new Uint8Array(5 + 32);
    new DataView(base.buffer).setUint8(0, 1);
    new DataView(base.buffer).setUint32(1, epoch, false);
    base.set(x25519Public, 5);
    if (!signingKey) {
      return base;
    }
    const payload = new Uint8Array(4 + 32);
    new DataView(payload.buffer).setUint32(0, epoch, false);
    payload.set(x25519Public, 4);
    const sig = new Uint8Array(
      await crypto.subtle.sign({ name: 'Ed25519' }, signingKey, payload),
    );
    const frame = new Uint8Array(base.length + sig.length);
    frame.set(base, 0);
    frame.set(sig, base.length);
    return frame;
  }

  it('带签名的密钥交换正常协商，收发与轮换不受影响', async () => {
    const { chA, chB } = boundChannels();
    await Promise.all([chA.start(), chB.start()]);
    try {
      // 指纹一致
      expect(Buffer.from(chA.getSessionKey()!).equals(Buffer.from(chB.getSessionKey()!))).toBe(true);

      const iter = chB.receive()[Symbol.asyncIterator]();
      await chA.send(new TextEncoder().encode('bound channel'));
      expect(new TextDecoder().decode((await iter.next()).value)).toBe('bound channel');

      // 轮换同样走签名帧
      await chA.rotateSessionKey();
      await waitFor(() => chB.getCurrentEpoch() === 2);
      expect(Buffer.from(chA.getSessionKey()!).equals(Buffer.from(chB.getSessionKey()!))).toBe(true);
    } finally {
      await Promise.all([chA.close(), chB.close()]);
    }
  });

  it('攻击者私钥签名的密钥帧被拒绝（验签失败）', async () => {
    const eve = await createTestIdentity('device-eve');
    const { connB, chA, chB } = boundChannels();
    await Promise.all([chA.start(), chB.start()]);
    try {
      const iter = chB.receive()[Symbol.asyncIterator]();

      // eve 伪造 epoch 2 密钥帧：自己的 X25519 公钥 + 自己的 Ed25519 签名
      const forgedX = (await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])) as CryptoKeyPair;
      const forgedPub = new Uint8Array(await crypto.subtle.exportKey('raw', forgedX.publicKey));
      connB.deliver(await forgeKeyFrame(2, forgedPub, eve.identity.devicePrivateKey));

      await expect(iter.next()).rejects.toThrow(/signature/i);
    } finally {
      await Promise.all([chA.close(), chB.close()]);
    }
  });

  it('要求验签时，未签名的密钥帧被拒绝', async () => {
    const { connB, chA, chB } = boundChannels();
    await Promise.all([chA.start(), chB.start()]);
    try {
      const iter = chB.receive()[Symbol.asyncIterator]();

      // 无签名的 epoch 2 密钥帧（旧格式）
      const x = (await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])) as CryptoKeyPair;
      const pub = new Uint8Array(await crypto.subtle.exportKey('raw', x.publicKey));
      connB.deliver(await forgeKeyFrame(2, pub, null));

      await expect(iter.next()).rejects.toThrow(/signature/i);
    } finally {
      await Promise.all([chA.close(), chB.close()]);
    }
  });
});
