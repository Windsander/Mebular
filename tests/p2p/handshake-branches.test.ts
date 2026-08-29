// 握手分支补强（Phase 6.2）：生命周期守卫、证书签发、脚本化对端注入
// 覆盖失败分支（错误类型帧/坏证书/坏签名/断连/畸形报文）与纯函数边界。

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  AuthenticationHandshake,
  base64ToBytes,
  bytesToBase64,
  hexToBytes,
  verifyCertificateSignature,
} from '../../src/p2p/handshake/AuthenticationHandshake.js';
import type { Connection } from '../../src/p2p/P2PNetwork.js';
import { InMemoryHub } from '../../src/p2p/transport/InMemoryTransport.js';
import {
  createTestIdentity,
  generateMasterKeyPair,
  issueCertificate,
  masterPublicKeyBytes,
  type TestIdentity,
} from './helpers.js';

function encodeFrame(frame: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(frame));
}

async function readFrame(iter: AsyncIterator<Uint8Array>): Promise<Record<string, unknown>> {
  const { value } = await iter.next();
  return JSON.parse(new TextDecoder().decode(value)) as Record<string, unknown>;
}

describe('握手生命周期与守卫', () => {
  let master: CryptoKeyPair;
  let masterPub: Uint8Array;
  let alice: TestIdentity;
  let bob: TestIdentity;
  let hub: InMemoryHub;

  beforeEach(async () => {
    master = await generateMasterKeyPair();
    masterPub = await masterPublicKeyBytes(master);
    alice = await createTestIdentity('device-alice');
    bob = await createTestIdentity('device-bob');
    await issueCertificate(master.privateKey, alice);
    await issueCertificate(master.privateKey, bob);
    hub = new InMemoryHub();
  });

  let hs: AuthenticationHandshake;
  afterEach(async () => {
    if (hs?.isRunning()) await hs.stop();
  });

  function newHandshake(timeout = 500): AuthenticationHandshake {
    hs = new AuthenticationHandshake({ timeout });
    return hs;
  }

  it('重复启动/未启动停止/未启动发起均诚实报错', async () => {
    hs = newHandshake();
    await expect(hs.stop()).rejects.toThrow('not running');
    const [connA] = hub.createLinkedPair(alice.peerId, bob.peerId);
    await expect(hs.initiateAuth(connA)).rejects.toThrow('not running');
    await hs.start();
    await expect(hs.start()).rejects.toThrow('already running');
  });

  it('停止时挂起会话被标记失败并清理', async () => {
    hs = newHandshake(100);
    hs.setIdentity(alice.identity);
    hs.setUserMasterPublicKey(masterPub);
    await hs.start();
    const [connA] = hub.createLinkedPair(alice.peerId, bob.peerId);
    const pending = hs.initiateAuth(connA);
    pending.catch(() => undefined); // 防未处理拒绝
    await hs.stop();
    await expect(pending).rejects.toThrow();
    expect(hs.getSession(bob.peerId)).toBeNull();
    expect(hs.getAllSessions()).toHaveLength(0);
  });

  it('访问器：getIdentity / getUserMasterPublicKey / 会话查询与移除', async () => {
    hs = newHandshake();
    hs.setIdentity(alice.identity);
    hs.setUserMasterPublicKey(masterPub);
    expect(hs.getIdentity()?.deviceId).toBe('device-alice');
    expect(hs.getUserMasterPublicKey()).toBe(masterPub);
    expect(hs.getSession(alice.peerId)).toBeNull();
    expect(hs.removeSession(alice.peerId)).toBeUndefined();
  });

  it('initiateAuth 守卫：缺身份 / 缺主公钥', async () => {
    hs = newHandshake();
    await hs.start();
    const [connA] = hub.createLinkedPair(alice.peerId, bob.peerId);
    await expect(hs.initiateAuth(connA)).rejects.toThrow('Local identity not set');

    hs.setIdentity(alice.identity);
    await expect(hs.initiateAuth(connA)).rejects.toThrow('User master public key not set');
  });

  it('acceptAuth 守卫：缺主公钥 / 缺本机证书', async () => {
    hs = newHandshake();
    hs.setIdentity(alice.identity);
    await hs.start();
    const [connA, connB] = hub.createLinkedPair(alice.peerId, bob.peerId);
    await expect(hs.acceptAuth(connB)).rejects.toThrow('User master public key not set');

    const dave = await createTestIdentity('device-dave'); // 无证书
    const hs2 = new AuthenticationHandshake({ timeout: 500 });
    hs2.setIdentity(dave.identity);
    hs2.setUserMasterPublicKey(masterPub);
    await hs2.start();
    try {
      await expect(hs2.acceptAuth(connA)).rejects.toThrow('Local certificate missing');
    } finally {
      await hs2.stop();
    }
  });

  it('createCertificate：缺身份/缺主私钥报错；签发成功且幂等复用', async () => {
    hs = newHandshake();
    const dave = await createTestIdentity('device-dave');
    await expect(hs.createCertificate(dave.peerId)).rejects.toThrow('Local identity not set');

    hs.setIdentity(dave.identity);
    await expect(hs.createCertificate(dave.peerId)).rejects.toThrow('User master private key not set');

    hs.setUserMasterPrivateKey(master.privateKey);
    const cert = await hs.createCertificate(dave.peerId);
    expect(cert.deviceId).toBe('device-dave');
    expect(await verifyCertificateSignature(cert, masterPub)).toBe(true);
    // 已持有证书时幂等返回同一对象
    expect(await hs.createCertificate(dave.peerId)).toBe(cert);
  });

  it('verifyCertificateSignature 纯函数边界：空签名/坏签名返回 false', async () => {
    const cert = alice.identity.certificate!;
    expect(await verifyCertificateSignature({ ...cert, signature: '' }, masterPub)).toBe(false);
    expect(await verifyCertificateSignature({ ...cert, signature: '!!!!' }, masterPub)).toBe(false);
  });

  it('hexToBytes 奇数长度诚实报错', () => {
    expect(() => hexToBytes('abc')).toThrow('Invalid hex string');
  });

  it('已认证会话重复发起直接复用', async () => {
    hs = newHandshake();
    hs.setIdentity(alice.identity);
    hs.setUserMasterPublicKey(masterPub);
    await hs.start();
    const hsBob = new AuthenticationHandshake({ timeout: 500 });
    hsBob.setIdentity(bob.identity);
    hsBob.setUserMasterPublicKey(masterPub);
    await hsBob.start();
    try {
      const [connA, connB] = hub.createLinkedPair(alice.peerId, bob.peerId);
      const [sessionA] = await Promise.all([hs.initiateAuth(connA), hsBob.acceptAuth(connB)]);
      const again = await hs.initiateAuth(connA);
      expect(again).toBe(sessionA);

      // 会话查询与移除
      expect(hs.getAllSessions().length).toBeGreaterThan(0);
      expect(hs.removeSession(bob.peerId)?.state).toBe('authenticated');
      expect(hs.getSession(bob.peerId)).toBeNull();
    } finally {
      await hsBob.stop();
    }
  });
});

