// 订阅自主策略（greenfield）：
//
// 系统只有四个概念：设备（信任链）· 订阅（阅读权 + 维持义务）· 移出（唯一否定）·
// 安全档（动作门槛）。本文件只从 `__policy__` 事件流推导：
//
//   - 订阅：`namespace_subscription`，只有 `author === member` 的自声明被采纳；
//   - 移出：`device_revoke`，只作用于被移出设备本人（作者级，不沿证书链连坐）；
//   - 恢复：`device_restore` + 恢复纪元 E-1（恢复位次之前的策略记录不采纳）；
//   - 域公告：`namespace_declare`（自签名，零门槛，供目录展示）；
//   - 安全档：`security_tier` / `security_approval` / `security_recovery`。
//
// 没有 grant / revoke / issuer / 自动签发 / 按对端×按域的授权白名单。

import { createHash } from 'node:crypto';
import type { Event } from '../types/event.js';
import type { EventLog } from '../eventlog/EventLog.js';
import { normalizeNamespace } from '../core/namespace.js';
import type { NamespaceSubscriptionPolicy } from './namespacePolicy.js';
import { verifyIssuedByUser } from './trust.js';
import {
  base64ToBytes,
  hexToBytes,
  verifyCertificateChain,
  type DeviceCertificate,
} from '../p2p/handshake/AuthenticationHandshake.js';

/**
 * 保留策略命名空间：订阅/移出/恢复/公告/安全记录落在这里。
 *
 * 它是**元数据**（带作者签名），不是用户数据；因此同步时**不受订阅裁剪**
 * （见 SyncManager 的 filterEventsForAllow），已认证设备总能读到它。
 */
export const POLICY_NAMESPACE = '__policy__';

/** 订阅声明（自签名）。 */
export const NAMESPACE_SUBSCRIPTION_EVENT = 'namespace_subscription';
/** 域公告（自签名、零门槛；目录可见 ≠ 订阅可读）。 */
export const NAMESPACE_DECLARE_EVENT = 'namespace_declare';
/** 移出设备（事件名保留；UI 称「移出」）。 */
export const DEVICE_REVOKE_EVENT = 'device_revoke';
/** 恢复设备身份 + 恢复纪元（替代旧 R-d 恢复授权）。 */
export const DEVICE_RESTORE_EVENT = 'device_restore';
/** 交接记录（审计产物；不参与订阅/移出推导）。 */
export const NAMESPACE_HANDOFF_EVENT = 'namespace_handoff';

// ---------------------------------------------------------------------------
// 安全等级（low / medium / high）与会签证明
// ---------------------------------------------------------------------------

export const SECURITY_TIER_EVENT = 'security_tier';
export const SECURITY_APPROVAL_EVENT = 'security_approval';
export const SECURITY_RECOVERY_EVENT = 'security_recovery';

export type SecurityLevel = 'low' | 'medium' | 'high';
export type SecurityOp = 'kick' | 'join' | 'tier' | 'rotate' | 'restore';

export interface CosignProof {
  v: 1;
  op: SecurityOp;
  approver: string;
  approverCertificateChain: DeviceCertificate[];
  approvalId: string;
  digest: string;
  pairingCode: string;
  issuedAt: number;
  expiresAt: number;
  signature: string;
}

export interface BreakGlassProof {
  v: 1;
  op: SecurityOp;
  keyId: string;
  digest: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
  signature: string;
}

export interface SecurityTierRecord {
  level: SecurityLevel;
  nonce: string;
  issuedAt: number;
  note?: string;
  cosign?: CosignProof;
  breakGlass?: BreakGlassProof;
}

export interface SecurityApprovalRecord {
  approvalId: string;
  op: SecurityOp;
  decision: 'request' | 'approve' | 'deny';
  initiator: string;
  target?: string;
  namespace?: string;
  level?: SecurityLevel;
  nonce: string;
  digest: string;
  pairingCode: string;
  cosign?: CosignProof;
  expiresAt: number;
  issuedAt: number;
  note?: string;
}

