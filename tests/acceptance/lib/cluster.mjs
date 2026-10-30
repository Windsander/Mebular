// 0.3 acceptance harness：真实 Mebular app + 真实 MCP capability API + 真实 sidecar。
//
// 每个设备：
// - 独立的临时 home，同一 user master key、不同 deviceId / hostKey；
// - 真实 `Mebular` + `MemoryService` + `startHttpServer`（端口 0）；
// - 真实 supervisor 启动 `mebular-memory-runtime`，sidecar 通过
//   `/internal/memory/v1` 读写同一套图/事件日志；
// - 设备间同步走真实 `SecureChannel` + `SyncManager.syncWithDevice/acceptSync`，
//   不使用内存假图，也不伪造同步协议。
//
// 这里只做测试编排：不修改产品代码，不写用户 home。
// Tests 可只读复用本文件（`tests/acceptance/lib/cluster.mjs`）。

import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  IdentityManager,
  InMemoryHub,
  Mebular,
  MemoryService,
  SecureChannelImpl,
  SecureChannelSyncTransport,
} from '../../../dist/index.js';
import { buildServer } from '../../../packages/mcp/src/server.mjs';
import { startHttpServer } from '../../../packages/mcp/src/serve.mjs';
import { readCapabilityToken } from '../../../packages/mcp/src/memory-runtime-token.mjs';

const DEFAULT_DEVICE_TIMEOUT_MS = 45_000;
const DEFAULT_POLL_MS = 100;

function parseJsonLines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // 撕裂行按本地存储的恢复规则忽略。
    }
  }
  return out;
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

