// 签名模块 - 使用 Web Crypto API 实现 Ed25519 签名

import type { Signature } from '../types/common.js';

export class SignatureManager {
  private keyPair: { publicKey: CryptoKey; privateKey: CryptoKey } | null = null;

  constructor() {}

  async generateKeyPair(): Promise<{ publicKey: CryptoKey; privateKey: CryptoKey }> {
    const keyPair = await crypto.subtle.generateKey(
      {
        name: 'Ed25519',
        namedCurve: 'Ed25519',
      },
      true,
      ['sign', 'verify']
    );

    this.keyPair = keyPair;
    return keyPair;
  }

  async sign(data: string): Promise<string> {
    if (!this.keyPair) {
      await this.generateKeyPair();
    }

    if (!this.keyPair) {
      throw new Error('密钥对未生成');
    }

    const dataBuffer = new TextEncoder().encode(data);
    const signature = await crypto.subtle.sign(
      { name: 'Ed25519' },
      this.keyPair.privateKey,
      dataBuffer
    );

    return arrayBufferToBase64(signature);
  }

  async verify(data: string, signature: string): Promise<boolean> {
    if (!this.keyPair) {
      throw new Error('密钥对未生成');
    }

    const dataBuffer = new TextEncoder().encode(data);
    const sigBuffer = base64ToArrayBuffer(signature);

    return crypto.subtle.verify(
      { name: 'Ed25519' },
      this.keyPair.publicKey,
      sigBuffer,
      dataBuffer
    );
  }

  setKeyPair(publicKey: CryptoKey, privateKey: CryptoKey): void {
    this.keyPair = { publicKey, privateKey };
  }

  getPublicKey(): CryptoKey | null {
    return this.keyPair ? this.keyPair.publicKey : null;
  }

  getPrivateKey(): CryptoKey | null {
    return this.keyPair ? this.keyPair.privateKey : null;
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