export interface SecurityRecoveryRecord {
  keyId: string;
  publicKey: string;
  createdAt: number;
  mode: 'set' | 'rotate';
  nonce?: string;
  note?: string;
  cosign?: CosignProof;
  breakGlass?: BreakGlassProof;
}

export type SecurityRejectionReason =
  | 'missing-proof'
  | 'invalid-proof'
  | 'approval-missing-or-not-causal'
  | 'approval-approver-revoked-at-its-order'
  | 'approver-not-admitted-at-approval'
  | 'approver-equals-author'
  | 'approver-equals-subject'
  | 'stale-or-replayed-nonce'
  | 'foreign-subscription'
  | 'restore-target-not-blocked'
  | 'self-restore'
  | 'self-revoke';

export interface SecurityRejection {
  eventId: string;
  reason: SecurityRejectionReason;
}

export interface SecurityPolicyState {
  level: SecurityLevel;
  changedAt?: number;
  changedBy?: string;
  admitted: string[];
  recoveryKeyId?: string;
  rejections: SecurityRejection[];
}

/** 订阅记录：设备 `member` 对 `namespace` 的自声明。 */
export interface NamespaceSubscriptionRecord {
  member: string;
  namespace: string;
  active: boolean;
  issuedAt: number;
  note?: string;
  nonce?: string;
  initiator?: string;
  cosign?: CosignProof;
  breakGlass?: BreakGlassProof;
}

/** 域公告：作者声明某记忆域存在。零门槛、自签名。 */
export interface NamespaceDeclareRecord {
  namespace: string;
  issuedAt: number;
  note?: string;
}

/** 移出记录：作者级否定（不沿证书链传播）。 */
export interface DeviceRevokeRecord {
  subject: string;
  issuedAt: number;
  note?: string;
  nonce?: string;
  cosign?: CosignProof;
  breakGlass?: BreakGlassProof;
}

/** 恢复记录：把当前处于移出状态的设备恢复；建立 E-1 纪元切点。 */
export interface DeviceRestoreRecord {
  subject: string;
  issuedAt: number;
  note?: string;
  nonce?: string;
  cosign?: CosignProof;
  breakGlass?: BreakGlassProof;
}

/** 交接记录（仅审计；不参与订阅/移出推导）。 */
export interface NamespaceHandoffRecord {
  handoffId: string;
  namespace: string;
  successor: string;
  forced: boolean;
  pendingCount: number;
  missingAuthors?: string[];
  issuedAt: number;
  note?: string;
}

/** 从图上推导出的策略快照。 */
export interface PolicyState {
  /** namespace → active 订阅者集合 */
  subscriptions: Map<string, Set<string>>;
  /** 出现任意被采纳订阅记录（active 或 inactive）的分区（订阅权威模式） */
  subscriptionNamespaces: Set<string>;
  /** namespace → 有过任意被采纳订阅记录（active 或 inactive）的成员 */
  subscriptionRecords: Map<string, Set<string>>;
  /** 当前处于移出状态的设备 */
  blocked: Set<string>;
  /** 域公告集合（目录可见；不含本地节点） */
  declarations: Set<string>;
  /** 恢复纪元：deviceId → 最近一次被采纳 restore 的 R-c 位次 */
  restoreAt: Map<string, number>;
  converged: boolean;
  iterations: number;
  security?: SecurityPolicyState;
}

interface SecurityPassResult {
  security: SecurityPolicyState;
  blocked: Set<string>;
  restoreAt: Map<string, number>;
  rejectedJoinIds: Set<string>;
  present: boolean;
}

interface Authority {
  subscriptions: Map<string, Set<string>>;
  subscriptionNamespaces: Set<string>;
  subscriptionRecords: Map<string, Set<string>>;
  blocked: Set<string>;
  declarations: Set<string>;
  restoreAt: Map<string, number>;
  security: SecurityPassResult;
}

