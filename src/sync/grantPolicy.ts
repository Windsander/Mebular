// 授权作为记忆（Phase 2 · D）与身份吊销（Phase 2 · E）的图上策略。
//
// 授权不再是逐机漂移的本地配置，而是**签发者签名**的记录，落在保留策略
// 命名空间 `__policy__`：全 fleet 可见、可审计、可撤销，且不可被被授权方自授。
//
// 信任根复用现有证书链（`verifyIssuedByUser`）：只有链到用户主密钥的设备
// 签发的记录才被采纳；其余（自授、别家用户、无证书伪造）一律忽略。
//
// 本文件只做「从图上推导授权/吊销状态」，不引入任何任务/调度/执行语义。

import { createHash } from 'node:crypto';
import type { Event } from '../types/event.js';
import type { EventLog } from '../eventlog/EventLog.js';
import { normalizeNamespaceList } from '../core/namespace.js';
import type { NamespaceGrantPolicy } from './namespacePolicy.js';
import { verifyIssuedByUser } from './trust.js';
import {
  base64ToBytes,
  hexToBytes,
  verifyCertificateChain,
  type DeviceCertificate,
} from '../p2p/handshake/AuthenticationHandshake.js';

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

// ---------------------------------------------------------------------------
// S1 · 安全等级（low / medium / high）与会签证明
// ---------------------------------------------------------------------------
//
// **线协议零新增消息类型**（SPEC §3.9）：三档的全部新增载体都是
// `__policy__` 里的**新事件类型**（旧端 `isPolicyType` 不含 → 忽略，A 类）
// 与既有记录的**可选证明字段**（旧端忽略未知字段，A 类）。不新增任何
// auth-* / sync-* 帧，也不改加入令牌格式。

/** 等级记录事件类型。 */
export const SECURITY_TIER_EVENT = 'security_tier';
/** 会签请求/批准/拒绝记录事件类型（流程载体 + 审计，不改变授权）。 */
export const SECURITY_APPROVAL_EVENT = 'security_approval';
/** 恢复码公钥登记/轮换记录事件类型（审计 + 登记）。 */
export const SECURITY_RECOVERY_EVENT = 'security_recovery';

export type SecurityLevel = 'low' | 'medium' | 'high';
export type SecurityOp = 'kick' | 'join' | 'tier' | 'rotate';

/**
 * 会签证明：另一台已受信且已准入的设备对**本次动作摘要**的设备密钥签名。
 *
 * `issuedAt/expiresAt` 是**流程/UI 元数据**；推导与预检层**永不读取**（SPEC §3.4）——
 * 已采纳记录不随墙钟翻转，`expiresAt` 只约束发起方提交前的执行窗口。
 */
export interface CosignProof {
  v: 1;
  op: SecurityOp;
  /** 批准设备 deviceId（≠ 记录作者，≠ 动作对象） */
  approver: string;
  /** 叶→根；锚定主公钥（自包含，防依赖图序） */
  approverCertificateChain: DeviceCertificate[];
  /** 指向 security_approval(approve) 记录（R-c 因果校验用） */
  approvalId: string;
  /** sha256hex(canonicalAction(op, ...))（SPEC §3.2） */
  digest: string;
  /** 人类比对码（由 digest 确定性派生，不传输、不存种） */
  pairingCode: string;
  issuedAt: number;
  /** 流程元数据；推导/预检层不判 */
  expiresAt: number;
  /** base64：批准设备私钥签 canonical(CosignProof 除 signature) */
  signature: string;
}

/** 恢复码（break-glass）证明：离线凭据签名，替代会签。 */
export interface BreakGlassProof {
  v: 1;
  op: SecurityOp;
  /** 指向已采纳的 security_recovery 记录（须在 R-c 序更早） */
  keyId: string;
  digest: string;
  /** 一次性消费（同一 keyId 下 nonce 不可重复） */
  nonce: string;
  issuedAt: number;
  /** 流程元数据；推导/预检层不判 */
  expiresAt: number;
  signature: string;
}

/** 等级记录（`__policy__`；C3 A 类）。 */
export interface SecurityTierRecord {
  level: SecurityLevel;
  /** 本次变更唯一号（进入 cosign digest） */
  nonce: string;
  /** 仅审计；定序用 R-c（vectorClock），不看墙钟 */
  issuedAt: number;
  note?: string;
  /** 本记录把档位**从 high** 改出时必需（网络规则） */
  cosign?: CosignProof;
  breakGlass?: BreakGlassProof;
}

/** 会签请求/批准/拒绝记录。 */
export interface SecurityApprovalRecord {
  approvalId: string;
  /** `rotate` 用于恢复码初始登记/轮换（§3.4D；初始登记 oldKeyId = '' 哨兵） */
  op: 'kick' | 'join' | 'tier' | 'rotate';
  decision: 'request' | 'approve' | 'deny';
  /** request 作者 = 发起设备 */
  initiator: string;
  /** kick: 被踢设备；join: 可缺省 */
  target?: string;
  namespace?: string;
  level?: SecurityLevel;
  nonce: string;
  /** 由发起方计算并公开，供批准侧核对 */
  digest: string;
  pairingCode: string;
  /** decision='approve' 时携带（approver 签署） */
  cosign?: CosignProof;
  /** 流程元数据；推导/预检层不判 */
  expiresAt: number;
  issuedAt: number;
  note?: string;
}

/** 恢复码公钥登记/轮换记录。 */
export interface SecurityRecoveryRecord {
  keyId: string;
  publicKey: string;
  createdAt: number;
  mode: 'set' | 'rotate';
  /** rotate 的动作 nonce（进入 digest；`set` 可缺省） */
  nonce?: string;
  note?: string;
  cosign?: CosignProof;
  breakGlass?: BreakGlassProof;
}

