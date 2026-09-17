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
  /** 不动点是否在迭代上限内**收敛**（false = 到达上限，回退到最保守结果，可观测） */
  converged: boolean;
  /** 实际执行的迭代轮数（诊断） */
  iterations: number;
}

/** 单轮推导的结果（不含不动点诊断字段） */
interface Authority {
  authorized: Map<string, string[]>;
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
  /**
   * 不动点迭代上限（默认 `FIXPOINT_MAX_ITERATIONS`）。仅对边界/测试开放；
   * 便于构造「必然落入回退」的输入以固化 fail-closed 行为。
   */
  maxIterations?: number;
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
 * 实现：**有界不动点**。R-a 只有一处权威实现（`isAuthorizedFor`）；单轮 `deriveOnce`
 * 由三步组成：①时间线种子吊销 → ②权威授权并记录**被采纳的 grantId** → ③用同一批被采纳
 * grant 重算吊销。故 `authorized` 与 `revoked` 同源（F-A）。
 *
 * **为何需要不动点（循环依赖）**：`revokedGrantIds` 必须**排除被吊销签发者发出的
 * `namespace_revoke`**（R-b，F-B），而“某签发者是否被吊销”又依赖 grant 采纳，grant 采纳
 * 又依赖 `revokedGrantIds`。于是以「全部 revoke」为种子迭代：每轮用**权威 `revoked`**
 * 重新过滤 `revokedGrantIds`，直到同输入产出同结果（稳定）或到达上限。
 *
 * **终止条件与回退**：迭代次数有固定上限 `FIXPOINT_MAX_ITERATIONS`，绝不接受无法收敛的
 * 链路。若上限内未稳定，**fail-closed 回退到已算出各轮中「被采纳 revoke 集合最小」的结果**
 * （对 R-b 最保守，即尽量不采纳被吊销签发者的 revoke）；并列时按字典序最小确定性 tie-break。
 * 全过程仅由 `compareEntries` 的确定序驱动，故同一输入在任何端得到同一结果。收敛情况由
 * `PolicyState.converged` / `PolicyState.iterations` 暴露，供日志/告警。
 *
 * 级联：吊销 A → A 的 grant 失效 → 依赖它的 B 在权威授权步因 R-a 失去授权 → B 的转授
 * 也随之不生效（无需额外回溯，见测试）。
 */
function namespacesOf(grant: NamespaceGrantRecord): Set<string> {
  return new Set(normalizeNamespaceList(grant.namespaces));
}

/** R-a 的唯一权威判定：签发者是引导白名单成员，或其**当时**已被授权全部被授予分区 */
function isAuthorizedFor(
  author: string,
  granted: Set<string>,
  authorized: Map<string, Set<string>>,
  bootstrap: ReadonlySet<string>,
): boolean {
  if (bootstrap.has(author)) return true;
  const own = authorized.get(author);
  return own !== undefined && [...granted].every((ns) => own.has(ns));
}

/** 不动点迭代上限（有界，防死循环） */
const FIXPOINT_MAX_ITERATIONS = 3;

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

/** 单轮推导：给定 grantId 撤销集合，产出 `authorized` 与 `revoked`（同源采纳判定） */
function deriveOnce(
  sorted: ParsedEntry[],
  bootstrap: ReadonlySet<string>,
  revokedGrantIds: ReadonlySet<string>,
): Authority {
  // ---- 第 1 步：时间线种子吊销集合（含恢复），供第 2 步 R-b 过滤 ----
  // 被撤销的 grantId 在本步永不采纳，因此无需处理 `namespace_revoke`（撤销集合已给定）。
  const seedRevoked = new Set<string>();
  const provisional = new Map<string, Set<string>>();
  const seedGrants = new Map<string, Map<string, Set<string>>>(); // subject -> grantId -> ns
  for (const entry of sorted) {
    if (seedRevoked.has(entry.author)) continue; // R-b（时间线上）
    if (entry.kind === 'grant' && entry.grant) {
      const grantId = entry.grant.grantId;
      if (revokedGrantIds.has(grantId)) continue; // 被撤销的 grantId 不能清除吊销（F-A）
      const granted = namespacesOf(entry.grant);
      if (!isAuthorizedFor(entry.author, granted, provisional, bootstrap)) continue; // R-a
      let grants = seedGrants.get(entry.grant.subject);
      if (!grants) {
        grants = new Map();
        seedGrants.set(entry.grant.subject, grants);
      }
      grants.set(grantId, granted);
      let union = provisional.get(entry.grant.subject);
      if (!union) {
        union = new Set();
        provisional.set(entry.grant.subject, union);
      }
      for (const ns of granted) union.add(ns);
      seedRevoked.delete(entry.grant.subject); // 被采纳的 grant → 恢复
    } else if (entry.kind === 'device' && entry.device) {
      seedRevoked.add(entry.device.subject);
      seedGrants.get(entry.device.subject)?.clear();
      provisional.delete(entry.device.subject);
    }
  }

  // ---- 第 2 步：权威授权（`authorized`），并记录被采纳的 grantId ----
  const authorized = new Map<string, Set<string>>();
  const adoptedGrantIds = new Set<string>();
  for (const entry of sorted) {
    if (seedRevoked.has(entry.author)) continue; // R-b（按最终候选集合过滤）
    if (entry.kind !== 'grant' || !entry.grant) continue;
    if (revokedGrantIds.has(entry.grant.grantId)) continue; // R-d
    const granted = namespacesOf(entry.grant);
    if (!isAuthorizedFor(entry.author, granted, authorized, bootstrap)) continue; // R-a
    adoptedGrantIds.add(entry.grant.grantId);
    let set = authorized.get(entry.grant.subject);
    if (!set) {
      set = new Set();
      authorized.set(entry.grant.subject, set);
    }
    for (const ns of granted) set.add(ns);
  }

  // ---- 第 3 步：重算吊销（同一批被采纳 grant + 有效 device_revoke）----
  // 被采纳 grant 才能清除吊销 → 被撤销的 grantId 无法“恢复”（F-A）。
  const revoked = new Set<string>();
  for (const entry of sorted) {
    if (revoked.has(entry.author)) continue; // R-b（时间线上）
    if (entry.kind === 'device' && entry.device) {
      revoked.add(entry.device.subject);
    } else if (entry.kind === 'grant' && entry.grant && adoptedGrantIds.has(entry.grant.grantId)) {
      revoked.delete(entry.grant.subject);
    }
  }
  for (const device of revoked) authorized.delete(device); // 被吊销设备读侧 []

  const out = new Map<string, string[]>();
  for (const [subject, set] of authorized) out.set(subject, [...set]);
  return { authorized: out, revoked };
}

/**
 * 比较两个「被采纳 revoke 集合」的保守程度：**集合越小越保守**（越少采纳 revoke，
 * 对 R-b 越安全：不会采纳被吊销签发者的 revoke）；同大小时按**字典序最小**兜底
 * （对排序后的 id 列表逐位比较）→ 完全确定，无关迭代顺序。
 */
function compareRevokeSets(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size !== b.size) return a.size - b.size;
  const av = [...a].sort();
  const bv = [...b].sort();
  for (let i = 0; i < av.length; i++) {
    if (av[i] !== bv[i]) return av[i]! < bv[i]! ? -1 : 1;
  }
  return 0;
}

