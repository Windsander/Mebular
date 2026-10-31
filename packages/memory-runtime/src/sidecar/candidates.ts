// 宿主候选校验、记忆域路由与 capability `/write` item 构造。
//
// 关键边界（contract v2 §4 / §6、sidecar §8.3）：
// - 宿主候选用 `{kind, data|content, domain|namespace?, provenance?}`；
//   不信任宿主提交的 ownerType/ownerId；
// - 直接用户陈述/明确偏好 → `user`（confirmation=explicit）；
// - Agent 自己的观察/学习 → `agent:<self>`；
// - 未分类 → `default`；任务 → `task:<threadId>`（仅显式 threadId）；
// - 禁止写其他 `agent:<id>`、`system`，禁止未确认的观察冒充用户事实。
//
// 本模块不 import @mebular/core，也不打开图/事件日志。

import { createHash } from 'node:crypto';
import {
  agentDomain,
  checkWriteDomain,
  isAgentDomain,
  isTaskDomain,
  normalizeDomain,
  policyAllowsUserWrite,
  taskDomain,
  threadIdOfDomain,
  type SidecarPolicy,
} from './domains.js';
import { SidecarSettlementError } from './errors.js';

export const MAX_CANDIDATES = 100;
export const MAX_CONTENT_BYTES = 262_144;
export const MAX_TAGS = 32;
export const MAX_TAG_CHARS = 128;
export const MAX_RELATED = 32;
export const MAX_ARRAY_ITEMS = 64;
export const MAX_ARRAY_ITEM_CHARS = 1024;

const WRITE_KINDS = new Set(['fact', 'preference', 'episode', 'observation', 'skill', 'entity']);
const EPISODE_TYPES = new Set(['conversation', 'task', 'decision', 'error', 'observation', 'other']);
const ENTITY_TYPES = new Set(['user', 'project', 'tool', 'concept', 'organization', 'location', 'other']);
const CLIENT_ITEM_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export type CandidateKind = 'fact' | 'preference' | 'episode' | 'observation' | 'skill' | 'entity';
export type Confirmation = 'explicit' | 'policy' | 'none';

export interface CandidateInput {
  kind: CandidateKind;
  content: Record<string, unknown>;
  domainHint: string | null;
  tags: string[];
  relatedTo: string[];
  validFrom?: number;
  validTo?: number;
  confirmation: Confirmation;
}

export interface RoutedCandidate extends CandidateInput {
  domain: string;
  /** 用户域只有 explicit 才允许；其他域固定 none。 */
  finalConfirmation: Confirmation;
  warnings: string[];
}

export interface RouteContext {
  agentId: string;
  threadId?: string | null;
  requestDomain?: string | null;
  policy?: SidecarPolicy | null;
}

export interface CandidateValidationResult {
  candidates: CandidateInput[];
  warnings: string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const entry = (value as Record<string, unknown>)[key];
    if (entry !== undefined) out[key] = canonicalize(entry);
  }
  return out;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function byteSize(value: unknown): number {
  return Buffer.byteLength(typeof value === 'string' ? value : canonicalJson(value), 'utf8');
}

function invalid(field: string, message: string): never {
  throw new SidecarSettlementError('validation_failed', message, {
    status: 422,
    details: { field },
  });
}

function requiredString(value: unknown, field: string, maxChars = 4096): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    invalid(field, `${field} 必须是非空字符串`);
  }
  if (value.length > maxChars) invalid(field, `${field} 不能超过 ${maxChars} 字符`);
  return value;
}

function optionalString(value: unknown, field: string, maxChars: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length > maxChars) {
    invalid(field, `${field} 必须是字符串且不超过 ${maxChars} 字符`);
  }
  return value;
}

function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    invalid(field, `${field} 必须是有限数字`);
  }
  return value;
}

