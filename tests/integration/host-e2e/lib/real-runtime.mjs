// Real Mebular MCP daemon + capability API + Memory Runtime sidecar for host
// integration tests.
//
// This starts the actual `startHttpServer` with a real `MemoryService`, mounts
// the real `/internal/memory/v1` capability API, and lets the real supervisor
// spawn the sidecar. Seed/status/recall/checkpoint assertions go through the
// real capability API (or the sidecar helper below); the obsolete prototype
// `/runtime/v1` route is only probed to assert that it no longer exists.
//
// It is a test harness only: production code and the Mebular home directory
// are never touched.

import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Mebular, IdentityManager, MemoryService } from '../../../../dist/index.js';
import { buildServer } from '../../../../packages/mcp/src/server.mjs';
import { hashToken, startHttpServer } from '../../../../packages/mcp/src/serve.mjs';
import { readCapabilityToken } from '../../../../packages/mcp/src/memory-runtime-token.mjs';

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
  const memoryRuntime = options.memoryRuntime ?? { enabled: true };
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

  const service = new MemoryService(app);
  const server = await startHttpServer({
    home,
    app,
    service,
    buildServer,
    config: { memoryRuntime },
    host: '127.0.0.1',
    port: 0,
    auth,
    manageMemoryRuntime,
    ...(tokensFile ? { tokensFile } : {}),
  });
  const url = `http://127.0.0.1:${server.port}`;

  async function capabilityToken() {
    const record = await readCapabilityToken({ home });
    if (typeof record?.token !== 'string' || record.token.length === 0) {
      throw new Error('capability token missing (memoryRuntime.enabled must be true)');
    }
    return record.token;
  }

  /** Authenticated request against the real MCP capability API. */
  async function requestCapability(path, init = {}) {
    const headers = {
      accept: 'application/json',
      authorization: `Bearer ${await capabilityToken()}`,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(init.headers ?? {}),
    };
    const response = await fetch(`${url}/internal/memory/v1${path}`, { ...init, headers });
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { status: response.status, body, data: body?.data ?? null, headers: response.headers };
  }

  async function status() {
    const agentId = 'host-e2e';
    const result = await requestCapability(`/status?agentId=${encodeURIComponent(agentId)}`);
    if (result.status !== 200 || result.body?.ok !== true) {
      throw new Error(`capability status failed: ${result.status} ${JSON.stringify(result.body)}`);
    }
    return result.data;
  }

  async function seedMemory({ text, namespace = 'default', agentId = 'host-e2e', threadId = 'th_host_e2e_seed' }) {
    const result = await requestCapability('/write', {
      method: 'POST',
      body: JSON.stringify({
        actor: { type: 'agent', agentId },
        ...(threadId ? { threadId } : {}),
        items: [{
          clientItemId: `seed-${randomUUID()}`,
          domain: namespace,
          // Episode/observation keeps the exact seed text as the record gist
          // (fact rendering would prepend subject/predicate).
          kind: 'episode',
          content: { episodeType: 'observation', content: text },
          provenance: {
            source: 'mcp',
            extractor: 'heuristic',
            ...(threadId ? { threadId } : {}),
          },
        }],
      }),
    });
    if (result.status !== 200 || result.body?.ok !== true) {
      throw new Error(`seed write failed: ${result.status} ${JSON.stringify(result.body)}`);
    }
    const data = result.data;
    return {
      accepted: {
        records: data.created,
        duplicates: data.duplicates,
        failed: data.failed,
      },
      records: data.results,
      data,
    };
  }

  async function recall(query, { agentId = 'host-e2e', namespaces = ['default'], threadId = 'th_host_e2e_recall' } = {}) {
    const result = await requestCapability('/query', {
      method: 'POST',
      body: JSON.stringify({
        actor: { type: 'agent', agentId },
        query,
        domains: namespaces,
        ...(threadId ? { threadId } : {}),
        limit: 20,
      }),
    });
    if (result.status !== 200 || result.body?.ok !== true) {
      throw new Error(`capability query failed: ${result.status} ${JSON.stringify(result.body)}`);
    }
    const data = result.data;
    return {
      ...data,
      records: (data.records ?? []).map((record) => ({
        ...record,
        content: record.text ?? record.content,
      })),
    };
  }

  async function checkpoint(threadId, agentId) {
    const result = await requestCapability('/internal-object', {
      method: 'POST',
      body: JSON.stringify({
        actor: { type: 'agent', agentId },
        kind: 'context_checkpoint',
        op: 'get',
        agentId,
        threadId,
      }),
    });
    if (result.status !== 200 || result.body?.ok !== true) {
      throw new Error(`capability checkpoint failed: ${result.status} ${JSON.stringify(result.body)}`);
    }
    return result.data?.object ?? null;
  }

  /** Probe the removed prototype route; real hosts must never use it. */
  async function legacyRuntimeStatus() {
    const response = await fetch(`${url}/runtime/v1/status`);
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return {
      status: response.status,
      body,
      deprecatedHeader: response.headers.get('x-mebular-deprecated'),
    };
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
    status,
    seedMemory,
    recall,
    checkpoint,
    legacyRuntimeStatus,
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
