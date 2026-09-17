// SyncManager 同步管理器（phase-3-plan 3.2/3.4 重写，对齐 spec-004）
//
// 职责：
// - 在 SecureChannel 上按 protocol.ts 的固定帧序完成一次同步会话
//   （syncWithDevice 发起方 / acceptSync 响应方，双角色共用一套应用管线）；
// - 应用管线：逐条验签（EventLog.verifyEvent）→ 事件日志幂等入库
//   （appendRemote）→ 冲突感知应用（applyRemoteEvent），冲突随结果与
//   'conflict' 事件上报；
// - 授权姿态：**默认拒绝**。对端必须被 NamespaceGrantPolicy 显式授权才能
//   收到任何分区；未配置策略 = 拒绝全部。裁剪链同时作用于 offer 与快照。
// - 分区水位（per-(peer, namespace) watermark）：缺失判定只在同一分区内
//   比较（event.author 计数 > 该 (peer, ns) 水位才算缺失），而不是拿对端的
//   累积全局时钟比对。这样未授权分区被跳过后，日后扩权仍能从正确起点回补。
// - 离线队列：待同步集合 = 本地事件 − 对端已确认集合，按对端分桶持久，
//   重连后续传天然幂等（内容寻址 ID 去重）；
// - 同步状态持久化（6.4 / 本轮 v2）：配置 syncStatePath 后落盘 per-event ack
//   集合 + per-(peer, namespace) 水位 + 快照推进的分区水位（原子写 tmp+rename），
//   重启后首帧不重发已确认事件、也不遗漏未发送分区；状态文件损坏诚实报
//   STORAGE_READ_FAILED，不静默重置。
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
import { ConfigNamespacePolicy, type NamespaceGrantPolicy } from '../namespacePolicy.js';
import { POLICY_NAMESPACE } from '../grantPolicy.js';
import { verifyIssuedByUser } from '../trust.js';
import {
  normalizeNamespace,
  normalizeNamespaceList,
  declarationToAllowList,
  intersectNamespaceAllowLists,
  isNamespaceAllowed,
  mergeClockInto,
  mergeNamespaceClocks,
  namespaceClockOf,
  type NamespaceClocks,
} from '../../core/namespace.js';
import { hexToBytes, type AuthSession } from '../../p2p/handshake/AuthenticationHandshake.js';
import {
  SecureChannelSyncTransport,
  nextSyncMessage,
  assertValidHello,
  assertValidSnapshot,
  assertValidAck,
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
  /**
   * 本会话是否「未授权任何分区」（裁剪链解析为 `[]`）：拒绝不再静默，
   * 订阅方据此把「没数据」与「没被授权」区分开。
   */
  denied?: boolean;
  /** 本会话以快照发出的物化实体数（nodes+edges）；0/undefined 表示未走快照 */
  snapshotSent?: number;
  /** 本会话以快照应用的对端物化实体数（nodes+edges） */
  snapshotApplied?: number;
  /**
   * 诊断信号（R1）：对端 hello 自报的分区水位**高于**本机记录（ack/已确认
   * 快照）的部分，仅用于发现「对端有问题」。自报**不参与**水位推进，因此
   * 该信号非空也不会影响本会话的发送集合。无差异时为 undefined。
   */
  reportedAhead?: NamespaceClocks;
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
  /**
   * 对端授权策略（T2 供给端裁剪，默认拒绝）。
   * 缺省 = `ConfigNamespacePolicy({})`：**不授权任何对端**，没有对端能收到数据。
   */
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
  /** 对端 hello 的订阅声明：true = 全部分区；false = 只订阅 namespaces */
  subscribeAll: boolean;
  /** 对端 hello 中声明的显式订阅清单（subscribeAll=true 时忽略） */
  namespaces: string[];
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

/**
 * 实体是否由当前被吊销的设备署名（F-1）：`createdBy` 或 `updatedBy` 命中即拒绝。
 * 堵住「被吊销设备的事件在入站写入处被隔离，但其署名实体仍可经已授权对端的
 * 快照进入本图」的旁路。
 */
function isEntityAuthoredByRevoked(
  entity: { createdBy?: string; updatedBy?: string },
  revoked: ReadonlySet<string> | undefined,
): boolean {
  if (!revoked || revoked.size === 0) return false;
  if (entity.createdBy !== undefined && revoked.has(entity.createdBy)) return true;
  return entity.updatedBy !== undefined && revoked.has(entity.updatedBy);
}

/**
 * 快照应用的回退保护（R3）：仅当本地不存在、或快照版本时钟**严格更新**时才写入。
 * 并发（互不因果）时保留本地版本——宁可少应用，绝不回退。这不是完整冲突解决；
 * 快照只发给空对端的前提（R2）仍然成立，见 `applySnapshot`。
 */
function shouldApplySnapshotEntity(
  local: { vectorClock?: Record<string, number> } | null,
  incoming: { vectorClock?: Record<string, number> },
): boolean {
  if (!local) return true;
  return (
    VectorClock.fromJSON(incoming.vectorClock ?? {}).compare(
      VectorClock.fromJSON(local.vectorClock ?? {}),
    ) === 'greater'
  );
}

/** 分区时钟的确定性排序输出（namespace / author 键排序，便于审计与测试） */
function sortNamespaceClocks(clocks: NamespaceClocks): NamespaceClocks {
  const out: NamespaceClocks = {};
  for (const ns of Object.keys(clocks).sort()) {
    const clock = clocks[ns]!;
    const sorted: Record<string, number> = {};
    for (const author of Object.keys(clock).sort()) {
      sorted[author] = clock[author]!;
    }
    out[ns] = sorted;
  }
  return out;
}

/** 解析并校验持久化的分区时钟（loadSyncState 用） */
function parseNamespaceClocks(value: unknown, label: string, filePath: string): NamespaceClocks {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new StorageError(
      `同步状态文件 ${label} 形状非法：${filePath}`,
      ErrorCodes.STORAGE_READ_FAILED,
    );
  }
  const result: NamespaceClocks = {};
  for (const [ns, clock] of Object.entries(value as Record<string, unknown>)) {
    if (clock === null || typeof clock !== 'object' || Array.isArray(clock)) {
      throw new StorageError(
        `同步状态文件 ${label}.${ns} 形状非法：${filePath}`,
        ErrorCodes.STORAGE_READ_FAILED,
      );
    }
    const parsed: Record<string, number> = {};
    for (const [author, count] of Object.entries(clock as Record<string, unknown>)) {
      if (typeof count !== 'number' || !Number.isFinite(count)) {
        throw new StorageError(
          `同步状态文件 ${label}.${ns}.${author} 非数值：${filePath}`,
          ErrorCodes.STORAGE_READ_FAILED,
        );
      }
      parsed[author] = count;
    }
    result[ns] = parsed;
  }
  return result;
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
  /** 对端授权策略：永不缺省为「不过滤」——未配置即拒绝全部（默认拒绝） */
  private readonly namespacePolicy: NamespaceGrantPolicy;
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
  /**
   * per-(对端, 分区) 同步水位：对端在各分区已收到的最大作者计数。
   * 缺失判定据此进行，并在 ack / 对端 hello 时推进；持久化（v2）。
   */
  private readonly peerWatermarks = new Map<string, NamespaceClocks>();
  /**
   * 本机经快照推进的分区水位（快照不带事件，无法从事件日志推导）。
   * hello 上报本机分区水位时与「事件日志推导值」合并；持久化（v2）。
   */
  private localSnapshotClocks: NamespaceClocks = {};
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
    // 默认拒绝：未配置策略时用空配置策略，任何对端都未获授权
    this.namespacePolicy = options.namespacePolicy ?? new ConfigNamespacePolicy({});
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
      // 是否推送只看订阅声明；授权裁剪仍由会话内的 offer 计算兜底
      if (!entry.subscribeAll && !entry.namespaces.includes(namespace)) {
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

  /**
   * 记录对端已确认的事件，并据此推进 per-(对端, 分区) 水位。
   * `sentEvents` 为本轮实际发出的候选事件（用于把 ack 映射回分区/作者）；
   * 只推进已被 ack 的事件，且只在本轮 allow 之内（调用方已过滤）。
   */
  async markEventsSynced(
    peerDeviceId: string,
    eventIds: string[],
    sentEvents?: Event[],
  ): Promise<void> {
    await this.ensureSyncStateLoaded();
    let acked = this.syncedByPeer.get(peerDeviceId);
    if (!acked) {
      acked = new Set();
      this.syncedByPeer.set(peerDeviceId, acked);
    }
    for (const id of eventIds) {
      acked.add(id);
    }
    if (sentEvents && sentEvents.length > 0) {
      const ackedSet = new Set(eventIds);
      const watermarks = this.peerWatermarks.get(peerDeviceId) ?? {};
      for (const event of sentEvents) {
        if (!ackedSet.has(event.id)) continue;
        mergeClockInto(watermarks, normalizeNamespace(event.namespace), {
          [event.author]: event.vectorClock?.[event.author] ?? 0,
        });
      }
      this.peerWatermarks.set(peerDeviceId, watermarks);
    }
    await this.persistSyncState();
  }

  /**
   * 收到「快照已应用」确认后，才用该次快照的分区水位推进对端水位（F4）。
   * 这是快照覆盖分区推进对端水位的**唯一**路径，绝不发完就乐观推进。
   */
  private async confirmSnapshotWatermark(
    peerDeviceId: string,
    clocks: NamespaceClocks,
  ): Promise<void> {
    await this.ensureSyncStateLoaded();
    const watermarks = this.peerWatermarks.get(peerDeviceId) ?? {};
    for (const [ns, clock] of Object.entries(clocks)) {
      mergeClockInto(watermarks, ns, clock);
    }
    this.peerWatermarks.set(peerDeviceId, watermarks);
    await this.persistSyncState();
  }

  /**
   * 清空 per-(对端, 分区) 水位（省略对端 = 全部）并持久化（F3）。
   *
   * 当对端水位被污染时（例如历史 F1 的累积时钟上报），这是**被认可的修复
   * 路径**：只清水位、**不动 per-event ack 集合**——方向安全，最多让已确认
   * 事件冗余重发一次，绝不会漏发。
   */
  async resetPeerWatermarks(peerDeviceId?: string): Promise<void> {
    await this.ensureSyncStateLoaded();
    if (peerDeviceId === undefined) {
      this.peerWatermarks.clear();
    } else {
      this.peerWatermarks.delete(peerDeviceId);
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
    const record = parsed as {
      peers?: unknown;
      peerWatermarks?: unknown;
      localSnapshotClocks?: unknown;
    } | null;
    const peers = record?.peers;
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
    // v2 增补：per-(对端, 分区) 水位 + 快照推进的本机分区水位
    if (record?.peerWatermarks !== undefined) {
      const watermarks = record.peerWatermarks;
      if (watermarks === null || typeof watermarks !== 'object' || Array.isArray(watermarks)) {
        throw new StorageError(
          `同步状态文件 peerWatermarks 形状非法：${filePath}`,
          ErrorCodes.STORAGE_READ_FAILED,
        );
      }
      for (const [peerId, clocks] of Object.entries(watermarks)) {
        this.peerWatermarks.set(peerId, parseNamespaceClocks(clocks, `peerWatermarks.${peerId}`, filePath));
      }
    }
    if (record?.localSnapshotClocks !== undefined) {
      this.localSnapshotClocks = parseNamespaceClocks(
        record.localSnapshotClocks,
        'localSnapshotClocks',
        filePath,
      );
    }
  }

  /** 原子落盘：tmp + rename，避免半写状态文件（v2：ack 集合 + 分区水位） */
  private async persistSyncState(): Promise<void> {
    if (!this.syncStatePath) return;
    await this.ensureSyncStateLoaded(); // 避免部分加载时覆盖其他对端的状态
    const filePath = this.syncStatePath;
    const peers: Record<string, string[]> = {};
    for (const [peerId, ids] of this.syncedByPeer) {
      peers[peerId] = [...ids].sort(); // 排序保证输出确定，便于审计与测试
    }
    const peerWatermarks: Record<string, NamespaceClocks> = {};
    for (const [peerId, clocks] of this.peerWatermarks) {
      peerWatermarks[peerId] = sortNamespaceClocks(clocks);
    }
    const tmpPath = `${filePath}.tmp`;
    try {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(
        tmpPath,
        JSON.stringify({
          version: 2,
          peers,
          peerWatermarks,
          localSnapshotClocks: sortNamespaceClocks(this.localSnapshotClocks),
        }),
        'utf-8',
      );
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

          // 1. hello：本机订阅声明（subscribeAll + namespaces）+ 分区水位
          await transport.send({
            type: 'sync-hello',
            direction,
            ...(await this.localHello()),
          });
          const hello = await nextSyncMessage(iterator, 'sync-hello', timeout);
          assertValidHello(hello);
          const reportedAhead = await this.recordPeerHello(peer.deviceId, hello);

          // 2. 我方 offer：按 per-(对端, 分区) 水位计算缺失集；pull 模式只收不发。
          //    先按「对端授权 ∩ 对端订阅 ∩ 本机订阅」裁剪（T2 供给端强制），
          //    对端分区水位为空且裁剪后缺失集达阈值时改发物化快照（G4；同样裁剪）
          const allow = await this.resolveOutgoingAllowList(peer, hello);
          let outgoing = direction === 'pull'
            ? []
            : this.filterEventsForAllow(await this.missingEventsForPeer(peer.deviceId), allow);
          const snapshotThreshold = options.snapshotThreshold ?? this.snapshotThreshold;
          let snapshot: SyncSnapshot | undefined;
          // R2：快照**只发给自报分区水位为空的对端**——`applySnapshot` 是物化
          // 状态覆盖（虽有 R3 回退保护，仍非完整冲突合并），对已有数据的对端
          // 发快照会覆盖其更新。放宽此条件前必须先让快照应用冲突感知。
          if (
            direction !== 'pull' &&
            snapshotThreshold !== undefined &&
            Object.keys(hello.namespaceClocks).length === 0 &&
            outgoing.length >= snapshotThreshold
          ) {
            snapshot = await this.buildSnapshot(allow);
            // 快照只带物化实体；策略事件（__policy__）仍需随本会话发出，供对端
            // bootstrap 授权视图（否则空对端拿不到策略）。
            outgoing = outgoing.filter((event) => normalizeNamespace(event.namespace) === POLICY_NAMESPACE);
          }
          await transport.send(
            snapshot
              ? { type: 'sync-offer', events: outgoing, snapshot }
              : { type: 'sync-offer', events: outgoing },
          );
          const ack = await nextSyncMessage(iterator, 'sync-ack', timeout);
          assertValidAck(ack);
          await this.markEventsSynced(peer.deviceId, ack.appliedEventIds, outgoing);
          // F4：**只在**对端确认已应用快照后，才按快照分区水位推进对端水位。
          // 发完就乐观推进会在此前把对端标记为「已有」，一旦应用失败即永久丢失。
          if (snapshot && ack.snapshotApplied === true) {
            await this.confirmSnapshotWatermark(peer.deviceId, snapshot.namespaceClocks);
          }

          // 3. 对端 offer：快照直接采纳（已认证对端）；事件走验签 + 幂等入库 + 冲突应用
          const offer = await nextSyncMessage(iterator, 'sync-offer', timeout);
          let snapshotApplied = 0;
          let applied: AppliedOffer;
          if (offer.snapshot) {
            assertValidSnapshot(offer.snapshot);
            // F-1：快照随行的策略事件先入库（刷新授权/吊销视图），再做物化采纳；
            // 否则接收方拿不到吊销记录，快照的按作者过滤无从谈起。
            applied = offer.events.length > 0
              ? await this.applyOffer(offer.events, peer)
              : { ackedIds: [], received: 0, duplicates: 0, conflicts: [] };
            snapshotApplied = await this.applySnapshot(offer.snapshot);
          } else {
            applied = await this.applyOffer(offer.events, peer);
          }
          await transport.send({
            type: 'sync-ack',
            appliedEventIds: applied.ackedIds,
            ...(offer.snapshot ? { snapshotApplied: true } : {}),
          });

          // 4. 交换最终时钟，收尾
          const finalVectorClock = this.eventLog.getClock().toJSON();
          await transport.send({ type: 'sync-done', finalVectorClock });
          await nextSyncMessage(iterator, 'sync-done', timeout);

          const result = this.buildResult(peer, direction, outgoing.length, applied, allow, reportedAhead);
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
      assertValidHello(hello);
      const reportedAhead = await this.recordPeerHello(peer.deviceId, hello);
      const direction: SyncDirection = hello.direction ?? 'bidirectional';
      await transport.send({
        type: 'sync-hello',
        ...(await this.localHello()),
      });

      const offer = await nextSyncMessage(iterator, 'sync-offer', timeout);
      let snapshotApplied = 0;
      let applied: AppliedOffer;
      if (offer.snapshot) {
        // 初始快照：已认证对端直接采纳物化状态并推进时钟（G4）。
        // F-1：先应用随行的策略事件（刷新吊销视图），再采纳快照并按作者过滤。
        assertValidSnapshot(offer.snapshot);
        applied = offer.events.length > 0
          ? await this.applyOffer(offer.events, peer)
          : { ackedIds: [], received: 0, duplicates: 0, conflicts: [] };
        snapshotApplied = await this.applySnapshot(offer.snapshot);
      } else {
        applied = await this.applyOffer(offer.events, peer);
      }
      // 确认「快照已应用」，供发送方（仅在收到该确认时）推进对端水位（F4）
      await transport.send({
        type: 'sync-ack',
        appliedEventIds: applied.ackedIds,
        ...(offer.snapshot ? { snapshotApplied: true } : {}),
      });

      // push 模式只对端发；否则按「对端授权 ∩ 对端订阅 ∩ 本机订阅」裁剪后回供（T2）。
      // 排除本会话刚从对端收到的事件：对端既然发来就已持有，回弹纯属冗余
      // （这是「已观测传输」的事实，不是对端自报，与 R1 的水位不变量不冲突）。
      const allow = await this.resolveOutgoingAllowList(peer, hello);
      const justReceived = new Set(applied.ackedIds);
      const outgoing = direction === 'push'
        ? []
        : this.filterEventsForAllow(await this.missingEventsForPeer(peer.deviceId), allow)
            .filter((event) => !justReceived.has(event.id));
      await transport.send({ type: 'sync-offer', events: outgoing });
      const ack = await nextSyncMessage(iterator, 'sync-ack', timeout);
      assertValidAck(ack);
      await this.markEventsSynced(peer.deviceId, ack.appliedEventIds, outgoing);

      await nextSyncMessage(iterator, 'sync-done', timeout);
      const finalVectorClock = this.eventLog.getClock().toJSON();
      await transport.send({ type: 'sync-done', finalVectorClock });

      const result = this.buildResult(peer, direction, outgoing.length, applied, allow, reportedAhead);
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
      // hello 到达前保守取「不订阅任何分区」，避免过早推送；首次会话即回填
      const entry: OnlinePeer = { peerId: session.peerId, peer, initiate, subscribeAll: false, namespaces: [] };
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

  /**
   * 记录对端 hello：订阅声明回填在线登记（供 push-on-write），并计算诊断信号。
   *
   * **不变量：`peerWatermarks` 只由我们掌握的两个事实推进——对端 ack
   * （`markEventsSynced`）与已确认快照（`confirmSnapshotWatermark`）。**
   * 对端 hello 的**自报水位绝不抬升**本机记录：自报是对方单方面的声明，
   * 抬升它会让本机误判「对端已有」而永久静默不发（F1 的对端版本）。
   * 自报同时仍用于：
   *   ① 快照触发（`applySnapshot` 非冲突感知，快照只发给自报为空的对端）；
   *   ② 诊断——自报高于本机记录时返回差额，供 `sync-completed.reportedAhead`
   *      暴露「对端有问题」。自报低于/等于本机记录时维持现状（不抬高也不下调）。
   */
  private async recordPeerHello(
    peerDeviceId: string,
    hello: Extract<SyncMessage, { type: 'sync-hello' }>,
  ): Promise<NamespaceClocks> {
    const namespaces = normalizeNamespaceList(hello.namespaces);
    for (const entry of this.onlinePeers.values()) {
      if (entry.peer.deviceId === peerDeviceId) {
        entry.subscribeAll = hello.subscribeAll;
        entry.namespaces = namespaces;
      }
    }
    await this.ensureSyncStateLoaded();
    const watermarks = this.peerWatermarks.get(peerDeviceId) ?? {};
    const ahead: NamespaceClocks = {};
    for (const [ns, clock] of Object.entries(hello.namespaceClocks)) {
      for (const [author, reported] of Object.entries(clock)) {
        const known = watermarks[ns]?.[author] ?? 0;
        if (reported > known) {
          (ahead[ns] ??= {})[author] = reported - known;
        }
      }
    }
    return ahead;
  }

  /** 本机 hello：订阅声明（subscribeAll + namespaces）+ 分区水位 */
  private async localHello(): Promise<{
    subscribeAll: boolean;
    namespaces: string[];
    namespaceClocks: NamespaceClocks;
  }> {
    return {
      // 本机订阅未配置/空 = 参与全部（保留语义）；否则为显式清单
      subscribeAll: this.subscriptionNamespaces.length === 0,
      namespaces: [...this.subscriptionNamespaces],
      namespaceClocks: await this.buildLocalNamespaceClocks(),
    };
  }

  /**
   * 本机分区水位 = 事件日志按分区推导值 ∪ 快照推进值（后者无对应事件）。
   *
   * **只取作者自身计数**：`event.vectorClock` 是累积时钟，会带上其他作者
   * （乃至其他分区）的计数；若整体并入，本机可能谎称「已有 C 在 ns1 的前 n 条」，
   * 而实际只有 C 在其他分区的事件。对端把该自报并入水位并持久化后，便会
   * 永久不再发送 → 静默丢失。与 ack 推进水位处保持同一纪律。
   */
  private async buildLocalNamespaceClocks(): Promise<NamespaceClocks> {
    const derived: NamespaceClocks = {};
    for (const event of await this.eventLog.listEvents()) {
      mergeClockInto(derived, normalizeNamespace(event.namespace), {
        [event.author]: event.vectorClock?.[event.author] ?? 0,
      });
    }
    return mergeNamespaceClocks(derived, this.localSnapshotClocks);
  }

  /**
   * 供给端裁剪链（默认拒绝）：
   * 对端授权（必填，`[]` = 拒绝）∩ 对端订阅声明 ∩ 本机订阅声明。
   * 授权槽永不为 null，因此结果一定是具体白名单——未授权对端解析为 `[]`。
   */
  private async resolveOutgoingAllowList(
    peer: SyncPeer,
    hello: Extract<SyncMessage, { type: 'sync-hello' }>,
  ): Promise<string[]> {
    const peerAuthorized = await this.namespacePolicy.getAuthorizedNamespaces(peer.deviceId);
    return (
      intersectNamespaceAllowLists(
        peerAuthorized,
        declarationToAllowList(hello.subscribeAll, hello.namespaces),
        declarationToAllowList(this.subscriptionNamespaces.length === 0, this.subscriptionNamespaces),
      ) ?? []
    );
  }

  /**
   * 供给端分区裁剪。，**保留策略命名空间（`__policy__`）始终放行**：授权/吊销
   * 记录是签发者签名的元数据，不是用户数据；让已认证设备总能读到它，才能解开
   * 「默认拒绝 + 策略在图上」的 bootstrap 鸡生蛋（写入/生效仍只认签发者）。
   */
  private filterEventsForAllow(events: Event[], allow: string[]): Event[] {
    return events.filter(
      (event) =>
        normalizeNamespace(event.namespace) === POLICY_NAMESPACE ||
        isNamespaceAllowed(event.namespace, allow),
    );
  }

  /**
   * 按 per-(对端, 分区) 水位计算缺失集：只在同一分区内比较该作者的计数。
   * **不用**对端累积全局时钟——那会把「因未授权被跳过的分区」误判为已同步，
   * 导致扩权后也无法回补。
   */
  private async missingEventsForPeer(peerDeviceId: string): Promise<Event[]> {
    const watermarks = this.peerWatermarks.get(peerDeviceId) ?? {};
    const all = await this.eventLog.listEvents();
    const missing = all.filter((event) => {
      const remoteHas = namespaceClockOf(watermarks, normalizeNamespace(event.namespace))[event.author] ?? 0;
      return (event.vectorClock?.[event.author] ?? 0) > remoteHas;
    });
    // 因果序：作者计数器为主键，时间戳与 ID 兜底，保证确定性
    return missing.sort((a, b) => {
      const counterDiff = (a.vectorClock?.[a.author] ?? 0) - (b.vectorClock?.[b.author] ?? 0);
      if (counterDiff !== 0) return counterDiff;
      if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }

  // ---------- 内部 ----------

  /**
   * 应用管线：已持有则去重（免验签）→ 验签 → 幂等入库 → 冲突感知应用；
   * 验签失败即中止会话。去重优先是安全的：ID 为内容寻址，同 ID 即同内容。
   */
  private async applyOffer(events: Event[], peer: SyncPeer): Promise<AppliedOffer> {
    const ackedIds: string[] = [];
    const appliedIds: string[] = [];
    const appliedNamespaces = new Set<string>();
    const conflicts: SyncConflict[] = [];
    let received = 0;
    let duplicates = 0;

    // E · 入站吊销：默认拒绝只挡「我们发给它」，挡不住被吊销设备把事件推进我们
    // 的图。这里按当前吊销集合隔离其**署名的**事件（不验签就谈不上凭据，故放在
    // 验签之后判定；本批只取一次吊销快照）。
    const revoked = this.namespacePolicy.getRevokedDevices
      ? await this.namespacePolicy.getRevokedDevices()
      : undefined;

    for (const event of events) {
      // 已持有 = 幂等重复：内容寻址 ID 已绑定内容，收到同 ID 即同一事件，
      // 无需再次验签。R1 起对端不再据自报抑制发送，会把本机已有事件（含回弹
      // 的本机事件）作为反熵冗余重发；此处去重即可，绝不能因此中止会话。
      if (await this.eventLog.getEvent(event.id)) {
        await this.eventLog.appendRemote(event); // 仍合并/推进时钟
        ackedIds.push(event.id);
        duplicates += 1;
        continue;
      }

      const valid = await this.verifyEventTrust(event, peer);
      if (!valid) {
        throw new SyncError(`Event signature verification failed: ${event.id}`, ErrorCodes.SYNC_INVALID_EVENT);
      }

      // 被吊销设备署名的事件：不应用、不入库、不 ack（隔离；发送方重试亦无效）
      if (revoked?.has(event.author)) {
        continue;
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
    // 中继/多跳：与 `GraphNamespacePolicy` 的签发者判定共用同一套证书链校验
    return verifyIssuedByUser(event, this.userMasterPublicKey);
  }

  /**
   * 构造物化快照（G4）：按 allow list 裁剪节点/边（未授权分区不进快照，
   * 堵住「空水位走快照通道绕过授权」的洞），并按分区给出水位。
   *
   * 分区水位只统计**被允许分区**的事件，且**每个作者只取自身计数**（不是
   * 累积时钟），绝不用本机全量时钟——否则对端会把未收到的分区/作者记为
   * 已同步，之后即便扩权也永久缺失。
   */
  private async buildSnapshot(allow: string[]): Promise<SyncSnapshot> {
    const nodes = (await this.storage.listNodes()).filter((node) =>
      isNamespaceAllowed(node.namespace, allow),
    );
    const edges = (await this.storage.listEdges()).filter((edge) =>
      isNamespaceAllowed(edge.namespace, allow),
    );
    const namespaceClocks: NamespaceClocks = {};
    for (const event of await this.eventLog.listEvents()) {
      if (!isNamespaceAllowed(event.namespace, allow)) continue;
      mergeClockInto(namespaceClocks, normalizeNamespace(event.namespace), {
        [event.author]: event.vectorClock?.[event.author] ?? 0,
      });
    }
    return { nodes, edges, namespaceClocks, namespaces: [...allow] };
  }

  /**
   * 采纳快照：物化节点/边写入存储（**回退保护的保守 upsert**），分区水位合并
   * 推进（供本机 hello 上报，使发送方不再重发已覆盖分区），返回**实际写入**的
   * 实体数。
   *
   * 前提（R2）：快照**只发给自报分区水位为空的对端**（触发条件见
   * `syncWithDevice`）。放宽该前提之前**必须先**让快照应用具备完整的冲突/
   * 合并语义；否则快照的「物化状态」会覆盖对端更新的事实。
   * 防护（R3）：即使有上述前提，这里也**不做无条件 upsert**——仅当本地缺失、
   * 或快照版本时钟**严格更新**时才写入；并发（互不因果）时保留本地版本。
   * 这是回退保护，**不是**完整冲突解决：它宁可少应用，也绝不回退。
   *
   * 快照仅来自已认证对端；不做逐事件验签（fast-start 取舍，见 protocol.ts）。
   */
  private async applySnapshot(snapshot: SyncSnapshot): Promise<number> {
    // E/F-1：按当前吊销集合过滤实体（createdBy/updatedBy 命中即拒绝）。
    // 快照是旁路——直接推送的事件已在 applyOffer 被隔离，这里必须补上同样的边界。
    const revoked = this.namespacePolicy.getRevokedDevices
      ? await this.namespacePolicy.getRevokedDevices()
      : undefined;
    let applied = 0;
    for (const node of snapshot.nodes) {
      if (isEntityAuthoredByRevoked(node, revoked)) continue;
      if (!shouldApplySnapshotEntity(await this.storage.getNode(node.id), node)) continue;
      await this.storage.putNode(node);
      applied += 1;
    }
    for (const edge of snapshot.edges) {
      if (isEntityAuthoredByRevoked(edge, revoked)) continue;
      if (!shouldApplySnapshotEntity(await this.storage.getEdge(edge.id), edge)) continue;
      await this.storage.putEdge(edge);
      applied += 1;
    }
    const clocks = snapshot.namespaceClocks ?? {};
    for (const [ns, clock] of Object.entries(clocks)) {
      mergeClockInto(this.localSnapshotClocks, ns, clock);
    }
    // 全局时钟合流：sync-done 与既有「双端时钟一致」断言依赖
    const global = this.eventLog.getClock();
    for (const clock of Object.values(clocks)) {
      global.merge(VectorClock.fromJSON(clock));
    }
    await this.persistSyncState();
    return applied;
  }

  private buildResult(
    peer: SyncPeer,
    direction: SyncDirection,
    sent: number,
    applied: AppliedOffer,
    allow: string[],
    reportedAhead?: NamespaceClocks,
  ): SyncResult {
    const result: SyncResult = {
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
      // 拒绝不静默：allow 解析为 [] 时明确指出「未授权任何分区」
      denied: allow.length === 0,
    };
    // 诊断信号（R1）：对端自报高于本机记录的部分；仅诊断，不影响发送集合
    if (reportedAhead && Object.keys(reportedAhead).length > 0) {
      result.reportedAhead = reportedAhead;
    }
    return result;
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
