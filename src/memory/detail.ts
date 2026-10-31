// 域内详情对象（DetailRecord / RawChunk，0.3.0 产品契约 §2）
//
// 详情不是普通 MemoryRecord，也不是第二套存储：节点落现有图 + 事件日志，
// 随现有同步跨设备。capability 只经 `/internal/memory/v1/detail` 受控写入。
//
// 本模块只放纯数据/视图/限制辅助；图读写由 MemoryService 统一执行。

import { createHash } from 'node:crypto';
import type { Node } from '../types/index.js';
import { domainOfNamespace, matchesNamespace, type NamespaceFilter } from '../core/namespace.js';
import { MebularError } from '../errors.js';

export const DETAIL_NODE_TYPE = 'detail_record';
export const DETAIL_INTERNAL_KIND = 'detail_record';

export const DETAIL_KINDS = ['raw_chunk', 'message', 'tool_output', 'document_slice'] as const;
export type DetailKind = (typeof DETAIL_KINDS)[number];

export const DETAIL_RETENTION_CLASSES = ['conversation', 'tool_output', 'document_slice', 'pinned'] as const;
export type DetailRetentionClass = (typeof DETAIL_RETENTION_CLASSES)[number];

export const DETAIL_ROLES = ['user', 'assistant', 'system', 'tool'] as const;
export type DetailRole = (typeof DETAIL_ROLES)[number];

export const DETAIL_MIMES = ['text/plain', 'text/markdown', 'application/json'] as const;
export type DetailMime = (typeof DETAIL_MIMES)[number];

export const DETAIL_DELETE_REASONS = [
  'user_requested',
  'record_deleted',
  'retention_expired',
  'quota_evicted',
  'checkpoint_deleted',
] as const;
export type DetailDeleteReason = (typeof DETAIL_DELETE_REASONS)[number];

/** 契约 §2.12：单条正文上限 256 KiB。 */
export const MAX_DETAIL_TEXT_BYTES = 256 * 1024;
/** 契约 §2.4：单次 write/delete ≤100。 */
export const MAX_DETAIL_BATCH_ITEMS = 100;
/** 契约 §2.4/§2.12：get 的 maxBytes 夹紧到 64 KiB。 */
export const MAX_DETAIL_GET_BYTES = 64 * 1024;
/** 契约 §2.4/§2.12：list limit 1–50。 */
export const MAX_DETAIL_LIST_LIMIT = 50;
/** 契约 §2.4：list domains 最多 16。 */
export const MAX_DETAIL_DOMAINS = 16;
/** 契约 §2.1：recordIds 最多与其他引用字段同量级；避免单节点过大。 */
export const MAX_DETAIL_RECORD_IDS = 200;
export const MAX_DETAIL_MESSAGE_ID_CHARS = 256;
export const MAX_DETAIL_REDACTION_RULES = 64;

const DAY_MS = 24 * 60 * 60 * 1000;
export const DETAIL_RETENTION_DAYS: Readonly<Record<Exclude<DetailRetentionClass, 'pinned'>, number>> = Object.freeze({
  conversation: 30,
  tool_output: 7,
  document_slice: 90,
});
/** conversation 可按域策略延长到 365 天；tool_output/document_slice 不延长。 */
export const DETAIL_RETENTION_MAX_DAYS: Readonly<Record<Exclude<DetailRetentionClass, 'pinned'>, number>> = Object.freeze({
  conversation: 365,
  tool_output: 7,
  document_slice: 90,
});
/** pinned 仅显式治理；给一个有限上限避免客户端写入“永久”不可清理的详情。 */
export const DETAIL_PINNED_MAX_DAYS = 3650;

/** 默认配额（契约 §2.7 / §6.16）。 */
export const DETAIL_QUOTA = Object.freeze({
  domainBytes: 256 * 1024 * 1024,
  cloudBytes: 1024 * 1024 * 1024,
  threadBytes: 64 * 1024 * 1024,
});

export interface DetailQuotaLimits {
  domainBytes: number;
  cloudBytes: number;
  threadBytes: number;
}

export const DEFAULT_DETAIL_QUOTA_LIMITS: DetailQuotaLimits = Object.freeze({ ...DETAIL_QUOTA });

export interface DetailRedaction {
  applied: boolean;
  rules: string[];
}

