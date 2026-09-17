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
  /**
   * 逻辑时间 = `sum(event.vectorClock)`（R-c）：因果单调（R2 因果后于 R1 ⇒ 严格更大），
   * 用于**跨签发者**定序，不看墙钟。
   */
  logical: number;
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
 * 确定性排序（R-c，不依赖墙钟）：
 * - 同一签发者内：以单调序列 `seq` 为准；
 * - 跨签发者：以逻辑时间 `logical` 为准；
 * - 仍平局（并发）：以 `(author, 内容寻址 id)` 兜底 → 完全确定、两端收敛一致。
 */
function compareEntries(a: ParsedEntry, b: ParsedEntry): number {
  // 同一签发者内 seq 唯一确定先后；跨签发者用逻辑时间；并发再用 author 兜底。
  if (a.author === b.author) return a.seq - b.seq;
  if (a.logical !== b.logical) return a.logical - b.logical;
  return a.author < b.author ? -1 : 1;
}

/** 事件作者自身的单调计数器（缺失回退 0） */
function eventSeq(event: Event): number {
  return event.vectorClock[event.author] ?? 0;
}

/** 逻辑时间 = vectorClock 分量求和（因果单调） */
function eventLogical(event: Event): number {
  let sum = 0;
  for (const value of Object.values(event.vectorClock)) sum += value;
  return sum;
}

/** 解析策略事件（调用方已按 isPolicyType 过滤） */
function parseEntries(events: Event[]): ParsedEntry[] {
  const entries: ParsedEntry[] = [];
  for (const event of events) {
    const author = event.author;
    const seq = eventSeq(event);
    const logical = eventLogical(event);
    if (event.type === NAMESPACE_GRANT_EVENT) {
      const grant = (event.data as { grant?: NamespaceGrantRecord }).grant;
      if (grant && typeof grant.grantId === 'string' && typeof grant.subject === 'string') {
        entries.push({ kind: 'grant', author, seq, logical, id: event.id, grant });
      }
    } else if (event.type === NAMESPACE_REVOKE_EVENT) {
      const revoke = (event.data as { revoke?: NamespaceRevokeRecord }).revoke;
      if (revoke && typeof revoke.grantId === 'string') {
        entries.push({ kind: 'revoke', author, seq, logical, id: event.id, revoke });
      }
    } else {
      const device = (event.data as { deviceRevoke?: DeviceRevokeRecord }).deviceRevoke;
      if (device && typeof device.subject === 'string') {
        entries.push({ kind: 'device', author, seq, logical, id: event.id, device });
      }
    }
  }
  return entries;
}

/** `derivePolicyState` 选项 */
export interface DerivePolicyOptions {
  /**
   * 引导期签发者白名单（R-a ①）：列出的设备可为**任意** namespace 签发。
   * 空/缺省 = 无引导签发者，图上政策只能来自「已被授权者的转授」；
   * 若谁都还没被授权，则图上政策不可签发 → 回退到配置白名单（不放松默认拒绝）。
   */
  policyIssuers?: readonly string[];
}

/**
 * 从策略事件流推导授权/吊销状态（纯函数，便于测试与复用）。
 *
 * 规则（多签发者与授权委托）：
 * - 只采纳「链到用户主密钥」的事件（由调用方先行过滤 / 或在此逐条校验）；
 * - **R-a 不可越权授予**：一条 grant 生效，要求签发者①在 `policyIssuers` 白名单，
 *   或②**当时**已被授权其声明的全部 namespaces（"不能给出自己没有的"）；
 * - **R-b 吊销连坐**：签发者被吊销 → 其记录（含**历史** grant、它发出的
 *   `device_revoke`）一律不采纳；
 * - **R-c**：排序用同一签发者的单调序列 / 跨签发者的逻辑时间 `sum(vectorClock)`，
 *   并发的 `(author, id)` 兜底；不看墙钟；
 * - **R-d**：`namespace_revoke` 按 grantId 精确失效；恢复必须用新 grantId。
 * - 主体从未出现 = 拒绝（默认拒绝不放松）。
 *
 * 实现：**按逻辑序的单遍扫描**。
 * - Phase 1 先扫出吊销集合：`device_revoke` 的签发者只要求「可信 + 未被吊销」
 *   （不要求 namespace 授权）——否则 revocation 会依赖 authorization，互吊销时
 *   会非单调振荡（PLAN 明确避免）；逻辑序在先的 revoke 胜出。
 * - Phase 2 再用**最终**吊销集合排除其签发者的全部记录（含历史），并逐条做 R-a。
 *   越权/依赖已吊销授权的下游转授会因 R-a 自然失效（级联）。
 */
function namespacesOf(grant: NamespaceGrantRecord): Set<string> {
  return new Set(normalizeNamespaceList(grant.namespaces));
}

