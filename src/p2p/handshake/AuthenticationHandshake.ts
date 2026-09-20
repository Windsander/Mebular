// 认证握手
//
// 实现 spec-002 的「设备间认证握手」，并在其 Step 2-4 的证书交换之上
// 加入挑战-应答（challenge-response）：
//
//   发起方                                   响应方
//     | ---- auth-hello {cert, nonceA} ----> |
//     |                                      | 用用户主公钥验证证书
//     | <-- auth-reply {cert, nonceB, sigA}  | sigA = sign(nonceA, 响应方设备私钥)
//     | 验证响应方证书 + sigA                  |
//     | ---- auth-final {sigB} ------------> | sigB = sign(nonceB, 发起方设备私钥)
//     |                                      | 验证 sigB
//     | <--------- auth-ok ----------------- | 双方收敛到一致的认证完成状态
//
// 证书签名证明「设备属于该用户」，nonce 签名证明「对端此刻持有设备私钥」，
// 两者缺一不可——仅有前者无法抵抗证书重放冒名。

import { EventEmitter } from 'events';
import type { Connection, PeerId } from '../P2PNetwork.js';
import type { MutableAuthenticationConnection } from '../transport/InMemoryTransport.js';
import { ErrorCodes, NetworkError } from '../../errors.js';

// 设备证书接口
//
// `issuer` 缺省 = 由**用户主密钥**直签（旧格式，逐字节兼容）；
// `issuer` 存在 = **委派证书**，由 `issuer` 指定的**设备私钥**签署（信任模型 v2 / T2）。
export interface DelegationIssuer {
  deviceId: string;
  /** 签发者设备公钥（hex，32 字节 Ed25519 raw） */
  publicKey: string;
}

export interface DeviceCertificate {
  deviceId: string;
  devicePublicKey: string;  // hex 编码
  createdAt: number;
  metadata?: Record<string, unknown>;
  signature: string;  // base64 编码的 Ed25519 签名（用户主密钥，或 issuer 设备私钥）
  /** 委派签发者；缺省 = 用户主密钥直签 */
  issuer?: DelegationIssuer;
}

/** 证书链**委派跳数**上界（master→…→leaf 的中间签发次数）。超长链一律拒绝。 */
export const MAX_CERT_CHAIN_HOPS = 4;

/** 本机身份：设备私钥用于签名挑战，证书用于向对端证明归属 */
export interface LocalIdentity {
  deviceId: string;
  devicePublicKey: Uint8Array; // 原始 32 字节
  devicePrivateKey: CryptoKey; // Ed25519 私钥（sign）
  certificate?: DeviceCertificate;
  /** 叶→根的证书链（T2）；缺省时按 `[certificate]` 处理（旧主密钥直签） */
  certificateChain?: DeviceCertificate[];
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
  /** 对端证书链（叶→根；T2） */
  certificateChain?: DeviceCertificate[];
}

type AuthWireMessage =
  | { type: 'auth-hello'; certificate: DeviceCertificate; chain?: DeviceCertificate[]; nonce: string }
  | { type: 'auth-reply'; certificate: DeviceCertificate; chain?: DeviceCertificate[]; nonce: string; response: string }
  | { type: 'auth-final'; response: string }
  | { type: 'auth-ok' }
  | { type: 'auth-error'; error: string };

export class AuthenticationHandshake extends EventEmitter {
  private options: Required<AuthHandshakeOptions>;
  private running = false;
  private sessions: Map<string, AuthSession> = new Map();
  private userMasterPublicKey: Uint8Array | null = null;
  private userMasterPrivateKey: CryptoKey | null = null;
  private identity: LocalIdentity | null = null;
  /** 吊销级联判定（T2）：链中任一设备被 `device_revoke` → 拒绝；缺省不判（握手层只做密码学）。 */
  private revocationCheck: ((deviceId: string) => boolean) | null = null;

  constructor(options: AuthHandshakeOptions = {}) {
    super();
    this.options = {
      timeout: 30000,
      retryDelay: 1000,
      maxRetries: 3,
      ...options,
    };
  }

