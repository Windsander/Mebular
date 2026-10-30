// fake MCP Memory Capability API（只用于 sidecar 沉降测试）。
//
// 不启动真实 MCP/core；只实现 /write 与 /namespaces，记录请求，
// 并按内存内容去重，足以验证幂等、域路由、provenance、outbox 重放。

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
  nodes: FakeNode[];
  records: FakeMemoryRecord[];
  compacts: FakeCompact[];
  setRecords: (records: FakeMemoryRecord[]) => void;
  setCompacts: (compacts: FakeCompact[]) => void;
  setFailure: (failure: { status: number; code: string; retryable?: boolean } | null) => void;
  close: () => Promise<void>;
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
  stale?: boolean;
  provenance?: Record<string, unknown>;
  createdAt?: number | null;
  updatedAt?: number | null;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
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

function errorEnvelope(code: string, message: string, retryable: boolean) {
  return {
    ok: false,
    requestId: 'req_fake',
    capabilityVersion: 1,
    error: { code, message, retryable: Boolean(retryable) },
  };
}

export async function startFakeCapability(): Promise<FakeCapabilityServer> {
  const requests: FakeCapabilityRequest[] = [];
  const writeRequests: FakeCapabilityRequest[] = [];
  const nodes: FakeNode[] = [];
  let records: FakeMemoryRecord[] = [];
  let compacts: FakeCompact[] = [];
  let failure: { status: number; code: string; retryable?: boolean } | null = null;
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

      if (failure && request.path !== '/internal/memory/v1/version') {
        res.statusCode = failure.status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(errorEnvelope(failure.code, 'fake failure', failure.retryable === true)));
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
          features: {},
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
        const result = recordList(body);
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
        const result = recordList(body);
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
        const episodes = recordList(body).filter((record) => record.type === 'episode' || record.kind === 'episode');
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
        const skills = recordList(body)
          .filter((record) => record.kind === 'skill' || record.type === 'skill')
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
        if (body?.kind === 'compact' && body?.op === 'list') {
          const objects = compacts
            .filter((compact) => inDomains(compact.domain, domainsOf(body)))
            .map((compact) => ({
              ...compact,
              type: 'compact' as const,
              kind: 'compact' as const,
              namespace: compact.domain,
              ownerType: compact.ownerType ?? ownerOf(compact.domain).ownerType,
              ownerId: compact.ownerId ?? ownerOf(compact.domain).ownerId,
              internal: true,
              sourceIds: compact.sourceIds ?? [],
              sourceHashes: compact.sourceHashes ?? [],
              strategy: 'summary',
              stale: compact.stale === true,
              provenance: compact.provenance ?? {},
              createdAt: compact.createdAt ?? 0,
              updatedAt: compact.updatedAt ?? compact.createdAt ?? 0,
            }));
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(envelope({ objects, total: objects.length, replayed: false })));
          return;
        }
        res.statusCode = 404;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(errorEnvelope('not_found', 'internal object not found', false)));
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
    nodes,
    get records() { return records; },
    get compacts() { return compacts; },
    setRecords: (next) => { records = next; },
    setCompacts: (next) => { compacts = next; },
    setFailure: (next) => {
      failure = next;
    },
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
  };
}
