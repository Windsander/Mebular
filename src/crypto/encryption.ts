// 加密模块 - 使用标准 Web Crypto API

export class EncryptionManager {
  private algorithm = 'AES-GCM';
  private key?: CryptoKey;

  constructor() {}

  async generateKey(): Promise<CryptoKey> {
    this.key = await crypto.subtle.generateKey(
      { name: this.algorithm, length: 256 },
      true,
      ['encrypt', 'decrypt']
    );
    return this.key;
  }

  async encrypt(plaintext: string): Promise<{ ciphertext: ArrayBuffer; iv: Uint8Array }> {
    if (!this.key) {
      throw new Error('Key not initialized. Call generateKey() first.');
    }
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plaintext);
    const cipher = await crypto.subtle.encrypt(
      { name: this.algorithm, iv: iv as unknown as BufferSource },
      this.key,
      encoded.buffer as ArrayBuffer
    );
    return { ciphertext: cipher, iv };
  }

  async decrypt(ciphertext: ArrayBuffer, iv: Uint8Array): Promise<string> {
    if (!this.key) {
      throw new Error('Key not initialized. Call generateKey() first.');
    }
    const plainBuf = await crypto.subtle.decrypt(
      { name: this.algorithm, iv: iv as unknown as BufferSource },
      this.key,
      ciphertext
    );
    return new TextDecoder().decode(plainBuf);
  }

  async exportKey(): Promise<ArrayBuffer> {
    if (!this.key) {
      throw new Error('Key not initialized. Call generateKey() first.');
    }
    return crypto.subtle.exportKey('raw', this.key);
  }
}
