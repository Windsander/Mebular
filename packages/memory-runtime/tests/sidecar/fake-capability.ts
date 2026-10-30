// fake MCP Memory Capability API（只用于 sidecar 测试）。
//
// 不启动真实 MCP/core；实现 /write、/query、/search、/history、/profile、
// /skills、/graph、/internal-object 与 /namespaces，记录请求并按内存内容去重，
// 足以验证幂等、域路由、provenance、outbox 重放、compact stale、
// checkpoint revision/lease 与 SelfRecord revision。

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';

export interface FakeCapabilityRequest {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: any;
}

interface FakeNode {
  id: string;
  type: string;
  kind: string;
  domain: string;
  ownerType: string;
  ownerId: string;
  contentHash: string;
  clientItemId?: string;
  content: unknown;
  provenance: Record<string, unknown>;
}

export interface FakeCapabilityServer {
  baseUrl: string;
  requests: FakeCapabilityRequest[];
  writeRequests: FakeCapabilityRequest[];
  detailRequests: FakeCapabilityRequest[];
  nodes: FakeNode[];
  records: FakeMemoryRecord[];
  compacts: FakeCompact[];
  selfRecords: FakeSelfRecord[];
  checkpoints: FakeCheckpoint[];
  details: FakeDetail[];
  setRecords: (records: FakeMemoryRecord[]) => void;
  setCompacts: (compacts: FakeCompact[]) => void;
  setDetails: (details: FakeDetail[]) => void;
  setCheckpointLeaseHost: (hostId: string) => void;
  setFailure: (failure: { status: number; code: string; retryable?: boolean } | null) => void;
  setDetailFailure: (failure: { status: number; code: string; retryable?: boolean } | null) => void;
  close: () => Promise<void>;
}

export interface FakeCapabilityOptions {
  /**
   * 验收用可选行为：按 query/topic/search 做词法过滤，模拟真实 capability
   * 只返回相关候选。默认关闭，保持既有 sidecar 测试的“返回全部记录”行为。
   */
  filterQuery?: boolean;
}

export interface FakeMemoryRecord {
  id: string;
  type: string;
  kind?: string;
  domain: string;
  namespace?: string;
  ownerType?: string;
  ownerId?: string;
  provenance?: Record<string, unknown>;
  content?: Record<string, unknown>;
  text?: string;
  tags?: string[];
  validFrom?: number | null;
  validTo?: number | null;
  createdAt?: number | null;
  updatedAt?: number | null;
  detailAvailable?: boolean;
  legacy?: boolean;
  score?: number;
  why?: string;
  stale?: boolean;
  metadata?: Record<string, unknown>;
  deletedAt?: number | null;
}

export interface FakeCompact {
  id: string;
  type?: 'compact';
  kind?: 'compact';
  domain: string;
  ownerType?: string;
  ownerId?: string;
  summary: string;
  sourceIds?: string[];
  sourceHashes?: string[];
  strategy?: 'summary' | 'dedupe';
  tokenCount?: number | null;
  stale?: boolean;
  provenance?: Record<string, unknown>;
  createdAt?: number | null;
  updatedAt?: number | null;
  identityKey?: string;
}

export interface FakeSelfRecord {
  id: string;
  domain: string;
  agentId: string;
  revision: number;
  content: Record<string, unknown>;
  provenance?: Record<string, unknown>;
  createdAt?: number | null;
  updatedAt?: number | null;
}

export interface FakeDetail {
  id: string;
  type?: 'detail_record';
  kind?: 'detail_record';
  detailKind: string;
  domain: string;
  ownerType?: string;
  ownerId?: string;
  recordIds: string[];
  role?: string;
  text: string;
  mime?: string;
  messageId?: string;
  chunkIndex?: number;
  turn?: number;
  contentHash?: string;
  redaction?: { applied: boolean; rules: string[] };
  retentionClass?: string;
  expiresAt?: number;
  deletedAt?: number | null;
  metadata?: Record<string, unknown>;
  provenance?: Record<string, unknown>;
  createdAt?: number | null;
  updatedAt?: number | null;
}

export interface FakeCheckpoint {
  id: string;
  domain: string;
  agentId: string;
  threadId: string;
  revision: number;
  state: Record<string, unknown>;
  summary: string | null;
  recordIds: string[];
  lease: { hostId: string; until: number } | null;
  expiresAt: number;
  provenance?: Record<string, unknown>;
  createdAt?: number | null;
  updatedAt?: number | null;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
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

function canonicalHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex')}`;
}

