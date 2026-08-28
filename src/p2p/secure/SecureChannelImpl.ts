// 加密通信信道
//
// 在已认证的连接上提供端到端加密。相对初版的三处安全修复：
//
// 1. 前向保密的真轮换：每个密钥世代（epoch）都使用全新的临时 X25519
//    密钥对协商，旧密钥随即销毁；轮换产生的是真正不同的密钥。
// 2. 重放保护：每个数据帧带 (epoch, counter)，接收方拒绝计数器不递增
//    的帧；帧头作为 AES-GCM 的 AAD，篡改帧头会导致解密失败。
// 3. 会话密钥不可导出：AES 密钥以 extractable=false 导入，
//    getSessionKey() 返回的是密钥指纹（SHA-256），用于双端核对，
//    而不是密钥本体。
//
// 线格式：
//   数据帧  [type=0:1][epoch:4 BE][counter:8 BE][iv:12][ciphertext+tag]
//   密钥帧  [type=1:1][epoch:4 BE][ephemeral X25519 public key:32][signature:64]?
//
// 身份绑定（防握手后 MITM）：配置 devicePrivateKey 后，密钥帧附本端对
// (epoch ‖ 临时公钥) 的 Ed25519 签名；配置 peerDevicePublicKey 后，未签名
// 或验签失败的密钥帧一律拒绝。两者均由 P2PNode 在认证完成后自动装配——
// 临时密钥由此绑定到握手已验证的设备身份。未配置时保持旧的无签名格式
//（匿名连接/测试路径）。

import { EventEmitter } from 'events';
import type { Connection } from '../P2PNetwork.js';
import { MessageQueue } from '../transport/InMemoryTransport.js';

export interface SecureChannelOptions {
  encryption?: 'TLS' | 'Noise';
  keyExchange?: 'X25519';
  sessionKeyRotation?: boolean;
  sessionKeyLifetime?: number;
  keyExchangeTimeout?: number;
  /** 本机设备私钥：提供后密钥交换帧附 Ed25519 签名（身份绑定） */
  devicePrivateKey?: CryptoKey;
  /** 对端设备公钥（握手已验证）：提供后强制验证密钥帧签名，否则拒绝 */
  peerDevicePublicKey?: Uint8Array;
}

/** 构造期解析后的配置：基础项齐全，身份绑定项可选 */
type ResolvedSecureChannelOptions = Required<
  Omit<SecureChannelOptions, 'devicePrivateKey' | 'peerDevicePublicKey'>
> &
  Pick<SecureChannelOptions, 'devicePrivateKey' | 'peerDevicePublicKey'>;

export interface SecureChannel {
  readonly connection: Connection;
  readonly isEncrypted: boolean;
  send(message: Uint8Array): Promise<void>;
  receive(): AsyncIterable<Uint8Array>;
  close(): Promise<void>;
  getSessionKey(): Uint8Array | null;
  rotateSessionKey(): Promise<void>;
}

const FRAME_DATA = 0;
const FRAME_KEY_EXCHANGE = 1;
const HEADER_LENGTH = 13; // type(1) + epoch(4) + counter(8)
const IV_LENGTH = 12;
const X25519_PUBLIC_KEY_LENGTH = 32;
const ED25519_SIGNATURE_LENGTH = 64;
/** 密钥帧长度：无签名 / 带 Ed25519 签名（身份绑定） */
const KEY_FRAME_UNSIGNED = 1 + 4 + X25519_PUBLIC_KEY_LENGTH;
const KEY_FRAME_SIGNED = KEY_FRAME_UNSIGNED + ED25519_SIGNATURE_LENGTH;

interface EpochState {
  key: CryptoKey;
  fingerprint: Uint8Array;
}

interface EphemeralKeyPair {
  privateKey: CryptoKey;
  publicKeyBytes: Uint8Array;
}

export class SecureChannelImpl extends EventEmitter implements SecureChannel {
  readonly connection: Connection;
  readonly isEncrypted: boolean = true;

  private options: ResolvedSecureChannelOptions;
  private running = false;

  /** 发送侧：当前世代与计数器 */
  private sendEpoch = 0;
  private sendCounter = 0n;
  private currentKey: EpochState | null = null;