  /** 注入吊销级联判定（T2）：由策略/同步层提供 `device_revoke` 集合。 */
  setRevocationCheck(check: ((deviceId: string) => boolean) | null): void {
    this.revocationCheck = check;
  }

  async start(): Promise<void> {
    if (this.running) {
      throw new NetworkError('AuthenticationHandshake already running', ErrorCodes.NETWORK_ALREADY_RUNNING);
    }
    this.running = true;
  }

  async stop(): Promise<void> {
    if (!this.running) {
      throw new NetworkError('AuthenticationHandshake not running', ErrorCodes.NETWORK_NOT_RUNNING);
    }
    this.running = false;

    for (const [, session] of this.sessions) {
      if (session.state === 'pending') {
        session.state = 'failed';
      }
    }
    this.sessions.clear();
  }

  // ---------- 身份与密钥配置 ----------

  setIdentity(identity: LocalIdentity): void {
    this.identity = identity;
  }

  getIdentity(): LocalIdentity | null {
    return this.identity;
  }

  setUserMasterPublicKey(publicKey: Uint8Array): void {
    this.userMasterPublicKey = publicKey;
  }

  getUserMasterPublicKey(): Uint8Array | null {
    return this.userMasterPublicKey;
  }

  /** 仅用户主设备持有：用于为新设备签发证书 */
  setUserMasterPrivateKey(privateKey: CryptoKey): void {
    this.userMasterPrivateKey = privateKey;
  }

  // ---------- 证书签发与验证（纯密码学操作，不要求 start） ----------

  /**
   * 为本机身份签发设备证书。
   * 已持有证书时直接返回；否则需要用户主私钥现场签署。
   */
  async createCertificate(peerId: PeerId): Promise<DeviceCertificate> {
    if (!this.identity) {
      throw new NetworkError('Local identity not set. Call setIdentity() first.', ErrorCodes.NETWORK_HANDSHAKE_FAILED);
    }
    if (this.identity.certificate && this.identity.certificate.deviceId === this.identity.deviceId) {
      return this.identity.certificate;
    }
    if (!this.userMasterPrivateKey) {
      throw new NetworkError('User master private key not set. Certificate issuance requires the master device.', ErrorCodes.NETWORK_HANDSHAKE_FAILED);
    }

    const certificate: DeviceCertificate = {
      deviceId: this.identity.deviceId,
      devicePublicKey: bytesToHex(this.identity.devicePublicKey),
      createdAt: Date.now(),
      metadata: { peerId: peerId.id },
      signature: '',
    };
    certificate.signature = await this.signWithMasterKey(canonicalCertificateData(certificate));
    this.identity.certificate = certificate;
    return certificate;
  }

  /**
   * 验证设备证书：deviceId 必须一致，且签名须由用户主密钥签署。
   * 只证明归属，不证明对端持有私钥——后者由挑战-应答完成。
   */
  async verifyCertificate(
    deviceId: string,
    certificate: DeviceCertificate,
    chain?: readonly DeviceCertificate[],
  ): Promise<boolean> {
    if (!this.userMasterPublicKey) {
      throw new NetworkError('User master public key not set', ErrorCodes.NETWORK_HANDSHAKE_FAILED);
    }
    if (!certificate || certificate.deviceId !== deviceId) {
      return false;
    }
    // T2：带链（委派）走链式校验；否则维持旧「主密钥直签」单层校验（逐字节语义不变）。
    if (chain !== undefined && chain.length > 1) {
      return verifyCertificateChain(chain, this.userMasterPublicKey, {
        subjectDeviceId: deviceId,
        ...(this.revocationCheck ? { isRevoked: this.revocationCheck } : {}),
      });
    }
    if (certificate.issuer !== undefined) {
      return false; // 委派证书必须携带链
    }
    return verifyCertificateSignature(certificate, this.userMasterPublicKey);
  }

  // ---------- 线上握手协议 ----------