function isObjectLike(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function typeOf(kind: string): string {
  if (kind === 'preference' || kind === 'fact' || kind === 'observation') return 'fact';
  return kind;
}

function ownerOf(domain: string): { ownerType: string; ownerId: string } {
  if (domain === 'user') return { ownerType: 'user', ownerId: 'u_test' };
  if (domain.startsWith('agent:')) return { ownerType: 'agent', ownerId: domain.slice('agent:'.length) };
  return { ownerType: 'other', ownerId: domain };
}

function envelope(data: unknown, warnings: unknown[] = [], degraded = false) {
  return {
    ok: true,
    requestId: 'req_fake',
    capabilityVersion: 1,
    data,
    warnings,
    degraded,
  };
}

function errorEnvelope(code: string, message: string, retryable: boolean, details?: unknown) {
  return {
    ok: false,
    requestId: 'req_fake',
    capabilityVersion: 1,
    error: {
      code,
      message,
      retryable: Boolean(retryable),
      ...(details !== undefined ? { details } : {}),
    },
  };
}

// 验收 fake 的轻量词法匹配：只用于让“无关 query”真的没有候选，
// 不模拟真实 BM25/embedding，也不改变产品召回逻辑。
const QUERY_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'do', 'does', 'for', 'from',
  'how', 'i', 'if', 'in', 'is', 'it', 'me', 'my', 'of', 'on', 'or', 'the',
  'to', 'was', 'we', 'what', 'when', 'where', 'which', 'who', 'why', 'you',
  'your', 'please', 'tell', 'remember', 'recall', 'last', 'time', 'about',
  '的', '了', '吗', '呢', '吧', '啊', '呀', '嘛', '哦', '嗯', '是', '在',
  '有', '和', '与', '就', '都', '也', '还', '很', '太', '我', '你', '他',
  '她', '它', '我们', '你们', '他们', '这个', '那个', '这些', '那些',
  '什么', '怎么', '怎样', '如何', '一下', '一些', '可以', '能否', '请问',
  '帮我', '告诉', '记得', '现在', '之前', '刚才', '还是', '到底', '哪个',
  '哪里', '多少', '几个', '哪天', '上次', '后来', '然后', '为什么', '是什么',
  '是不是', '说的', '改了', '用', '选', '把', '给', '吗？', '呢？',
]);

function queryTerms(query: string): string[] {
  const text = String(query ?? '').normalize('NFKC').toLowerCase();
  const terms = new Set<string>();
  const add = (value: string | undefined): void => {
    const term = value?.trim().toLowerCase();
    if (!term || term.length < 2 || QUERY_STOPWORDS.has(term)) return;
    terms.add(term);
  };
  for (const match of text.matchAll(/[a-z0-9][a-z0-9._:/-]{1,63}/g)) add(match[0]);
  for (const run of text.matchAll(/[\u3400-\u9fff]{2,}/g)) {
    const value = run[0]!;
    if (value.length <= 8) add(value);
    for (let index = 0; index < value.length - 1; index += 1) {
      add(value.slice(index, index + 2));
    }
  }
  return [...terms];
}

function recordHaystack(record: FakeMemoryRecord): string {
  return [
    record.id,
    record.type,
    record.kind,
    record.domain,
    record.text,
    ...(record.tags ?? []),
    JSON.stringify(record.content ?? {}),
  ].filter((part) => typeof part === 'string' && part.length > 0).join(' ').toLowerCase();
}

function recordMatchesQuery(record: FakeMemoryRecord, query: string): boolean {
  const terms = queryTerms(query);
  if (terms.length === 0) return true;
  const haystack = recordHaystack(record);
  return terms.some((term) => haystack.includes(term));
}