function optionalConfidence(value: unknown, field: string): number | undefined {
  const confidence = optionalNumber(value, field);
  if (confidence !== undefined && (confidence < 0 || confidence > 1)) {
    invalid(field, `${field} 必须在 [0,1] 区间`);
  }
  return confidence;
}

function stringArray(
  value: unknown,
  field: string,
  { maxItems = MAX_TAGS, maxChars = MAX_TAG_CHARS }: { maxItems?: number; maxChars?: number } = {},
): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) invalid(field, `${field} 必须是字符串数组`);
  if (value.length > maxItems) invalid(field, `${field} 最多 ${maxItems} 项`);
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim().length === 0 || entry.length > maxChars) {
      invalid(field, `${field} 每项需为 1–${maxChars} 字符`);
    }
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}

function normalizeTags(value: unknown): string[] {
  const tags = stringArray(value, 'tags');
  for (const tag of tags) {
    if (tag.startsWith('mebular:runtime:')) {
      invalid('tags', '不得使用 mebular:runtime:* 保留标签');
    }
  }
  return tags;
}

function normalizeConfirmation(value: unknown): Confirmation {
  if (value === undefined || value === null) return 'none';
  if (value === 'explicit' || value === 'policy' || value === 'none') return value;
  invalid('provenance.confirmation', 'confirmation 非法');
}

function factContent(raw: Record<string, unknown>): Record<string, unknown> {
  const content: Record<string, unknown> = {
    subject: requiredString(raw.subject, 'content.subject'),
    predicate: requiredString(raw.predicate, 'content.predicate'),
    object: requiredString(raw.object, 'content.object'),
  };
  const confidence = optionalConfidence(raw.confidence, 'content.confidence');
  if (confidence !== undefined) content.confidence = confidence;
  const source = optionalString(raw.source, 'content.source', 200);
  if (source !== undefined) content.source = source;
  return content;
}

function preferenceContent(raw: Record<string, unknown>): Record<string, unknown> {
  const content: Record<string, unknown> = {
    entity: requiredString(raw.entity, 'content.entity'),
    preferenceType: requiredString(raw.preferenceType, 'content.preferenceType'),
    value: requiredString(raw.value, 'content.value'),
  };
  const confidence = optionalConfidence(raw.confidence, 'content.confidence');
  if (confidence !== undefined) content.confidence = confidence;
  const source = optionalString(raw.source, 'content.source', 200);
  if (source !== undefined) content.source = source;
  return content;
}

function episodeContent(raw: Record<string, unknown>): Record<string, unknown> {
  const episodeType = requiredString(raw.episodeType, 'content.episodeType', 32);
  if (!EPISODE_TYPES.has(episodeType)) invalid('content.episodeType', 'content.episodeType 非法');
  const content: Record<string, unknown> = {
    episodeType,
    content: requiredString(raw.content, 'content.content', 262_144),
  };
  const title = optionalString(raw.title, 'content.title', 512);
  if (title !== undefined) content.title = title;
  const startTime = optionalNumber(raw.startTime, 'content.startTime');
  if (startTime !== undefined) content.startTime = startTime;
  const endTime = optionalNumber(raw.endTime, 'content.endTime');
  if (endTime !== undefined) content.endTime = endTime;
  if (startTime !== undefined && endTime !== undefined && endTime < startTime) {
    invalid('content.endTime', 'endTime 早于 startTime');
  }
  const context = optionalString(raw.context, 'content.context', 512);
  if (context !== undefined) content.context = context;
  return content;
}

function skillContent(raw: Record<string, unknown>): Record<string, unknown> {
  const content: Record<string, unknown> = {
    name: requiredString(raw.name, 'content.name'),
    description: requiredString(raw.description, 'content.description'),
    category: requiredString(raw.category, 'content.category'),
  };
  for (const field of ['steps', 'commands', 'toolReferences', 'prerequisites', 'relatedEntities'] as const) {
    if (raw[field] === undefined || raw[field] === null) continue;
    content[field] = stringArray(raw[field], `content.${field}`, {
      maxItems: MAX_ARRAY_ITEMS,
      maxChars: MAX_ARRAY_ITEM_CHARS,
    });
  }
  return content;
}

