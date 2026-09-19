// 事件日志类
//
// Phase 3 升级（对应 phase-3-plan 3.1）：
// - 事件 ID 内容寻址：sha256(规范化事件内容)，同内容同 ID，
//   重复接收/重放天然幂等；
// - 事件由创建设备的 Ed25519 私钥签名，接收方验签后才可应用；
// - missingEvents 按向量时钟计算对端缺失的增量集合。

import { EventEmitter } from 'events';
import type { Event, EventFilter } from '../types/event.js';
import { VectorClock } from '../sync/vectorclock/index.js';
import type { StorageAdapter } from '../storage/StorageAdapter.js';
import { bytesToHex, hexToBytes, bytesToBase64, base64ToBytes } from '../p2p/handshake/AuthenticationHandshake.js';

export type { Event, EventFilter, EventType } from '../types/event.js';

/** 事件签名者：本机设备身份；携带证书时事件附带信任链字段 */
export interface EventSigner {
  deviceId: string;
  privateKey: CryptoKey; // Ed25519 私钥（sign）
  /** 本机设备证书（用户主密钥签发，或委派证书的叶）；提供则写入事件的 authorCertificate */
  certificate?: import('../p2p/handshake/AuthenticationHandshake.js').DeviceCertificate;
  /** 叶→根证书链（T2）；提供则写入 authorCertificateChain（缺省按 [certificate]） */
  certificateChain?: import('../p2p/handshake/AuthenticationHandshake.js').DeviceCertificate[];
}

export interface EventLogOptions {
  signer?: EventSigner;
  initialClock?: Record<string, number>;
}

export class EventLog extends EventEmitter {
  private storage: StorageAdapter;
  private clock: VectorClock;
  private deviceId: string;
  private signer: EventSigner | null;

  constructor(storage: StorageAdapter, deviceId: string, options: EventLogOptions = {}) {
    super();
    this.storage = storage;
    this.deviceId = deviceId;

    this.signer = options.signer ?? null;
    this.clock = new VectorClock(options.initialClock);
  }

  /** 从存储中的既有事件重建向量时钟（重启恢复路径，保证计数器单调不回退） */
  static async restore(
    storage: StorageAdapter,
    deviceId: string,
    options?: EventLogOptions,
  ): Promise<EventLog> {
    const log = new EventLog(storage, deviceId, options);
    const events = await storage.listEvents();
    for (const event of events) {
      log.clock.merge(VectorClock.fromJSON(event.vectorClock ?? {}));
    }
    return log;
  }

  /** 追加本地事件：自增时钟、内容寻址 ID、（配置签名者后）签名 */
  async append(event: Omit<Event, 'id' | 'timestamp' | 'vectorClock' | 'author' | 'signature'>): Promise<Event> {
    const timestamp = Date.now();
    this.clock.increment(this.deviceId);

    const unsigned: Omit<Event, 'id' | 'signature'> = {
      ...event,
      timestamp,
      vectorClock: this.clock.toJSON(),
      author: this.deviceId,
    };

    const fullEvent: Event = {
      ...unsigned,
      id: await computeEventId(unsigned),
      signature: this.signer ? await signEvent(unsigned, this.signer.privateKey) : '',
      // 证书链字段不参与内容寻址与签名（canonicalEventData 字段集固定）
      ...(this.signer?.certificate ? { authorCertificate: this.signer.certificate } : {}),
      ...(this.signer?.certificateChain && this.signer.certificateChain.length > 1
        ? { authorCertificateChain: this.signer.certificateChain }
        : {}),
    };

    await this.storage.putEvent(fullEvent);
    // 本地写入即广播（push-on-write 的信号源）：仅本地 append 触发，
    // appendRemote 不触发，避免收到远端事件后回弹造成风暴。
    this.emit('event-appended', fullEvent);
    return fullEvent;
  }

  /**
   * 追加远端事件（同步应用路径）：
   * 不签名、不改写内容；同 ID 去重；合并向量时钟。
   * 验签由调用方（SyncManager）在调用前完成。
   */
  async appendRemote(event: Event): Promise<'applied' | 'duplicate'> {
    const existing = await this.storage.getEvent(event.id);
    if (existing) {
      this.clock.merge(VectorClock.fromJSON(event.vectorClock ?? {}));
      return 'duplicate';
    }
    await this.storage.putEvent(event);
    this.clock.merge(VectorClock.fromJSON(event.vectorClock ?? {}));
    return 'applied';
  }

