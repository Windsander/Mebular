// MCP Memory Capability API（0.3.0 contract v2 §7.1 / capability-api §1–§6）
//
// 内部接口：`/internal/memory/v1`，运行在 MCP daemon 内，只允许本机 memory-runtime
// sidecar 调用。不是公共 MCP 工具面（29 工具不变）。
//
// 端点：
//   GET  /version
//   GET  /status
//   GET  /namespaces
//   POST /query /search /history /profile /skills /graph
//   POST /write /update /delete /archive /internal-object
//   GET/POST /sync
//
// 约束：
// - 只调用 MemoryService / Mebular 公共方法；不直接打开 GraphStore 文件、不 append
//   事件、不新增事件类型或同步协议。普通 MemoryRecord 的读写只经 MemoryService；
//   只有 internal-object（compact/self_record/context_checkpoint）允许直接 GraphStore 写入。
// - 读取（query/search/history/profile/skills/graph）、状态/域统计与同步状态都由
//   MemoryService 统一执行；capability 只负责授权域、owner/provenance 投影与响应信封。
// - 内部对象（metadata.internal / __*）默认不返回；graph 不遍历内部对象。
// - capability token 不进入日志、status、错误详情；响应使用统一信封。
// - 本模块不 import @mebular/memory-runtime 的业务实现。

import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { domainOfNamespace, semanticKindOf } from '@mebular/core';
import {
  ensureCapabilityToken,
  removeCapabilityToken,
  verifyCapabilityToken,
} from './memory-runtime-token.mjs';
import { APP_VERSION } from './version.mjs';

export { domainOfNamespace };

export const CAPABILITY_API_PREFIX = '/internal/memory/v1';
export const CAPABILITY_API_VERSION = 1;
export const CAPABILITY_SCHEMA_VERSION = 1;

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_QUERY_BYTES = 8 * 1024;
const MAX_DOMAINS = 16;
const MAX_LIMIT = 50;
const MAX_DEPTH = 5;
const DEFAULT_LIMIT = 10;
const MAX_TAGS = 32;
const MAX_TAG_CHARS = 128;
const MAX_BATCH_ITEMS = 100;
const MAX_CONTENT_BYTES = 256 * 1024;
const MAX_PROVENANCE_BYTES = 8 * 1024;
const MAX_COMPACT_SUMMARY_BYTES = 64 * 1024;
const MAX_CHECKPOINT_STATE_BYTES = 256 * 1024;
const MAX_COMPACT_SOURCES = 200;
const MAX_RELATED = 32;
const MAX_MESSAGE_IDS = 64;
const MAX_JSON_FIELD_BYTES = 16 * 1024;
const OPEN_VALID_TO = 9999999999999;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const IDEMPOTENCY_MAX_ENTRIES = 5000;
const IDEMPOTENCY_LEDGER_VERSION = 1;
const IDEMPOTENCY_LEDGER_FILE = 'capability-idempotency.json';
const MAX_SYNC_WAIT_MS = 30_000;

const AGENT_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const THREAD_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{1,200}$/;
const CLIENT_ITEM_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

const RESERVED_DOMAINS = new Set(['user', 'default', 'shared', 'system']);
const ALLOWED_TYPES = new Set(['fact', 'preference', 'episode', 'observation', 'skill', 'entity', 'meta']);
const DEFAULT_TYPES = ['fact', 'preference', 'episode', 'observation', 'skill', 'entity'];
const WRITE_ENDPOINTS = new Set(['write', 'update', 'delete', 'archive', 'internal-object', 'sync']);
const INTERNAL_OBJECT_KINDS = ['compact', 'self_record', 'context_checkpoint'];
const WRITE_KINDS = new Set(['fact', 'preference', 'episode', 'observation', 'skill', 'entity']);
const EPISODE_KINDS = new Set(['conversation', 'task', 'decision', 'error', 'observation', 'other']);
const ENTITY_KINDS = new Set(['user', 'project', 'tool', 'concept', 'organization', 'location', 'other']);
const SOURCE_VALUES = new Set(['mcp', 'runtime', 'host', 'import', 'legacy']);
const EXTRACTOR_VALUES = new Set(['user', 'heuristic', 'local', 'host', 'api']);
const CONFIRMATION_VALUES = new Set(['explicit', 'policy', 'none']);
const PROTECTED_METADATA_KEYS = new Set([
  'internal',
  'internalObject',
  'provenance',
  'owner',
  'ownerType',
  'ownerId',
  'archivedAt',
  'domain',
  'namespace',
  'kind',
  'contentHash',
  'contentHashValidFrom',
  'clientItemId',
  'updatedBy',
]);
const PATCH_KEYS = new Set(['content', 'tags', 'validFrom', 'validTo', 'metadata']);

export const CAPABILITY_LIMITS = Object.freeze({
  maxBodyBytes: MAX_BODY_BYTES,
  maxBatchItems: MAX_BATCH_ITEMS,
  maxContentBytes: MAX_CONTENT_BYTES,
  maxProvenanceBytes: MAX_PROVENANCE_BYTES,
  maxDomains: MAX_DOMAINS,
  maxLimit: MAX_LIMIT,
  maxGraphDepth: MAX_DEPTH,
  maxCheckpointStateBytes: MAX_CHECKPOINT_STATE_BYTES,
  maxCompactSummaryBytes: MAX_COMPACT_SUMMARY_BYTES,
  maxCompactSources: MAX_COMPACT_SOURCES,
  idempotencyTtlMs: IDEMPOTENCY_TTL_MS,
});

class CapabilityError extends Error {
  constructor(status, code, message, details, retryable = false) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryable = retryable;
  }
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasValue(value) {
  return value !== undefined && value !== null;
}

/** 仅当 MCP 配置 `memoryRuntime.enabled=true` 时挂载能力端点。 */
export function isMemoryRuntimeEnabled(config) {
  return config?.memoryRuntime?.enabled === true;
}

export function isMemoryCapabilityPath(path) {
  return typeof path === 'string'
    && (path === CAPABILITY_API_PREFIX || path.startsWith(`${CAPABILITY_API_PREFIX}/`));
}

/** 服务端只接受这三个 loopback 地址（含 IPv4-mapped IPv6）。 */
export function isLoopbackRemoteAddress(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

export function isLoopbackHostname(hostname) {
  let normalized = String(hostname ?? '').toLowerCase();
  if (normalized.startsWith('[') && normalized.endsWith(']')) normalized = normalized.slice(1, -1);
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1';
}

/** 解析 Host 头；IPv6 用 `[::1]:port`。 */
export function parseHostHeader(header) {
  if (typeof header !== 'string' || header.length === 0) return null;
  const value = header.trim();
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end === -1) return null;
    const hostname = value.slice(1, end);
    const rest = value.slice(end + 1);
    if (rest === '') return { hostname, port: null };
    if (!rest.startsWith(':')) return null;
    return { hostname, port: rest.slice(1) };
  }
  const colon = value.lastIndexOf(':');
  if (colon === -1) return { hostname: value, port: null };
  // 裸 IPv6（无方括号）不是合法 Host；这里只在恰好一个冒号时按 host:port 解析。
  if (value.indexOf(':') !== colon) return null;
  return { hostname: value.slice(0, colon), port: value.slice(colon + 1) };
}

function portMatches(port, localPort) {
  if (!hasValue(localPort)) return true;
  if (port === null || port === '') return false;
  return String(port) === String(localPort);
}

export function hostHeaderAllowed(header, localPort) {
  const parsed = parseHostHeader(header);
  if (!parsed || !isLoopbackHostname(parsed.hostname)) return false;
  return portMatches(parsed.port, localPort);
}

export function originAllowed(origin, localPort) {
  if (!hasValue(origin) || origin === '') return true;
  if (typeof origin !== 'string') return false;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.username !== '' || parsed.password !== '') return false;
  if (!isLoopbackHostname(parsed.hostname)) return false;
  const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
  return portMatches(port, localPort);
}

/** agentId 语法（contract v2 §4.2）。 */
export function isValidAgentId(agentId) {
  return typeof agentId === 'string' && AGENT_ID_RE.test(agentId);
}

/** 记忆域语法；非法返回 null。 */
export function normalizeDomain(value) {
  if (typeof value !== 'string') return null;
  const domain = value.trim();
  if (domain.length === 0 || domain.length > 128) return null;
  // `__policy__` 与所有 `__*` 保留域不是记忆域。
  if (domain.startsWith('__')) return null;
  if (RESERVED_DOMAINS.has(domain)) return domain;
  if (domain.startsWith('agent:')) {
    return isValidAgentId(domain.slice('agent:'.length)) ? domain : null;
  }
  if (domain.startsWith('task:')) {
    return THREAD_ID_RE.test(domain.slice('task:'.length)) ? domain : null;
  }
  // 0.2 任意 namespace = Other 显式域；保留原值，不迁移、不改名。
  if (/[\u0000-\u001f\u007f/\\]/.test(domain)) return null;
  return domain;
}

/** 域 → 归属（服务端推导，客户端不能伪造）。 */
export function deriveOwner(domain, { userId = 'user' } = {}) {
  if (domain === 'user') return { ownerType: 'user', ownerId: userId };
  if (domain.startsWith('agent:')) return { ownerType: 'agent', ownerId: domain.slice('agent:'.length) };
  return { ownerType: 'other', ownerId: domain };
}

/** core 的通用内部可见性约定（contract v2 §5.3 / §9.2）。 */
export function isInternalNode(node) {
  if (!node) return false;
  if (node.metadata?.internal === true) return true;
  const namespace = node.namespace;
  return typeof namespace === 'string' && namespace.startsWith('__') && namespace !== '__policy__';
}

function isArchivedNode(node) {
  return typeof node?.metadata?.archivedAt === 'number';
}

// ---------- 写路径通用工具（W2b） ----------

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) out[key] = canonicalize(value[key]);
  }
  return out;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function byteSize(value) {
  return Buffer.byteLength(typeof value === 'string' ? value : canonicalJson(value), 'utf-8');
}

function jsonClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function validationError(index, field, message, extra) {
  return new CapabilityError(422, 'validation_failed', message, {
    ...(Number.isInteger(index) ? { index } : {}),
    field,
    ...(extra ?? {}),
  });
}

function nonEmptyString(value, field, index) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw validationError(index, field, `${field} 必须是非空字符串`);
  }
  return value;
}

function optionalString(value, field, index, maxChars = 4096) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length > maxChars) {
    throw validationError(index, field, `${field} 必须是字符串且不超过 ${maxChars} 字符`);
  }
  return value;
}

function optionalNumber(value, field, index) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw validationError(index, field, `${field} 必须是有限数字`);
  }
  return value;
}

function optionalConfidence(value, field, index) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw validationError(index, field, `${field} 必须在 [0,1] 区间`);
  }
  return value;
}

function stringArray(value, field, index, { maxItems = MAX_TAGS, maxChars = MAX_TAG_CHARS } = {}) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw validationError(index, field, `${field} 必须是字符串数组`);
  if (value.length > maxItems) throw validationError(index, field, `${field} 最多 ${maxItems} 项`);
  const out = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > maxChars) {
      throw validationError(index, field, `${field} 每项需为 1–${maxChars} 字符`);
    }
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}

function normalizeTags(value, index) {
  const tags = stringArray(value, 'tags', index) ?? [];
  for (const tag of tags) {
    if (tag.startsWith('mebular:runtime:')) {
      throw validationError(index, 'tags', '不得使用 mebular:runtime:* 保留标签', { tag });
    }
  }
  return tags;
}

function normalizeRelatedTo(value, index) {
  const related = stringArray(value, 'relatedTo', index, { maxItems: MAX_RELATED, maxChars: 128 }) ?? [];
  return related;
}

function normalizeMessageIds(value, field, index) {
  return stringArray(value, field, index, { maxItems: MAX_MESSAGE_IDS, maxChars: 256 }) ?? [];
}

function parseProvenanceInput(value, index) {
  if (value === undefined || value === null) return {};
  if (!isObject(value)) throw validationError(index, 'provenance', 'provenance 必须是对象');
  const out = {};
  if (value.source !== undefined) {
    if (!SOURCE_VALUES.has(value.source)) throw validationError(index, 'provenance.source', 'provenance.source 非法');
    out.source = value.source;
  }
  if (value.extractor !== undefined) {
    if (!EXTRACTOR_VALUES.has(value.extractor)) {
      throw validationError(index, 'provenance.extractor', 'provenance.extractor 非法');
    }
    out.extractor = value.extractor;
  }
  if (value.model !== undefined && value.model !== null) {
    if (typeof value.model !== 'string' || value.model.length > 128) {
      throw validationError(index, 'provenance.model', 'provenance.model 必须是字符串或 null');
    }
    out.model = value.model;
  } else {
    out.model = null;
  }
  if (value.threadId !== undefined && value.threadId !== null) {
    if (typeof value.threadId !== 'string' || !THREAD_ID_RE.test(value.threadId)) {
      throw validationError(index, 'provenance.threadId', 'threadId 格式非法');
    }
    out.threadId = value.threadId;
  }
  if (value.confirmation !== undefined) {
    if (!CONFIRMATION_VALUES.has(value.confirmation)) {
      throw validationError(index, 'provenance.confirmation', 'provenance.confirmation 非法');
    }
    out.confirmation = value.confirmation;
  }
  if (value.agentName !== undefined && value.agentName !== null) {
    if (typeof value.agentName !== 'string' || value.agentName.length > 128) {
      throw validationError(index, 'provenance.agentName', 'provenance.agentName 必须是字符串');
    }
    out.agentName = value.agentName;
  }
  out.messageIds = normalizeMessageIds(value.messageIds, 'provenance.messageIds', index);
  out.rawChunkIds = normalizeMessageIds(value.rawChunkIds, 'provenance.rawChunkIds', index);
  return out;
}

function buildWriteProvenance({
  input,
  actor,
  identity,
  hostId,
  now,
  threadId = null,
  confirmation = 'none',
}) {
  const writerId = actor.type === 'agent'
    ? actor.agentId
    : actor.type === 'user'
      ? (actor.userId ?? identity.userId ?? 'user')
      : 'system';
  return {
    source: input.source ?? 'runtime',
    writerType: actor.type,
    writerId,
    extractor: input.extractor ?? (actor.type === 'agent' ? 'heuristic' : 'user'),
    model: input.model ?? null,
    version: APP_VERSION,
    deviceId: identity.deviceId ?? null,
    hostId,
    threadId: input.threadId ?? threadId ?? null,
    agentId: actor.type === 'agent' ? actor.agentId : null,
    agentName: actor.displayName ?? input.agentName ?? null,
    messageIds: [...(input.messageIds ?? [])],
    rawChunkIds: [...(input.rawChunkIds ?? [])],
    confirmation,
    at: now,
  };
}

function domainWriteForbidden(message, details) {
  return new CapabilityError(403, 'domain_write_forbidden', message, details);
}

/**
 * 写权限矩阵（contract v2 §6.2 / capability-api §5.2）。
 * actor/domain 由服务端推导 owner；客户端只能在 item 里回传校验。
 */
function assertDomainWrite(actor, domain, provenanceInput, requestThreadId = null) {
  if (actor.type === 'system') return;
  if (actor.type === 'user') {
    // capability token 具备 memory.admin，user/system 可按治理矩阵写入。
    return;
  }
  if (domain === 'user') {
    if (provenanceInput?.confirmation !== 'explicit' || typeof provenanceInput?.source !== 'string'
      || provenanceInput.source.length === 0) {
      throw domainWriteForbidden('Agent 写入 user 域需要用户明确确认', {
        domain,
        actor: actor.agentId,
        allowedDomain: `agent:${actor.agentId}`,
      });
    }
    return;
  }
  if (domain === 'system') {
    throw domainWriteForbidden('Agent 不能写入 system 域', { domain, actor: actor.agentId });
  }
  if (domain.startsWith('agent:')) {
    if (domain !== `agent:${actor.agentId}`) {
      throw domainWriteForbidden('Agent 不能写入其他 Agent 的记忆域', {
        domain,
        actor: actor.agentId,
        allowedDomain: `agent:${actor.agentId}`,
      });
    }
    return;
  }
  if (domain.startsWith('task:')) {
    const threadId = domain.slice('task:'.length);
    const claimed = provenanceInput?.threadId ?? requestThreadId;
    if (claimed !== threadId) {
      throw domainWriteForbidden('Agent 只能写入自己参与且 threadId 匹配的任务域', {
        domain,
        actor: actor.agentId,
        threadId: claimed ?? null,
      });
    }
  }
}