function entityContent(raw: Record<string, unknown>): Record<string, unknown> {
  const entityType = requiredString(raw.entityType, 'content.entityType', 64);
  if (!ENTITY_TYPES.has(entityType)) invalid('content.entityType', 'content.entityType 非法');
  const content: Record<string, unknown> = {
    entityType,
    name: requiredString(raw.name, 'content.name'),
  };
  const description = optionalString(raw.description, 'content.description', 4096);
  if (description !== undefined) content.description = description;
  if (raw.properties !== undefined && raw.properties !== null) {
    if (!isObject(raw.properties)) invalid('content.properties', 'content.properties 必须是对象');
    if (byteSize(raw.properties) > 16_384) invalid('content.properties', 'content.properties 超过 16 KiB');
    content.properties = raw.properties;
  }
  return content;
}

function normalizeContent(kind: CandidateKind, raw: Record<string, unknown>): Record<string, unknown> {
  if (byteSize(raw) > MAX_CONTENT_BYTES) {
    throw new SidecarSettlementError('payload_too_large', 'content 超过 256 KiB', {
      status: 413,
      details: { field: 'content' },
    });
  }
  switch (kind) {
    case 'fact':
      return factContent(raw);
    case 'preference':
      return preferenceContent(raw);
    case 'episode':
      return episodeContent(raw);
    case 'observation':
      return { content: requiredString(raw.content, 'content.content', 262_144) };
    case 'skill':
      return skillContent(raw);
    case 'entity':
      return entityContent(raw);
  }
}

/** 校验一条宿主候选；非法时抛 validation_failed。 */
export function normalizeCandidate(value: unknown): CandidateInput {
  if (!isObject(value)) invalid('candidate', 'candidate 必须是对象');
  const kind = value.kind;
  if (typeof kind !== 'string' || !WRITE_KINDS.has(kind)) {
    invalid('kind', 'kind 非法');
  }
  const typedKind = kind as CandidateKind;
  const rawContent = isObject(value.content) ? value.content : (isObject(value.data) ? value.data : null);
  if (!rawContent) invalid('content', 'candidate.content 必须是非空对象');

  const content = normalizeContent(typedKind, rawContent);

  const domainValue = value.domain ?? value.namespace;
  let domainHint: string | null = null;
  if (domainValue !== undefined && domainValue !== null) {
    domainHint = normalizeDomain(domainValue);
    if (domainHint === null) {
      throw new SidecarSettlementError('domain_invalid', 'candidate.domain 非法', {
        status: 400,
        details: { field: 'domain' },
      });
    }
  }
  if (value.domain !== undefined && value.namespace !== undefined) {
    const namespace = normalizeDomain(value.namespace);
    if (namespace === null || namespace !== domainHint) {
      throw new SidecarSettlementError('domain_invalid', 'candidate.domain 与 namespace 不一致', {
        status: 400,
        details: { field: 'domain' },
      });
    }
  }

  const provenance = isObject(value.provenance) ? value.provenance : {};
  const confirmation = normalizeConfirmation(value.confirmation ?? provenance.confirmation);

  const validFrom = optionalNumber(value.validFrom ?? rawContent.validFrom, 'validFrom');
  const validTo = optionalNumber(value.validTo ?? rawContent.validTo, 'validTo');
  if (validFrom !== undefined && validTo !== undefined && validTo < validFrom) {
    invalid('validTo', 'validTo 必须不早于 validFrom');
  }

  if (value.clientItemId !== undefined && value.clientItemId !== null) {
    if (typeof value.clientItemId !== 'string' || !CLIENT_ITEM_ID_RE.test(value.clientItemId)) {
      invalid('clientItemId', 'clientItemId 格式非法');
    }
  }

  return {
    kind: typedKind,
    content,
    domainHint,
    tags: normalizeTags(value.tags),
    relatedTo: stringArray(value.relatedTo, 'relatedTo', { maxItems: MAX_RELATED, maxChars: 128 }),
    ...(validFrom !== undefined ? { validFrom } : {}),
    ...(validTo !== undefined ? { validTo } : {}),
    confirmation,
  };
}