/** 服务端接受的详情写入输入（capability 已完成授权与受保护字段校验）。 */
export interface DetailWriteInput {
  domain: string;
  detailKind: DetailKind;
  text: string;
  mime?: DetailMime;
  role?: DetailRole;
  messageId?: string;
  chunkIndex?: number;
  turn?: number;
  threadId?: string;
  recordIds: string[];
  /** 客户端可回传用于一致性校验；必须等于 sha256(text)。 */
  contentHash?: string;
  redaction?: DetailRedaction;
  retentionClass?: DetailRetentionClass;
  /** 0 / 缺省 = 按 retentionClass 计算；显式值不得超过策略上限。 */
  expiresAt?: number;
  clientItemId?: string;
  /** 服务端推导的 provenance（capability 构造）。 */
  provenance?: Record<string, unknown>;
  /** 非受保护的自定义 metadata。 */
  metadata?: Record<string, unknown>;
  /** 可选回传，用于 owner_mismatch 校验。 */
  ownerType?: string;
  ownerId?: string;
}

export interface DetailWriteResultEntry {
  clientItemId?: string;
  status: 'created' | 'duplicate' | 'failed';
  id?: string;
  type?: typeof DETAIL_NODE_TYPE;
  kind?: typeof DETAIL_NODE_TYPE;
  domain: string;
  detailKind: DetailKind;
  contentHash: string;
  ownerType?: string;
  ownerId?: string;
  duplicate?: boolean;
  code?: string;
  retryable?: boolean;
  message?: string;
  details?: Record<string, unknown>;
}

export interface DetailWriteBatchResult {
  results: DetailWriteResultEntry[];
  created: number;
  duplicates: number;
  failed: number;
  partial: boolean;
  evicted: string[];
}

export interface DetailView {
  id: string;
  type: typeof DETAIL_NODE_TYPE;
  kind: typeof DETAIL_NODE_TYPE;
  detailKind: DetailKind;
  domain: string;
  ownerType: string;
  ownerId: string;
  text: string | null;
  truncated: boolean;
  redacted: boolean;
  expiresAt: number;
  availability: string[];
  recordIds: string[];
  provenance: Record<string, unknown>;
  mime: string;
  role: string | null;
  messageId: string | null;
  chunkIndex: number;
  turn: number | null;
  threadId: string | null;
  retentionClass: DetailRetentionClass;
  contentHash: string;
  redaction: DetailRedaction;
  deletedAt: number | null;
  deletedReason: string | null;
  createdAt: number;
  updatedAt: number;
}

export type DetailListView = Omit<DetailView, 'text' | 'truncated'> & {
  text: null;
  truncated: false;
};

export interface DetailListOptions {
  domains?: NamespaceFilter;
  threadId?: string;
  recordIds?: string[];
  detailKinds?: DetailKind[];
  limit?: number;
  offset?: number;
  includeExpired?: boolean;
  includeDeleted?: boolean;
  userId?: string;
  /** 测试/维护可注入的时钟。 */
  now?: number;
}