  /** 接收侧：每个已建立世代的密钥与已见最大计数器 */
  private recvStates = new Map<number, EpochState>();
  private recvCounters = new Map<number, bigint>();

  /** 本端为每个世代生成的临时密钥对（存 Promise，防止并发重复生成） */
  private ephemeralByEpoch = new Map<number, Promise<EphemeralKeyPair>>();

  private plaintextQueue = new MessageQueue<Uint8Array>();
  private pumpStarted = false;
  private rotationTimer: ReturnType<typeof setInterval> | null = null;

  constructor(connection: Connection, options: SecureChannelOptions = {}) {
    super();
    this.connection = connection;
    this.options = {
      encryption: 'Noise',
      keyExchange: 'X25519',
      sessionKeyRotation: true,
      sessionKeyLifetime: 3600000,
      keyExchangeTimeout: 10000,
      ...options,
    };
  }

  /** 建立首个密钥世代并启动帧处理泵；双端的 start() 需并发调用 */
  async start(): Promise<SecureChannel> {
    if (this.running) {
      throw new Error('SecureChannel already running');
    }

    this.startPump();
    await this.negotiateEpoch(1);

    this.running = true;

    if (this.options.sessionKeyRotation && this.options.sessionKeyLifetime > 0) {
      this.rotationTimer = setInterval(() => {
        this.rotateSessionKey().catch((error) => this.emit('channel-error', error));
      }, this.options.sessionKeyLifetime);
      // 不让轮换计时器阻止进程退出 / 测试结束
      (this.rotationTimer as { unref?: () => void }).unref?.();
    }

    return this;
  }

  async stop(): Promise<void> {
    if (!this.running) {
      throw new Error('SecureChannel not running');
    }
    this.running = false;

    if (this.rotationTimer) {
      clearInterval(this.rotationTimer);
      this.rotationTimer = null;
    }

    this.plaintextQueue.close();
    this.currentKey = null;
    this.recvStates.clear();
    this.recvCounters.clear();
    this.ephemeralByEpoch.clear();

    await this.connection.close();
  }

  async close(): Promise<void> {
    if (this.running) {
      await this.stop();
    }
  }

  /**
   * 返回当前世代密钥的指纹（SHA-256），而非密钥本体。
   * 双端指纹一致即说明协商出了同一把密钥。
   */
  getSessionKey(): Uint8Array | null {
    return this.currentKey ? new Uint8Array(this.currentKey.fingerprint) : null;
  }

  getCurrentEpoch(): number {
    return this.sendEpoch;
  }

  isRunning(): boolean {
    return this.running;
  }

  // ---------- 数据收发 ----------

