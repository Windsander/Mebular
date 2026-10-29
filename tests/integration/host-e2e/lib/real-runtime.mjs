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

import { Mebular, IdentityManager } from '../../../../dist/index.js';
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

/**
 * @param {{
 *   auth?: 'none' | 'bearer',
 *   token?: string,
 *   mode?: 'immersive' | 'mcp',
 *   capture?: 'off' | 'local',
 *   trace?: 'off' | 'local',
 *   root?: string | null,
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
    service: null,
    buildServer,
    config: {
      runtime: {
        mode,
        capture,
        trace,
        model: { source: 'heuristic' },
      },
    },
    host: '127.0.0.1',
    port: 0,
    auth,
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
    close,
    async cleanup() {
      await close();
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}