/** §3.4E 拒绝原因枚举（`expiresAt` 相关原因**不在**枚举内——无墙钟判定）。 */
export type SecurityRejectionReason =
  | 'missing-proof'
  | 'invalid-proof'
  | 'approval-missing-or-not-causal'
  | 'approval-approver-revoked-at-its-order'
  | 'approver-not-admitted-at-approval'
  | 'approver-equals-author'
  | 'approver-equals-subject'
  | 'stale-or-replayed-nonce';

export interface SecurityRejection {
  eventId: string;
  reason: SecurityRejectionReason;
}

/** `PolicyState.security` 子对象（SPEC §1.5；`admitted` 必须暴露）。 */
export interface SecurityPolicyState {
  level: SecurityLevel;
  changedAt?: number;
  changedBy?: string;
  /** 有资格担任会签批准人的设备（§3.5） */
  admitted: string[];
  recoveryKeyId?: string;
  rejections: SecurityRejection[];
}

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
  /** S1：加入动作 nonce（high 档首现验收用；进入 digest） */
  nonce?: string;
  /** S1：join 动作发起设备（批准侧填写；缺省 = 记录作者） */
  initiator?: string;
  cosign?: CosignProof;
  breakGlass?: BreakGlassProof;
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
  /** S1：kick 动作 nonce（high 档必需；进入 digest） */
  nonce?: string;
  cosign?: CosignProof;
  breakGlass?: BreakGlassProof;
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
 *
 * **闸门启用（W1-B）**：分区进入「已启用成员资格」当且仅当存在被采纳的 `active=true` 记录；
 * 注销记录不启用闸门（只有注销记录的分区与 legacy/从未有记录一致）。
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
  /** S1：join 动作 nonce（high 档首现验收用；进入 digest） */
  nonce?: string;
  /** S1：join 动作发起设备（缺省 = 记录作者） */
  initiator?: string;
  cosign?: CosignProof;
  breakGlass?: BreakGlassProof;
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
  /**
   * M1：出现≥1 条被采纳 **active=true** 成员记录的分区（= 已启用成员资格，须强制闸门）。
   * W1-B 起**仅** active=true 记录启用——只有注销记录（或没有记录）的分区不启用（legacy 语义）。
   */
  membershipNamespaces: Set<string>;
  /** 不动点是否在迭代上限内**收敛**（false = 到达上限，回退到最保守结果，可观测） */
  converged: boolean;
  /** 实际执行的迭代轮数（诊断） */
  iterations: number;
  /**
   * S1：安全等级子对象（仅有安全记录时出现；纯旧记录输入不出现 →
   * 与基线 `23a4468ad` 的 `PolicyState` 形状逐字节一致）。
   */
  security?: SecurityPolicyState;
}

/** §3.4E 拒绝诊断的累计器（确定性顺序 = R-c 处理顺序）。 */
interface SecurityPassResult {
  security: SecurityPolicyState;
  /** 被安全门槛拒绝的 grant/membership 事件 ID（下一轮授权/成员推导跳过） */
  rejectedJoinIds: Set<string>;
  /** 被安全门槛拒绝的 device_revoke 事件 ID（下一轮吊销推导跳过） */
  rejectedRevokeIds: Set<string>;
  /** 是否存在任何安全记录（决定是否暴露 `security`） */
  present: boolean;
}

/** 单轮推导的结果（不含不动点诊断字段） */
interface Authority {
  authorized: Map<string, string[]>;
  revoked: Set<string>;
  issuers: Set<string>;
  members: Map<string, Set<string>>;
  membershipNamespaces: Set<string>;
  security: SecurityPassResult;
}

interface ParsedEntry {
  kind: 'grant' | 'revoke' | 'device' | 'issuer' | 'membership' | 'tier' | 'approval' | 'recovery';
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
  tier?: SecurityTierRecord;
  approval?: SecurityApprovalRecord;
  recovery?: SecurityRecoveryRecord;
  /** 记录体上内嵌的证明（与 cosign/breakGlass 同名字段一一对应） */
  cosign?: CosignProof;
  breakGlass?: BreakGlassProof;
  /**
   * 异步预检结果（信任过滤阶段产出；**不含墙钟**）：
   * 链锚定 ∧ approver/恢复码签名 ∧ 结构完整。缺省 = 未通过（fail-closed）。
   */
  cosignWellFormed?: boolean;
  breakGlassWellFormed?: boolean;
  /** `security_approval(approve)` 自带 cosign 的预检结果 */
  approvalCosignWellFormed?: boolean;
}

function isPolicyType(type: string): boolean {
  return (
    type === NAMESPACE_GRANT_EVENT ||
    type === NAMESPACE_REVOKE_EVENT ||
    type === DEVICE_REVOKE_EVENT ||
    type === POLICY_ISSUER_DECLARE_EVENT ||
    type === NAMESPACE_MEMBERSHIP_EVENT ||
    type === SECURITY_TIER_EVENT ||
    type === SECURITY_APPROVAL_EVENT ||
    type === SECURITY_RECOVERY_EVENT
  );
}

function isSecurityLevel(value: unknown): value is SecurityLevel {
  return value === 'low' || value === 'medium' || value === 'high';
}

