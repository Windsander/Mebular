// 认证握手

import { PeerId } from '../index.js';
import { EventEmitter } from 'events';

// 设备证书接口
export interface DeviceCertificate {
  deviceId: string;
  devicePublicKey: string;  // hex 编码
  createdAt: number;
  metadata?: Record<string, unknown>;
  signature: string;  // base64 编码的 Ed25519 签名
}

export interface AuthHandshakeOptions {
  timeout?: number;
  retryDelay?: number;
  maxRetries?: number;
}

export interface AuthRequest {
  peerId: PeerId;
  certificate: DeviceCertificate;
  timestamp: number;
}

export interface AuthResponse {
  accepted: boolean;
  certificate?: DeviceCertificate;
  error?: string;
}

export interface AuthSession {
  readonly peerId: PeerId;
  state: 'pending' | 'authenticated' | 'failed';
  certificate?: DeviceCertificate;
}

export class AuthenticationHandshake extends EventEmitter {
  private options: AuthHandshakeOptions;
  private running = false;
  private sessions: Map<string, AuthSession> = new Map();
  private pendingCertificates: Map<string, DeviceCertificate> = new Map();
  private userMasterPublicKey: Uint8Array | null = null;

  constructor(options: AuthHandshakeOptions = {}) {
    super();
    this.options = {
      timeout: 30000,
      retryDelay: 1000,
      maxRetries: 3,
      ...options,
    };
  }

  async start(): Promise<void> {
    if (this.running) {
      throw new Error('AuthenticationHandshake already running');
    }
    this.running = true;
  }

  async stop(): Promise<void> {
    if (!this.running) {
      throw new Error('AuthenticationHandshake not running');
    }
    this.running = false;

    for (const [_, session] of this.sessions) {
      session.state = 'failed';
    }
    this.sessions.clear();
    this.pendingCertificates.clear();
  }

  setUserMasterPublicKey(publicKey: Uint8Array): void {
    this.userMasterPublicKey = publicKey;
  }

  getUserMasterPublicKey(): Uint8Array | null {
    return this.userMasterPublicKey;
  }

  provideCertificate(peerId: PeerId, certificate: DeviceCertificate): void {
    this.pendingCertificates.set(peerId.id, certificate);
  }

  async initiateAuth(peerId: PeerId): Promise<AuthSession> {
    if (!this.running) {
      throw new Error('AuthenticationHandshake not running');
    }

    const existing = this.sessions.get(peerId.id);
    if (existing) {
      return existing;
    }

    const session: AuthSession = {
      peerId,
      state: 'pending',
    };

    this.sessions.set(peerId.id, session);

    try {
      await this.performHandshake(peerId, session);
    } catch (error) {
      session.state = 'failed';
      this.emit('auth-failed', peerId, error);
    }

    return session;
  }

  private async performHandshake(peerId: PeerId, session: AuthSession): Promise<void> {
    const cert = this.pendingCertificates.get(peerId.id);
    if (!cert) {
      throw new Error(`No certificate provided for peer ${peerId.id}`);
    }

    const isValid = await this.verifyCertificate(cert);
    if (!isValid) {
      throw new Error(`Certificate verification failed for peer ${peerId.id}`);
    }

    session.state = 'authenticated';
    session.certificate = cert;
  }

  async verifyCertificate(certificate: DeviceCertificate): Promise<boolean> {
    if (!this.running) {
      throw new Error('AuthenticationHandshake not running');
    }
    if (!this.userMasterPublicKey) {
      throw new Error('User master public key not set');
    }

    // 序列化证书数据（不包括签名）
    const certData = {
      deviceId: certificate.deviceId,
      devicePublicKey: certificate.devicePublicKey,
      createdAt: certificate.createdAt,
      metadata: certificate.metadata,
    };
    const dataStr = JSON.stringify(certData);
    const dataBuffer = new TextEncoder().encode(dataStr);

    // 将签名从 base64 转换为 Uint8Array
    const sigBytes = base64ToUint8Array(certificate.signature);

    // 导入用户主公钥为 CryptoKey (Ed25519 公钥，每 32 字节一个公钥)
    const publicKey = await crypto.subtle.importKey(
      'raw',
      this.userMasterPublicKey.buffer as ArrayBuffer,
      { name: 'Ed25519' },
      false,
      ['verify']
    );

    // 验证签名
    return crypto.subtle.verify(
      { name: 'Ed25519' },
      publicKey,
      sigBytes.buffer as BufferSource,
      dataBuffer
    );
  }

  getSession(peerId: PeerId): AuthSession | null {
    return this.sessions.get(peerId.id) || null;
  }

  getAllSessions(): AuthSession[] {
    return Array.from(this.sessions.values());
  }

  removeSession(peerId: PeerId): AuthSession | undefined {
    const deleted = this.sessions.get(peerId.id);
    this.sessions.delete(peerId.id);
    return deleted;
  }

  isRunning(): boolean {
    return this.running;
  }
}

// 辅助函数：将 base64 转换为 Uint8Array
function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
