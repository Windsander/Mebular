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
import type { NamespaceGrantPolicy } from '../namespacePolicy.js';
import {
  normalizeNamespace,
  normalizeNamespaceList,
  subscriptionToAllowList,
  intersectNamespaceAllowLists,
  isNamespaceAllowed,
  type NamespaceAllowList,
} from '../../core/namespace.js';
import { hexToBytes, verifyCertificateSignature, type AuthSession } from '../../p2p/handshake/AuthenticationHandshake.js';
import {
  SecureChannelSyncTransport,
  nextSyncMessage,
  type SyncDirection,
  type SyncMessage,
  type SyncSnapshot,
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
  /**
   * 初始同步快照阈值（G4）：对端向量时钟为空且本地缺失事件数 ≥ 阈值时，
   * 发送物化快照（nodes+edges+clock）替代全量事件重放。缺省不启用（保持旧行为）。
   */
  snapshotThreshold?: number;
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
  /**
   * 本会话从对端 offer 中确认应用的事件 ID（复用 ApplyResult.ackedIds，
   * 含验签通过但为幂等重复的事件；快照路径为空）。「变更可订阅」据此判断
   * 是否有我关心的新记忆。
   */
  appliedEventIds?: string[];
  /** 本会话以快照发出的物化实体数（nodes+edges）；0/undefined 表示未走快照 */
  snapshotSent?: number;
  /** 本会话以快照应用的对端物化实体数（nodes+edges） */
  snapshotApplied?: number;
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
  /**
   * 初始同步快照阈值（G4）：对端空时钟且缺失事件数 ≥ 阈值时以物化快照替代
   * 全量事件重放；缺省不启用。可由单次 SyncOptions.snapshotThreshold 覆盖。
   */
  snapshotThreshold?: number;
  /** 本机订阅的 namespace：空/缺省 = 全部（保持现状语义） */
  subscriptionNamespaces?: string[];
  /** 对端授权策略（T2 供给端裁剪）；缺省不过滤（向后兼容） */
  namespacePolicy?: NamespaceGrantPolicy;
  /** 本地写入后向订阅对端即时推送（默认关闭） */
  pushOnWrite?: boolean;
  /** push-on-write 节流窗口（ms，默认 50）：连续写入合并为一次推送 */
  pushOnWriteThrottleMs?: number;
}

const DEFAULT_SYNC_TIMEOUT = 30_000;
const DEFAULT_PUSH_ON_WRITE_THROTTLE_MS = 50;

/** 已认证在线对端（push-on-write 的定向目标） */
interface OnlinePeer {
  peerId: PeerId;
  peer: SyncPeer;
  /** 对端 hello 中声明的订阅；undefined = 未声明（不过滤，兼容旧对端） */
  namespaces?: string[];
  /** 本机在该对端会话中的角色（设备 ID 字典序小者发起） */
  initiate: boolean;
}

/** 一次 offer 应用的结果（含 ack 集合与对端事件命名空间） */
interface AppliedOffer {
  ackedIds: string[];
  received: number;
  duplicates: number;
  conflicts: SyncConflict[];
}

export class SyncManager extends EventEmitter {
  private readonly eventLog: EventLog;
  private readonly storage: StorageAdapter;
  private readonly deviceId: string;
  private readonly autoSync: boolean;
  private readonly peerWhitelist: string[] | undefined;
  private readonly syncTimeout: number;
  private readonly userMasterPublicKey: Uint8Array | null;
  private readonly subscriptionNamespaces: string[];
  private readonly namespacePolicy: NamespaceGrantPolicy | null;
  private readonly pushOnWrite: boolean;
  private readonly pushOnWriteThrottleMs: number;