  async send(message: Uint8Array): Promise<void> {
    if (!this.running) {
      throw new Error('SecureChannel not running');
    }
    const state = this.currentKey;
    if (!state) {
      throw new Error('Session key not established');
    }

    const header = new Uint8Array(HEADER_LENGTH);
    const view = new DataView(header.buffer);
    view.setUint8(0, FRAME_DATA);
    view.setUint32(1, this.sendEpoch, false);
    view.setBigUint64(5, this.sendCounter, false);
    this.sendCounter += 1n;

    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: header },
      state.key,
      message.buffer as ArrayBuffer,
    );

    const frame = new Uint8Array(HEADER_LENGTH + IV_LENGTH + ciphertext.byteLength);
    frame.set(header, 0);
    frame.set(iv, HEADER_LENGTH);
    frame.set(new Uint8Array(ciphertext), HEADER_LENGTH + IV_LENGTH);

    await this.connection.send(frame);
  }

  receive(): AsyncIterable<Uint8Array> {
    if (!this.running && !this.pumpStarted) {
      throw new Error('SecureChannel not running');
    }
    return this.plaintextQueue.iterate();
  }

  // ---------- 密钥协商与轮换 ----------

  /** 发起一次密钥轮换：使用全新的临时密钥对，产生真正不同的密钥 */
  async rotateSessionKey(): Promise<void> {
    if (!this.running) {
      throw new Error('SecureChannel not running');
    }
    await this.negotiateEpoch(this.sendEpoch + 1);
  }

  /** 发送本端临时公钥并等待对端公钥，为新世代推导密钥 */
  private async negotiateEpoch(epoch: number): Promise<void> {
    const established = this.waitForEpoch(epoch);
    await this.sendKeyExchange(epoch);
    await established;
  }

  private waitForEpoch(epoch: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Key exchange for epoch ${epoch} timed out`));
      }, this.options.keyExchangeTimeout);
      (timer as { unref?: () => void }).unref?.();

      this.once(`epoch-${epoch}`, () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private async sendKeyExchange(epoch: number): Promise<void> {
    const ephemeral = await this.ensureEphemeral(epoch);

    let frame = new Uint8Array(KEY_FRAME_UNSIGNED);
    const view = new DataView(frame.buffer);
    view.setUint8(0, FRAME_KEY_EXCHANGE);
    view.setUint32(1, epoch, false);
    frame.set(ephemeral.publicKeyBytes, 5);

    // 身份绑定：签名 (epoch ‖ 临时公钥)，把临时密钥锚定到握手已验证的设备身份
    if (this.options.devicePrivateKey) {
      const signature = new Uint8Array(
        await crypto.subtle.sign(
          { name: 'Ed25519' },
          this.options.devicePrivateKey,
          keyExchangeSignPayload(epoch, ephemeral.publicKeyBytes),
        ),
      );
      const signed = new Uint8Array(KEY_FRAME_SIGNED);
      signed.set(frame, 0);
      signed.set(signature, KEY_FRAME_UNSIGNED);
      frame = signed;
    }

    await this.connection.send(frame);
  }

  /**
   * 取当前世代的临时密钥对；不存在则生成。
   * Promise 同步占位：generateKey 的 await 期间对端密钥帧到达时，
   * 不会触发第二次生成（否则双端持有的密钥对会错位）。
   */
  private ensureEphemeral(epoch: number): Promise<EphemeralKeyPair> {
    let entry = this.ephemeralByEpoch.get(epoch);
    if (!entry) {
      entry = generateEphemeralKeyPair();
      this.ephemeralByEpoch.set(epoch, entry);
    }
    return entry;
  }

  /** 收到对端临时公钥：先身份绑定校验，若本端尚未为该世代发公钥则补发，随后推导密钥 */
  private async handleKeyExchange(frame: Uint8Array): Promise<void> {
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const epoch = view.getUint32(1, false);
    const remotePublicKeyBytes = frame.slice(5, 5 + X25519_PUBLIC_KEY_LENGTH);

    // 身份绑定校验：配置了对端设备公钥时，未签名/验签失败的密钥帧一律拒绝
    if (this.options.peerDevicePublicKey) {
      if (frame.byteLength !== KEY_FRAME_SIGNED) {
        throw new Error('Key exchange frame missing identity signature');
      }
      const signature = frame.slice(KEY_FRAME_UNSIGNED, KEY_FRAME_SIGNED);
      const valid = await verifyKeyExchangeSignature(
        this.options.peerDevicePublicKey,
        epoch,
        remotePublicKeyBytes,
        signature,
      );
      if (!valid) {
        throw new Error('Key exchange signature verification failed (possible MITM)');
      }
    }

    if (epoch <= 0 || (this.currentKey && epoch <= this.sendEpoch && this.recvStates.has(epoch))) {
      return; // 重复或过时的密钥帧
    }
    if (!this.ephemeralByEpoch.has(epoch)) {
      await this.sendKeyExchange(epoch);
    }

    const ephemeral = await this.ensureEphemeral(epoch);
    const state = await deriveEpochState(ephemeral, remotePublicKeyBytes);

    this.recvStates.set(epoch, state);
    this.recvCounters.set(epoch, -1n);

    // 剪枝：只保留当前与上一个世代
    for (const known of this.recvStates.keys()) {
      if (known < epoch - 1) {
        this.recvStates.delete(known);
        this.recvCounters.delete(known);
        this.ephemeralByEpoch.delete(known);
      }
    }

    // 切换到新世代：发送侧从 0 重新计数
    if (epoch > this.sendEpoch || !this.currentKey) {
      this.sendEpoch = epoch;
      this.sendCounter = 0n;
      this.currentKey = state;
    }

    this.emit(`epoch-${epoch}`);
    this.emit('session-established', { epoch, keyLength: 256 });
  }

  // ---------- 帧处理泵 ----------

  /**
   * 独立读取连接上的所有帧：密钥帧就地处理，数据帧校验后解密入队。
   * 泵独立于 receive() 的消费进度，保证轮换随时可以进行。
   */
  private startPump(): void {
    if (this.pumpStarted) return;
    this.pumpStarted = true;

    void (async () => {
      try {
        for await (const frame of this.connection.receive()) {
          if (frame.length < 1) continue;
          const type = frame[0];
          if (type === FRAME_KEY_EXCHANGE) {
            await this.handleKeyExchange(frame);
          } else if (type === FRAME_DATA) {
            const plaintext = await this.decryptFrame(frame);
            this.plaintextQueue.push(plaintext);
          }
        }
        this.plaintextQueue.close();
      } catch (error) {
        this.plaintextQueue.fail(error instanceof Error ? error : new Error(String(error)));
      }
    })();
  }

  private async decryptFrame(frame: Uint8Array): Promise<Uint8Array> {
    if (frame.length < HEADER_LENGTH + IV_LENGTH + 16) {
      throw new Error('Encrypted frame too short');
    }

    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const epoch = view.getUint32(1, false);
    const counter = view.getBigUint64(5, false);

    const state = this.recvStates.get(epoch);
    if (!state) {
      throw new Error(`Frame for unknown key epoch ${epoch}`);
    }

    const lastCounter = this.recvCounters.get(epoch) ?? -1n;
    if (counter <= lastCounter) {
      throw new Error(
        `Possible replay attack: counter ${counter} not after ${lastCounter} in epoch ${epoch}`,
      );
    }

    const header = frame.slice(0, HEADER_LENGTH);
    const iv = frame.slice(HEADER_LENGTH, HEADER_LENGTH + IV_LENGTH);
    const ciphertext = frame.slice(HEADER_LENGTH + IV_LENGTH);

    let plaintext: ArrayBuffer;
    try {
      plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv, additionalData: header },
        state.key,
        ciphertext,
      );
    } catch {
      throw new Error('Frame decryption failed (tampered or wrong key)');
    }

    this.recvCounters.set(epoch, counter);
    return new Uint8Array(plaintext);
  }
}

// ---------- 密钥推导 ----------

/** 密钥交换签名载荷：epoch（4 字节 BE）‖ 临时公钥，把世代与密钥共同绑定 */
function keyExchangeSignPayload(epoch: number, publicKeyBytes: Uint8Array): ArrayBuffer {
  const payload = new Uint8Array(4 + publicKeyBytes.byteLength);
  new DataView(payload.buffer).setUint32(0, epoch, false);
  payload.set(publicKeyBytes, 4);
  return payload.buffer;
}

/** 用对端设备公钥验证密钥交换帧签名 */
async function verifyKeyExchangeSignature(
  peerDevicePublicKey: Uint8Array,
  epoch: number,
  remotePublicKeyBytes: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      peerDevicePublicKey.buffer as ArrayBuffer,
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    return await crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      signature.buffer as ArrayBuffer,
      keyExchangeSignPayload(epoch, remotePublicKeyBytes),
    );
  } catch {
    return false;
  }
}

async function generateEphemeralKeyPair(): Promise<EphemeralKeyPair> {
  const keyPair = (await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])) as CryptoKeyPair;
  const publicKeyBytes = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
  return { privateKey: keyPair.privateKey, publicKeyBytes };
}

/**
 * X25519 共享密钥 → AES-256-GCM（不可导出）+ 指纹（SHA-256）。
 * 原始密钥材料在导入与哈希后立即清零。
 */
async function deriveEpochState(
  ephemeral: EphemeralKeyPair,
  remotePublicKeyBytes: Uint8Array,
): Promise<EpochState> {
  const remotePublicKey = await crypto.subtle.importKey(
    'raw',
    remotePublicKeyBytes.buffer as ArrayBuffer,
    { name: 'X25519' },
    false,
    [],
  );

  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'X25519', public: remotePublicKey },
    ephemeral.privateKey,
    256,
  );
  const bits = new Uint8Array(sharedBits);

  try {
    const [key, fingerprint] = await Promise.all([
      crypto.subtle.importKey('raw', bits, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']),
      crypto.subtle.digest('SHA-256', bits),
    ]);
    return { key, fingerprint: new Uint8Array(fingerprint) };
  } finally {
    bits.fill(0);
  }
}
