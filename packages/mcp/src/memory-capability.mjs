// MCP Memory Capability API（0.3.0 contract v2 §7.1 / capability-api §1–§6）
//
// 内部接口：`/internal/memory/v1`，运行在 MCP daemon 内，只允许本机 memory-runtime
// sidecar 调用。不是公共 MCP 工具面（29 工具不变）。
//
// W2a 范围（只读）：
//   GET  /version
//   GET  /status
//   GET  /namespaces
//   POST /query
//   POST /search
//   POST /history
//   POST /profile
//   POST /skills
//   POST /graph
//
// W2b 才实现 write / update / delete / archive / internal-object / sync；本文件对
// 这些路径返回结构化 501 `not_implemented`，不复制写入业务逻辑。
//
// 约束：
// - 只调用 MemoryService / Mebular 公共方法；不直接打开 GraphStore / EventLog。
// - 域过滤是 MemoryService 结果之上的后置过滤；不修改公共工具默认行为。
// - 内部对象（metadata.internal / __*）默认不返回；graph 不遍历内部对象。
// - capability token 不进入日志、status、错误详情；响应使用统一信封。

import { createHash, randomUUID } from 'node:crypto';
import {
  ensureCapabilityToken,
  removeCapabilityToken,
  verifyCapabilityToken,
} from './memory-runtime-token.mjs';
import { APP_VERSION } from './version.mjs';

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

const AGENT_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const THREAD_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

const RESERVED_DOMAINS = new Set(['user', 'default', 'shared', 'system']);
const MEMORY_TYPES = new Set(['entity', 'fact', 'episode', 'skill', 'meta']);
const ALLOWED_TYPES = new Set(['fact', 'preference', 'episode', 'observation', 'skill', 'entity', 'meta']);
const DEFAULT_TYPES = ['fact', 'preference', 'episode', 'observation', 'skill', 'entity'];
const WRITE_ENDPOINTS = new Set(['write', 'update', 'delete', 'archive', 'internal-object', 'sync']);

