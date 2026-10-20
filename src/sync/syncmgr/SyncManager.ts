// SyncManager 同步管理器（phase-3-plan 3.2/3.4 重写，对齐 spec-004）
//
// 职责：
// - 在 SecureChannel 上按 protocol.ts 的固定帧序完成一次同步会话
//   （syncWithDevice 发起方 / acceptSync 响应方，双角色共用一套应用管线）；
// - 应用管线：逐条验签（EventLog.verifyEvent）→ 事件日志幂等入库
//   （appendRemote）→ 冲突感知应用（applyRemoteEvent），冲突随结果与
//   'conflict' 事件上报；
// - 供给姿态：**订阅即读**。供给 = 信任边界 ∩ 本机订阅 ∩ 对端订阅；
//   没有「对端授权」项。裁剪链同时作用于 offer 与快照。
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
import { applyRemoteEvent, isApplyableEventType, type SyncConflict } from '../apply.js';
import {
  EmptySubscriptionPolicy,
  type NamespaceSubscriptionPolicy,
} from '../namespacePolicy.js';
import { POLICY_NAMESPACE } from '../grantPolicy.js';
import { verifyIssuedByUser } from '../trust.js';
import { PeerFrames } from './PeerFrames.js';
import {
  normalizeNamespace,
  normalizeNamespaceList,
  declarationToAllowList,
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
  parseStateFingerprints,
  type SyncDirection,
  type SyncMessage,
  type SyncSnapshot,
  type SyncStateFingerprints,
  type SyncTransport,
} from '../protocol.js';
import { compareStateFingerprints, type SyncFingerprintEvent } from '../convergence.js';
import type { P2PNode, PeerId, Connection } from '../../p2p/P2PNetwork.js';

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
   * 本会话供给集合为空（本机与对端没有任何订阅交集）。拒绝不再静默，
   * 订阅方据此把「没数据」与「没有订阅交集」区分开。
   */
  noSubscriptionOverlap?: boolean;
  /**
   * 本会话中「对端 hello 自称订阅、但它不是该域订阅者」而被**显式拒绝**的分区。
   * 非空即表示拒绝不再静默（订阅声明不一致的可观测信号）。无此类分区时 undefined。
   */
  subscriptionRejected?: string[];
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
  /**
   * P3（S1）：本会话我方 offer（`sentEvents`）中被对端 ack 的事件数。
   * `sentEvents > 0 ∧ ackedOutgoing === 0` 即「发出但未被确认」的一手证据。
   */
  ackedOutgoing?: number;
  /**
   * P3（S3）：本会话 hello 触发的水位**向下修正**次数（R2；每次修正一个
   * 作者/分区记 1）。频繁出现意味着对端反复「丢失状态」——值得解释而非静默。
   */
  watermarkDownCorrections?: number;
  /**
   * P3（S9）：本会话收到的、本端无法物化的未知事件类型数（日志有、图无）。
   */
  unknownEventTypes?: number;
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
   * 订阅策略（图上 `namespace_subscription` 记录）。缺省 = 没有记录：
   * 对端订阅完全回退到 hello 会话声明。
   */
  subscriptionPolicy?: NamespaceSubscriptionPolicy;
  /** 本地写入后向订阅对端即时推送（默认关闭；常驻入口由门面/MCP 打开） */
  pushOnWrite?: boolean;
  /** push-on-write 节流窗口（ms，默认 50）：连续写入合并为一次推送/nudge */
  pushOnWriteThrottleMs?: number;
  /**
   * 周期 anti-entropy（C）：每隔 intervalMs（带 jitter）对在线且已授权、且确有
   * pending 的对端兜底同步一次。**core 默认关闭**（不藏定时器）；常驻入口默认开启。
   */
  antiEntropy?: AntiEntropyConfig;
  /**
   * P3（收敛健康度）：会话尾状态指纹（`sync-done.stateFingerprints`，C3 A 类
   * 可选字段）。**由门面在开关启用时注入**；未注入 = 与今日线协议行为逐字节一致。
   * 指纹只作诊断（收到即比对 + emit `sync-fingerprint`），绝不参与授权/水位判定；
   * 计算失败不影响会话（丢弃发声：`sync-fingerprint{result:'local-error'}`）。
   */
  fingerprints?: { report: () => Promise<SyncStateFingerprints> };
}

/** 周期 anti-entropy 配置（core 默认 disabled） */
export interface AntiEntropyConfig {
  enabled?: boolean;
  /** 基础间隔（ms，默认 10 分钟；常驻入口建议 5–15 分钟） */
  intervalMs?: number;
  /** 抖动比例（默认 0.2 = ±20%），防多端齐步走 */
  jitterRatio?: number;
}

const DEFAULT_SYNC_TIMEOUT = 30_000;
const DEFAULT_PUSH_ON_WRITE_THROTTLE_MS = 50;
const DEFAULT_ANTI_ENTROPY_INTERVAL_MS = 10 * 60_000;
const DEFAULT_ANTI_ENTROPY_JITTER_RATIO = 0.2;
/** anti-entropy 连续失败退避上限 */
const ANTI_ENTROPY_MAX_BACKOFF_MS = 60 * 60_000;

/**
 * 计算 anti-entropy 的下次延迟：`intervalMs ± intervalMs*jitterRatio`（落界 ≥ 0）。
 * 纯函数，便于测试 jitter 界内。
 */
export function computeAntiEntropyDelay(
  intervalMs: number,
  jitterRatio: number,
  random: () => number = Math.random,
): number {
  const jitter = intervalMs * jitterRatio;
  return Math.max(0, intervalMs + (random() * 2 - 1) * jitter);
}

