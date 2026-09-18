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
/** C1：把「谁是引导签发者」声明上图（与 `namespace_grant` 等同在 `__policy__`）。 */
export const POLICY_ISSUER_DECLARE_EVENT = 'policy_issuer_declare';
/** M1：持久、签名的**成员资格**记录（订阅=成员资格）。 */
export const NAMESPACE_MEMBERSHIP_EVENT = 'namespace_membership';
/**
 * 2b：**交接记录**（退订方签名写入 `__policy__`，可审计）。**不参与授权/成员推导**
 * （仅审计产物），因此不改变 `derivePolicyState` 的结果。
 */
export const NAMESPACE_HANDOFF_EVENT = 'namespace_handoff';

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

/**
 * C1 引导签发者声明：把 `subject` 声明为引导签发者（bootstrap issuer）。
 *
 * 采纳**不做 R-a**（无条件，仅要求签发者可信且未被吊销、主体未被吊销）——因此与不动点无循环依赖；
 * 生效集合 = 图上被采纳声明 ∪ 本地配置 `sync.policyIssuers`。
 */
export interface PolicyIssuerDeclareRecord {
  /** 被声明为引导签发者的设备 ID */
  subject: string;
  issuedAt: number;
  note?: string;
}

/**
 * M1 成员资格记录：设备 `member` 在分区 `namespace` 的成员状态。
 *
 * 采纳**不做 R-a**（无条件，仅要求签发者与成员可信且未被吊销）→ 与不动点无循环依赖。
 * 同一 `(namespace, member)` 取 R-c 定序下**最新记录**的 `active`（在册/注销）。
 * 生效成员集合还需 ∩ 该设备对该分区的**生效授权**（授权默认拒绝不变）。
 */
export interface NamespaceMembershipRecord {
  /** 成员设备 ID */
  member: string;
  /** 分区 */
  namespace: string;
  /** true=在册，false=注销 */
  active: boolean;
  issuedAt: number;
  note?: string;
}

/**
 * 2b 交接记录：退订方在**本地彻底清理前**签名写入 `__policy__` 的审计产物。
 * 记录被指定的继任者、验证结论（`forced` 与未覆盖作者明细）与时间。
 * 仅审计：不参与 `derivePolicyState`（授权/吊销/签发者/成员）。
 */
export interface NamespaceHandoffRecord {
  handoffId: string;
  namespace: string;
  /** 继任者设备 ID */
  successor: string;
  /** true = 跳过全量 ack 门禁（仅本地 CLI 可用） */
  forced: boolean;
  /** 校验时退订方仍持有、继任者尚未 ack 的事件数（0 = 已全量覆盖） */
  pendingCount: number;
  /** 未完全覆盖的作者（诊断） */
  missingAuthors?: string[];
  issuedAt: number;
  note?: string;
}

/** 从图上推导出的策略快照：每个主体的生效授权 + 被吊销设备集合。 */
export interface PolicyState {
  /** subject → 生效分区白名单（未出现 = 拒绝） */
  authorized: Map<string, string[]>;
  /** 当前处于吊销状态的设备 */
  revoked: Set<string>;
  /** C1：生效引导签发者集合（图上被采纳声明 ∪ 配置 bootstrap） */
  issuers: Set<string>;
  /** M1：`namespace → 在册成员集合`（采纳且 active；尚未 ∩ 授权） */
  members: Map<string, Set<string>>;
  /** M1：出现≥1 条被采纳成员记录的分区（= 已启用成员资格，须强制闸门） */
  membershipNamespaces: Set<string>;
  /** 不动点是否在迭代上限内**收敛**（false = 到达上限，回退到最保守结果，可观测） */
  converged: boolean;
  /** 实际执行的迭代轮数（诊断） */
  iterations: number;
}

/** 单轮推导的结果（不含不动点诊断字段） */
interface Authority {
  authorized: Map<string, string[]>;
  revoked: Set<string>;
  issuers: Set<string>;
  members: Map<string, Set<string>>;
  membershipNamespaces: Set<string>;
}

interface ParsedEntry {
  kind: 'grant' | 'revoke' | 'device' | 'issuer' | 'membership';
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
  issuer?: PolicyIssuerDeclareRecord;
  membership?: NamespaceMembershipRecord;
}

