// 加密模块 - 使用标准 Web Crypto API

export class EncryptionManager {
  constructor() {}

  async encrypt(plaintext: string, key: Uint8Array): Promise<{ ciphertext: ArrayBuffer; iv: Uint8Array }> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plaintext);
    const rawKey = new Uint8Array(key.buffer, key.byteOffset, key.byteLength);

    const cryptoKey = await crypto.subtle.importKey(
      'raw', rawKey,
      { name: 'AES-GCM' },
      false,
      ['encrypt']
    );

    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      cryptoKey,
      encoded
    );

    return { ciphertext, iv };
  }

  async decrypt(ciphertext: ArrayBuffer, iv: Uint8Array, key: Uint8Array): Promise<string> {
    const rawKey = new Uint8Array(key.buffer, key.byteOffset, key.byteLength);

    const cryptoKey = await crypto.subtle.importKey(
      'raw', rawKey,
      { name: 'AES-GCM' },
      false,
      ['decrypt']
    );

    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      cryptoKey,
      ciphertext
    );

    return new TextDecoder().decode(decrypted);
  }

  generateKey(): Promise<Uint8Array> {
    const key = crypto.getRandomValues(new Uint8Array(32));
    return Promise.resolve(key);
  }
}