/** 已认证在线对端（push-on-write / nudge / anti-entropy 的定向目标） */
interface OnlinePeer {
  peerId: PeerId;
  peer: SyncPeer;
  /**
   * N1/N2：登记时的连接（来自握手会话）。同设备新连接替换旧连接时，
   * 旧连接的关闭事件据此比对代际，不误删新登记。
   */
  connection?: Connection;
  /** 对端 hello 的订阅声明：true = 全部分区；false = 只订阅 namespaces */
  subscribeAll: boolean;
  /** 对端 hello 中声明的显式订阅清单（subscribeAll=true 时忽略） */
  namespaces: string[];
  /** 本机在该对端会话中的角色（设备 ID 字典序小者发起） */
  initiate: boolean;
  /** 常驻形态的传输（非常驻一次性会话为 undefined） */
  transport?: SyncTransport;
  /** 常驻形态的帧路由（唯一读取者） */
  frames?: PeerFrames;
  /** 发起方常驻循环：待处理触发（本地写入 / 收到 nudge），布尔合并 = per-peer 在途上限 1 */
  triggerPending?: boolean;
  /** 发起方常驻循环：等待中的触发唤醒器 */
  triggerResolve?: () => void;
}

/** 一次 offer 应用的结果（含 ack 集合与对端事件命名空间） */
interface AppliedOffer {
  ackedIds: string[];
  received: number;
  duplicates: number;
  conflicts: SyncConflict[];
  /** P3（S9）：未知事件类型计数（日志有、图无） */
  unknownEventTypes?: number;
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
  /** 本机订阅（运行期可热更新；空 = 参与全部） */
  private subscriptionNamespaces: string[];
  /** 订阅策略：缺省 = 没有图上订阅记录（回退 hello） */
  private readonly subscriptionPolicy: NamespaceSubscriptionPolicy;
  /** 最近一次解析中「对端自称订阅但它不是订阅者」的分区（显式拒绝，供 SyncResult 暴露） */
  private lastSubscriptionRejected: string[] = [];
  /**
   * 2c：本机已**显式声明重置**的分区（由门面依据图外标记注入）。这些分区即使为空，
   * 也会以**空时钟**随 hello 上报，触发对端向下修正并从头重发——这是**显式**降水位信号
   * （普通空订阅不上报，避免无谓的向下修正）。
   */
  private readonly resetNamespaces = new Set<string>();
  private readonly pushOnWrite: boolean;
  private readonly pushOnWriteThrottleMs: number;
  private readonly antiEntropy: { enabled: boolean; intervalMs: number; jitterRatio: number };
  private antiEntropyTimer: ReturnType<typeof setTimeout> | null = null;
  /** per-peer anti-entropy 退避状态（连续失败指数退避，成功复位） */
  private readonly antiEntropyBackoff = new Map<string, { failures: number; nextAttemptAt: number }>();
  /** P3：会话尾状态指纹提供者（门面注入；未注入 = 不携带、不比对） */
  private readonly fingerprints: { report: () => Promise<SyncStateFingerprints> } | null;

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

  /**
   * N4：会话串行化按**连接**粒度（同一信道上会话串行，帧序不交错；
   * 不同连接互不饿死——旧实现为每 SyncManager 全局串行，单个"无限等待 hello"
   * 的常驻响应方会话会饿死同管理器内其它连接/对端的会话）。
   * key = 连接对象（或 `'global'`：无法获知连接时的退化为全局队列）。
   */
  private readonly sessionQueues = new Map<object | string, Promise<unknown>>();
  private syncing = false;
  private lastSyncAt: number | null = null;
  private lastResult: SyncResult | null = null;