function isPolicyType(type: string): boolean {
  return (
    type === NAMESPACE_GRANT_EVENT ||
    type === NAMESPACE_REVOKE_EVENT ||
    type === DEVICE_REVOKE_EVENT ||
    type === POLICY_ISSUER_DECLARE_EVENT ||
    type === NAMESPACE_MEMBERSHIP_EVENT
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
    } else if (event.type === POLICY_ISSUER_DECLARE_EVENT) {
      const issuer = (event.data as { policyIssuer?: PolicyIssuerDeclareRecord }).policyIssuer;
      if (issuer && typeof issuer.subject === 'string') {
        entries.push({ kind: 'issuer', author, seq, logical, id: event.id, issuer });
      }
    } else if (event.type === NAMESPACE_MEMBERSHIP_EVENT) {
      const membership = (event.data as { membership?: NamespaceMembershipRecord }).membership;
      if (
        membership &&
        typeof membership.member === 'string' &&
        typeof membership.namespace === 'string' &&
        typeof membership.active === 'boolean'
      ) {
        entries.push({ kind: 'membership', author, seq, logical, id: event.id, membership });
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
   * 不动点迭代上限**覆盖**（测试专用注入；**生产路径不得使用**）。
   * 缺省 = 输入的确定性函数 `2·|entries| + 2`（见 `iterationBound`）——该默认值是**协议语义**，
   * 改它会破坏跨端一致性，需全端同版本。本选项仅用于构造「必然落入回退」或「慢收敛」的边界用例。
   *
   * @internal
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
 * 又依赖 `revokedGrantIds`。于是迭代未知量对 `(revokedGrantIds, revokedIn)`：每轮用上一轮
 * 的 `revoked` 过滤 `revokedGrantIds` 并作为 R-b 作者排除，直到同输入产出同结果（稳定）
 * 或到达上限。种子取 `(∅, ∅)`——**天然 fail-closed**。
 *
 * **终止条件与回退**：迭代上限是**输入的确定性函数** `2·|entries| + 2`（`iterationBound`；
 * 属协议语义，见 `POLICY-INVARIANTS.md` §2.4），绝不接受无法收敛的链路。若上限内未稳定，
 * 回退到一个**两轴皆保守**的闭包：以各轮吊销并集为初始排除集 `excluded`，**只增不减**地迭代，每轮以
 * `filterRevokes(excluded)` 为被采纳 revoke 集、`excluded` 为签发者排除集，直到
 * `revoked ⊆ excluded`——即输出里每个被吊销设备的记录都不被采纳，**R-b 在回退路径上字面成立**。
 * `excluded` 单调增长且有上界（设备全集）→ 必终止；另设硬上限 `2·|entries|+1` 兜底。
 * 两轴皆偏保守：设备吊销轴排除更多签发者；撤销轴只采纳**非排除**签发者的 revoke（少 grant
 * → 少授权/少恢复），**绝不放宽 R-b、绝不 fail-open**。全过程仅由确定序驱动，故同一输入在
 * 任何端得到同一结果。收敛情况由 `PolicyState.converged` / `iterations` 暴露。
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

/**
 * 不动点迭代上限 = **输入的确定性纯函数**：`2·|entries| + 2`。
 *
 * 只用输入规模，不依赖配置 / 环境变量 / 时钟 → **同一输入在任何端得到同一上限**（协议语义，
 * 见 `POLICY-INVARIANTS.md` §2.4；改它属破坏性协议变更，需全端同版本）。
 * 依据：慢收敛链的轮数随记录数近线性增长（实测最大 ≈1.3·|entries|）；仅 `|entries|+1` 不足
 * （存在 7 条记录需 9 轮的确定性反例），此处取 ~2× 余量。
 *
 * （历史：曾为常量 8；该值会让合法的「慢收敛」链误入回退，已移除。）
 */
function iterationBound(entries: ParsedEntry[]): number {
  return 2 * entries.length + 2;
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

/**
 * 单轮推导：给定「被采纳 revoke 集合」`revokedGrantIds` 与「R-b 作者排除集合」
 * `revokedIn`（上一轮输出的 `revoked`），产出 `authorized` 与 `revoked`。
 * 两者都由**同一批被采纳 grant** 决定（F-A：只有被采纳的 grant 才清除吊销）。
 */
/**
 * C1：生效引导集合 = 配置 bootstrap ∪ 图上**被采纳**的 `policy_issuer_declare` 主体。
 *
 * 采纳**不做 R-a**（无条件），因此只是 `(sorted, configured, revokedIn)` 的纯函数、不引入新的
 * 不动点未知量；但受 R-b 约束：**签发者**（其记录不采纳）或**被声明主体**被吊销 → 不采纳。
 */
function effectiveIssuers(
  sorted: ParsedEntry[],
  configured: ReadonlySet<string>,
  revokedIn: ReadonlySet<string>,
): Set<string> {
  const issuers = new Set(configured);
  for (const entry of sorted) {
    if (entry.kind !== 'issuer' || !entry.issuer) continue;
    if (revokedIn.has(entry.author)) continue; // R-b：被吊销签发者的记录不采纳
    if (revokedIn.has(entry.issuer.subject)) continue; // R-b：被吊销设备不得因声明成为签发者
    issuers.add(entry.issuer.subject);
  }
  return issuers;
}

/**
 * M1：从成员记录推导「分区 → 在册成员集合」与「已启用成员资格的分区」。
 *
 * 纯函数于 `(sorted, revokedIn)`（不做 R-a）→ 不引入新不动点未知量。R-b：签发者或成员被吊销
 * 的记录不采纳。`sorted` 已是 R-c 确定序，故同一 `(namespace, member)` **后者胜**（最新记录）。
 */
function deriveMembership(
  sorted: ParsedEntry[],
  revokedIn: ReadonlySet<string>,
): { members: Map<string, Set<string>>; namespaces: Set<string> } {
  const latest = new Map<string, boolean>();
  const namespaces = new Set<string>();
  for (const entry of sorted) {
    if (entry.kind !== 'membership' || !entry.membership) continue;
    if (revokedIn.has(entry.author)) continue; // R-b：被吊销签发者的记录不采纳
    if (revokedIn.has(entry.membership.member)) continue; // R-b：被吊销成员不采纳
    const { namespace, member, active } = entry.membership;
    namespaces.add(namespace);
    latest.set(`${namespace}\u0000${member}`, active);
  }
  const members = new Map<string, Set<string>>();
  for (const [key, active] of latest) {
    if (!active) continue;
    const sep = key.indexOf('\u0000');
    const namespace = key.slice(0, sep);
    const member = key.slice(sep + 1);
    let set = members.get(namespace);
    if (!set) {
      set = new Set();
      members.set(namespace, set);
    }
    set.add(member);
  }
  return { members, namespaces };
}

function deriveOnce(
  sorted: ParsedEntry[],
  bootstrap: ReadonlySet<string>,
  revokedGrantIds: ReadonlySet<string>,
  revokedIn: ReadonlySet<string>,
): Authority {
  // C1：R-a 的引导白名单改为「生效引导集合」（图上声明 ∪ 配置）。
  const issuers = effectiveIssuers(sorted, bootstrap, revokedIn);
  // 权威授权：R-b（revokedIn）→ R-d（grantId 撤销）→ R-a
  const authorized = new Map<string, Set<string>>();
  const adoptedGrantIds = new Set<string>();
  for (const entry of sorted) {
    if (revokedIn.has(entry.author)) continue; // R-b：被吊销签发者的记录不采纳
    if (entry.kind !== 'grant' || !entry.grant) continue;
    if (revokedGrantIds.has(entry.grant.grantId)) continue; // R-d：grantId 精确撤销
    const granted = namespacesOf(entry.grant);
    if (!isAuthorizedFor(entry.author, granted, authorized, issuers)) continue; // R-a
    adoptedGrantIds.add(entry.grant.grantId);
    let set = authorized.get(entry.grant.subject);
    if (!set) {
      set = new Set();
      authorized.set(entry.grant.subject, set);
    }
    for (const ns of granted) set.add(ns);
  }

  // 吊销：按逻辑序单遍；被采纳 grant 清除其主体的吊销（R-d 恢复）。
  const revoked = new Set<string>();
  for (const entry of sorted) {
    // R-b：被吊销签发者的记录一律不采纳——既包括**权威排除集** `revokedIn`（覆盖其**历史**
    // 记录，F-1），也包括本轮在途已判吊销者（互吊销按逻辑序确定，见「R-b 互吊销」）。
    if (revokedIn.has(entry.author) || revoked.has(entry.author)) continue;
    if (entry.kind === 'device' && entry.device) {
      // 自吊销（subject === author）语义未定义，且与 R-b 自指冲突（吊销后其记录不再被采纳 →
      // 反而无法维持吊销）。不予采纳：吊销须由**其他**设备发起。
      if (entry.device.subject !== entry.author) revoked.add(entry.device.subject);
    } else if (entry.kind === 'grant' && entry.grant && adoptedGrantIds.has(entry.grant.grantId)) {
      revoked.delete(entry.grant.subject);
    }
  }
  for (const device of revoked) authorized.delete(device); // 被吊销设备读侧 []

  const out = new Map<string, string[]>();
  for (const [subject, set] of authorized) out.set(subject, [...set]);
  const membership = deriveMembership(sorted, revokedIn);
  return { authorized: out, revoked, issuers, members: membership.members, membershipNamespaces: membership.namespaces };
}

/** 由权威 `revoked` 过滤出应被采纳的 revoke（R-b：排除被吊销签发者发出的 revoke） */
function filterRevokes(sorted: ParsedEntry[], revoked: ReadonlySet<string>): Set<string> {
  const next = new Set<string>();
  for (const entry of sorted) {
    if (entry.kind === 'revoke' && entry.revoke && !revoked.has(entry.author)) {
      next.add(entry.revoke.grantId);
    }
  }
  return next;
}

/**
 * 推导入口：**有界不动点**（见文件顶部说明）。未知量为「被采纳的 revoke 集合」`R`
 * 与「R-b 作者排除集合」`revokedIn`（上一轮输出的 `revoked`）。种子取
 * `R = ∅` 且 `revokedIn = ∅`：**天然 fail-closed**（绝不采纳被吊销签发者的 revoke），
 * 随后迭代把「未被吊销签发者发出的 revoke」纳入。每轮迭代均由确定序驱动。
 *
 * **终止与回退**：迭代上限 `maxIterations`；未收敛时回退到**两轴皆保守**的闭包
 * （每轮用 `filterRevokes(excluded)` 与排除集 `excluded`，直到 `revoked ⊆ excluded`；
 * 见文件顶部说明），整体绝不放宽 R-b、绝不 fail-open。
 */
export function derivePolicyState(entries: ParsedEntry[], options: DerivePolicyOptions = {}): PolicyState {
  const bootstrap = new Set(options.policyIssuers ?? []);
  const maxIterations = options.maxIterations ?? iterationBound(entries);
  // 排序唯一确定迭代顺序，保证同一输入在任何端得到同一结果。
  const sorted = [...entries].sort(compareEntries);

  let revokedGrantIds = new Set<string>();
  let revokedIn = new Set<string>();
  let current = deriveOnce(sorted, bootstrap, revokedGrantIds, revokedIn);
  const rounds: Array<{ revokedGrantIds: Set<string>; state: Authority }> = [
    { revokedGrantIds, state: current },
  ];

  let converged = false;
  let iterations = 0;
  while (iterations < maxIterations) {
    iterations += 1;
    const nextRevokes = filterRevokes(sorted, current.revoked);
    if (setsEqual(nextRevokes, revokedGrantIds) && setsEqual(current.revoked, revokedIn)) {
      converged = true;
      break;
    }
    revokedGrantIds = nextRevokes;
    revokedIn = current.revoked;
    current = deriveOnce(sorted, bootstrap, revokedGrantIds, revokedIn);
    rounds.push({ revokedGrantIds, state: current });
  }

  // 未收敛 → 两轴皆保守的闭包。从各轮吊销并集出发，只增不减地迭代，每轮：
  //  - 被采纳 revoke 集 = `filterRevokes(sorted, excluded)`（非排除签发者的 revoke 仍生效）；
  //  - 签发者排除集 = `excluded`；
  // 直到输出 `revoked ⊆ excluded`（R-b 字面成立：输出里每个被吊销设备的记录都不被采纳）。
  // 终止性：`excluded` 单调增长、上界为设备全集 → ≤|devices| 轮；硬上限 `2·|entries|+1` 兜底
  // （超出则取最后一轮，`converged=false` 保持不变）。
  let chosen = current;
  if (!converged) {
    const excluded = new Set<string>();
    for (const round of rounds) for (const device of round.state.revoked) excluded.add(device);
    const hardCap = 2 * sorted.length + 1;
    for (let guard = 0; guard < hardCap; guard += 1) {
      const candidate = deriveOnce(sorted, bootstrap, filterRevokes(sorted, excluded), excluded);
      chosen = candidate;
      let grew = false;
      for (const device of candidate.revoked) {
        if (!excluded.has(device)) {
          excluded.add(device);
          grew = true;
        }
      }
      if (!grew) break;
    }
  }

  return {
    authorized: chosen.authorized,
    revoked: chosen.revoked,
    issuers: chosen.issuers,
    members: chosen.members,
    membershipNamespaces: chosen.membershipNamespaces,
    converged,
    iterations,
  };
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
    // 生产路径恒用输入的确定性上限 `iterationBound(entries)`（不可由构造选项注入，
    // 避免各端上限不同导致权威集不一致）。
    return derivePolicyState(parseEntries(trusted), { policyIssuers: this.policyIssuers });
  }

  async getAuthorizedNamespaces(peerDeviceId: string): Promise<string[]> {
    return (await this.snapshot()).authorized.get(peerDeviceId) ?? [];
  }

  /** C1：当前生效引导签发者集合（图上被采纳声明 ∪ 构造时配置的 bootstrap）。 */
  async getPolicyIssuers(): Promise<string[]> {
    return [...(await this.snapshot()).issuers].sort();
  }

  /**
   * M1：某分区的成员资格。`active=false` 表示**该分区尚无被采纳的成员记录**（未启用成员资格，
   * 调用方沿用旧行为）；`active=true` 时 `members` 为在册成员（已 ∩ 授权由上层完成）。
   */
  async getNamespaceMembership(namespace: string): Promise<{ active: boolean; members: string[] }> {
    const state = await this.snapshot();
    return {
      active: state.membershipNamespaces.has(namespace),
      members: [...(state.members.get(namespace) ?? [])].sort(),
    };
  }

  async getRevokedDevices(): Promise<ReadonlySet<string>> {
    return (await this.snapshot()).revoked;
  }
}
