// 加密通信信道

import { Connection, PeerId } from '../index.js';
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

export class SecureChannelImpl extends EventEmitter implements SecureChannel {
  readonly connection: Connection;
  readonly isEncrypted: boolean = true;
  private options: SecureChannelOptions;
  private running = false;
  private sessionKey: Uint8Array | null = null;
  private sessionKeyLifetime: number = 3600000;
  private sessionKeyRotation: boolean = true;

  constructor(connection: Connection, options: SecureChannelOptions = {}) {
    super();
    this.connection = connection;
    this.options = options;

    // irectly use user-provided values with defaults
    if (options.sessionKeyLifetime !== undefined) {
      this.sessionKeyLifetime = options.sessionKeyLifetime;
    }
    if (options.sessionKeyRotation !== undefined) {
      this.sessionKeyRotation = options.sessionKeyRotation;
    }
  }

  async start(): Promise<SecureChannel> {
    if (this.running) {
      throw new Error('SecureChannel already running');
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
    return this.sessionKey;
  }

  async rotateSessionKey(): Promise<void> {
    if (!this.running) {
      throw new Error('SecureChannel not running');
    }

    await this.negotiateSessionKey();
  }

  private async negotiateSessionKey(): Promise<void> {
    throw new Error('Not implemented');
  }

  private async encrypt(data: Uint8Array): Promise<Uint8Array> {
    throw new Error('Not implemented');
  }

  private async decrypt(data: Uint8Array): Promise<Uint8Array> {
    throw new Error('Not implemented');
  }
}