describe('握手失败分支（脚本化对端注入）', () => {
  let master: CryptoKeyPair;
  let masterPub: Uint8Array;
  let alice: TestIdentity;
  let bob: TestIdentity;
  let hub: InMemoryHub;
  let hsAlice: AuthenticationHandshake;

  beforeEach(async () => {
    master = await generateMasterKeyPair();
    masterPub = await masterPublicKeyBytes(master);
    alice = await createTestIdentity('device-alice');
    bob = await createTestIdentity('device-bob');
    await issueCertificate(master.privateKey, alice);
    await issueCertificate(master.privateKey, bob);
    hub = new InMemoryHub();

    hsAlice = new AuthenticationHandshake({ timeout: 300 });
    hsAlice.setIdentity(alice.identity);
    hsAlice.setUserMasterPublicKey(masterPub);
    await hsAlice.start();
  });

  afterEach(async () => {
    if (hsAlice.isRunning()) await hsAlice.stop();
  });

  it('发起方收到非 auth-reply 帧', async () => {
    const [connA, connB] = hub.createLinkedPair(alice.peerId, bob.peerId);
    const peerIter = connB.receive()[Symbol.asyncIterator]();
    const p = hsAlice.initiateAuth(connA);
    await readFrame(peerIter); // hello
    await connB.send(encodeFrame({ type: 'auth-ok' }));
    await expect(p).rejects.toThrow('Unexpected message during handshake');
  });

  it('发起方收到错误主密钥签发的证书', async () => {
    const otherMaster = await generateMasterKeyPair();
    const carol = await createTestIdentity('device-carol');
    await issueCertificate(otherMaster.privateKey, carol);

    const [connA, connB] = hub.createLinkedPair(alice.peerId, carol.peerId);
    const peerIter = connB.receive()[Symbol.asyncIterator]();
    const p = hsAlice.initiateAuth(connA);
    await readFrame(peerIter);
    await connB.send(encodeFrame({
      type: 'auth-reply',
      certificate: carol.identity.certificate,
      nonce: bytesToBase64(new Uint8Array(32)),
      response: bytesToBase64(new Uint8Array(64)),
    }));
    await expect(p).rejects.toThrow('Peer certificate verification failed');
  });

  it('发起方收到无效的 nonceA 挑战签名', async () => {
    const [connA, connB] = hub.createLinkedPair(alice.peerId, bob.peerId);
    const peerIter = connB.receive()[Symbol.asyncIterator]();
    const p = hsAlice.initiateAuth(connA);
    await readFrame(peerIter);
    await connB.send(encodeFrame({
      type: 'auth-reply',
      certificate: bob.identity.certificate,
      nonce: bytesToBase64(new Uint8Array(32)),
      response: bytesToBase64(new Uint8Array(64)), // 全零签名
    }));
    await expect(p).rejects.toThrow('challenge-response');
  });

  it('发起方收到对端 auth-error 与异常 ack', async () => {
    // auth-error 作为 reply
    const [connA, connB] = hub.createLinkedPair(alice.peerId, bob.peerId);
    const peerIter = connB.receive()[Symbol.asyncIterator]();
    const p1 = hsAlice.initiateAuth(connA);
    await readFrame(peerIter);
    await connB.send(encodeFrame({ type: 'auth-error', error: 'no entry' }));
    await expect(p1).rejects.toThrow('Peer rejected authentication');

    // 合法 reply + 异常 ack（wrong type）
    const [connA2, connB2] = hub.createLinkedPair(alice.peerId, bob.peerId);
    const peerIter2 = connB2.receive()[Symbol.asyncIterator]();
    const p2 = hsAlice.initiateAuth(connA2);
    const hello = await readFrame(peerIter2);
    const nonceA = new Uint8Array(base64ToBytes(hello.nonce as string));
    const sig = await crypto.subtle.sign({ name: 'Ed25519' }, bob.identity.devicePrivateKey, nonceA);
    await connB2.send(encodeFrame({
      type: 'auth-reply',
      certificate: bob.identity.certificate,
      nonce: bytesToBase64(crypto.getRandomValues(new Uint8Array(32))),
      response: bytesToBase64(new Uint8Array(sig)),
    }));
    await readFrame(peerIter2); // auth-final
    await connB2.send(encodeFrame({ type: 'auth-hello' }));
    await expect(p2).rejects.toThrow('Unexpected message during handshake');
  });

  it('响应方收到非 auth-hello 首帧 / auth-error 终帧 / 非 auth-final 终帧', async () => {
    const hsBob = new AuthenticationHandshake({ timeout: 300 });
    hsBob.setIdentity(bob.identity);
    hsBob.setUserMasterPublicKey(masterPub);
    await hsBob.start();
    try {
      // 首帧 wrong type
      const [c1a, c1b] = hub.createLinkedPair(alice.peerId, bob.peerId);
      const p1 = hsBob.acceptAuth(c1b);
      await c1a.send(encodeFrame({ type: 'auth-ok' }));
      await expect(p1).rejects.toThrow('Unexpected message during handshake');

      // 合法 hello + auth-error 终帧
      const [c2a, c2b] = hub.createLinkedPair(alice.peerId, bob.peerId);
      const iter2 = c2a.receive()[Symbol.asyncIterator]();
      const p2 = hsBob.acceptAuth(c2b);
      await c2a.send(encodeFrame({
        type: 'auth-hello',
        certificate: alice.identity.certificate,
        nonce: bytesToBase64(crypto.getRandomValues(new Uint8Array(32))),
      }));
      await readFrame(iter2); // reply
      await c2a.send(encodeFrame({ type: 'auth-error', error: 'give up' }));
      await expect(p2).rejects.toThrow('Peer reported authentication error');

      // 合法 hello + wrong type 终帧
      const [c3a, c3b] = hub.createLinkedPair(alice.peerId, bob.peerId);
      const iter3 = c3a.receive()[Symbol.asyncIterator]();
      const p3 = hsBob.acceptAuth(c3b);
      await c3a.send(encodeFrame({
        type: 'auth-hello',
        certificate: alice.identity.certificate,
        nonce: bytesToBase64(crypto.getRandomValues(new Uint8Array(32))),
      }));
      await readFrame(iter3);
      await c3a.send(encodeFrame({ type: 'auth-hello' }));
      await expect(p3).rejects.toThrow('Unexpected message during handshake');
    } finally {
      await hsBob.stop();
    }
  });

  it('握手中连接断开 / 畸形 JSON / 缺 type 字段', async () => {
    // 断开
    const [connA, connB] = hub.createLinkedPair(alice.peerId, bob.peerId);
    const p1 = hsAlice.initiateAuth(connA);
    await connB.close();
    await expect(p1).rejects.toThrow(/Connection closed|timed out/);

    // 畸形 JSON
    const [connA2, connB2] = hub.createLinkedPair(alice.peerId, bob.peerId);
    const iter2 = connB2.receive()[Symbol.asyncIterator]();
    const p2 = hsAlice.initiateAuth(connA2);
    await readFrame(iter2);
    await connB2.send(new TextEncoder().encode('not-json{'));
    await expect(p2).rejects.toThrow('Malformed handshake message');

    // 缺 type 字段
    const [connA3, connB3] = hub.createLinkedPair(alice.peerId, bob.peerId);
    const iter3 = connB3.receive()[Symbol.asyncIterator]();
    const p3 = hsAlice.initiateAuth(connA3);
    await readFrame(iter3);
    await connB3.send(encodeFrame({ foo: 1 }));
    await expect(p3).rejects.toThrow('Malformed handshake message');
  });
});