export const CAPABILITY_LIMITS = Object.freeze({
  maxBodyBytes: MAX_BODY_BYTES,
  maxBatchItems: 100,
  maxContentBytes: 256 * 1024,
  maxDomains: MAX_DOMAINS,
  maxLimit: MAX_LIMIT,
  maxGraphDepth: MAX_DEPTH,
  maxCheckpointStateBytes: 256 * 1024,
  maxCompactSources: 200,
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

/** 节点 namespace → domain；缺失/空白按 default。 */
export function domainOfNamespace(namespace) {
  if (typeof namespace !== 'string') return 'default';
  const trimmed = namespace.trim();
  return trimmed === '' ? 'default' : trimmed;
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

/**
 * capability 的语义类型（preference/observation）→ MemoryService 的节点类型。
 * MemoryService 对 preference 有额外过滤，对 observation 只做 episode 展开；
 * 因此这里映射后，再由 capability 按语义类型做后置过滤。
 */
function serviceTypesFor(types, { search = false } = {}) {
  const out = new Set();
  for (const type of types) {
    if (type === 'fact') {
      out.add('fact');
    } else if (type === 'preference') {
      // search 的 MemoryStore 不认 preference；query 在“只要 preference”时可利用其原生过滤。
      if (search || types.includes('fact')) out.add('fact');
      else out.add('preference');
    } else if (type === 'episode' || type === 'observation') {
      out.add('episode');
    } else {
      out.add(type);
    }
  }
  return [...out];
}

function isNarrowSemanticFilter(types) {
  return (types.includes('preference') && !types.includes('fact'))
    || (types.includes('observation') && !types.includes('episode'));
}

function matchesRequestedTypes(record, types) {
  if (record.type === 'fact') {
    return types.includes('fact') || (types.includes('preference') && record.kind === 'preference');
  }
  if (record.type === 'episode') {
    return types.includes('episode') || (types.includes('observation') && record.kind === 'observation');
  }
  return types.includes(record.type);
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

async function knownDomainsFor(app, _config, actor, threadId) {
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
    // fall through to storage scan
  }
  for (const node of await listAllNodes(app)) {
    const domain = normalizeDomain(domainOfNamespace(node.namespace));
    if (domain) known.add(domain);
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
    ? await knownDomainsFor(app, config, actor, threadId)
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
  const content = isObject(node?.content) ? node.content : {};
  const metadata = isObject(node?.metadata) ? node.metadata : {};
  if (typeof metadata.kind === 'string' && ALLOWED_TYPES.has(metadata.kind)) return metadata.kind;
  if (typeof content.kind === 'string' && ALLOWED_TYPES.has(content.kind)) return content.kind;
  const type = node?.type ?? memory?.type;
  const tags = Array.isArray(node?.tags) ? node.tags : Array.isArray(memory?.metadata?.tags) ? memory.metadata.tags : [];
  if (type === 'fact' && tags.includes('preference')) return 'preference';
  if (type === 'episode' && content.episodeType === 'observation') return 'observation';
  return type ?? 'unknown';
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

function mapRelations(relations, nodeVisible) {
  const out = [];
  for (const relation of Array.isArray(relations) ? relations : []) {
    if (!nodeVisible(relation?.sourceId) || !nodeVisible(relation?.targetId)) continue;
    out.push({
      sourceId: relation.sourceId,
      targetId: relation.targetId,
      edgeType: relation.edgeType,
      ...(typeof relation.reason === 'string' ? { reason: relation.reason } : {}),
    });
  }
  return out;
}

function internalObjectKind(node) {
  const metadata = isObject(node?.metadata) ? node.metadata : {};
  const internalObject = isObject(metadata.internalObject) ? metadata.internalObject : {};
  if (typeof internalObject.kind === 'string') return internalObject.kind;
  return node?.type ?? null;
}

function domainStats(nodes) {
  const stats = new Map();
  for (const node of nodes) {
    const domain = domainOfNamespace(node.namespace);
    // `__policy__` 与其他 `__*` 保留域不是记忆域；capability 不读写。
    if (domain.startsWith('__')) continue;
    let entry = stats.get(domain);
    if (!entry) {
      entry = { domain, count: 0, memoryRecords: 0, internalObjects: 0, lastUpdatedAt: 0, internalKinds: {} };
      stats.set(domain, entry);
    }
    entry.count += 1;
    if (isInternalNode(node)) {
      entry.internalObjects += 1;
      const kind = internalObjectKind(node);
      if (kind) entry.internalKinds[kind] = (entry.internalKinds[kind] ?? 0) + 1;
    } else if (MEMORY_TYPES.has(node.type)) {
      entry.memoryRecords += 1;
    }
    entry.lastUpdatedAt = Math.max(entry.lastUpdatedAt, typeof node.updatedAt === 'number' ? node.updatedAt : 0);
  }
  return stats;
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
      batchWrite: false,
      idempotency: false,
      internalObjects: [],
      sync: false,
      graph: true,
      // W2a 只读中间态；W2b 加入写/内部对象后去掉此标记。
      readOnly: true,
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
      ],
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

      // W2b TODO：这些路径的写入/内部对象/同步逻辑不在 W2a 实现。
      if (WRITE_ENDPOINTS.has(route)) {
        throw new CapabilityError(
          501,
          'not_implemented',
          'W2a 只提供只读能力；写端点将在 W2b 实现',
          { endpoint: route, plannedIn: 'W2b' },
        );
      }

      if (route === 'version') {
        if (!isGet) throw new CapabilityError(405, 'method_not_allowed', 'version 仅接受 GET');
        return sendOk(versionPayload());
      }

      if (route === 'status') {
        if (!isGet) throw new CapabilityError(405, 'method_not_allowed', 'status 仅接受 GET');
        const actor = parseActor(actorFromQuery(url));
        const includeCounts = url?.searchParams?.get('includeCounts') !== 'false';
        const nodes = await listAllNodes(app());
        const stats = domainStats(nodes);
        const counts = {
          nodes: 0,
          memoryRecords: 0,
          compacts: 0,
          checkpoints: 0,
          selfRecords: 0,
        };
        for (const entry of stats.values()) {
          counts.nodes += entry.count;
          counts.memoryRecords += entry.memoryRecords;
          counts.compacts += entry.internalKinds.compact ?? 0;
          counts.checkpoints += entry.internalKinds.context_checkpoint ?? 0;
          counts.selfRecords += entry.internalKinds.self_record ?? 0;
        }
        let status = null;
        const currentService = getService?.() ?? null;
        try {
          if (currentService && typeof currentService.status === 'function') status = await currentService.status();
        } catch {
          status = null;
        }
        if (nodes.length === 0 && typeof status?.nodeCount === 'number') {
          counts.nodes = status.nodeCount;
        }
        const identity = identitySnapshot();
        const data = {
          initialized: Boolean(currentService)
            && (typeof app()?.isInitialized === 'function' ? app().isInitialized() : Boolean(app())),
          identity: {
            ...identity,
            deviceId: identity.deviceId ?? status?.deviceId ?? app()?.deviceId ?? null,
            userId: identity.userId ?? 'user',
          },
          counts: includeCounts ? counts : null,
          domains: includeCounts
            ? [...stats.values()].map((entry) => ({
              domain: entry.domain,
              ownerType: deriveOwner(entry.domain, { userId: identity.userId }).ownerType,
              count: entry.count,
            }))
            : [],
          sync: {
            running: status?.running === true,
            pendingEvents: typeof status?.pendingEventCount === 'number' ? status.pendingEventCount : 0,
            subscriptions: subscriptionView(getConfig()),
            lastSyncAt: null,
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
        const nodes = await listAllNodes(app());
        const stats = domainStats(nodes);
        const identity = identitySnapshot();
        const subscriptions = subscriptionView(getConfig());
        const domains = [...stats.values()].map((entry) => {
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
        const resolved = await resolveDomains({
          requested: payload.domains,
          endpoint: 'query',
          actor,
          threadId,
          strictDomains: payload.strictDomains === true,
          app: app(),
          config: getConfig(),
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
        const narrow = isNarrowSemanticFilter(types);
        const fetchLimit = narrow ? Math.min(offset + limit + MAX_LIMIT, 200) : limit;
        const result = await service().query({
          ...(typeof payload.query === 'string' && payload.query.length > 0 ? { query: payload.query } : {}),
          types: serviceTypesFor(types),
          limit: fetchLimit,
          offset: narrow ? 0 : offset,
          ...(payload.includeHistory !== undefined ? { includeHistory: payload.includeHistory === true } : {}),
          ...(payload.includeArchived !== undefined ? { includeArchived: payload.includeArchived === true } : {}),
          filters: { ...(filters ?? {}), namespace: resolved.domains },
        });
        const cache = new Map();
        const domainSet = new Set(resolved.domains);
        const loaded = await Promise.all((result?.memories ?? []).map(async (memory) => ({
          memory,
          node: await loadNode(app(), memory.id, cache),
        })));
        const mapped = loaded
          .filter(({ memory, node }) => !isInternalNode(node)
            && domainSet.has(domainOfNamespace(node?.namespace ?? memory?.metadata?.namespace)))
          .map(({ memory, node }) => recordView(memory, node, {
            userId: identitySnapshot().userId,
            withScore: true,
          }));
        const records = mapped.filter((record) => matchesRequestedTypes(record, types));
        const page = narrow ? records.slice(offset, offset + limit) : records;
        const total = narrow
          ? records.length
          : typeof result?.totalMatches === 'number'
            ? result.totalMatches
            : records.length;
        return sendOk({
          records: page,
          total,
          offset,
          limit,
          hasMore: offset + page.length < total,
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
        const resolved = await resolveDomains({
          requested: payload.domains,
          endpoint: 'search',
          actor,
          threadId,
          strictDomains: payload.strictDomains === true,
          app: app(),
          config: getConfig(),
        });
        const limit = clampLimit(payload.limit);
        const types = parseTypes(payload.types ?? undefined);
        if (resolved.domains.length === 0) {
          return sendOk({ records: [], relations: [], total: 0, tookMs: 0 }, resolved.warnings);
        }
        const filters = parseFilters(payload.filters);
        const narrow = isNarrowSemanticFilter(types);
        const result = await service().search({
          query: payload.query,
          types: serviceTypesFor(types, { search: true }),
          limit: narrow ? MAX_LIMIT : limit,
          ...(payload.includeRelations !== undefined ? { includeRelations: payload.includeRelations === true } : {}),
          ...(payload.includeArchived !== undefined ? { includeArchived: payload.includeArchived === true } : {}),
          filters: { ...(filters ?? {}), namespace: resolved.domains },
        });
        const cache = new Map();
        const domainSet = new Set(resolved.domains);
        const loaded = await Promise.all((result?.memories ?? []).map(async (memory) => ({
          memory,
          node: await loadNode(app(), memory.id, cache),
        })));
        const mapped = loaded
          .filter(({ memory, node }) => !isInternalNode(node)
            && domainSet.has(domainOfNamespace(node?.namespace ?? memory?.metadata?.namespace)))
          .map(({ memory, node }) => recordView(memory, node, {
            userId: identitySnapshot().userId,
            withScore: true,
          }));
        const records = mapped
          .filter((record) => matchesRequestedTypes(record, types))
          .slice(0, limit);
        const visible = new Set(records.map((record) => record.id));
        const nodeVisible = (id) => {
          if (typeof id !== 'string' || !visible.has(id)) {
            // 关系端点可能不在命中集：用缓存补读并判断域/内部对象。
            const node = cache.get(id);
            if (!node) return false;
            if (isInternalNode(node)) return false;
            return domainSet.has(domainOfNamespace(node.namespace));
          }
          return true;
        };
        // 关系端点未必命中 records；先补读再过滤。
        for (const relation of Array.isArray(result?.relations) ? result.relations : []) {
          await loadNode(app(), relation?.sourceId, cache);
          await loadNode(app(), relation?.targetId, cache);
        }
        return sendOk({
          records,
          relations: payload.includeRelations === true
            ? mapRelations(
              (Array.isArray(result?.relations) ? result.relations : [])
                .filter((relation) => visible.has(relation?.sourceId) || visible.has(relation?.targetId)),
              nodeVisible,
            )
            : [],
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
        const resolved = await resolveDomains({
          requested: payload.domains,
          endpoint: 'history',
          actor,
          threadId,
          strictDomains: payload.strictDomains === true,
          app: app(),
          config: getConfig(),
        });
        const limit = clampLimit(payload.limit);
        const offset = clampOffset(payload.offset);
        if (resolved.domains.length === 0) {
          return sendOk({ episodes: [], total: 0, offset, limit, hasMore: false }, resolved.warnings);
        }
        const result = await service().history({
          ...(Array.isArray(payload.sessionIds) ? { sessionIds: payload.sessionIds.filter((id) => typeof id === 'string') } : {}),
          ...(typeof payload.startTime === 'number' ? { startTime: payload.startTime } : {}),
          ...(typeof payload.endTime === 'number' ? { endTime: payload.endTime } : {}),
          ...(typeof payload.topic === 'string' && payload.topic.length > 0 ? { topic: payload.topic } : {}),
          ...(payload.includeArchived !== undefined ? { includeArchived: payload.includeArchived === true } : {}),
        });
        const domainSet = new Set(resolved.domains);
        const episodes = (result?.episodes ?? [])
          .filter((node) => !isInternalNode(node) && domainSet.has(domainOfNamespace(node.namespace)))
          .map((node) => nodeView(node, { userId: identitySnapshot().userId }));
        const total = episodes.length;
        const page = episodes.slice(offset, offset + limit);
        return sendOk({
          episodes: page,
          total,
          offset,
          limit,
          hasMore: offset + page.length < total,
        }, resolved.warnings);
      }

      if (route === 'skills') {
        if (!isPost) throw new CapabilityError(405, 'method_not_allowed', 'skills 仅接受 POST');
        const payload = requireObjectBody();
        const actor = parseActor(payload.actor);
        const resolved = await resolveDomains({
          requested: payload.domains,
          endpoint: 'skills',
          actor,
          threadId: null,
          strictDomains: payload.strictDomains === true,
          app: app(),
          config: getConfig(),
        });
        const limit = clampLimit(payload.limit, MAX_LIMIT);
        if (resolved.domains.length === 0) {
          return sendOk({ skills: [], total: 0 }, resolved.warnings);
        }
        const skills = await service().skills({
          ...(typeof payload.category === 'string' && payload.category.length > 0 ? { category: payload.category } : {}),
          ...(typeof payload.search === 'string' && payload.search.length > 0 ? { search: payload.search } : {}),
          ...(Array.isArray(payload.tags) ? { tags: payload.tags.filter((tag) => typeof tag === 'string') } : {}),
          ...(payload.includeArchived !== undefined ? { includeArchived: payload.includeArchived === true } : {}),
        });
        const domainSet = new Set(resolved.domains);
        const cache = new Map();
        const filtered = [];
        for (const skill of Array.isArray(skills) ? skills : []) {
          const node = await loadNode(app(), skill?.id, cache);
          if (!node || isInternalNode(node)) continue;
          const domain = domainOfNamespace(node.namespace);
          if (!domainSet.has(domain)) continue;
          const owner = deriveOwner(domain, { userId: identitySnapshot().userId });
          const metadata = isObject(node.metadata) ? node.metadata : {};
          filtered.push({
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
          skills: filtered.slice(0, limit),
          total: filtered.length,
          usedDomains: resolved.domains,
        }, resolved.warnings);
      }

      if (route === 'profile') {
        if (!isPost) throw new CapabilityError(405, 'method_not_allowed', 'profile 仅接受 POST');
        const payload = requireObjectBody();
        const actor = parseActor(payload.actor);
        const known = await knownDomainsFor(app(), getConfig(), actor, null);
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
        const profile = await service().profile({
          ...(payload.includeArchived !== undefined ? { includeArchived: payload.includeArchived === true } : {}),
        });
        const cache = new Map();
        const preferences = [];
        let legacyCount = 0;
        for (const preference of Array.isArray(profile?.preferences) ? profile.preferences : []) {
          const node = await loadNode(app(), preference?.id, cache);
          if (!node || isInternalNode(node)) continue;
          const domain = domainOfNamespace(node.namespace);
          if (!allowedDomains.has(domain)) continue;
          const metadata = isObject(node.metadata) ? node.metadata : {};
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
          result = await service().graph(payload.startId, {
            direction: payload.direction === 'incoming' || payload.direction === 'outgoing' ? payload.direction : 'both',
            maxDepth: clampDepth(payload.maxDepth),
            ...(Array.isArray(payload.edgeTypes)
              ? { edgeTypes: payload.edgeTypes.filter((type) => typeof type === 'string') }
              : {}),
            ...(payload.includeArchived !== undefined ? { includeArchived: payload.includeArchived === true } : {}),
            namespace: resolved.domains,
          });
        } catch (error) {
          if (error?.code === 'INTERNAL_OBJECT') {
            throw new CapabilityError(404, 'internal_object', '内部对象不可通过记忆图访问');
          }
          throw error;
        }

        const domainSet = new Set(resolved.domains);
        const visibleNodes = (result?.visitedNodes ?? [])
          .filter((node) => !isInternalNode(node) && domainSet.has(domainOfNamespace(node.namespace)));
        const kept = new Set(visibleNodes.map((node) => node.id));
        const nodes = visibleNodes
          .filter((node) => node.id !== payload.startId)
          .map((node) => nodeView(node, { userId: identitySnapshot().userId }));
        const edges = (result?.visitedEdges ?? [])
          .filter((edge) => kept.has(edge.source) && kept.has(edge.target))
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
