// Test-only HTTP tap in front of the real Memory Runtime sidecar.
//
// The host client still talks HTTP to one loopback origin; every request is
// forwarded to the real sidecar and the real response is returned unchanged.
// The tap only records observability data (method, path, auth shape, JSON body,
// status and a bounded JSON response). It is never part of production code and
// never stores the bearer token: only whether a bearer header was present.

import { createServer } from 'node:http';

const MAX_CAPTURE_BYTES = 128 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
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

function parseBody(buffer, contentType) {
  if (buffer.length === 0 || buffer.length > MAX_CAPTURE_BYTES) return null;
  if (contentType && !contentType.includes('json')) return null;
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    return null;
  }
}

function forwardHeaders(headers) {
  const out = { ...headers };
  delete out.host;
  delete out.connection;
  delete out['content-length'];
  delete out['transfer-encoding'];
  return out;
}

function responseHeaders(headers) {
  const out = {};
  for (const key of ['content-type', 'x-request-id', 'x-mebular-mode', 'x-mebular-degraded', 'www-authenticate']) {
    const value = headers.get(key);
    if (value !== null) out[key] = value;
  }
  return out;
}

/**
 * @param {string} targetUrl real sidecar base URL
 * @param {{ name?: string }} [options]
 */
export async function createRuntimeTap(targetUrl, options = {}) {
  const target = targetUrl.replace(/\/+$/, '');
  const state = {
    name: options.name ?? 'runtime-tap',
    startedAt: new Date().toISOString(),
    requests: [],
  };

  const server = createServer(async (req, res) => {
    const started = Date.now();
    let bodyBuffer;
    try {
      bodyBuffer = await readBody(req);
    } catch (error) {
      res.statusCode = 413;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: false, error: { code: 'payload_too_large' } }));
      return;
    }
    const path = req.url ?? '/';
    const method = req.method ?? 'GET';
    const incoming = req.headers;
    const contentType = typeof incoming['content-type'] === 'string' ? incoming['content-type'] : '';
    const requestBody = parseBody(bodyBuffer, contentType);
    const authHeader = typeof incoming.authorization === 'string' ? incoming.authorization : '';
    const auth = authHeader.length === 0
      ? 'missing'
      : authHeader.startsWith('Bearer ')
        ? 'bearer'
        : 'other';
    const record = {
      at: new Date().toISOString(),
      method,
      path,
      auth,
      idempotencyKey: typeof incoming['idempotency-key'] === 'string'
        ? incoming['idempotency-key']
        : null,
      body: requestBody,
      status: null,
      ok: false,
      response: null,
      error: null,
      tookMs: null,
    };
    try {
      const response = await fetch(`${target}${path}`, {
        method,
        headers: forwardHeaders(incoming),
        body: method === 'GET' || method === 'HEAD' ? undefined : bodyBuffer,
        redirect: 'manual',
      });
      const buffer = Buffer.from(await response.arrayBuffer());
      const responseType = response.headers.get('content-type') ?? '';
      record.status = response.status;
      record.ok = response.status >= 200 && response.status < 300;
      record.response = parseBody(buffer, responseType);
      record.tookMs = Date.now() - started;
      res.writeHead(response.status, responseHeaders(response.headers));
      res.end(buffer);
    } catch (error) {
      record.error = String(error?.message ?? error);
      record.tookMs = Date.now() - started;
      res.statusCode = 502;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: false, error: { code: 'tap_upstream_failed', message: record.error } }));
    } finally {
      state.requests.push(record);
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;

  return {
    url,
    state,
    allRequests: () => state.requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