/** 轮询直到 `probe` 返回非 null/非 false；超时抛出带 label 的错误。 */
export async function waitFor(probe, {
  timeoutMs = 15_000,
  intervalMs = DEFAULT_POLL_MS,
  label = 'condition',
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  for (;;) {
    try {
      const value = await probe();
      if (value !== null && value !== undefined && value !== false) return value;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      const suffix = lastError ? `（最近错误：${lastError.message}）` : '';
      throw new Error(`等待 ${label} 超时（${timeoutMs}ms）${suffix}`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
  }
}

/** 读取 sidecar 发现文件；不存在返回 null。 */
export async function readSidecarDiscovery(home) {
  try {
    return JSON.parse(await readFile(join(home, 'memory-runtime.json'), 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

/** 读取 sidecar 发现文件中的 host token（兼容 JSON 记录与裸 token）。 */
export async function readSidecarToken(discovery) {
  if (typeof discovery?.tokenFile !== 'string' || discovery.tokenFile.length === 0) return '';
  const raw = String(await readFile(discovery.tokenFile, 'utf8')).trim();
  if (raw.length === 0) return '';
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.token === 'string') return parsed.token.trim();
  } catch {
    // 裸 token 文件。
  }
  return raw;
}

/** sidecar 已 ready 且 health 通过。 */
async function healthyDiscovery(home) {
  const discovery = await readSidecarDiscovery(home);
  if (discovery?.state !== 'ready' || typeof discovery?.url !== 'string') return null;
  try {
    const response = await fetch(`${discovery.url}/health`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(1000),
    });
    if (!response.ok) return null;
    const body = await response.json();
    if (body?.ready !== true) return null;
    return discovery;
  } catch {
    return null;
  }
}

/** 等待某个 home 的 sidecar ready；可要求 pid 不同于 previousPid（重启场景）。 */
export async function waitForSidecar(home, {
  timeoutMs = DEFAULT_DEVICE_TIMEOUT_MS,
  intervalMs = DEFAULT_POLL_MS,
  notPid = null,
} = {}) {
  return waitFor(async () => {
    const discovery = await healthyDiscovery(home);
    if (!discovery) return null;
    if (notPid !== null && discovery.pid === notPid) return null;
    return discovery;
  }, { timeoutMs, intervalMs, label: `sidecar ready @ ${home}` });
}

async function requestJson(url, init = {}) {
  const response = await fetch(url, init);
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body, data: body?.data ?? null, headers: response.headers };
}

/**
 * 创建一个设备。`sidecarConfig` / `sidecarPolicy` 会在 supervisor 启动
 * sidecar 之前写入 `<home>/memory-runtime/`，用于显式跨 Agent 读授权或
 * 指向可控的 capability 网关。
 */
async function createDevice({
  root,
  deviceId,
  master,
  sidecarConfig = null,
  sidecarPolicy = null,
  timeoutMs = DEFAULT_DEVICE_TIMEOUT_MS,
}) {
  const home = join(root, deviceId);
  const cloudRoot = join(root, `${deviceId}-cloud-root`);
  await mkdir(home, { recursive: true });
  await mkdir(cloudRoot, { recursive: true });

  const dataDir = join(home, 'memory-runtime');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const baseConfig = {
    schema: 1,
    // 与 MCP 一样使用临时端口，避免与开发机上真实 sidecar 抢 7341。
    http: { host: '127.0.0.1', port: 0 },
    ...(sidecarConfig ?? {}),
  };
  await writeFile(join(dataDir, 'config.json'), JSON.stringify(baseConfig, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
  if (sidecarPolicy !== null) {
    await writeFile(join(dataDir, 'policy.json'), JSON.stringify(sidecarPolicy, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
  }

  const app = new Mebular({
    storagePath: join(home, 'device.jsonl'),
    deviceId,
    encryption: {
      userMasterKey: master.publicKey,
      userMasterPrivateKey: master.privateKey,
    },
    network: { enabled: false },
    sync: {
      autoSync: false,
      syncStatePath: join(home, 'sync-state.json'),
    },
  });
  await app.initialize();
  const service = new MemoryService(app);
  const server = await startHttpServer({
    home,
    app,
    service,
    buildServer,
    config: { memoryRuntime: { enabled: true, startTimeoutMs: 20_000 } },
    host: '127.0.0.1',
    port: 0,
    auth: 'none',
    manageMemoryRuntime: true,
  });
  const url = `http://127.0.0.1:${server.port}`;

  async function capabilityToken() {
    const record = await readCapabilityToken({ home });
    if (typeof record?.token !== 'string' || record.token.length === 0) {
      throw new Error(`capability token missing for ${deviceId}`);
    }
    return record.token;
  }

  async function requestCapability(path, init = {}) {
    const headers = {
      accept: 'application/json',
      authorization: `Bearer ${await capabilityToken()}`,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(init.headers ?? {}),
    };
    return requestJson(`${url}/internal/memory/v1${path}`, { ...init, headers });
  }

  function actorFor(agentId) {
    return agentId ? { type: 'agent', agentId } : { type: 'user' };
  }

  const capability = {
    request: requestCapability,
    async version() {
      const result = await requestCapability('/version');
      if (result.status !== 200 || result.body?.ok !== true) {
        throw new Error(`capability version failed: ${result.status} ${JSON.stringify(result.body)}`);
      }
      return result.data;
    },
    async status(agentId = null) {
      const query = agentId ? `?agentId=${encodeURIComponent(agentId)}` : '';
      const result = await requestCapability(`/status${query}`);
      if (result.status !== 200 || result.body?.ok !== true) {
        throw new Error(`capability status failed: ${result.status} ${JSON.stringify(result.body)}`);
      }
      return result.data;
    },
    async write(items, { actor = null, agentId = null, requestId = null } = {}) {
      return requestCapability('/write', {
        method: 'POST',
        body: JSON.stringify({
          ...(requestId ? { requestId } : {}),
          actor: actor ?? actorFor(agentId),
          items,
        }),
        ...(requestId ? { headers: { 'idempotency-key': requestId } } : {}),
      });
    },
    async query({
      query,
      agentId = null,
      domains = null,
      types = null,
      threadId = null,
      includeHistory = false,
      includeArchived = false,
      limit = 20,
    }) {
      return requestCapability('/query', {
        method: 'POST',
        body: JSON.stringify({
          actor: actorFor(agentId),
          ...(query !== undefined ? { query } : {}),
          ...(domains ? { domains } : {}),
          ...(types ? { types } : {}),
          ...(threadId ? { threadId } : {}),
          includeHistory,
          includeArchived,
          limit,
        }),
      });
    },
    async search({
      query,
      agentId = null,
      domains = null,
      types = null,
      includeArchived = false,
      limit = 20,
    }) {
      return requestCapability('/search', {
        method: 'POST',
        body: JSON.stringify({
          actor: actorFor(agentId),
          query,
          ...(domains ? { domains } : {}),
          ...(types ? { types } : {}),
          includeArchived,
          limit,
        }),
      });
    },
    async delete(ids, { actor = { type: 'user' }, reason = 'acceptance test' } = {}) {
      return requestCapability('/delete', {
        method: 'POST',
        body: JSON.stringify({ actor, ids, reason }),
      });
    },
    async archive(ids, { actor = { type: 'user' }, archived = true } = {}) {
      return requestCapability('/archive', {
        method: 'POST',
        body: JSON.stringify({ actor, ids, archived }),
      });
    },
    async internalObject(body) {
      return requestCapability('/internal-object', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
  };

  async function currentDiscovery({ notPid = null } = {}) {
    return waitForSidecar(home, { timeoutMs, notPid });
  }

  async function requestSidecar(path, init = {}) {
    const discovery = await currentDiscovery();
    const token = await readSidecarToken(discovery);
    const headers = {
      accept: 'application/json',
      ...(token.length > 0 ? { authorization: `Bearer ${token}` } : {}),
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(init.headers ?? {}),
    };
    return requestJson(`${discovery.url}${path}`, { ...init, headers });
  }

  const sidecar = {
    request: requestSidecar,
    discovery: () => currentDiscovery(),
    async waitForReady() {
      return currentDiscovery();
    },
    async waitForRestart(previousPid, { timeoutMs: restartTimeoutMs = timeoutMs } = {}) {
      return waitForSidecar(home, { timeoutMs: restartTimeoutMs, notPid: previousPid });
    },
    async status() {
      const result = await requestSidecar('/status');
      if (result.status !== 200 || result.body?.ok !== true) {
        throw new Error(`sidecar status failed: ${result.status} ${JSON.stringify(result.body)}`);
      }
      return result.data;
    },
    async ingest(body, { idempotencyKey = null } = {}) {
      return requestSidecar('/ingest', {
        method: 'POST',
        body: JSON.stringify(body),
        ...(idempotencyKey ? { headers: { 'idempotency-key': idempotencyKey } } : {}),
      });
    },
    async recall(body) {
      return requestSidecar('/recall', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    async context(body) {
      return requestSidecar('/context', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    async getCheckpoint(threadId, { agentId = null, sync = null } = {}) {
      const params = new URLSearchParams();
      if (agentId) params.set('agentId', agentId);
      if (sync !== null) params.set('sync', sync);
      const query = params.toString();
      return requestSidecar(
        `/checkpoints/${encodeURIComponent(threadId)}${query ? `?${query}` : ''}`,
      );
    },
    async putCheckpoint(threadId, body) {
      return requestSidecar(`/checkpoints/${encodeURIComponent(threadId)}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      });
    },
    async getSelf(agentId) {
      return requestSidecar(`/self/${encodeURIComponent(agentId)}`);
    },
    async putSelf(agentId, body) {
      return requestSidecar(`/self/${encodeURIComponent(agentId)}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      });
    },
    async compact(body) {
      return requestSidecar('/compact', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    async getCompact(id) {
      return requestSidecar(`/compacts/${encodeURIComponent(id)}`);
    },
    async rawEntries() {
      const entries = await readSidecarJsonLines(home, join('memory-runtime', 'raw', 'chunks.jsonl'));
      return entries.map((entry) => entry.chunk).filter(Boolean);
    },
    async rawTexts() {
      return (await sidecar.rawEntries())
        .map((chunk) => chunk.text)
        .filter((textValue) => typeof textValue === 'string');
    },
    async traces() {
      return readSidecarJsonLines(home, join('memory-runtime', 'traces.jsonl'));
    },
  };

  return {
    deviceId,
    home,
    cloudRoot,
    url,
    app,
    service,
    server,
    capability,
    sidecar,
    async setSidecarConfig(config) {
      const next = {
        schema: 1,
        http: { host: '127.0.0.1', port: 0 },
        ...(config ?? {}),
      };
      await writeFile(join(dataDir, 'config.json'), JSON.stringify(next, null, 2), {
        encoding: 'utf8',
        mode: 0o600,
      });
    },
    async close() {
      await server.close().catch(() => undefined);
      await app.shutdown().catch(() => undefined);
    },
  };
}

function peerIdOf(device) {
  const identity = device.app.identity.getDeviceKey(device.app.deviceId);
  if (!identity) throw new Error(`missing device identity: ${device.app.deviceId}`);
  return {
    id: device.app.deviceId,
    multihash: identity.publicKey,
    pubKey: identity.publicKey,
  };
}

function syncPeerOf(device) {
  return { deviceId: device.app.deviceId, publicKey: peerIdOf(device).pubKey };
}

/**
 * 两个真实设备。默认返回 `{a,b,sync,...}`；offline 验收可只建一个设备。
 *
 * @param {{
 *   deviceCount?: 1 | 2,
 *   a?: { sidecarConfig?: object | null, sidecarPolicy?: object | null },
 *   b?: { sidecarConfig?: object | null, sidecarPolicy?: object | null },
 * }} [options]
 */
export async function createCluster(options = {}) {
  const deviceCount = options.deviceCount === 1 ? 1 : 2;
  const root = await mkdtemp(join(tmpdir(), 'mebular-acceptance-'));
  const hub = new InMemoryHub();
  const master = await new IdentityManager().generateUserMasterKey();
  const suffix = randomUUID().slice(0, 8);
  const devices = [];

  try {
    const a = await createDevice({
      root,
      deviceId: `device-accept-a-${suffix}`,
      master,
      ...(options.a ?? {}),
    });
    devices.push(a);
    let b = null;
    if (deviceCount === 2) {
      b = await createDevice({
        root,
        deviceId: `device-accept-b-${suffix}`,
        master,
        ...(options.b ?? {}),
      });
      devices.push(b);
    }

    const sync = async (direction = 'bidirectional') => {
      if (!a || !b) throw new Error('sync 需要两个设备');
      const [connA, connB] = hub.createLinkedPair(peerIdOf(a), peerIdOf(b));
      const channelA = new SecureChannelImpl(connA);
      const channelB = new SecureChannelImpl(connB);
      await Promise.all([channelA.start(), channelB.start()]);
      const transportA = new SecureChannelSyncTransport(channelA);
      const transportB = new SecureChannelSyncTransport(channelB);
      try {
        return await Promise.all([
          a.app.sync.syncWithDevice(transportA, syncPeerOf(b), { direction }),
          b.app.sync.acceptSync(transportB, syncPeerOf(a)),
        ]);
      } finally {
        await Promise.allSettled([transportA.close(), transportB.close()]);
      }
    };

    let closed = false;
    const cleanup = async () => {
      if (closed) return;
      closed = true;
      for (const device of devices.slice().reverse()) {
        await device.close();
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
        .catch(() => undefined);
    };

    return {
      root,
      hub,
      master,
      a,
      b,
      devices,
      sync,
      cleanup,
    };
  } catch (error) {
    for (const device of devices.slice().reverse()) {
      await device.close().catch(() => undefined);
    }
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * 可控的 capability 网关：把 sidecar 的 loopback 请求转发到真实 MCP。
 * `down()` 后立即断开既有连接并拒绝新连接（503 capability_unavailable），
 * 用来模拟 capability 不可达；`up()` 恢复转发。只监听 127.0.0.1，端口由内核分配。
 *
 * 注意：MCP capability 会校验 Host 头必须是自身 loopback 端口，所以网关必须
 * 改写 Host，而不能做纯 TCP 透传。
 */
export async function startCapabilityGate() {
  let target = null;
  let down = false;
  const agent = new http.Agent({ keepAlive: false });
  const inflight = new Set();

  function unavailable(res) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(503, {
      'content-type': 'application/json',
      'retry-after': '1',
    });
    res.end(JSON.stringify({
      ok: false,
      requestId: 'req_gate_unavailable',
      capabilityVersion: 1,
      error: {
        code: 'capability_unavailable',
        message: 'capability gate is down',
        retryable: true,
      },
    }));
  }

  const server = http.createServer((req, res) => {
    if (down || target === null) {
      req.resume();
      unavailable(res);
      return;
    }
    const headers = { ...req.headers };
    headers.host = `${target.host}:${target.port}`;
    delete headers.connection;
    const upstream = http.request({
      host: target.host,
      port: target.port,
      method: req.method,
      path: req.url,
      headers,
      agent,
    }, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    });
    inflight.add(upstream);
    upstream.on('close', () => inflight.delete(upstream));
    upstream.on('error', () => {
      inflight.delete(upstream);
      unavailable(res);
    });
    req.on('error', () => upstream.destroy());
    req.pipe(upstream);
  });

  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;

  return {
    url,
    setTarget(targetUrl) {
      const parsed = new URL(targetUrl);
      target = { host: parsed.hostname, port: Number(parsed.port) };
    },
    down() {
      down = true;
      server.closeAllConnections?.();
      for (const request of inflight) request.destroy();
      inflight.clear();
    },
    up() {
      down = false;
    },
    isDown() {
      return down;
    },
    async close() {
      down = true;
      server.closeAllConnections?.();
      for (const request of inflight) request.destroy();
      inflight.clear();
      agent.destroy();
      await new Promise((resolvePromise) => server.close(() => resolvePromise()));
    },
  };
}

/** 便捷断言 helper：从 capability/recall 结果中取出记录 id。 */
export function recordIds(records) {
  return (records ?? []).map((record) => record?.id).filter((id) => typeof id === 'string');
}