  /** 发起方：在已建立的连接上执行三步握手 */
  async initiateAuth(connection: Connection): Promise<AuthSession> {
    this.assertRunning();
    const identity = this.requireIdentity();
    if (!this.userMasterPublicKey) {
      throw new NetworkError('User master public key not set', ErrorCodes.NETWORK_HANDSHAKE_FAILED);
    }
    if (!identity.certificate) {
      throw new NetworkError('Local certificate missing. Call createCertificate() first.', ErrorCodes.NETWORK_HANDSHAKE_FAILED);
    }

    const existing = this.sessions.get(connection.peerId.id);
    // 仅当复用的是同一条「活着且已认证」的连接时才跳过握手；
    // 旧会话残留 + 新连接对象必须重走握手，否则对端会一直等 auth-hello（F4）
    if (
      existing &&
      existing.state === 'authenticated' &&
      connection.isAuthenticated() &&
      connection.state !== 'closed' &&
      connection.state !== 'disconnecting'
    ) {
      return existing;
    }

    const session: AuthSession = { peerId: connection.peerId, state: 'pending' };
    this.sessions.set(connection.peerId.id, session);

    try {
      const iter = connection.receive()[Symbol.asyncIterator]();
      const localCert = identity.certificate;

      // Step 1：发送本机证书与挑战 nonceA
      const nonceA = crypto.getRandomValues(new Uint8Array(32));
      await this.sendWireMessage(connection, {
        type: 'auth-hello',
        certificate: localCert,
        chain: identity.certificateChain ?? [localCert],
        nonce: bytesToBase64(nonceA),
      });

      // Step 2：等待响应方证书、挑战 nonceB 与 nonceA 的签名
      const reply = await this.readWireMessage(iter, this.options.timeout);
      if (reply.type === 'auth-error') {
        throw new NetworkError(`Peer rejected authentication: ${reply.error}`, ErrorCodes.NETWORK_AUTH_FAILED);
      }
      if (reply.type !== 'auth-reply') {
        throw new NetworkError(`Unexpected message during handshake: ${reply.type}`, ErrorCodes.NETWORK_HANDSHAKE_FAILED);
      }

      // 验证响应方证书（归属）与 nonceA 签名（私钥持有）
      const certValid = await this.verifyCertificate(reply.certificate.deviceId, reply.certificate, reply.chain);
      if (!certValid) {
        throw new NetworkError('Peer certificate verification failed', ErrorCodes.NETWORK_AUTH_FAILED);
      }
      const responseValid = await this.verifyDeviceSignature(
        reply.certificate,
        nonceA,
        base64ToBytes(reply.response),
      );
      if (!responseValid) {
        throw new NetworkError('Peer failed challenge-response (nonceA signature invalid)', ErrorCodes.NETWORK_AUTH_FAILED);
      }

      // Step 3：回应对方的挑战 nonceB
      const nonceB = base64ToBytes(reply.nonce);
      const finalSig = await crypto.subtle.sign(
        { name: 'Ed25519' },
        identity.devicePrivateKey,
        asArrayBuffer(nonceB),
      );
      await this.sendWireMessage(connection, { type: 'auth-final', response: bytesToBase64(new Uint8Array(finalSig)) });

      // Step 4：等待响应方确认——冒名者会在此收到 auth-error
      const ack = await this.readWireMessage(iter, this.options.timeout);
      if (ack.type === 'auth-error') {
        throw new NetworkError(`Peer rejected authentication: ${ack.error}`, ErrorCodes.NETWORK_AUTH_FAILED);
      }
      if (ack.type !== 'auth-ok') {
        throw new NetworkError(`Unexpected message during handshake: ${ack.type}`, ErrorCodes.NETWORK_HANDSHAKE_FAILED);
      }

      session.state = 'authenticated';
      session.certificate = reply.certificate;
      session.certificateChain = reply.chain ?? [reply.certificate];
      this.markAuthenticated(connection);
      this.emit('authenticated', session);
      return session;
    } catch (error) {
      session.state = 'failed';
      await this.trySendError(connection, error);
      this.emit('auth-failed', connection.peerId, error);
      throw error;
    }
  }

