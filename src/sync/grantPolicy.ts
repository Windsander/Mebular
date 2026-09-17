// 授权作为记忆（Phase 2 · D）与身份吊销（Phase 2 · E）的图上策略。
//
// 授权不再是逐机漂移的本地配置，而是**签发者签名**的记录，落在保留策略
// 命名空间 `__policy__`：全 fleet 可见、可审计、可撤销，且不可被被授权方自授。
//
// 信任根复用现有证书链（`verifyIssuedByUser`）：只有链到用户主密钥的设备
// 签发的记录才被采纳；其余（自授、别家用户、无证书伪造）一律忽略。
//
// 本文件只做「从图上推导授权/吊销状态」，不引入任何任务/调度/执行语义。

import type { Event } from '../types/event.js';
import type { EventLog } from '../eventlog/EventLog.js';
import { normalizeNamespaceList } from '../core/namespace.js';
import type { NamespaceGrantPolicy } from './namespacePolicy.js';
import { verifyIssuedByUser } from './trust.js';

/**
 * 保留策略命名空间：授权/吊销记录落在这里。
 *
 * 它是**元数据**（带签发者签名），不是用户数据；因此同步时**不受 allow 链
 * 约束**（见 SyncManager 的 filterEventsForAllow），已认证设备总能读到它，
 * 从而解开「默认拒绝 + 策略在图上的 bootstrap 鸡生蛋」问题。写入/生效仍只认
 * 签发者。
 */
export const POLICY_NAMESPACE = '__policy__';

export const NAMESPACE_GRANT_EVENT = 'namespace_grant';
export const NAMESPACE_REVOKE_EVENT = 'namespace_revoke';
export const DEVICE_REVOKE_EVENT = 'device_revoke';

/** 授予记录：把 `namespaces` 授予 `subject` 设备。 */
export interface NamespaceGrantRecord {
  /** 唯一 ID，用于授予/撤销配对与幂等 */
  grantId: string;
  /** 被授权设备 ID */
  subject: string;
  /** 授权分区白名单 */
  namespaces: string[];
  /** 签发时间（签发者时钟，仅用于同一主体内排序） */
  issuedAt: number;
  /** 预留：过期时间（本轮**不**强制生效，见 README） */
  expiresAt?: number;
  note?: string;
}

/** 撤销记录：撤销某个 grantId（按 ID 精确失效）。 */
export interface NamespaceRevokeRecord {
  grantId: string;
  subject?: string;
  issuedAt: number;
  note?: string;
}

/** 身份吊销记录：吊销某设备（读侧拒绝 + 入站事件不再被应用）。 */
export interface DeviceRevokeRecord {
  subject: string;
  issuedAt: number;
  note?: string;
}

/** 从图上推导出的策略快照：每个主体的生效授权 + 被吊销设备集合。 */
export interface PolicyState {
  /** subject → 生效分区白名单（未出现 = 拒绝） */
  authorized: Map<string, string[]>;
  /** 当前处于吊销状态的设备 */
  revoked: Set<string>;
}

interface ParsedEntry {
  kind: 'grant' | 'revoke' | 'device';
  /** 签发者设备 ID（= event.author） */
  author: string;
  /**
   * 签发者自身的单调序列 = `event.vectorClock[event.author]`。它随该作者的
   * 每次签发递增，**不受墙钟影响**，是同一签发者内事件真实先后（F-2）。
   */
  seq: number;
  /** 签发者墙钟；仅作跨签发者兑底与同 seq 的 tie-break */
  issuedAt: number;
  id: string;
  grant?: NamespaceGrantRecord;
  revoke?: NamespaceRevokeRecord;
  device?: DeviceRevokeRecord;
}

function isPolicyType(type: string): boolean {
  return (
    type === NAMESPACE_GRANT_EVENT || type === NAMESPACE_REVOKE_EVENT || type === DEVICE_REVOKE_EVENT
  );
}

/**
 * 确定性排序（F-2）：**同一签发者内以单调序列 seq 为准**（不受墙钟偏移影响），
 * 跨签发者（seq 不可比）回退到 issuedAt；仍平局时用内容寻址 ID 兜底。
 */
