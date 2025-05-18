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
// - 自动同步：attachToNode 后在握手 'authenticated' 上触发，
//   设备 ID 字典序小者发起，大者响应，避免双发死锁。
//
// 会话串行化：同一时刻只允许一个同步会话（enqueue 排队），
// 避免共享信道上的帧序交错。

import { EventEmitter } from 'events';
import type { StorageAdapter } from '../../storage/StorageAdapter.js';
import { EventLog } from '../../eventlog/EventLog.js';
import { VectorClock } from '../vectorclock/index.js';
import type { Event } from '../../types/event.js';
import { applyRemoteEvent, type SyncConflict } from '../apply.js';
import { hexToBytes, type AuthSession } from '../../p2p/handshake/AuthenticationHandshake.js';
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
}

const DEFAULT_SYNC_TIMEOUT = 30_000;

export class SyncManager extends EventEmitter {
  private readonly eventLog: EventLog;
  private readonly storage: StorageAdapter;
  private readonly deviceId: string;
  private readonly autoSync: boolean;
  private readonly peerWhitelist: string[] | undefined;
  private readonly syncTimeout: number;

  /** 每个对端已确认（ack）的事件 ID 集合——离线队列的持久依据 */
  private readonly syncedByPeer = new Map<string, Set<string>>();

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
  }

  // ---------- spec-004 查询面 ----------

  getLocalVectorClock(): VectorClock {
    return this.eventLog.getClock();
  }

  /** 待同步事件：未被（指定对端 / 任一已知对端中的某一个）确认过的本地事件 */
  async getPendingEvents(peerDeviceId?: string): Promise<Event[]> {
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

  markEventsSynced(peerDeviceId: string, eventIds: string[]): void {
    let acked = this.syncedByPeer.get(peerDeviceId);
    if (!acked) {
      acked = new Set();
      this.syncedByPeer.set(peerDeviceId, acked);
    }
    for (const id of eventIds) {
      acked.add(id);
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
          this.markEventsSynced(peer.deviceId, ack.appliedEventIds);

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
          this.markEventsSynced(peer.deviceId, ack.appliedEventIds);

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
      throw new Error(`Secure channel to ${peer.deviceId} not ready`);
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
      const valid = await EventLog.verifyEvent(event, peer.publicKey);
      if (!valid) {
        throw new Error(`Event signature verification failed: ${event.id}`);
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