function proofFields(data: object): {
  cosign?: CosignProof;
  breakGlass?: BreakGlassProof;
} {
  const cosign = (data as { cosign?: CosignProof }).cosign;
  const breakGlass = (data as { breakGlass?: BreakGlassProof }).breakGlass;
  return {
    ...(cosign && typeof cosign === 'object' ? { cosign } : {}),
    ...(breakGlass && typeof breakGlass === 'object' ? { breakGlass } : {}),
  };
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
    const data = event.data as Record<string, unknown>;
    if (event.type === NAMESPACE_GRANT_EVENT) {
      const grant = (data as { grant?: NamespaceGrantRecord }).grant;
      if (grant && typeof grant.grantId === 'string' && typeof grant.subject === 'string') {
        entries.push({ kind: 'grant', author, seq, logical, id: event.id, grant, ...proofFields(grant) });
      }
    } else if (event.type === NAMESPACE_REVOKE_EVENT) {
      const revoke = (data as { revoke?: NamespaceRevokeRecord }).revoke;
      if (revoke && typeof revoke.grantId === 'string') {
        entries.push({ kind: 'revoke', author, seq, logical, id: event.id, revoke });
      }
    } else if (event.type === POLICY_ISSUER_DECLARE_EVENT) {
      const issuer = (data as { policyIssuer?: PolicyIssuerDeclareRecord }).policyIssuer;
      if (issuer && typeof issuer.subject === 'string') {
        entries.push({ kind: 'issuer', author, seq, logical, id: event.id, issuer });
      }
    } else if (event.type === NAMESPACE_MEMBERSHIP_EVENT) {
      const membership = (data as { membership?: NamespaceMembershipRecord }).membership;
      if (
        membership &&
        typeof membership.member === 'string' &&
        typeof membership.namespace === 'string' &&
        typeof membership.active === 'boolean'
      ) {
        entries.push({ kind: 'membership', author, seq, logical, id: event.id, membership, ...proofFields(membership) });
      }
    } else if (event.type === SECURITY_TIER_EVENT) {
      const securityTier = (data as { securityTier?: SecurityTierRecord }).securityTier;
      if (
        securityTier &&
        isSecurityLevel(securityTier.level) &&
        typeof securityTier.nonce === 'string'
      ) {
        entries.push({
          kind: 'tier',
          author,
          seq,
          logical,
          id: event.id,
          tier: securityTier,
          ...proofFields(securityTier),
        });
      }
    } else if (event.type === SECURITY_APPROVAL_EVENT) {
      const securityApproval = (data as { securityApproval?: SecurityApprovalRecord }).securityApproval;
      if (
        securityApproval &&
        typeof securityApproval.approvalId === 'string' &&
        typeof securityApproval.initiator === 'string' &&
        typeof securityApproval.nonce === 'string' &&
        typeof securityApproval.digest === 'string'
      ) {
        entries.push({
          kind: 'approval',
          author,
          seq,
          logical,
          id: event.id,
          approval: securityApproval,
        });
      }
    } else if (event.type === SECURITY_RECOVERY_EVENT) {
      const securityRecovery = (data as { securityRecovery?: SecurityRecoveryRecord }).securityRecovery;
      if (
        securityRecovery &&
        typeof securityRecovery.keyId === 'string' &&
        typeof securityRecovery.publicKey === 'string'
      ) {
        entries.push({
          kind: 'recovery',
          author,
          seq,
          logical,
          id: event.id,
          recovery: securityRecovery,
          ...proofFields(securityRecovery),
        });
      }
    } else {
      const device = (data as { deviceRevoke?: DeviceRevokeRecord }).deviceRevoke;
      if (device && typeof device.subject === 'string') {
        entries.push({ kind: 'device', author, seq, logical, id: event.id, device, ...proofFields(device) });
      }
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// 动作摘要 / 配对号 / 证明预检（SPEC §3.2、§3.4）
// ---------------------------------------------------------------------------

/** 稳定 JSON 序列化：对象键递归排序、无空白。用于证明签名覆盖的规范数据。 */
function stableCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableCanonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableCanonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export type SecurityAction =
  | { op: 'kick'; initiator: string; subject: string; nonce: string }
  | { op: 'join'; initiator: string; namespace: string; nonce: string }
  | { op: 'tier'; initiator: string; level: SecurityLevel; nonce: string }
  | { op: 'rotate'; initiator: string; oldKeyId: string; newPublicKey: string; nonce: string };

/**
 * 动作摘要（SPEC §3.2 冻结的规范 JSON：键序固定、无空白）。
 *
 * `digest = sha256hex(canonicalJson(...))`；nonce 由发起方生成并同时进入
 * 请求记录与最终操作记录（最终记录的作者重算并复用）。
 */
export function securityActionDigest(action: SecurityAction): string {
  let canonical: Record<string, unknown>;
  switch (action.op) {
    case 'kick':
      canonical = {
        authority: 'mebular-security',
        op: 'kick',
        initiator: action.initiator,
        subject: action.subject,
        nonce: action.nonce,
      };
      break;
    case 'join':
      canonical = {
        authority: 'mebular-security',
        op: 'join',
        initiator: action.initiator,
        namespace: action.namespace,
        nonce: action.nonce,
      };
      break;
    case 'tier':
      canonical = {
        authority: 'mebular-security',
        op: 'tier',
        initiator: action.initiator,
        level: action.level,
        nonce: action.nonce,
      };
      break;
    case 'rotate':
      canonical = {
        authority: 'mebular-security',
        op: 'rotate',
        initiator: action.initiator,
        oldKeyId: action.oldKeyId,
        newPublicKey: action.newPublicKey,
        nonce: action.nonce,
      };
      break;
  }
  return sha256Hex(JSON.stringify(canonical));
}

/**
 * 配对号：`sha256('mebular-pairing' || digest)` 的**前 6 位十进制**，
 * 格式 `NNN-NNN`。两机各自确定性计算，不传输、不存种。
 *
 * 实现注记：取哈希前 4 字节（uint32 BE）对 10^6 取模，零填充 6 位。
 * 这是规格「前 6 位十进制」的确定性落法，S2/S3 必须复用本函数。
 */
export function pairingCodeForDigest(digest: string): string {
  const hash = createHash('sha256').update('mebular-pairing').update(digest).digest();
  const value = hash.readUInt32BE(0) % 1_000_000;
  const digits = String(value).padStart(6, '0');
  return `${digits.slice(0, 3)}-${digits.slice(3)}`;
}

/** 证明签名覆盖的规范数据（除 `signature` 外的全部字段，稳定键序）。 */
export function canonicalCosignProofData(proof: CosignProof): string {
  const { signature: _signature, ...data } = proof;
  return stableCanonicalJson(data);
}

/** 恢复码证明签名覆盖的规范数据。 */
export function canonicalBreakGlassProofData(proof: BreakGlassProof): string {
  const { signature: _signature, ...data } = proof;
  return stableCanonicalJson(data);
}

async function importEd25519PublicKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw as BufferSource, { name: 'Ed25519' }, false, ['verify']);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const bytes = base64ToBytes(base64);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * cosign 的**密码学预检**：链锚定（叶→根到主公钥）+ approver 设备私钥验签。
 * **不读取 issuedAt/expiresAt**（无墙钟）。digest/动作绑定由推导层做纯关系判定。
 */
export async function verifyCosignProof(
  proof: CosignProof,
  userMasterPublicKey: Uint8Array | null | undefined,
): Promise<boolean> {
  if (!userMasterPublicKey) return false;
  if (!proof || proof.v !== 1 || !Array.isArray(proof.approverCertificateChain)) return false;
  if (typeof proof.approver !== 'string' || proof.approver.length === 0) return false;
  if (typeof proof.signature !== 'string' || proof.signature.length === 0) return false;
  const leaf = proof.approverCertificateChain[0];
  if (!leaf || leaf.deviceId !== proof.approver) return false;
  try {
    const anchored = await verifyCertificateChain(proof.approverCertificateChain, userMasterPublicKey, {
      subjectDeviceId: proof.approver,
    });
    if (!anchored) return false;
    const key = await importEd25519PublicKey(hexToBytes(leaf.devicePublicKey));
    return await crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      base64ToArrayBuffer(proof.signature),
      new TextEncoder().encode(canonicalCosignProofData(proof)),
    );
  } catch {
    return false;
  }
}