export function derivePolicyState(entries: ParsedEntry[], options: DerivePolicyOptions = {}): PolicyState {
  const bootstrap = new Set(options.policyIssuers ?? []);
  const sorted = [...entries].sort(compareEntries);

  // ---- Pass A：时间线（逻辑序单遍）——求「当前吊销集合」并支持恢复 ----
  // 被吊销者的记录在线性推进中即被忽略（R-b）；一条**有效**的新 grant 会清除
  // 其主体的吊销状态（R-d 恢复）。device_revoke 的签发者只要求可信 + 未被吊销
  // （不要求 namespace 授权，以免 revocation 依赖 authorization 而互吊销振荡）。
  const revoked = new Set<string>();
  const provisional = new Map<string, Set<string>>(); // 时间线上的主体授权（供 R-a 判定）
  const activeGrants = new Map<string, Map<string, Set<string>>>(); // subject -> grantId -> ns
  const grantSubject = new Map<string, string>(); // grantId -> subject
  const recompute = (subject: string): void => {
    const set = new Set<string>();
    const grants = activeGrants.get(subject);
    if (grants) for (const ns of grants.values()) for (const x of ns) set.add(x);
    if (set.size > 0) provisional.set(subject, set);
    else provisional.delete(subject);
  };

  for (const entry of sorted) {
    if (revoked.has(entry.author)) continue; // R-b：被吊销者的记录不再采纳
    if (entry.kind === 'grant' && entry.grant) {
      const granted = namespacesOf(entry.grant);
      const own = provisional.get(entry.author);
      const issuerOk = bootstrap.has(entry.author) || (own !== undefined && [...granted].every((ns) => own.has(ns)));
      if (!issuerOk) continue; // R-a：不可越权授予
      let grants = activeGrants.get(entry.grant.subject);
      if (!grants) {
        grants = new Map();
        activeGrants.set(entry.grant.subject, grants);
      }
      grants.set(entry.grant.grantId, granted);
      grantSubject.set(entry.grant.grantId, entry.grant.subject);
      recompute(entry.grant.subject);
      revoked.delete(entry.grant.subject); // R-d：吊销后有效新 grant → 恢复
    } else if (entry.kind === 'revoke' && entry.revoke) {
      const subject = grantSubject.get(entry.revoke.grantId);
      if (subject !== undefined) {
        activeGrants.get(subject)?.delete(entry.revoke.grantId);
        grantSubject.delete(entry.revoke.grantId);
        recompute(subject);
      }
    } else if (entry.kind === 'device' && entry.device) {
      revoked.add(entry.device.subject);
      activeGrants.delete(entry.device.subject);
      provisional.delete(entry.device.subject);
    }
  }

  // ---- Pass B：读侧授权（权威结果）----
  // 用**最终**吊销集合排除其签发者的**全部**记录（含历史 grant），再逐条做 R-a。
  // 依赖已吊销权威的下游转授会因 R-a 自然失效（级联）。
  const revokedGrantIds = new Set<string>();
  for (const entry of sorted) {
    if (entry.kind === 'revoke' && entry.revoke && !revoked.has(entry.author)) {
      revokedGrantIds.add(entry.revoke.grantId); // R-d：grantId 精确撤销（与顺序无关）
    }
  }
  const authorized = new Map<string, Set<string>>();
  for (const entry of sorted) {
    if (revoked.has(entry.author)) continue; // R-b：被吊销签发者的记录（含历史）不采纳
    if (entry.kind !== 'grant' || !entry.grant) continue;
    if (revokedGrantIds.has(entry.grant.grantId)) continue;
    const granted = namespacesOf(entry.grant);
    if (!bootstrap.has(entry.author)) {
      const own = authorized.get(entry.author);
      if (!own || ![...granted].every((ns) => own.has(ns))) continue; // R-a
    }
    let set = authorized.get(entry.grant.subject);
    if (!set) {
      set = new Set();
      authorized.set(entry.grant.subject, set);
    }
    for (const ns of granted) set.add(ns);
  }
  for (const device of revoked) authorized.delete(device); // 被吊销设备读侧 []

  const out = new Map<string, string[]>();
  for (const [subject, set] of authorized) out.set(subject, [...set]);
  return { authorized: out, revoked };
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
  private readonly policyIssuers: string[];

  constructor(options: {
    eventLog: EventLog;
    userMasterPublicKey?: Uint8Array | null;
    /** 引导期签发者白名单（R-a ①），可多台；缺省空 = 只能转授 */
    policyIssuers?: readonly string[];
  }) {
    this.eventLog = options.eventLog;
    this.userMasterPublicKey = options.userMasterPublicKey ?? null;
    this.policyIssuers = [...(options.policyIssuers ?? [])];
  }

  /** 读取策略事件（保留命名空间）并只保留签发者可信者，再推导状态。 */
  async snapshot(): Promise<PolicyState> {
    const events = await this.eventLog.listEvents({ namespace: POLICY_NAMESPACE });
    const trusted: Event[] = [];
    for (const event of events) {
      if (!isPolicyType(event.type)) continue;
      if (await verifyIssuedByUser(event, this.userMasterPublicKey)) trusted.push(event);
    }
    return derivePolicyState(parseEntries(trusted), { policyIssuers: this.policyIssuers });
  }

  async getAuthorizedNamespaces(peerDeviceId: string): Promise<string[]> {
    return (await this.snapshot()).authorized.get(peerDeviceId) ?? [];
  }

  async getRevokedDevices(): Promise<ReadonlySet<string>> {
    return (await this.snapshot()).revoked;
  }
}
