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
  setFailure: (failure: { status: number; code: string; retryable?: boolean } | null) => void;
  close: () => Promise<void>;
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
  let failure: { status: number; code: string; retryable?: boolean } | null = null;
  let counter = 0;

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
    setFailure: (next) => {
      failure = next;
    },
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
  };
}
