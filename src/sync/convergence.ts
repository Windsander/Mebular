// P3 · 收敛健康度（Convergence Health）——监控 + 状态机 + 指纹比较
//
// 定位：把「未收敛 / 停滞」从静默变成 **可见 / 可查 / 可告警**。纯观察层：
// 不改变任何同步、授权、水位语义；不写图、不写事件账；指纹只作诊断，
// 差异的默认动作是告警（绝不据此放宽授权/水位；见 C2 §2 告警方向）。
//
// 数据来源（全部为既有出口或 P1 已落地的计数）：
// - 会话事件：`sync-started / sync-completed / sync-failed`（SyncResult 的可选诊断字段）；
// - 会话尾指纹：`sync-done.stateFingerprints`（C3 A 类可选字段）→ `sync-fingerprint` 事件；
// - 积压两口径：`SyncManager.getBacklogDiagnostics`（per-event ack 集合 vs 水位）；
// - 丢弃计数：`SyncManager.getDropCounters`（I6「丢弃必须发声」）；
// - 在线对端：`SyncManager.getOnlinePeers`；
// - 修复探测（A1 批准项）：`SyncManager.requestSession`——限频、方向安全（最多多问一轮，
//   借对端 hello 自报触发既有 R2 向下修正；不越过任何安全判定）。

import { createHash } from 'crypto';
import { EventEmitter } from 'events';
import type { SyncResult } from './syncmgr/SyncManager.js';
import type { PolicyState } from './grantPolicy.js';
import type { SyncStateFingerprints } from './protocol.js';

// ---------- 配置 ----------

export interface ConvergenceConfig {
  /** 常驻入口默认 true（形状照 antiEntropy 先例）；core 默认 false（库行为零变化） */
  enabled?: boolean;
  /** 评估间隔（ms） */
  evalIntervalMs?: number;
  /** 静止窗口（ms）：距上次会话/本地写入 ≥ 此值才做「去抖确认」类判定 */
  quietMs?: number;
  /** 停滞统计窗口（ms） */
  stallWindowMs?: number;
  /** 连续会话失败达到此数判停滞 */
  failStreak?: number;
  /** 未收敛需连续（静止）确认次数（去抖） */
  mismatchConfirmations?: number;
  /** A1：对「记账矛盾」对端限频自动探测一轮（默认开） */
  autoProbe?: boolean;
}

export interface NormalizedConvergenceConfig extends Required<ConvergenceConfig> {}

export const CONVERGENCE_DEFAULTS: NormalizedConvergenceConfig = {
  enabled: false,
  evalIntervalMs: 60_000,
  quietMs: 60_000,
  stallWindowMs: 15 * 60_000,
  failStreak: 3,
  mismatchConfirmations: 2,
  autoProbe: true,
};