function compareEntries(a: ParsedEntry, b: ParsedEntry): number {
  if (a.author === b.author && a.seq !== b.seq) return a.seq - b.seq;
  if (a.issuedAt !== b.issuedAt) return a.issuedAt - b.issuedAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** 事件作者自身的单调计数器（缺失回退 0） */
function eventSeq(event: Event): number {
  return event.vectorClock?.[event.author] ?? 0;
}

function parseEntries(events: Event[]): ParsedEntry[] {
  const entries: ParsedEntry[] = [];
  for (const event of events) {
    if (!isPolicyType(event.type)) continue;
    const author = event.author;
    const seq = eventSeq(event);
    if (event.type === NAMESPACE_GRANT_EVENT) {
      const grant = (event.data as { grant?: NamespaceGrantRecord }).grant;
      if (grant && typeof grant.grantId === 'string' && typeof grant.subject === 'string') {
        entries.push({ kind: 'grant', author, seq, issuedAt: grant.issuedAt ?? event.timestamp, id: event.id, grant });
      }
    } else if (event.type === NAMESPACE_REVOKE_EVENT) {
      const revoke = (event.data as { revoke?: NamespaceRevokeRecord }).revoke;
      if (revoke && typeof revoke.grantId === 'string') {
        entries.push({ kind: 'revoke', author, seq, issuedAt: revoke.issuedAt ?? event.timestamp, id: event.id, revoke });
      }
    } else {
      const device = (event.data as { deviceRevoke?: DeviceRevokeRecord }).deviceRevoke;
      if (device && typeof device.subject === 'string') {
        entries.push({ kind: 'device', author, seq, issuedAt: device.issuedAt ?? event.timestamp, id: event.id, device });
      }
    }
  }
  return entries;
}

/**
 * 从策略事件流推导授权/吊销状态（纯函数，便于测试与复用）。
 *
 * 语义：
 * - 只采纳「链到用户主密钥」的事件（由调用方先行过滤 / 或在此逐条校验）；
 * - 事件排序以签发者自身的**单调序列**（`event.vectorClock[author]`）为准，
 *   issuedAt 仅作跨签发者兑底与 tie-break（F-2：不依赖墙钟）；
 * - `namespace_revoke` 按 grantId 精确失效；
 * - `device_revoke` 使该主体在**序列上位于其之前**的授权全部失效，状态为吊销；
 * - **恢复必须使用新的 grantId**（F-3）：被撤销的 grantId 永久失效，复用它再
 *   授予不会恢复；吊销本身也不是终态——之后签发**新的** grant 即恢复；
 * - 主体从未出现 = 拒绝（默认拒绝不放松）。
 */
export function derivePolicyState(entries: ParsedEntry[]): PolicyState {
  const sorted = [...entries].sort(compareEntries);
  // grantId → 该授予的 entry（保留 issuedAt/id 以便与撤销做确定性排序）
  const grants = new Map<string, ParsedEntry>();
  const revokedGrantIds = new Set<string>();
  const latestDeviceRevoke = new Map<string, ParsedEntry>();
  const latestGrant = new Map<string, ParsedEntry>();

  for (const entry of sorted) {
    if (entry.kind === 'grant' && entry.grant) {
      grants.set(entry.grant.grantId, entry);
      const cur = latestGrant.get(entry.grant.subject);
      if (!cur || compareEntries(entry, cur) > 0) {
        latestGrant.set(entry.grant.subject, entry);
      }
    } else if (entry.kind === 'revoke' && entry.revoke) {
      revokedGrantIds.add(entry.revoke.grantId);
    } else if (entry.kind === 'device' && entry.device) {
      const cur = latestDeviceRevoke.get(entry.device.subject);
      if (!cur || compareEntries(entry, cur) > 0) {
        latestDeviceRevoke.set(entry.device.subject, entry);
      }
    }
  }

  const authorized = new Map<string, string[]>();
  const revoked = new Set<string>();
  // 主体集合包含「有 grant 的」与「被 device_revoke 的」：后者即使从未被授予，
  // 吊销也应生效（预防性吊销、且身份吊销本就独立于授权）。
  const subjects = new Set<string>([
    ...[...grants.values()].map((entry) => entry.grant!.subject),
    ...latestDeviceRevoke.keys(),
  ]);
  for (const subject of subjects) {
    const revoke = latestDeviceRevoke.get(subject);
    const grant = latestGrant.get(subject);
    if (revoke && (!grant || compareEntries(revoke, grant) > 0)) {
      // 最后一次操作是设备吊销（其后没有新 grant）→ 吊销
      revoked.add(subject);
      authorized.set(subject, []);
      continue;
    }
    const namespaces = new Set<string>();
    for (const entry of grants.values()) {
      const record = entry.grant!;
      if (record.subject !== subject) continue;
      if (revokedGrantIds.has(record.grantId)) continue;
      if (revoke && compareEntries(entry, revoke) <= 0) continue; // 吊销之前签发的授权失效
      for (const ns of normalizeNamespaceList(record.namespaces)) namespaces.add(ns);
    }
    authorized.set(subject, [...namespaces]);
  }
  return { authorized, revoked };
}

/**
 * 从图上（事件日志）推导授权的 NamespaceGrantPolicy。
 *
 * 每次查询都重新读取策略事件并逐条做信任链校验——策略事件通常很少，且
 * 避免缓存失效的复杂度。`userMasterPublicKey` 缺失时无记录可信 → 默认拒绝。
 */
export class GraphNamespacePolicy implements NamespaceGrantPolicy {
  private readonly eventLog: EventLog;
  private readonly userMasterPublicKey: Uint8Array | null;

  constructor(options: { eventLog: EventLog; userMasterPublicKey?: Uint8Array | null }) {
    this.eventLog = options.eventLog;
    this.userMasterPublicKey = options.userMasterPublicKey ?? null;
  }

  /** 读取策略事件（保留命名空间）并只保留签发者可信者，再推导状态。 */
  async snapshot(): Promise<PolicyState> {
    const events = await this.eventLog.listEvents({ namespace: POLICY_NAMESPACE });
    const trusted: Event[] = [];
    for (const event of events) {
      if (!isPolicyType(event.type)) continue;
      if (await verifyIssuedByUser(event, this.userMasterPublicKey)) trusted.push(event);
    }
    return derivePolicyState(parseEntries(trusted));
  }

  async getAuthorizedNamespaces(peerDeviceId: string): Promise<string[]> {
    return (await this.snapshot()).authorized.get(peerDeviceId) ?? [];
  }

  async getRevokedDevices(): Promise<ReadonlySet<string>> {
    return (await this.snapshot()).revoked;
  }
}