export function validateCandidates(raw: unknown): CandidateValidationResult {
  if (raw === undefined || raw === null) return { candidates: [], warnings: [] };
  if (!Array.isArray(raw)) {
    throw new SidecarSettlementError('invalid_request', 'candidates 必须是数组', { status: 400 });
  }
  if (raw.length > MAX_CANDIDATES) {
    throw new SidecarSettlementError('payload_too_large', `candidates 不能超过 ${MAX_CANDIDATES} 条`, {
      status: 413,
    });
  }
  const candidates: CandidateInput[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const [index, value] of raw.entries()) {
    try {
      const candidate = normalizeCandidate(value);
      const key = candidateKey(candidate);
      if (seen.has(key)) {
        warnings.push(`duplicate_candidate:${index}`);
        continue;
      }
      seen.add(key);
      candidates.push(candidate);
    } catch (error) {
      if (error instanceof SidecarSettlementError && error.code === 'payload_too_large') {
        throw error;
      }
      const message = error instanceof SidecarSettlementError ? error.message : '候选非法';
      warnings.push(`invalid_candidate:${index}:${message}`);
    }
  }
  return { candidates, warnings };
}

function candidateKey(candidate: CandidateInput): string {
  return [
    candidate.kind,
    candidate.domainHint ?? '',
    canonicalJson(candidate.content),
    candidate.validFrom ?? '',
    candidate.validTo ?? '',
  ].join('\u0000');
}

function forbidden(message: string, details?: unknown): never {
  throw new SidecarSettlementError('domain_write_forbidden', message, {
    status: 403,
    details,
  });
}

function domainMismatch(message: string, details?: unknown): never {
  throw new SidecarSettlementError('domain_mismatch', message, {
    status: 400,
    details,
  });
}

function requireWritable(
  context: RouteContext,
  domain: string,
  confirmation: Confirmation,
  fallback?: string,
): void {
  const check = checkWriteDomain(context.policy, {
    agentId: context.agentId,
    threadId: context.threadId ?? null,
    domain,
    confirmation,
  });
  if (check.allowed) return;
  if (check.code === 'domain_mismatch') {
    domainMismatch(check.reason ?? '域与当前 threadId 不一致', { domain, ...(fallback ? { allowedDomain: fallback } : {}) });
  }
  forbidden(check.reason ?? '当前 Agent 不能写入该域', {
    domain,
    actor: context.agentId,
    ...(check.allowedDomain ? { allowedDomain: check.allowedDomain } : {}),
  });
}

interface RoutedOnce {
  domain: string;
  confirmation: Confirmation;
  warnings: string[];
}

/**
 * 显式域/提示域的落地规则。
 * 返回 null 表示该提示不适用于此候选，让自动路由决定。
 */
