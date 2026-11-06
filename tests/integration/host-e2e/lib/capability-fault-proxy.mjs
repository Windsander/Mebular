// Test-only fault proxy between the real Memory Runtime sidecar and the real
// MCP Memory Capability API.
//
// It never implements graph behavior: every healthy request is forwarded to the
// real capability API. It only provides deterministic transport faults (503 for
// checkpoint upserts) so the real sidecar's outbox/202 path can be exercised.

import { createServer } from 'node:http';

const MAX_BODY_BYTES = 2 * 1024 * 1024;

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

/**
 * @param {{ name?: string }} [options]
 */
export async function createCapabilityFaultProxy(options = {}) {
  const state = {
    name: options.name ?? 'capability-fault-proxy',
    mode: 'forward',
    requests: [],
    target: null,
  };
  let targetResolve;
  const targetReady = new Promise((resolve) => { targetResolve = resolve; });

  function setTarget(url) {
    state.target = String(url ?? '').replace(/\/+$/u, '');
    if (state.target.length > 0) targetResolve();
  }

  const server = createServer(async (req, res) => {
    const path = req.url ?? '/';
    let buffer;
    try {
      buffer = await readBody(req);
    } catch {
      res.statusCode = 413;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: false, error: { code: 'payload_too_large' } }));
      return;
    }
    const body = parseJson(buffer);
    const record = {
      method: req.method ?? 'GET',
      path,
      body,
      mode: state.mode,
      status: null,
      faulted: false,
    };
    state.requests.push(record);

    const checkpointWrite = path.endsWith('/internal-object')
      && body?.kind === 'context_checkpoint'
      && body?.op === 'upsert';
    if (state.mode === 'fail_checkpoint_writes' && checkpointWrite) {
      record.faulted = true;
      record.status = 503;
      const text = JSON.stringify({
        ok: false,
        error: {
          code: 'capability_unavailable',
          message: 'test-only capability outage',
          retryable: true,
        },
      });
      res.writeHead(503, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
      res.end(text);
      return;
    }
    const detailWrite = path.endsWith('/detail') && body?.op === 'write';
    if (state.mode === 'fail_detail_writes' && detailWrite) {
      record.faulted = true;
      record.status = 403;
      const text = JSON.stringify({
        ok: false,
        error: {
          code: 'forbidden_scope',
          message: 'test-only detail policy rejection',
          retryable: false,
        },
      });
      res.writeHead(403, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
      res.end(text);
      return;
    }

    try {
      await Promise.race([
        targetReady,
        new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new Error('capability target not configured')), 20_000);
          timer.unref?.();
        }),
      ]);
      const response = await fetch(`${state.target}${path}`, {
        method: req.method ?? 'GET',
        headers: forwardHeaders(req.headers),
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : buffer,
      });
      const responseBuffer = Buffer.from(await response.arrayBuffer());
      record.status = response.status;
      res.writeHead(response.status, {
        'content-type': response.headers.get('content-type') ?? 'application/json',
        ...(response.headers.get('retry-after') === null
          ? {}
          : { 'retry-after': response.headers.get('retry-after') }),
        'content-length': responseBuffer.length,
      });
      res.end(responseBuffer);
    } catch (error) {
      record.status = 502;
      const text = JSON.stringify({
        ok: false,
        error: { code: 'capability_proxy_failed', message: String(error?.message ?? error), retryable: true },
      });
      res.writeHead(502, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
      res.end(text);
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    state,
    setTarget,
    setMode(mode) {
      state.mode = mode === 'fail_checkpoint_writes' || mode === 'fail_detail_writes'
        ? mode
        : 'forward';
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