interface ParsedEntry {
  kind: 'subscription' | 'declare' | 'device' | 'restore' | 'tier' | 'approval' | 'recovery';
  author: string;
  seq: number;
  logical: number;
  /** R-c 定序后的位次（deriveOnce 内填；测试构造时可缺省） */
  order?: number;
  id: string;
  subscription?: NamespaceSubscriptionRecord;
  declaration?: NamespaceDeclareRecord;
  device?: DeviceRevokeRecord;
  restore?: DeviceRestoreRecord;
  tier?: SecurityTierRecord;
  approval?: SecurityApprovalRecord;
  recovery?: SecurityRecoveryRecord;
  cosign?: CosignProof;
  breakGlass?: BreakGlassProof;
  cosignWellFormed?: boolean;
  breakGlassWellFormed?: boolean;
  approvalCosignWellFormed?: boolean;
}

function isPolicyType(type: string): boolean {
  return (
    type === NAMESPACE_SUBSCRIPTION_EVENT ||
    type === NAMESPACE_DECLARE_EVENT ||
    type === DEVICE_REVOKE_EVENT ||
    type === DEVICE_RESTORE_EVENT ||
    type === SECURITY_TIER_EVENT ||
    type === SECURITY_APPROVAL_EVENT ||
    type === SECURITY_RECOVERY_EVENT
  );
}

function isSecurityLevel(value: unknown): value is SecurityLevel {
  return value === 'low' || value === 'medium' || value === 'high';
}

function proofFields(data: object): { cosign?: CosignProof; breakGlass?: BreakGlassProof } {
  const cosign = (data as { cosign?: CosignProof }).cosign;
  const breakGlass = (data as { breakGlass?: BreakGlassProof }).breakGlass;
  return {
    ...(cosign && typeof cosign === 'object' ? { cosign } : {}),
    ...(breakGlass && typeof breakGlass === 'object' ? { breakGlass } : {}),
  };
}

function compareEntries(a: ParsedEntry, b: ParsedEntry): number {
  if (a.author === b.author) return a.seq - b.seq;
  if (a.logical !== b.logical) return a.logical - b.logical;
  return a.author < b.author ? -1 : 1;
}

function eventSeq(event: Event): number {
  return event.vectorClock[event.author] ?? 0;
}

function eventLogical(event: Event): number {
  let sum = 0;
  for (const value of Object.values(event.vectorClock)) sum += value;
  return sum;
}

