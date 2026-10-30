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
 *   writesEnabled?: boolean,
 *   master?: { publicKey: CryptoKey, privateKey: CryptoKey },
 *   deviceId?: string,
 *   deviceName?: string,
 *   network?: Record<string, unknown> | null,
 *   sync?: Record<string, unknown> | null,
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

  const master = options.master ?? await new IdentityManager().generateUserMasterKey();
  const deviceId = typeof options.deviceId === 'string' && options.deviceId.length > 0
    ? options.deviceId
    : `device-host-e2e-${process.pid}-${randomUUID().slice(0, 8)}`;
  const app = new Mebular({
    storagePath: join(home, 'device.jsonl'),
    deviceId,
    ...(typeof options.deviceName === 'string' && options.deviceName.length > 0
      ? { deviceName: options.deviceName }
      : {}),
    encryption: {
      userMasterKey: master.publicKey,
      userMasterPrivateKey: master.privateKey,
    },
    network: options.network ?? { enabled: false },
    sync: { autoSync: false, ...(options.sync ?? {}) },
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
    ...(options.writesEnabled === true ? { writesEnabled: true } : {}),
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

  async function seedMemory({
    text,
    namespace = 'default',
    agentId = 'host-e2e',
    threadId = 'th_host_e2e_seed',
    confirmation = null,
    kind = 'episode',
    content = undefined,
    supersedes = [],
  }) {
    if (kind === 'fact' && (!content || typeof content !== 'object')) {
      throw new Error('fact seed requires explicit content { subject, predicate, object }');
    }
    const result = await requestCapability('/write', {
      method: 'POST',
      body: JSON.stringify({
        actor: { type: 'agent', agentId },
        ...(threadId ? { threadId } : {}),
        items: [{
          clientItemId: `seed-${randomUUID()}`,
          domain: namespace,
          // Default episode/observation keeps the exact seed text as the record
          // gist. Callers that exercise fact semantics pass kind/content.
          kind,
          content: content ?? { episodeType: 'observation', content: text },
          ...(Array.isArray(supersedes) && supersedes.length > 0 ? { supersedes } : {}),
          provenance: {
            source: 'mcp',
            extractor: 'heuristic',
            ...(threadId ? { threadId } : {}),
            ...(confirmation ? { confirmation } : {}),
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

  async function detailRequest(payload) {
    const result = await requestCapability('/detail', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (result.status !== 200 || result.body?.ok !== true) {
      throw new Error(`capability detail failed: ${result.status} ${JSON.stringify(result.body)}`);
    }
    return result.data;
  }

  /** Write a record plus one linked detail record (domain-shared, not local raw). */
  async function seedMemoryWithDetail({
    text,
    detailText,
    namespace = 'default',
    agentId = 'host-e2e',
    threadId = 'th_host_e2e_seed',
    role = 'user',
    confirmation = null,
    kind = 'episode',
    content = undefined,
    supersedes = [],
  }) {
    const seed = await seedMemory({ text, namespace, agentId, threadId, confirmation, kind, content, supersedes });
    const recordId = seed.records.find((record) => typeof record?.id === 'string')?.id;
    if (!recordId) throw new Error('seed record id missing');
    const detail = await detailRequest({
      actor: { type: 'agent', agentId },
      op: 'write',
      items: [{
        clientItemId: `detail-${randomUUID()}`,
        domain: namespace,
        detailKind: 'raw_chunk',
        threadId,
        recordIds: [recordId],
        role,
        text: detailText ?? text,
        mime: 'text/plain',
        retentionClass: 'conversation',
        expiresAt: 0,
        provenance: {
          source: 'runtime',
          extractor: 'host',
          threadId,
          messageIds: [],
          ...(confirmation ? { confirmation } : {}),
        },
      }],
    });
    const detailId = detail.results?.find((item) => typeof item?.id === 'string')?.id ?? null;
    return { ...seed, recordId, detailId };
  }

  /** Write one structured fact through the real capability API. */
  async function writeFact({
    subject,
    predicate,
    object,
    namespace = 'default',
    agentId = 'host-e2e',
    threadId = 'th_host_e2e_fact',
    confidence = 0.9,
  }) {
    const result = await requestCapability('/write', {
      method: 'POST',
      body: JSON.stringify({
        actor: { type: 'agent', agentId },
        ...(threadId ? { threadId } : {}),
        items: [{
          clientItemId: `fact-${randomUUID()}`,
          domain: namespace,
          kind: 'fact',
          content: { subject, predicate, object, confidence },
          provenance: {
            source: 'mcp',
            extractor: 'heuristic',
            ...(threadId ? { threadId } : {}),
          },
        }],
      }),
    });
    if (result.status !== 200 || result.body?.ok !== true) {
      throw new Error(`fact write failed: ${result.status} ${JSON.stringify(result.body)}`);
    }
    const recordId = result.data?.results?.find((item) => typeof item?.id === 'string')?.id ?? null;
    return { recordId, data: result.data };
  }

  /** Update one MemoryRecord through the real capability API. */
  async function updateMemory({ id, patch, agentId = 'host-e2e' }) {
    const result = await requestCapability('/update', {
      method: 'POST',
      body: JSON.stringify({
        actor: { type: 'agent', agentId },
        items: [{ id, patch }],
      }),
    });
    if (result.status !== 200 || result.body?.ok !== true) {
      throw new Error(`update failed: ${result.status} ${JSON.stringify(result.body)}`);
    }
    return result.data;
  }

  /** Delete records through the real capability API (tombstones + detail cascade). */
  async function deleteMemory(ids, { agentId = 'host-e2e' } = {}) {
    const result = await requestCapability('/delete', {
      method: 'POST',
      body: JSON.stringify({
        actor: { type: 'agent', agentId },
        ids,
      }),
    });
    if (result.status !== 200 || result.body?.ok !== true) {
      throw new Error(`delete failed: ${result.status} ${JSON.stringify(result.body)}`);
    }
    return result.data;
  }

  /** Expand one sidecar recall trace through the real `/recall/:id/expand` endpoint. */
  async function sidecarExpand(recallId, { fragmentId, agentId = 'host-e2e', format = 'verbatim' } = {}) {
    const discovery = await sidecarDiscovery();
    if (discovery === null) throw new Error('sidecar discovery missing');
    return requestSidecar(discovery, `/recall/${encodeURIComponent(recallId)}/expand`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId, fragmentId, format }),
    });
  }

  /** Raw `/context` request against the real sidecar. */
  async function sidecarContext(payload) {
    const discovery = await sidecarDiscovery();
    if (discovery === null) throw new Error('sidecar discovery missing');
    return requestSidecar(discovery, '/context', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  /** List detail records through the real capability API. */
  async function listDetails({
    domains = ['default', 'user'],
    recordIds,
    threadId,
    includeText = false,
    detailKinds = ['raw_chunk'],
    limit = 20,
    agentId = 'host-e2e',
  } = {}) {
    return detailRequest({
      actor: { type: 'agent', agentId },
      op: 'list',
      domains,
      ...(Array.isArray(recordIds) && recordIds.length > 0 ? { recordIds } : {}),
      ...(threadId ? { threadId } : {}),
      detailKinds,
      limit,
      offset: 0,
      includeText,
    });
  }

  async function getDetail(id, { agentId = 'host-e2e', maxBytes = 8192 } = {}) {
    return detailRequest({
      actor: { type: 'agent', agentId },
      op: 'get',
      id,
      includeText: true,
      maxBytes,
    });
  }

  async function resolveDetails({ agentId = 'host-e2e', domains = ['default', 'user', 'agent:opencode', 'agent:hermes'], recordIds, threadId } = {}) {
    const listed = await listDetails({ agentId, domains, recordIds, threadId });
    const details = [];
    for (const item of Array.isArray(listed.details) ? listed.details : []) {
      if (typeof item?.id !== 'string') continue;
      try {
        const got = await getDetail(item.id, { agentId });
        if (got.detail) details.push(got.detail);
      } catch {
        // Availability is asserted through the list when get is denied.
      }
    }
    return details;
  }

  async function recall(query, {
    agentId = 'host-e2e',
    namespaces = ['default'],
    threadId = 'th_host_e2e_recall',
    includeHistory = false,
  } = {}) {
    const result = await requestCapability('/query', {
      method: 'POST',
      body: JSON.stringify({
        actor: { type: 'agent', agentId },
        query,
        domains: namespaces,
        ...(threadId ? { threadId } : {}),
        ...(includeHistory ? { includeHistory: true } : {}),
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

  async function sidecarStagingEntries() {
    const entries = await readSidecarJsonLines(home, join('memory-runtime', 'staging', 'chunks.jsonl'));
    return entries.map((entry) => entry.chunk).filter(Boolean);
  }

  async function sidecarStagingChunks() {
    return (await sidecarStagingEntries())
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
    app,
    master,
    deviceId,
    auth,
    token,
    status,
    requestCapability,
    seedMemory,
    seedMemoryWithDetail,
    writeFact,
    updateMemory,
    deleteMemory,
    listDetails,
    getDetail,
    resolveDetails,
    recall,
    checkpoint,
    legacyRuntimeStatus,
    sidecarDiscovery,
    waitForSidecar: (options) => waitForSidecar(home, options),
    sidecarStatus,
    sidecarCheckpoint,
    sidecarExpand,
    sidecarContext,
    sidecarStagingEntries,
    sidecarStagingChunks,
    sidecarTraces,
    close,
    async cleanup() {
      await close();
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}
