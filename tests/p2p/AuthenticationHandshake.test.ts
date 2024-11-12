// 认证握手单元测试：真实 Ed25519 密钥 + 内存连接对

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  AuthenticationHandshake,
  bytesToHex,
  type LocalIdentity,
} from '../../src/p2p/handshake/AuthenticationHandshake.js';
import { InMemoryHub } from '../../src/p2p/transport/InMemoryTransport.js';
import {
  createTestIdentity,
  generateMasterKeyPair,
  issueCertificate,
  masterPublicKeyBytes,
  type TestIdentity,
} from './helpers.js';

describe('AuthenticationHandshake', () => {
  let master: CryptoKeyPair;
  let masterPub: Uint8Array;
  let alice: TestIdentity;
  let bob: TestIdentity;
  let hub: InMemoryHub;
  let hsAlice: AuthenticationHandshake;
  let hsBob: AuthenticationHandshake;

  beforeEach(async () => {
    master = await generateMasterKeyPair();
    masterPub = await masterPublicKeyBytes(master);
    alice = await createTestIdentity('device-alice');
    bob = await createTestIdentity('device-bob');
    await issueCertificate(master.privateKey, alice);
    await issueCertificate(master.privateKey, bob);
    hub = new InMemoryHub();

    hsAlice = new AuthenticationHandshake({ timeout: 2000 });
    hsAlice.setIdentity(alice.identity);
    hsAlice.setUserMasterPublicKey(masterPub);
    await hsAlice.start();

    hsBob = new AuthenticationHandshake({ timeout: 2000 });
    hsBob.setIdentity(bob.identity);
    hsBob.setUserMasterPublicKey(masterPub);
    await hsBob.start();
  });

  afterEach(async () => {
    for (const hs of [hsAlice, hsBob]) {
      if (hs.isRunning()) await hs.stop();
    }
  });

  it('签发并验证设备证书', async () => {
    const certificate = alice.identity.certificate!;
    await expect(hsAlice.verifyCertificate(certificate.deviceId, certificate)).resolves.toBe(true);
  });

  it('拒绝 deviceId 不匹配、公钥篡改与错误主密钥的证书', async () => {
    const certificate = alice.identity.certificate!;

    await expect(hsAlice.verifyCertificate('device-other', certificate)).resolves.toBe(false);

    const tampered = { ...certificate, devicePublicKey: bytesToHex(bob.identity.devicePublicKey) };
    await expect(hsAlice.verifyCertificate(certificate.deviceId, tampered)).resolves.toBe(false);

    const otherMaster = await generateMasterKeyPair();
    const hsOther = new AuthenticationHandshake();
    hsOther.setUserMasterPublicKey(await masterPublicKeyBytes(otherMaster));
    await expect(hsOther.verifyCertificate(certificate.deviceId, certificate)).resolves.toBe(false);
  });

  it('未设置主公钥时验证抛出错误', async () => {
    const handshake = new AuthenticationHandshake();
    const certificate = alice.identity.certificate!;
    await expect(handshake.verifyCertificate(certificate.deviceId, certificate)).rejects.toThrow(
      'User master public key not set',
    );
  });

  it('完成双向挑战-应答握手，双端会话一致', async () => {
    const [connA, connB] = hub.createLinkedPair(alice.peerId, bob.peerId);

    const [sessionA, sessionB] = await Promise.all([
      hsAlice.initiateAuth(connA),
      hsBob.acceptAuth(connB),
    ]);

    expect(sessionA.state).toBe('authenticated');
    expect(sessionB.state).toBe('authenticated');
    expect(sessionA.certificate?.deviceId).toBe('device-bob');
    expect(sessionB.certificate?.deviceId).toBe('device-alice');
    expect(connA.isAuthenticated()).toBe(true);
    expect(connB.isAuthenticated()).toBe(true);
  });

  it('持有窃取证书但没有对应私钥的冒名者无法通过挑战-应答', async () => {
    // 攻击者截获了 alice 的证书与公钥，但只有自己的私钥
    const attacker = await createTestIdentity('device-attacker');
    const impostorIdentity: LocalIdentity = {
      deviceId: alice.identity.deviceId,
      devicePublicKey: alice.identity.devicePublicKey,
      devicePrivateKey: attacker.identity.devicePrivateKey,
      certificate: alice.identity.certificate,
    };
    const hsEvil = new AuthenticationHandshake({ timeout: 2000 });
    hsEvil.setIdentity(impostorIdentity);
    hsEvil.setUserMasterPublicKey(masterPub);
    await hsEvil.start();

    try {
      const [connEvil, connBob] = hub.createLinkedPair(alice.peerId, bob.peerId);
      await expect(
        Promise.all([hsEvil.initiateAuth(connEvil), hsBob.acceptAuth(connBob)]),
      ).rejects.toThrow();
    } finally {
      await hsEvil.stop();
    }
  });

  it('由其他用户主密钥签发的证书被拒绝', async () => {
    const otherMaster = await generateMasterKeyPair();
    const carol = await createTestIdentity('device-carol');
    await issueCertificate(otherMaster.privateKey, carol);

    const hsCarol = new AuthenticationHandshake({ timeout: 2000 });
    hsCarol.setIdentity(carol.identity);
    hsCarol.setUserMasterPublicKey(await masterPublicKeyBytes(otherMaster));
    await hsCarol.start();

    try {
      const [connCarol, connAlice] = hub.createLinkedPair(carol.peerId, alice.peerId);
      await expect(
        Promise.all([hsCarol.initiateAuth(connCarol), hsAlice.acceptAuth(connAlice)]),
      ).rejects.toThrow();
    } finally {
      await hsCarol.stop();
    }
  });

  it('对端无响应时握手超时', async () => {
    const [connA] = hub.createLinkedPair(alice.peerId, bob.peerId);
    await expect(hsAlice.initiateAuth(connA)).rejects.toThrow('timed out');
  });

  it('缺少本机证书时无法发起握手', async () => {
    const dave = await createTestIdentity('device-dave'); // 不签发证书
    const hsDave = new AuthenticationHandshake({ timeout: 1000 });
    hsDave.setIdentity(dave.identity);
    hsDave.setUserMasterPublicKey(masterPub);
    await hsDave.start();

    try {
      const [connDave] = hub.createLinkedPair(dave.peerId, bob.peerId);
      await expect(hsDave.initiateAuth(connDave)).rejects.toThrow('certificate');
    } finally {
      await hsDave.stop();
    }
  });
});