  /** 响应方：处理对端发起的三步握手 */
  async acceptAuth(connection: Connection): Promise<AuthSession> {
    this.assertRunning();
    const identity = this.requireIdentity();
    if (!this.userMasterPublicKey) {
      throw new NetworkError('User master public key not set', ErrorCodes.NETWORK_HANDSHAKE_FAILED);
    }
    if (!identity.certificate) {
      throw new NetworkError('Local certificate missing. Call createCertificate() first.', ErrorCodes.NETWORK_HANDSHAKE_FAILED);
    }

    const session: AuthSession = { peerId: connection.peerId, state: 'pending' };
    this.sessions.set(connection.peerId.id, session);

    try {
      const iter = connection.receive()[Symbol.asyncIterator]();

      // 等待 hello：对端证书 + nonceA
      const hello = await this.readWireMessage(iter, this.options.timeout);
      if (hello.type !== 'auth-hello') {
        throw new NetworkError(`Unexpected message during handshake: ${hello.type}`, ErrorCodes.NETWORK_HANDSHAKE_FAILED);
      }

      const certValid = await this.verifyCertificate(hello.certificate.deviceId, hello.certificate, hello.chain);
      if (!certValid) {
        throw new NetworkError('Peer certificate verification failed', ErrorCodes.NETWORK_AUTH_FAILED);
      }

      // 回应：本机证书 + 新挑战 nonceB + nonceA 的签名
      const nonceA = base64ToBytes(hello.nonce);
      const responseToA = await crypto.subtle.sign(
        { name: 'Ed25519' },
        identity.devicePrivateKey,
        asArrayBuffer(nonceA),
      );
      const nonceB = crypto.getRandomValues(new Uint8Array(32));
      await this.sendWireMessage(connection, {
        type: 'auth-reply',
        certificate: identity.certificate,
        chain: identity.certificateChain ?? [identity.certificate],
        nonce: bytesToBase64(nonceB),
        response: bytesToBase64(new Uint8Array(responseToA)),
      });

      // 等待 final：nonceB 的签名
      const finalMsg = await this.readWireMessage(iter, this.options.timeout);
      if (finalMsg.type === 'auth-error') {
        throw new NetworkError(`Peer reported authentication error: ${finalMsg.error}`, ErrorCodes.NETWORK_AUTH_FAILED);
      }
      if (finalMsg.type !== 'auth-final') {
        throw new NetworkError(`Unexpected message during handshake: ${finalMsg.type}`, ErrorCodes.NETWORK_HANDSHAKE_FAILED);
      }

      const finalValid = await this.verifyDeviceSignature(
        hello.certificate,
        nonceB,
        base64ToBytes(finalMsg.response),
      );
      if (!finalValid) {
        throw new NetworkError('Peer failed challenge-response (nonceB signature invalid)', ErrorCodes.NETWORK_AUTH_FAILED);
      }

      // 确认认证完成，让发起方收敛到一致状态
      await this.sendWireMessage(connection, { type: 'auth-ok' });

      session.state = 'authenticated';
      session.certificate = hello.certificate;
      session.certificateChain = hello.chain ?? [hello.certificate];
      this.markAuthenticated(connection);
      this.emit('authenticated', session);
      return session;
    } catch (error) {
      session.state = 'failed';
      await this.trySendError(connection, error);
      this.emit('auth-failed', connection.peerId, error);
      throw error;
    }
  }

  // ---------- 会话查询 ----------

  getSession(peerId: PeerId): AuthSession | null {
    return this.sessions.get(peerId.id) || null;
  }

  getAllSessions(): AuthSession[] {
    return Array.from(this.sessions.values());
  }

  removeSession(peerId: PeerId): AuthSession | undefined {
    const session = this.sessions.get(peerId.id);
    this.sessions.delete(peerId.id);
    return session;
  }

  isRunning(): boolean {
    return this.running;
  }

  // ---------- 内部实现 ----------

  private assertRunning(): void {
    if (!this.running) {
      throw new NetworkError('AuthenticationHandshake not running', ErrorCodes.NETWORK_NOT_RUNNING);
    }
  }

  private requireIdentity(): LocalIdentity {
    if (!this.identity) {
      throw new NetworkError('Local identity not set. Call setIdentity() first.', ErrorCodes.NETWORK_HANDSHAKE_FAILED);
    }
    return this.identity;
  }

  private markAuthenticated(connection: Connection): void {
    const mutable = connection as Partial<MutableAuthenticationConnection>;
    if (typeof mutable.markAuthenticated === 'function') {
      mutable.markAuthenticated();
    }
  }

