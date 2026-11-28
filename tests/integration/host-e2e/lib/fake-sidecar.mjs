// Deterministic fake of the Mebular Memory Runtime sidecar host API.
//
// It exists so host E2E tests can exercise discovery, host-token auth, the
// `/memory-runtime/v1/context` injection contract, ingest idempotency and
// checkpoint PUT without requiring a live MCP capability API. The real
// OpenCode process still loads the real @mebular/opencode-plugin and talks to
// this loopback server over HTTP.

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';

function sha256(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim().length === 0) return resolve(null);
      try {
        resolve(JSON.parse(text));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

function envelope(data, warnings = [], degraded = false) {
  return {
    ok: true,
    requestId: `req_${randomUUID()}`,
    apiVersion: 1,
    data,
    warnings,
    degraded,
  };
}

function errorEnvelope(code, message, retryable = false) {
  return {
    ok: false,
    requestId: `req_${randomUUID()}`,
    apiVersion: 1,
    error: { code, message, retryable },
  };
}

function tokenMatches(header, token) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  return header.slice('Bearer '.length).trim() === token;
}

/**
 * @param {{ home: string, token?: string, seedText?: string, seedToken?: string }} options
 */
export async function startFakeSidecar(options = {}) {
  const home = options.home;
  if (!home) throw new Error('fake sidecar requires a home directory');
  const token = options.token ?? `host-token-${randomUUID()}`;
  const seedToken = options.seedToken ?? `seed-${randomUUID()}`;
  const seedText = options.seedText ?? `Remember ${seedToken} for the theme`;
  await mkdir(join(home, 'memory-runtime'), { recursive: true });
  const tokenFile = join(home, 'memory-runtime', 'host-token');
  await writeFile(tokenFile, token, { mode: 0o600 });

  const state = {
    requests: [],
    ingested: [],
    checkpoints: new Map(),
    token,
    tokenFile,
    seedToken,
    seedText,
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    const auth = req.headers.authorization === undefined
      ? 'missing'
      : tokenMatches(req.headers.authorization, token) ? 'bearer' : 'other';
    let body = null;
    try {
      body = await readBody(req);
    } catch {
      send(res, 400, errorEnvelope('invalid_request', 'invalid JSON'));
      return;
    }
    const record = { method, path, body, auth, at: Date.now() };
    state.requests.push(record);

    if (path === '/memory-runtime/v1/health') {
      send(res, 200, {
        ok: true,
        apiVersion: 1,
        state: 'ready',
        ready: true,
        degraded: false,
        runtimeVersion: '0.3.0',
        capabilityApiVersion: 1,
      });
      return;
    }

    if (!path.startsWith('/memory-runtime/v1/')) {
      send(res, 404, errorEnvelope('not_found', 'unknown path'));
      return;
    }
    if (auth !== 'bearer') {
      send(res, 401, errorEnvelope('unauthorized', 'host token required'));
      return;
    }

    if (path === '/memory-runtime/v1/version') {
      send(res, 200, envelope({
        runtimeVersion: '0.3.0',
        apiVersion: 1,
        capabilityApiVersion: 1,
        minMcpVersion: '0.3.0',
        maxMcpVersion: '0.3.x',
        capabilities: {
          ingest: true,
          recall: true,
          context: true,
          feedback: true,
          traces: true,
          checkpoint: true,
          compact: true,
          self: true,
          models: ['heuristic', 'host'],
        },
      }));
      return;
    }

    if (path === '/memory-runtime/v1/status') {
      send(res, 200, envelope({
        runtimeVersion: '0.3.0',
        mode: 'immersive',
        state: 'ready',
        degraded: false,
        identity: { profileId: 'host-e2e', cloudId: null },
        capabilities: {
          ingest: true,
          recall: true,
          context: true,
          checkpoint: true,
          compact: true,
          self: true,
          models: ['heuristic', 'host'],
        },
        auth: { mode: 'bearer' },
      }));
      return;
    }

    if (path === '/memory-runtime/v1/context') {
      const query = String(body?.query ?? '');
      const hit = query.includes(seedToken);
      const blocks = hit
        ? [{
          kind: 'fragment',
          content: `[F1] kind=fact owner=user domain=user confidence=0.90 time=unknown citation=01JFAKE\nprovenance=mcp;agent=opencode\ngist: ${seedText}`,
          citations: [{ id: '01JFAKE', type: 'fact' }],
          fragments: ['mf_fake_1'],
          trust: 'untrusted',
        }]
        : [];
      send(res, 200, envelope({
        recallId: `rr_${sha256(query).slice(0, 16)}`,
        fragments: blocks.length > 0
          ? [{
            id: 'mf_fake_1',
            kind: 'fact',
            gist: seedText,
            owner: { role: 'user', domain: 'user' },
            confidence: 0.9,
            citations: [{ id: '01JFAKE', type: 'fact' }],
            trust: 'untrusted',
          }]
          : [],
        blocks,
        citations: blocks.length > 0 ? [{ id: '01JFAKE', type: 'fact' }] : [],
        estimatedTokens: 20,
        estimatedBytes: blocks[0]?.content.length ?? 0,
        truncated: false,
        degraded: false,
        warnings: [],
        silenceReason: blocks.length > 0 ? null : 'no_hits',
        traceId: 'tr_fake',
        timing: { cueMs: 0, fuzzyMs: 0, expandMs: 0, assembleMs: 0, totalMs: 1 },
      }));
      return;
    }

    if (path === '/memory-runtime/v1/ingest') {
      const chunks = Array.isArray(body?.chunks) ? body.chunks : [];
      state.ingested.push({ body, chunks });
      const duplicate = state.ingested.filter((entry) => entry.body?.requestId === body?.requestId).length > 1;
      send(res, 200, envelope({
        accepted: { chunks: chunks.length, records: duplicate ? 0 : 1 },
        rawChunkIds: chunks.map((chunk) => `rc_${sha256(`${body?.requestId}:${chunk.text}`).slice(0, 16)}`),
        records: duplicate ? [] : [{ id: '01JRUNTIME', type: 'fact' }],
        extraction: { id: 'ext_fake', status: 'completed', extractor: body?.extractor ?? 'heuristic', records: [], warnings: [] },
        duplicate,
        warnings: [],
      }));
      return;
    }

    if (path.startsWith('/memory-runtime/v1/checkpoints/')) {
      const threadId = decodeURIComponent(path.slice('/memory-runtime/v1/checkpoints/'.length));
      if (method === 'GET') {
        const checkpoint = state.checkpoints.get(threadId) ?? null;
        send(res, 200, envelope({ checkpoint }));
        return;
      }
      if (method === 'PUT') {
        const previous = state.checkpoints.get(threadId);
        const expected = body?.expectedRevision;
        if (Number.isInteger(expected) && previous && expected !== previous.revision) {
          send(res, 409, errorEnvelope('revision_mismatch', 'revision mismatch'));
          return;
        }
        const checkpoint = {
          threadId,
          agentId: body?.agentId,
          domain: body?.domain,
          summary: body?.summary ?? null,
          state: body?.state ?? {},
          recordIds: body?.recordIds ?? [],
          revision: (previous?.revision ?? 0) + 1,
          updatedAt: Date.now(),
        };
        state.checkpoints.set(threadId, checkpoint);
        send(res, 200, envelope({ checkpoint, source: 'cloud', degraded: false }));
        return;
      }
      send(res, 405, errorEnvelope('method_not_allowed', 'checkpoints GET/PUT only'));
      return;
    }

    send(res, 404, errorEnvelope('not_found', 'unknown path'));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/memory-runtime/v1`;
  const updatedAt = Date.now();
  const discovery = {
    schema: 1,
    kind: 'mebular-memory-runtime',
    pid: process.pid,
    host: '127.0.0.1',
    port,
    url,
    healthUrl: `${url}/health`,
    cloudId: null,
    profileId: 'host-e2e',
    runtimeVersion: '0.3.0',
    apiVersion: 1,
    capabilityApiVersion: 1,
    minMcpVersion: '0.3.0',
    maxMcpVersion: '0.3.x',
    state: 'ready',
    degraded: false,
    tokenFile,
    startedAt: updatedAt,
    updatedAt,
    capabilities: {
      ingest: true,
      recall: true,
      context: true,
      checkpoint: true,
      compact: true,
      self: true,
      models: ['heuristic', 'host'],
    },
  };
  const discoveryPath = join(home, 'memory-runtime.json');
  await writeFile(discoveryPath, JSON.stringify(discovery, null, 2), { mode: 0o600 });
  const heartbeat = setInterval(() => {
    const next = { ...discovery, updatedAt: Date.now() };
    writeFile(discoveryPath, JSON.stringify(next, null, 2), { mode: 0o600 }).catch(() => undefined);
  }, 5000);
  heartbeat.unref?.();

  return {
    url,
    home,
    token,
    tokenFile,
    discoveryPath,
    seedToken,
    seedText,
    state,
    runtimeRequests: () => [...state.requests],
    checkpoint: (threadId) => state.checkpoints.get(threadId) ?? null,
    async close() {
      clearInterval(heartbeat);
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
