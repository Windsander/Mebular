// SyncManager 同步管理器（phase-3-plan 3.2/3.4 重写，对齐 spec-004）
//
// 职责：
// - 在 SecureChannel 上按 protocol.ts 的固定帧序完成一次同步会话
//   （syncWithDevice 发起方 / acceptSync 响应方，双角色共用一套应用管线）；
// - 应用管线：逐条验签（EventLog.verifyEvent）→ 事件日志幂等入库
//   （appendRemote）→ 冲突感知应用（applyRemoteEvent），冲突随结果与
//   'conflict' 事件上报；
// - 离线队列：待同步集合 = 本地事件 − 对端已确认集合，按对端分桶持久，
//   重连后续传天然幂等（内容寻址 ID 去重）；
// - 已确认集合持久化（6.4）：配置 syncStatePath 后按对端已确认集合落盘
//   （原子写：tmp+rename），重启后首帧不再多带一轮冗余事件；
//   状态文件损坏诚实报 STORAGE_READ_FAILED，不静默重置。
// - 自动同步：attachToNode 后在握手 'authenticated' 上触发，
//   设备 ID 字典序小者发起，大者响应，避免双发死锁。
//
// 会话串行化：同一时刻只允许一个同步会话（enqueue 排队），
// 避免共享信道上的帧序交错。

import { EventEmitter } from 'events';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { StorageAdapter } from '../../storage/StorageAdapter.js';
import { EventLog } from '../../eventlog/EventLog.js';
import { VectorClock } from '../vectorclock/index.js';
import { ErrorCodes, StorageError, SyncError } from '../../errors.js';
import type { Event } from '../../types/event.js';
import { applyRemoteEvent, type SyncConflict } from '../apply.js';
import { hexToBytes, verifyCertificateSignature, type AuthSession } from '../../p2p/handshake/AuthenticationHandshake.js';
import {
  SecureChannelSyncTransport,
  nextSyncMessage,
  type SyncDirection,
  type SyncTransport,
} from '../protocol.js';
import type { P2PNode, PeerId } from '../../p2p/P2PNetwork.js';

export interface SyncPeer {
  deviceId: string;
  /** 对端设备 Ed25519 公钥（原始 32 字节），用于事件验签 */
  publicKey: Uint8Array;
}

export interface SyncOptions {
  direction?: SyncDirection;
  timeoutMs?: number;
}

export interface SyncResult {
  peerDeviceId: string;
  direction: SyncDirection;
  /** 本方发出并被对端确认的事件数 */
  sentEvents: number;
  /** 本方实际应用的对端事件数（不含重复） */
  receivedEvents: number;
  /** 已持有而跳过的重复事件数 */
  duplicates: number;
  conflicts: SyncConflict[];
  durationMs: number;
  finalVectorClock: Record<string, number>;
}

export interface SyncStatus {
  isSyncing: boolean;
  pendingCount: number;
  lastSyncAt: number | null;
  lastResult: SyncResult | null;
}

export interface SyncManagerOptions {
  eventLog: EventLog;
  storage: StorageAdapter;
  deviceId: string;
  /** attachToNode 后是否在认证完成时自动同步（默认 true） */
  autoSync?: boolean;
  /** 允许自动同步的对端设备 ID 白名单；缺省不过滤 */
  peerWhitelist?: string[];
  /** 单条协议消息等待超时（默认 30s） */
  syncTimeout?: number;
  /**
   * 用户主公钥（Phase 5.1 信任链）：提供后，非直连对端签发的事件
   * 可经 authorCertificate 证书链验签（中继/多跳场景）；未提供时
   * 只接受直连对端直签事件（Phase 3 行为）。
   */
  userMasterPublicKey?: Uint8Array;
  /**
   * 已确认集合持久化文件路径（6.4）：提供后，markEventsSynced 确认的
   * 事件 ID 集合随会话落盘（JSON，原子写），重启后懒加载恢复，
   * 首帧 offer 不再携带对端早已确认的冗余事件。
   */
  syncStatePath?: string;
}

const DEFAULT_SYNC_TIMEOUT = 30_000;

export class SyncManager extends EventEmitter {
  private readonly eventLog: EventLog;
  private readonly storage: StorageAdapter;
  private readonly deviceId: string;
  private readonly autoSync: boolean;
  private readonly peerWhitelist: string[] | undefined;
  private readonly syncTimeout: number;
  private readonly userMasterPublicKey: Uint8Array | null;

  /** 每个对端已确认（ack）的事件 ID 集合——离线队列的持久依据 */
  private readonly syncedByPeer = new Map<string, Set<string>>();
  /** 已确认集合持久化路径；null 则维持纯内存（6.4 前行为） */
  private readonly syncStatePath: string | null;
  /** 懒加载在途 Promise（去重并发首次访问） */
  private syncStateLoading: Promise<void> | null = null;