  /** 用证书中的设备公钥验证一次挑战签名 */
  private async verifyDeviceSignature(
    certificate: DeviceCertificate,
    nonce: Uint8Array,
    signature: Uint8Array,
  ): Promise<boolean> {
    try {
      const devicePublicKey = await importEd25519PublicKey(hexToBytes(certificate.devicePublicKey));
      return await crypto.subtle.verify(
        { name: 'Ed25519' },
        devicePublicKey,
        asArrayBuffer(signature),
        asArrayBuffer(nonce),
      );
    } catch {
      return false;
    }
  }

  private async signWithMasterKey(data: string): Promise<string> {
    if (!this.userMasterPrivateKey) {
      throw new NetworkError('User master private key not set', ErrorCodes.NETWORK_HANDSHAKE_FAILED);
    }
    const signature = await crypto.subtle.sign(
      { name: 'Ed25519' },
      this.userMasterPrivateKey,
      new TextEncoder().encode(data),
    );
    return bytesToBase64(new Uint8Array(signature));
  }

  private async sendWireMessage(connection: Connection, message: AuthWireMessage): Promise<void> {
    await connection.send(new TextEncoder().encode(JSON.stringify(message)));
  }

  private async readWireMessage(
    iter: AsyncIterator<Uint8Array>,
    timeoutMs: number,
  ): Promise<AuthWireMessage> {
    const next = await withTimeout(
      iter.next().then((result) => {
        if (result.done) {
          throw new NetworkError('Connection closed during handshake', ErrorCodes.NETWORK_CONNECTION_CLOSED);
        }
        return result.value;
      }),
      timeoutMs,
      'Authentication handshake timed out',
    );

    let parsed: AuthWireMessage;
    try {
      parsed = JSON.parse(new TextDecoder().decode(next)) as AuthWireMessage;
    } catch {
      throw new NetworkError('Malformed handshake message', ErrorCodes.NETWORK_HANDSHAKE_FAILED);
    }
    if (!parsed || typeof parsed.type !== 'string') {
      throw new NetworkError('Malformed handshake message', ErrorCodes.NETWORK_HANDSHAKE_FAILED);
    }
    return parsed;
  }

  private async trySendError(connection: Connection, error: unknown): Promise<void> {
    try {
      const message = error instanceof Error ? error.message : String(error);
      await this.sendWireMessage(connection, { type: 'auth-error', error: message });
    } catch {
      // 对端可能已断开，忽略
    }
  }
}

// ---------- 辅助函数 ----------

/** 证书的规范化签名内容：固定键序，metadata 缺省为 {} */
export function canonicalCertificateData(certificate: DeviceCertificate): string {
  const payload: Record<string, unknown> = {
    deviceId: certificate.deviceId,
    devicePublicKey: certificate.devicePublicKey,
    createdAt: certificate.createdAt,
    metadata: certificate.metadata ?? {},
  };
  // 委派证书把签发者绑定进签名内容；旧主密钥直签证书无此字段 → 字节与旧格式**完全一致**。
  if (certificate.issuer !== undefined) {
    payload.issuer = { deviceId: certificate.issuer.deviceId, publicKey: certificate.issuer.publicKey };
  }
  return JSON.stringify(payload);
}

/**
 * 纯密码学证书验签：签名须由给定用户主公钥对应的主密钥签署。
 * 不含 deviceId 一致性检查（由调用方按场景校验）；
 * 供握手实例方法与同步层的证书链验签共用（Phase 5.1，D9 收口）。
 */
export async function verifyCertificateSignature(
  certificate: DeviceCertificate,
  userMasterPublicKey: Uint8Array,
): Promise<boolean> {
  if (!certificate.signature || !certificate.devicePublicKey) {
    return false;
  }
  try {
    const publicKey = await importEd25519PublicKey(userMasterPublicKey);
    return await crypto.subtle.verify(
      { name: 'Ed25519' },
      publicKey,
      asArrayBuffer(base64ToBytes(certificate.signature)),
      new TextEncoder().encode(canonicalCertificateData(certificate)),
    );
  } catch {
    return false;
  }
}