  /** attachToNode 后的网络节点引用（push-on-write 取信道用） */
  private node: P2PNode | null = null;
  /** 已认证在线对端（push-on-write 定向目标），key = peerId.id */
  private readonly onlinePeers = new Map<string, OnlinePeer>();
  /** push-on-write 节流计时器，key = peerId.id（连续写入合并为一次推送） */
  private readonly pushTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** 每个对端已确认（ack）的事件 ID 集合——离线队列的持久依据 */
  private readonly syncedByPeer = new Map<string, Set<string>>();
  /** 已确认集合持久化路径；null 则维持纯内存（6.4 前行为） */
  private readonly syncStatePath: string | null;
  /** 初始同步快照阈值（G4）；undefined 不启用 */
  private readonly snapshotThreshold: number | undefined;
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
    this.snapshotThreshold = options.snapshotThreshold;
    this.subscriptionNamespaces = normalizeNamespaceList(options.subscriptionNamespaces);
    this.namespacePolicy = options.namespacePolicy ?? null;
    this.pushOnWrite = options.pushOnWrite ?? false;
    this.pushOnWriteThrottleMs = options.pushOnWriteThrottleMs ?? DEFAULT_PUSH_ON_WRITE_THROTTLE_MS;
    if (this.pushOnWrite) {
      // 本地写入即触发定向推送；远端 appendRemote 不触发，避免回弹风暴
      this.eventLog.on('event-appended', this.handleLocalAppend);
    }
  }

  /** 本地写入信号：对订阅了相关 namespace 的在线对端安排一次节流推送 */
  private readonly handleLocalAppend = (event: Event): void => {
    const namespace = normalizeNamespace(event.namespace);
    for (const entry of this.onlinePeers.values()) {
      if (!entry.initiate) continue; // 仅发起方角色可主动推送
      if (entry.namespaces && entry.namespaces.length > 0 && !entry.namespaces.includes(namespace)) {
        continue; // 对端未订阅该分区
      }
      this.schedulePush(entry);
    }
  };

  private schedulePush(entry: OnlinePeer): void {
    const key = entry.peerId.id;
    if (this.pushTimers.has(key)) return; // 节流窗口内：合并
    const timer = setTimeout(() => {
      this.pushTimers.delete(key);
      void this.runPush(entry);
    }, this.pushOnWriteThrottleMs);
    (timer as { unref?: () => void }).unref?.();
    this.pushTimers.set(key, timer);
  }

  private async runPush(entry: OnlinePeer): Promise<void> {
    // 对端已离线 / 会话被替换：跳过本次推送
    if (this.onlinePeers.get(entry.peerId.id) !== entry) return;
    try {
      const channel = await this.node?.getChannel(entry.peerId);
      if (!channel) return;
      const transport = new SecureChannelSyncTransport(channel);
      await this.syncWithDevice(transport, entry.peer, { direction: 'push' });
    } catch (error) {
      // 推送失败不阻断本地写入：保留待同步队列，等待下次 autoSync / 手动同步
      this.emit('sync-failed', { peerDeviceId: entry.peer.deviceId, error });
    }
  }

  // ---------- spec-004 查询面 ----------

  getLocalVectorClock(): VectorClock {
    return this.eventLog.getClock();
  }

  /**
   * 待同步事件：未被（指定对端 / 任一已知对端中的某一个）确认过的本地事件。
   *
   * 保留策略约束（PLAN 1.5，本期只落约束不做裁剪）：无参调用返回「尚未被
   * 所有已知对端 ack 的事件」，正是将来任何自动事件裁剪**必须排除**的集合。
   * 丢弃这些事件会让对端永久缺失该记忆，直接违背「所有记忆一致」。
   */
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

          // 1. 交换向量时钟（发起方 hello 携带方向与本机订阅，响应方据此裁剪回供集合）
          await transport.send({
            type: 'sync-hello',
            vectorClock: this.eventLog.getClock().toJSON(),
            direction,
            ...this.localHelloNamespaces(),
          });
          const hello = await nextSyncMessage(iterator, 'sync-hello', timeout);
          this.recordPeerNamespaces(peer.deviceId, hello.namespaces);

          // 2. 我方 offer：按对端时钟计算缺失集；pull 模式只收不发。
          //    先按「对端授权 ∩ 对端订阅 ∩ 本机订阅」裁剪（T2 供给端强制），
          //    对端空时钟且裁剪后缺失集达阈值时改发物化快照（G4；同样裁剪）
          const allow = await this.resolveOutgoingAllowList(peer, hello.namespaces);
          let outgoing = direction === 'pull'
            ? []
            : this.filterEventsForAllow(await this.eventLog.missingEvents(hello.vectorClock), allow);
          const snapshotThreshold = options.snapshotThreshold ?? this.snapshotThreshold;
          let snapshot: SyncSnapshot | undefined;
          if (
            direction !== 'pull' &&
            snapshotThreshold !== undefined &&
            Object.keys(hello.vectorClock).length === 0 &&
            outgoing.length >= snapshotThreshold
          ) {
            snapshot = await this.buildSnapshot(allow);
            outgoing = [];
          }
          await transport.send(
            snapshot
              ? { type: 'sync-offer', events: [], snapshot }
              : { type: 'sync-offer', events: outgoing },
          );
          const ack = await nextSyncMessage(iterator, 'sync-ack', timeout);
          await this.markEventsSynced(peer.deviceId, ack.appliedEventIds);

          // 3. 对端 offer：快照直接采纳（已认证对端）；事件走验签 + 幂等入库 + 冲突应用
          const offer = await nextSyncMessage(iterator, 'sync-offer', timeout);
          let snapshotApplied = 0;
          let applied: AppliedOffer;
          if (offer.snapshot) {
            snapshotApplied = await this.applySnapshot(offer.snapshot);
            applied = { ackedIds: [], received: 0, duplicates: 0, conflicts: [] };
          } else {
            applied = await this.applyOffer(offer.events, peer);
          }
          await transport.send({ type: 'sync-ack', appliedEventIds: applied.ackedIds });

          // 4. 交换最终时钟，收尾
          const finalVectorClock = this.eventLog.getClock().toJSON();
          await transport.send({ type: 'sync-done', finalVectorClock });
          await nextSyncMessage(iterator, 'sync-done', timeout);

          const result = this.buildResult(peer, direction, outgoing.length, applied);
          if (snapshot) {
            result.snapshotSent = snapshot.nodes.length + snapshot.edges.length;
          }
          if (snapshotApplied > 0) {
            result.snapshotApplied = snapshotApplied;
          }
          return result;
        } catch (error) {
          await this.trySendError(transport, error);
          throw error;
        }
      }),
    );
  }

  /** 响应方：接受对端发起的同步会话（帧序与 syncWithDevice 镜像） */
  async acceptSync(transport: SyncTransport, peer: SyncPeer): Promise<SyncResult> {
    return this.enqueue(() =>
      this.runSession(peer, () =>
        this.runResponder(
          transport,
          peer,
          transport.receive()[Symbol.asyncIterator](),
          this.syncTimeout,
        ),
      ),
    );
  }

  /**
   * 响应方会话主体：首个 hello 的超时由 firstHelloTimeout 控制。
   * 常驻监听（push-on-write）传 undefined 表示无限等待——连接关闭时迭代器
   * 自然结束并抛 SYNC_CONNECTION_FAILED，不会留下悬挂的 `.next()`。
   */
  private async runResponder(
    transport: SyncTransport,
    peer: SyncPeer,
    iterator: AsyncIterator<SyncMessage>,
    firstHelloTimeout: number | undefined,
  ): Promise<SyncResult> {
    const timeout = this.syncTimeout;
    try {
      const hello = await nextSyncMessage(iterator, 'sync-hello', firstHelloTimeout);
      this.recordPeerNamespaces(peer.deviceId, hello.namespaces);
      const direction: SyncDirection = hello.direction ?? 'bidirectional';
      await transport.send({
        type: 'sync-hello',
        vectorClock: this.eventLog.getClock().toJSON(),
        ...this.localHelloNamespaces(),
      });

      const offer = await nextSyncMessage(iterator, 'sync-offer', timeout);
      let snapshotApplied = 0;
      let applied: AppliedOffer;
      if (offer.snapshot) {
        // 初始快照：已认证对端直接采纳物化状态并推进时钟（G4）
        snapshotApplied = await this.applySnapshot(offer.snapshot);
        applied = { ackedIds: [], received: 0, duplicates: 0, conflicts: [] };
      } else {
        applied = await this.applyOffer(offer.events, peer);
      }
      await transport.send({ type: 'sync-ack', appliedEventIds: applied.ackedIds });

      // push 模式只对端发；否则按「对端授权 ∩ 对端订阅 ∩ 本机订阅」裁剪后回供（T2）
      const allow = await this.resolveOutgoingAllowList(peer, hello.namespaces);
      const outgoing = direction === 'push'
        ? []
        : this.filterEventsForAllow(await this.eventLog.missingEvents(hello.vectorClock), allow);
      await transport.send({ type: 'sync-offer', events: outgoing });
      const ack = await nextSyncMessage(iterator, 'sync-ack', timeout);
      await this.markEventsSynced(peer.deviceId, ack.appliedEventIds);

      await nextSyncMessage(iterator, 'sync-done', timeout);
      const finalVectorClock = this.eventLog.getClock().toJSON();
      await transport.send({ type: 'sync-done', finalVectorClock });

      const result = this.buildResult(peer, direction, outgoing.length, applied);
      if (snapshotApplied > 0) {
        result.snapshotApplied = snapshotApplied;
      }
      return result;
    } catch (error) {
      await this.trySendError(transport, error);
      throw error;
    }
  }

  /**
   * 常驻监听对端发起的同步会话（响应方角色；push-on-write 用）。
   * 单次会话失败不终止监听（除连接关闭外），保证后续推送仍可被接受。
   */
  private async runIncomingLoop(node: P2PNode, entry: OnlinePeer): Promise<void> {
    const channel = await node.getChannel(entry.peerId);
    if (!channel) return;
    const transport = new SecureChannelSyncTransport(channel);
    const iterator = transport.receive()[Symbol.asyncIterator]();
    for (;;) {
      if (this.onlinePeers.get(entry.peerId.id) !== entry) return;
      try {
        await this.enqueue(() =>
          this.runSession(entry.peer, () => this.runResponder(transport, entry.peer, iterator, undefined)),
        );
      } catch (error) {
        if ((error as { code?: string }).code === ErrorCodes.SYNC_CONNECTION_FAILED) return;
        // 单次会话失败（验签/协议）：已尽力通知对端，继续等待下一次会话
      }
    }
  }

  // ---------- 自动同步（phase-3-plan 3.4） ----------

  /**
   * 挂到 P2PNode：握手认证完成后自动触发一次双向同步。
   * 角色仲裁：设备 ID 字典序小者发起，大者响应（双端各触发一次，角色互补）。
   */
  attachToNode(node: P2PNode): void {
    this.node = node;
    // 连接关闭：清理在线登记与推送节流计时器
    node.onConnectionClosed((peerId: PeerId) => this.removeOnlinePeer(peerId));

    node.getHandshake().on('authenticated', (session: AuthSession) => {
      const peerDeviceId = session.certificate?.deviceId ?? session.peerId.id;
      if (this.peerWhitelist && !this.peerWhitelist.includes(peerDeviceId)) {
        return;
      }
      const publicKey = session.certificate
        ? hexToBytes(session.certificate.devicePublicKey)
        : session.peerId.pubKey;
      const peer: SyncPeer = { deviceId: peerDeviceId, publicKey };
      const initiate = this.deviceId < peerDeviceId;
      const entry: OnlinePeer = { peerId: session.peerId, peer, initiate };
      this.onlinePeers.set(session.peerId.id, entry);

      if (!this.autoSync) {
        // autoSync 关闭：仅 push-on-write 时以常驻监听接收定向推送
        if (this.pushOnWrite && !initiate) {
          this.runIncomingLoop(node, entry).catch((error) => {
            this.emit('sync-failed', { peerDeviceId, error });
          });
        }
        return;
      }

      void (async () => {
        try {
          if (initiate) {
            const channel = await node.getChannel(session.peerId);
            if (!channel) {
              throw new SyncError(
                `Secure channel to ${peer.deviceId} not ready`,
                ErrorCodes.SYNC_CONNECTION_FAILED,
              );
            }
            await this.syncWithDevice(new SecureChannelSyncTransport(channel), peer, {
              direction: 'bidirectional',
            });
          } else if (this.pushOnWrite) {
            // 响应方常驻监听：既完成首次同步，也接收后续定向推送
            await this.runIncomingLoop(node, entry);
          } else {
            const channel = await node.getChannel(session.peerId);
            if (!channel) {
              throw new SyncError(
                `Secure channel to ${peer.deviceId} not ready`,
                ErrorCodes.SYNC_CONNECTION_FAILED,
              );
            }
            await this.acceptSync(new SecureChannelSyncTransport(channel), peer);
          }
        } catch (error) {
          this.emit('sync-failed', { peerDeviceId, error });
        }
      })();
    });
  }

  private removeOnlinePeer(peerId: PeerId): void {
    this.onlinePeers.delete(peerId.id);
    const timer = this.pushTimers.get(peerId.id);
    if (timer) {
      clearTimeout(timer);
      this.pushTimers.delete(peerId.id);
    }
  }

  /** 对端 hello 声明的订阅回填到在线登记（供 push-on-write 定向判断） */
  private recordPeerNamespaces(peerDeviceId: string, namespaces?: string[]): void {
    const normalized = namespaces === undefined ? undefined : normalizeNamespaceList(namespaces);
    const value = normalized && normalized.length > 0 ? normalized : undefined;
    for (const entry of this.onlinePeers.values()) {
      if (entry.peer.deviceId === peerDeviceId) {
        entry.namespaces = value;
      }
    }
  }

  /** 本机 hello 携带的订阅字段：未配置/空 = 不声明（旧对端行为不变） */
  private localHelloNamespaces(): { namespaces?: string[] } {
    return this.subscriptionNamespaces.length > 0
      ? { namespaces: [...this.subscriptionNamespaces] }
      : {};
  }

  /**
   * 供给端裁剪链：本机订阅 ∩ 对端声明订阅 ∩ 对端被授权集合。
   * 三者任一「未声明」= 不过滤；任一为空白名单 = 不供任何分区。
   */
  private async resolveOutgoingAllowList(
    peer: SyncPeer,
    remoteNamespaces?: string[],
  ): Promise<NamespaceAllowList> {
    const declared = remoteNamespaces === undefined ? null : normalizeNamespaceList(remoteNamespaces);
    const declaredAllow = declared && declared.length > 0 ? declared : null;
    const peerAuthorized = this.namespacePolicy
      ? await this.namespacePolicy.getAuthorizedNamespaces(peer.deviceId)
      : null;
    return intersectNamespaceAllowLists(
      subscriptionToAllowList(this.subscriptionNamespaces),
      declaredAllow,
      peerAuthorized,
    );
  }

  private filterEventsForAllow(events: Event[], allow: NamespaceAllowList): Event[] {
    if (allow === null) return events;
    return events.filter((event) => isNamespaceAllowed(event.namespace, allow));
  }

  // ---------- 内部 ----------

  /** 应用管线：验签 → 幂等入库 → 冲突感知应用；验签失败即中止会话 */
  private async applyOffer(events: Event[], peer: SyncPeer): Promise<AppliedOffer> {
    const ackedIds: string[] = [];
    const appliedIds: string[] = [];
    const appliedNamespaces = new Set<string>();
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
        appliedIds.push(event.id);
        appliedNamespaces.add(normalizeNamespace(event.namespace));
      }
      if (result.conflict) {
        conflicts.push(result.conflict);
        this.emit('conflict', result.conflict);
      }
    }

    // 变更可订阅（一致性的可观测性）：本机刚应用了哪些远端事件、涉及哪些分区
    if (appliedIds.length > 0) {
      this.emit('events-applied', {
        peerDeviceId: peer.deviceId,
        eventIds: appliedIds,
        namespaces: [...appliedNamespaces],
      });
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

  /**
   * 构造物化快照（G4）：按 allow list 裁剪节点/边（未授权分区不进快照，
   * 堵住「空时钟走快照通道绕过授权」的洞）。
   *
   * 时钟处理：裁剪时用「被允许事件」的向量时钟合并值，而不是本机全量时钟——
   * 否则对端会把未收到的分区也记为已同步，之后即便授权变化也永久缺失。
   */
  private async buildSnapshot(allow: NamespaceAllowList): Promise<SyncSnapshot> {
    const nodes = await this.storage.listNodes();
    const edges = await this.storage.listEdges();
    if (allow === null) {
      return { nodes, edges, clock: this.eventLog.getClock().toJSON() };
    }
    const clock = new VectorClock();
    for (const event of await this.eventLog.listEvents()) {
      if (isNamespaceAllowed(event.namespace, allow)) {
        clock.merge(VectorClock.fromJSON(event.vectorClock ?? {}));
      }
    }
    return {
      nodes: nodes.filter((node) => isNamespaceAllowed(node.namespace, allow)),
      edges: edges.filter((edge) => isNamespaceAllowed(edge.namespace, allow)),
      clock: clock.toJSON(),
      namespaces: [...allow],
    };
  }

  /**
   * 采纳快照：物化节点/边写入存储，时钟合并推进，返回实体数。
   * 快照仅来自已认证对端；不做逐事件验签（fast-start 取舍，见 protocol.ts）。
   */
  private async applySnapshot(snapshot: SyncSnapshot): Promise<number> {
    for (const node of snapshot.nodes) {
      await this.storage.putNode(node);
    }
    for (const edge of snapshot.edges) {
      await this.storage.putEdge(edge);
    }
    this.eventLog.getClock().merge(VectorClock.fromJSON(snapshot.clock));
    return snapshot.nodes.length + snapshot.edges.length;
  }

  private buildResult(
    peer: SyncPeer,
    direction: SyncDirection,
    sent: number,
    applied: AppliedOffer,
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
      // 变更可订阅：复用 ApplyResult.ackedIds（不新造来源），快照路径为空
      appliedEventIds: [...applied.ackedIds],
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