  private queue: Promise<unknown> = Promise.resolve();
  private syncing = false;
  private lastSyncAt: number | null = null;
  private lastResult: SyncResult | null = null;

  constructor(options: SyncManagerOptions) {
    super();
    this.eventLog = options.eventLog;
    this.storage = options.storage;
    this.deviceId = options.deviceId;
    this.autoSync = options.autoSync ?? true;
    this.peerWhitelist = options.peerWhitelist;
    this.syncTimeout = options.syncTimeout ?? DEFAULT_SYNC_TIMEOUT;
    this.userMasterPublicKey = options.userMasterPublicKey ?? null;
    this.syncStatePath = options.syncStatePath ?? null;
  }

  // ---------- spec-004 查询面 ----------

  getLocalVectorClock(): VectorClock {
    return this.eventLog.getClock();
  }

  /** 待同步事件：未被（指定对端 / 任一已知对端中的某一个）确认过的本地事件 */
  async getPendingEvents(peerDeviceId?: string): Promise<Event[]> {
    await this.ensureSyncStateLoaded();
    const all = await this.eventLog.listEvents();
    if (peerDeviceId) {
      const acked = this.syncedByPeer.get(peerDeviceId);
      return all.filter((event) => !acked?.has(event.id));
    }
    const peerIds = [...this.syncedByPeer.keys()];
    if (peerIds.length === 0) {
      return all;
    }
    return all.filter((event) =>
      peerIds.some((id) => !this.syncedByPeer.get(id)!.has(event.id)),
    );
  }

  async markEventsSynced(peerDeviceId: string, eventIds: string[]): Promise<void> {
    await this.ensureSyncStateLoaded();
    let acked = this.syncedByPeer.get(peerDeviceId);
    if (!acked) {
      acked = new Set();
      this.syncedByPeer.set(peerDeviceId, acked);
    }
    for (const id of eventIds) {
      acked.add(id);
    }
    await this.persistSyncState();
  }

  // ---------- 已确认集合持久化（6.4） ----------

  /** 懒加载持久化的已确认集合；无配置路径时为空操作（纯内存行为不变） */
  private ensureSyncStateLoaded(): Promise<void> {
    if (!this.syncStatePath) return Promise.resolve();
    this.syncStateLoading ??= this.loadSyncState(this.syncStatePath);
    return this.syncStateLoading;
  }

