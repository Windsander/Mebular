// Real Mebular Runtime HTTP for host integration tests.
//
// This starts the actual `startHttpServer` + `RuntimeService` path against a
// disposable home. Model source is forced to `heuristic`; no local model is
// downloaded and no API endpoint is configured. Raw/trace stay local under the
// temp home so tests can assert what the real Runtime persisted.
//
// It is a test harness only: production code and the Mebular home directory
// are never touched.

import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Mebular, IdentityManager, MemoryService } from '../../../../dist/index.js';
import { buildServer } from '../../../../packages/mcp/src/server.mjs';
import { hashToken, startHttpServer } from '../../../../packages/mcp/src/serve.mjs';

export const ALL_SCOPES = ['memory.read', 'memory.write', 'memory.admin'];

function parseJsonLines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A torn line is ignored, matching the local store's own recovery rule.
    }
  }
  return out;
}

/** Read the sidecar discovery document written by the real supervisor. */
export async function readSidecarDiscovery(home) {
  try {
    return JSON.parse(await readFile(join(home, 'memory-runtime.json'), 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Wait until the real sidecar supervisor has published a ready discovery file.
 * Port 0 is used by every suite, so the URL is only known after the sidecar
 * listens.
 */
export async function waitForSidecar(home, { timeoutMs = 30_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const discovery = await readSidecarDiscovery(home);
    if (discovery?.state === 'ready' && typeof discovery?.url === 'string') return discovery;
    if (Date.now() >= deadline) {
      throw new Error(`sidecar discovery not ready after ${timeoutMs}ms (${JSON.stringify(discovery)})`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
  }
}

/**
 * The sidecar writes `{version,token,...}` to tokenFile. Accept that record and
 * a raw token so test helpers are independent from the on-disk envelope.
 * (The DSH/OpenCode adapters currently only accept the raw form; see README.)
 */
export function sidecarTokenFromFile(text) {
  const raw = String(text ?? '').trim();
  if (raw.length === 0) return '';
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.token === 'string') return parsed.token.trim();
  } catch {
    // Raw token file.
  }
  return raw;
}

export async function readSidecarToken(discovery) {
  if (typeof discovery?.tokenFile !== 'string' || discovery.tokenFile.length === 0) return '';
  return sidecarTokenFromFile(await readFile(discovery.tokenFile, 'utf8'));
}

/** Authenticated request against the real sidecar. `path` starts with `/`. */
export async function requestSidecar(discovery, path, init = {}) {
  if (discovery?.url === undefined) throw new Error('sidecar discovery missing');
  const token = await readSidecarToken(discovery);
  const headers = {
    accept: 'application/json',
    ...(token.length > 0 ? { authorization: `Bearer ${token}` } : {}),
    ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    ...(init.headers ?? {}),
  };
  const response = await fetch(`${discovery.url}${path}`, { ...init, headers });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body, data: body?.data ?? null };
}

async function readSidecarJsonLines(home, relativePath) {
  try {
    const text = await readFile(join(home, relativePath), 'utf8');
    return parseJsonLines(text);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * @param {{
 *   auth?: 'none' | 'bearer',
 *   token?: string,
 *   mode?: 'immersive' | 'mcp',
 *   capture?: 'off' | 'local',
 *   trace?: 'off' | 'local',
 *   root?: string | null,
 *   memoryRuntime?: { enabled?: boolean } | null,
 *   manageMemoryRuntime?: boolean,
 * }} [options]
 */
export async function startRealRuntime(options = {}) {
  const auth = options.auth === 'bearer' ? 'bearer' : 'none';
  const token = typeof options.token === 'string' && options.token.length > 0
    ? options.token
    : 'host-e2e-runtime-token';
  const mode = options.mode === 'mcp' ? 'mcp' : 'immersive';
  const capture = options.capture === 'off' ? 'off' : 'local';
  const trace = options.trace === 'off' ? 'off' : 'local';
  const memoryRuntime = options.memoryRuntime ?? null;
  const manageMemoryRuntime = options.manageMemoryRuntime !== false;
  const root = options.root ?? await mkdtemp(join(tmpdir(), 'mebular-host-e2e-runtime-'));
  const home = join(root, 'mebular-home');
  const cloudRoot = join(root, 'cloud-root');
  await mkdir(home, { recursive: true });
  await mkdir(cloudRoot, { recursive: true });

  const master = await new IdentityManager().generateUserMasterKey();
  const app = new Mebular({
    storagePath: join(home, 'device.jsonl'),
    deviceId: `device-host-e2e-${process.pid}`,
    encryption: {
      userMasterKey: master.publicKey,
      userMasterPrivateKey: master.privateKey,
    },
    network: { enabled: false },
    sync: { autoSync: false },
  });
  await app.initialize();

  let tokensFile;
  if (auth === 'bearer') {
    const authDir = join(home, 'auth');
    await mkdir(authDir, { recursive: true, mode: 0o700 });
    tokensFile = join(authDir, 'tokens.json');
    await writeFile(tokensFile, JSON.stringify({
      tokens: [{
        id: 'host-e2e',
        sha256: hashToken(token),
        scope: ALL_SCOPES,
        revoked: false,
      }],
    }, null, 2), { encoding: 'utf8', mode: 0o600 });
  }

  const server = await startHttpServer({
    home,
    app,
    // The Memory Capability API needs a real MemoryService.  Keep the legacy
    // /runtime/v1-only suites on the original null-service harness.
    service: memoryRuntime?.enabled === true ? new MemoryService(app) : null,
    buildServer,
    config: {
      runtime: {
        mode,
        capture,
        trace,
        model: { source: 'heuristic' },
      },
      ...(memoryRuntime ? { memoryRuntime } : {}),
    },
    host: '127.0.0.1',
    port: 0,
    auth,
    manageMemoryRuntime,
    ...(tokensFile ? { tokensFile } : {}),
  });
  const url = `http://127.0.0.1:${server.port}`;

  function headers(extra = {}) {
    return {
      ...(auth === 'bearer' ? { authorization: `Bearer ${token}` } : {}),
      ...extra,
    };
  }

  async function request(path, init = {}) {
    const response = await fetch(`${url}${path}`, {
      ...init,
      headers: headers({
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(init.headers ?? {}),
      }),
    });
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { status: response.status, body, headers: response.headers };
  }

  async function post(path, body) {
    return request(path, { method: 'POST', body: JSON.stringify(body) });
  }

  async function status() {
    const result = await request('/runtime/v1/status');
    return result.body?.data ?? null;
  }

  async function seedMemory({ text, namespace = 'default', agentId = 'host-e2e', threadId = 'th_host_e2e_seed' }) {
    const result = await post('/runtime/v1/ingest', {
      agentId,
      threadId,
      namespace,
      capture,
      chunks: [{ role: 'user', text, at: Date.now(), messageId: `seed-${Date.now()}` }],
    });
    if (result.status !== 200 || result.body?.ok !== true) {
      throw new Error(`seed ingest failed: ${result.status} ${JSON.stringify(result.body)}`);
    }
    return result.body.data;
  }

  async function seedCandidate({ candidate, namespace = 'default', agentId = 'host-e2e', threadId = 'th_host_e2e_seed_candidate' }) {
    const result = await post('/runtime/v1/ingest', {
      agentId,
      threadId,
      namespace,
      capture: 'off',
      extractor: 'host',
      candidates: [candidate],
    });
    if (result.status !== 200 || result.body?.ok !== true) {
      throw new Error(`seed candidate failed: ${result.status} ${JSON.stringify(result.body)}`);
    }
    return result.body.data;
  }

  async function recall(query, { agentId = 'host-e2e', namespaces = ['default'], threadId = 'th_host_e2e_recall' } = {}) {
    const result = await post('/runtime/v1/recall', {
      query,
      agentId,
      ...(threadId ? { threadId } : {}),
      namespaces,
      limit: 20,
    });
    if (result.status !== 200 || result.body?.ok !== true) {
      throw new Error(`recall failed: ${result.status} ${JSON.stringify(result.body)}`);
    }
    return result.body.data;
  }

  async function checkpoint(threadId, agentId) {
    const result = await request(`/runtime/v1/checkpoints/${encodeURIComponent(threadId)}?agentId=${encodeURIComponent(agentId)}`);
    if (result.status !== 200) {
      throw new Error(`checkpoint get failed: ${result.status} ${JSON.stringify(result.body)}`);
    }
    return result.body?.data?.checkpoint ?? null;
  }

  async function rawChunks() {
    try {
      const text = await readFile(join(home, 'runtime', 'raw', 'chunks.jsonl'), 'utf8');
      return parseJsonLines(text).map((entry) => entry.chunk).filter(Boolean);
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
  }

  async function checkpointFiles() {
    const base = join(home, 'runtime', 'checkpoints');
    const out = [];
    async function walk(dir) {
      let entries = [];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (error) {
        if (error?.code === 'ENOENT') return;
        throw error;
      }
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.name.endsWith('.json')) out.push(JSON.parse(await readFile(path, 'utf8')));
      }
    }
    await walk(base);
    return out;
  }

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    await server.close().catch(() => undefined);
    await app.shutdown().catch(() => undefined);
  }

  async function sidecarDiscovery() {
    return readSidecarDiscovery(home);
  }

  async function sidecarStatus() {
    const discovery = await sidecarDiscovery();
    if (discovery === null) return null;
    const result = await requestSidecar(discovery, '/status');
    if (result.status !== 200 || result.data === null) {
      throw new Error(`sidecar status failed: ${result.status} ${JSON.stringify(result.body)}`);
    }
    return result.data;
  }

  async function sidecarCheckpoint(threadId, agentId) {
    const discovery = await sidecarDiscovery();
    if (discovery === null) return null;
    const query = agentId ? `?agentId=${encodeURIComponent(agentId)}` : '';
    const result = await requestSidecar(
      discovery,
      `/checkpoints/${encodeURIComponent(threadId)}${query}`,
    );
    if (result.status !== 200) {
      throw new Error(`sidecar checkpoint failed: ${result.status} ${JSON.stringify(result.body)}`);
    }
    return result.data?.checkpoint ?? null;
  }

  async function sidecarRawEntries() {
    const entries = await readSidecarJsonLines(home, join('memory-runtime', 'raw', 'chunks.jsonl'));
    return entries.map((entry) => entry.chunk).filter(Boolean);
  }

  async function sidecarRawChunks() {
    return (await sidecarRawEntries())
      .map((chunk) => chunk.text)
      .filter((textValue) => typeof textValue === 'string');
  }

  async function sidecarTraces() {
    return readSidecarJsonLines(home, join('memory-runtime', 'traces.jsonl'));
  }

  return {
    url,
    root,
    home,
    cloudRoot,
    auth,
    token,
    mode,
    capture,
    trace,
    request,
    post,
    status,
    seedMemory,
    seedCandidate,
    recall,
    checkpoint,
    rawChunks,
    checkpointFiles,
    sidecarDiscovery,
    waitForSidecar: (options) => waitForSidecar(home, options),
    sidecarStatus,
    sidecarCheckpoint,
    sidecarRawEntries,
    sidecarRawChunks,
    sidecarTraces,
    close,
    async cleanup() {
      await close();
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}