function routeExplicit(
  candidate: CandidateInput,
  hint: string,
  context: RouteContext,
): RoutedOnce {
  const warnings: string[] = [];
  // `default` 是 Third/Other 兜底，不是用户域。明确偏好/已确认用户事实
  // 即使被 hint 成 default，也回到 user；未被授权时降级到自己的 Agent 域。
  if (hint === 'default'
    && (candidate.kind === 'preference'
      || (candidate.kind === 'fact' && candidate.confirmation === 'explicit'))) {
    if (policyAllowsUserWrite(context.policy, context.agentId)) {
      requireWritable(context, 'user', 'explicit', agentDomain(context.agentId));
      warnings.push('user_domain_enforced');
      return { domain: 'user', confirmation: 'explicit', warnings };
    }
    warnings.push('user_domain_not_allowed_downgraded');
    return {
      domain: agentDomain(context.agentId),
      confirmation: 'none',
      warnings,
    };
  }
  if (hint === 'user') {
    if (candidate.kind !== 'fact' && candidate.kind !== 'preference') {
      forbidden('user 域只接受用户事实/偏好，观察、任务与技能不能冒充用户信息', {
        domain: hint,
        actor: context.agentId,
        allowedDomain: agentDomain(context.agentId),
      });
    }
    let confirmation: Confirmation = candidate.confirmation;
    if (candidate.kind === 'preference' && confirmation === 'none') {
      // 明确的偏好即用户陈述；只有偏好可以使用这个默认。
      confirmation = 'explicit';
    }
    if (confirmation !== 'explicit') {
      warnings.push('user_domain_unconfirmed_downgraded');
      return {
        domain: agentDomain(context.agentId),
        confirmation: 'none',
        warnings,
      };
    }
    if (!policyAllowsUserWrite(context.policy, context.agentId)) {
      warnings.push('user_domain_not_allowed_downgraded');
      return {
        domain: agentDomain(context.agentId),
        confirmation: 'none',
        warnings,
      };
    }
    requireWritable(context, 'user', 'explicit', agentDomain(context.agentId));
    return { domain: 'user', confirmation: 'explicit', warnings };
  }

  if (hint === 'system') {
    forbidden('system 域只允许 admin 写入', { domain: hint, actor: context.agentId });
  }
  if (isAgentDomain(hint)) {
    const owner = hint.slice('agent:'.length);
    if (owner !== context.agentId) {
      forbidden('Agent 不能写入其他 Agent 的记忆域', {
        domain: hint,
        actor: context.agentId,
        allowedDomain: agentDomain(context.agentId),
      });
    }
  }
  if (isTaskDomain(hint) && (!context.threadId || threadIdOfDomain(hint) !== context.threadId)) {
    domainMismatch('任务域必须与当前显式 threadId 一致', {
      domain: hint,
      threadId: context.threadId ?? null,
    });
  }
  requireWritable(context, hint, candidate.confirmation, agentDomain(context.agentId));
  return { domain: hint, confirmation: candidate.confirmation, warnings };
}

/** 按角色/内容/授权决定候选的最终记忆域。 */
export function routeCandidate(candidate: CandidateInput, context: RouteContext): RoutedCandidate {
  const warnings: string[] = [];
  const explicit = candidate.domainHint ?? normalizeDomain(context.requestDomain);
  if (candidate.domainHint === null && context.requestDomain !== undefined && context.requestDomain !== null) {
    if (normalizeDomain(context.requestDomain) === null) {
      throw new SidecarSettlementError('domain_invalid', 'domain 非法', {
        status: 400,
        details: { field: 'domain' },
      });
    }
  }

  if (explicit) {
    const routed = routeExplicit(candidate, explicit, context);
    warnings.push(...routed.warnings);
    return {
      ...candidate,
      domain: routed.domain,
      finalConfirmation: routed.confirmation,
      warnings,
    };
  }

  if (candidate.kind === 'preference') {
    if (policyAllowsUserWrite(context.policy, context.agentId)) {
      requireWritable(context, 'user', 'explicit', agentDomain(context.agentId));
      return { ...candidate, domain: 'user', finalConfirmation: 'explicit', warnings };
    }
    const domain = agentDomain(context.agentId);
    requireWritable(context, domain, 'none');
    warnings.push('user_domain_not_allowed_downgraded');
    return { ...candidate, domain, finalConfirmation: 'none', warnings };
  }

  if (candidate.kind === 'fact') {
    if (candidate.confirmation === 'explicit' && policyAllowsUserWrite(context.policy, context.agentId)) {
      requireWritable(context, 'user', 'explicit', agentDomain(context.agentId));
      return { ...candidate, domain: 'user', finalConfirmation: 'explicit', warnings };
    }
    requireWritable(context, 'default', 'none');
    return { ...candidate, domain: 'default', finalConfirmation: 'none', warnings };
  }

  if (candidate.kind === 'observation' || candidate.kind === 'skill') {
    const domain = agentDomain(context.agentId);
    requireWritable(context, domain, 'none');
    return { ...candidate, domain, finalConfirmation: 'none', warnings };
  }

  if (candidate.kind === 'episode') {
    if (context.threadId) {
      const domain = taskDomain(context.threadId);
      requireWritable(context, domain, 'none', 'default');
      return { ...candidate, domain, finalConfirmation: 'none', warnings };
    }
    requireWritable(context, 'default', 'none');
    return { ...candidate, domain: 'default', finalConfirmation: 'none', warnings };
  }

  requireWritable(context, 'default', 'none');
  return { ...candidate, domain: 'default', finalConfirmation: 'none', warnings };
}