/**
 * 推导入口：以「全部 revoke」为种子做**有界不动点**（见文件顶部说明）。
 * 每轮用权威 `revoked` 过滤掉被吊销签发者发出的 revoke（R-b），重新单轮推导，
 * 直到稳定或到达上限。
 *
 * **回退（fail-closed）**：未在 `maxIterations` 内收敛时，在已算出的各轮里选
 * 「被采纳 revoke 集合最小」的结果（对 R-b 最保守），而不是回到「全部 revoke 都
 * 采纳」的种子——后者正是被吊销者可以吊销他人的漏洞姿态。选择规则由
 * `compareRevokeSets`（越小越保守；并列取字典序最小）确定，故有界且确定。
 */
export function derivePolicyState(entries: ParsedEntry[], options: DerivePolicyOptions = {}): PolicyState {
  const bootstrap = new Set(options.policyIssuers ?? []);
  const maxIterations = options.maxIterations ?? FIXPOINT_MAX_ITERATIONS;
  // 排序唯一确定迭代顺序，保证同一输入在任何端得到同一结果。
  const sorted = [...entries].sort(compareEntries);

  const allRevokeIds = new Set<string>();
  for (const entry of sorted) {
    if (entry.kind === 'revoke' && entry.revoke) allRevokeIds.add(entry.revoke.grantId);
  }

  let revokedGrantIds = allRevokeIds;
  let current = deriveOnce(sorted, bootstrap, revokedGrantIds);
  const rounds: Array<{ revokedGrantIds: Set<string>; state: Authority }> = [
    { revokedGrantIds, state: current },
  ];

  let converged = false;
  let iterations = 0;
  while (iterations < maxIterations) {
    iterations += 1;
    const next = new Set<string>();
    for (const entry of sorted) {
      // R-b：被吊销签发者发出的 namespace_revoke 不采纳（F-B）
      if (entry.kind === 'revoke' && entry.revoke && !current.revoked.has(entry.author)) {
        next.add(entry.revoke.grantId);
      }
    }
    if (setsEqual(next, revokedGrantIds)) {
      converged = true;
      break;
    }
    revokedGrantIds = next;
    current = deriveOnce(sorted, bootstrap, revokedGrantIds);
    rounds.push({ revokedGrantIds, state: current });
  }

  const chosen = converged
    ? current
    : rounds.reduce((best, round) =>
        compareRevokeSets(round.revokedGrantIds, best.revokedGrantIds) < 0 ? round : best,
      ).state;

  return { authorized: chosen.authorized, revoked: chosen.revoked, converged, iterations };
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
  private readonly maxIterations: number | undefined;

  constructor(options: {
    eventLog: EventLog;
    userMasterPublicKey?: Uint8Array | null;
    /** 引导期签发者白名单（R-a ①），可多台；缺省空 = 只能转授 */
    policyIssuers?: readonly string[];
    /** 不动点迭代上限（边界/测试用）；缺省 `FIXPOINT_MAX_ITERATIONS` */
    maxIterations?: number;
  }) {
    this.eventLog = options.eventLog;
    this.userMasterPublicKey = options.userMasterPublicKey ?? null;
    this.policyIssuers = [...(options.policyIssuers ?? [])];
    this.maxIterations = options.maxIterations;
  }

  /** 读取策略事件（保留命名空间）并只保留签发者可信者，再推导状态。 */
  async snapshot(): Promise<PolicyState> {
    const events = await this.eventLog.listEvents({ namespace: POLICY_NAMESPACE });
    const trusted: Event[] = [];
    for (const event of events) {
      if (!isPolicyType(event.type)) continue;
      if (await verifyIssuedByUser(event, this.userMasterPublicKey)) trusted.push(event);
    }
    return derivePolicyState(parseEntries(trusted), {
      policyIssuers: this.policyIssuers,
      ...(this.maxIterations !== undefined ? { maxIterations: this.maxIterations } : {}),
    });
  }

  async getAuthorizedNamespaces(peerDeviceId: string): Promise<string[]> {
    return (await this.snapshot()).authorized.get(peerDeviceId) ?? [];
  }

  async getRevokedDevices(): Promise<ReadonlySet<string>> {
    return (await this.snapshot()).revoked;
  }
}