/** 治理动作：user/system 全部；agent 只能治理自己域内、自己写入的记录。 */
function canGovernNode(actor, node) {
  if (actor.type === 'user' || actor.type === 'system') return true;
  if (actor.type !== 'agent') return false;
  const domain = domainOfNamespace(node?.namespace);
  if (domain !== `agent:${actor.agentId}`) return false;
  const provenance = isObject(node?.metadata?.provenance) ? node.metadata.provenance : {};
  return provenance.writerId === actor.agentId;
}

/** 更新：agent 只能更新自己域内、自己写入的记录。 */
function canUpdateNode(actor, node) {
  return canGovernNode(actor, node);
}

function factExtras(raw, index) {
  const confidence = optionalConfidence(raw.confidence, 'content.confidence', index);
  const source = optionalString(raw.source, 'content.source', index);
  return {
    ...(confidence !== undefined ? { confidence } : {}),
    ...(source !== undefined ? { source } : {}),
  };
}

function normalizeWriteContent(kind, raw, index) {
  if (!isObject(raw)) throw validationError(index, 'content', 'content 必须是非空对象');
  if (byteSize(raw) > MAX_CONTENT_BYTES) {
    throw new CapabilityError(413, 'payload_too_large', `content 超过 ${MAX_CONTENT_BYTES} 字节`, { index });
  }
  switch (kind) {
    case 'fact':
      return {
        nodeType: 'fact',
        content: {
          subject: nonEmptyString(raw.subject, 'content.subject', index),
          predicate: nonEmptyString(raw.predicate, 'content.predicate', index),
          object: nonEmptyString(raw.object, 'content.object', index),
          ...factExtras(raw, index),
        },
        tags: [],
      };
    case 'preference':
      return {
        nodeType: 'fact',
        content: {
          subject: nonEmptyString(raw.entity, 'content.entity', index),
          predicate: nonEmptyString(raw.preferenceType, 'content.preferenceType', index),
          object: nonEmptyString(raw.value, 'content.value', index),
          ...factExtras(raw, index),
        },
        tags: ['preference'],
      };
    case 'observation':
      // 与公共 memory_write 一致：observation 是 episode（episodeType=observation），不是 fact。
      return {
        nodeType: 'episode',
        content: {
          episodeType: 'observation',
          content: nonEmptyString(raw.content, 'content.content', index),
        },
        tags: [],
      };
    case 'episode': {
      const episodeType = nonEmptyString(raw.episodeType, 'content.episodeType', index);
      if (!EPISODE_KINDS.has(episodeType)) {
        throw validationError(index, 'content.episodeType', 'episodeType 非法');
      }
      const content = {
        episodeType,
        content: nonEmptyString(raw.content, 'content.content', index),
      };
      const title = optionalString(raw.title, 'content.title', index, 512);
      if (title !== undefined) content.title = title;
      const startTime = optionalNumber(raw.startTime, 'content.startTime', index);
      const endTime = optionalNumber(raw.endTime, 'content.endTime', index);
      if (startTime !== undefined) content.startTime = startTime;
      if (endTime !== undefined) content.endTime = endTime;
      const context = optionalString(raw.context, 'content.context', index, 512);
      if (context !== undefined) content.context = context;
      return { nodeType: 'episode', content, tags: [] };
    }
    case 'skill': {
      const content = {
        name: nonEmptyString(raw.name, 'content.name', index),
        description: nonEmptyString(raw.description, 'content.description', index),
        category: nonEmptyString(raw.category, 'content.category', index),
      };
      for (const field of ['steps', 'commands', 'toolReferences', 'prerequisites', 'relatedEntities']) {
        const value = stringArray(raw[field], `content.${field}`, index, { maxItems: 64, maxChars: 1024 });
        if (value !== undefined) content[field] = value;
      }
      return { nodeType: 'skill', content, tags: [] };
    }
    case 'entity': {
      const entityType = nonEmptyString(raw.entityType, 'content.entityType', index);
      if (!ENTITY_KINDS.has(entityType)) throw validationError(index, 'content.entityType', 'entityType 非法');
      const content = {
        entityType,
        name: nonEmptyString(raw.name, 'content.name', index),
      };
      const description = optionalString(raw.description, 'content.description', index, 4096);
      if (description !== undefined) content.description = description;
      if (raw.properties !== undefined && raw.properties !== null) {
        if (!isObject(raw.properties)) throw validationError(index, 'content.properties', 'properties 必须是对象');
        if (byteSize(raw.properties) > MAX_JSON_FIELD_BYTES) {
          throw validationError(index, 'content.properties', `properties 超过 ${MAX_JSON_FIELD_BYTES} 字节`);
        }
        content.properties = jsonClone(raw.properties);
      }
      return { nodeType: 'entity', content, tags: [] };
    }
    default:
      throw validationError(index, 'kind', 'kind 非法');
  }
}

/** 更新时对合并后的节点内容重新按 kind 校验（只保留已知字段）。 */
function normalizeNodeContent(kind, nodeType, raw, index) {
  if (!isObject(raw)) throw validationError(index, 'patch.content', 'content 必须是对象');
  if (byteSize(raw) > MAX_CONTENT_BYTES) {
    throw new CapabilityError(413, 'payload_too_large', `content 超过 ${MAX_CONTENT_BYTES} 字节`, { index });
  }
  if (kind === 'observation' && nodeType === 'episode') {
    const episodeType = nonEmptyString(raw.episodeType ?? 'observation', 'content.episodeType', index);
    if (!EPISODE_KINDS.has(episodeType)) throw validationError(index, 'content.episodeType', 'episodeType 非法');
    return {
      episodeType,
      content: nonEmptyString(raw.content, 'content.content', index),
      ...(optionalString(raw.title, 'content.title', index, 512) !== undefined
        ? { title: optionalString(raw.title, 'content.title', index, 512) }
        : {}),
      ...(optionalNumber(raw.startTime, 'content.startTime', index) !== undefined
        ? { startTime: optionalNumber(raw.startTime, 'content.startTime', index) }
        : {}),
      ...(optionalNumber(raw.endTime, 'content.endTime', index) !== undefined
        ? { endTime: optionalNumber(raw.endTime, 'content.endTime', index) }
        : {}),
      ...(optionalString(raw.context, 'content.context', index, 512) !== undefined
        ? { context: optionalString(raw.context, 'content.context', index, 512) }
        : {}),
    };
  }
  if (kind === 'observation') {
    return { content: nonEmptyString(raw.content, 'content.content', index) };
  }
  if (kind === 'fact' || kind === 'preference') {
    return {
      subject: nonEmptyString(raw.subject, 'content.subject', index),
      predicate: nonEmptyString(raw.predicate, 'content.predicate', index),
      object: nonEmptyString(raw.object, 'content.object', index),
      ...factExtras(raw, index),
    };
  }
  if (kind === 'episode') {
    const episodeType = nonEmptyString(raw.episodeType, 'content.episodeType', index);
    if (!EPISODE_KINDS.has(episodeType)) throw validationError(index, 'content.episodeType', 'episodeType 非法');
    return {
      episodeType,
      content: nonEmptyString(raw.content, 'content.content', index),
      ...(optionalString(raw.title, 'content.title', index, 512) !== undefined
        ? { title: optionalString(raw.title, 'content.title', index, 512) }
        : {}),
      ...(optionalNumber(raw.startTime, 'content.startTime', index) !== undefined
        ? { startTime: optionalNumber(raw.startTime, 'content.startTime', index) }
        : {}),
      ...(optionalNumber(raw.endTime, 'content.endTime', index) !== undefined
        ? { endTime: optionalNumber(raw.endTime, 'content.endTime', index) }
        : {}),
      ...(optionalString(raw.context, 'content.context', index, 512) !== undefined
        ? { context: optionalString(raw.context, 'content.context', index, 512) }
        : {}),
    };
  }
  if (kind === 'skill') {
    const content = {
      name: nonEmptyString(raw.name, 'content.name', index),
      description: nonEmptyString(raw.description, 'content.description', index),
      category: nonEmptyString(raw.category, 'content.category', index),
    };
    for (const field of ['steps', 'commands', 'toolReferences', 'prerequisites', 'relatedEntities']) {
      const value = stringArray(raw[field], `content.${field}`, index, { maxItems: 64, maxChars: 1024 });
      if (value !== undefined) content[field] = value;
    }
    return content;
  }
  if (kind === 'entity') {
    const entityType = nonEmptyString(raw.entityType, 'content.entityType', index);
    if (!ENTITY_KINDS.has(entityType)) throw validationError(index, 'content.entityType', 'entityType 非法');
    const content = {
      entityType,
      name: nonEmptyString(raw.name, 'content.name', index),
    };
    const description = optionalString(raw.description, 'content.description', index, 4096);
    if (description !== undefined) content.description = description;
    if (raw.properties !== undefined && raw.properties !== null) {
      if (!isObject(raw.properties)) throw validationError(index, 'content.properties', 'properties 必须是对象');
      if (byteSize(raw.properties) > MAX_JSON_FIELD_BYTES) {
        throw validationError(index, 'content.properties', `properties 超过 ${MAX_JSON_FIELD_BYTES} 字节`);
      }
      content.properties = jsonClone(raw.properties);
    }
    return content;
  }
  throw validationError(index, 'kind', '节点类型不支持更新');
}

function ownerMismatchError(index, domain, expected, actual) {
  return new CapabilityError(400, 'owner_mismatch', '客户端 owner 与服务端推导不一致', {
    index,
    domain,
    expected,
    actual,
  });
}

function contentHashFor(kind, content, validFrom) {
  // observation 的节点正文已从 fact {content} 迁到 episode {episodeType, content}；
  // hash 仍只取语义正文，保证升级前后同一 observation 仍按内容去重。
  const hashContent = kind === 'observation' && isObject(content)
    ? { content: content.content }
    : content;
  return `sha256:${sha256Hex(canonicalJson({
    kind,
    content: hashContent,
    ...(validFrom !== undefined ? { validFrom } : {}),
  }))}`;
}

function dedupeKey(prefix, domain, value) {
  return `${prefix}\u0000${domain}\u0000${value}`;
}

async function buildDedupeIndex(app) {
  const index = { client: new Map(), hash: new Map() };
  for (const node of await listAllNodes(app)) {
    // 墓碑不参与去重；归档仍视为已存在（避免重复创建后又出现两条）。
    if (!node || node.deletedAt || isInternalNode(node)) continue;
    const metadata = isObject(node.metadata) ? node.metadata : {};
    const domain = domainOfNamespace(node.namespace);
    if (typeof metadata.clientItemId === 'string') {
      index.client.set(dedupeKey('client', domain, metadata.clientItemId), node);
    }
    if (typeof metadata.contentHash === 'string') {
      index.hash.set(dedupeKey('hash', domain, metadata.contentHash), node);
    }
  }
  return index;
}

function recordWriteResult(status, node, item, owner) {
  return {
    ...(item.clientItemId !== undefined ? { clientItemId: item.clientItemId } : {}),
    status,
    id: node.id,
    type: node.type,
    kind: item.kind,
    domain: item.domain,
    ownerType: owner.ownerType,
    ownerId: owner.ownerId,
    ...(status === 'duplicate' ? { duplicate: true } : {}),
  };
}

async function listNodesOfType(app, type) {
  try {
    if (app?.graph && typeof app.graph.listNodes === 'function') {
      return await app.graph.listNodes({ type });
    }
  } catch {
    // fall through
  }
  return (await listAllNodes(app)).filter((node) => node?.type === type);
}

function internalObjectMetadata(node) {
  return isObject(node?.metadata?.internalObject) ? node.metadata.internalObject : {};
}