  private async loadSyncState(filePath: string): Promise<void> {
    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; // 首次运行：无状态文件正常
      throw new StorageError(
        `同步状态读取失败：${filePath}`,
        ErrorCodes.STORAGE_READ_FAILED,
        error as Error,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      throw new StorageError(
        `同步状态文件损坏：${filePath}`,
        ErrorCodes.STORAGE_READ_FAILED,
        error as Error,
      );
    }
    const peers = (parsed as { peers?: unknown } | null)?.peers;
    if (!peers || typeof peers !== 'object') {
      throw new StorageError(
        `同步状态文件缺少 peers 字段：${filePath}`,
        ErrorCodes.STORAGE_READ_FAILED,
      );
    }
    for (const [peerId, ids] of Object.entries(peers)) {
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
        throw new StorageError(
          `同步状态文件 peers.${peerId} 不是字符串数组：${filePath}`,
          ErrorCodes.STORAGE_READ_FAILED,
        );
      }
      this.syncedByPeer.set(peerId, new Set(ids as string[]));
    }
  }

  /** 原子落盘：tmp + rename，避免半写状态文件 */
  private async persistSyncState(): Promise<void> {
    if (!this.syncStatePath) return;
    const filePath = this.syncStatePath;
    const peers: Record<string, string[]> = {};
    for (const [peerId, ids] of this.syncedByPeer) {
      peers[peerId] = [...ids].sort(); // 排序保证输出确定，便于审计与测试
    }
    const tmpPath = `${filePath}.tmp`;
    try {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(tmpPath, JSON.stringify({ version: 1, peers }), 'utf-8');
      await rename(tmpPath, filePath);
    } catch (error) {
      throw new StorageError(
        `同步状态写入失败：${filePath}`,
        ErrorCodes.STORAGE_WRITE_FAILED,
        error as Error,
      );
    }
  }

  async hasPendingEvents(peerDeviceId?: string): Promise<boolean> {
    return (await this.getPendingEvents(peerDeviceId)).length > 0;
  }

  async getSyncStatus(): Promise<SyncStatus> {
    return {
      isSyncing: this.syncing,
      pendingCount: (await this.getPendingEvents()).length,
      lastSyncAt: this.lastSyncAt,
      lastResult: this.lastResult,
    };
  }

  // ---------- 同步会话 ----------

  /** 发起方：向对端发起一次同步会话 */
  async syncWithDevice(
    transport: SyncTransport,
    peer: SyncPeer,
    options: SyncOptions = {},
  ): Promise<SyncResult> {
    const direction = options.direction ?? 'bidirectional';
    const timeout = options.timeoutMs ?? this.syncTimeout;

    return this.enqueue(() =>
      this.runSession(peer, async () => {
        try {
          const iterator = transport.receive()[Symbol.asyncIterator]();

          // 1. 交换向量时钟（发起方 hello 携带方向，响应方据此决定回供集合）
          await transport.send({
            type: 'sync-hello',
            vectorClock: this.eventLog.getClock().toJSON(),
            direction,
          });
          const hello = await nextSyncMessage(iterator, 'sync-hello', timeout);

          // 2. 我方 offer：按对端时钟计算缺失集；pull 模式只收不发
          const outgoing = direction === 'pull'
            ? []
            : await this.eventLog.missingEvents(hello.vectorClock);
          await transport.send({ type: 'sync-offer', events: outgoing });
          const ack = await nextSyncMessage(iterator, 'sync-ack', timeout);
          await this.markEventsSynced(peer.deviceId, ack.appliedEventIds);

          // 3. 对端 offer：验签 + 幂等入库 + 冲突感知应用
          const offer = await nextSyncMessage(iterator, 'sync-offer', timeout);
          const applied = await this.applyOffer(offer.events, peer);
          await transport.send({ type: 'sync-ack', appliedEventIds: applied.ackedIds });

          // 4. 交换最终时钟，收尾
          const finalVectorClock = this.eventLog.getClock().toJSON();
          await transport.send({ type: 'sync-done', finalVectorClock });
          await nextSyncMessage(iterator, 'sync-done', timeout);

          return this.buildResult(peer, direction, outgoing.length, applied);
        } catch (error) {
          await this.trySendError(transport, error);
          throw error;
        }
      }),
    );
  }

  /** 响应方：接受对端发起的同步会话（帧序与 syncWithDevice 镜像） */
  async acceptSync(transport: SyncTransport, peer: SyncPeer): Promise<SyncResult> {
    const timeout = this.syncTimeout;

    return this.enqueue(() =>
      this.runSession(peer, async () => {
        try {
          const iterator = transport.receive()[Symbol.asyncIterator]();

          const hello = await nextSyncMessage(iterator, 'sync-hello', timeout);
          const direction: SyncDirection = hello.direction ?? 'bidirectional';
          await transport.send({
            type: 'sync-hello',
            vectorClock: this.eventLog.getClock().toJSON(),
          });

          const offer = await nextSyncMessage(iterator, 'sync-offer', timeout);
          const applied = await this.applyOffer(offer.events, peer);
          await transport.send({ type: 'sync-ack', appliedEventIds: applied.ackedIds });

          // push 模式只对端发，我方回空 offer
          const outgoing = direction === 'push'
            ? []
            : await this.eventLog.missingEvents(hello.vectorClock);
          await transport.send({ type: 'sync-offer', events: outgoing });
          const ack = await nextSyncMessage(iterator, 'sync-ack', timeout);
          await this.markEventsSynced(peer.deviceId, ack.appliedEventIds);

          await nextSyncMessage(iterator, 'sync-done', timeout);
          const finalVectorClock = this.eventLog.getClock().toJSON();
          await transport.send({ type: 'sync-done', finalVectorClock });

          return this.buildResult(peer, direction, outgoing.length, applied);
        } catch (error) {
          await this.trySendError(transport, error);
          throw error;
        }
      }),
    );
  }

  // ---------- 自动同步（phase-3-plan 3.4） ----------

  /**
   * 挂到 P2PNode：握手认证完成后自动触发一次双向同步。
   * 角色仲裁：设备 ID 字典序小者发起，大者响应（双端各触发一次，角色互补）。
   */
  attachToNode(node: P2PNode): void {
    node.getHandshake().on('authenticated', (session: AuthSession) => {
      if (!this.autoSync) {
        return;
      }
      const peerDeviceId = session.certificate?.deviceId ?? session.peerId.id;
      if (this.peerWhitelist && !this.peerWhitelist.includes(peerDeviceId)) {
        return;
      }
      const publicKey = session.certificate
        ? hexToBytes(session.certificate.devicePublicKey)
        : session.peerId.pubKey;
      const peer: SyncPeer = { deviceId: peerDeviceId, publicKey };
      const initiate = this.deviceId < peerDeviceId;

      this.runAutoSync(node, session.peerId, peer, initiate).catch((error) => {
        this.emit('sync-failed', { peerDeviceId, error });
      });
    });
  }

  private async runAutoSync(
    node: P2PNode,
    peerId: PeerId,
    peer: SyncPeer,
    initiate: boolean,
  ): Promise<void> {
    // 信道在认证完成后异步建立，轮询等待其就绪
    const channel = await node.getChannel(peerId);
    if (!channel) {
      throw new SyncError(`Secure channel to ${peer.deviceId} not ready`, ErrorCodes.SYNC_CONNECTION_FAILED);
    }
    const transport = new SecureChannelSyncTransport(channel);
    if (initiate) {
      await this.syncWithDevice(transport, peer, { direction: 'bidirectional' });
    } else {
      await this.acceptSync(transport, peer);
    }
  }

  // ---------- 内部 ----------

  /** 应用管线：验签 → 幂等入库 → 冲突感知应用；验签失败即中止会话 */
  private async applyOffer(
    events: Event[],
    peer: SyncPeer,
  ): Promise<{ ackedIds: string[]; received: number; duplicates: number; conflicts: SyncConflict[] }> {
    const ackedIds: string[] = [];
    const conflicts: SyncConflict[] = [];
    let received = 0;
    let duplicates = 0;

    for (const event of events) {
      const valid = await this.verifyEventTrust(event, peer);
      if (!valid) {
        throw new SyncError(`Event signature verification failed: ${event.id}`, ErrorCodes.SYNC_INVALID_EVENT);
      }

      // 验签通过即确认（重复/冲突落败也已入日志，重收时为幂等重复）
      ackedIds.push(event.id);

      const appended = await this.eventLog.appendRemote(event);
      if (appended === 'duplicate') {
        duplicates += 1;
        continue;
      }

      const result = await applyRemoteEvent(this.storage, event);
      if (result.status === 'applied') {
        received += 1;
      }
      if (result.conflict) {
        conflicts.push(result.conflict);
        this.emit('conflict', result.conflict);
      }
    }

    return { ackedIds, received, duplicates, conflicts };
  }

  /**
   * 事件信任链验签（Phase 5.1，收口 D9）：
   * - 直连对端直签：author 即对端设备 → 用对端公钥验签（快路径）；
   * - 中继/多跳：author 是第三设备 → 事件须携带 authorCertificate，
   *   且证书 deviceId 与 author 一致、证书经用户主密钥验签后，
   *   用证书中的设备公钥验事件签名；
   * - 其余形态（无证书、证书不匹配、未配置主公钥）一律拒绝。
   */
  private async verifyEventTrust(event: Event, peer: SyncPeer): Promise<boolean> {
    if (event.author === peer.deviceId) {
      return EventLog.verifyEvent(event, peer.publicKey);
    }
    const certificate = event.authorCertificate;
    if (!certificate || certificate.deviceId !== event.author || !this.userMasterPublicKey) {
      return false;
    }
    const certValid = await verifyCertificateSignature(certificate, this.userMasterPublicKey);
    if (!certValid) {
      return false;
    }
    try {
      return await EventLog.verifyEvent(event, hexToBytes(certificate.devicePublicKey));
    } catch {
      return false;
    }
  }

  private buildResult(
    peer: SyncPeer,
    direction: SyncDirection,
    sent: number,
    applied: { received: number; duplicates: number; conflicts: SyncConflict[] },
  ): SyncResult {
    return {
      peerDeviceId: peer.deviceId,
      direction,
      sentEvents: sent,
      receivedEvents: applied.received,
      duplicates: applied.duplicates,
      conflicts: applied.conflicts,
      durationMs: 0, // 由 runSession 填充
      finalVectorClock: this.eventLog.getClock().toJSON(),
    };
  }

  /** 会话串行化：共享信道不允许多会话帧序交错 */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** 失败时尽力通知对端（对端可能正在等帧），发送失败忽略 */
  private async trySendError(transport: SyncTransport, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await transport.send({ type: 'sync-error', message }).catch(() => undefined);
  }

  /** 会话骨架：状态维护、事件上报、错误时尽力通知对端 */
  private async runSession<T extends SyncResult>(    peer: SyncPeer,
    session: () => Promise<T>,
  ): Promise<SyncResult> {
    const startedAt = Date.now();
    this.syncing = true;
    this.emit('sync-started', { peerDeviceId: peer.deviceId });
    try {
      const result = await session();
      result.durationMs = Date.now() - startedAt;
      this.lastSyncAt = Date.now();
      this.lastResult = result;
      this.emit('sync-completed', result);
      return result;
    } catch (error) {
      this.emit('sync-failed', { peerDeviceId: peer.deviceId, error });
      throw error;
    } finally {
      this.syncing = false;
    }
  }
}