function positive(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function normalizeConvergenceConfig(config?: ConvergenceConfig): NormalizedConvergenceConfig {
  return {
    enabled: config?.enabled ?? CONVERGENCE_DEFAULTS.enabled,
    evalIntervalMs: positive(config?.evalIntervalMs, CONVERGENCE_DEFAULTS.evalIntervalMs),
    quietMs: positive(config?.quietMs, CONVERGENCE_DEFAULTS.quietMs),
    stallWindowMs: positive(config?.stallWindowMs, CONVERGENCE_DEFAULTS.stallWindowMs),
    failStreak: positive(config?.failStreak, CONVERGENCE_DEFAULTS.failStreak),
    mismatchConfirmations: positive(config?.mismatchConfirmations, CONVERGENCE_DEFAULTS.mismatchConfirmations),
    autoProbe: config?.autoProbe ?? CONVERGENCE_DEFAULTS.autoProbe,
  };
}

// ---------- 指纹比较（S7/S8 判据） ----------

export type FingerprintResultKind = 'match' | 'mismatch' | 'peer-missing' | 'inconclusive';
export type FingerprintPolicyVerdict = 'match' | 'mismatch' | 'peer-missing' | 'local-missing';

export interface FingerprintComparison {
  result: FingerprintResultKind;
  /** 双方共同持有的分区（记忆域） */
  commonDomains: string[];
  /** 判定为不一致的分区（共同域差异 + 期望内对端多余 + 发送集合内我方多余） */
  mismatchedDomains: string[];
  /** 对端多出、且落在「本机期望收到」集合内的分区 */
  peerOnlyDomains: string[];
  /** 本机多出、且落在本会话发送集合内的分区 */
  localOnlyDomains: string[];
  /** 策略视图指纹裁决（S8，C2 ⑦） */
  policy: FingerprintPolicyVerdict;
}

export interface CompareFingerprintOptions {
  /**
   * 本机「期望收到」的分区：生效授权 ∩ 订阅声明（subscribeAll = 全部授权域）。
   * 对端多出的分区只有落在此集合内才算不一致（授权外的数据多寡不是收敛义务）。
   */
  expectedIncoming?: string[] | 'all';
  /** 本会话的发送集合（allow）：我方多出的分区只有在此集合内才算「对端应有而缺」。 */
  outgoingAllow?: string[];
}

/** 比较双方会话尾指纹（共同域口径与 `verify-mcp-cross.mjs` / `wan-sync.mjs` 同构）。 */
export function compareStateFingerprints(
  local: SyncStateFingerprints | null | undefined,
  peer: SyncStateFingerprints | null | undefined,
  options: CompareFingerprintOptions = {},
): FingerprintComparison {
  if (!local || !peer) {
    return {
      result: 'peer-missing',
      commonDomains: [],
      mismatchedDomains: [],
      peerOnlyDomains: [],
      localOnlyDomains: [],
      policy: 'peer-missing',
    };
  }
  const localGraphs = local.graphs ?? {};
  const peerGraphs = peer.graphs ?? {};
  const common = Object.keys(localGraphs).filter((ns) => Object.hasOwn(peerGraphs, ns)).sort();
  const mismatched = common.filter((ns) => localGraphs[ns] !== peerGraphs[ns]);
  const expected = options.expectedIncoming ?? [];
  const outgoing = new Set(options.outgoingAllow ?? []);
  const peerOnly = Object.keys(peerGraphs)
    .filter((ns) => !Object.hasOwn(localGraphs, ns))
    .filter((ns) => (expected === 'all' ? true : expected.includes(ns)))
    .sort();
  const localOnly = Object.keys(localGraphs)
    .filter((ns) => !Object.hasOwn(peerGraphs, ns))
    .filter((ns) => outgoing.has(ns))
    .sort();
  const mismatchedDomains = [...new Set([...mismatched, ...peerOnly, ...localOnly])].sort();

  let policy: FingerprintPolicyVerdict;
  if (local.policy === undefined) policy = 'local-missing';
  else if (peer.policy === undefined) policy = 'peer-missing';
  else policy = local.policy === peer.policy ? 'match' : 'mismatch';

  let result: FingerprintResultKind;
  if (mismatchedDomains.length > 0 || policy === 'mismatch') result = 'mismatch';
  else if (common.length > 0 || (Object.keys(localGraphs).length === 0 && Object.keys(peerGraphs).length === 0)) {
    result = 'match';
  } else {
    result = 'inconclusive';
  }
  return { result, commonDomains: common, mismatchedDomains, peerOnlyDomains: peerOnly, localOnlyDomains: localOnly, policy };
}

/** 会话尾指纹事件：`SyncManager` 每次收到对端 sync-done 后 emit（诊断载荷）。 */
export interface SyncFingerprintEvent extends Omit<FingerprintComparison, 'result'> {
  peerDeviceId: string;
  at: number;
  result: FingerprintResultKind | 'local-error';
  error?: string;
}

/** 策略视图指纹（S8，C2 ⑦）：`derivePolicyState` 输出的确定性序列化 SHA-256。
 * 同一事件集（同一信任过滤口径）在任何端推导出同一状态 → 同一哈希。 */
export function hashPolicyState(state: PolicyState): string {
  const byKey = (a: [string, unknown], b: [string, unknown]): number => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  const canon = JSON.stringify({
    authorized: [...state.authorized.entries()]
      .sort(byKey)
      .map(([subject, namespaces]) => [subject, [...namespaces].sort()]),
    revoked: [...state.revoked].sort(),
    issuers: [...state.issuers].sort(),
    members: [...state.members.entries()]
      .sort(byKey)
      .map(([ns, members]) => [ns, [...members].sort()]),
  });
  return createHash('sha256').update(canon).digest('hex');
}

// ---------- 状态与原因 ----------

export type ConvergenceState = 'ok' | 'stalled' | 'diverged' | 'unverifiable' | 'offline' | 'syncing';

export type ConvergenceReasonCode =
  /** S7/S8：共同域/策略指纹不一致（去抖确认后） */
  | 'fingerprint-mismatch'
  /** S4：会话失败连击 */
  | 'session-failures'
  /** S1：发出但未被确认 */
  | 'no-ack-progress'
  /** S1：记账矛盾（per-event ack 集合与水路口径不一致） */
  | 'backlog-mismatch'
  /** S5：身份缺失丢弃（键控回归哨兵，设备级） */
  | 'keying-drop'
  /** S5：键控类丢弃（nudge/stale，设备级，提示） */
  | 'keying-drops'
  /** A1 探测多轮无果 */
  | 'probe-ineffective'
  /** S2：对端自报超前（提示） */
  | 'peer-claims-ahead'
  /** S3：对端水位反复下降修正（提示） */
  | 'peer-state-loss'
  /** S9：未知事件类型（日志有、图无） */
  | 'unknown-event-types'
  /** 对端未提供指纹（旧版本/未启用） */
  | 'no-fingerprints'
  /** 尚未有过可比对的会话 */
  | 'awaiting-session'
  /** S6：本机有期望却无法跨端自证（等待对账） */
  | 'expected-yet-unverifiable';

export interface ConvergenceReason {
  code: ConvergenceReasonCode;
  detail?: string;
  count?: number;
  domains?: string[];
}

export interface PeerConvergenceStatus {
  peerDeviceId: string;
  state: ConvergenceState;
  reasons: ConvergenceReason[];
  /** 进入当前状态的时刻 */
  since: number;
  lastEvaluatedAt: number;
  lastSessionAt: number | null;
  lastConvergedAt: number | null;
  /** 最近一拍的「未显式 ack」事件数（诊断） */
  pendingEvents: number | null;
  /** A1 探测次数与最近时刻 */
  probes: number;
  lastProbeAt: number | null;
  online: boolean;
}

export interface ConvergenceSummary {
  peers: number;
  online: number;
  ok: number;
  stalled: number;
  diverged: number;
  unverifiable: number;
  syncing: number;
  offline: number;
}

export interface ConvergenceStatus {
  enabled: true;
  at: number;
  peers: PeerConvergenceStatus[];
  summary: ConvergenceSummary;
}

export interface ConvergenceTransition {
  peerDeviceId: string;
  from: ConvergenceState;
  to: ConvergenceState;
  at: number;
  reasons: ConvergenceReason[];
}

// ---------- 监控 ----------

export interface ConvergenceMonitorOptions {
  config?: ConvergenceConfig;
  /** 可注入时钟（测试） */
  now?: () => number;
  getOnlinePeers?: () => Array<{ deviceId: string }>;
  getBacklog?: (peerDeviceId: string) => Promise<{ pendingById: number; missingByWatermark: number }>;
  getDropCounters?: () => { nudgeDroppedStaleEntry: number; staleEntrySignals: number; identityFailures: number };
  /** A1：请对端开一轮会话（返回是否已安排；限频由监控执行） */
  requestSession?: (peerDeviceId: string) => boolean;
  /** S6：本机「期望收到」的分区（生效授权 ∩ 订阅） */
  getExpectedIncomingDomains?: () => Promise<string[]> | string[];
}

interface SessionSample {
  at: number;
  sent: number;
  acked: number;
}

interface CountedEvent {
  at: number;
  count: number;
}

interface PeerRuntime {
  deviceId: string;
  online: boolean;
  inFlight: boolean;
  lastOnlineAt: number | null;
  lastSessionAt: number | null;
  sessions: SessionSample[];
  /** S4：连续失败计数（成功即复位） */
  failStreak: number;
  lastFailureAt: number | null;
  comparisons: Array<{ at: number; result: SyncFingerprintEvent['result']; mismatchedDomains: string[]; policy: FingerprintPolicyVerdict }>;
  mismatchQuietChecks: number;
  mismatchConfirmed: boolean;
  backlog: { at: number; pendingById: number; missingByWatermark: number } | null;
  divergenceSince: number | null;
  lastProbeAt: number | null;
  probeCount: number;
  lastConvergedAt: number | null;
  aheadTimes: number[];
  downCorrections: CountedEvent[];
  unknownTypes: CountedEvent[];
  dropBaseline: { nudgeDroppedStaleEntry: number; staleEntrySignals: number; identityFailures: number } | null;
  dropDelta: { nudgeDroppedStaleEntry: number; staleEntrySignals: number; identityFailures: number };
  expectedIncoming: string[];
  state: ConvergenceState;
  since: number;
  reasons: ConvergenceReason[];
}

const MAX_KEEP = 100;

export class ConvergenceMonitor extends EventEmitter {
  private readonly config: NormalizedConvergenceConfig;
  private readonly now: () => number;
  private readonly options: ConvergenceMonitorOptions;
  private readonly peers = new Map<string, PeerRuntime>();
  private lastLocalAppendAt = 0;
  private lastGlobalDrops: { nudgeDroppedStaleEntry: number; staleEntrySignals: number; identityFailures: number } | null = null;
  private lastEvaluatedAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private evaluating = false;

  constructor(options: ConvergenceMonitorOptions = {}) {
    super();
    this.options = options;
    this.config = normalizeConvergenceConfig(options.config);
    this.now = options.now ?? (() => Date.now());
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  getConfig(): NormalizedConvergenceConfig {
    return { ...this.config };
  }

  start(): void {
    if (!this.config.enabled || this.timer) return;
    const timer = setInterval(() => {
      void this.evaluateNow().catch(() => undefined);
    }, this.config.evalIntervalMs);
    (timer as { unref?: () => void }).unref?.();
    this.timer = timer;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // ---------- 事件馈入 ----------

  /** 本地写入（event-appended 仅本地触发）：用于静止窗口判定。 */
  noteLocalAppend(at?: number): void {
    this.lastLocalAppendAt = at ?? this.now();
  }

  noteSessionStarted(peerDeviceId: string, at?: number): void {
    const peer = this.ensurePeer(peerDeviceId);
    peer.inFlight = true;
    void at;
  }

  noteSessionCompleted(result: SyncResult, at?: number): void {
    const time = at ?? this.now();
    const peer = this.ensurePeer(result.peerDeviceId);
    peer.inFlight = false;
    peer.lastSessionAt = time;
    peer.failStreak = 0; // 成功即复位（连续失败口径）
    const acked = typeof result.ackedOutgoing === 'number' ? result.ackedOutgoing : result.sentEvents;
    peer.sessions.push({ at: time, sent: result.sentEvents, acked });
    if (peer.sessions.length > MAX_KEEP) peer.sessions.splice(0, peer.sessions.length - MAX_KEEP);
    if (result.reportedAhead && Object.keys(result.reportedAhead).length > 0) {
      peer.aheadTimes.push(time);
      if (peer.aheadTimes.length > MAX_KEEP) peer.aheadTimes.splice(0, peer.aheadTimes.length - MAX_KEEP);
    }
    if (result.watermarkDownCorrections && result.watermarkDownCorrections > 0) {
      peer.downCorrections.push({ at: time, count: result.watermarkDownCorrections });
    }
    if (result.unknownEventTypes && result.unknownEventTypes > 0) {
      peer.unknownTypes.push({ at: time, count: result.unknownEventTypes });
    }
  }

  noteSessionFailed(payload: { peerDeviceId: string }, at?: number): void {
    const time = at ?? this.now();
    const peer = this.ensurePeer(payload.peerDeviceId);
    peer.inFlight = false;
    peer.failStreak += 1;
    peer.lastFailureAt = time;
  }

  noteFingerprintComparison(comparison: SyncFingerprintEvent): void {
    const peer = this.ensurePeer(comparison.peerDeviceId);
    peer.comparisons.push({
      at: comparison.at,
      result: comparison.result,
      mismatchedDomains: [...comparison.mismatchedDomains],
      policy: comparison.policy,
    });
    if (peer.comparisons.length > MAX_KEEP) peer.comparisons.splice(0, peer.comparisons.length - MAX_KEEP);
    if (comparison.result === 'match') peer.lastConvergedAt = comparison.at;
  }

  // ---------- 评估 ----------

  async evaluateNow(): Promise<void> {
    if (this.evaluating) return;
    this.evaluating = true;
    try {
      const now = this.now();
      const online = new Set((this.options.getOnlinePeers?.() ?? []).map((p) => p.deviceId));
      for (const deviceId of online) this.ensurePeer(deviceId);
      if (online.size === 0 && this.peers.size === 0) {
        this.lastEvaluatedAt = now;
        return;
      }
      for (const peer of this.peers.values()) peer.online = online.has(peer.deviceId);

      const expectedIncoming = await this.safeExpectedIncoming();
      for (const peer of this.peers.values()) peer.expectedIncoming = expectedIncoming;

      // 丢弃计数（设备级）：本拍增量广播给所有在线对端
      const counters = this.options.getDropCounters?.();
      const dropDelta = { nudgeDroppedStaleEntry: 0, staleEntrySignals: 0, identityFailures: 0 };
      if (counters) {
        if (this.lastGlobalDrops) {
          dropDelta.nudgeDroppedStaleEntry = Math.max(0, counters.nudgeDroppedStaleEntry - this.lastGlobalDrops.nudgeDroppedStaleEntry);
          dropDelta.staleEntrySignals = Math.max(0, counters.staleEntrySignals - this.lastGlobalDrops.staleEntrySignals);
          dropDelta.identityFailures = Math.max(0, counters.identityFailures - this.lastGlobalDrops.identityFailures);
        }
        this.lastGlobalDrops = { ...counters };
      }

      for (const peer of this.peers.values()) {
        if (peer.online && this.options.getBacklog) {
          try {
            const backlog = await this.options.getBacklog(peer.deviceId);
            peer.backlog = { at: now, pendingById: backlog.pendingById, missingByWatermark: backlog.missingByWatermark };
          } catch {
            // 读取失败：保留上一拍（诊断层不制造新故障）
          }
        }
        peer.dropDelta = { ...dropDelta };
        const next = this.computeState(peer, now);
        if (next !== peer.state) {
          const from = peer.state;
          peer.state = next;
          peer.since = now;
          this.emit('transition', {
            peerDeviceId: peer.deviceId,
            from,
            to: next,
            at: now,
            reasons: peer.reasons.map((r) => ({ ...r })),
          } satisfies ConvergenceTransition);
        }
      }
      this.lastEvaluatedAt = now;
    } finally {
      this.evaluating = false;
    }
  }

  private async safeExpectedIncoming(): Promise<string[]> {
    try {
      const value = await this.options.getExpectedIncomingDomains?.();
      return Array.isArray(value) ? [...new Set(value)].sort() : [];
    } catch {
      return [];
    }
  }

  private isQuiet(peer: PeerRuntime, now: number): boolean {
    const lastActivity = Math.max(peer.lastSessionAt ?? 0, this.lastLocalAppendAt);
    return now - lastActivity >= this.config.quietMs;
  }

  private computeState(peer: PeerRuntime, now: number): ConvergenceState {
    const window = this.config.stallWindowMs;
    const reasons: ConvergenceReason[] = [];

    if (!peer.online) {
      peer.reasons = reasons;
      return 'offline';
    }

    const red = new Set<'fingerprint-mismatch' | 'session-failures' | 'no-ack-progress' | 'backlog-mismatch' | 'keying-drop'>();

    // S4：会话连续失败 ≥ failStreak（成功即复位）
    if (peer.failStreak >= this.config.failStreak) {
      red.add('session-failures');
      reasons.push({ code: 'session-failures', count: peer.failStreak });
    }

    // S5：身份缺失丢弃（设备级）——修复后应恒为 0，立即告警
    if (peer.dropDelta.identityFailures > 0) {
      red.add('keying-drop');
      reasons.push({ code: 'keying-drop', count: peer.dropDelta.identityFailures, detail: '设备级（身份缺失/键控回归哨兵）' });
    }
    if (peer.dropDelta.nudgeDroppedStaleEntry > 0 || peer.dropDelta.staleEntrySignals > 0) {
      reasons.push({
        code: 'keying-drops',
        count: peer.dropDelta.nudgeDroppedStaleEntry + peer.dropDelta.staleEntrySignals,
        detail: '设备级（nudge/stale entry 丢弃）',
      });
    }

    // S1②：最近两次「发出但零确认」的会话 → 对端不确认
    const sentSessions = peer.sessions.filter((s) => s.sent > 0 && s.at >= now - window);
    const lastTwo = sentSessions.slice(-2);
    if (lastTwo.length >= 2 && lastTwo.every((s) => s.acked === 0)) {
      red.add('no-ack-progress');
      reasons.push({ code: 'no-ack-progress', count: lastTwo.length });
    }

    // S7/S8：指纹（去抖：静止窗口下连续 mismatchConfirmations 次确认）
    const latest = peer.comparisons.at(-1);
    if (latest && latest.result === 'mismatch') {
      if (this.isQuiet(peer, now)) peer.mismatchQuietChecks += 1;
      if (peer.mismatchQuietChecks >= this.config.mismatchConfirmations) peer.mismatchConfirmed = true;
      reasons.push({
        code: 'fingerprint-mismatch',
        domains: latest.mismatchedDomains.length > 0 ? latest.mismatchedDomains : undefined,
        ...(latest.mismatchedDomains.length === 0 && latest.policy === 'mismatch' ? { detail: '策略视图指纹不一致' } : {}),
      });
      if (peer.mismatchConfirmed) red.add('fingerprint-mismatch');
    } else {
      peer.mismatchQuietChecks = 0;
      peer.mismatchConfirmed = false;
      if (latest?.result === 'peer-missing') {
        reasons.push({ code: 'no-fingerprints', detail: '对端未提供状态指纹（旧版本 / 未启用）' });
        if (peer.expectedIncoming.length > 0) {
          reasons.push({ code: 'expected-yet-unverifiable', domains: [...peer.expectedIncoming] });
        }
      }
    }

    // S1①：记账矛盾（per-event ack 集合有欠、水位口径无欠）→ 死锁类；
    // 静止确认一次后进入停滞；修复探测（A1）限频尝试一轮。
    const divergent = peer.backlog !== null
      && peer.backlog.pendingById > 0
      && peer.backlog.missingByWatermark === 0;
    if (divergent && peer.divergenceSince === null) {
      peer.divergenceSince = now;
    } else if (!divergent) {
      peer.divergenceSince = null;
    }
    if (peer.divergenceSince !== null && peer.backlog !== null) {
      const since = peer.divergenceSince;
      const resolvedByMatch = latest?.result === 'match' && latest.at > since;
      if (resolvedByMatch) {
        peer.divergenceSince = null;
      } else {
        reasons.push({ code: 'backlog-mismatch', count: peer.backlog.pendingById });
        red.add('backlog-mismatch');
        if (this.config.autoProbe && (peer.lastProbeAt === null || now - peer.lastProbeAt >= this.config.evalIntervalMs)) {
          peer.lastProbeAt = now;
          peer.probeCount += 1;
          try {
            this.options.requestSession?.(peer.deviceId);
          } catch {
            // 探测失败不影响评估
          }
        }
        if (peer.probeCount >= 3 && (!latest || latest.at <= since)) {
          reasons.push({ code: 'probe-ineffective', count: peer.probeCount });
        }
      }
    }

    // 提示类（不改变状态）
    const aheadRecent = peer.aheadTimes.filter((t) => t >= now - window).length;
    if (aheadRecent >= 2) reasons.push({ code: 'peer-claims-ahead', count: aheadRecent });
    const downRecent = peer.downCorrections.filter((e) => e.at >= now - window).reduce((sum, e) => sum + e.count, 0);
    if (downRecent >= 3) reasons.push({ code: 'peer-state-loss', count: downRecent });
    const unknownRecent = peer.unknownTypes.filter((e) => e.at >= now - window).reduce((sum, e) => sum + e.count, 0);
    if (unknownRecent > 0) reasons.push({ code: 'unknown-event-types', count: unknownRecent });

    peer.reasons = reasons;

    if (red.has('fingerprint-mismatch')) return 'diverged';
    if (red.size > 0) return 'stalled';
    if (!latest) {
      reasons.push({ code: 'awaiting-session' });
      peer.reasons = reasons;
      return peer.inFlight ? 'syncing' : 'unverifiable';
    }
    // 注意：响应方常驻循环在两次会话之间 `inFlight` 恒真（无限等待下一个 hello）
    // ——「syncing」不得压过已确认的 ok（否则每台响应侧永远显示同步中）。
    if (latest.result === 'match' || latest.result === 'inconclusive') return 'ok';
    if (peer.inFlight) return 'syncing';
    // mismatch 未确认：核实中（不报 diverged，也不误报 ok）
    return 'unverifiable';
  }

  // ---------- 快照 ----------

  getStatus(): ConvergenceStatus {
    const peers = [...this.peers.values()].sort((a, b) => (a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0));
    const summary: ConvergenceSummary = {
      peers: peers.length,
      online: peers.filter((p) => p.online).length,
      ok: 0,
      stalled: 0,
      diverged: 0,
      unverifiable: 0,
      syncing: 0,
      offline: 0,
    };
    const statusPeers: PeerConvergenceStatus[] = peers.map((peer) => {
      summary[peer.state] += 1;
      return {
        peerDeviceId: peer.deviceId,
        state: peer.state,
        reasons: peer.reasons.map((r) => ({ ...r })),
        since: peer.since,
        lastEvaluatedAt: this.lastEvaluatedAt,
        lastSessionAt: peer.lastSessionAt,
        lastConvergedAt: peer.lastConvergedAt,
        pendingEvents: peer.backlog && peer.backlog.at === this.lastEvaluatedAt ? peer.backlog.pendingById : (peer.backlog?.pendingById ?? null),
        probes: peer.probeCount,
        lastProbeAt: peer.lastProbeAt,
        online: peer.online,
      };
    });
    return { enabled: true, at: this.lastEvaluatedAt, peers: statusPeers, summary };
  }

  private ensurePeer(deviceId: string): PeerRuntime {
    let peer = this.peers.get(deviceId);
    if (!peer) {
      const now = this.now();
      peer = {
        deviceId,
        online: false,
        inFlight: false,
        lastOnlineAt: null,
        lastSessionAt: null,
        sessions: [],
        failStreak: 0,
        lastFailureAt: null,
        comparisons: [],
        mismatchQuietChecks: 0,
        mismatchConfirmed: false,
        backlog: null,
        divergenceSince: null,
        lastProbeAt: null,
        probeCount: 0,
        lastConvergedAt: null,
        aheadTimes: [],
        downCorrections: [],
        unknownTypes: [],
        dropBaseline: null,
        dropDelta: { nudgeDroppedStaleEntry: 0, staleEntrySignals: 0, identityFailures: 0 },
        expectedIncoming: [],
        state: 'unverifiable',
        since: now,
        reasons: [],
      };
      this.peers.set(deviceId, peer);
    }
    return peer;
  }
}