function internalObjectRevision(node) {
  const value = internalObjectMetadata(node).revision ?? (isObject(node?.content) ? node.content.revision : undefined);
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function compareInternalObjectNodes(a, b) {
  if (internalObjectRevision(a) !== internalObjectRevision(b)) {
    return internalObjectRevision(b) - internalObjectRevision(a);
  }
  if ((b.updatedAt ?? 0) !== (a.updatedAt ?? 0)) return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
  return String(b.id).localeCompare(String(a.id));
}

function isV2CheckpointNode(node) {
  const domain = domainOfNamespace(node?.namespace);
  return node?.type === 'context_checkpoint'
    && isInternalNode(node)
    && (domain === 'default' || (domain.startsWith('task:') && !domain.startsWith('__')));
}

function checkpointAgentId(node) {
  const content = isObject(node?.content) ? node.content : {};
  const internalObject = internalObjectMetadata(node);
  if (typeof content.agentId === 'string') return content.agentId;
  if (typeof internalObject.agentId === 'string') return internalObject.agentId;
  return null;
}

function checkpointThreadId(node) {
  const content = isObject(node?.content) ? node.content : {};
  const internalObject = internalObjectMetadata(node);
  if (typeof content.threadId === 'string') return content.threadId;
  if (typeof internalObject.threadId === 'string') return internalObject.threadId;
  const domain = domainOfNamespace(node?.namespace);
  return domain.startsWith('task:') ? domain.slice('task:'.length) : null;
}

function checkpointMatches(node, agentId, threadId) {
  return isV2CheckpointNode(node)
    && checkpointAgentId(node) === agentId
    && checkpointThreadId(node) === threadId;
}

async function currentSelfRecord(app, agentId) {
  const nodes = await listNodesOfType(app, 'self_record');
  return nodes
    .filter((node) => !node.deletedAt
      && isInternalNode(node)
      && internalObjectKind(node) === 'self_record'
      && domainOfNamespace(node.namespace) === `agent:${agentId}`)
    .sort(compareInternalObjectNodes)[0] ?? null;
}

async function currentCheckpoint(app, agentId, threadId) {
  const nodes = await listNodesOfType(app, 'context_checkpoint');
  return nodes
    .filter((node) => !node.deletedAt && checkpointMatches(node, agentId, threadId))
    .sort(compareInternalObjectNodes)[0] ?? null;
}

async function allCheckpoints(app, agentId, threadId = null) {
  const nodes = await listNodesOfType(app, 'context_checkpoint');
  return nodes.filter((node) => {
    if (node.deletedAt || !isV2CheckpointNode(node)) return false;
    if (checkpointAgentId(node) !== agentId) return false;
    if (threadId !== null && checkpointThreadId(node) !== threadId) return false;
    return checkpointThreadId(node) !== null;
  });
}

function checkpointExpired(node, now = Date.now()) {
  const content = isObject(node?.content) ? node.content : {};
  return typeof content.expiresAt === 'number' && content.expiresAt > 0 && content.expiresAt < now;
}

async function isCompactStale(app, node) {
  const content = isObject(node?.content) ? node.content : {};
  const sourceIds = Array.isArray(content.sourceIds) ? content.sourceIds : [];
  const sourceHashes = Array.isArray(content.sourceHashes) ? content.sourceHashes : [];
  for (let index = 0; index < sourceIds.length; index += 1) {
    const source = await app?.graph?.getNode?.(sourceIds[index]);
    if (!source || source.deletedAt) return true;
    const expected = sourceHashes[index];
    if (typeof expected === 'string' && expected.length > 0) {
      const actual = `sha256:${sha256Hex(canonicalJson(source.content ?? null))}`;
      if (actual !== expected) return true;
    } else if ((source.updatedAt ?? 0) > (node.createdAt ?? 0)) {
      return true;
    }
  }
  return false;
}

export function requestIdOf(req) {
  const incoming = req?.headers?.['x-request-id'];
  return typeof incoming === 'string' && REQUEST_ID_RE.test(incoming) ? incoming : `req_${randomUUID()}`;
}

export function hostIdForHome(home) {
  return `h_${createHash('sha256').update(String(home ?? '')).digest('hex').slice(0, 16)}`;
}

function parseActor(value) {
  if (!isObject(value)) {
    throw new CapabilityError(400, 'invalid_request', '缺少 actor');
  }
  if (value.type === 'agent') {
    const agentId = typeof value.agentId === 'string' ? value.agentId.trim() : '';
    if (agentId === '') throw new CapabilityError(400, 'invalid_request', 'actor.type=agent 需要 agentId');
    if (!isValidAgentId(agentId)) throw new CapabilityError(400, 'invalid_agent_id', 'agentId 格式非法');
    return {
      type: 'agent',
      agentId,
      ...(typeof value.displayName === 'string' && value.displayName.length > 0
        ? { displayName: value.displayName.slice(0, 128) }
        : {}),
    };
  }
  if (value.type === 'user') {
    return {
      type: 'user',
      ...(typeof value.userId === 'string' && /^u_[A-Za-z0-9._:-]{1,128}$/.test(value.userId)
        ? { userId: value.userId }
        : {}),
      ...(typeof value.displayName === 'string' && value.displayName.length > 0
        ? { displayName: value.displayName.slice(0, 128) }
        : {}),
    };
  }
  if (value.type === 'system') return { type: 'system' };
  throw new CapabilityError(400, 'invalid_request', 'actor.type 必须是 agent | user | system');
}

function actorFromQuery(url) {
  const raw = url?.searchParams?.get('actor');
  if (typeof raw === 'string' && raw.length > 0) {
    if (raw === 'user' || raw === 'system') return { type: raw };
    if (raw.startsWith('agent:')) return { type: 'agent', agentId: raw.slice('agent:'.length) };
    try {
      return JSON.parse(raw);
    } catch {
      throw new CapabilityError(400, 'invalid_request', 'actor 必须是 JSON 对象或 agentId');
    }
  }
  const agentId = url?.searchParams?.get('agentId');
  if (typeof agentId === 'string' && agentId.length > 0) return { type: 'agent', agentId };
  throw new CapabilityError(400, 'invalid_request', '缺少 actor');
}

function parseThreadId(value) {
  if (!hasValue(value)) return null;
  if (typeof value !== 'string' || !THREAD_ID_RE.test(value)) {
    throw new CapabilityError(400, 'invalid_thread_id', 'threadId 格式非法');
  }
  return value;
}

function parseTypes(value) {
  if (!hasValue(value)) return [...DEFAULT_TYPES];
  if (!Array.isArray(value) || value.length === 0) {
    throw new CapabilityError(400, 'invalid_request', 'types 必须是非空数组');
  }
  const out = [];
  for (const type of value) {
    if (typeof type !== 'string' || !ALLOWED_TYPES.has(type)) {
      throw new CapabilityError(400, 'invalid_request', 'types 含未知类型');
    }
    if (!out.includes(type)) out.push(type);
  }
  return out;
}

function parseFilters(value) {
  if (!hasValue(value)) return undefined;
  if (!isObject(value)) throw new CapabilityError(400, 'invalid_request', 'filters 必须是对象');
  const out = {};
  if (Array.isArray(value.tags)) {
    if (value.tags.length > MAX_TAGS) {
      throw new CapabilityError(400, 'invalid_request', `tags 最多 ${MAX_TAGS} 个`);
    }
    if (value.tags.some((tag) => typeof tag !== 'string' || tag.length === 0 || tag.length > MAX_TAG_CHARS)) {
      throw new CapabilityError(400, 'invalid_request', `每个 tag 需为 1–${MAX_TAG_CHARS} 字符`);
    }
    if (value.tags.length > 0) out.tags = [...value.tags];
  }
  if (typeof value.createdAfter === 'number' && Number.isFinite(value.createdAfter)) out.createdAfter = value.createdAfter;
  if (typeof value.createdBefore === 'number' && Number.isFinite(value.createdBefore)) out.createdBefore = value.createdBefore;
  if (typeof value.entity === 'string' && value.entity.length > 0) out.entity = value.entity;
  if (typeof value.minConfidence === 'number' && Number.isFinite(value.minConfidence)) {
    out.minConfidence = Math.min(Math.max(value.minConfidence, 0), 1);
  }
  // 显式 domains 是唯一域入口；忽略 filters.namespace，避免绕过域过滤。
  return Object.keys(out).length > 0 ? out : undefined;
}

function clampLimit(value, fallback = DEFAULT_LIMIT) {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(Math.max(n, 1), MAX_LIMIT);
}

function clampOffset(value) {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 0;
  return Math.max(n, 0);
}

function clampDepth(value) {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 2;
  return Math.min(Math.max(n, 0), MAX_DEPTH);
}

function subscriptionView(config) {
  const raw = Array.isArray(config?.sync?.namespaces)
    ? config.sync.namespaces.filter((ns) => typeof ns === 'string' && ns.length > 0 && ns !== '__policy__')
    : [];
  const namespaces = [...new Set(raw)];
  return { mode: namespaces.length === 0 ? 'all' : 'list', namespaces };
}

function defaultDomainsFor(endpoint, actor, threadId) {
  const domains = ['user'];
  if (actor.type === 'agent') domains.push(`agent:${actor.agentId}`);
  domains.push('default');
  if (endpoint === 'skills') {
    domains.push('shared');
  } else if (threadId) {
    domains.push(`task:${threadId}`);
  }
  return domains;
}

async function listAllNodes(app) {
  try {
    const storage = app?.storage;
    if (storage && typeof storage.listNodes === 'function') {
      return await storage.listNodes();
    }
  } catch {
    // fall through
  }
  try {
    if (app?.graph && typeof app.graph.listNodes === 'function') {
      return await app.graph.listNodes({});
    }
  } catch {
    // fall through
  }
  return [];
}

async function knownDomainsFor(app, _config, actor, threadId, currentService = null) {
  const known = new Set(['user', 'default', 'shared', 'system']);
  if (actor?.type === 'agent') known.add(`agent:${actor.agentId}`);
  if (threadId) known.add(`task:${threadId}`);
  try {
    if (app && typeof app.getNamespaceDirectory === 'function') {
      for (const ns of await app.getNamespaceDirectory()) {
        const domain = normalizeDomain(ns);
        if (domain) known.add(domain);
      }
      return known;
    }
  } catch {
    // fall through to unified stats
  }
  try {
    if (currentService && typeof currentService.stats === 'function') {
      const stats = await currentService.stats();
      for (const entry of Array.isArray(stats?.domains) ? stats.domains : []) {
        const domain = normalizeDomain(entry?.domain);
        if (domain) known.add(domain);
      }
    }
  } catch {
    // 统计不可用时只保留内建域；不另造第二套扫描。
  }
  return known;
}

function isBuiltinDomain(domain, actor, threadId) {
  if (RESERVED_DOMAINS.has(domain)) return true;
  if (actor?.type === 'agent' && domain === `agent:${actor.agentId}`) return true;
  if (threadId && domain === `task:${threadId}`) return true;
  return false;
}

async function resolveDomains({
  requested,
  endpoint,
  actor,
  threadId,
  strictDomains,
  app,
  config,
  service,
}) {
  if (hasValue(requested) && !Array.isArray(requested)) {
    throw new CapabilityError(400, 'invalid_request', 'domains 必须是字符串数组');
  }
  const explicit = Array.isArray(requested) && requested.length > 0;
  if (explicit && requested.length > MAX_DOMAINS) {
    throw new CapabilityError(400, 'invalid_request', `domains 最多 ${MAX_DOMAINS} 个`);
  }

  const candidates = explicit
    ? requested.map((value) => {
      if (typeof value !== 'string') throw new CapabilityError(400, 'domain_invalid', 'domains 含非字符串');
      const domain = normalizeDomain(value);
      if (!domain) throw new CapabilityError(400, 'domain_invalid', 'domains 含非法域', { domain: value });
      return domain;
    })
    : defaultDomainsFor(endpoint, actor, threadId);

  const known = explicit
    ? await knownDomainsFor(app, config, actor, threadId, service)
    : null;
  const allowed = [];
  const warnings = [];
  for (const domain of candidates) {
    if (allowed.includes(domain)) continue;
    const available = known === null || known.has(domain) || isBuiltinDomain(domain, actor, threadId);
    if (!available) {
      if (strictDomains) {
        throw new CapabilityError(403, 'domain_read_forbidden', '域在本机不可用', { domain });
      }
      warnings.push({ code: 'domain_unavailable', domain, message: `域 ${domain} 本机不可用，已跳过` });
      continue;
    }
    allowed.push(domain);
  }
  return { domains: allowed, warnings, explicit };
}

function buildProvenance(metadata, domain, owner, node) {
  const stored = isObject(metadata?.provenance) ? metadata.provenance : {};
  const agentIdFromDomain = domain.startsWith('agent:') ? domain.slice('agent:'.length) : null;
  const threadIdFromDomain = domain.startsWith('task:') ? domain.slice('task:'.length) : null;
  const writerType = typeof stored.writerType === 'string'
    ? stored.writerType
    : owner.ownerType === 'agent'
      ? 'agent'
      : owner.ownerType === 'user'
        ? 'user'
        : 'system';
  return {
    source: typeof stored.source === 'string' ? stored.source : 'legacy',
    writerType,
    writerId: typeof stored.writerId === 'string' ? stored.writerId : owner.ownerId,
    extractor: typeof stored.extractor === 'string' ? stored.extractor : null,
    model: typeof stored.model === 'string' ? stored.model : null,
    version: typeof stored.version === 'string' ? stored.version : null,
    deviceId: typeof stored.deviceId === 'string'
      ? stored.deviceId
      : typeof metadata?.deviceId === 'string'
        ? metadata.deviceId
        : node?.createdBy ?? null,
    hostId: typeof stored.hostId === 'string'
      ? stored.hostId
      : typeof metadata?.hostId === 'string'
        ? metadata.hostId
        : null,
    threadId: threadIdFromDomain ?? (typeof stored.threadId === 'string' ? stored.threadId : null),
    agentId: agentIdFromDomain ?? (typeof stored.agentId === 'string' ? stored.agentId : null),
    agentName: typeof stored.agentName === 'string'
      ? stored.agentName
      : typeof metadata?.agentName === 'string'
        ? metadata.agentName
        : null,
    messageIds: Array.isArray(stored.messageIds)
      ? stored.messageIds.filter((id) => typeof id === 'string').slice(0, 64)
      : [],
    rawChunkIds: Array.isArray(stored.rawChunkIds)
      ? stored.rawChunkIds.filter((id) => typeof id === 'string').slice(0, 64)
      : [],
    confirmation: typeof stored.confirmation === 'string' ? stored.confirmation : null,
    at: typeof stored.at === 'number' ? stored.at : node?.createdAt ?? null,
  };
}

function normalizeValidTo(value) {
  return typeof value === 'number' && value !== 9999999999999 ? value : null;
}

function kindOf(node, memory) {
  if (node) return semanticKindOf(node);
  return semanticKindOf({
    type: memory?.type ?? 'unknown',
    content: {},
    tags: Array.isArray(memory?.metadata?.tags) ? memory.metadata.tags : [],
    metadata: {},
  });
}

function renderNodeText(node) {
  const content = node?.content;
  if (typeof content === 'string') return content;
  if (!isObject(content)) return '';
  if (node?.type === 'fact') {
    const { subject, predicate, object } = content;
    if (typeof subject === 'string' && typeof predicate === 'string' && typeof object === 'string') {
      return `${subject} ${predicate} ${object}`;
    }
  }
  if (typeof content.content === 'string') return content.content;
  if (typeof content.name === 'string') return content.name;
  if (typeof content.title === 'string') return content.title;
  if (typeof content.summary === 'string') return content.summary;
  try {
    return JSON.stringify(content);
  } catch {
    return '';
  }
}

function recordView(memory, node, { userId = 'user', withScore = false } = {}) {
  const domain = domainOfNamespace(node?.namespace ?? memory?.metadata?.namespace);
  const owner = deriveOwner(domain, { userId });
  const metadata = isObject(node?.metadata) ? node.metadata : {};
  const text = typeof memory?.content === 'string' ? memory.content : renderNodeText(node);
  const content = isObject(node?.content) ? node.content : { content: text };
  const tags = Array.isArray(node?.tags)
    ? node.tags
    : Array.isArray(memory?.metadata?.tags)
      ? memory.metadata.tags
      : [];
  const view = {
    id: memory?.id ?? node?.id,
    type: node?.type ?? memory?.type ?? 'unknown',
    kind: kindOf(node, memory),
    domain,
    namespace: domain,
    ownerType: owner.ownerType,
    ownerId: owner.ownerId,
    provenance: buildProvenance(metadata, domain, owner, node),
    content,
    text,
    tags,
    validFrom: node?.validFrom ?? memory?.metadata?.validFrom ?? null,
    validTo: normalizeValidTo(node?.validTo ?? memory?.metadata?.validTo),
    createdAt: node?.createdAt ?? memory?.metadata?.createdAt ?? null,
    updatedAt: node?.updatedAt ?? node?.createdAt ?? memory?.metadata?.createdAt ?? null,
    detailAvailable: metadata.detailAvailable !== false,
    legacy: !isObject(metadata.provenance),
  };
  if (withScore && typeof memory?.relevance === 'number') {
    view.score = memory.relevance;
    view.why = 'vector+keyword';
  } else if (withScore) {
    view.why = 'keyword';
  }
  return view;
}

function nodeView(node, { userId = 'user' } = {}) {
  return recordView(null, node, { userId });
}

async function loadNode(app, id, cache) {
  if (!cache) return null;
  if (cache.has(id)) return cache.get(id);
  let node = null;
  try {
    if (app?.graph && typeof app.graph.getNode === 'function') {
      node = await app.graph.getNode(id);
    }
  } catch {
    node = null;
  }
  cache.set(id, node);
  return node;
}

function internalObjectKind(node) {
  const metadata = isObject(node?.metadata) ? node.metadata : {};
  const internalObject = isObject(metadata.internalObject) ? metadata.internalObject : {};
  if (typeof internalObject.kind === 'string') return internalObject.kind;
  return node?.type ?? null;
}

// ---------- 内部对象视图（compact / self_record / context_checkpoint） ----------

function internalProvenance(node, domain, userId) {
  const metadata = isObject(node?.metadata) ? node.metadata : {};
  const owner = deriveOwner(domain, { userId });
  return buildProvenance(metadata, domain, owner, node);
}

function compactObjectView(node, { userId = 'user', stale = false } = {}) {
  const domain = domainOfNamespace(node?.namespace);
  const content = isObject(node?.content) ? node.content : {};
  const owner = deriveOwner(domain, { userId });
  return {
    id: node.id,
    type: 'compact',
    kind: 'compact',
    domain,
    namespace: domain,
    ownerType: owner.ownerType,
    ownerId: owner.ownerId,
    internal: true,
    provenance: internalProvenance(node, domain, userId),
    summary: typeof content.summary === 'string' ? content.summary : '',
    sourceIds: Array.isArray(content.sourceIds) ? content.sourceIds : [],
    sourceHashes: Array.isArray(content.sourceHashes) ? content.sourceHashes : [],
    strategy: typeof content.strategy === 'string' ? content.strategy : 'summary',
    tokenCount: typeof content.tokenCount === 'number' ? content.tokenCount : null,
    ...(isObject(content.model) ? { model: content.model } : {}),
    stale,
    createdAt: node.createdAt ?? null,
    updatedAt: node.updatedAt ?? node.createdAt ?? null,
  };
}

function selfRecordView(node, { userId = 'user' } = {}) {
  const domain = domainOfNamespace(node?.namespace);
  const content = isObject(node?.content) ? node.content : {};
  const owner = deriveOwner(domain, { userId });
  const record = isObject(content.record)
    ? content.record
    : Object.fromEntries(Object.entries(content).filter(([key]) => key !== 'agentId' && key !== 'revision'));
  const internalObject = internalObjectMetadata(node);
  return {
    id: node.id,
    type: 'self_record',
    kind: 'self_record',
    domain,
    namespace: domain,
    ownerType: owner.ownerType,
    ownerId: owner.ownerId,
    internal: true,
    agentId: typeof content.agentId === 'string'
      ? content.agentId
      : typeof internalObject.agentId === 'string'
        ? internalObject.agentId
        : domain.startsWith('agent:') ? domain.slice('agent:'.length) : null,
    revision: internalObjectRevision(node),
    content: record,
    provenance: internalProvenance(node, domain, userId),
    createdAt: node.createdAt ?? null,
    updatedAt: node.updatedAt ?? node.createdAt ?? null,
  };
}

function checkpointObjectView(node, { userId = 'user' } = {}) {
  const domain = domainOfNamespace(node?.namespace);
  const content = isObject(node?.content) ? node.content : {};
  const owner = deriveOwner(domain, { userId });
  const internalObject = internalObjectMetadata(node);
  const threadId = typeof content.threadId === 'string'
    ? content.threadId
    : typeof internalObject.threadId === 'string'
      ? internalObject.threadId
      : domain.startsWith('task:') ? domain.slice('task:'.length) : null;
  return {
    id: node.id,
    type: 'context_checkpoint',
    kind: 'context_checkpoint',
    domain,
    namespace: domain,
    ownerType: owner.ownerType,
    ownerId: owner.ownerId,
    internal: true,
    agentId: typeof content.agentId === 'string'
      ? content.agentId
      : typeof internalObject.agentId === 'string'
        ? internalObject.agentId
        : null,
    threadId,
    revision: internalObjectRevision(node),
    state: isObject(content.state) ? content.state : {},
    summary: typeof content.summary === 'string' ? content.summary : null,
    recordIds: Array.isArray(content.recordIds) ? content.recordIds : [],
    lease: isObject(content.lease) ? content.lease : null,
    expiresAt: typeof content.expiresAt === 'number' ? content.expiresAt : 0,
    provenance: internalProvenance(node, domain, userId),
    createdAt: node.createdAt ?? null,
    updatedAt: node.updatedAt ?? node.createdAt ?? null,
  };
}

function normalizeSelfRecord(value, index) {
  if (!isObject(value)) throw validationError(index, 'record', 'record 必须是对象');
  const record = {};
  const displayName = optionalString(value.displayName, 'record.displayName', index, 128);
  if (displayName !== undefined) record.displayName = displayName;
  for (const field of ['goals', 'traits', 'capabilities', 'boundaries']) {
    const list = stringArray(value[field], `record.${field}`, index, { maxItems: 64, maxChars: 1024 });
    if (list !== undefined) record[field] = list;
  }
  if (value.preferences !== undefined && value.preferences !== null) {
    if (!isObject(value.preferences)) throw validationError(index, 'record.preferences', 'preferences 必须是对象');
    if (byteSize(value.preferences) > MAX_JSON_FIELD_BYTES) {
      throw validationError(index, 'record.preferences', `preferences 超过 ${MAX_JSON_FIELD_BYTES} 字节`);
    }
    record.preferences = jsonClone(value.preferences);
  }
  if (byteSize(record) > MAX_CONTENT_BYTES) {
    throw new CapabilityError(413, 'payload_too_large', 'SelfRecord 超过大小限制', { index });
  }
  return record;
}

function normalizeCheckpointState(value, index) {
  if (value === undefined || value === null) return {};
  if (!isObject(value)) throw validationError(index, 'state', 'state 必须是对象');
  if (byteSize(value) > MAX_CHECKPOINT_STATE_BYTES) {
    throw new CapabilityError(413, 'payload_too_large', `state 超过 ${MAX_CHECKPOINT_STATE_BYTES} 字节`, { index });
  }
  return jsonClone(value);
}

function timeoutAfter(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new CapabilityError(503, 'sync_unavailable', message, { reason: 'timeout' }, true)), ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function versionPayload() {
  return {
    capabilityApiVersion: CAPABILITY_API_VERSION,
    schemaVersion: CAPABILITY_SCHEMA_VERSION,
    mcpVersion: APP_VERSION,
    coreVersion: APP_VERSION,
    features: {
      domains: true,
      owner: true,
      provenance: true,
      batchWrite: true,
      idempotency: true,
      internalObjects: [...INTERNAL_OBJECT_KINDS],
      sync: true,
      graph: true,
      readOnly: false,
      readEndpoints: [
        'version',
        'status',
        'namespaces',
        'query',
        'search',
        'history',
        'profile',
        'skills',
        'graph',
        'sync',
      ],
      writeEndpoints: ['write', 'update', 'delete', 'archive', 'internal-object', 'sync'],
    },
    limits: { ...CAPABILITY_LIMITS },
    domains: {
      reserved: ['user', 'default', 'shared', 'system'],
      agentPrefix: 'agent:',
      taskPrefix: 'task:',
      policyDomain: '__policy__',
    },
  };
}

/**
 * 创建 capability HTTP handler。
 *
 * @param {{
 *   home: string,
 *   getConfig?: () => object,
 *   getService?: () => object|null,
 *   getApp?: () => object|null,
 *   getIdentity?: () => {cloudId?: string|null, profileId?: string|null, userId?: string|null},
 *   env?: NodeJS.ProcessEnv,
 *   now?: () => number,
 *   ttlMs?: number,
 * }} options
 */
export function createMemoryCapabilityHandler({
  home,
  getConfig = () => ({}),
  getService = () => null,
  getApp = () => null,
  getIdentity = () => ({}),
  env = process.env,
  now = () => Date.now(),
  ttlMs,
} = {}) {
  let tokenRecord = null;
  let tokenPromise = null;
  let tokenError = null;
  let disposed = false;
  const hostId = hostIdForHome(home);

  async function ensureToken() {
    const current = tokenRecord;
    if (current && !(typeof current.expiresAt === 'number' && current.expiresAt > 0 && now() >= current.expiresAt)) {
      return current;
    }
    if (!tokenPromise) {
      tokenPromise = ensureCapabilityToken({
        home,
        env,
        now: now(),
        mcpPid: process.pid,
        ...(ttlMs !== undefined ? { ttlMs } : {}),
      })
        .then((record) => {
          tokenRecord = record;
          tokenError = null;
          return record;
        })
        .catch((error) => {
          tokenError = error;
          tokenRecord = null;
          throw error;
        })
        .finally(() => {
          tokenPromise = null;
        });
    }
    return tokenPromise;
  }

  /** daemon 启动时调用（仅 enabled）：提前生成 token 文件，sidecar 才能发现。 */
  async function prepare() {
    if (!isMemoryRuntimeEnabled(getConfig())) return { enabled: false, tokenId: null };
    try {
      const record = await ensureToken();
      return { enabled: true, tokenId: record.tokenId };
    } catch {
      return { enabled: true, tokenId: null };
    }
  }

  /** 停用/关闭：撤销进程内 token 并删除 token 文件（旧 sidecar 下一次请求 401）。 */
  async function revoke() {
    tokenRecord = null;
    tokenError = null;
    await removeCapabilityToken({ home });
  }

  async function dispose() {
    disposed = true;
    await revoke();
  }

  function identitySnapshot() {
    let identity = {};
    try {
      identity = getIdentity?.() ?? {};
    } catch {
      identity = {};
    }
    return {
      cloudId: identity?.cloudId ?? null,
      cloudTrustId: identity?.cloudTrustId ?? null,
      userId: identity?.userId ?? 'user',
      profileId: identity?.profileId ?? null,
      deviceId: identity?.deviceId ?? null,
      hostId,
    };
  }

  const handle = async function handleMemoryCapabilityRequest({ req, res, url, body }) {
    const path = url?.pathname ?? '';
    if (!isMemoryCapabilityPath(path)) return false;

    const requestId = requestIdOf(req);
    res.setHeader('x-request-id', requestId);
    res.setHeader('x-mebular-capability-version', String(CAPABILITY_API_VERSION));
    res.setHeader('x-mebular-degraded', 'false');

    const sendOk = (data, warnings = [], status = 200, degraded = false) => {
      res.setHeader('x-mebular-degraded', String(degraded));
      res.statusCode = status;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.end(JSON.stringify({
        ok: true,
        requestId,
        capabilityVersion: CAPABILITY_API_VERSION,
        data,
        warnings,
        degraded,
      }));
      return true;
    };

    const sendError = (status, code, message, details, retryable = false) => {
      res.statusCode = status;
      if (status === 503 && retryable) res.setHeader('retry-after', '1');
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.end(JSON.stringify({
        ok: false,
        requestId,
        capabilityVersion: CAPABILITY_API_VERSION,
        error: {
          code,
          message,
          retryable,
          ...(details !== undefined ? { details } : {}),
        },
      }));
      return true;
    };

    const service = () => {
      const value = getService?.() ?? null;
      if (!value) {
        throw new CapabilityError(503, 'capability_unavailable', '记忆服务尚未初始化', undefined, true);
      }
      return value;
    };

    const app = () => getApp?.() ?? null;

    /**
     * 状态/域统计唯一来源：MemoryService.stats()。
     * 兼容测试/旧运行时没有 stats 的情况时只回落到 status 计数，绝不扫描图另造统计。
     */
    async function statsFor(currentService) {
      if (currentService && typeof currentService.stats === 'function') {
        return await currentService.stats();
      }
      const status = currentService && typeof currentService.status === 'function'
        ? await currentService.status()
        : null;
      const nodes = typeof status?.nodeCount === 'number' ? status.nodeCount : 0;
      return {
        nodeCount: nodes,
        edgeCount: typeof status?.edgeCount === 'number' ? status.edgeCount : 0,
        counts: {
          nodes,
          memoryRecords: 0,
          compacts: 0,
          checkpoints: 0,
          selfRecords: 0,
        },
        domains: [],
      };
    }

    /**
     * 同步状态唯一来源：MemoryService.syncStatus()。
     * 兼容旧运行时只回落到 status 的同一组字段，不读 app.sync 另造一份。
     */
    async function syncStatusFor(currentService) {
      if (currentService && typeof currentService.syncStatus === 'function') {
        return await currentService.syncStatus();
      }
      const status = currentService && typeof currentService.status === 'function'
        ? await currentService.status()
        : null;
      return {
        running: status?.running === true,
        pendingEventCount: typeof status?.pendingEventCount === 'number' ? status.pendingEventCount : 0,
        lastSyncAt: typeof status?.lastSyncAt === 'number' ? status.lastSyncAt : null,
        isSyncing: status?.isSyncing === true,
      };
    }

    const requireObjectBody = () => {
      if (!body || body.length === 0) {
        throw new CapabilityError(400, 'invalid_request', '请求体必须是 JSON 对象');
      }
      let parsed;
      try {
        parsed = JSON.parse(body.toString('utf-8'));
      } catch {
        throw new CapabilityError(400, 'invalid_request', '请求体不是合法 JSON');
      }
      if (!isObject(parsed)) {
        throw new CapabilityError(400, 'invalid_request', '请求体必须是 JSON 对象');
      }
      return parsed;
    };

    // ---------- 写路径：幂等账本（24h，本地过渡数据，不进入图/同步） ----------

    const ledgerDir = typeof home === 'string' && home.length > 0 ? join(home, 'memory-runtime') : null;
    const ledgerFile = ledgerDir ? join(ledgerDir, IDEMPOTENCY_LEDGER_FILE) : null;
    let ledger = null;
    let ledgerLoading = null;

    async function ledgerState() {
      if (ledger) return ledger;
      if (!ledgerFile) {
        ledger = new Map();
        return ledger;
      }
      if (!ledgerLoading) {
        ledgerLoading = (async () => {
          const state = new Map();
          try {
            const raw = JSON.parse(await readFile(ledgerFile, 'utf-8'));
            if (raw?.version === IDEMPOTENCY_LEDGER_VERSION && Array.isArray(raw.entries)) {
              const cutoff = now() - IDEMPOTENCY_TTL_MS;
              for (const entry of raw.entries) {
                if (!isObject(entry) || typeof entry.key !== 'string' || !isObject(entry.data)) continue;
                if (typeof entry.at !== 'number' || entry.at < cutoff) continue;
                state.set(entry.key, entry);
              }
            }
          } catch {
            // 账本损坏/不存在：按空处理；clientItemId 与内容 hash 仍可防重。
          }
          ledger = state;
          return state;
        })().finally(() => {
          ledgerLoading = null;
        });
      }
      return ledgerLoading;
    }

    async function saveLedger(state) {
      if (!ledgerFile || !ledgerDir) return;
      const cutoff = now() - IDEMPOTENCY_TTL_MS;
      const entries = [...state.values()].filter((entry) => entry.at >= cutoff);
      while (entries.length > IDEMPOTENCY_MAX_ENTRIES) {
        const oldest = entries.shift();
        if (oldest) state.delete(oldest.key);
      }
      // 重新过滤：淘汰后 entries 与 state 保持一致。
      const payload = {
        version: IDEMPOTENCY_LEDGER_VERSION,
        entries: entries.filter((entry) => state.has(entry.key)),
      };
      await mkdir(ledgerDir, { recursive: true, mode: 0o700 });
      await chmod(ledgerDir, 0o700);
      const tmp = `${ledgerFile}.tmp-${process.pid}-${randomUUID()}`;
      try {
        await writeFile(tmp, JSON.stringify(payload), { encoding: 'utf-8', mode: 0o600 });
        await chmod(tmp, 0o600);
        await rename(tmp, ledgerFile);
        await chmod(ledgerFile, 0o600);
      } catch (error) {
        await rm(tmp, { force: true }).catch(() => undefined);
        throw error;
      }
    }

    function idempotencyKeyOf(req, payload) {
      const header = req?.headers?.['idempotency-key'];
      if (hasValue(header) && header !== '') {
        if (typeof header !== 'string' || !IDEMPOTENCY_KEY_RE.test(header)) {
          throw new CapabilityError(400, 'invalid_request', 'Idempotency-Key 格式非法', { field: 'Idempotency-Key' });
        }
        return header;
      }
      if (hasValue(payload?.requestId)) {
        if (typeof payload.requestId !== 'string' || !IDEMPOTENCY_KEY_RE.test(payload.requestId)) {
          throw new CapabilityError(400, 'invalid_request', 'requestId 格式非法', { field: 'requestId' });
        }
        return payload.requestId;
      }
      return null;
    }

    async function withIdempotency(route, payload, tokenId, execute) {
      const key = idempotencyKeyOf(req, payload);
      if (key === null) return execute();
      const state = await ledgerState();
      const composite = `${tokenId ?? 'none'}\u0000${route}\u0000${key}`;
      const requestHash = sha256Hex(canonicalJson(payload));
      const existing = state.get(composite);
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new CapabilityError(409, 'idempotency_conflict', '同一幂等键对应了不同请求体', {
            key,
            route,
          });
        }
        return {
          data: { ...jsonClone(existing.data), replayed: true },
          warnings: jsonClone(existing.warnings ?? []),
          degraded: existing.degraded === true,
        };
      }
      const result = await execute();
      const entry = {
        key: composite,
        requestHash,
        at: now(),
        data: jsonClone({ ...(result.data ?? {}), replayed: false }),
        warnings: jsonClone(result.warnings ?? []),
        degraded: result.degraded === true,
      };
      // LRU：同键刷新到队尾。
      state.delete(composite);
      state.set(composite, entry);
      const cutoff = now() - IDEMPOTENCY_TTL_MS;
      for (const [entryKey, value] of state) {
        if (typeof value.at !== 'number' || value.at < cutoff) state.delete(entryKey);
      }
      while (state.size > IDEMPOTENCY_MAX_ENTRIES) {
        const oldest = state.keys().next().value;
        if (oldest === undefined) break;
        state.delete(oldest);
      }
      try {
        await saveLedger(state);
      } catch {
        result.warnings = [
          ...(result.warnings ?? []),
          { code: 'idempotency_ledger_unavailable', message: '幂等账本写入失败；仍可依赖内容 hash 防重' },
        ];
      }
      return result;
    }

    // ---------- /write ----------

    function validateWriteItem(raw, index, requestThreadId, actor) {
      if (!isObject(raw)) throw validationError(index, 'item', 'item 必须是对象');
      if (!hasValue(raw.domain) || (typeof raw.domain === 'string' && raw.domain.trim() === '')) {
        throw validationError(index, 'domain', 'item.domain 必填');
      }
      const domain = normalizeDomain(raw.domain);
      if (!domain) {
        throw new CapabilityError(400, 'domain_invalid', 'item.domain 非法', {
          index,
          ...(typeof raw.domain === 'string' ? { domain: raw.domain } : {}),
        });
      }
      if (typeof raw.kind !== 'string' || !WRITE_KINDS.has(raw.kind)) {
        throw validationError(index, 'kind', 'kind 非法');
      }
      let clientItemId;
      if (hasValue(raw.clientItemId)) {
        if (typeof raw.clientItemId !== 'string' || !CLIENT_ITEM_ID_RE.test(raw.clientItemId)) {
          throw validationError(index, 'clientItemId', 'clientItemId 格式非法');
        }
        clientItemId = raw.clientItemId;
      }
      const normalized = normalizeWriteContent(raw.kind, raw.content, index);
      let tags = [...new Set([...normalized.tags, ...normalizeTags(raw.tags, index)])];
      // `preference` 是 preference 的保留语义标签；其他 kind 不得借它冒充偏好。
      if (raw.kind !== 'preference') tags = tags.filter((tag) => tag !== 'preference');
      const relatedTo = normalizeRelatedTo(raw.relatedTo, index);
      const validFrom = raw.validFrom === undefined || raw.validFrom === null
        ? now()
        : optionalNumber(raw.validFrom, 'validFrom', index);
      const validTo = raw.validTo === undefined || raw.validTo === null
        ? OPEN_VALID_TO
        : optionalNumber(raw.validTo, 'validTo', index);
      if (validTo < validFrom) throw validationError(index, 'validTo', 'validTo 必须不早于 validFrom');

      const provenanceInput = parseProvenanceInput(raw.provenance, index);
      assertDomainWrite(actor, domain, provenanceInput, requestThreadId);
      const identity = identitySnapshot();
      const provenance = buildWriteProvenance({
        input: provenanceInput,
        actor,
        identity,
        hostId,
        now: now(),
        threadId: provenanceInput.threadId ?? requestThreadId ?? null,
        confirmation: provenanceInput.confirmation ?? 'none',
      });
      if (byteSize(provenance) > MAX_PROVENANCE_BYTES) {
        throw new CapabilityError(413, 'payload_too_large', `provenance 超过 ${MAX_PROVENANCE_BYTES} 字节`, { index });
      }
      const owner = deriveOwner(domain, { userId: identity.userId });
      if (hasValue(raw.ownerType) && raw.ownerType !== owner.ownerType) {
        throw ownerMismatchError(index, domain, owner, {
          ownerType: raw.ownerType,
          ownerId: raw.ownerId ?? null,
        });
      }
      if (hasValue(raw.ownerId) && raw.ownerId !== owner.ownerId) {
        throw ownerMismatchError(index, domain, owner, {
          ownerType: raw.ownerType ?? owner.ownerType,
          ownerId: raw.ownerId,
        });
      }
      const explicitValidFrom = raw.validFrom !== undefined && raw.validFrom !== null;
      const contentHash = contentHashFor(
        raw.kind,
        normalized.content,
        explicitValidFrom ? validFrom : undefined,
      );
      return {
        index,
        domain,
        owner,
        kind: raw.kind,
        nodeType: normalized.nodeType,
        content: normalized.content,
        tags,
        relatedTo,
        validFrom,
        validTo,
        provenance,
        ...(clientItemId !== undefined ? { clientItemId } : {}),
        contentHash,
        contentHashIncludesValidFrom: explicitValidFrom,
      };
    }

    async function performWriteItem(appValue, item) {
      if (!appValue?.graph?.getNode) {
        throw new CapabilityError(503, 'capability_unavailable', '图存储不可用', undefined, true);
      }
      const currentService = service();
      if (typeof currentService.writeRecords !== 'function') {
        throw new CapabilityError(503, 'capability_unavailable', '记忆服务不支持统一写入', undefined, true);
      }
      const metadata = {
        kind: item.kind,
        provenance: item.provenance,
        contentHash: item.contentHash,
        ...(item.contentHashIncludesValidFrom ? { contentHashValidFrom: item.validFrom } : {}),
        ...(item.clientItemId !== undefined ? { clientItemId: item.clientItemId } : {}),
      };
      const [stored] = await currentService.writeRecords([{
        kind: item.kind,
        content: item.content,
        namespace: item.domain,
        tags: item.tags,
        validFrom: item.validFrom,
        validTo: item.validTo,
        relatedTo: item.relatedTo,
        metadata,
      }], { tolerateVectorIndexFailure: true });
      if (!stored?.node) {
        throw new CapabilityError(503, 'capability_unavailable', '节点写入后读取失败', undefined, true);
      }
      const warnings = [];
      if (!stored.vectorIndexed) {
        warnings.push({ code: 'vector_index_unavailable', message: '向量索引更新失败；图数据已写入' });
      }
      for (const targetId of stored.skippedRelatedTo ?? []) {
        warnings.push({
          code: 'related_to_skipped',
          id: targetId,
          message: 'relatedTo 目标不存在、已删除或为内部对象，已跳过',
        });
      }
      return { node: stored.node, warnings };
    }

    async function handleWrite(payload, actor) {
      const items = payload.items;
      if (!Array.isArray(items) || items.length === 0) {
        throw new CapabilityError(400, 'invalid_request', 'items 必须是非空数组');
      }
      if (items.length > MAX_BATCH_ITEMS) {
        throw new CapabilityError(413, 'payload_too_large', `items 最多 ${MAX_BATCH_ITEMS} 条`, {
          maxBatchItems: MAX_BATCH_ITEMS,
        });
      }
      if (payload.sync !== undefined || payload['self.sync'] !== undefined || payload['checkpoint.sync'] !== undefined) {
        throw new CapabilityError(400, 'legacy_sync_unsupported', '不再支持 sync/self.sync/checkpoint.sync 字段');
      }
      const requestThreadId = parseThreadId(payload.threadId);
      const appValue = app();
      if (!appValue) throw new CapabilityError(503, 'capability_unavailable', '图存储尚未初始化', undefined, true);
      // 校验原子：先全部校验，再逐项落库。
      const validated = [];
      for (let index = 0; index < items.length; index += 1) {
        validated.push(validateWriteItem(items[index], index, requestThreadId, actor));
      }
      const dedupe = await buildDedupeIndex(appValue);
      const results = [];
      const warnings = [];
      let created = 0;
      let duplicates = 0;
      let failed = 0;
      for (const item of validated) {
        const existing = (item.clientItemId !== undefined
          ? dedupe.client.get(dedupeKey('client', item.domain, item.clientItemId))
          : undefined)
          ?? dedupe.hash.get(dedupeKey('hash', item.domain, item.contentHash));
        if (existing) {
          duplicates += 1;
          results.push(recordWriteResult('duplicate', existing, item, item.owner));
          continue;
        }
        try {
          const written = await performWriteItem(appValue, item);
          warnings.push(...written.warnings);
          const node = written.node;
          created += 1;
          results.push(recordWriteResult('created', node, item, item.owner));
          if (item.clientItemId !== undefined) {
            dedupe.client.set(dedupeKey('client', item.domain, item.clientItemId), node);
          }
          dedupe.hash.set(dedupeKey('hash', item.domain, item.contentHash), node);
        } catch (error) {
          failed += 1;
          results.push({
            ...(item.clientItemId !== undefined ? { clientItemId: item.clientItemId } : {}),
            status: 'failed',
            kind: item.kind,
            domain: item.domain,
            code: error instanceof CapabilityError ? error.code : 'internal',
            retryable: error instanceof CapabilityError ? error.retryable : true,
          });
        }
      }
      return {
        data: {
          results,
          created,
          duplicates,
          failed,
          partial: failed > 0,
          replayed: false,
        },
        warnings,
        degraded: false,
      };
    }

    // ---------- /update ----------

    function validateUpdateItem(raw, index) {
      if (!isObject(raw)) throw validationError(index, 'item', 'item 必须是对象');
      if (typeof raw.id !== 'string' || raw.id.length === 0 || raw.id.length > 128) {
        throw validationError(index, 'id', 'id 必须是节点 id');
      }
      if (!isObject(raw.patch)) throw validationError(index, 'patch', 'patch 必须是对象');
      for (const key of Object.keys(raw.patch)) {
        if (!PATCH_KEYS.has(key)) {
          throw validationError(index, key, `${key} 不是允许更新的字段`, { field: key });
        }
      }
      return raw;
    }

    async function handleUpdate(payload, actor) {
      const items = payload.items;
      if (!Array.isArray(items) || items.length === 0) {
        throw new CapabilityError(400, 'invalid_request', 'items 必须是非空数组');
      }
      if (items.length > MAX_BATCH_ITEMS) {
        throw new CapabilityError(413, 'payload_too_large', `items 最多 ${MAX_BATCH_ITEMS} 条`, {
          maxBatchItems: MAX_BATCH_ITEMS,
        });
      }
      if (payload.sync !== undefined || payload['self.sync'] !== undefined || payload['checkpoint.sync'] !== undefined) {
        throw new CapabilityError(400, 'legacy_sync_unsupported', '不再支持 sync/self.sync/checkpoint.sync 字段');
      }
      const appValue = app();
      if (!appValue) throw new CapabilityError(503, 'capability_unavailable', '图存储尚未初始化', undefined, true);
      const identity = identitySnapshot();
      const plans = [];
      // 校验原子：保护字段、权限、版本、合并后的 content 全部通过后才写。
      for (let index = 0; index < items.length; index += 1) {
        const raw = validateUpdateItem(items[index], index);
        const node = await appValue.graph.getNode(raw.id);
        if (!node || node.deletedAt) {
          throw new CapabilityError(404, 'not_found', '节点不存在', { index, id: raw.id });
        }
        if (isInternalNode(node)) {
          throw new CapabilityError(404, 'internal_object', '内部对象必须通过 /internal-object 更新', { index, id: raw.id });
        }
        if (!canUpdateNode(actor, node)) {
          throw new CapabilityError(403, 'forbidden_scope', '当前 actor 不能更新该记录', {
            index,
            id: raw.id,
            domain: domainOfNamespace(node.namespace),
          });
        }
        if (hasValue(raw.expectedUpdatedAt)) {
          if (typeof raw.expectedUpdatedAt !== 'number' || !Number.isFinite(raw.expectedUpdatedAt)) {
            throw validationError(index, 'expectedUpdatedAt', 'expectedUpdatedAt 必须是数字');
          }
          if (node.updatedAt !== raw.expectedUpdatedAt) {
            throw new CapabilityError(409, 'update_conflict', '记录已被其他写入方更新', {
              index,
              id: raw.id,
              currentUpdatedAt: node.updatedAt,
            }, true);
          }
        }
        const patch = raw.patch;
        const kind = kindOf(node);
        let content;
        if (patch.content !== undefined) {
          if (!isObject(patch.content)) throw validationError(index, 'patch.content', 'patch.content 必须是对象');
          // preference 的写入形状是 entity/preferenceType/value；更新时兼容映射到 fact 三元组。
          const contentPatch = kind === 'preference' ? { ...patch.content } : patch.content;
          if (kind === 'preference') {
            if (contentPatch.subject === undefined && contentPatch.entity !== undefined) contentPatch.subject = contentPatch.entity;
            if (contentPatch.predicate === undefined && contentPatch.preferenceType !== undefined) {
              contentPatch.predicate = contentPatch.preferenceType;
            }
            if (contentPatch.object === undefined && contentPatch.value !== undefined) contentPatch.object = contentPatch.value;
          }
          const merged = { ...(isObject(node.content) ? node.content : {}) };
          for (const [key, value] of Object.entries(contentPatch)) {
            if (value === null) delete merged[key];
            else merged[key] = value;
          }
          content = normalizeNodeContent(kind, node.type, merged, index);
        }
        let tags;
        if (patch.tags !== undefined) {
          tags = normalizeTags(patch.tags, index);
          if (kind === 'preference' && !tags.includes('preference')) tags.push('preference');
          if (kind !== 'preference') tags = tags.filter((tag) => tag !== 'preference');
        }
        let contentHash;
        if (content !== undefined) {
          const metadataForHash = isObject(node.metadata) ? node.metadata : {};
          contentHash = contentHashFor(
            kind,
            content,
            typeof metadataForHash.contentHashValidFrom === 'number'
              ? metadataForHash.contentHashValidFrom
              : undefined,
          );
        }
        let metadata;
        if (patch.metadata !== undefined) {
          if (!isObject(patch.metadata)) throw validationError(index, 'patch.metadata', 'patch.metadata 必须是对象');
          for (const key of Object.keys(patch.metadata)) {
            if (PROTECTED_METADATA_KEYS.has(key)) {
              throw validationError(index, `patch.metadata.${key}`, 'metadata 含受保护字段', { field: key });
            }
          }
          metadata = { ...(isObject(node.metadata) ? node.metadata : {}), ...jsonClone(patch.metadata) };
        }
        // GraphStore.updateNode 保留 validFrom/validTo（不可变）；显式变更给结构化错误。
        if (patch.validFrom !== undefined && patch.validFrom !== node.validFrom) {
          throw validationError(index, 'patch.validFrom', 'validFrom 暂不支持更新', {
            code: 'temporal_update_unsupported',
          });
        }
        if (patch.validTo !== undefined && patch.validTo !== node.validTo) {
          throw validationError(index, 'patch.validTo', 'validTo 暂不支持更新', {
            code: 'temporal_update_unsupported',
          });
        }
        if (content === undefined && tags === undefined && metadata === undefined) {
          throw validationError(index, 'patch', 'patch 没有可更新字段');
        }
        plans.push({
          index,
          id: raw.id,
          node,
          content,
          tags,
          metadata,
          contentHash,
          actorId: actor.type === 'agent' ? actor.agentId : actor.type === 'user' ? identity.userId : 'system',
        });
      }

      const results = [];
      const warnings = [];
      let updated = 0;
      let failed = 0;
      for (const plan of plans) {
        try {
          const currentService = service();
          if (typeof currentService.updateRecord !== 'function') {
            throw new CapabilityError(503, 'capability_unavailable', '记忆服务不支持统一更新', undefined, true);
          }
          const metadata = {
            ...(plan.metadata ?? (isObject(plan.node.metadata) ? plan.node.metadata : {})),
            ...(plan.contentHash !== undefined ? { contentHash: plan.contentHash } : {}),
            updatedBy: { actorType: actor.type, actorId: plan.actorId, at: now() },
          };
          const updatedRecord = await currentService.updateRecord({
            id: plan.id,
            ...(plan.content !== undefined ? { content: plan.content } : {}),
            ...(plan.tags !== undefined ? { tags: plan.tags } : {}),
            metadata,
          }, { tolerateVectorIndexFailure: true });
          if (!updatedRecord?.node) {
            throw new CapabilityError(404, 'not_found', '节点不存在', { id: plan.id });
          }
          const node = updatedRecord.node;
          if (!updatedRecord.vectorIndexed) {
            warnings.push({ code: 'vector_index_unavailable', message: '向量索引更新失败；图数据已更新' });
          }
          updated += 1;
          const domain = domainOfNamespace(node.namespace);
          const owner = deriveOwner(domain, { userId: identity.userId });
          results.push({
            id: plan.id,
            status: 'updated',
            domain,
            ownerType: owner.ownerType,
            ownerId: owner.ownerId,
            updatedAt: node.updatedAt,
          });
        } catch (error) {
          failed += 1;
          results.push({
            id: plan.id,
            status: 'failed',
            code: error instanceof CapabilityError ? error.code : 'internal',
            retryable: error instanceof CapabilityError ? error.retryable : true,
          });
        }
      }
      return {
        data: { results, updated, failed, partial: failed > 0, replayed: false },
        warnings,
        degraded: false,
      };
    }

    // ---------- /delete /archive ----------

    function parseIdList(payload) {
      const ids = payload.ids;
      if (!Array.isArray(ids) || ids.length === 0) {
        throw new CapabilityError(400, 'invalid_request', 'ids 必须是非空数组');
      }
      if (ids.length > MAX_BATCH_ITEMS) {
        throw new CapabilityError(413, 'payload_too_large', `ids 最多 ${MAX_BATCH_ITEMS} 个`, {
          maxBatchItems: MAX_BATCH_ITEMS,
        });
      }
      for (const id of ids) {
        if (typeof id !== 'string' || id.length === 0 || id.length > 128) {
          throw new CapabilityError(422, 'validation_failed', 'ids 含非法节点 id', { field: 'ids' });
        }
      }
      return [...new Set(ids)];
    }

    async function classifyGovernanceTargets(ids, actor) {
      const appValue = app();
      if (!appValue) throw new CapabilityError(503, 'capability_unavailable', '图存储尚未初始化', undefined, true);
      const allowed = [];
      const notFound = [];
      const forbidden = [];
      const internal = [];
      const nodes = new Map();
      for (const id of ids) {
        const node = await appValue.graph.getNode(id);
        if (!node) {
          notFound.push(id);
          continue;
        }
        nodes.set(id, node);
        if (isInternalNode(node)) {
          internal.push(id);
          continue;
        }
        if (!canGovernNode(actor, node)) {
          forbidden.push(id);
          continue;
        }
        allowed.push(id);
      }
      return { appValue, nodes, allowed, notFound, forbidden, internal };
    }

    async function handleDelete(payload, actor) {
      if (payload.sync !== undefined) {
        throw new CapabilityError(400, 'legacy_sync_unsupported', '不再支持 sync 字段');
      }
      const ids = parseIdList(payload);
      const classified = await classifyGovernanceTargets(ids, actor);
      const deleted = [];
      if (classified.allowed.length > 0) {
        const result = await service().delete(classified.allowed);
        deleted.push(...(result?.deleted ?? []));
        classified.notFound.push(...(result?.notFound ?? []));
        classified.internal.push(...(result?.internal ?? []));
      }
      return {
        data: {
          deleted,
          notFound: classified.notFound,
          forbidden: classified.forbidden,
          internal: classified.internal,
          partial: classified.notFound.length > 0
            || classified.forbidden.length > 0
            || classified.internal.length > 0,
          replayed: false,
        },
        warnings: [],
        degraded: false,
      };
    }

    async function handleArchive(payload, actor) {
      if (payload.sync !== undefined) {
        throw new CapabilityError(400, 'legacy_sync_unsupported', '不再支持 sync 字段');
      }
      if (payload.archived !== undefined && typeof payload.archived !== 'boolean') {
        throw new CapabilityError(400, 'invalid_request', 'archived 必须是布尔值');
      }
      const archived = payload.archived !== false;
      const ids = parseIdList(payload);
      const classified = await classifyGovernanceTargets(ids, actor);
      const skipped = [];
      const allowed = [];
      for (const id of classified.allowed) {
        const node = classified.nodes.get(id);
        if (node?.deletedAt) skipped.push(id);
        else allowed.push(id);
      }
      let archivedIds = [];
      let unarchivedIds = [];
      if (allowed.length > 0) {
        const result = await service().archive(allowed, archived);
        archivedIds = result?.archived ?? [];
        unarchivedIds = result?.unarchived ?? [];
        classified.notFound.push(...(result?.notFound ?? []));
        skipped.push(...(result?.skipped ?? []));
        classified.internal.push(...(result?.internal ?? []));
      }
      return {
        data: {
          archived: archivedIds,
          unarchived: unarchivedIds,
          notFound: classified.notFound,
          skipped,
          forbidden: classified.forbidden,
          internal: classified.internal,
          partial: classified.notFound.length > 0
            || classified.forbidden.length > 0
            || classified.internal.length > 0,
          replayed: false,
        },
        warnings: [],
        degraded: false,
      };
    }

    // ---------- /internal-object ----------

    function assertInternalObjectActor(actor, agentId) {
      if (actor.type === 'user' || actor.type === 'system') return;
      if (actor.type === 'agent' && actor.agentId === agentId) return;
      throw new CapabilityError(403, 'forbidden_scope', '当前 actor 不能读写该 Agent 的内部对象', {
        actor: actor.type === 'agent' ? actor.agentId : actor.type,
        agentId,
      });
    }

    function parseInternalDomain(value, { required = true } = {}) {
      if (value === undefined || value === null) {
        if (required) throw new CapabilityError(400, 'domain_invalid', '缺少 domain');
        return null;
      }
      const domain = normalizeDomain(value);
      if (!domain) throw new CapabilityError(400, 'domain_invalid', 'domain 非法', { domain: value });
      return domain;
    }

    async function findCompactByIdentity(appValue, domain, identityKey) {
      const nodes = await listNodesOfType(appValue, 'compact');
      return nodes.find((node) => !node.deletedAt
        && isInternalNode(node)
        && internalObjectKind(node) === 'compact'
        && domainOfNamespace(node.namespace) === domain
        && internalObjectMetadata(node).identityKey === identityKey) ?? null;
    }

    // [internal-object-write] 内部对象允许直接 GraphStore 写入；普通 MemoryRecord 禁止。
    async function handleCompactObject(payload, actor) {      const op = payload.op;
      if (!['upsert', 'get', 'list', 'delete'].includes(op)) {
        throw new CapabilityError(400, 'internal_kind_invalid', 'compact op 必须是 upsert/get/list/delete');
      }
      const appValue = app();
      if (!appValue) throw new CapabilityError(503, 'capability_unavailable', '图存储尚未初始化', undefined, true);
      const identity = identitySnapshot();

      if (op === 'upsert') {
        const domain = parseInternalDomain(payload.domain);
        const strategy = payload.strategy === 'dedupe' ? 'dedupe' : 'summary';
        if (payload.strategy !== undefined && !['summary', 'dedupe'].includes(payload.strategy)) {
          throw new CapabilityError(400, 'invalid_request', 'strategy 必须是 summary | dedupe');
        }
        const sourceIds = (() => {
          if (Array.isArray(payload.sourceIds) && payload.sourceIds.length > MAX_COMPACT_SOURCES) {
            throw new CapabilityError(413, 'payload_too_large', `sourceIds 最多 ${MAX_COMPACT_SOURCES} 个`, {
              maxCompactSources: MAX_COMPACT_SOURCES,
            });
          }
          return stringArray(payload.sourceIds, 'sourceIds', 0, {
            maxItems: MAX_COMPACT_SOURCES,
            maxChars: 128,
          }) ?? [];
        })();
        if (sourceIds.length === 0) {
          throw new CapabilityError(400, 'invalid_request', 'sourceIds 不能为空');
        }
        if (new Set(sourceIds).size !== sourceIds.length) {
          throw new CapabilityError(400, 'invalid_request', 'sourceIds 不得重复');
        }
        const sourceHashes = stringArray(payload.sourceHashes, 'sourceHashes', 0, {
          maxItems: MAX_COMPACT_SOURCES,
          maxChars: 128,
        }) ?? [];
        if (sourceHashes.length > 0 && sourceHashes.length !== sourceIds.length) {
          throw new CapabilityError(400, 'invalid_request', 'sourceHashes 必须与 sourceIds 等长');
        }
        const provenanceInput = parseProvenanceInput(payload.provenance, 0);
        assertDomainWrite(actor, domain, provenanceInput, payload.threadId);
        const summary = nonEmptyString(payload.summary, 'summary', 0);
        if (Buffer.byteLength(summary, 'utf-8') > MAX_COMPACT_SUMMARY_BYTES) {
          throw new CapabilityError(413, 'payload_too_large', 'summary 超过 64 KiB');
        }
        const tokenCount = optionalNumber(payload.tokenCount, 'tokenCount', 0);
        if (tokenCount !== undefined && tokenCount < 0) {
          throw validationError(0, 'tokenCount', 'tokenCount 不能为负数');
        }
        const model = isObject(payload.model) ? jsonClone(payload.model) : undefined;
        if (model && byteSize(model) > MAX_JSON_FIELD_BYTES) {
          throw new CapabilityError(413, 'payload_too_large', 'model 超过大小限制');
        }
        const sourceNodes = [];
        for (const sourceId of sourceIds) {
          const source = await appValue.graph.getNode(sourceId);
          if (!source || source.deletedAt) {
            throw new CapabilityError(404, 'not_found', 'compact source 不存在', { id: sourceId });
          }
          if (isInternalNode(source)) {
            throw new CapabilityError(400, 'domain_mismatch', 'compact source 不能是内部对象', { id: sourceId });
          }
          const sourceDomain = domainOfNamespace(source.namespace);
          if (sourceDomain !== domain) {
            throw new CapabilityError(400, 'domain_mismatch', 'compact 与 source 必须同域', {
              domain,
              sourceId,
              sourceDomain,
            });
          }
          sourceNodes.push(source);
        }
        const effectiveSourceHashes = sourceHashes.length > 0
          ? [...sourceHashes]
          : sourceNodes.map((source) => `sha256:${sha256Hex(canonicalJson(source.content ?? null))}`);
        const identityKey = sha256Hex(canonicalJson({
          domain,
          strategy,
          sourceIds: [...sourceIds].sort(),
          sourceHashes: effectiveSourceHashes,
        }));
        const existing = await findCompactByIdentity(appValue, domain, identityKey);
        if (existing) {
          return {
            data: {
              object: compactObjectView(existing, {
                userId: identity.userId,
                stale: await isCompactStale(appValue, existing),
              }),
              replayed: false,
            },
            warnings: [],
            degraded: false,
          };
        }
        const provenance = buildWriteProvenance({
          input: provenanceInput,
          actor,
          identity,
          hostId,
          now: now(),
          threadId: provenanceInput.threadId ?? payload.threadId ?? null,
        });
        const content = {
          summary,
          sourceIds: [...sourceIds],
          sourceHashes: effectiveSourceHashes,
          strategy,
          ...(tokenCount !== undefined ? { tokenCount } : {}),
          ...(model !== undefined ? { model } : {}),
        };
        const created = await appValue.graph.createNode('compact', content, undefined, { namespace: domain });
        const node = await appValue.graph.updateNode(created.id, {
          metadata: {
            internal: true,
            internalObject: {
              schema: 1,
              kind: 'compact',
              strategy,
              identityKey,
              sourceIds: [...sourceIds],
              sourceHashes: effectiveSourceHashes,
            },
            provenance,
          },
        });
        if (!node) throw new CapabilityError(503, 'capability_unavailable', 'compact 写入后读取失败', undefined, true);
        return {
          data: {
            object: compactObjectView(node, { userId: identity.userId, stale: false }),
            replayed: false,
          },
          warnings: [],
          degraded: false,
        };
      }

      if (op === 'get') {
        if (typeof payload.id !== 'string' || payload.id.length === 0) {
          throw new CapabilityError(400, 'invalid_request', 'compact get 需要 id');
        }
        const node = await appValue.graph.getNode(payload.id);
        if (!node || node.deletedAt || !isInternalNode(node) || internalObjectKind(node) !== 'compact') {
          throw new CapabilityError(404, 'not_found', 'compact 不存在', { id: payload.id });
        }
        return {
          data: {
            object: compactObjectView(node, {
              userId: identity.userId,
              stale: await isCompactStale(appValue, node),
            }),
            replayed: false,
          },
          warnings: [],
          degraded: false,
        };
      }

      if (op === 'list') {
        let domains = null;
        if (payload.domains !== undefined) {
          if (!Array.isArray(payload.domains) || payload.domains.length > MAX_DOMAINS) {
            throw new CapabilityError(400, 'invalid_request', `domains 最多 ${MAX_DOMAINS} 个`);
          }
          domains = payload.domains.map((value) => {
            const domain = normalizeDomain(value);
            if (!domain) throw new CapabilityError(400, 'domain_invalid', 'domains 含非法域', { domain: value });
            return domain;
          });
        }
        const limit = clampLimit(payload.limit, 20);
        const staleOnly = payload.stale === true;
        const nodes = (await listNodesOfType(appValue, 'compact'))
          .filter((node) => !node.deletedAt && isInternalNode(node) && internalObjectKind(node) === 'compact')
          .filter((node) => domains === null || domains.includes(domainOfNamespace(node.namespace)))
          .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
        const objects = [];
        for (const node of nodes) {
          const stale = await isCompactStale(appValue, node);
          if (staleOnly && !stale) continue;
          objects.push(compactObjectView(node, { userId: identity.userId, stale }));
        }
        return {
          data: { objects: objects.slice(0, limit), total: objects.length, replayed: false },
          warnings: [],
          degraded: false,
        };
      }

      // delete
      if (actor.type !== 'user' && actor.type !== 'system') {
        throw new CapabilityError(403, 'forbidden_scope', '删除 compact 需要 user/system 权限');
      }
      if (typeof payload.id !== 'string' || payload.id.length === 0) {
        throw new CapabilityError(400, 'invalid_request', 'compact delete 需要 id');
      }
      const node = await appValue.graph.getNode(payload.id);
      if (!node || node.deletedAt || !isInternalNode(node) || internalObjectKind(node) !== 'compact') {
        throw new CapabilityError(404, 'not_found', 'compact 不存在', { id: payload.id });
      }
      await appValue.graph.deleteNode(payload.id);
      return {
        data: { deleted: true, id: payload.id, replayed: false },
        warnings: [],
        degraded: false,
      };
    }

    async function handleSelfRecordObject(payload, actor) {
      const op = payload.op;
      if (!['upsert', 'get'].includes(op)) {
        throw new CapabilityError(400, 'internal_kind_invalid', 'self_record op 必须是 upsert/get');
      }
      if (!isValidAgentId(payload.agentId)) {
        throw new CapabilityError(400, 'invalid_agent_id', 'agentId 格式非法');
      }
      const agentId = payload.agentId;
      assertInternalObjectActor(actor, agentId);
      const domain = `agent:${agentId}`;
      if (payload.domain !== undefined && payload.domain !== domain) {
        throw new CapabilityError(400, 'domain_mismatch', 'SelfRecord 必须位于 agent:<agentId> 域', {
          domain: payload.domain,
          expected: domain,
        });
      }
      if (payload.sync !== undefined || payload['self.sync'] !== undefined) {
        throw new CapabilityError(400, 'legacy_sync_unsupported', '不再支持 sync/self.sync 字段');
      }
      const appValue = app();
      if (!appValue) throw new CapabilityError(503, 'capability_unavailable', '图存储尚未初始化', undefined, true);
      const identity = identitySnapshot();
      const current = await currentSelfRecord(appValue, agentId);
      if (op === 'get') {
        return {
          data: {
            object: current ? selfRecordView(current, { userId: identity.userId }) : null,
            replayed: false,
          },
          warnings: [],
          degraded: false,
        };
      }
      const currentRevision = current ? internalObjectRevision(current) : 0;
      if (hasValue(payload.expectedRevision)) {
        if (typeof payload.expectedRevision !== 'number' || !Number.isInteger(payload.expectedRevision) || payload.expectedRevision < 0) {
          throw new CapabilityError(400, 'invalid_request', 'expectedRevision 必须是非负整数');
        }
        if (payload.expectedRevision !== currentRevision) {
          throw new CapabilityError(409, 'revision_mismatch', 'SelfRecord revision 冲突', {
            agentId,
            currentRevision,
            expectedRevision: payload.expectedRevision,
          }, true);
        }
      }
      const record = normalizeSelfRecord(payload.record, 0);
      const provenanceInput = parseProvenanceInput(payload.provenance, 0);
      assertDomainWrite(actor, domain, provenanceInput, null);
      const provenance = buildWriteProvenance({
        input: provenanceInput,
        actor,
        identity,
        hostId,
        now: now(),
      });
      const revision = currentRevision + 1;
      const created = await appValue.graph.createNode('self_record', {
        agentId,
        revision,
        record,
      }, undefined, { namespace: domain });
      const node = await appValue.graph.updateNode(created.id, {
        metadata: {
          internal: true,
          internalObject: { schema: 1, kind: 'self_record', agentId, revision },
          provenance,
        },
      });
      if (!node) throw new CapabilityError(503, 'capability_unavailable', 'SelfRecord 写入后读取失败', undefined, true);
      return {
        data: { object: selfRecordView(node, { userId: identity.userId }), conflict: null, replayed: false },
        warnings: [],
        degraded: false,
      };
    }

    async function handleCheckpointObject(payload, actor) {
      const op = payload.op;
      if (!['upsert', 'get', 'list', 'delete'].includes(op)) {
        throw new CapabilityError(400, 'internal_kind_invalid', 'context_checkpoint op 必须是 upsert/get/list/delete');
      }
      if (!isValidAgentId(payload.agentId)) {
        throw new CapabilityError(400, 'invalid_agent_id', 'agentId 格式非法');
      }
      const agentId = payload.agentId;
      assertInternalObjectActor(actor, agentId);
      if (payload.sync !== undefined || payload['checkpoint.sync'] !== undefined) {
        throw new CapabilityError(400, 'legacy_sync_unsupported', '不再支持 sync/checkpoint.sync 字段');
      }
      const appValue = app();
      if (!appValue) throw new CapabilityError(503, 'capability_unavailable', '图存储尚未初始化', undefined, true);
      const identity = identitySnapshot();

      if (op === 'get') {
        const threadId = parseThreadId(payload.threadId);
        if (!threadId) throw new CapabilityError(400, 'invalid_thread_id', 'checkpoint get 需要 threadId');
        const node = await currentCheckpoint(appValue, agentId, threadId);
        const visible = node && !checkpointExpired(node, now()) ? node : null;
        return {
          data: {
            object: visible ? checkpointObjectView(visible, { userId: identity.userId }) : null,
            replayed: false,
          },
          warnings: [],
          degraded: false,
        };
      }

      if (op === 'list') {
        const threadId = payload.threadId === undefined ? null : parseThreadId(payload.threadId);
        const limit = clampLimit(payload.limit, 20);
        const nodes = (await allCheckpoints(appValue, agentId, threadId))
          .filter((node) => !checkpointExpired(node, now()))
          .sort(compareInternalObjectNodes);
        const latestByThread = new Map();
        for (const node of nodes) {
          const threadId = checkpointThreadId(node);
          if (typeof threadId === 'string' && !latestByThread.has(threadId)) {
            latestByThread.set(threadId, node);
          }
        }
        const objects = [...latestByThread.values()].map((node) => checkpointObjectView(node, { userId: identity.userId }));
        return {
          data: { objects: objects.slice(0, limit), total: objects.length, replayed: false },
          warnings: [],
          degraded: false,
        };
      }

      if (op === 'delete') {
        if (actor.type !== 'user' && actor.type !== 'system') {
          throw new CapabilityError(403, 'forbidden_scope', '删除 checkpoint 需要 user/system 权限');
        }
        if (payload.id !== undefined) {
          if (typeof payload.id !== 'string' || payload.id.length === 0) {
            throw new CapabilityError(400, 'invalid_request', 'id 非法');
          }
          const node = await appValue.graph.getNode(payload.id);
          if (!node || node.deletedAt || !isV2CheckpointNode(node) || internalObjectKind(node) !== 'context_checkpoint') {
            throw new CapabilityError(404, 'not_found', 'checkpoint 不存在', { id: payload.id });
          }
          const revisionAgentId = checkpointAgentId(node);
          const revisionThreadId = checkpointThreadId(node);
          const revisions = revisionAgentId && revisionThreadId
            ? await allCheckpoints(appValue, revisionAgentId, revisionThreadId)
            : [node];
          for (const revision of revisions) {
            await appValue.graph.deleteNode(revision.id);
          }
          return {
            data: { deleted: true, id: payload.id, count: revisions.length, replayed: false },
            warnings: [],
            degraded: false,
          };
        }
        const threadId = parseThreadId(payload.threadId);
        if (!threadId) throw new CapabilityError(400, 'invalid_thread_id', 'checkpoint delete 需要 id 或 threadId');
        const nodes = await allCheckpoints(appValue, agentId, threadId);
        for (const node of nodes) {
          await appValue.graph.deleteNode(node.id);
        }
        return {
          data: { deleted: nodes.length > 0, count: nodes.length, replayed: false },
          warnings: [],
          degraded: false,
        };
      }

      // upsert
      const threadId = parseThreadId(payload.threadId);
      if (!threadId) throw new CapabilityError(400, 'invalid_thread_id', 'checkpoint 需要 threadId');
      if (payload.force === true && actor.type === 'agent') {
        throw new CapabilityError(403, 'forbidden_scope', 'force=true 仅允许 user/system');
      }
      let domain = 'default';
      if (payload.domain !== undefined && payload.domain !== null) {
        domain = parseInternalDomain(payload.domain);
        const validTaskDomain = domain.startsWith('task:') && domain.slice('task:'.length) === threadId;
        if (domain !== 'default' && !validTaskDomain) {
          throw new CapabilityError(400, 'domain_mismatch', 'Checkpoint 只能位于 task:<threadId> 或 default 域', {
            domain,
            threadId,
          });
        }
      }
      const current = await currentCheckpoint(appValue, agentId, threadId);
      const currentRevision = current ? internalObjectRevision(current) : 0;
      if (hasValue(payload.expectedRevision)) {
        if (typeof payload.expectedRevision !== 'number' || !Number.isInteger(payload.expectedRevision) || payload.expectedRevision < 0) {
          throw new CapabilityError(400, 'invalid_request', 'expectedRevision 必须是非负整数');
        }
        if (payload.expectedRevision !== currentRevision) {
          throw new CapabilityError(409, 'revision_mismatch', 'checkpoint revision 冲突', {
            agentId,
            threadId,
            currentRevision,
            expectedRevision: payload.expectedRevision,
          }, true);
        }
      }
      const currentContent = isObject(current?.content) ? current.content : {};
      const currentLease = isObject(currentContent.lease) ? currentContent.lease : null;
      if (currentLease && typeof currentLease.until === 'number' && currentLease.until > now()
        && currentLease.hostId !== hostId) {
        if (payload.force !== true) {
          throw new CapabilityError(409, 'checkpoint_lease_held', 'checkpoint 租约被其他 host 持有', {
            hostId: currentLease.hostId,
            until: currentLease.until,
          }, true);
        }
        if (actor.type !== 'user' && actor.type !== 'system') {
          throw new CapabilityError(403, 'forbidden_scope', '只有 user/system 可以抢占租约');
        }
      }
      const state = normalizeCheckpointState(payload.state, 0);
      let summary = null;
      if (payload.summary !== undefined && payload.summary !== null) {
        if (typeof payload.summary !== 'string') throw validationError(0, 'summary', 'summary 必须是字符串');
        if (Buffer.byteLength(payload.summary, 'utf-8') > MAX_COMPACT_SUMMARY_BYTES) {
          throw new CapabilityError(413, 'payload_too_large', 'summary 超过 64 KiB');
        }
        summary = payload.summary;
      }
      const recordIds = stringArray(payload.recordIds, 'recordIds', 0, {
        maxItems: MAX_COMPACT_SOURCES,
        maxChars: 128,
      }) ?? [];
      const expiresAt = payload.expiresAt === undefined || payload.expiresAt === null
        ? 0
        : optionalNumber(payload.expiresAt, 'expiresAt', 0);
      if (expiresAt < 0) throw validationError(0, 'expiresAt', 'expiresAt 不能为负数');
      let leaseMs = 60_000;
      if (payload.leaseMs !== undefined && payload.leaseMs !== null) {
        if (typeof payload.leaseMs !== 'number' || !Number.isFinite(payload.leaseMs) || payload.leaseMs <= 0) {
          throw validationError(0, 'leaseMs', 'leaseMs 必须是正数');
        }
        leaseMs = Math.min(payload.leaseMs, 3_600_000);
      }
      const lease = { hostId, until: now() + leaseMs };
      const provenanceInput = parseProvenanceInput(payload.provenance, 0);
      assertDomainWrite(actor, domain, {
        ...provenanceInput,
        threadId: provenanceInput.threadId ?? threadId,
      }, threadId);
      const provenance = buildWriteProvenance({
        input: provenanceInput,
        actor,
        identity,
        hostId,
        now: now(),
        threadId: provenanceInput.threadId ?? threadId,
      });
      const revision = currentRevision + 1;
      const content = {
        agentId,
        threadId,
        revision,
        state,
        summary,
        recordIds,
        lease,
        expiresAt,
      };
      const created = await appValue.graph.createNode('context_checkpoint', content, undefined, { namespace: domain });
      const node = await appValue.graph.updateNode(created.id, {
        metadata: {
          internal: true,
          internalObject: {
            schema: 1,
            kind: 'context_checkpoint',
            agentId,
            threadId,
            revision,
            lease,
          },
          provenance,
        },
      });
      if (!node) {
        throw new CapabilityError(503, 'capability_unavailable', 'checkpoint 写入后读取失败', undefined, true);
      }
      return {
        data: { object: checkpointObjectView(node, { userId: identity.userId }), conflict: null, replayed: false },
        warnings: [],
        degraded: false,
      };
    }

    // [/internal-object-write]
    async function handleInternalObject(payload, actor) {
      if (payload.sync !== undefined || payload['self.sync'] !== undefined || payload['checkpoint.sync'] !== undefined) {
        throw new CapabilityError(400, 'legacy_sync_unsupported', '不再支持 sync/self.sync/checkpoint.sync 字段');
      }
      const kind = payload.kind;
      if (!INTERNAL_OBJECT_KINDS.includes(kind)) {
        throw new CapabilityError(400, 'internal_kind_invalid', 'kind 必须是 compact | self_record | context_checkpoint');
      }
      if (kind === 'compact') return handleCompactObject(payload, actor);
      if (kind === 'self_record') return handleSelfRecordObject(payload, actor);
      return handleCheckpointObject(payload, actor);
    }

    // ---------- /sync ----------

    async function syncStatusData() {
      const currentService = service();
      const syncStatus = await syncStatusFor(currentService);
      const running = syncStatus.running === true;
      return {
        running,
        pendingEvents: typeof syncStatus.pendingEventCount === 'number' ? syncStatus.pendingEventCount : 0,
        peers: [],
        subscriptions: subscriptionView(getConfig()),
        lastSyncAt: typeof syncStatus.lastSyncAt === 'number' ? syncStatus.lastSyncAt : null,
        isSyncing: syncStatus.isSyncing === true,
        degraded: !running,
        warnings: running
          ? []
          : [{ code: 'sync_unavailable', message: '同步网络未启用；本地图仍可读写' }],
      };
    }

    async function handleSyncPost(payload) {
      if (payload.action !== 'now') {
        throw new CapabilityError(400, 'invalid_request', 'action 必须是 now');
      }
      let waitMs = MAX_SYNC_WAIT_MS;
      if (payload.waitMs !== undefined && payload.waitMs !== null) {
        if (typeof payload.waitMs !== 'number' || !Number.isFinite(payload.waitMs) || payload.waitMs < 0) {
          throw new CapabilityError(400, 'invalid_request', 'waitMs 必须是非负数字');
        }
        waitMs = Math.min(payload.waitMs, MAX_SYNC_WAIT_MS);
      }
      const currentService = service();
      if (typeof currentService.sync !== 'function') {
        throw new CapabilityError(503, 'sync_unavailable', '当前 MemoryService 不提供同步触发', undefined, true);
      }
      const syncStatus = await syncStatusFor(currentService);
      if (syncStatus.running !== true) {
        throw new CapabilityError(503, 'sync_unavailable', '同步网络未启用', { reason: 'network_not_running' }, true);
      }
      if (payload.peerId !== undefined && (typeof payload.peerId !== 'string' || payload.peerId.length === 0)) {
        throw new CapabilityError(400, 'invalid_request', 'peerId 必须是非空字符串');
      }
      if (payload.address !== undefined && typeof payload.address !== 'string') {
        throw new CapabilityError(400, 'invalid_request', 'address 必须是字符串');
      }
      if (typeof payload.peerId !== 'string' || payload.peerId.length === 0) {
        throw new CapabilityError(503, 'sync_unavailable', '需要显式 peerId 才能触发单次同步', {
          reason: 'peer_required',
        }, true);
      }
      const address = typeof payload.address === 'string' && payload.address.length > 0
        ? payload.address
        : undefined;
      let result;
      try {
        result = await timeoutAfter(
          currentService.sync(payload.peerId, address),
          Math.max(1, waitMs),
          '同步等待超时',
        );
      } catch (error) {
        if (error instanceof CapabilityError) throw error;
        throw new CapabilityError(503, 'sync_unavailable', '同步不可用', { reason: 'sync_failed' }, true);
      }
      return {
        data: {
          synced: true,
          peerId: typeof result?.peerDeviceId === 'string' ? result.peerDeviceId : payload.peerId,
          applied: typeof result?.receivedEvents === 'number' ? result.receivedEvents : 0,
          pushed: typeof result?.sentEvents === 'number' ? result.sentEvents : 0,
          duplicates: typeof result?.duplicates === 'number' ? result.duplicates : 0,
          conflicts: Array.isArray(result?.conflicts) ? result.conflicts.length : 0,
          tookMs: typeof result?.durationMs === 'number' ? result.durationMs : 0,
          replayed: false,
        },
        warnings: [],
        degraded: false,
      };
    }

    try {
      if (disposed) throw new CapabilityError(503, 'capability_unavailable', '能力接口已关闭', undefined, true);

      // 1) 挂载开关：轻量模式不创建目录/token/进程，直接 404。
      if (!isMemoryRuntimeEnabled(getConfig())) {
        await revoke().catch(() => undefined);
        throw new CapabilityError(404, 'capability_disabled', '记忆运行时能力接口未启用');
      }

      // 2) loopback + Host/Origin；无 CORS、无 cookie。
      if (!isLoopbackRemoteAddress(req?.socket?.remoteAddress)) {
        throw new CapabilityError(403, 'loopback_required', '仅允许本机回环调用');
      }
      const localPort = req?.socket?.localPort;
      if (!hostHeaderAllowed(req?.headers?.host, localPort)) {
        throw new CapabilityError(403, 'loopback_required', 'Host 头必须是本机回环地址');
      }
      if (!originAllowed(req?.headers?.origin, localPort)) {
        throw new CapabilityError(403, 'loopback_required', 'Origin 必须是本机回环地址');
      }

      // 3) 可选版本协商（major 不匹配拒绝）。
      const requestedVersion = req?.headers?.['x-mebular-capability-version'];
      if (hasValue(requestedVersion) && String(requestedVersion).trim() !== String(CAPABILITY_API_VERSION)) {
        throw new CapabilityError(409, 'capability_version_unsupported', '不支持的 capability major 版本');
      }

      // 4) Bearer capability token。
      if (tokenError) throw new CapabilityError(503, 'capability_unavailable', '能力令牌不可用', undefined, true);
      const record = await ensureToken().catch(() => {
        throw new CapabilityError(503, 'capability_unavailable', '能力令牌不可用', undefined, true);
      });
      const authorization = req?.headers?.authorization;
      const presented = typeof authorization === 'string' && authorization.startsWith('Bearer ')
        ? authorization.slice('Bearer '.length).trim()
        : '';
      if (presented === '' || !verifyCapabilityToken(presented, record, { now: now() })) {
        res.setHeader('www-authenticate', 'Bearer');
        throw new CapabilityError(401, 'capability_token_invalid', '缺少或无效的 capability token');
      }

      // 5) body 上限（contract §9.1）。
      if (body && body.length > MAX_BODY_BYTES) {
        throw new CapabilityError(413, 'payload_too_large', `请求体超过 ${MAX_BODY_BYTES} 字节`);
      }

      const relative = path.slice(CAPABILITY_API_PREFIX.length) || '/';
      const route = relative === '/' ? '' : relative.replace(/^\/+/, '');
      const isGet = req?.method === 'GET' || req?.method === 'HEAD';
      const isPost = req?.method === 'POST';

      // 6) 写端点：/sync（GET/POST）与 write/update/delete/archive/internal-object。
      if (route === 'sync') {
        if (isGet) {
          const data = await syncStatusData();
          return sendOk(data, data.warnings, 200, data.degraded);
        }
        if (!isPost) throw new CapabilityError(405, 'method_not_allowed', 'sync 仅接受 GET/POST');
        const payload = requireObjectBody();
        const result = await withIdempotency('sync', payload, record.tokenId, () => handleSyncPost(payload));
        return sendOk(result.data, result.warnings, 200, result.degraded);
      }

      if (WRITE_ENDPOINTS.has(route)) {
        if (!isPost) throw new CapabilityError(405, 'method_not_allowed', `${route} 仅接受 POST`);
        const payload = requireObjectBody();
        const actor = parseActor(payload.actor);
        let execute;
        if (route === 'write') execute = () => handleWrite(payload, actor);
        else if (route === 'update') execute = () => handleUpdate(payload, actor);
        else if (route === 'delete') execute = () => handleDelete(payload, actor);
        else if (route === 'archive') execute = () => handleArchive(payload, actor);
        else if (route === 'internal-object') execute = () => handleInternalObject(payload, actor);
        else throw new CapabilityError(404, 'not_found', '未知能力端点', { path: relative });
        const result = await withIdempotency(route, payload, record.tokenId, execute);
        return sendOk(result.data, result.warnings, 200, result.degraded);
      }

      if (route === 'version') {
        if (!isGet) throw new CapabilityError(405, 'method_not_allowed', 'version 仅接受 GET');
        return sendOk(versionPayload());
      }

      if (route === 'status') {
        if (!isGet) throw new CapabilityError(405, 'method_not_allowed', 'status 仅接受 GET');
        const actor = parseActor(actorFromQuery(url));
        const includeCounts = url?.searchParams?.get('includeCounts') !== 'false';
        const currentService = getService?.() ?? null;
        const stats = await statsFor(currentService);
        const syncStatus = await syncStatusFor(currentService);
        const identity = identitySnapshot();
        const data = {
          initialized: Boolean(currentService)
            && (typeof app()?.isInitialized === 'function' ? app().isInitialized() : Boolean(app())),
          identity: {
            ...identity,
            deviceId: identity.deviceId ?? app()?.deviceId ?? null,
            userId: identity.userId ?? 'user',
          },
          counts: includeCounts ? stats.counts : null,
          domains: includeCounts
            ? stats.domains.map((entry) => ({
              domain: entry.domain,
              ownerType: deriveOwner(entry.domain, { userId: identity.userId }).ownerType,
              count: entry.count,
            }))
            : [],
          sync: {
            running: syncStatus.running === true,
            pendingEvents: typeof syncStatus.pendingEventCount === 'number' ? syncStatus.pendingEventCount : 0,
            subscriptions: subscriptionView(getConfig()),
            lastSyncAt: typeof syncStatus.lastSyncAt === 'number' ? syncStatus.lastSyncAt : null,
          },
          limits: {
            maxBodyBytes: CAPABILITY_LIMITS.maxBodyBytes,
            maxBatchItems: CAPABILITY_LIMITS.maxBatchItems,
            maxLimit: CAPABILITY_LIMITS.maxLimit,
          },
          actor: { type: actor.type, ...(actor.agentId ? { agentId: actor.agentId } : {}) },
        };
        return sendOk(data);
      }

      if (route === 'namespaces') {
        if (!isGet) throw new CapabilityError(405, 'method_not_allowed', 'namespaces 仅接受 GET');
        const actor = parseActor(actorFromQuery(url));
        const includeCounts = url?.searchParams?.get('includeCounts') !== 'false';
        const currentService = getService?.() ?? null;
        const stats = await statsFor(currentService);
        const identity = identitySnapshot();
        const subscriptions = subscriptionView(getConfig());
        const domains = stats.domains.map((entry) => {
          const owner = deriveOwner(entry.domain, { userId: identity.userId });
          return {
            domain: entry.domain,
            ownerType: owner.ownerType,
            ownerId: owner.ownerId,
            namespace: entry.domain,
            ...(includeCounts
              ? {
                count: entry.count,
                memoryRecords: entry.memoryRecords,
                internalObjects: entry.internalObjects,
              }
              : {}),
            subscribed: subscriptions.mode === 'all' || subscriptions.namespaces.includes(entry.domain),
            lastUpdatedAt: entry.lastUpdatedAt,
          };
        });
        const legacyNamespaces = domains
          .map((entry) => entry.domain)
          .filter((domain) => !RESERVED_DOMAINS.has(domain)
            && !domain.startsWith('agent:')
            && !domain.startsWith('task:'));
        return sendOk({
          subscriptions,
          domains,
          legacyNamespaces,
          policyDomain: '__policy__',
          actor: { type: actor.type, ...(actor.agentId ? { agentId: actor.agentId } : {}) },
        });
      }

      if (route === 'query') {
        if (!isPost) throw new CapabilityError(405, 'method_not_allowed', 'query 仅接受 POST');
        const payload = requireObjectBody();
        const actor = parseActor(payload.actor);
        const threadId = parseThreadId(payload.threadId);
        if (hasValue(payload.query) && typeof payload.query !== 'string') {
          throw new CapabilityError(400, 'invalid_request', 'query 必须是字符串');
        }
        if (typeof payload.query === 'string' && Buffer.byteLength(payload.query, 'utf-8') > MAX_QUERY_BYTES) {
          throw new CapabilityError(413, 'payload_too_large', 'query 文本超过 8 KiB');
        }
        const currentService = service();
        const resolved = await resolveDomains({
          requested: payload.domains,
          endpoint: 'query',
          actor,
          threadId,
          strictDomains: payload.strictDomains === true,
          app: app(),
          config: getConfig(),
          service: currentService,
        });
        const limit = clampLimit(payload.limit);
        const offset = clampOffset(payload.offset);
        const types = parseTypes(payload.types ?? undefined);
        if (resolved.domains.length === 0) {
          return sendOk({
            records: [],
            total: 0,
            offset,
            limit,
            hasMore: false,
            tookMs: 0,
            usedDomains: [],
          }, resolved.warnings);
        }
        const filters = parseFilters(payload.filters);
        const result = await currentService.query({
          ...(typeof payload.query === 'string' && payload.query.length > 0 ? { query: payload.query } : {}),
          types,
          limit,
          offset,
          ...(payload.includeHistory !== undefined ? { includeHistory: payload.includeHistory === true } : {}),
          ...(payload.includeArchived !== undefined ? { includeArchived: payload.includeArchived === true } : {}),
          filters: { ...(filters ?? {}), namespace: resolved.domains },
        });
        const cache = new Map();
        const loaded = await Promise.all((result?.memories ?? []).map(async (memory) => ({
          memory,
          node: await loadNode(app(), memory.id, cache),
        })));
        // 选择/过滤/分页已全部由 MemoryService 完成；这里只做 owner/provenance 投影。
        const records = loaded.map(({ memory, node }) => recordView(memory, node, {
          userId: identitySnapshot().userId,
          withScore: true,
        }));
        const total = typeof result?.totalMatches === 'number' ? result.totalMatches : records.length;
        return sendOk({
          records,
          total,
          offset,
          limit,
          hasMore: offset + records.length < total,
          tookMs: typeof result?.queryTimeMs === 'number' ? result.queryTimeMs : 0,
          usedDomains: resolved.domains,
        }, resolved.warnings);
      }

      if (route === 'search') {
        if (!isPost) throw new CapabilityError(405, 'method_not_allowed', 'search 仅接受 POST');
        const payload = requireObjectBody();
        const actor = parseActor(payload.actor);
        const threadId = parseThreadId(payload.threadId);
        if (typeof payload.query !== 'string' || payload.query.trim() === '') {
          throw new CapabilityError(400, 'invalid_request', 'search 需要非空 query');
        }
        if (Buffer.byteLength(payload.query, 'utf-8') > MAX_QUERY_BYTES) {
          throw new CapabilityError(413, 'payload_too_large', 'query 文本超过 8 KiB');
        }
        const currentService = service();
        const resolved = await resolveDomains({
          requested: payload.domains,
          endpoint: 'search',
          actor,
          threadId,
          strictDomains: payload.strictDomains === true,
          app: app(),
          config: getConfig(),
          service: currentService,
        });
        const limit = clampLimit(payload.limit);
        const types = parseTypes(payload.types ?? undefined);
        if (resolved.domains.length === 0) {
          return sendOk({ records: [], relations: [], total: 0, tookMs: 0 }, resolved.warnings);
        }
        const filters = parseFilters(payload.filters);
        const result = await currentService.search({
          query: payload.query,
          types,
          limit,
          ...(payload.includeRelations !== undefined ? { includeRelations: payload.includeRelations === true } : {}),
          ...(payload.includeArchived !== undefined ? { includeArchived: payload.includeArchived === true } : {}),
          filters: { ...(filters ?? {}), namespace: resolved.domains },
        });
        const cache = new Map();
        const loaded = await Promise.all((result?.memories ?? []).map(async (memory) => ({
          memory,
          node: await loadNode(app(), memory.id, cache),
        })));
        // 选择/过滤/域关系过滤/分页已全部由 MemoryService 完成。
        const records = loaded.map(({ memory, node }) => recordView(memory, node, {
          userId: identitySnapshot().userId,
          withScore: true,
        }));
        const relations = payload.includeRelations === true
          ? (Array.isArray(result?.relations) ? result.relations : []).map((relation) => ({
            sourceId: relation.sourceId,
            targetId: relation.targetId,
            edgeType: relation.edgeType,
            ...(typeof relation.reason === 'string' ? { reason: relation.reason } : {}),
          }))
          : [];
        return sendOk({
          records,
          relations,
          total: records.length,
          tookMs: typeof result?.queryTimeMs === 'number' ? result.queryTimeMs : 0,
          usedDomains: resolved.domains,
        }, resolved.warnings);
      }

      if (route === 'history') {
        if (!isPost) throw new CapabilityError(405, 'method_not_allowed', 'history 仅接受 POST');
        const payload = requireObjectBody();
        const actor = parseActor(payload.actor);
        const threadId = parseThreadId(payload.threadId);
        const currentService = service();
        const resolved = await resolveDomains({
          requested: payload.domains,
          endpoint: 'history',
          actor,
          threadId,
          strictDomains: payload.strictDomains === true,
          app: app(),
          config: getConfig(),
          service: currentService,
        });
        const limit = clampLimit(payload.limit);
        const offset = clampOffset(payload.offset);
        if (resolved.domains.length === 0) {
          return sendOk({ episodes: [], total: 0, offset, limit, hasMore: false }, resolved.warnings);
        }
        const result = await currentService.history({
          ...(Array.isArray(payload.sessionIds) ? { sessionIds: payload.sessionIds.filter((id) => typeof id === 'string') } : {}),
          ...(typeof payload.startTime === 'number' ? { startTime: payload.startTime } : {}),
          ...(typeof payload.endTime === 'number' ? { endTime: payload.endTime } : {}),
          ...(typeof payload.topic === 'string' && payload.topic.length > 0 ? { topic: payload.topic } : {}),
          ...(payload.includeArchived !== undefined ? { includeArchived: payload.includeArchived === true } : {}),
          domains: resolved.domains,
          limit,
          offset,
        });
        // 域过滤、会话/时间/主题过滤、排序与分页均由 MemoryService.history 统一执行。
        const episodes = (result?.episodes ?? [])
          .map((node) => nodeView(node, { userId: identitySnapshot().userId }));
        const total = typeof result?.totalCount === 'number' ? result.totalCount : episodes.length;
        return sendOk({
          episodes,
          total,
          offset,
          limit,
          hasMore: offset + episodes.length < total,
        }, resolved.warnings);
      }

      if (route === 'skills') {
        if (!isPost) throw new CapabilityError(405, 'method_not_allowed', 'skills 仅接受 POST');
        const payload = requireObjectBody();
        const actor = parseActor(payload.actor);
        const currentService = service();
        const resolved = await resolveDomains({
          requested: payload.domains,
          endpoint: 'skills',
          actor,
          threadId: null,
          strictDomains: payload.strictDomains === true,
          app: app(),
          config: getConfig(),
          service: currentService,
        });
        const limit = clampLimit(payload.limit, MAX_LIMIT);
        if (resolved.domains.length === 0) {
          return sendOk({ skills: [], total: 0 }, resolved.warnings);
        }
        const skillFilter = {
          ...(typeof payload.category === 'string' && payload.category.length > 0 ? { category: payload.category } : {}),
          ...(typeof payload.search === 'string' && payload.search.length > 0 ? { search: payload.search } : {}),
          ...(Array.isArray(payload.tags) ? { tags: payload.tags.filter((tag) => typeof tag === 'string') } : {}),
          ...(payload.includeArchived !== undefined ? { includeArchived: payload.includeArchived === true } : {}),
          domains: resolved.domains,
          limit,
        };
        let page;
        if (typeof currentService.skillPage === 'function') {
          page = await currentService.skillPage(skillFilter);
        } else {
          // 兼容旧运行时：仍由 MemoryService 选技能；适配器只做分页兜底。
          const all = await currentService.skills(skillFilter);
          page = { skills: all.slice(0, limit), total: all.length };
        }
        const cache = new Map();
        const skills = [];
        for (const skill of Array.isArray(page?.skills) ? page.skills : []) {
          const node = await loadNode(app(), skill?.id, cache);
          if (!node) continue;
          const domain = domainOfNamespace(node?.namespace);
          const owner = deriveOwner(domain, { userId: identitySnapshot().userId });
          const metadata = isObject(node?.metadata) ? node.metadata : {};
          skills.push({
            ...skill,
            kind: 'skill',
            domain,
            namespace: domain,
            ownerType: owner.ownerType,
            ownerId: owner.ownerId,
            provenance: buildProvenance(metadata, domain, owner, node),
            legacy: !isObject(metadata.provenance),
            detailAvailable: metadata.detailAvailable !== false,
          });
        }
        return sendOk({
          skills,
          total: typeof page?.total === 'number' ? page.total : skills.length,
          usedDomains: resolved.domains,
        }, resolved.warnings);
      }

      if (route === 'profile') {
        if (!isPost) throw new CapabilityError(405, 'method_not_allowed', 'profile 仅接受 POST');
        const payload = requireObjectBody();
        const actor = parseActor(payload.actor);
        const currentService = service();
        const known = await knownDomainsFor(app(), getConfig(), actor, null, currentService);
        let allowedDomains;
        let profileWarnings = [];
        if (hasValue(payload.domains) && !Array.isArray(payload.domains)) {
          throw new CapabilityError(400, 'invalid_request', 'domains 必须是字符串数组');
        }
        if (Array.isArray(payload.domains) && payload.domains.length > 0) {
          const resolved = await resolveDomains({
            requested: payload.domains,
            endpoint: 'profile',
            actor,
            threadId: null,
            strictDomains: payload.strictDomains === true,
            app: app(),
            config: getConfig(),
            service: currentService,
          });
          allowedDomains = new Set(resolved.domains.filter((domain) => !domain.startsWith('agent:')
            && !domain.startsWith('task:')
            && domain !== 'system'));
          profileWarnings = resolved.warnings;
          if (allowedDomains.size === 0) {
            return sendOk({
              userId: identitySnapshot().userId,
              preferences: [],
              properties: {},
              legacyCount: 0,
              updatedAt: now(),
            }, resolved.warnings);
          }
        } else {
          allowedDomains = new Set([...known]
            .filter((domain) => !domain.startsWith('agent:')
              && !domain.startsWith('task:')
              && domain !== 'system'));
        }
        // 域过滤由 MemoryService.profile({domains}) 执行；这里只做 owner/provenance/legacy 投影。
        const profile = await currentService.profile({
          ...(payload.includeArchived !== undefined ? { includeArchived: payload.includeArchived === true } : {}),
          domains: [...allowedDomains],
        });
        const cache = new Map();
        const preferences = [];
        let legacyCount = 0;
        for (const preference of Array.isArray(profile?.preferences) ? profile.preferences : []) {
          const node = await loadNode(app(), preference?.id, cache);
          if (!node) continue;
          const domain = domainOfNamespace(node?.namespace);
          const metadata = isObject(node?.metadata) ? node.metadata : {};
          const legacy = !isObject(metadata.provenance);
          if (legacy) legacyCount += 1;
          preferences.push({
            ...preference,
            domain,
            namespace: domain,
            legacy,
            ownerType: deriveOwner(domain, { userId: identitySnapshot().userId }).ownerType,
            ownerId: deriveOwner(domain, { userId: identitySnapshot().userId }).ownerId,
            provenance: buildProvenance(metadata, domain, deriveOwner(domain, { userId: identitySnapshot().userId }), node),
          });
        }
        return sendOk({
          userId: profile?.userId ?? identitySnapshot().userId,
          preferences,
          properties: profile?.properties ?? {},
          legacyCount,
          updatedAt: typeof profile?.updatedAt === 'number' ? profile.updatedAt : now(),
        }, profileWarnings);
      }

      if (route === 'graph') {
        if (!isPost) throw new CapabilityError(405, 'method_not_allowed', 'graph 仅接受 POST');
        const payload = requireObjectBody();
        const actor = parseActor(payload.actor);
        const threadId = parseThreadId(payload.threadId);
        if (typeof payload.startId !== 'string' || payload.startId.length === 0) {
          throw new CapabilityError(400, 'invalid_request', 'graph 需要 startId');
        }
        const startCache = new Map();
        const startNode = await loadNode(app(), payload.startId, startCache);
        if (!startNode || startNode.deletedAt) throw new CapabilityError(404, 'not_found', '起点不存在');
        if (isInternalNode(startNode)) throw new CapabilityError(404, 'internal_object', '内部对象不可通过记忆图访问');
        if (isArchivedNode(startNode) && payload.includeArchived !== true) {
          throw new CapabilityError(404, 'not_found', '起点不存在');
        }
        const startDomain = domainOfNamespace(startNode.namespace);
        if (startDomain.startsWith('__')) {
          // `__policy__` / 其他 `__*` 不是记忆域；capability 永不读写。
          throw new CapabilityError(404, 'internal_object', '内部对象不可通过记忆图访问');
        }

        const currentService = service();
        let resolved;
        if (Array.isArray(payload.domains) && payload.domains.length > 0) {
          resolved = await resolveDomains({
            requested: payload.domains,
            endpoint: 'graph',
            actor,
            threadId,
            strictDomains: payload.strictDomains === true,
            app: app(),
            config: getConfig(),
            service: currentService,
          });
        } else {
          if (hasValue(payload.domains) && !Array.isArray(payload.domains)) {
            throw new CapabilityError(400, 'invalid_request', 'domains 必须是字符串数组');
          }
          resolved = await resolveDomains({
            requested: undefined,
            endpoint: 'graph',
            actor,
            threadId,
            strictDomains: payload.strictDomains === true,
            app: app(),
            config: getConfig(),
            service: currentService,
          });
          if (!resolved.domains.includes(startDomain)) resolved.domains.push(startDomain);
        }
        if (!resolved.domains.includes(startDomain)) {
          if (payload.strictDomains === true) {
            throw new CapabilityError(403, 'domain_read_forbidden', '起点域不可读', { domain: startDomain });
          }
          throw new CapabilityError(404, 'not_found', '起点不存在');
        }

        let result;
        try {
          result = await currentService.graph(payload.startId, {
            direction: payload.direction === 'incoming' || payload.direction === 'outgoing' ? payload.direction : 'both',
            maxDepth: clampDepth(payload.maxDepth),
            ...(Array.isArray(payload.edgeTypes)
              ? { edgeTypes: payload.edgeTypes.filter((type) => typeof type === 'string') }
              : {}),
            ...(payload.includeArchived !== undefined ? { includeArchived: payload.includeArchived === true } : {}),
            domains: resolved.domains,
          });
        } catch (error) {
          if (error?.code === 'INTERNAL_OBJECT') {
            throw new CapabilityError(404, 'internal_object', '内部对象不可通过记忆图访问');
          }
          throw error;
        }

        // 深度/方向/边类型、域、内部与归档过滤均已由 MemoryService.graph 执行。
        const visibleNodes = result?.visitedNodes ?? [];
        const nodes = visibleNodes
          .filter((node) => node.id !== payload.startId)
          .map((node) => nodeView(node, { userId: identitySnapshot().userId }));
        const edges = (result?.visitedEdges ?? [])
          .map((edge) => ({
            id: edge.id,
            source: edge.source,
            target: edge.target,
            relation: edge.relation,
            domain: domainOfNamespace(edge.namespace),
          }));
        return sendOk({
          start: nodeView(startNode, { userId: identitySnapshot().userId }),
          nodes,
          edges,
          truncated: false,
        }, resolved.warnings);
      }

      throw new CapabilityError(404, 'not_found', '未知能力端点', { path: relative });
    } catch (error) {
      if (error instanceof CapabilityError) {
        return sendError(error.status, error.code, error.message, error.details, error.retryable);
      }
      // 不把内部错误细节（含路径/内容）回给调用方；不记录 token。
      return sendError(500, 'internal', '能力接口内部错误', undefined, true);
    }
  };

  return Object.assign(handle, {
    prepare,
    revoke,
    dispose,
    isEnabled: () => isMemoryRuntimeEnabled(getConfig()),
    tokenId: () => tokenRecord?.tokenId ?? null,
  });
}