export async function startFakeCapability(options: FakeCapabilityOptions = {}): Promise<FakeCapabilityServer> {
  const filterQuery = options.filterQuery === true;
  const requests: FakeCapabilityRequest[] = [];
  const writeRequests: FakeCapabilityRequest[] = [];
  const detailRequests: FakeCapabilityRequest[] = [];
  const nodes: FakeNode[] = [];
  let records: FakeMemoryRecord[] = [];
  let compacts: FakeCompact[] = [];
  const selfRecords: FakeSelfRecord[] = [];
  const checkpoints: FakeCheckpoint[] = [];
  let details: FakeDetail[] = [];
  let failure: { status: number; code: string; retryable?: boolean } | null = null;
  let detailFailure: { status: number; code: string; retryable?: boolean } | null = null;
  let leaseHost = 'h_fake';
  let counter = 0;

  const domainsOf = (body: any): string[] | null => {
    if (Array.isArray(body?.domains)) return body.domains.filter((entry: unknown) => typeof entry === 'string');
    return null;
  };
  const inDomains = (domain: string, domains: string[] | null): boolean => !domains || domains.includes(domain);
  const recordList = (body: any, types?: string[]) => records
    .filter((record) => inDomains(record.domain, domainsOf(body)))
    .filter((record) => !types || types.length === 0 || types.includes(record.kind ?? record.type))
    .map((record) => ({
      namespace: record.namespace ?? record.domain,
      ownerType: record.ownerType ?? ownerOf(record.domain).ownerType,
      ownerId: record.ownerId ?? ownerOf(record.domain).ownerId,
      provenance: record.provenance ?? {},
      content: record.content ?? {},
      tags: record.tags ?? [],
      validFrom: record.validFrom ?? null,
      validTo: record.validTo ?? null,
      createdAt: record.createdAt ?? null,
      updatedAt: record.updatedAt ?? record.createdAt ?? null,
      detailAvailable: record.detailAvailable !== false,
      legacy: record.legacy === true,
      ...record,
    }));

  const compactView = (compact: FakeCompact) => {
    const sourceIds = compact.sourceIds ?? [];
    const sourceHashes = compact.sourceHashes ?? [];
    let stale = compact.stale === true;
    for (let index = 0; index < sourceIds.length; index += 1) {
      const source = records.find((record) => record.id === sourceIds[index]);
      if (!source) {
        stale = true;
        break;
      }
      const expected = sourceHashes[index];
      if (typeof expected === 'string' && expected.length > 0) {
        if (canonicalHash(source.content ?? {}) !== expected) {
          stale = true;
          break;
        }
      } else if ((source.updatedAt ?? 0) > (compact.createdAt ?? 0)) {
        stale = true;
        break;
      }
    }
    return {
      ...compact,
      type: 'compact' as const,
      kind: 'compact' as const,
      namespace: compact.domain,
      ownerType: compact.ownerType ?? ownerOf(compact.domain).ownerType,
      ownerId: compact.ownerId ?? ownerOf(compact.domain).ownerId,
      internal: true,
      sourceIds,
      sourceHashes,
      strategy: compact.strategy ?? 'summary',
      tokenCount: compact.tokenCount ?? null,
      stale,
      provenance: compact.provenance ?? {},
      createdAt: compact.createdAt ?? 0,
      updatedAt: compact.updatedAt ?? compact.createdAt ?? 0,
    };
  };

  const currentSelf = (agentId: string): FakeSelfRecord | null => selfRecords
    .filter((record) => record.agentId === agentId)
    .sort((a, b) => b.revision - a.revision
      || (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
      || b.id.localeCompare(a.id))[0] ?? null;

  const selfView = (record: FakeSelfRecord) => ({
    id: record.id,
    type: 'self_record' as const,
    kind: 'self_record' as const,
    domain: record.domain,
    namespace: record.domain,
    ownerType: ownerOf(record.domain).ownerType,
    ownerId: ownerOf(record.domain).ownerId,
    internal: true,
    agentId: record.agentId,
    revision: record.revision,
    content: record.content,
    provenance: record.provenance ?? {},
    createdAt: record.createdAt ?? 0,
    updatedAt: record.updatedAt ?? record.createdAt ?? 0,
  });

  const currentCheckpoint = (agentId: string, threadId: string): FakeCheckpoint | null => checkpoints
    .filter((checkpoint) => checkpoint.agentId === agentId && checkpoint.threadId === threadId)
    .sort((a, b) => b.revision - a.revision
      || (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
      || b.id.localeCompare(a.id))[0] ?? null;

  const detailView = (detail: FakeDetail, includeText: boolean) => ({
    id: detail.id,
    type: 'detail_record' as const,
    kind: 'detail_record' as const,
    detailKind: detail.detailKind,
    domain: detail.domain,
    namespace: detail.domain,
    ownerType: detail.ownerType ?? ownerOf(detail.domain).ownerType,
    ownerId: detail.ownerId ?? ownerOf(detail.domain).ownerId,
    role: detail.role ?? 'user',
    ...(includeText ? { text: detail.text } : {}),
    ...(detail.text.length > 4096 ? { truncated: true } : {}),
    redacted: detail.redaction?.applied === true,
    contentHash: detail.contentHash ?? `sha256:${sha256(detail.text)}`,
    recordIds: detail.recordIds,
    ...(detail.messageId ? { messageId: detail.messageId } : {}),
    ...(typeof detail.chunkIndex === 'number' ? { chunkIndex: detail.chunkIndex } : {}),
    ...(typeof detail.turn === 'number' ? { turn: detail.turn } : {}),
    retentionClass: detail.retentionClass ?? 'conversation',
    expiresAt: detail.expiresAt ?? 0,
    ...(detail.deletedAt ? { deletedAt: detail.deletedAt } : {}),
    availability: detail.deletedAt ? ['deleted'] : ['available'],
    provenance: detail.provenance ?? {},
    createdAt: detail.createdAt ?? 0,
    updatedAt: detail.updatedAt ?? detail.createdAt ?? 0,
  });

  const checkpointView = (checkpoint: FakeCheckpoint) => ({
    id: checkpoint.id,
    type: 'context_checkpoint' as const,
    kind: 'context_checkpoint' as const,
    domain: checkpoint.domain,
    namespace: checkpoint.domain,
    ownerType: ownerOf(checkpoint.domain).ownerType,
    ownerId: ownerOf(checkpoint.domain).ownerId,
    internal: true,
    agentId: checkpoint.agentId,
    threadId: checkpoint.threadId,
    revision: checkpoint.revision,
    state: checkpoint.state,
    summary: checkpoint.summary,
    recordIds: checkpoint.recordIds,
    lease: checkpoint.lease,
    expiresAt: checkpoint.expiresAt,
    provenance: checkpoint.provenance ?? {},
    createdAt: checkpoint.createdAt ?? 0,
    updatedAt: checkpoint.updatedAt ?? checkpoint.createdAt ?? 0,
  });

  const actorCanTouchAgent = (actor: any, agentId: string): boolean => actor?.type === 'user'
    || actor?.type === 'system'
    || (actor?.type === 'agent' && actor.agentId === agentId);

  const server: Server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const request: FakeCapabilityRequest = {
        method: req.method ?? 'GET',
        path: url.pathname,
        headers: req.headers,
        body: text.length > 0 ? JSON.parse(text) as unknown : null,
      };
      requests.push(request);
      if (request.path === '/internal/memory/v1/write') writeRequests.push(request);
      if (request.path === '/internal/memory/v1/detail') detailRequests.push(request);

      if (failure && request.path !== '/internal/memory/v1/version') {
        res.statusCode = failure.status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(errorEnvelope(failure.code, 'fake failure', failure.retryable === true)));
        return;
      }
      if (detailFailure && request.path === '/internal/memory/v1/detail') {
        res.statusCode = detailFailure.status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(errorEnvelope(
          detailFailure.code,
          'fake detail failure',
          detailFailure.retryable === true,
        )));
        return;
      }

      if (request.path === '/internal/memory/v1/version') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(envelope({
          capabilityApiVersion: 1,
          schemaVersion: 1,
          mcpVersion: '0.3.1',
          coreVersion: '0.3.1',
          features: { details: true },
          limits: {},
        })));
        return;
      }

      if (request.path === '/internal/memory/v1/namespaces') {
        const domains = new Map<string, number>();
        for (const node of nodes) domains.set(node.domain, (domains.get(node.domain) ?? 0) + 1);
        for (const record of records) domains.set(record.domain, (domains.get(record.domain) ?? 0) + 1);
        for (const compact of compacts) domains.set(compact.domain, (domains.get(compact.domain) ?? 0) + 1);
        domains.set('user', domains.get('user') ?? 0);
        domains.set('default', domains.get('default') ?? 0);
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(envelope({
          subscriptions: { mode: 'all', namespaces: [] },
          domains: [...domains.entries()].map(([domain, count]) => ({
            domain,
            ownerType: ownerOf(domain).ownerType,
            ownerId: ownerOf(domain).ownerId,
            namespace: domain,
            count,
            memoryRecords: count,
            internalObjects: 0,
            subscribed: true,
            lastUpdatedAt: 0,
          })),
          legacyNamespaces: [],
          policyDomain: '__policy__',
        })));
        return;
      }

      if (request.path === '/internal/memory/v1/query') {
        const body = request.body as any;
        let result = recordList(body);
        if (filterQuery && typeof body?.query === 'string') {
          result = result.filter((record) => recordMatchesQuery(record, body.query));
        }
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(envelope({
          records: result,
          total: result.length,
          offset: 0,
          limit: result.length,
          hasMore: false,
          tookMs: 1,
          usedDomains: domainsOf(body) ?? [],
        })));
        return;
      }

      if (request.path === '/internal/memory/v1/search') {
        const body = request.body as any;
        let result = recordList(body);
        if (filterQuery && typeof body?.query === 'string') {
          result = result.filter((record) => recordMatchesQuery(record, body.query));
        }
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(envelope({
          records: result,
          relations: [],
          total: result.length,
          tookMs: 1,
        })));
        return;
      }

      if (request.path === '/internal/memory/v1/history') {
        const body = request.body as any;
        let episodes = recordList(body).filter((record) => record.type === 'episode' || record.kind === 'episode');
        if (filterQuery && typeof body?.topic === 'string' && body.topic.length > 0) {
          episodes = episodes.filter((record) => recordMatchesQuery(record, body.topic));
        }
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(envelope({
          episodes,
          total: episodes.length,
          offset: 0,
          limit: episodes.length,
          hasMore: false,
        })));
        return;
      }

      if (request.path === '/internal/memory/v1/profile') {
        const body = request.body as any;
        const preferences = recordList(body)
          .filter((record) => record.kind === 'preference')
          .map((record) => ({
            id: record.id,
            type: record.content?.preferenceType ?? 'preference',
            value: record.content?.value ?? '',
            confidence: record.content?.confidence ?? 0.8,
            validFrom: record.validFrom ?? null,
            validTo: record.validTo ?? null,
            domain: record.domain,
            ownerType: record.ownerType,
            ownerId: record.ownerId,
            provenance: record.provenance,
            legacy: record.legacy === true,
          }));
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(envelope({
          userId: 'u_test',
          preferences,
          properties: {},
          legacyCount: preferences.filter((entry) => entry.legacy).length,
          updatedAt: 0,
        })));
        return;
      }

      if (request.path === '/internal/memory/v1/skills') {
        const body = request.body as any;
        let skillRecords = recordList(body)
          .filter((record) => record.kind === 'skill' || record.type === 'skill');
        if (filterQuery && typeof body?.search === 'string' && body.search.length > 0) {
          skillRecords = skillRecords.filter((record) => recordMatchesQuery(record, body.search));
        }
        const skills = skillRecords
          .map((record) => ({
            id: record.id,
            name: record.content?.name ?? record.text ?? '',
            description: record.content?.description ?? '',
            category: record.content?.category ?? '',
            steps: record.content?.steps ?? [],
            commands: record.content?.commands ?? [],
            domain: record.domain,
            ownerType: record.ownerType,
            ownerId: record.ownerId,
            provenance: record.provenance,
            detailAvailable: record.detailAvailable !== false,
          }));
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(envelope({
          skills,
          total: skills.length,
          usedDomains: domainsOf(body) ?? [],
        })));
        return;
      }

      if (request.path === '/internal/memory/v1/graph') {
        const body = request.body as any;
        const start = records.find((record) => record.id === body?.startId);
        if (!start) {
          res.statusCode = 404;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(errorEnvelope('not_found', 'start not found', false)));
          return;
        }
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(envelope({
          start: recordList({ domains: [start.domain] }).find((record) => record.id === start.id),
          nodes: [],
          edges: [],
          truncated: false,
        })));
        return;
      }

      if (request.path === '/internal/memory/v1/internal-object') {
        const body = request.body as any;
        const actor = body?.actor;
        const send = (status: number, payload: unknown) => {
          res.statusCode = status;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(payload));
        };
        const fail = (status: number, code: string, message: string, details?: unknown, retryable = false) => {
          send(status, errorEnvelope(code, message, retryable, details));
        };
        if (body?.sync !== undefined || body?.['self.sync'] !== undefined || body?.['checkpoint.sync'] !== undefined) {
          fail(400, 'legacy_sync_unsupported', '不再支持 sync/self.sync/checkpoint.sync');
          return;
        }

        if (body?.kind === 'compact') {
          const op = body.op;
          if (op === 'list') {
            const staleOnly = body.stale === true;
            const objects = compacts
              .filter((compact) => inDomains(compact.domain, domainsOf(body)))
              .map(compactView)
              .filter((compact) => !staleOnly || compact.stale);
            send(200, envelope({ objects, total: objects.length, replayed: false }));
            return;
          }
          if (op === 'get') {
            const compact = compacts.find((entry) => entry.id === body.id);
            if (!compact) {
              fail(404, 'not_found', 'compact 不存在');
              return;
            }
            send(200, envelope({ object: compactView(compact), replayed: false }));
            return;
          }
          if (op === 'delete') {
            if (actor?.type !== 'user' && actor?.type !== 'system') {
              fail(403, 'forbidden_scope', '删除 compact 需要 user/system 权限');
              return;
            }
            const index = compacts.findIndex((entry) => entry.id === body.id);
            if (index < 0) {
              fail(404, 'not_found', 'compact 不存在');
              return;
            }
            compacts.splice(index, 1);
            send(200, envelope({ deleted: true, id: body.id, replayed: false }));
            return;
          }
          if (op !== 'upsert') {
            fail(400, 'internal_kind_invalid', 'compact op 非法');
            return;
          }
          if (typeof body.domain !== 'string' || body.domain.length === 0) {
            fail(400, 'domain_invalid', 'compact 需要 domain');
            return;
          }
          if (actor?.type === 'agent' && body.domain.startsWith('agent:')
            && body.domain !== `agent:${actor.agentId}`) {
            fail(403, 'domain_write_forbidden', 'Agent 不能写入其他 Agent 域');
            return;
          }
          const sourceIds = Array.isArray(body.sourceIds) ? body.sourceIds.filter((id: unknown) => typeof id === 'string') : [];
          if (sourceIds.length === 0) {
            fail(400, 'invalid_request', 'sourceIds 不能为空');
            return;
          }
          const sources: FakeMemoryRecord[] = [];
          for (const sourceId of sourceIds) {
            const source = records.find((record) => record.id === sourceId);
            if (!source) {
              fail(404, 'not_found', 'compact source 不存在', { id: sourceId });
              return;
            }
            if (source.domain !== body.domain) {
              fail(400, 'domain_mismatch', 'compact 与 source 必须同域', {
                domain: body.domain,
                sourceId,
                sourceDomain: source.domain,
              });
              return;
            }
            sources.push(source);
          }
          const sourceHashes = Array.isArray(body.sourceHashes) && body.sourceHashes.length > 0
            ? body.sourceHashes.filter((hash: unknown) => typeof hash === 'string')
            : sources.map((source) => canonicalHash(source.content ?? {}));
          if (sourceHashes.length !== sourceIds.length) {
            fail(400, 'invalid_request', 'sourceHashes 必须与 sourceIds 等长');
            return;
          }
          const strategy = body.strategy === 'dedupe' ? 'dedupe' : 'summary';
          const identityKey = sha256({
            domain: body.domain,
            strategy,
            sourceIds: [...sourceIds].sort(),
            sourceHashes,
          });
          const existing = compacts.find((compact) => compact.identityKey === identityKey);
          if (existing) {
            send(200, envelope({ object: compactView(existing), replayed: false }));
            return;
          }
          counter += 1;
          const createdAt = Date.now();
          const compact: FakeCompact = {
            id: `01FAKEC${String(counter).padStart(4, '0')}`,
            type: 'compact',
            kind: 'compact',
            domain: body.domain,
            summary: String(body.summary ?? ''),
            sourceIds,
            sourceHashes,
            strategy,
            tokenCount: typeof body.tokenCount === 'number' ? body.tokenCount : null,
            provenance: isObjectLike(body.provenance) ? body.provenance : {},
            createdAt,
            updatedAt: createdAt,
            identityKey,
          };
          compacts.push(compact);
          send(200, envelope({ object: compactView(compact), replayed: false }));
          return;
        }

        if (body?.kind === 'self_record') {
          if (typeof body.agentId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(body.agentId)) {
            fail(400, 'invalid_agent_id', 'agentId 格式非法');
            return;
          }
          const agentId = body.agentId;
          if (!actorCanTouchAgent(actor, agentId)) {
            fail(403, 'forbidden_scope', '当前 actor 不能读写该 Agent 的内部对象');
            return;
          }
          const current = currentSelf(agentId);
          if (body.op === 'get') {
            send(200, envelope({ object: current ? selfView(current) : null, replayed: false }));
            return;
          }
          if (body.op !== 'upsert') {
            fail(400, 'internal_kind_invalid', 'self_record op 非法');
            return;
          }
          if (body.domain !== undefined && body.domain !== `agent:${agentId}`) {
            fail(400, 'domain_mismatch', 'SelfRecord 必须位于 agent:<agentId> 域');
            return;
          }
          const currentRevision = current?.revision ?? 0;
          if (body.expectedRevision !== undefined && body.expectedRevision !== currentRevision) {
            fail(409, 'revision_mismatch', 'SelfRecord revision 冲突', {
              agentId,
              currentRevision,
              expectedRevision: body.expectedRevision,
            }, true);
            return;
          }
          counter += 1;
          const createdAt = Date.now();
          const record = isObjectLike(body.record) ? body.record : {};
          const self: FakeSelfRecord = {
            id: `01FAKES${String(counter).padStart(4, '0')}`,
            domain: `agent:${agentId}`,
            agentId,
            revision: currentRevision + 1,
            content: record,
            provenance: {
              ...(isObjectLike(body.provenance) ? body.provenance : {}),
              writerType: actor?.type ?? 'unknown',
              writerId: actor?.agentId ?? (actor?.type === 'user' ? 'u_test' : 'system'),
              agentId,
            },
            createdAt,
            updatedAt: createdAt,
          };
          selfRecords.push(self);
          send(200, envelope({ object: selfView(self), conflict: null, replayed: false }));
          return;
        }

        if (body?.kind === 'context_checkpoint') {
          if (typeof body.agentId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(body.agentId)) {
            fail(400, 'invalid_agent_id', 'agentId 格式非法');
            return;
          }
          const agentId = body.agentId;
          if (!actorCanTouchAgent(actor, agentId)) {
            fail(403, 'forbidden_scope', '当前 actor 不能读写该 Agent 的内部对象');
            return;
          }
          if (body.op === 'get') {
            const threadId = body.threadId;
            const current = currentCheckpoint(agentId, threadId);
            const visible = current && !(current.expiresAt > 0 && current.expiresAt < Date.now()) ? current : null;
            send(200, envelope({ object: visible ? checkpointView(visible) : null, replayed: false }));
            return;
          }
          if (body.op === 'list') {
            const objects = checkpoints
              .filter((checkpoint) => checkpoint.agentId === agentId)
              .filter((checkpoint) => !body.threadId || checkpoint.threadId === body.threadId)
              .filter((checkpoint) => !(checkpoint.expiresAt > 0 && checkpoint.expiresAt < Date.now()))
              .sort((a, b) => b.revision - a.revision)
              .map(checkpointView);
            send(200, envelope({ objects, total: objects.length, replayed: false }));
            return;
          }
          if (body.op === 'delete') {
            if (actor?.type !== 'user' && actor?.type !== 'system') {
              fail(403, 'forbidden_scope', '删除 checkpoint 需要 user/system 权限');
              return;
            }
            const before = checkpoints.length;
            for (let index = checkpoints.length - 1; index >= 0; index -= 1) {
              const checkpoint = checkpoints[index]!;
              const matches = body.id
                ? checkpoint.id === body.id
                : checkpoint.agentId === agentId && checkpoint.threadId === body.threadId;
              if (matches) checkpoints.splice(index, 1);
            }
            send(200, envelope({ deleted: checkpoints.length < before, count: before - checkpoints.length, replayed: false }));
            return;
          }
          if (body.op !== 'upsert') {
            fail(400, 'internal_kind_invalid', 'context_checkpoint op 非法');
            return;
          }
          const threadId = body.threadId;
          if (typeof threadId !== 'string' || threadId.length === 0) {
            fail(400, 'invalid_thread_id', 'checkpoint 需要 threadId');
            return;
          }
          if (body.force === true && actor?.type === 'agent') {
            fail(403, 'forbidden_scope', 'force=true 仅允许 user/system');
            return;
          }
          const domain = body.domain ?? 'default';
          const validTask = typeof domain === 'string' && domain.startsWith('task:')
            && domain.slice('task:'.length) === threadId;
          if (domain !== 'default' && !validTask) {
            fail(400, 'domain_mismatch', 'Checkpoint 只能位于 task:<threadId> 或 default 域', {
              domain,
              threadId,
            });
            return;
          }
          const current = currentCheckpoint(agentId, threadId);
          const currentRevision = current?.revision ?? 0;
          if (body.expectedRevision !== undefined && body.expectedRevision !== currentRevision) {
            fail(409, 'revision_mismatch', 'checkpoint revision 冲突', {
              agentId,
              threadId,
              currentRevision,
              expectedRevision: body.expectedRevision,
            }, true);
            return;
          }
          if (current?.lease && current.lease.until > Date.now() && current.lease.hostId !== leaseHost) {
            if (body.force !== true) {
              fail(409, 'checkpoint_lease_held', 'checkpoint 租约被其他 host 持有', {
                hostId: current.lease.hostId,
                until: current.lease.until,
              }, true);
              return;
            }
            if (actor?.type !== 'user' && actor?.type !== 'system') {
              fail(403, 'forbidden_scope', '只有 user/system 可以抢占租约');
              return;
            }
          }
          const leaseMs = typeof body.leaseMs === 'number' && body.leaseMs > 0
            ? Math.min(body.leaseMs, 3_600_000)
            : 60_000;
          counter += 1;
          const createdAt = Date.now();
          const checkpoint: FakeCheckpoint = {
            id: `01FAKEP${String(counter).padStart(4, '0')}`,
            domain: String(domain),
            agentId,
            threadId,
            revision: currentRevision + 1,
            state: isObjectLike(body.state) ? body.state : {},
            summary: typeof body.summary === 'string' ? body.summary : null,
            recordIds: Array.isArray(body.recordIds) ? body.recordIds.filter((id: unknown) => typeof id === 'string') : [],
            lease: { hostId: leaseHost, until: createdAt + leaseMs },
            expiresAt: typeof body.expiresAt === 'number' ? body.expiresAt : 0,
            provenance: {
              ...(isObjectLike(body.provenance) ? body.provenance : {}),
              writerType: actor?.type ?? 'unknown',
              writerId: actor?.agentId ?? (actor?.type === 'user' ? 'u_test' : 'system'),
              threadId,
            },
            createdAt,
            updatedAt: createdAt,
          };
          checkpoints.push(checkpoint);
          send(200, envelope({ object: checkpointView(checkpoint), conflict: null, replayed: false }));
          return;
        }

        fail(400, 'internal_kind_invalid', 'kind 必须是 compact | self_record | context_checkpoint');
        return;
      }

      if (request.path === '/internal/memory/v1/detail') {
        const body = request.body as any;
        const op = body?.op;
        const actor = body?.actor;
        const send = (status: number, payload: unknown) => {
          res.statusCode = status;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(payload));
        };
        const fail = (status: number, code: string, message: string, details?: unknown, retryable = false) => {
          send(status, errorEnvelope(code, message, retryable, details));
        };
        const canReadDomain = (domain: string): boolean => {
          if (actor?.type !== 'agent') return true;
          if (!domain.startsWith('agent:')) return true;
          return domain === `agent:${actor.agentId}`;
        };

        if (op === 'write') {
          const items = Array.isArray(body?.items) ? body.items : [];
          if (items.length === 0 || items.length > 100) {
            fail(400, 'invalid_request', 'items 必须是 1–100 条');
            return;
          }
          const results = items.map((item: any) => {
            if (typeof item?.clientItemId !== 'string' || typeof item?.domain !== 'string') {
              return { clientItemId: item?.clientItemId, status: 'failed', code: 'validation_failed' };
            }
            const recordIds = Array.isArray(item.recordIds)
              ? item.recordIds.filter((id: unknown) => typeof id === 'string')
              : [];
            if (recordIds.length === 0) {
              return { clientItemId: item.clientItemId, status: 'failed', code: 'validation_failed' };
            }
            for (const recordId of recordIds) {
              const record = records.find((entry) => entry.id === recordId);
              const node = nodes.find((entry) => entry.id === recordId);
              const domain = record?.domain ?? node?.domain;
              if (!domain || domain !== item.domain) {
                return { clientItemId: item.clientItemId, status: 'failed', code: 'validation_failed' };
              }
            }
            const contentHash = typeof item.contentHash === 'string'
              ? item.contentHash
              : `sha256:${sha256(item.text ?? '')}`;
            const existing = details.find((detail) => detail.domain === item.domain
              && detail.detailKind === (item.detailKind ?? 'raw_chunk')
              && detail.contentHash === contentHash
              && (detail.chunkIndex ?? -1) === (item.chunkIndex ?? -1));
            if (existing) {
              return {
                clientItemId: item.clientItemId,
                status: 'duplicate',
                id: existing.id,
                domain: existing.domain,
                detailKind: existing.detailKind,
                contentHash: existing.contentHash,
                duplicate: true,
              };
            }
            counter += 1;
            const createdAt = Date.now();
            const detail: FakeDetail = {
              id: `01FAKED${String(counter).padStart(4, '0')}`,
              type: 'detail_record',
              kind: 'detail_record',
              detailKind: typeof item.detailKind === 'string' ? item.detailKind : 'raw_chunk',
              domain: item.domain,
              recordIds,
              role: item.role,
              text: String(item.text ?? ''),
              mime: item.mime,
              messageId: item.messageId,
              chunkIndex: item.chunkIndex,
              turn: item.turn,
              contentHash,
              redaction: isObjectLike(item.redaction) ? item.redaction : { applied: false, rules: [] },
              retentionClass: item.retentionClass,
              expiresAt: typeof item.expiresAt === 'number' ? item.expiresAt : 0,
              metadata: { internal: true },
              provenance: isObjectLike(item.provenance) ? item.provenance : {},
              createdAt,
              updatedAt: createdAt,
            };
            details.push(detail);
            return {
              clientItemId: item.clientItemId,
              status: 'created',
              id: detail.id,
              domain: detail.domain,
              detailKind: detail.detailKind,
              contentHash: detail.contentHash,
            };
          });
          send(200, envelope({
            results,
            created: results.filter((result: any) => result.status === 'created').length,
            duplicates: results.filter((result: any) => result.status === 'duplicate').length,
            failed: results.filter((result: any) => result.status === 'failed').length,
            partial: results.some((result: any) => result.status === 'failed'),
          }));
          return;
        }

        if (op === 'get') {
          const detail = details.find((entry) => entry.id === body?.id);
          if (!detail) {
            fail(404, 'not_found', '详情不存在');
            return;
          }
          if (!canReadDomain(detail.domain)) {
            fail(403, 'domain_read_forbidden', '不能读取其他 Agent 域的详情');
            return;
          }
          if (detail.deletedAt) {
            fail(410, 'detail_deleted', '详情已删除');
            return;
          }
          if (typeof detail.expiresAt === 'number' && detail.expiresAt > 0 && detail.expiresAt < Date.now()) {
            fail(410, 'detail_expired', '详情已过期');
            return;
          }
          send(200, envelope({ detail: detailView(detail, body?.includeText !== false) }));
          return;
        }

        if (op === 'list') {
          const domains = Array.isArray(body?.domains) ? body.domains : null;
          const recordIds = Array.isArray(body?.recordIds) ? new Set(body.recordIds) : null;
          const detailKinds = Array.isArray(body?.detailKinds) ? new Set(body.detailKinds) : null;
          const listed = details
            .filter((detail) => !domains || domains.includes(detail.domain))
            .filter((detail) => !body?.threadId || detail.provenance?.threadId === body.threadId)
            .filter((detail) => !recordIds || detail.recordIds.some((id) => recordIds.has(id)))
            .filter((detail) => !detailKinds || detailKinds.has(detail.detailKind))
            .filter((detail) => !detail.deletedAt)
            .slice(0, typeof body?.limit === 'number' ? body.limit : 20)
            .map((detail) => detailView(detail, body?.includeText === true));
          send(200, envelope({ details: listed, total: listed.length, offset: 0, limit: listed.length, hasMore: false }));
          return;
        }

        if (op === 'delete') {
          const ids = Array.isArray(body?.ids) ? body.ids.filter((id: unknown) => typeof id === 'string') : [];
          const deleted: string[] = [];
          const notFound: string[] = [];
          const forbidden: string[] = [];
          for (const id of ids) {
            const detail = details.find((entry) => entry.id === id);
            if (!detail) {
              notFound.push(id);
              continue;
            }
            if (actor?.type === 'agent') {
              if (detail.domain !== `agent:${actor.agentId}`
                || detail.provenance?.agentId !== actor.agentId) {
                forbidden.push(id);
                continue;
              }
            } else if (actor?.type !== 'user' && actor?.type !== 'system') {
              forbidden.push(id);
              continue;
            }
            detail.deletedAt = Date.now();
            detail.metadata = { ...(detail.metadata ?? {}), deletedReason: body?.reason ?? 'user_requested' };
            deleted.push(id);
          }
          send(200, envelope({ deleted, notFound, forbidden, partial: notFound.length + forbidden.length > 0 }));
          return;
        }

        fail(400, 'invalid_request', 'detail op 必须是 write/get/list/delete');
        return;
      }

      if (request.path === '/internal/memory/v1/write') {
        const body = request.body as any;
        const items = Array.isArray(body?.items) ? body.items : [];
        const results = items.map((item: any) => {
          const owner = ownerOf(String(item.domain));
          const contentHash = sha256({ kind: item.kind, content: item.content });
          const existing = nodes.find((node) => node.clientItemId === item.clientItemId
            || (node.domain === item.domain && node.contentHash === contentHash));
          if (existing) {
            return {
              ...(item.clientItemId ? { clientItemId: item.clientItemId } : {}),
              status: 'duplicate',
              id: existing.id,
              type: existing.type,
              kind: existing.kind,
              domain: existing.domain,
              ownerType: owner.ownerType,
              ownerId: owner.ownerId,
              duplicate: true,
            };
          }
          counter += 1;
          const node: FakeNode = {
            id: `01FAKE${String(counter).padStart(4, '0')}`,
            type: typeOf(String(item.kind)),
            kind: String(item.kind),
            domain: String(item.domain),
            ownerType: owner.ownerType,
            ownerId: owner.ownerId,
            contentHash,
            clientItemId: typeof item.clientItemId === 'string' ? item.clientItemId : undefined,
            content: item.content,
            provenance: {
              ...(item.provenance ?? {}),
              agentId: body?.actor?.agentId ?? null,
            },
          };
          nodes.push(node);
          return {
            ...(item.clientItemId ? { clientItemId: item.clientItemId } : {}),
            status: 'created',
            id: node.id,
            type: node.type,
            kind: node.kind,
            domain: node.domain,
            ownerType: owner.ownerType,
            ownerId: owner.ownerId,
          };
        });
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(envelope({
          results,
          created: results.filter((result: any) => result.status === 'created').length,
          duplicates: results.filter((result: any) => result.status === 'duplicate').length,
          failed: 0,
          partial: false,
          replayed: false,
        })));
        return;
      }

      res.statusCode = 404;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(errorEnvelope('not_found', 'not found', false)));
    })().catch(() => {
      if (!res.writableEnded) {
        res.statusCode = 500;
        res.end(JSON.stringify(errorEnvelope('internal', 'fake error', true)));
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}/internal/memory/v1`,
    requests,
    writeRequests,
    detailRequests,
    nodes,
    get records() { return records; },
    get compacts() { return compacts; },
    selfRecords,
    checkpoints,
    get details() { return details; },
    setRecords: (next) => { records = next; },
    setCompacts: (next) => { compacts = next; },
    setDetails: (next) => { details = next; },
    setCheckpointLeaseHost: (hostId) => { leaseHost = hostId; },
    setFailure: (next) => {
      failure = next;
    },
    setDetailFailure: (next) => {
      detailFailure = next;
    },
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
  };
}