/**
 * breakGlass 的**密码学预检**：用已登记的恢复码公钥验签。
 * **不读取 issuedAt/expiresAt**；keyId 是否当前/更早由推导层判定。
 */
export async function verifyBreakGlassProof(
  proof: BreakGlassProof,
  publicKeyHex: string | undefined,
): Promise<boolean> {
  if (!publicKeyHex) return false;
  if (!proof || proof.v !== 1) return false;
  if (typeof proof.signature !== 'string' || proof.signature.length === 0) return false;
  try {
    const key = await importEd25519PublicKey(hexToBytes(publicKeyHex));
    return await crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      base64ToArrayBuffer(proof.signature),
      new TextEncoder().encode(canonicalBreakGlassProofData(proof)),
    );
  } catch {
    return false;
  }
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
 *
 * **闸门启用边界（W1-B）**：仅 `active=true` 记录让分区进入「已启用成员资格」；只有注销记录
 * （`active=false`）或没有记录的分区 = 未启用（沿用 hello 订阅裁剪，与 legacy 一致）。启用是
 * 单调的：曾启用即保持——注销只把成员移出在册集合（「非成员收不到」仍成立），不回退 legacy。
 */
function deriveMembership(
  sorted: ParsedEntry[],
  revokedIn: ReadonlySet<string>,
  rejectedJoinIds: ReadonlySet<string> = new Set(),
): { members: Map<string, Set<string>>; namespaces: Set<string> } {
  const latest = new Map<string, boolean>();
  const namespaces = new Set<string>();
  for (const entry of sorted) {
    if (entry.kind !== 'membership' || !entry.membership) continue;
    if (rejectedJoinIds.has(entry.id)) continue; // S1：high 档首现未通过会签验收
    if (revokedIn.has(entry.author)) continue; // R-b：被吊销签发者的记录不采纳
    if (revokedIn.has(entry.membership.member)) continue; // R-b：被吊销成员不采纳
    const { namespace, member, active } = entry.membership;
    if (active) namespaces.add(namespace); // W1-B：仅 active=true 记录启用闸门（注销记录不启用）
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

/** 上一轮安全验收的过滤集（反馈进下一轮授权/吊销推导）。 */
interface SecurityFilters {
  rejectedJoinIds: ReadonlySet<string>;
  rejectedRevokeIds: ReadonlySet<string>;
}

const EMPTY_FILTERS: SecurityFilters = {
  rejectedJoinIds: new Set<string>(),
  rejectedRevokeIds: new Set<string>(),
};

function consumeNonce(
  used: Map<string, string>,
  scope: string,
  op: SecurityOp,
  nonce: string | undefined,
  digest: string,
): boolean {
  if (!nonce) return false;
  const key = `${scope}|${op}|${nonce}`;
  const prior = used.get(key);
  if (prior !== undefined) return prior === digest; // 同一动作重复 = 幂等，不同动作 = 重放
  used.set(key, digest);
  return true;
}

interface SecurityContext {
  index: number;
  recoveryKeyId?: string;
  admitted: ReadonlySet<string>;
  revokedAtOrder: ReadonlySet<string>;
  approvalIndex: ReadonlyMap<string, number>;
  approvalValidity: ReadonlyMap<number, SecurityRejectionReason | null>;
  usedNonces: Map<string, string>;
  sorted: ParsedEntry[];
}

/**
 * 判定一条记录携带的会签/恢复码证明（纯关系 + digest 重算；不读墙钟）。
 *
 * 返回 `undefined` = 通过；否则返回 §3.4E 的原因。密码学预检
 * （链锚定/签名）已由 `GraphNamespacePolicy.snapshot` 异步完成并写入
 * `cosignWellFormed`/`breakGlassWellFormed`；本函数只消费该标记。
 */
function proofOf(entry: ParsedEntry): { cosign?: CosignProof; breakGlass?: BreakGlassProof } {
  return {
    cosign:
      entry.cosign ??
      entry.tier?.cosign ??
      entry.device?.cosign ??
      entry.grant?.cosign ??
      entry.membership?.cosign ??
      entry.recovery?.cosign,
    breakGlass:
      entry.breakGlass ??
      entry.tier?.breakGlass ??
      entry.device?.breakGlass ??
      entry.grant?.breakGlass ??
      entry.membership?.breakGlass ??
      entry.recovery?.breakGlass,
  };
}

/**
 * join 动作的发起方：cosign 以**批准请求的 initiator** 为准（D 的 grant 与
 * R 的 membership 共用同一份证明，作者可能不同，SPEC §3.7）；breakGlass
 * 用记录自带的 initiator，缺省退回记录作者。
 */
function joinInitiator(entry: ParsedEntry, ctx: SecurityContext): string {
  const { cosign } = proofOf(entry);
  if (cosign) {
    const at = ctx.approvalIndex.get(cosign.approvalId);
    const approval = at !== undefined ? ctx.sorted[at]?.approval : undefined;
    if (approval) return approval.initiator;
  }
  return entry.grant?.initiator ?? entry.membership?.initiator ?? entry.author;
}

function checkSecurityProof(
  entry: ParsedEntry,
  op: SecurityOp,
  expectedDigest: string,
  subject: string | undefined,
  nonce: string | undefined,
  ctx: SecurityContext,
): SecurityRejectionReason | undefined {
  const { cosign, breakGlass: glass } = proofOf(entry);
  if (!cosign && !glass) return 'missing-proof';

  if (glass) {
    if (!entry.breakGlassWellFormed) return 'invalid-proof';
    if (glass.op !== op || glass.keyId !== ctx.recoveryKeyId || glass.digest !== expectedDigest) {
      return 'invalid-proof';
    }
    if (!consumeNonce(ctx.usedNonces, `breakglass:${glass.keyId}`, op, nonce, expectedDigest)) {
      return 'stale-or-replayed-nonce';
    }
    return undefined;
  }

  if (!cosign || !entry.cosignWellFormed) return 'invalid-proof';
  if (cosign.op !== op) return 'invalid-proof';
  const approvalAt = ctx.approvalIndex.get(cosign.approvalId);
  if (approvalAt === undefined || approvalAt >= ctx.index) return 'approval-missing-or-not-causal';
  if (!ctx.approvalValidity.has(approvalAt)) return 'approval-missing-or-not-causal';
  const approvalReason = ctx.approvalValidity.get(approvalAt);
  if (approvalReason) return approvalReason;

  const approval = ctx.sorted[approvalAt]?.approval;
  if (!approval) return 'approval-missing-or-not-causal';
  const approvalAuthor = ctx.sorted[approvalAt]!.author;
  if (cosign.approver !== approvalAuthor) return 'invalid-proof';
  if (approval.op !== op) return 'invalid-proof';
  const pairing = pairingCodeForDigest(expectedDigest);
  if (cosign.digest !== expectedDigest || cosign.pairingCode !== pairing) return 'invalid-proof';
  if (approval.digest !== expectedDigest || approval.pairingCode !== pairing) return 'invalid-proof';
  if (cosign.approver === entry.author) return 'approver-equals-author';
  if (subject !== undefined && cosign.approver === subject) return 'approver-equals-subject';
  if (!consumeNonce(ctx.usedNonces, `cosign:${cosign.approver}`, op, nonce, expectedDigest)) {
    return 'stale-or-replayed-nonce';
  }
  return undefined;
}

/**
 * S1 安全轴单遍推导（SPEC §1.2、§3.4、§3.5、§3.6）。
 *
 * 输入：R-c 定序后的记录、上一轮吊销排除集、上一轮 grantId 撤销集、本轮
 * 授权步采纳的 grantId。输出：档位/准入/恢复码/拒绝诊断，以及供下一轮
 * 授权/吊销步使用的过滤集。
 *
 * **无墙钟**：只读记录字段与位次；`issuedAt/expiresAt` 仅原样拷贝到审计
 * 出口 `changedAt`，绝不参与采纳判定。
 */
function runSecurityPass(
  sorted: ParsedEntry[],
  revokedIn: ReadonlySet<string>,
  adoptedGrantIds: ReadonlySet<string>,
  candidateGrantIds: ReadonlySet<string> = adoptedGrantIds,
): SecurityPassResult {
  const present = sorted.some(
    (entry) => entry.kind === 'tier' || entry.kind === 'approval' || entry.kind === 'recovery',
  );
  const rejections: SecurityRejection[] = [];
  const rejectedEventIds = new Set<string>();
  const rejectedJoinIds = new Set<string>();
  const rejectedRevokeIds = new Set<string>();
  const reject = (eventId: string, reason: SecurityRejectionReason): void => {
    if (rejectedEventIds.has(eventId)) return;
    rejectedEventIds.add(eventId);
    rejections.push({ eventId, reason });
  };

  const approvalIndex = new Map<string, number>();
  for (let i = 0; i < sorted.length; i += 1) {
    const entry = sorted[i]!;
    if (entry.kind !== 'approval' || !entry.approval) continue;
    if (entry.approval.decision !== 'approve') continue;
    if (!approvalIndex.has(entry.approval.approvalId)) approvalIndex.set(entry.approval.approvalId, i);
  }

  const seed = new Set<string>();
  const admitted = new Set<string>();
  let sealed = false;
  let level: SecurityLevel = 'low';
  let changedAt: number | undefined;
  let changedBy: string | undefined;
  let recoveryKeyId: string | undefined;
  /** 是否已采纳过任何 high-tier 记录（用于恢复码初始登记的“升档仪式”边界）。 */
  let highTierAdopted = false;
  const usedNonces = new Map<string, string>();
  const revokedAtOrder = new Set<string>();
  const approvalValidity = new Map<number, SecurityRejectionReason | null>();

  for (let index = 0; index < sorted.length; index += 1) {
    const entry = sorted[index]!;
    const ctx: SecurityContext & { sorted: ParsedEntry[] } = {
      index,
      ...(recoveryKeyId !== undefined ? { recoveryKeyId } : {}),
      admitted,
      revokedAtOrder,
      approvalIndex,
      approvalValidity,
      usedNonces,
      sorted,
    };

    switch (entry.kind) {
      case 'grant': {
        if (!entry.grant) break;
        if (revokedIn.has(entry.author) || revokedAtOrder.has(entry.author)) break; // R-b
        // 用**候选集**（R-a/R-d 通过、未应用上一轮 join 过滤）判定首现门槛：
        // 否则被 join 过滤的 grant 在下一轮从 adoptedGrantIds 消失，会把它的
        // rejection 清掉，造成过滤集振荡。采纳/准入/恢复仍只看本轮实际采纳集。
        if (!candidateGrantIds.has(entry.grant.grantId)) break; // R-a / R-d 已判定
        const subject = entry.grant.subject;
        const gated = sealed && level === 'high' && !admitted.has(subject);
        if (gated) {
          const namespaces = normalizeNamespaceList(entry.grant.namespaces);
          const initiator = joinInitiator(entry, ctx);
          const nonce = entry.grant.nonce;
          let reason: SecurityRejectionReason | undefined;
          if (namespaces.length !== 1) {
            // join digest 只绑定单个 namespace；多分区首现无法被一个会签覆盖 → fail-closed。
            reason = proofOf(entry).cosign || proofOf(entry).breakGlass ? 'invalid-proof' : 'missing-proof';
          } else if (!nonce) {
            reason = proofOf(entry).cosign || proofOf(entry).breakGlass ? 'invalid-proof' : 'missing-proof';
          } else {
            const digest = securityActionDigest({
              op: 'join',
              initiator,
              namespace: namespaces[0]!,
              nonce,
            });
            reason = checkSecurityProof(entry, 'join', digest, subject, nonce, ctx);
          }
          if (reason) {
            reject(entry.id, reason);
            rejectedJoinIds.add(entry.id);
            break;
          }
        }
        // 本轮授权步可能因上一轮 join 过滤未采纳它；下一轮会采纳，届时再加入
        // admitted/seed（避免把「尚未生效」写成既成事实）。
        if (!adoptedGrantIds.has(entry.grant.grantId)) break;
        if (!sealed) {
          seed.add(entry.author);
          seed.add(subject);
        } else if (!admitted.has(subject)) {
          admitted.add(subject);
        }
        revokedAtOrder.delete(subject); // R-d 恢复
        break;
      }

      case 'membership': {
        if (!entry.membership) break;
        if (revokedIn.has(entry.author) || revokedIn.has(entry.membership.member)) break; // R-b
        const member = entry.membership.member;
        const gated = sealed && level === 'high' && !admitted.has(member);
        if (gated) {
          const initiator = joinInitiator(entry, ctx);
          const nonce = entry.membership.nonce;
          let reason: SecurityRejectionReason | undefined;
          if (!nonce) {
            reason = proofOf(entry).cosign || proofOf(entry).breakGlass ? 'invalid-proof' : 'missing-proof';
          } else {
            const digest = securityActionDigest({
              op: 'join',
              initiator,
              namespace: entry.membership.namespace,
              nonce,
            });
            reason = checkSecurityProof(entry, 'join', digest, member, nonce, ctx);
          }
          if (reason) {
            reject(entry.id, reason);
            rejectedJoinIds.add(entry.id);
            break;
          }
        }
        if (!sealed) {
          seed.add(entry.author);
          seed.add(member);
        } else if (!admitted.has(member)) {
          admitted.add(member);
        }
        break;
      }

      case 'device': {
        if (!entry.device) break;
        if (revokedIn.has(entry.author) || revokedAtOrder.has(entry.author)) break; // R-b
        if (entry.device.subject === entry.author) break; // 自吊销不采纳（基线）
        const subject = entry.device.subject;
        if (level === 'high') {
          const nonce = entry.device.nonce;
          const digest = nonce
            ? securityActionDigest({ op: 'kick', initiator: entry.author, subject, nonce })
            : '';
          const reason = checkSecurityProof(entry, 'kick', digest, subject, nonce, ctx);
          if (reason) {
            reject(entry.id, reason);
            rejectedRevokeIds.add(entry.id);
            break;
          }
        }
        if (!sealed) {
          seed.add(entry.author);
          seed.add(subject);
        }
        revokedAtOrder.add(subject);
        break;
      }

      case 'revoke': {
        if (!entry.revoke || revokedIn.has(entry.author)) break;
        if (!sealed) {
          seed.add(entry.author);
          if (entry.revoke.subject !== undefined) seed.add(entry.revoke.subject);
        }
        break;
      }

      case 'issuer': {
        if (!entry.issuer || revokedIn.has(entry.author) || revokedIn.has(entry.issuer.subject)) break;
        if (!sealed) {
          seed.add(entry.author);
          seed.add(entry.issuer.subject);
        }
        break;
      }

      case 'tier': {
        if (!entry.tier) break;
        if (revokedIn.has(entry.author) || revokedAtOrder.has(entry.author)) break; // R-b（含历史）
        const record = entry.tier;
        const before = level;
        if (before === 'high' && record.level === 'high') {
          highTierAdopted = true; // 同级重发：采纳但无效果
          break;
        }
        if (before === 'high' && record.level !== 'high') {
          const nonce = record.nonce;
          const digest = nonce
            ? securityActionDigest({ op: 'tier', initiator: entry.author, level: record.level, nonce })
            : '';
          const reason = checkSecurityProof(entry, 'tier', digest, undefined, nonce, ctx);
          if (reason) {
            reject(entry.id, reason);
            break;
          }
        }
        level = record.level;
        if (record.level === 'high') highTierAdopted = true;
        changedAt = record.issuedAt;
        changedBy = entry.author;
        if (!sealed) {
          // §3.5 种子口径：首条被采纳 tier 记录的作者自动准入（否则单设备升级 high 后
          // 无人可批准，与 §3.5 目的及 §6.4 E-7 冲突）。
          seed.add(entry.author);
          for (const device of seed) admitted.add(device);
          sealed = true;
        }
        break;
      }

      case 'approval': {
        if (!entry.approval) break;
        if (entry.approval.decision !== 'approve') break;
        const record = entry.approval;
        let reason: SecurityRejectionReason | null = null;
        if (!record.cosign || !entry.approvalCosignWellFormed) {
          reason = 'invalid-proof';
        } else if (
          record.cosign.approver !== entry.author ||
          record.cosign.approvalId !== record.approvalId ||
          record.cosign.op !== record.op ||
          record.cosign.digest !== record.digest
        ) {
          reason = 'invalid-proof';
        } else if (
          record.cosign.pairingCode !== pairingCodeForDigest(record.digest) ||
          record.pairingCode !== pairingCodeForDigest(record.digest)
        ) {
          reason = 'invalid-proof';
        } else if (entry.author === record.initiator) {
          reason = 'approver-equals-author';
        } else if (revokedAtOrder.has(entry.author)) {
          reason = 'approval-approver-revoked-at-its-order';
        } else if (!admitted.has(entry.author)) {
          reason = 'approver-not-admitted-at-approval';
        }
        approvalValidity.set(index, reason);
        break;
      }

      case 'recovery': {
        if (!entry.recovery) break;
        if (revokedIn.has(entry.author) || revokedAtOrder.has(entry.author)) break; // R-b
        const record = entry.recovery;
        if (recoveryKeyId === undefined) {
          // 初始登记：仅「升档仪式内」（R-c 序早于首条被采纳的 high-tier 记录）
          // 的 mode:'set' 免证明。high 出现后（含之后降档窗口）必须携
          // cosign(op:'rotate', oldKeyId='') 或 breakGlass——防被窃受信设备
          // 自登记恢复码后用 breakGlass 绕过会签。
          const freeInitial = record.mode === 'set' && !highTierAdopted;
          if (!freeInitial) {
            const nonce = record.nonce;
            const digest = nonce
              ? securityActionDigest({
                  op: 'rotate',
                  initiator: entry.author,
                  oldKeyId: '',
                  newPublicKey: record.publicKey,
                  nonce,
                })
              : '';
            const reason = checkSecurityProof(entry, 'rotate', digest, undefined, nonce, ctx);
            if (reason) {
              reject(entry.id, reason);
              break;
            }
          }
          recoveryKeyId = record.keyId;
          if (!sealed) seed.add(entry.author);
          break;
        }
        const nonce = record.nonce;
        const digest = nonce
          ? securityActionDigest({
              op: 'rotate',
              initiator: entry.author,
              oldKeyId: recoveryKeyId,
              newPublicKey: record.publicKey,
              nonce,
            })
          : '';
        const reason = checkSecurityProof(entry, 'rotate', digest, undefined, nonce, ctx);
        if (reason) {
          reject(entry.id, reason);
          break;
        }
        recoveryKeyId = record.keyId;
        if (!sealed) seed.add(entry.author);
        break;
      }
    }
  }

  return {
    security: {
      level,
      ...(changedAt !== undefined ? { changedAt } : {}),
      ...(changedBy !== undefined ? { changedBy } : {}),
      admitted: [...admitted].sort(),
      ...(recoveryKeyId !== undefined ? { recoveryKeyId } : {}),
      rejections,
    },
    rejectedJoinIds,
    rejectedRevokeIds,
    present,
  };
}

function deriveOnce(
  sorted: ParsedEntry[],
  bootstrap: ReadonlySet<string>,
  revokedGrantIds: ReadonlySet<string>,
  revokedIn: ReadonlySet<string>,
  filters: SecurityFilters = EMPTY_FILTERS,
): Authority {
  // C1：R-a 的引导白名单改为「生效引导集合」（图上声明 ∪ 配置）。
  const issuers = effectiveIssuers(sorted, bootstrap, revokedIn);
  // 权威授权：R-b（revokedIn）→ R-d（grantId 撤销）→ R-a
  const authorized = new Map<string, Set<string>>();
  const adoptedGrantIds = new Set<string>();
  const candidateGrantIds = new Set<string>();
  for (const entry of sorted) {
    if (revokedIn.has(entry.author)) continue; // R-b：被吊销签发者的记录不采纳
    if (entry.kind !== 'grant' || !entry.grant) continue;
    if (revokedGrantIds.has(entry.grant.grantId)) continue; // R-d：grantId 精确撤销
    const granted = namespacesOf(entry.grant);
    if (!isAuthorizedFor(entry.author, granted, authorized, issuers)) continue; // R-a
    candidateGrantIds.add(entry.grant.grantId);
    if (filters.rejectedJoinIds.has(entry.id)) continue; // S1：high 档首现未通过会签验收
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
      if (filters.rejectedRevokeIds.has(entry.id)) continue; // S1：high 档踢人未通过会签验收
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
  const membership = deriveMembership(sorted, revokedIn, filters.rejectedJoinIds);
  // S1：安全轴单遍（tier/admitted/recovery/rejections）与既有两轴同一推导循环。
  const security = runSecurityPass(sorted, revokedIn, adoptedGrantIds, candidateGrantIds);
  return {
    authorized: out,
    revoked,
    issuers,
    members: membership.members,
    membershipNamespaces: membership.namespaces,
    security,
  };
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
  let filters: SecurityFilters = EMPTY_FILTERS;
  let current = deriveOnce(sorted, bootstrap, revokedGrantIds, revokedIn, filters);
  const rounds: Array<{ revokedGrantIds: Set<string>; state: Authority }> = [
    { revokedGrantIds, state: current },
  ];

  let converged = false;
  let iterations = 0;
  while (iterations < maxIterations) {
    iterations += 1;
    const nextRevokes = filterRevokes(sorted, current.revoked);
    const filtersStable =
      setsEqual(current.security.rejectedJoinIds, filters.rejectedJoinIds) &&
      setsEqual(current.security.rejectedRevokeIds, filters.rejectedRevokeIds);
    if (
      setsEqual(nextRevokes, revokedGrantIds) &&
      setsEqual(current.revoked, revokedIn) &&
      filtersStable
    ) {
      converged = true;
      break;
    }
    revokedGrantIds = nextRevokes;
    revokedIn = current.revoked;
    filters = {
      rejectedJoinIds: current.security.rejectedJoinIds,
      rejectedRevokeIds: current.security.rejectedRevokeIds,
    };
    current = deriveOnce(sorted, bootstrap, revokedGrantIds, revokedIn, filters);
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
      const candidate = deriveOnce(sorted, bootstrap, filterRevokes(sorted, excluded), excluded, filters);
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

  // 未收敛回退：新轴一律取更保守值（证明视为不满足、档位变更不采纳、恢复码
  // 签名不采纳）——SPEC §3.4 实现注记。`rejections` 保留以便诊断。
  let securityOut: SecurityPolicyState | undefined;
  if (chosen.security.present) {
    securityOut = converged
      ? chosen.security.security
      : {
          level: 'low',
          admitted: [],
          rejections: chosen.security.security.rejections,
        };
  }

  return {
    authorized: chosen.authorized,
    revoked: chosen.revoked,
    issuers: chosen.issuers,
    members: chosen.members,
    membershipNamespaces: chosen.membershipNamespaces,
    converged,
    iterations,
    ...(securityOut !== undefined ? { security: securityOut } : {}),
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
    const entries = parseEntries(trusted);
    await this.annotateProofs(entries);
    // 生产路径恒用输入的确定性上限 `iterationBound(entries)`（不可由构造选项注入，
    // 避免各端上限不同导致权威集不一致）。
    return derivePolicyState(entries, { policyIssuers: this.policyIssuers });
  }

  /**
   * S1：异步密码学预检（链锚定 / 签名 / 结构），产出 `*WellFormed` 标记。
   * **不读取 issuedAt/expiresAt**（无墙钟）——时效只约束发起方执行窗口。
   */
  private async annotateProofs(entries: ParsedEntry[]): Promise<void> {
    const recoveryKeys = new Map<string, string>();
    for (const entry of entries) {
      if (entry.kind === 'recovery' && entry.recovery) {
        recoveryKeys.set(entry.recovery.keyId, entry.recovery.publicKey);
      }
    }
    for (const entry of entries) {
      if (entry.kind === 'approval' && entry.approval?.cosign) {
        entry.approvalCosignWellFormed = await verifyCosignProof(
          entry.approval.cosign,
          this.userMasterPublicKey,
        );
      }
      if (entry.cosign) {
        entry.cosignWellFormed = await verifyCosignProof(entry.cosign, this.userMasterPublicKey);
      }
      if (entry.breakGlass) {
        entry.breakGlassWellFormed = await verifyBreakGlassProof(
          entry.breakGlass,
          recoveryKeys.get(entry.breakGlass.keyId),
        );
      }
    }
  }

  /** S1：只读安全等级出口（`admitted` 必须暴露，SPEC §3.5）。 */
  async getSecurityTier(): Promise<SecurityPolicyState> {
    return (await this.snapshot()).security ?? { level: 'low', admitted: [], rejections: [] };
  }

  async getAuthorizedNamespaces(peerDeviceId: string): Promise<string[]> {
    return (await this.snapshot()).authorized.get(peerDeviceId) ?? [];
  }

  /** C1：当前生效引导签发者集合（图上被采纳声明 ∪ 构造时配置的 bootstrap）。 */
  async getPolicyIssuers(): Promise<string[]> {
    return [...(await this.snapshot()).issuers].sort();
  }

  /**
   * M1：某分区的成员资格。`active=false` 表示**该分区尚无被采纳的 active=true 成员记录**
   * （未启用成员资格，调用方沿用旧行为）；`active=true` 时 `members` 为在册成员
   * （已 ∩ 授权由上层完成）。W1-B：注销记录不再启用闸门。
   */
  async getNamespaceMembership(namespace: string): Promise<{ active: boolean; members: string[] }> {
    const state = await this.snapshot();
    return {
      active: state.membershipNamespaces.has(namespace),
      members: [...(state.members.get(namespace) ?? [])].sort(),
    };
  }

  /**
   * W1-B（Q2）：`member` 是否在该分区**曾声明在册**（存在被采纳的 `active=true` 成员记录，
   * 任意时点）。与 `getNamespaceMembership` 同一信任/吊销过滤口径（链到用户主密钥、
   * 签发者与成员未被吊销）；只回答「曾在册」，不改变任何推导。
   *
   * 用于 rejoin 准入（「本机订阅声明 ∧ 未吊销」）：曾在册 = 图上留有该设备的持久订阅声明
   * ——不再要求 self-grant（网内订阅自主；autoGrant 对 self 冻结签发，旧门槛会让本机对
   * 自己参与过的域永远无法重入）。
   */
  async wasNamespaceMember(namespace: string, member: string): Promise<boolean> {
    const state = await this.snapshot();
    if (state.revoked.has(member)) return false; // R-b：被吊销成员不采纳
    const events = await this.eventLog.listEvents({ namespace: POLICY_NAMESPACE });
    const trusted: Event[] = [];
    for (const event of events) {
      if (event.type !== NAMESPACE_MEMBERSHIP_EVENT) continue;
      if (await verifyIssuedByUser(event, this.userMasterPublicKey)) trusted.push(event);
    }
    for (const entry of parseEntries(trusted)) {
      if (entry.kind !== 'membership' || !entry.membership) continue;
      if (state.revoked.has(entry.author)) continue; // R-b：被吊销签发者的记录不采纳
      if (entry.membership.active !== true) continue;
      if (entry.membership.namespace !== namespace || entry.membership.member !== member) continue;
      return true;
    }
    return false;
  }

  async getRevokedDevices(): Promise<ReadonlySet<string>> {
    return (await this.snapshot()).revoked;
  }
}