  /**
   * 「丢弃必须发声」（N3）：三类静默点各有计数，且每次丢弃 emit
   * `sync-frames-dropped`。供测试判别性断言与现场诊断：
   * - `nudgeDroppedStaleEntry`：nudge 落在已被替换的旧 entry（连接键控错位的直接信号）；
   * - `staleEntrySignals`：其余因 entry 已被替换而忽略的滞后信号（退役旧连接的关闭清理等）；
   * - `identityFailures`：已认证会话缺权威身份（证书 deviceId），对端不登记（禁静默兜底）。
   */
  private readonly dropCounters = {
    nudgeDroppedStaleEntry: 0,
    staleEntrySignals: 0,
    identityFailures: 0,
  };

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
    this.subscriptionPolicy = options.subscriptionPolicy ?? new EmptySubscriptionPolicy();
    this.pushOnWrite = options.pushOnWrite ?? false;
    this.pushOnWriteThrottleMs = options.pushOnWriteThrottleMs ?? DEFAULT_PUSH_ON_WRITE_THROTTLE_MS;
    this.antiEntropy = {
      enabled: options.antiEntropy?.enabled ?? false,
      intervalMs: options.antiEntropy?.intervalMs ?? DEFAULT_ANTI_ENTROPY_INTERVAL_MS,
      jitterRatio: options.antiEntropy?.jitterRatio ?? DEFAULT_ANTI_ENTROPY_JITTER_RATIO,
    };
    this.fingerprints = options.fingerprints ?? null;
    if (this.pushOnWrite) {
      // 本地写入即触发定向推送；远端 appendRemote 不触发，避免回弹风暴
      this.eventLog.on('event-appended', this.handleLocalAppend);
    }
    if (this.antiEntropy.enabled) {
      this.scheduleAntiEntropy();
    }
  }

  /**
   * 运行期更新本机订阅（热生效）。空数组 = 参与全部。
   *
   * 只改本进程的供给判定；持久化由门面/守护负责（写 `namespace_subscription`
   * 记录并更新 config.json 的 `sync.namespaces`）。
   */
  setSubscriptionNamespaces(namespaces: readonly string[] | undefined): void {
    this.subscriptionNamespaces = normalizeNamespaceList(namespaces ?? []);
  }

  getSubscriptionNamespaces(): string[] {
    return [...this.subscriptionNamespaces];
  }

  /**
   * 本地写入信号：对每个在线对端调用 `maybeNotify`，由 `peerSubscribes`
   * 统一判定「它是否订阅这个域」。**`__policy__` 写入必须能 nudge 到所有在线
   * 对端**（否则订阅记录要等反熵才到达）。
   */
  private readonly handleLocalAppend = (event: Event): void => {
    const namespace = normalizeNamespace(event.namespace);
    for (const entry of this.onlinePeers.values()) {
      if (!entry.transport) continue; // 仅常驻连接
      void this.maybeNotify(entry, namespace);
    }
  };

  /**
   * 对端是否订阅该域：
   * - 该域有任意被采纳订阅记录 → 记录权威，只看 subscribers；
   * - 无记录 → 回退 hello 会话声明。
   */
  private async peerSubscribes(entry: OnlinePeer, namespace: string): Promise<boolean> {
    if (namespace === POLICY_NAMESPACE) return true;
    const view = await this.subscriptionPolicy.getNamespaceSubscriptions(namespace);
    if (view.active) {
      if (view.subscribers.includes(entry.peer.deviceId)) return true;
      // 对端自己有过记录（含 active=false）→ 记录权威；没有记录 → 允许 hello bootstrap。
      if ((view.recorded ?? view.subscribers).includes(entry.peer.deviceId)) return false;
    }
    return entry.subscribeAll || entry.namespaces.includes(namespace);
  }

  /** 确有订阅 + pending 才通知（避免无意义会话 / nudge） */
  private async maybeNotify(entry: OnlinePeer, namespace: string): Promise<void> {
    if (!(await this.peerSubscribes(entry, namespace))) return;
    if (!(await this.hasPendingForPeer(entry.peer.deviceId, [namespace]))) return;
    this.scheduleSyncTrigger(entry);
  }

  /** 订阅动作后主动唤醒所有在线对端（不等反熵周期）。 */
  requestSubscriptionSync(): void {
    for (const entry of this.onlinePeers.values()) {
      if (!entry.transport) continue;
      this.scheduleSyncTrigger(entry);
    }
  }

  /** 节流合并触发（50ms）；同一对端同一时刻只有一个计时器 = per-peer 在途上限 1 */
  private scheduleSyncTrigger(entry: OnlinePeer): void {
    const key = entry.peerId.id;
    if (this.pushTimers.has(key)) return; // 节流窗口内：合并
    const timer = setTimeout(() => {
      this.pushTimers.delete(key);
      this.deliverTrigger(entry);
    }, this.pushOnWriteThrottleMs);
    (timer as { unref?: () => void }).unref?.();
    this.pushTimers.set(key, timer);
  }

  private deliverTrigger(entry: OnlinePeer): void {
    if (this.onlinePeers.get(entry.peerId.id) !== entry) {
      // 「丢弃必须发声」：entry 已被同设备新连接替换（旧连接的滞后触发）
      this.noteDropped('staleEntrySignals', { where: 'deliverTrigger', peerDeviceId: entry.peer.deviceId });
      return;
    }
    if (entry.initiate) {
      // 本机是发起方：唤醒常驻循环起一轮
      this.wakeInitiator(entry);
    } else {
      // 本机是响应方（不能自行发起）：在现有信道上发 nudge，请发起方开一轮
      void entry.transport?.send({ type: 'sync-nudge' }).catch((error) => {
        this.emit('sync-failed', { peerDeviceId: entry.peer.deviceId, error });
      });
    }
  }

  private wakeInitiator(entry: OnlinePeer): void {
    if (entry.triggerResolve) {
      const resolve = entry.triggerResolve;
      entry.triggerResolve = undefined;
      resolve();
    } else {
      entry.triggerPending = true;
    }
  }

  private waitInitiatorTrigger(entry: OnlinePeer): Promise<void> {
    if (entry.triggerPending) {
      entry.triggerPending = false;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      entry.triggerResolve = resolve;
    });
  }

  /** 收到对端 nudge（仅发起方角色响应）：节流后起一轮 */
  private onPeerNudge(entry: OnlinePeer): void {
    if (this.onlinePeers.get(entry.peerId.id) !== entry) {
      // 「丢弃必须发声」：nudge 落在被替换的旧 entry——连接键控错位的直接信号；
      // 静默丢弃会让「对端写入永不落图」失去任何可观测面（N3 红线）。
      this.noteDropped('nudgeDroppedStaleEntry', {
        where: 'onPeerNudge',
        peerDeviceId: entry.peer.deviceId,
        key: entry.peerId.id,
      });
      return;
    }
    if (!entry.initiate) return; // 只有发起方响应 nudge
    this.scheduleSyncTrigger(entry);
  }

  /**
   * 「丢弃必须发声」（N3）：递增分类计数并 emit `sync-frames-dropped`。
   * 计数口径见 `dropCounters` 文档。
   */
  private noteDropped(
    kind: keyof typeof this.dropCounters,
    detail: Record<string, unknown>,
  ): void {
    this.dropCounters[kind] += 1;
    this.emit('sync-frames-dropped', { kind, ...detail });
  }

  /** 丢弃计数快照（测试判别性断言 / 现场诊断） */
  getDropCounters(): {
    nudgeDroppedStaleEntry: number;
    staleEntrySignals: number;
    identityFailures: number;
  } {
    return { ...this.dropCounters };
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
   * 2b：分区**彻底清理后**丢弃本地同步状态——该分区的 per-(对端,分区) 水位、本机快照水位，
   * 以及被删除事件的 per-event ack。**只删本地状态，不产生任何事件**（无 tombstone）。
   */
  /** 2c：登记本机已显式重置的分区（随 hello 以空时钟上报，触发对端向下修正）。 */
  noteLocalReset(namespace: string): void {
    this.resetNamespaces.add(normalizeNamespace(namespace));
  }

  async forgetNamespace(namespace: string, eventIds: readonly string[] = []): Promise<void> {
    await this.ensureSyncStateLoaded();
    const ns = normalizeNamespace(namespace);
    if (eventIds.length > 0) {
      const ids = new Set(eventIds);
      for (const acked of this.syncedByPeer.values()) {
        for (const id of ids) acked.delete(id);
      }
    }
    for (const watermarks of this.peerWatermarks.values()) delete watermarks[ns];
    delete this.localSnapshotClocks[ns];
    await this.persistSyncState();
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

  /**
   * P3（收敛健康度）· 只读诊断：该对端的「积压两口径」。
   * - `pendingById`：per-event ack 集合视角（`getPendingEvents`）；
   * - `missingByWatermark`：per-(对端, 分区) 水路口径（缺失判定实际发送依据）。
   * 两者长期「有 id 欠账、无水位欠账」（`pendingById>0 ∧ missingByWatermark===0`）
   * 即 SP-28 类「记账矛盾」（可伴随既有快照路径的良性残留）；纯读取，无行为变化。
   */
  async getBacklogDiagnostics(peerDeviceId: string): Promise<{ pendingById: number; missingByWatermark: number }> {
    await this.ensureSyncStateLoaded();
    const [pending, missing] = await Promise.all([
      this.getPendingEvents(peerDeviceId),
      this.missingEventsForPeer(peerDeviceId),
    ]);
    return { pendingById: pending.length, missingByWatermark: missing.length };
  }

  /**
   * P3（A1 批准项）· 对指定在线对端**安排一轮同步触发**（限频由调用方执行）。
   * 复用既有触发路径（发起方唤醒 / 响应方 nudge），不越过任何安全判定：
   * 最多让会话多起一轮；对端 hello 自报会触发既有的 R2 向下修正（方向安全）。
   * 返回 false = 对端不在线/无常驻信道（未安排）。
   */
  requestSession(peerDeviceId: string): boolean {
    for (const entry of this.onlinePeers.values()) {
      if (entry.peer.deviceId !== peerDeviceId) continue;
      if (!entry.transport) continue; // 非实时形态无常驻循环
      this.deliverTrigger(entry); // 发起方：唤醒；响应方：发 nudge（既有路径）
      return true;
    }
    return false;
  }

  /** P3：当前已认证在线对端（收敛健康度的观察对象）。 */
  getOnlinePeers(): Array<{ deviceId: string; peerId: string }> {
    return [...this.onlinePeers.values()].map((entry) => ({
      deviceId: entry.peer.deviceId,
      peerId: entry.peerId.id,
    }));
  }

  // ---------- 同步会话 ----------

  /**
   * 发起方：向对端发起一次同步会话。
   * `existingIterator` 供**常驻循环**复用同一读取者（一个连接只允许一个消费者，
   * 见 `PeerFrames`）；一次性调用省略即可。
   */
  async syncWithDevice(
    transport: SyncTransport,
    peer: SyncPeer,
    options: SyncOptions = {},
    existingIterator?: AsyncIterator<SyncMessage>,
  ): Promise<SyncResult> {
    const direction = options.direction ?? 'bidirectional';
    const timeout = options.timeoutMs ?? this.syncTimeout;

    return this.enqueue(this.connectionQueueKey(undefined, transport), () =>
      this.runSession(peer, async () => {
        try {
          const iterator = existingIterator ?? transport.receive()[Symbol.asyncIterator]();

          // 1. hello：本机订阅声明（subscribeAll + namespaces）+ 分区水位
          await transport.send({
            type: 'sync-hello',
            direction,
            ...(await this.localHello()),
          });
          const hello = await nextSyncMessage(iterator, 'sync-hello', timeout);
          assertValidHello(hello);
          const helloOutcome = await this.recordPeerHello(peer.deviceId, hello);
          const reportedAhead = helloOutcome.ahead;

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
            // 「自报分区水位为空」= 每个分区时钟都没有作者计数（空对象亦算空；
            // 再订阅恢复会显式上报空的已订阅分区以触发向下修正）
            Object.values(hello.namespaceClocks).every((clock) => Object.keys(clock).length === 0) &&
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
          const ackedOutgoing = ack.appliedEventIds.length; // P3（S1）：发出→确认的一手计数
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

          // 4. 交换最终时钟，收尾（P3：附带会话尾状态指纹——双方各自算、会话尾交换；
          //    仅门面注入 fingerprints 时携带，旧端忽略未知字段）
          const finalVectorClock = this.eventLog.getClock().toJSON();
          const localFingerprints = await this.buildStateFingerprintEnvelope(peer);
          await transport.send({
            type: 'sync-done',
            finalVectorClock,
            ...localFingerprints,
          });
          const peerDone = await nextSyncMessage(iterator, 'sync-done', timeout);
          await this.notePeerFingerprints(peer, localFingerprints.stateFingerprints ?? null, peerDone.stateFingerprints, allow);

          const result = this.buildResult(peer, direction, outgoing.length, applied, allow, reportedAhead, {
            ackedOutgoing,
            watermarkDownCorrections: helloOutcome.downCorrections,
            unknownEventTypes: applied.unknownEventTypes,
          });
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
    return this.enqueue(this.connectionQueueKey(undefined, transport), () =>
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
      const helloOutcome = await this.recordPeerHello(peer.deviceId, hello);
      const reportedAhead = helloOutcome.ahead;
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
      const ackedOutgoing = ack.appliedEventIds.length; // P3（S1）：发出→确认的一手计数
      await this.markEventsSynced(peer.deviceId, ack.appliedEventIds, outgoing);

      // P3：先收对端 sync-done（含其状态指纹），再发本机收尾帧并附本机指纹；
      //     收到对端 done 后即可比对（双方此时均已完成本会话 apply）。
      const peerDone = await nextSyncMessage(iterator, 'sync-done', timeout);
      const finalVectorClock = this.eventLog.getClock().toJSON();
      const localFingerprints = await this.buildStateFingerprintEnvelope(peer);
      await this.notePeerFingerprints(peer, localFingerprints.stateFingerprints ?? null, peerDone.stateFingerprints, allow);
      await transport.send({
        type: 'sync-done',
        finalVectorClock,
        ...localFingerprints,
      });

      const result = this.buildResult(peer, direction, outgoing.length, applied, allow, reportedAhead, {
        ackedOutgoing,
        watermarkDownCorrections: helloOutcome.downCorrections,
        unknownEventTypes: applied.unknownEventTypes,
      });
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
   * 常驻响应方循环：等待对端发起的会话并处理（H/C 用）。
   * 单次会话失败不终止监听（除连接关闭外），保证后续推送仍可被接受。
   */
  private async runResponderLoop(
    transport: SyncTransport,
    entry: OnlinePeer,
    frames: PeerFrames,
  ): Promise<void> {
    const reader = frames.reader();
    for (;;) {
      if (this.onlinePeers.get(entry.peerId.id) !== entry || frames.isClosed) return;
      frames.setSessionActive(true);
      try {
        await this.enqueue(this.connectionQueueKey(entry.connection, transport), () =>
          this.runSession(entry.peer, () => this.runResponder(transport, entry.peer, reader, undefined)),
        );
      } catch (error) {
        if ((error as { code?: string }).code === ErrorCodes.SYNC_CONNECTION_FAILED) return;
        // 单次会话失败（验签/协议）：已尽力通知对端，继续等待下一次会话
      } finally {
        frames.setSessionActive(false);
      }
    }
  }

  /**
   * 常驻发起方循环（H 双向 push）：等待触发（连接时首次 / 本地写入 / 收到对端
   * nudge），每次触发用同一 reader 起一轮会话。触发布尔合并 = per-peer 在途上限 1。
   */
  private async runInitiatorLoop(
    transport: SyncTransport,
    entry: OnlinePeer,
    frames: PeerFrames,
  ): Promise<void> {
    const reader = frames.reader();
    for (;;) {
      if (this.onlinePeers.get(entry.peerId.id) !== entry || frames.isClosed) return;
      await this.waitInitiatorTrigger(entry);
      if (this.onlinePeers.get(entry.peerId.id) !== entry || frames.isClosed) return;
      frames.setSessionActive(true);
      try {
        await this.syncWithDevice(transport, entry.peer, { direction: 'bidirectional' }, reader);
      } catch (error) {
        if ((error as { code?: string }).code === ErrorCodes.SYNC_CONNECTION_FAILED) return;
        // 单次失败：继续等待下一次触发
      } finally {
        frames.setSessionActive(false);
      }
    }
  }

  // ---------- 自动同步（phase-3-plan 3.4） ----------

  /**
   * 挂到 P2PNode：握手认证完成后按配置进入同步。
   * 角色仲裁：设备 ID 字典序小者发起，大者响应（双端各触发一次，角色互补）。
   *
   * - 非实时形态（`pushOnWrite` 与 `antiEntropy` 均关）：保持旧的一次性行为；
   * - 实时形态：建立常驻帧路由与角色循环（发起方收 nudge / 本地触发；响应方收 hello）。
   */
  attachToNode(node: P2PNode): void {
    this.node = node;
    // 连接关闭：清理在线登记与触发计时器（N2：携带连接对象做代际比对）
    node.onConnectionClosed((peerId: PeerId, connection?: Connection) =>
      this.removeOnlinePeer(peerId, connection),
    );

    node.getHandshake().on('authenticated', (session: AuthSession) => {
      // 身份不变量 I1：唯一权威身份 = 握手证书 deviceId。
      // 取不到权威身份 = 显式失败 + 告警（禁静默兜底——兜底成 peerId.id 会让
      // 角色仲裁/信任判定/键控在不同形态间静默错位）。
      const certificate = session.certificate;
      if (!certificate?.deviceId) {
        this.noteDropped('identityFailures', { where: 'authenticated', key: session.peerId.id });
        const error = new SyncError(
          `Authenticated session without certificate identity: ${session.peerId.id}`,
          ErrorCodes.SYNC_INVALID_EVENT,
        );
        console.warn(`[sync] 已认证会话缺权威身份（证书 deviceId），对端不登记：${session.peerId.id}`);
        this.emit('sync-failed', { peerDeviceId: session.peerId.id, error });
        return;
      }
      const peerDeviceId = certificate.deviceId;
      if (this.peerWhitelist && !this.peerWhitelist.includes(peerDeviceId)) {
        return;
      }
      const publicKey = hexToBytes(certificate.devicePublicKey);
      const peer: SyncPeer = { deviceId: peerDeviceId, publicKey };
      const initiate = this.deviceId < peerDeviceId;
      // hello 到达前保守取「不订阅任何分区」，避免过早推送；首次会话即回填
      const entry: OnlinePeer = {
        peerId: session.peerId,
        peer,
        initiate,
        subscribeAll: false,
        namespaces: [],
        ...(session.connection ? { connection: session.connection } : {}),
      };
      this.onlinePeers.set(session.peerId.id, entry);

      const realtime = this.pushOnWrite || this.antiEntropy.enabled;
      if (!this.autoSync && !realtime) return; // 旧行为：无动作

      void (async () => {
        try {
          // N1/N2：按「连接代际」取信道——同设备新连接认证后信道按归属替换，
          // 这里绝不会命中旧连接的信道（旧信道随旧连接关闭自然收束）。
          const channel = await node.getChannel(session.peerId, {
            ...(session.connection ? { connection: session.connection } : {}),
          });
          if (!channel) {
            throw new SyncError(
              `Secure channel to ${peer.deviceId} not ready`,
              ErrorCodes.SYNC_CONNECTION_FAILED,
            );
          }
          const transport = new SecureChannelSyncTransport(channel);

          if (!realtime) {
            // 非实时：一次性会话（发起方主动 / 响应方接受）
            if (initiate) {
              await this.syncWithDevice(transport, peer, { direction: 'bidirectional' });
            } else {
              await this.acceptSync(transport, peer);
            }
            return;
          }

          const frames = new PeerFrames(transport.receive()[Symbol.asyncIterator](), {
            onNudge: () => this.onPeerNudge(entry),
            onInvalidNudge: (error) => this.emit('sync-failed', { peerDeviceId, error }),
            onClosed: () => entry.triggerResolve?.(),
          });
          entry.transport = transport;
          entry.frames = frames;

          if (initiate) {
            if (this.autoSync) this.wakeInitiator(entry); // 连接时先收敛一次
            await this.runInitiatorLoop(transport, entry, frames);
          } else {
            await this.runResponderLoop(transport, entry, frames);
          }
        } catch (error) {
          this.emit('sync-failed', { peerDeviceId, error });
        }
      })();
    });
  }

  /**
   * 连接关闭：清理在线登记与触发计时器。
   * N2：`connection` 用于**代际比对**——被退役旧连接的关闭事件不得误删
   * 同设备新连接的登记（同规范键、不同连接）。
   */
  private removeOnlinePeer(peerId: PeerId, connection?: Connection): void {
    const entry = this.onlinePeers.get(peerId.id);
    if (entry && connection && entry.connection && entry.connection !== connection) {
      // 「丢弃必须发声」：旧连接的关闭事件（entry 已属新连接）
      this.noteDropped('staleEntrySignals', {
        where: 'removeOnlinePeer',
        peerDeviceId: entry.peer.deviceId,
        key: peerId.id,
      });
      return;
    }
    if (entry?.triggerResolve) {
      const resolve = entry.triggerResolve;
      entry.triggerResolve = undefined;
      resolve();
    }
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
   *      暴露「对端有问题」。
   *
   * **R2 再订阅恢复（2c）：自报水位只允许向下修正**。对端自报某作者计数**低于**本机
   * 记录时，把本机水位**下调**到自报值（作者自报缺失 = 0）——这样退订方清理后重入、
   * 上报空的已订阅分区，对端会**从 0 重新 offer**（含快照，若符合既有的“空水位”门禁）。
   * **绝不向上修正**（不抬高），因此不会把「对端没有」误判为「已有」而静默不发。
   */
  private async recordPeerHello(
    peerDeviceId: string,
    hello: Extract<SyncMessage, { type: 'sync-hello' }>,
  ): Promise<{ ahead: NamespaceClocks; downCorrections: number }> {
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
    let changed = false;
    let downCorrections = 0; // P3（S3）：向下修正计数（每次修正一个作者/分区记 1）
    for (const [ns, clock] of Object.entries(hello.namespaceClocks)) {
      const knownNs = watermarks[ns] ?? {};
      // ② 诊断：自报高于本机记录 → 差额（不抬高本机水位）
      for (const [author, reported] of Object.entries(clock)) {
        const known = knownNs[author] ?? 0;
        if (reported > known) (ahead[ns] ??= {})[author] = reported - known;
      }
      // R2：向下修正（自报作者缺失 = 0）
      const authors = new Set([...Object.keys(knownNs), ...Object.keys(clock)]);
      for (const author of authors) {
        const known = knownNs[author] ?? 0;
        const reported = clock[author] ?? 0;
        if (reported < known) {
          if (!watermarks[ns]) watermarks[ns] = {};
          if (reported === 0) delete watermarks[ns][author];
          else watermarks[ns][author] = reported;
          changed = true;
          downCorrections += 1;
        }
      }
    }
    if (changed) {
      this.peerWatermarks.set(peerDeviceId, watermarks);
      await this.persistSyncState();
    }
    return { ahead, downCorrections };
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
    // R2：**显式声明重置**的分区即使为空也上报（空时钟）——据此触发对端**向下修正**与从 0
    // 重新 offer。普通空订阅不上报（避免无谓修正）；该集合由门面依据图外标记注入。
    for (const ns of this.resetNamespaces) derived[normalizeNamespace(ns)] ??= {};
    return mergeNamespaceClocks(derived, this.localSnapshotClocks);
  }

  /**
   * 供给端裁剪链：**信任边界 ∩ 本机订阅 ∩ 对端订阅**。
   *
   * - 没有「对端授权」项；对端是否可读只由它自己的订阅声明决定；
   * - 本机订阅为空 = 参与全部（候选域 = 本地已知域 ∪ 对端 hello 声明）；
   * - 某域有订阅记录时，记录是权威（hello 只用于「自称订阅却非订阅者」的告警）；
   * - 某域无任何订阅记录时，回退 hello 会话声明。
   */
  private async resolveOutgoingAllowList(
    peer: SyncPeer,
    hello: Extract<SyncMessage, { type: 'sync-hello' }>,
  ): Promise<string[]> {
    // 被移出对端：不供给任何用户数据（`__policy__` 仍随 filterEventsForAllow 放行）。
    const blocked = await this.subscriptionPolicy.getBlockedDevices?.();
    if (blocked?.has(peer.deviceId)) return [];
    const helloSub = declarationToAllowList(hello.subscribeAll, hello.namespaces);
    const helloWants = (ns: string): boolean => helloSub === null || helloSub.includes(ns);
    const localAll = this.subscriptionNamespaces.length === 0;
    const candidates = new Set<string>();
    if (localAll) {
      for (const event of await this.eventLog.listEvents()) {
        const ns = normalizeNamespace(event.namespace);
        if (ns !== POLICY_NAMESPACE) candidates.add(ns);
      }
      for (const ns of normalizeNamespaceList(hello.namespaces)) {
        if (ns !== POLICY_NAMESPACE) candidates.add(ns);
      }
    } else {
      for (const ns of this.subscriptionNamespaces) candidates.add(ns);
    }

    const allowed: string[] = [];
    const rejected: string[] = [];
    for (const ns of candidates) {
      const view = await this.subscriptionPolicy.getNamespaceSubscriptions(ns);
      const hasPeerRecord = (view.recorded ?? view.subscribers).includes(peer.deviceId);
      const peerSubscribed = view.active
        ? view.subscribers.includes(peer.deviceId) || (!hasPeerRecord && helloWants(ns))
        : helloWants(ns);
      if (peerSubscribed) {
        allowed.push(ns);
      } else if (view.active && helloWants(ns)) {
        rejected.push(ns); // 对端有退订记录却自称订阅 → 显式拒绝（非静默）
      }
    }
    this.lastSubscriptionRejected = rejected;
    if (rejected.length > 0) {
      this.emit('sync-subscription-rejected', { peerDeviceId: peer.deviceId, namespaces: rejected });
    }
    return allowed;
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

  /**
   * 该对端在给定（已授权）分区集合内是否确有 pending：我们持有、但对端水位未
   * 覆盖的事件。策略命名空间（`__policy__`）始终可传，故始终计入。
   */
  private async hasPendingForPeer(peerDeviceId: string, authorizedNamespaces: string[]): Promise<boolean> {
    const missing = await this.missingEventsForPeer(peerDeviceId);
    return missing.some((event) => {
      const ns = normalizeNamespace(event.namespace);
      return ns === POLICY_NAMESPACE || authorizedNamespaces.includes(ns);
    });
  }

  // ---------- 周期 anti-entropy（C） ----------

  /** core 默认关闭；常驻入口（门面 / MCP serve）默认开启 */
  get antiEntropyEnabled(): boolean {
    return this.antiEntropy.enabled;
  }

  private scheduleAntiEntropy(): void {
    if (!this.antiEntropy.enabled || this.antiEntropyTimer) return;
    const delay = computeAntiEntropyDelay(this.antiEntropy.intervalMs, this.antiEntropy.jitterRatio);
    const timer = setTimeout(() => {
      this.antiEntropyTimer = null;
      void this.runAntiEntropyCycle();
    }, delay);
    (timer as { unref?: () => void }).unref?.();
    this.antiEntropyTimer = timer;
  }

  /**
   * 一轮 anti-entropy：对每个在线对端，仅当「确实需要」（有 pending、不在退避、
   * 无会话在途）时触发一次同步；无 pending 的对端**短路跳过**（不做 hello/offer 往返）。
   */
  async runAntiEntropyCycle(): Promise<void> {
    try {
      for (const entry of this.onlinePeers.values()) {
        if (!entry.transport) continue;
        if (await this.shouldAntiEntropySync(entry.peer.deviceId)) {
          this.scheduleSyncTrigger(entry);
        }
      }
    } finally {
      this.scheduleAntiEntropy();
    }
  }

  /** 是否应为该对端发起 anti-entropy（无 pending / 会话在途 / 退避 → false） */
  async shouldAntiEntropySync(peerDeviceId: string): Promise<boolean> {
    if (this.syncing) return false; // 已有会话在途 → 跳过
    if (this.isAntiEntropyBackedOff(peerDeviceId)) return false;
    const blocked = await this.subscriptionPolicy.getBlockedDevices?.();
    if (blocked?.has(peerDeviceId)) return false;
    const namespaces = this.subscriptionNamespaces.length === 0
      ? await this.localKnownNamespaces()
      : this.subscriptionNamespaces;
    // 已知对端订阅记录时就按记录过滤；无记录（回退 hello）时保留候选，交给会话裁剪。
    const candidates: string[] = [];
    for (const ns of namespaces) {
      const view = await this.subscriptionPolicy.getNamespaceSubscriptions(ns);
      const hasPeerRecord = (view.recorded ?? view.subscribers).includes(peerDeviceId);
      if (!view.active || view.subscribers.includes(peerDeviceId) || !hasPeerRecord) candidates.push(ns);
    }
    return this.hasPendingForPeer(peerDeviceId, candidates);
  }

  /** 本地事件日志中出现过的用户数据分区（不含 `__policy__`）。 */
  private async localKnownNamespaces(): Promise<string[]> {
    const namespaces = new Set<string>();
    for (const event of await this.eventLog.listEvents()) {
      const ns = normalizeNamespace(event.namespace);
      if (ns !== POLICY_NAMESPACE) namespaces.add(ns);
    }
    return [...namespaces];
  }

  private isAntiEntropyBackedOff(peerDeviceId: string): boolean {
    const backoff = this.antiEntropyBackoff.get(peerDeviceId);
    return backoff !== undefined && Date.now() < backoff.nextAttemptAt;
  }

  /** 会话结果反馈：失败累积指数退避（有上限），成功即复位 */
  private recordSyncOutcome(peerDeviceId: string, ok: boolean): void {
    if (!this.antiEntropy.enabled) return;
    if (ok) {
      this.antiEntropyBackoff.delete(peerDeviceId);
      return;
    }
    const failures = (this.antiEntropyBackoff.get(peerDeviceId)?.failures ?? 0) + 1;
    const delay = Math.min(this.antiEntropy.intervalMs * 2 ** failures, ANTI_ENTROPY_MAX_BACKOFF_MS);
    this.antiEntropyBackoff.set(peerDeviceId, { failures, nextAttemptAt: Date.now() + delay });
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
    let unknownEventTypes = 0; // P3（S9）：日志有、图无（前向兼容；解释未收敛成因）

    // 入站移出：供给裁剪只挡「我们发给它」，挡不住被移出设备把事件推进我们
    // 的图。这里按当前移出集合隔离其**署名的**事件（不验签就谈不上凭据，故放在
    // 验签之后判定；本批只取一次移出快照）。
    const revoked = this.subscriptionPolicy.getBlockedDevices
      ? await this.subscriptionPolicy.getBlockedDevices()
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
      } else if (result.status === 'stale' && !isApplyableEventType(event.type)) {
        // 未知事件类型：入日志但不物化（前向兼容设计）——计数发声（P3/S9）
        unknownEventTypes += 1;
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

    return {
      ackedIds,
      received,
      duplicates,
      conflicts,
      ...(unknownEventTypes > 0 ? { unknownEventTypes } : {}),
    };
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
    // 中继/多跳：与 `GraphNamespacePolicy` 的签发者判定共用同一套证书链校验。
    // 吊销是**作者级**语义：本函数只验签发者证书链，不检查链中其他设备；
    // 被吊销作者的隔离在 `applyOffer` 按 `event.author` 判定（不应用/不入库/不 ack）。
    // 因此踢根机/中间设备不会连带拒绝其下级或新成员的事件。
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
    // 按当前移出集合过滤实体（createdBy/updatedBy 命中即拒绝）。
    // 快照是旁路——直接推送的事件已在 applyOffer 被隔离，这里必须补上同样的边界。
    const revoked = this.subscriptionPolicy.getBlockedDevices
      ? await this.subscriptionPolicy.getBlockedDevices()
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
    diagnostics: {
      ackedOutgoing?: number;
      watermarkDownCorrections?: number;
      unknownEventTypes?: number;
    } = {},
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
      // 拒绝不静默：allow 解析为 [] 时明确指出「没有订阅交集」
      noSubscriptionOverlap: allow.length === 0,
    };
    // 订阅一致性——对端自称订阅却不是订阅者的分区，显式暴露（非静默）
    if (this.lastSubscriptionRejected.length > 0) {
      result.subscriptionRejected = [...this.lastSubscriptionRejected];
    }
    // 诊断信号（R1）：对端自报高于本机记录的部分；仅诊断，不影响发送集合
    if (reportedAhead && Object.keys(reportedAhead).length > 0) {
      result.reportedAhead = reportedAhead;
    }
    // P3 诊断信号（S1/S3/S9）：发出→确认计数、向下修正、未知事件类型
    if (typeof diagnostics.ackedOutgoing === 'number') {
      result.ackedOutgoing = diagnostics.ackedOutgoing;
    }
    if (diagnostics.watermarkDownCorrections && diagnostics.watermarkDownCorrections > 0) {
      result.watermarkDownCorrections = diagnostics.watermarkDownCorrections;
    }
    if (diagnostics.unknownEventTypes && diagnostics.unknownEventTypes > 0) {
      result.unknownEventTypes = diagnostics.unknownEventTypes;
    }
    return result;
  }

  // ---------- P3 · 收敛健康度（会话尾指纹） ----------

  /**
   * P3：本会话要携带的状态指纹信封（仅在门面注入 `fingerprints` 时非空）。
   * 计算失败不影响会话（诊断载荷；以 `sync-fingerprint{result:'local-error'}`
   * 发声，不静默）。
   */
  private async buildStateFingerprintEnvelope(peer: SyncPeer): Promise<{ stateFingerprints?: SyncStateFingerprints }> {
    if (!this.fingerprints) return {};
    try {
      return { stateFingerprints: await this.fingerprints.report() };
    } catch (error) {
      this.emit('sync-fingerprint', {
        peerDeviceId: peer.deviceId,
        at: Date.now(),
        result: 'local-error',
        commonDomains: [],
        mismatchedDomains: [],
        peerOnlyDomains: [],
        localOnlyDomains: [],
        policy: 'local-missing',
        error: error instanceof Error ? error.message : String(error),
      } satisfies SyncFingerprintEvent);
      return {};
    }
  }

  /**
   * P3：比对双方会话尾指纹（收到对端 `sync-done` 后调用）。结果一律以
   * `sync-fingerprint` 事件上报（含 `peer-missing` 降级）；**绝不改变**任何
   * 会话/授权/水位状态（只读诊断，差异默认动作 = 告警）。
   */
  private async notePeerFingerprints(
    peer: SyncPeer,
    local: SyncStateFingerprints | null,
    peerRaw: unknown,
    outgoingAllow: string[],
  ): Promise<void> {
    if (!local) return; // 本地未启用或计算失败：无可比（对端字段按未知字段忽略）
    const comparison = compareStateFingerprints(local, parseStateFingerprints(peerRaw), {
      expectedIncoming: await this.expectedIncomingDomains(),
      outgoingAllow,
    });
    this.emit('sync-fingerprint', {
      peerDeviceId: peer.deviceId,
      at: Date.now(),
      ...comparison,
    } satisfies SyncFingerprintEvent);
  }

  /**
   * P3（S6/S7）：「本机期望收到」的分区 = 本机订阅集；订阅为空（参与全部）
   * 时取本地已知域。仅用于指纹比较的「对端多出」判据——订阅外的数据多寡
   * 不是收敛义务。
   */
  private async expectedIncomingDomains(): Promise<string[]> {
    try {
      if (this.subscriptionNamespaces.length === 0) return await this.localKnownNamespaces();
      return [...this.subscriptionNamespaces];
    } catch {
      return [];
    }
  }

  /**
   * 会话队列键（N4）：优先用 entry 的连接对象；否则用传输承载的连接；
   * 都无法获知（内存/测试替身）时退化为全局键（历史行为）。
   */
  private connectionQueueKey(
    connection: Connection | undefined,
    transport: SyncTransport,
  ): object | string {
    return connection ?? transport.connection ?? 'global';
  }

  /**
   * 会话串行化（N4）：**按连接粒度**排队——同一信道上不允许多会话帧序交错；
   * 不同连接的会话互不阻塞（单个"无限等待 hello"的常驻响应方会话不再饿死
   * 同管理器内其它连接/对端的会话）。队列尾完成即自清理（不泄漏）。
   */
  private enqueue<T>(key: object | string, task: () => Promise<T>): Promise<T> {
    const previous = this.sessionQueues.get(key) ?? Promise.resolve();
    const run = previous.then(task);
    const tail = run.catch(() => undefined);
    this.sessionQueues.set(key, tail);
    void tail.finally(() => {
      if (this.sessionQueues.get(key) === tail) {
        this.sessionQueues.delete(key);
      }
    });
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
      this.recordSyncOutcome(peer.deviceId, true);
      return result;
    } catch (error) {
      this.emit('sync-failed', { peerDeviceId: peer.deviceId, error });
      this.recordSyncOutcome(peer.deviceId, false);
      throw error;
    } finally {
      this.syncing = false;
    }
  }
}
