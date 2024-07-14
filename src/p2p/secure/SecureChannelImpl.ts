// 加密通信信道

import { Connection } from '../index.js';
import { EventEmitter } from 'events';

export interface SecureChannelOptions {
  encryption?: 'TLS' | 'Noise';
  keyExchange?: 'X25519';
  sessionKeyRotation?: boolean;
  sessionKeyLifetime?: number;
}

export interface SecureChannel {
  readonly connection: Connection;
  readonly isEncrypted: boolean;
  send(message: Uint8Array): Promise<void>;
  receive(): AsyncIterable<Uint8Array>;
  close(): Promise<void>;
  getSessionKey(): Uint8Array | null;
  rotateSessionKey(): Promise<void>;
}

export interface SecureChannelKeyConfig {
  localPrivateKey: CryptoKey;
  remotePublicKey: Uint8Array;
}

function bufferSourceFromUint8Array(data: Uint8Array): ArrayBuffer {
  return data.buffer as ArrayBuffer;
}

export class SecureChannelImpl extends EventEmitter implements SecureChannel {
  readonly connection: Connection;
  readonly isEncrypted: boolean = true;
  private options: Required<SecureChannelOptions>;
  private running = false;
  private sessionKey: CryptoKey | null = null;
  private sessionKeyBytes: Uint8Array | null = null;
  private localPrivateKey: CryptoKey | null = null;
  private remotePublicKey: Uint8Array | null = null;
  private remotePublicKeyCrypto: CryptoKey | null = null;

  constructor(connection: Connection, options: SecureChannelOptions = {}) {
    super();
    this.connection = connection;
    this.options = {
      encryption: 'Noise',
      keyExchange: 'X25519',
      sessionKeyRotation: true,
      sessionKeyLifetime: 3600000,
      ...options,
    };
  }

  setKeyConfig(config: SecureChannelKeyConfig): void {
    this.localPrivateKey = config.localPrivateKey;
    this.remotePublicKey = config.remotePublicKey;
    this.emit('key-configured');
  }

  async start(): Promise<SecureChannel> {
    if (this.running) {
      throw new Error('SecureChannel already running');
    }

    if (!this.localPrivateKey || !this.remotePublicKey) {
      throw new Error('Key configuration not set. Call setKeyConfig() first.');
    }

    // 確保遠程公钥已匯入為 CryptoKey
    if (!this.remotePublicKeyCrypto) {
      this.remotePublicKeyCrypto = await crypto.subtle.importKey(
        'raw',
        bufferSourceFromUint8Array(this.remotePublicKey),
        { name: 'X25519' },
        false,
        ['deriveKey']
      );
    }

    await this.negotiateSessionKey();

    this.running = true;
    return this;
  }

  async stop(): Promise<void> {
    if (!this.running) {
      throw new Error('SecureChannel not running');
    }

    this.sessionKey = null;
    this.sessionKeyBytes = null;
    this.running = false;

    await this.connection.close();
  }

  async send(message: Uint8Array): Promise<void> {
    if (!this.running) {
      throw new Error('SecureChannel not running');
    }

    const encrypted = await this.encrypt(message);
    await this.connection.send(encrypted);
  }

  async *receive(): AsyncIterable<Uint8Array> {
    if (!this.running) {
      throw new Error('SecureChannel not running');
    }

    for await (const encrypted of this.connection.receive()) {
      const decrypted = await this.decrypt(encrypted);
      yield decrypted;
    }
  }

  async close(): Promise<void> {
    await this.stop();
  }

  getSessionKey(): Uint8Array | null {
    return this.sessionKeyBytes;
  }

  async rotateSessionKey(): Promise<void> {
    if (!this.running) {
      throw new Error('SecureChannel not running');
    }

    await this.negotiateSessionKey();
  }

  private async negotiateSessionKey(): Promise<void> {
    if (!this.localPrivateKey || !this.remotePublicKeyCrypto) {
      throw new Error('Key configuration not set');
    }

    // 使用 X25519 推導共享密钥
    const sharedSecret = await crypto.subtle.deriveKey(
      {
        name: 'X25519',
        public: this.remotePublicKeyCrypto,
      },
      this.localPrivateKey,
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );

    this.sessionKey = sharedSecret;

    // 匯出密钥字節以便同步訪問
    const exported = await crypto.subtle.exportKey('raw', sharedSecret);
    this.sessionKeyBytes = new Uint8Array(exported);

    this.emit('session-established', {
      keyLength: this.sessionKeyBytes.length * 8,
    });
  }

  private async encrypt(data: Uint8Array): Promise<Uint8Array> {
    if (!this.sessionKey) {
      throw new Error('Session key not established');
    }

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      this.sessionKey,
      bufferSourceFromUint8Array(data)
    );

    // 組合 IV + 密文以便傳輸
    const result = new Uint8Array(iv.length + ciphertext.byteLength);
    result.set(iv, 0);
    result.set(new Uint8Array(ciphertext), iv.length);
    return result;
  }

  private async decrypt(data: Uint8Array): Promise<Uint8Array> {
    if (!this.sessionKey) {
      throw new Error('Session key not established');
    }

    if (data.length < 12) {
      throw new Error('Encrypted message too short');
    }

    // 從消息開頭提取 IV
    const iv = data.slice(0, 12);
    const ciphertext = data.slice(12);

    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      this.sessionKey,
      bufferSourceFromUint8Array(ciphertext)
    );

    return new Uint8Array(plaintext);
  }
}