/**
 * 验证**设备证书链**（叶→根有序数组）：
 * - `chain[0].deviceId` 必须等于 `subjectDeviceId`（若提供）；
 * - 对 `i`：`chain[i].issuer` 必须存在，且其 `deviceId`/`publicKey` 与 `chain[i+1]`
 *   的 `deviceId`/`devicePublicKey` **完全一致**，并用 `chain[i+1].devicePublicKey` 验 `chain[i]` 签名；
 * - 末元素（根）必须**无 `issuer`**，并用 `userMasterPublicKey` 验签；
 * - 委派跳数 = `chain.length - 1`，**超过 `MAX_CERT_CHAIN_HOPS` 拒绝**；
 * - `opts.isRevoked(deviceId)` 为真时拒绝（**吊销级联**，与策略层 R-b 同源；握手层本身不做吊销判定）。
 *
 * 单元素链（`issuer` 缺省）= 旧“主密钥直签”证书，等价于 `verifyCertificateSignature`。
 */
export async function verifyCertificateChain(
  chain: readonly DeviceCertificate[],
  userMasterPublicKey: Uint8Array,
  opts: { subjectDeviceId?: string; isRevoked?: (deviceId: string) => boolean } = {},
): Promise<boolean> {
  if (!Array.isArray(chain) || chain.length === 0) return false;
  if (chain.length - 1 > MAX_CERT_CHAIN_HOPS) return false;
  const leaf = chain[0]!;
  if (opts.subjectDeviceId !== undefined && leaf.deviceId !== opts.subjectDeviceId) return false;
  if (chain.length === 1) {
    if (leaf.issuer !== undefined) return false; // 单元素必须是主密钥直签
    if (opts.isRevoked?.(leaf.deviceId)) return false;
    return verifyCertificateSignature(leaf, userMasterPublicKey);
  }
  for (let i = 0; i < chain.length; i += 1) {
    const cert = chain[i]!;
    if (opts.isRevoked?.(cert.deviceId)) return false;
    if (i === chain.length - 1) {
      if (cert.issuer !== undefined) return false; // 根不得再委派
      if (!(await verifyCertificateSignature(cert, userMasterPublicKey))) return false;
      continue;
    }
    const parent = chain[i + 1]!;
    const issuer = cert.issuer;
    if (!issuer || issuer.deviceId !== parent.deviceId || issuer.publicKey !== parent.devicePublicKey) return false;
    if (!cert.signature || !parent.devicePublicKey) return false;
    try {
      const key = await importEd25519PublicKey(hexToBytes(parent.devicePublicKey));
      const ok = await crypto.subtle.verify(
        { name: 'Ed25519' },
        key,
        asArrayBuffer(base64ToBytes(cert.signature)),
        new TextEncoder().encode(canonicalCertificateData(cert)),
      );
      if (!ok) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** 用**设备私钥**签署委派证书：填充 `issuer` 后签 `canonicalCertificateData`，返回不可变副本。 */
export async function signDelegatedCertificate(
  certificate: Omit<DeviceCertificate, 'signature' | 'issuer'>,
  issuer: { deviceId: string; devicePrivateKey: CryptoKey; devicePublicKey: string },
): Promise<DeviceCertificate> {
  const withIssuer: DeviceCertificate = {
    ...certificate,
    issuer: { deviceId: issuer.deviceId, publicKey: issuer.devicePublicKey },
    signature: '',
  };
  const signature = await crypto.subtle.sign(
    { name: 'Ed25519' },
    issuer.devicePrivateKey,
    new TextEncoder().encode(canonicalCertificateData(withIssuer)),
  );
  withIssuer.signature = bytesToBase64(new Uint8Array(signature));
  return withIssuer;
}

async function importEd25519PublicKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', asArrayBuffer(raw), { name: 'Ed25519' }, false, ['verify']);
}

/** 取 Uint8Array 精确对应的 ArrayBuffer（满足 BufferSource 对 ArrayBuffer 的要求） */
function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    hex += bytes[i]!.toString(16).padStart(2, '0');
  }
  return hex;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new NetworkError('Invalid hex string', ErrorCodes.NETWORK_HANDSHAKE_FAILED);
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
