// p2p 测试共享辅助：真实 Ed25519 密钥、真实证书签发

import {
  canonicalCertificateData,
  bytesToBase64,
  bytesToHex,
  type DeviceCertificate,
  type LocalIdentity,
} from '../../src/p2p/handshake/AuthenticationHandshake.js';
import type { PeerId } from '../../src/p2p/P2PNetwork.js';

export interface TestIdentity {
  identity: LocalIdentity;
  peerId: PeerId;
}

export async function generateMasterKeyPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
}

/** 生成设备身份；PeerId 派生规则与 P2PNode 一致（设备公钥的 SHA-256） */
export async function createTestIdentity(deviceId: string): Promise<TestIdentity> {
  const keyPair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const devicePublicKey = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', devicePublicKey));

  const peerId: PeerId = {
    multihash: digest,
    pubKey: devicePublicKey,
    id: bytesToHex(digest),
  };

  return {
    identity: { deviceId, devicePublicKey, devicePrivateKey: keyPair.privateKey },
    peerId,
  };
}

/** 用用户主私钥为设备身份签发证书 */
export async function issueCertificate(
  masterPrivateKey: CryptoKey,
  target: TestIdentity,
): Promise<DeviceCertificate> {
  const certificate: DeviceCertificate = {
    deviceId: target.identity.deviceId,
    devicePublicKey: bytesToHex(target.identity.devicePublicKey),
    createdAt: Date.now(),
    metadata: { peerId: target.peerId.id },
    signature: '',
  };
  const signature = await crypto.subtle.sign(
    { name: 'Ed25519' },
    masterPrivateKey,
    new TextEncoder().encode(canonicalCertificateData(certificate)),
  );
  certificate.signature = bytesToBase64(new Uint8Array(signature));
  target.identity.certificate = certificate;
  return certificate;
}

export async function masterPublicKeyBytes(master: CryptoKeyPair): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.exportKey('raw', master.publicKey));
}

/** 轮询等待条件成立 */
export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3000,
  intervalMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) {
      throw new Error('waitFor timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