export interface WriteProvenance {
  source: 'runtime' | 'host';
  extractor: 'heuristic' | 'local' | 'host' | 'api';
  model: string | null;
  threadId?: string;
  messageIds: string[];
  /** 旧字段：仅兼容旧读取方；0.3 新写入不依赖本地 staging id。 */
  rawChunkIds?: string[];
  /** 指向 DetailRecord；由 detail 沉降后回填。 */
  detailIds?: string[];
  confirmation: Confirmation;
  agentName?: string;
}

export interface CapabilityWriteItem {
  clientItemId: string;
  domain: string;
  kind: CandidateKind;
  content: Record<string, unknown>;
  tags?: string[];
  relatedTo?: string[];
  validFrom?: number;
  validTo?: number;
  /** 记录级修正：同域、同 subject/predicate 的旧事实 id。 */
  supersedes?: string[];
  provenance: WriteProvenance;
}

/** 由内容派生稳定的逐项幂等键；不用宿主正文做 id。 */
export function clientItemIdFor(candidate: RoutedCandidate, agentId: string): string {
  const hash = sha256Hex([
    agentId,
    candidate.domain,
    candidate.kind,
    canonicalJson(candidate.content),
    candidate.validFrom ?? '',
  ].join('\u0000'));
  return `cand_${hash.slice(0, 48)}`;
}

/** 构造 capability `/write` item；不发送 ownerType/ownerId。 */
export function toWriteItem(
  candidate: RoutedCandidate,
  context: {
    agentId: string;
    threadId?: string | null;
    messageIds?: string[];
    rawChunkIds?: string[];
    provenance: Omit<WriteProvenance, 'confirmation'>;
  },
): CapabilityWriteItem {
  const provenance: WriteProvenance = {
    ...context.provenance,
    confirmation: candidate.finalConfirmation,
    ...(context.threadId ? { threadId: context.threadId } : {}),
    // capability 的 provenance 上限 8 KiB；这里保守截断，避免 413。
    messageIds: [...(context.messageIds ?? [])].slice(0, 16),
    ...(context.rawChunkIds && context.rawChunkIds.length > 0
      ? { rawChunkIds: [...context.rawChunkIds].slice(0, 32) }
      : {}),
  };
  const item: CapabilityWriteItem = {
    clientItemId: clientItemIdFor(candidate, context.agentId),
    domain: candidate.domain,
    kind: candidate.kind,
    content: candidate.content,
    provenance,
  };
  if (candidate.tags.length > 0) item.tags = [...candidate.tags];
  if (candidate.relatedTo.length > 0) item.relatedTo = [...candidate.relatedTo];
  if (candidate.validFrom !== undefined) item.validFrom = candidate.validFrom;
  if (candidate.validTo !== undefined) item.validTo = candidate.validTo;
  return item;
}