/** 解析策略事件（调用方已按 isPolicyType 过滤）。 */
function parseEntries(events: Event[]): ParsedEntry[] {
  const entries: ParsedEntry[] = [];
  for (const event of events) {
    const author = event.author;
    const seq = eventSeq(event);
    const logical = eventLogical(event);
    const data = event.data as Record<string, unknown>;
    if (event.type === NAMESPACE_SUBSCRIPTION_EVENT) {
      const subscription = (data as { subscription?: NamespaceSubscriptionRecord }).subscription;
      if (
        subscription &&
        typeof subscription.member === 'string' &&
        typeof subscription.namespace === 'string' &&
        typeof subscription.active === 'boolean'
      ) {
        entries.push({
          kind: 'subscription',
          author,
          seq,
          logical,
          order: 0,
          id: event.id,
          subscription,
          ...proofFields(subscription),
        });
      }
    } else if (event.type === NAMESPACE_DECLARE_EVENT) {
      const declaration = (data as { declaration?: NamespaceDeclareRecord }).declaration;
      if (declaration && typeof declaration.namespace === 'string') {
        entries.push({ kind: 'declare', author, seq, logical, order: 0, id: event.id, declaration });
      }
    } else if (event.type === DEVICE_REVOKE_EVENT) {
      const device = (data as { deviceRevoke?: DeviceRevokeRecord }).deviceRevoke;
      if (device && typeof device.subject === 'string') {
        entries.push({ kind: 'device', author, seq, logical, order: 0, id: event.id, device, ...proofFields(device) });
      }
    } else if (event.type === DEVICE_RESTORE_EVENT) {
      const restore = (data as { deviceRestore?: DeviceRestoreRecord }).deviceRestore;
      if (restore && typeof restore.subject === 'string') {
        entries.push({ kind: 'restore', author, seq, logical, order: 0, id: event.id, restore, ...proofFields(restore) });
      }
    } else if (event.type === SECURITY_TIER_EVENT) {
      const securityTier = (data as { securityTier?: SecurityTierRecord }).securityTier;
      if (securityTier && isSecurityLevel(securityTier.level) && typeof securityTier.nonce === 'string') {
        entries.push({
          kind: 'tier',
          author,
          seq,
          logical,
          order: 0,
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
          order: 0,
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
          order: 0,
          id: event.id,
          recovery: securityRecovery,
          ...proofFields(securityRecovery),
        });
      }
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// 动作摘要 / 配对号 / 证明预检
// ---------------------------------------------------------------------------

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
  | { op: 'rotate'; initiator: string; oldKeyId: string; newPublicKey: string; nonce: string }
  | { op: 'restore'; initiator: string; subject: string; nonce: string };

/** 动作摘要（SPEC §3.2 冻结的规范 JSON：键序固定、无空白）。 */
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
    case 'restore':
      canonical = {
        authority: 'mebular-security',
        op: 'restore',
        initiator: action.initiator,
        subject: action.subject,
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

export function pairingCodeForDigest(digest: string): string {
  const hash = createHash('sha256').update('mebular-pairing').update(digest).digest();
  const value = hash.readUInt32BE(0) % 1_000_000;
  const digits = String(value).padStart(6, '0');
  return `${digits.slice(0, 3)}-${digits.slice(3)}`;
}

export function canonicalCosignProofData(proof: CosignProof): string {
  const { signature: _signature, ...data } = proof;
  return stableCanonicalJson(data);
}

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

/** cosign 的密码学预检：链锚定 + approver 设备私钥验签（不读墙钟）。 */
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

/** breakGlass 的密码学预检（keyId 是否当前/更早由推导层判定）。 */
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

export interface DerivePolicyOptions {
  /**
   * 不动点迭代上限覆盖（测试专用；生产路径不得使用）。
   * @internal
   */
  maxIterations?: number;
}

function iterationBound(entries: ParsedEntry[]): number {
  return 2 * entries.length + 2;
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

function markOrders(sorted: ParsedEntry[]): void {
  for (let index = 0; index < sorted.length; index += 1) sorted[index]!.order = index;
}

/** E-1：恢复位次（含）之前的作者策略记录不采纳。 */
function beforeRestore(entry: ParsedEntry, restoreAt: ReadonlyMap<string, number>): boolean {
  const at = restoreAt.get(entry.author);
  return at !== undefined && (entry.order ?? 0) <= at;
}

/**
 * 订阅轴（R-c 单遍）：
 * - 只采纳 `author === member` 的自声明（S-1）；foreign 记录跳过并进拒绝诊断；
 * - 作者/成员被移出（R-b 含历史）或恢复前记录（E-1）不采纳；
 * - 同一 `(namespace, member)` 最新记录的 `active` 胜出；
 * - **任意**被采纳记录（active 或 inactive）让该域进入订阅权威模式。
 */
function deriveSubscriptions(
  sorted: ParsedEntry[],
  blockedIn: ReadonlySet<string>,
  blocked: ReadonlySet<string>,
  restoreAt: ReadonlyMap<string, number>,
  rejectedJoinIds: ReadonlySet<string>,
): { subscriptions: Map<string, Set<string>>; namespaces: Set<string>; records: Map<string, Set<string>> } {
  const latest = new Map<string, boolean>();
  const authoritative = new Set<string>();
  for (const entry of sorted) {
    if (entry.kind !== 'subscription' || !entry.subscription) continue;
    if (rejectedJoinIds.has(entry.id)) continue;
    const record = entry.subscription;
    if (entry.author !== record.member) continue; // S-1
    if (blockedIn.has(entry.author) || blockedIn.has(record.member)) continue; // R-b（历史）
    if (blocked.has(entry.author) || blocked.has(record.member)) continue; // R-b（当前）
    if (beforeRestore(entry, restoreAt)) continue; // E-1
    const namespace = normalizeNamespace(record.namespace);
    authoritative.add(namespace);
    latest.set(`${namespace}\u0000${record.member}`, record.active);
  }
  const subscriptions = new Map<string, Set<string>>();
  const records = new Map<string, Set<string>>();
  for (const [key, active] of latest) {
    const sep = key.indexOf('\u0000');
    const namespace = key.slice(0, sep);
    const member = key.slice(sep + 1);
    let recorded = records.get(namespace);
    if (!recorded) {
      recorded = new Set();
      records.set(namespace, recorded);
    }
    recorded.add(member);
    if (!active) continue;
    let set = subscriptions.get(namespace);
    if (!set) {
      set = new Set();
      subscriptions.set(namespace, set);
    }
    set.add(member);
  }
  return { subscriptions, namespaces: authoritative, records };
}

/** 域公告轴：作者未被移出、E-1 通过；自签名记录本身即声明。 */
function deriveDeclarations(
  sorted: ParsedEntry[],
  blockedIn: ReadonlySet<string>,
  restoreAt: ReadonlyMap<string, number>,
): Set<string> {
  const declarations = new Set<string>();
  for (const entry of sorted) {
    if (entry.kind !== 'declare' || !entry.declaration) continue;
    if (blockedIn.has(entry.author)) continue; // R-b
    if (beforeRestore(entry, restoreAt)) continue; // E-1
    const namespace = normalizeNamespace(entry.declaration.namespace);
    if (namespace === POLICY_NAMESPACE) continue;
    declarations.add(namespace);
  }
  return declarations;
}

// ---------------------------------------------------------------------------
// 安全轴
// ---------------------------------------------------------------------------

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
  if (prior !== undefined) return prior === digest;
  used.set(key, digest);
  return true;
}

interface SecurityContext {
  index: number;
  recoveryKeyId?: string;
  admitted: ReadonlySet<string>;
  blockedAtOrder: ReadonlySet<string>;
  approvalIndex: ReadonlyMap<string, number>;
  approvalValidity: ReadonlyMap<number, SecurityRejectionReason | null>;
  usedNonces: Map<string, string>;
  sorted: ParsedEntry[];
}

function proofOf(entry: ParsedEntry): { cosign?: CosignProof; breakGlass?: BreakGlassProof } {
  return {
    cosign:
      entry.cosign ??
      entry.tier?.cosign ??
      entry.device?.cosign ??
      entry.restore?.cosign ??
      entry.subscription?.cosign ??
      entry.recovery?.cosign,
    breakGlass:
      entry.breakGlass ??
      entry.tier?.breakGlass ??
      entry.device?.breakGlass ??
      entry.restore?.breakGlass ??
      entry.subscription?.breakGlass ??
      entry.recovery?.breakGlass,
  };
}

function joinInitiator(entry: ParsedEntry, ctx: SecurityContext): string {
  const { cosign } = proofOf(entry);
  if (cosign) {
    const at = ctx.approvalIndex.get(cosign.approvalId);
    const approval = at !== undefined ? ctx.sorted[at]?.approval : undefined;
    if (approval) return approval.initiator;
  }
  return entry.subscription?.initiator ?? entry.author;
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
 * 安全轴单遍推导（H1）：
 * - 只有 **active=true** 的订阅参与 seed/admitted/首现会签；
 * - 加入首记：首现会签只覆盖「设备第一次 active=true 订阅」（设备级）；通过后订阅任何域自主、无需会签；
 * - `active=false` 不触发会签、不 seed、不 admitted。
 */
function runSecurityPass(
  sorted: ParsedEntry[],
  blockedIn: ReadonlySet<string>,
  restoreAtIn: ReadonlyMap<string, number> = new Map(),
): SecurityPassResult & { blocked: Set<string>; restoreAt: Map<string, number> } {
  const present = sorted.some(
    (entry) => entry.kind === 'tier' || entry.kind === 'approval' || entry.kind === 'recovery',
  );
  const rejections: SecurityRejection[] = [];
  const rejectedEventIds = new Set<string>();
  const rejectedJoinIds = new Set<string>();
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
  let highTierAdopted = false;
  const usedNonces = new Map<string, string>();
  const blocked = new Set<string>();
  const restoreAt = new Map<string, number>(restoreAtIn);
  /** subject → (revoking author → count)，用于 restore 时撤销该 subject 旧纪元的移出。 */
  const revokesBySubject = new Map<string, Map<string, number>>();
  const approvalValidity = new Map<number, SecurityRejectionReason | null>();

  for (let index = 0; index < sorted.length; index += 1) {
    const entry = sorted[index]!;
    const ctx: SecurityContext = {
      index,
      ...(recoveryKeyId !== undefined ? { recoveryKeyId } : {}),
      admitted,
      blockedAtOrder: blocked,
      approvalIndex,
      approvalValidity,
      usedNonces,
      sorted,
    };

    if (entry.kind === 'subscription' && entry.subscription && entry.author !== entry.subscription.member) {
      reject(entry.id, 'foreign-subscription');
      continue;
    }
    // approval 需要在自身分支里把「批准人此刻已被移出」写成拒绝诊断，
    // 因此不在这里静默跳过。
    if (entry.kind !== 'approval' && entry.kind !== 'subscription') {
      if (blockedIn.has(entry.author) || blocked.has(entry.author)) continue; // R-b
      if (beforeRestore(entry, restoreAt)) continue; // E-1
    }
    // 订阅：历史记录仍可解释「该设备曾在被移出前被准入」，但按位次被移出后的
    // 记录不采纳（blockedAtOrder）。最终订阅集合另由 deriveSubscriptions 排除 blocked。
    if (entry.kind === 'subscription') {
      if (blocked.has(entry.author)) continue;
      if (beforeRestore(entry, restoreAt)) continue; // E-1
    }

    switch (entry.kind) {
      case 'subscription': {
        if (!entry.subscription) break;
        const record = entry.subscription;
        const member = record.member;
        if (record.active !== true) break; // 退订不 seed/admitted/不触发会签
        const gated = sealed && level === 'high' && !admitted.has(member);
        if (gated) {
          const initiator = joinInitiator(entry, ctx);
          const nonce = record.nonce;
          let reason: SecurityRejectionReason | undefined;
          if (!nonce) {
            reason = proofOf(entry).cosign || proofOf(entry).breakGlass ? 'invalid-proof' : 'missing-proof';
          } else {
            const digest = securityActionDigest({
              op: 'join',
              initiator,
              namespace: normalizeNamespace(record.namespace),
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

      case 'declare': {
        if (!entry.declaration) break;
        if (!sealed) seed.add(entry.author);
        break;
      }

      case 'device': {
        if (!entry.device) break;
        if (entry.device.subject === entry.author) {
          reject(entry.id, 'self-revoke');
          break;
        }
        const subject = entry.device.subject;
        if (level === 'high') {
          const nonce = entry.device.nonce;
          const digest = nonce
            ? securityActionDigest({ op: 'kick', initiator: entry.author, subject, nonce })
            : '';
          const reason = checkSecurityProof(entry, 'kick', digest, subject, nonce, ctx);
          if (reason) {
            reject(entry.id, reason);
            break;
          }
        }
        if (!sealed) {
          seed.add(entry.author);
          seed.add(subject);
        }
        blocked.add(subject);
        const byAuthor = revokesBySubject.get(subject) ?? new Map<string, number>();
        byAuthor.set(entry.author, (byAuthor.get(entry.author) ?? 0) + 1);
        revokesBySubject.set(subject, byAuthor);
        break;
      }

      case 'restore': {
        if (!entry.restore) break;
        if (entry.restore.subject === entry.author) {
          reject(entry.id, 'self-restore');
          break;
        }
        const subject = entry.restore.subject;
        if (!blocked.has(subject)) {
          // 对未移出设备的 restore 是 no-op（不报错、不参与安全 seed）
          break;
        }
        if (level === 'high') {
          const nonce = entry.restore.nonce;
          const digest = nonce
            ? securityActionDigest({ op: 'restore', initiator: entry.author, subject, nonce })
            : '';
          const reason = checkSecurityProof(entry, 'restore', digest, subject, nonce, ctx);
          if (reason) {
            reject(entry.id, reason);
            break;
          }
        }
        if (!sealed) {
          seed.add(entry.author);
          seed.add(subject);
        }
        // E-1：恢复 = 信任重置。该设备旧纪元的移出/准入/会签资格全部失效。
        blocked.delete(subject);
        restoreAt.set(subject, entry.order ?? 0);
        seed.delete(subject);
        admitted.delete(subject);
        for (const target of revokesBySubject.get(subject)?.keys() ?? []) blocked.delete(target);
        revokesBySubject.delete(subject);
        for (let prior = 0; prior < index; prior += 1) {
          const priorEntry = sorted[prior]!;
          if (priorEntry.kind === 'approval' && priorEntry.author === subject) {
            approvalValidity.set(prior, 'approval-approver-revoked-at-its-order');
          }
        }
        break;
      }

      case 'tier': {
        if (!entry.tier) break;
        const record = entry.tier;
        const before = level;
        if (before === 'high' && record.level === 'high') {
          highTierAdopted = true;
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
          seed.add(entry.author);
          for (const device of seed) admitted.add(device);
          sealed = true;
        }
        break;
      }

      case 'approval': {
        if (!entry.approval) break;
        if (beforeRestore(entry, restoreAt)) break;
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
        } else if (blocked.has(entry.author)) {
          reason = 'approval-approver-revoked-at-its-order';
        } else if (!admitted.has(entry.author)) {
          reason = 'approver-not-admitted-at-approval';
        }
        approvalValidity.set(index, reason);
        break;
      }

      case 'recovery': {
        if (!entry.recovery) break;
        const record = entry.recovery;
        if (recoveryKeyId === undefined) {
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
    blocked,
    restoreAt,
    rejectedJoinIds,
    present: present || rejections.length > 0,
  };
}

function deriveOnce(sorted: ParsedEntry[], blockedIn: ReadonlySet<string>): Authority {
  // 两遍：先按「上一轮纪元」求 blocked/restoreAt，再用它做 E-1 过滤重算安全轴。
  // 这样恢复位次之前的 tier/approval/recovery/移出记录不会复活。
  const first = runSecurityPass(sorted, blockedIn);
  const pass = runSecurityPass(sorted, blockedIn, first.restoreAt);
  const subscriptionAxis = deriveSubscriptions(sorted, blockedIn, pass.blocked, pass.restoreAt, pass.rejectedJoinIds);
  const declarations = deriveDeclarations(sorted, blockedIn, pass.restoreAt);
  return {
    subscriptions: subscriptionAxis.subscriptions,
    subscriptionNamespaces: subscriptionAxis.namespaces,
    subscriptionRecords: subscriptionAxis.records,
    blocked: pass.blocked,
    declarations,
    restoreAt: pass.restoreAt,
    security: pass,
  };
}

/**
 * 推导入口：有界不动点。未知量为「上一轮输出的 blocked」与安全过滤集。
 * 种子为空（fail-closed），由确定序驱动；未收敛时回退到只增不减的移出闭包。
 */
export function derivePolicyState(entries: ParsedEntry[], options: DerivePolicyOptions = {}): PolicyState {
  const maxIterations = options.maxIterations ?? iterationBound(entries);
  const sorted = [...entries].sort(compareEntries);
  markOrders(sorted);

  const mapsEqual = (a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): boolean => {
    if (a.size !== b.size) return false;
    for (const [key, value] of a) if (b.get(key) !== value) return false;
    return true;
  };

  let blockedIn = new Set<string>();
  let previousRestoreAt = new Map<string, number>();
  let current = deriveOnce(sorted, blockedIn);
  const rounds: Authority[] = [current];

  let converged = false;
  let iterations = 0;
  while (iterations < maxIterations) {
    iterations += 1;
    if (setsEqual(current.blocked, blockedIn) && mapsEqual(current.restoreAt, previousRestoreAt)) {
      converged = true;
      break;
    }
    blockedIn = current.blocked;
    previousRestoreAt = current.restoreAt;
    current = deriveOnce(sorted, blockedIn);
    rounds.push(current);
  }

  let chosen = current;
  if (!converged) {
    const excluded = new Set<string>();
    for (const round of rounds) for (const device of round.blocked) excluded.add(device);
    const hardCap = 2 * sorted.length + 1;
    for (let guard = 0; guard < hardCap; guard += 1) {
      const candidate = deriveOnce(sorted, excluded);
      chosen = candidate;
      let grew = false;
      for (const device of candidate.blocked) {
        if (!excluded.has(device)) {
          excluded.add(device);
          grew = true;
        }
      }
      if (!grew) break;
    }
  }

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
    subscriptions: chosen.subscriptions,
    subscriptionNamespaces: chosen.subscriptionNamespaces,
    subscriptionRecords: chosen.subscriptionRecords,
    blocked: chosen.blocked,
    declarations: chosen.declarations,
    restoreAt: chosen.restoreAt,
    converged,
    iterations,
    ...(securityOut !== undefined ? { security: securityOut } : {}),
  };
}

/**
 * 从图上（事件日志）推导订阅策略。
 * 每次查询都重新读取策略事件并逐条做信任链校验（策略事件通常很少）。
 */
export class GraphNamespacePolicy implements NamespaceSubscriptionPolicy {
  private readonly eventLog: EventLog;
  private readonly userMasterPublicKey: Uint8Array | null;

  constructor(options: { eventLog: EventLog; userMasterPublicKey?: Uint8Array | null }) {
    this.eventLog = options.eventLog;
    this.userMasterPublicKey = options.userMasterPublicKey ?? null;
  }

  private async trustedEntries(): Promise<ParsedEntry[]> {
    const events = await this.eventLog.listEvents({ namespace: POLICY_NAMESPACE });
    const trusted: Event[] = [];
    for (const event of events) {
      if (!isPolicyType(event.type)) continue;
      if (await verifyIssuedByUser(event, this.userMasterPublicKey)) trusted.push(event);
    }
    const entries = parseEntries(trusted);
    await this.annotateProofs(entries);
    return entries;
  }

  async snapshot(): Promise<PolicyState> {
    return derivePolicyState(await this.trustedEntries());
  }

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

  async getSecurityTier(): Promise<SecurityPolicyState> {
    return (await this.snapshot()).security ?? { level: 'low', admitted: [], rejections: [] };
  }

  async getNamespaceSubscriptions(namespace: string): Promise<{ active: boolean; subscribers: string[]; recorded: string[] }> {
    const ns = normalizeNamespace(namespace);
    const state = await this.snapshot();
    return {
      active: state.subscriptionNamespaces.has(ns),
      subscribers: [...(state.subscriptions.get(ns) ?? [])].sort(),
      recorded: [...(state.subscriptionRecords.get(ns) ?? [])].sort(),
    };
  }

  async getSubscriptions(deviceId: string): Promise<string[]> {
    const state = await this.snapshot();
    const namespaces: string[] = [];
    for (const [namespace, subscribers] of state.subscriptions) {
      if (subscribers.has(deviceId)) namespaces.push(namespace);
    }
    return namespaces.sort();
  }

  async getDeclaredNamespaces(): Promise<string[]> {
    return [...(await this.snapshot()).declarations].sort();
  }

  /** 本机/任意设备曾在某分区有过被采纳的 active=true 订阅（任意时点；E-1 之后重算）。 */
  async wasNamespaceSubscriber(namespace: string, member: string): Promise<boolean> {
    const ns = normalizeNamespace(namespace);
    const state = await this.snapshot();
    if (state.blocked.has(member)) return false;
    const entries = (await this.trustedEntries()).sort(compareEntries);
    markOrders(entries);
    for (const entry of entries) {
      if (entry.kind !== 'subscription' || !entry.subscription) continue;
      if (entry.author !== member || entry.subscription.member !== member) continue;
      if (normalizeNamespace(entry.subscription.namespace) !== ns) continue;
      if (entry.subscription.active !== true) continue;
      if (state.blocked.has(entry.author)) continue;
      if (beforeRestore(entry, state.restoreAt)) continue;
      return true;
    }
    return false;
  }

  async getBlockedDevices(): Promise<ReadonlySet<string>> {
    return (await this.snapshot()).blocked;
  }
}
