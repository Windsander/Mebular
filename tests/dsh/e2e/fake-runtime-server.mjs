// Test-only Mebular Memory Runtime sidecar stand-in.
//
// It implements just enough of the `/memory-runtime/v1` host surface for the
// DSH memory runtime adapter and the real DSH E2E harness:
//   GET  /health
//   GET  /status
//   POST /context
//   POST /recall
//   POST /ingest
//   PUT  /checkpoints/:threadId
//   GET  /app/embed/info (MCP daemon surface, kept for the bridge)
//
// It never calls a model, never touches the Mebular home directory and never
// stores the raw bearer token. Tests assert on `state.requests`, which only
// records how a request was authenticated (`missing` / `bearer` / `wrong`).

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

const MAX_BODY_BYTES = 2 * 1024 * 1024;

function hash(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 16);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('payload too large'), { code: 'payload_too_large' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJson(buffer) {
  if (buffer.length === 0) return null;
  try {
    return JSON.parse(buffer.toString('utf-8'));
  } catch {
    return null;
  }
}

function sendJson(res, status, body, requestId) {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('content-length', Buffer.byteLength(text));
  if (requestId) res.setHeader('x-request-id', requestId);
  res.end(text);
}

function envelope(requestId, data, warnings = []) {
  return { ok: true, requestId, data, warnings };
}

function failure(requestId, code, message, retryable = false) {
  return { ok: false, requestId, error: { code, message, retryable } };
}

/**
 * Start a fake Memory Runtime sidecar on an ephemeral loopback port.
 *
 * @param {{
 *   auth?: 'none' | 'bearer',
 *   token?: string,
 *   records?: Array<Record<string, unknown>>,
 *   fragments?: Array<Record<string, unknown>>,
 *   recallDelayMs?: number,
 *   ingestFailTimes?: number,
 *   ingestFailureStatus?: number,
 *   ingestFailureCode?: string,
 *   ingestDelayMs?: number,
 *   checkpointFailTimes?: number,
 * }} [options]
 */
export async function createFakeRuntime(options = {}) {
  const opts = options ?? {};
  const authMode = opts.auth === 'bearer' ? 'bearer' : 'none';
  const token = typeof opts.token === 'string' ? opts.token : '';
  const state = {
    startedAt: new Date().toISOString(),
    authMode,
    requests: [],
    recalls: [],
    contexts: [],
    ingests: [],
    checkpoints: [],
    ingestAttempts: 0,
    ingestFailureCount: 0,
    ingestDuplicates: 0,
    recallCount: 0,
    contextCount: 0,
    unauthorized: 0,
    maxBodyBytes: MAX_BODY_BYTES,
  };
  const idempotentIngest = new Map();
  const idempotentCheckpoint = new Map();

  function classifyAuth(req) {
    const header = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
    if (header.length === 0) return 'missing';
    if (!header.startsWith('Bearer ')) return 'wrong';
    if (authMode !== 'bearer') return 'bearer';
    return header.slice('Bearer '.length) === token ? 'bearer' : 'wrong';
  }

  function authorize(req, res, requestId) {
    const classification = classifyAuth(req);
    if (authMode === 'none' || classification === 'bearer') return true;
    state.unauthorized += 1;
    res.setHeader('www-authenticate', 'Bearer');
    sendJson(res, 401, failure(requestId, 'unauthorized', 'missing or invalid bearer token'), requestId);
    return false;
  }

  function requestIdOf(req, body) {
    const valid = /^[A-Za-z0-9._:-]{1,128}$/;
    const incoming = req.headers['x-request-id'];
    if (typeof incoming === 'string' && valid.test(incoming)) return incoming;
    if (typeof body?.requestId === 'string' && valid.test(body.requestId)) {
      return body.requestId;
    }
    return `fake_${hash(`${req.method}:${req.url}:${Date.now()}:${Math.random()}`)}`;
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    let bodyBuffer = Buffer.alloc(0);
    try {
      bodyBuffer = await readBody(req);
    } catch (error) {
      if (error?.code === 'payload_too_large') {
        sendJson(res, 413, failure('fake', 'payload_too_large', 'request body too large'));
        return;
      }
      sendJson(res, 400, failure('fake', 'bad_request', 'could not read request body'));
      return;
    }
    const body = parseJson(bodyBuffer);
    const requestId = requestIdOf(req, body);
    const auth = classifyAuth(req);
    const record = {
      at: new Date().toISOString(),
      method: req.method ?? 'GET',
      path,
      requestId,
      auth,
      authorized: authMode === 'none' || auth === 'bearer',
      idempotencyKey: typeof req.headers['idempotency-key'] === 'string'
        ? req.headers['idempotency-key']
        : null,
      body,
    };
    state.requests.push(record);

    if (path === '/healthz') {
      sendJson(res, 200, { status: 'ok', version: '0.3.0-fake-runtime', auth: authMode }, requestId);
      return;
    }
    if (path === '/__state') {
      // Test-only observation endpoint. It never returns the configured token;
      // requests only record whether auth was missing/valid/wrong.
      sendJson(res, 200, state, requestId);
      return;
    }
    if (path === '/health') {
      sendJson(res, 200, {
        ok: true,
        ready: true,
        state: 'ready',
        runtimeVersion: '0.3.0-fake-runtime',
        apiVersion: 1,
        capabilityApiVersion: 1,
        degraded: false,
      }, requestId);
      return;
    }
    if (path === '/app/embed/info') {
      const origin = `http://127.0.0.1:${server.address().port}`;
      sendJson(res, 200, {
        ok: true,
        version: '0.3.0-fake-runtime',
        loopback: true,
        embedProtocol: 1,
        capabilities: { embedConsole: true },
        consoleUrl: `${origin}/console`,
        embedUrl: `${origin}/console/?embed=dsh`,
        mcpUrl: `${origin}/mcp`,
      }, requestId);
      return;
    }
    if (path === '/mcp') {
      sendJson(res, 404, failure(requestId, 'not_found', 'fake runtime has no MCP endpoint'), requestId);
      return;
    }
    if (!path.startsWith('/memory-runtime/v1')) {
      sendJson(res, 404, failure(requestId, 'not_found', 'unknown path'), requestId);
      return;
    }
    if (!authorize(req, res, requestId)) return;

    if (path === '/memory-runtime/v1/status' && req.method === 'GET') {
      sendJson(res, 200, envelope(requestId, { mode: 'immersive', apiVersion: 1, auth: { mode: authMode } }), requestId);
      return;
    }

    if (path === '/memory-runtime/v1/context' && req.method === 'POST') {
      state.contextCount += 1;
      if (Number.isFinite(opts.recallDelayMs) && opts.recallDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, opts.recallDelayMs));
      }
      const records = Array.isArray(opts.records) ? opts.records : [];
      const fragments = Array.isArray(opts.fragments)
        ? opts.fragments
        : records.map((record, index) => ({
          id: `mf_${record?.id ?? index}`,
          kind: record?.type ?? 'fact',
          gist: typeof record?.content === 'string' ? record.content : '',
          owner: { role: 'agent', domain: 'agent:dsh', agentId: 'dsh', agentName: 'DSH' },
          confidence: 0.9,
          time: { at: Date.now(), precision: 'exact' },
          citations: [{ id: record?.id ?? `record-${index}`, type: record?.type ?? 'fact' }],
          hasDetail: false,
          trust: 'untrusted',
        }));
      state.contexts.push({
        requestId,
        query: body?.query ?? null,
        agentId: body?.agentId ?? null,
        threadId: body?.threadId ?? null,
        turnId: body?.turnId ?? null,
        turnKind: body?.turnKind ?? null,
        domains: Array.isArray(body?.domains) ? body.domains : [],
        maxFragments: body?.maxFragments ?? null,
        maxBytes: body?.maxBytes ?? null,
        tokenBudget: body?.tokenBudget ?? null,
        count: fragments.length,
      });
      sendJson(res, 200, envelope(requestId, {
        recallId: `rr_fake_${state.contextCount}`,
        fragments,
        blocks: fragments.length === 0 ? [] : [{
          kind: 'fragment',
          content: fragments.map((fragment) => fragment.gist).filter(Boolean).join('\n'),
          citations: fragments.flatMap((fragment) => fragment.citations ?? []),
          trust: 'untrusted',
        }],
        records,
        traceId: `tr_fake_${state.contextCount}`,
      }), requestId);
      return;
    }

    if (path === '/memory-runtime/v1/recall' && req.method === 'POST') {
      state.recallCount += 1;
      if (Number.isFinite(opts.recallDelayMs) && opts.recallDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, opts.recallDelayMs));
      }
      const records = Array.isArray(opts.records) ? opts.records : [];
      state.recalls.push({ requestId, query: body?.query ?? null, count: records.length });
      sendJson(res, 200, envelope(requestId, { records, fragments: [], blocks: [] }), requestId);
      return;
    }

    if (path === '/memory-runtime/v1/ingest' && req.method === 'POST') {
      const key = record.idempotencyKey ?? body?.requestId ?? requestId;
      const replay = idempotentIngest.get(key);
      if (replay !== undefined) {
        state.ingestDuplicates += 1;
        state.ingests.push({
          requestId,
          key,
          duplicate: true,
          chunks: Array.isArray(body?.chunks) ? body.chunks.length : 0,
          candidates: Array.isArray(body?.candidates) ? body.candidates.length : 0,
        });
        sendJson(res, 200, replay, requestId);
        return;
      }
      state.ingestAttempts += 1;
      if (state.ingestFailureCount < (opts.ingestFailTimes ?? 0)) {
        state.ingestFailureCount += 1;
        const status = Number.isInteger(opts.ingestFailureStatus) ? opts.ingestFailureStatus : 503;
        const code = typeof opts.ingestFailureCode === 'string' ? opts.ingestFailureCode : 'runtime_not_ready';
        state.ingests.push({ requestId, key, status, failed: true });
        sendJson(res, status, failure(requestId, code, 'fake ingest failure', true), requestId);
        return;
      }
      if (Number.isFinite(opts.ingestDelayMs) && opts.ingestDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, opts.ingestDelayMs));
      }
      const response = envelope(requestId, {
        accepted: {
          chunks: Array.isArray(body?.chunks) ? body.chunks.length : 0,
          records: Array.isArray(body?.candidates) ? body.candidates.length : 0,
        },
      });
      idempotentIngest.set(key, response);
      state.ingests.push({
        requestId,
        key,
        duplicate: false,
        chunks: Array.isArray(body?.chunks) ? body.chunks.length : 0,
        candidates: Array.isArray(body?.candidates) ? body.candidates.length : 0,
        messageIds: Array.isArray(body?.chunks)
          ? body.chunks.map((chunk) => chunk?.messageId ?? null)
          : [],
        threadId: body?.threadId ?? null,
        agentId: body?.agentId ?? null,
        domain: body?.domain ?? null,
        hasSync: Object.prototype.hasOwnProperty.call(body ?? {}, 'sync'),
      });
      sendJson(res, 200, response, requestId);
      return;
    }

    const checkpointMatch = path.match(/^\/memory-runtime\/v1\/checkpoints\/([^/]+)$/);
    if (checkpointMatch && req.method === 'PUT') {
      const key = record.idempotencyKey ?? body?.requestId ?? requestId;
      const replay = idempotentCheckpoint.get(key);
      if (replay !== undefined) {
        state.checkpoints.push({ requestId, key, duplicate: true });
        sendJson(res, 200, replay, requestId);
        return;
      }
      if (state.checkpoints.filter((entry) => entry.failed === true).length < (opts.checkpointFailTimes ?? 0)) {
        state.checkpoints.push({ requestId, key, status: 409, failed: true });
        sendJson(res, 409, failure(requestId, 'revision_mismatch', 'fake checkpoint failure'), requestId);
        return;
      }
      const response = envelope(requestId, { checkpoint: { revision: 1 } });
      idempotentCheckpoint.set(key, response);
      state.checkpoints.push({
        requestId,
        key,
        duplicate: false,
        threadId: decodeURIComponent(checkpointMatch[1]),
        compactionId: body?.state?.compactionId ?? null,
        summary: typeof body?.summary === 'string' ? body.summary : null,
        domain: body?.domain ?? null,
        hasSync: Object.prototype.hasOwnProperty.call(body ?? {}, 'sync'),
        committed: true,
      });
      sendJson(res, 200, response, requestId);
      return;
    }

    sendJson(res, 404, failure(requestId, 'not_found', 'unknown memory runtime path'), requestId);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;

  return {
    url,
    sidecarUrl: `${url}/memory-runtime/v1`,
    state,
    close: async () => {
      await new Promise((resolve) => server.close(() => resolve()));
    },
    reset: () => {
      state.requests.length = 0;
      state.recalls.length = 0;
      state.contexts.length = 0;
      state.ingests.length = 0;
      state.checkpoints.length = 0;
      state.ingestAttempts = 0;
      state.ingestFailureCount = 0;
      state.ingestDuplicates = 0;
      state.recallCount = 0;
      state.contextCount = 0;
      state.unauthorized = 0;
      idempotentIngest.clear();
      idempotentCheckpoint.clear();
    },
  };
}