export interface DetailListResult {
  details: DetailListView[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

export interface DetailReadOptions {
  includeText?: boolean;
  maxBytes?: number;
  includeExpired?: boolean;
  includeDeleted?: boolean;
  userId?: string;
  /** 测试/维护可注入的时钟。 */
  now?: number;
}

export interface DetailDeleteOptions {
  reason?: DetailDeleteReason;
  actorType?: 'agent' | 'user' | 'system';
  agentId?: string;
  userId?: string;
}

export interface DetailDeleteResult {
  deleted: string[];
  notFound: string[];
  forbidden: string[];
  partial: boolean;
}

/** 结构化配额错误；capability 映射为 413 detail_quota_exceeded。 */
export class DetailQuotaError extends MebularError {
  readonly details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown>) {
    super(message, 'DETAIL_QUOTA_EXCEEDED');
    this.name = 'DetailQuotaError';
    this.details = details;
  }
}

/** 域 → owner（与 capability `deriveOwner` 同一规则，服务端推导）。 */
export function deriveDetailOwner(
  domain: string,
  { userId = 'user' }: { userId?: string } = {},
): { ownerType: string; ownerId: string } {
  if (domain === 'user') return { ownerType: 'user', ownerId: userId };
  if (domain.startsWith('agent:')) return { ownerType: 'agent', ownerId: domain.slice('agent:'.length) };
  return { ownerType: 'other', ownerId: domain };
}

export function detailContentHash(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

export function detailTextBytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

export function isDetailKind(value: unknown): value is DetailKind {
  return typeof value === 'string' && (DETAIL_KINDS as readonly string[]).includes(value);
}

export function isDetailRetentionClass(value: unknown): value is DetailRetentionClass {
  return typeof value === 'string' && (DETAIL_RETENTION_CLASSES as readonly string[]).includes(value);
}

export function isDetailRole(value: unknown): value is DetailRole {
  return typeof value === 'string' && (DETAIL_ROLES as readonly string[]).includes(value);
}

export function isDetailMime(value: unknown): value is DetailMime {
  return typeof value === 'string' && (DETAIL_MIMES as readonly string[]).includes(value);
}

export function isDetailDeleteReason(value: unknown): value is DetailDeleteReason {
  return typeof value === 'string' && (DETAIL_DELETE_REASONS as readonly string[]).includes(value);
}

/** 是否为 detail_record 内部节点（type + metadata.internal + internalObject.kind）。 */
export function isDetailNode(node: Node | null | undefined): node is Node {
  if (!node || node.type !== DETAIL_NODE_TYPE) return false;
  const metadata = node.metadata ?? {};
  if (metadata.internal !== true) return false;
  const internalObject = metadata.internalObject;
  return Boolean(internalObject)
    && typeof internalObject === 'object'
    && !Array.isArray(internalObject)
    && (internalObject as { kind?: unknown }).kind === DETAIL_INTERNAL_KIND;
}

export function detailInternalObject(node: Node | null | undefined): Record<string, unknown> {
  const value = node?.metadata?.internalObject;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function detailContent(node: Node | null | undefined): Record<string, unknown> {
  return node?.content && typeof node.content === 'object' && !Array.isArray(node.content)
    ? node.content as Record<string, unknown>
    : {};
}

export function detailRecordIds(node: Node | null | undefined): string[] {
  const value = detailContent(node).recordIds;
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
}

export function detailExpiresAt(node: Node | null | undefined): number {
  const content = detailContent(node);
  const value = typeof content.expiresAt === 'number' ? content.expiresAt : detailInternalObject(node).expiresAt;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function detailRetentionClass(node: Node | null | undefined): DetailRetentionClass {
  const value = detailContent(node).retentionClass;
  return isDetailRetentionClass(value) ? value : 'conversation';
}

export function detailDeletedReason(node: Node | null | undefined): string | null {
  const value = node?.metadata?.deletedReason;
  return typeof value === 'string' ? value : null;
}

export function isDetailExpired(node: Node | null | undefined, now = Date.now()): boolean {
  const expiresAt = detailExpiresAt(node);
  return expiresAt > 0 && expiresAt < now;
}

export function detailBytes(node: Node | null | undefined): number {
  const text = detailContent(node).text;
  return typeof text === 'string' ? detailTextBytes(text) : 0;
}

export function detailAvailability(node: Node | null | undefined, now = Date.now()): string[] {
  if (node?.deletedAt) {
    const reason = detailDeletedReason(node);
    if (reason === 'quota_evicted') return ['quota_evicted'];
    if (reason === 'retention_expired') return ['expired'];
    return ['deleted'];
  }
  if (isDetailExpired(node, now)) return ['expired'];
  return ['available'];
}

export function truncateDetailText(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const limit = Math.min(Math.max(1, Math.trunc(maxBytes)), MAX_DETAIL_GET_BYTES);
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= limit) return { text, truncated: false };
  let end = limit;
  // 回退到 UTF-8 字符起始字节，避免把多字节字符截成替换符。
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) {
    end -= 1;
  }
  return { text: buffer.subarray(0, end).toString('utf8'), truncated: true };
}

/** 计算服务端保留到期时间；显式 expiresAt 不得超过策略上限。 */
export function resolveDetailExpiresAt(
  retentionClass: DetailRetentionClass,
  requested: number | undefined,
  now: number,
): number {
  const requestedAt = requested === undefined || requested === null ? 0 : requested;
  if (typeof requestedAt !== 'number' || !Number.isFinite(requestedAt) || requestedAt < 0) {
    throw new RangeError('expiresAt 必须是非负有限数字');
  }
  if (retentionClass === 'pinned') {
    // pinned 是显式治理动作：0 表示直到删除；显式到期时间由治理方负责。
    return requestedAt;
  }
  const max = now + DETAIL_RETENTION_MAX_DAYS[retentionClass] * DAY_MS;
  if (requestedAt === 0) return now + DETAIL_RETENTION_DAYS[retentionClass] * DAY_MS;
  if (requestedAt > max) {
    throw new RangeError(`${retentionClass} expiresAt 超过策略上限（${DETAIL_RETENTION_MAX_DAYS[retentionClass]} 天）`);
  }
  return requestedAt;
}

export function buildDetailContent(
  input: DetailWriteInput,
  {
    contentHash,
    expiresAt,
    threadId,
  }: { contentHash: string; expiresAt: number; threadId: string | null },
): Record<string, unknown> {
  const retentionClass = input.retentionClass ?? 'conversation';
  return {
    detailKind: input.detailKind,
    text: input.text,
    mime: input.mime ?? 'text/plain',
    ...(input.role !== undefined ? { role: input.role } : {}),
    ...(input.messageId !== undefined ? { messageId: input.messageId } : {}),
    chunkIndex: input.chunkIndex ?? 0,
    ...(input.turn !== undefined ? { turn: input.turn } : {}),
    ...(threadId !== null ? { threadId } : {}),
    recordIds: [...input.recordIds],
    contentHash,
    redaction: normalizeRedaction(input.redaction),
    retentionClass,
    expiresAt,
  };
}

export function normalizeRedaction(value: DetailRedaction | undefined): DetailRedaction {
  if (!value) return { applied: false, rules: [] };
  const rules = Array.isArray(value.rules)
    ? [...new Set(value.rules.filter((rule): rule is string => typeof rule === 'string' && rule.length > 0))]
      .slice(0, MAX_DETAIL_REDACTION_RULES)
    : [];
  return { applied: value.applied === true, rules };
}

export function detailView(
  node: Node,
  {
    includeText = true,
    maxBytes = MAX_DETAIL_GET_BYTES,
    includeExpired = false,
    includeDeleted = false,
    userId = 'user',
    now = Date.now(),
  }: DetailReadOptions & { now?: number } = {},
): DetailView {
  const content = detailContent(node);
  const domain = domainOfNamespace(node.namespace);
  const owner = deriveDetailOwner(domain, { userId });
  const availability = detailAvailability(node, now);
  const available = availability[0] === 'available';
  const visibleText = includeText && (available || includeExpired || includeDeleted);
  const rawText = typeof content.text === 'string' ? content.text : '';
  const textResult = visibleText ? truncateDetailText(rawText, maxBytes) : { text: null as string | null, truncated: false };
  const redaction = normalizeRedaction(
    content.redaction && typeof content.redaction === 'object' && !Array.isArray(content.redaction)
      ? content.redaction as DetailRedaction
      : undefined,
  );
  return {
    id: node.id,
    type: DETAIL_NODE_TYPE,
    kind: DETAIL_NODE_TYPE,
    detailKind: (isDetailKind(content.detailKind) ? content.detailKind : 'raw_chunk'),
    domain,
    ownerType: owner.ownerType,
    ownerId: owner.ownerId,
    text: textResult.text,
    truncated: textResult.truncated,
    redacted: redaction.applied,
    expiresAt: detailExpiresAt(node),
    availability,
    recordIds: detailRecordIds(node),
    provenance: node.metadata?.provenance && typeof node.metadata.provenance === 'object'
      ? node.metadata.provenance as Record<string, unknown>
      : {},
    mime: typeof content.mime === 'string' ? content.mime : 'text/plain',
    role: typeof content.role === 'string' ? content.role : null,
    messageId: typeof content.messageId === 'string' ? content.messageId : null,
    chunkIndex: typeof content.chunkIndex === 'number' ? content.chunkIndex : 0,
    turn: typeof content.turn === 'number' ? content.turn : null,
    threadId: typeof content.threadId === 'string' ? content.threadId : null,
    retentionClass: detailRetentionClass(node),
    contentHash: typeof content.contentHash === 'string' ? content.contentHash : '',
    redaction,
    deletedAt: typeof node.deletedAt === 'number' ? node.deletedAt : null,
    deletedReason: detailDeletedReason(node),
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  };
}

export function detailListView(
  node: Node,
  options: DetailReadOptions & { now?: number } = {},
): DetailListView {
  const view = detailView(node, { ...options, includeText: false, maxBytes: 1 });
  return { ...view, text: null, truncated: false };
}

export function detailMatchesFilters(node: Node, options: DetailListOptions, now = Date.now()): boolean {
  if (!isDetailNode(node)) return false;
  if (!options.includeDeleted && node.deletedAt) return false;
  if (!node.deletedAt) {
    const expired = isDetailExpired(node, now);
    if (!options.includeExpired && expired) return false;
  }
  const domain = domainOfNamespace(node.namespace);
  if (options.domains !== undefined && !matchesNamespace(domain, options.domains)) return false;
  const content = detailContent(node);
  if (options.threadId !== undefined && content.threadId !== options.threadId) return false;
  if (Array.isArray(options.detailKinds) && options.detailKinds.length > 0) {
    if (!isDetailKind(content.detailKind) || !options.detailKinds.includes(content.detailKind)) return false;
  }
  if (Array.isArray(options.recordIds) && options.recordIds.length > 0) {
    const recordIds = detailRecordIds(node);
    if (!recordIds.some((id) => options.recordIds!.includes(id))) return false;
  }
  return true;
}