  /** 计算对端缺失的事件：按作者维度的时钟高水位比较，按因果序返回 */
  async missingEvents(remoteClock: Record<string, number>): Promise<Event[]> {
    const all = await this.storage.listEvents();
    const missing = all.filter((event) => {
      const authorCount = event.vectorClock?.[event.author] ?? 0;
      const remoteHas = remoteClock[event.author] ?? 0;
      return authorCount > remoteHas;
    });

    // 因果序：作者计数器为主键，时间戳与 ID 兜底，保证确定性
    return missing.sort((a, b) => {
      const counterDiff = (a.vectorClock?.[a.author] ?? 0) - (b.vectorClock?.[b.author] ?? 0);
      if (counterDiff !== 0) return counterDiff;
      if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }

  /** 验证事件签名与内容寻址 ID（静态方法，收发双方都可用） */
  static async verifyEvent(event: Event, devicePublicKey: Uint8Array): Promise<boolean> {
    if (!event.signature) {
      return false;
    }
    const unsigned: Omit<Event, 'id' | 'signature'> = {
      type: event.type,
      data: event.data,
      timestamp: event.timestamp,
      vectorClock: event.vectorClock,
      author: event.author,
      // namespace 参与内容寻址（新事件）；旧事件无此字段时保持原字节
      ...(event.namespace !== undefined ? { namespace: event.namespace } : {}),
    };
    try {
      // ID 必须与内容绑定，防止内容被改而沿用原 ID
      const expectedId = await computeEventId(unsigned);
      if (expectedId !== event.id) {
        return false;
      }
      const key = await crypto.subtle.importKey(
        'raw',
        devicePublicKey.buffer as ArrayBuffer,
        { name: 'Ed25519' },
        false,
        ['verify'],
      );
      return await crypto.subtle.verify(
        { name: 'Ed25519' },
        key,
        base64ToBytes(event.signature).buffer as ArrayBuffer,
        new TextEncoder().encode(canonicalEventData(unsigned)),
      );
    } catch {
      return false;
    }
  }

  async getEvent(id: string): Promise<Event | null> {
    return this.storage.getEvent(id);
  }

  async listEvents(filter?: EventFilter): Promise<Event[]> {
    return this.storage.listEvents(filter);
  }

  getClock(): VectorClock {
    return this.clock;
  }

  getDeviceId(): string {
    return this.deviceId;
  }

  hasSigner(): boolean {
    return this.signer !== null;
  }
}

// ---------- 规范化与签名 ----------

/** 规范化序列化：递归按键名排序，保证同内容得到同字节序列 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((item) => canonicalize(item)).join(',') + ']';
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const parts = keys.map((key) => JSON.stringify(key) + ':' + canonicalize(record[key]));
  return '{' + parts.join(',') + '}';
}

/** 事件的规范化签名/哈希内容：固定字段集合，排除 id 与 signature */
export function canonicalEventData(event: Omit<Event, 'id' | 'signature'>): string {
  const payload: Record<string, unknown> = {
    type: event.type,
    data: event.data ?? {},
    timestamp: event.timestamp,
    vectorClock: event.vectorClock ?? {},
    author: event.author,
  };
  // namespace 参与内容寻址与签名（新事件）；旧事件无此字段时字节完全不变，
  // 保证旧事件 ID/签名的向后兼容。
  if (event.namespace !== undefined) {
    payload.namespace = event.namespace;
  }
  return canonicalize(payload);
}

/** 内容寻址事件 ID：sha256(规范化内容) 的 hex */
export async function computeEventId(event: Omit<Event, 'id' | 'signature'>): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalEventData(event)),
  );
  return 'sha256:' + bytesToHex(new Uint8Array(digest));
}

async function signEvent(event: Omit<Event, 'id' | 'signature'>, privateKey: CryptoKey): Promise<string> {
  const signature = await crypto.subtle.sign(
    { name: 'Ed25519' },
    privateKey,
    new TextEncoder().encode(canonicalEventData(event)),
  );
  return bytesToBase64(new Uint8Array(signature));
}

// 供 SyncManager 验签时还原设备公钥
export { hexToBytes };
