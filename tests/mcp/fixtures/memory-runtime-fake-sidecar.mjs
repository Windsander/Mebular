#!/usr/bin/env node
// 测试用 fake Memory Runtime sidecar。
//
// 行为由 FAKE_SIDECAR_MODE 控制：
//   ready（默认）——监听临时端口、写 discovery、SIGTERM 清理后退出；
//   crash         ——写 discovery 后很快退出，用于崩溃退避/重启上限；
//   hang          ——不写 discovery、不监听，用于启动超时；
//   slow          ——延迟 FAKE_SIDECAR_DELAY_MS 后写 discovery。
//
// 只用于测试 MCP supervisor 的进程/HTTP/discovery 生命周期，不实现任何记忆业务。

import { createServer } from 'node:http';
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const env = process.env;
const home = env.MEBULAR_HOME;
const dataDir = env.MEBULAR_MEMORY_RUNTIME_HOME ?? join(home, 'memory-runtime');
const discoveryPath = join(home, 'memory-runtime.json');
const tokenPath = join(dataDir, 'host-token');
const hostToken = env.MEBULAR_MEMORY_RUNTIME_TOKEN ?? env.FAKE_SIDECAR_HOST_TOKEN ?? 'fake-host-token-0123456789abcdef';
const mode = env.FAKE_SIDECAR_MODE ?? 'ready';
const profileId = env.FAKE_SIDECAR_PROFILE_ID ?? 'default';
const cloudId = env.FAKE_SIDECAR_CLOUD_ID ?? null;

mkdirSync(dataDir, { recursive: true, mode: 0o700 });
writeFileSync(tokenPath, hostToken, { mode: 0o600 });

function readJsonEnv(name, fallback) {
  const path = env[name];
  if (typeof path !== 'string' || path.length === 0) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return fallback;
  }
}

function recordAuth(req) {
  const out = env.FAKE_SIDECAR_AUTH_OUT;
  if (typeof out !== 'string' || out.length === 0) return;
  try {
    appendFileSync(out, `${JSON.stringify({ path: req.url, authorization: req.headers.authorization ?? null })}\n`);
  } catch {
    // 测试临时目录可能已清理；记录失败不影响 sidecar 响应。
  }
}

function authorized(req) {
  const header = req.headers.authorization;
  return header === `Bearer ${hostToken}`;
}

function sendUnauthorized(res) {
  res.statusCode = 401;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ ok: false, error: { code: 'host_token_invalid', message: 'host token 缺失或无效' } }));
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}'));
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

function recordAdmin(req, body) {
  const out = env.FAKE_SIDECAR_ADMIN_OUT;
  if (typeof out !== 'string' || out.length === 0) return;
  try {
    appendFileSync(out, `${JSON.stringify({ method: req.method, path: req.url, body: body ?? null })}\n`);
  } catch {
    // 测试临时目录可能已清理；记录失败不影响 sidecar 响应。
  }
}

const MODEL_PACKS = [
  { packId: 'qwen3-8b-instruct-q4_k_m', modelId: 'qwen3-8b-instruct', tier: 'default', displayName: 'Qwen3 8B' },
  { packId: 'qwen3-4b-instruct-q4_k_m', modelId: 'qwen3-4b-instruct', tier: 'light', displayName: 'Qwen3 4B' },
  { packId: 'qwen3-14b-instruct-q4_k_m', modelId: 'qwen3-14b-instruct', tier: 'quality', displayName: 'Qwen3 14B' },
  { packId: 'qwen3-30b-a3b-instruct-q4_k_m', modelId: 'qwen3-30b-a3b-instruct', tier: 'high', displayName: 'Qwen3 30B-A3B' },
];
const ACTIVE_PACK = 'qwen3-4b-instruct-q4_k_m';
let inferenceSource = env.FAKE_SIDECAR_MODEL_SOURCE ?? 'heuristic';
let engineState = 'stopped';
let currentInstall = null;

function engineView() {
  return {
    state: engineState,
    health: engineState === 'running' ? 'ok' : 'unknown',
    packId: engineState === 'running' ? ACTIVE_PACK : null,
    modelId: engineState === 'running' ? 'qwen3-4b-instruct' : null,
    crashCount: 0,
    restartCount: 0,
    lastError: null,
    installed: true,
    release: 'b12017',
    platform: 'darwin',
    arch: 'arm64',
    binaryReady: true,
    reason: null,
  };
}

function activeView() {
  return {
    source: inferenceSource,
    packId: inferenceSource === 'local' ? ACTIVE_PACK : null,
    modelId: inferenceSource === 'local' ? 'qwen3-4b-instruct' : null,
    engine: engineView(),
  };
}

function installJob(state = 'downloading') {
  return {
    schema: 1,
    jobId: 'job_fake_0001',
    packId: ACTIVE_PACK,
    modelId: 'qwen3-4b-instruct',
    state,
    phase: 'model',
    progress: state === 'completed' ? 1 : 0.25,
    downloadedBytes: 25,
    totalBytes: 100,
    speedBytesPerSecond: 10,
    etaMs: 7500,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    completedAt: state === 'completed' ? Date.now() : null,
    error: null,
    warnings: [],
  };
}

function catalogView() {
  return {
    hardware: {
      platform: 'darwin',
      arch: 'arm64',
      osVersion: 'test',
      cpuModel: 'Apple M3',
      cpuCores: 8,
      totalMemoryBytes: 16 * 1024 ** 3,
      freeMemoryBytes: 8 * 1024 ** 3,
      diskAvailableBytes: 100 * 1024 ** 3,
      diskTotalBytes: 500 * 1024 ** 3,
      gpu: { vendor: 'apple', name: 'Apple M3', vramBytes: null, unifiedMemory: true },
      detectedAt: 0,
      warnings: [],
    },
    recommended: {
      kind: 'local',
      packId: 'qwen3-8b-instruct-q4_k_m',
      modelId: 'qwen3-8b-instruct',
      tier: 'default',
      reason: 'default',
      warnings: [],
      alternatives: [],
    },
    packs: MODEL_PACKS.map((pack) => ({
      ...pack,
      description: '',
      quantization: 'Q4_K_M',
      contextLength: 32768,
      estimatedDownloadBytes: 100,
      requirements: {
        platforms: ['darwin', 'linux', 'win32'],
        architectures: null,
        minMemoryBytes: 1,
        recommendedMemoryBytes: 2,
        minDiskBytes: 1,
        gpu: 'optional',
      },
      state: pack.packId === ACTIVE_PACK ? 'installed' : 'not_installed',
      installed: pack.packId === ACTIVE_PACK,
      installedBytes: pack.packId === ACTIVE_PACK ? 100 : 0,
      expectedBytes: 100,
      verifiedAt: null,
      manifest: { available: true, error: null },
      supported: true,
      active: inferenceSource === 'local' && pack.packId === ACTIVE_PACK,
      install: currentInstall,
      warnings: [],
    })),
    active: activeView(),
    providers: [
      { id: 'heuristic', kind: 'builtin', configured: true, available: true, active: inferenceSource === 'heuristic', reason: null },
      { id: 'host', kind: 'host', configured: true, available: true, active: inferenceSource === 'host', reason: null },
      { id: 'local', kind: 'local-engine', configured: true, available: true, active: inferenceSource === 'local', reason: null },
      { id: 'api', kind: 'remote', configured: false, available: false, active: inferenceSource === 'api', reason: 'api_not_configured' },
    ],
    install: currentInstall,
    engine: {
      state: 'installed',
      installed: true,
      release: 'b12017',
      platform: 'darwin',
      arch: 'arm64',
      asset: 'llama-b12017-bin-macos-arm64.tar.gz',
      binaryReady: true,
      reason: null,
      progress: 1,
      installedAt: 0,
      verifiedAt: 0,
      supported: true,
    },
    warnings: [],
  };
}

function statusView() {
  return {
    active: activeView(),
    engine: engineView(),
    install: currentInstall,
    recommended: catalogView().recommended,
    installedPackIds: [ACTIVE_PACK],
    warnings: [],
  };
}

function sendEnvelope(res, status, data, warnings = []) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ ok: true, data, warnings, degraded: false }));
}

function sendError(res, status, code, message) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ ok: false, error: { code, message, retryable: false } }));
}

const defaultTrace = {
  id: 'tr_fake_0001',
  recallId: 'rr_fake_0001',
  schema: 2,
  at: Date.now() - 60_000,
  agentId: 'opencode',
  threadId: 'th_fake',
  queryHash: 'fake-hash',
  queryPreview: 'fake query preview',
  domains: ['notes'],
  silenceReason: null,
  degraded: false,
  feedback: null,
  counts: { candidates: 1, expansions: 1, injected: 1, tokens: 12 },
  timing: { totalMs: 9 },
};

const defaultTraceDetail = {
  ...defaultTrace,
  hits: [{ id: 'memory-fake-1', type: 'fact', score: 0.91, rank: 1 }],
  cue: { topics: ['fake topic'], entities: [{ name: 'Mebular', type: 'product' }] },
  candidates: [{
    id: 'memory-fake-1',
    type: 'fact',
    domain: 'agent:opencode',
    owner: { role: 'agent', ownerId: 'opencode', domain: 'agent:opencode', agentName: 'OpenCode' },
    provenance: { source: 'runtime', extractor: 'heuristic', hostId: 'h_fake' },
    confidence: 0.91,
    score: 0.91,
    rank: 1,
  }],
  expansions: [{ sourceId: 'memory-fake-1', reason: 'exact_value', status: 'ok' }],
  injected: [{
    fragmentId: 'mf_fake_1',
    sourceId: 'memory-fake-1',
    layer: 'detail',
    tokens: 12,
    citations: ['memory-fake-1'],
    confidence: 0.91,
    owner: { role: 'agent', ownerId: 'opencode', domain: 'agent:opencode', agentName: 'OpenCode' },
    provenance: { source: 'runtime', extractor: 'heuristic', hostId: 'h_fake' },
  }],
};

const record = {
  argv: process.argv.slice(2),
  pid: process.pid,
  env: {
    MEBULAR_HOME: home,
    MEBULAR_MEMORY_RUNTIME_HOME: dataDir,
    MEBULAR_CAPABILITY_TOKEN: env.MEBULAR_CAPABILITY_TOKEN ?? null,
    MEBULAR_MEMORY_RUNTIME_TOKEN: env.MEBULAR_MEMORY_RUNTIME_TOKEN ?? null,
    MEBULAR_MCP_URL: env.MEBULAR_MCP_URL ?? null,
  },
};
if (typeof env.FAKE_SIDECAR_ENV_OUT === 'string' && env.FAKE_SIDECAR_ENV_OUT.length > 0) {
  writeFileSync(env.FAKE_SIDECAR_ENV_OUT, JSON.stringify(record), { mode: 0o600 });
}
if (typeof env.FAKE_SIDECAR_SPAWNS_OUT === 'string' && env.FAKE_SIDECAR_SPAWNS_OUT.length > 0) {
  appendFileSync(env.FAKE_SIDECAR_SPAWNS_OUT, `${process.pid}\n`);
}

function writeDiscovery(port) {
  const base = `http://127.0.0.1:${port}/memory-runtime/v1`;
  const discovery = {
    schema: 1,
    kind: 'mebular-memory-runtime',
    pid: process.pid,
    host: '127.0.0.1',
    port,
    url: base,
    healthUrl: `${base}/health`,
    cloudId,
    profileId,
    runtimeVersion: '0.3.0',
    apiVersion: 1,
    capabilityApiVersion: 1,
    minMcpVersion: '0.3.0',
    maxMcpVersion: '0.3.x',
    state: 'ready',
    degraded: false,
    tokenFile: tokenPath,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    capabilities: {
      ingest: false,
      recall: false,
      context: false,
      checkpoint: false,
      compact: false,
      self: false,
      models: ['heuristic'],
    },
  };
  const tmp = `${discoveryPath}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(discovery), { mode: 0o600 });
  renameSync(tmp, discoveryPath);
}

function cleanup() {
  try {
    const current = JSON.parse(readFileSync(discoveryPath, 'utf-8'));
    if (current?.pid === process.pid) rmSync(discoveryPath, { force: true });
  } catch {
    // ignore
  }
}

let server = null;
let exiting = false;
function shutdown(code = 0) {
  if (exiting) return;
  exiting = true;
  cleanup();
  if (server) {
    server.close(() => process.exit(code));
    server.closeAllConnections?.();
    setTimeout(() => process.exit(code), 200).unref();
  } else {
    process.exit(code);
  }
}

process.once('SIGTERM', () => shutdown(0));
process.once('SIGINT', () => shutdown(0));
process.once('exit', cleanup);

if (mode === 'hang') {
  setInterval(() => undefined, 60_000);
} else if (mode === 'crash') {
  server = createServer((req, res) => {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, state: 'ready', ready: true, degraded: false }));
  });
  server.listen(0, '127.0.0.1', () => {
    writeDiscovery(server.address().port);
    setTimeout(() => shutdown(1), Math.max(1, Number(env.FAKE_SIDECAR_EXIT_AFTER_MS ?? 30)));
  });
} else {
  server = createServer(async (req, res) => {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    const path = String(req.url ?? '');
    if (path.endsWith('/health')) {
      res.end(JSON.stringify({ ok: true, state: 'ready', ready: true, degraded: false, pid: process.pid, profileId, cloudId }));
      return;
    }
    if (path.includes('/memory-runtime/v1/')) {
      recordAuth(req);
      if (!authorized(req)) {
        sendUnauthorized(res);
        return;
      }
      const pathname = new URL(path, 'http://127.0.0.1').pathname;
      const relative = pathname.slice(pathname.indexOf('/memory-runtime/v1/') + '/memory-runtime/v1/'.length);
      if (relative === 'models') {
        recordAdmin(req);
        sendEnvelope(res, 200, catalogView());
        return;
      }
      if (relative === 'inference') {
        recordAdmin(req);
        sendEnvelope(res, 200, {
          ...statusView(),
          config: { source: inferenceSource },
          providers: catalogView().providers,
        });
        return;
      }
      if (relative === 'inference/settings') {
        const body = await readBody(req);
        recordAdmin(req, body);
        if (body?.source === 'local') {
          sendError(res, 400, 'pack_required', 'local 来源必须通过模型包激活设置');
          return;
        }
        if (!['heuristic', 'host', 'api', 'auto'].includes(body?.source)) {
          sendError(res, 400, 'invalid_request', 'source 必须是 heuristic/host/api/auto');
          return;
        }
        inferenceSource = body.source;
        if (inferenceSource !== 'local') engineState = 'stopped';
        sendEnvelope(res, 200, {
          ...statusView(),
          config: { source: inferenceSource },
          providers: catalogView().providers,
        });
        return;
      }
      if (relative.startsWith('models/')) {
        const parts = relative.split('/');
        const packId = decodeURIComponent(parts[1] ?? '');
        const action = parts[2] ?? 'status';
        if (!MODEL_PACKS.some((pack) => pack.packId === packId)) {
          sendError(res, 404, 'unknown_pack', '未知模型包');
          return;
        }
        if (action === 'status') {
          recordAdmin(req);
          const pack = MODEL_PACKS.find((entry) => entry.packId === packId);
          sendEnvelope(res, 200, {
            packId,
            modelId: pack.modelId,
            displayName: pack.displayName,
            state: packId === ACTIVE_PACK ? 'installed' : 'not_installed',
            installed: packId === ACTIVE_PACK,
            installedBytes: packId === ACTIVE_PACK ? 100 : 0,
            expectedBytes: 100,
            verified: null,
            verifiedAt: null,
            manifest: { available: true, error: null },
            supported: true,
            active: inferenceSource === 'local' && packId === ACTIVE_PACK,
            install: currentInstall,
            engine: engineView(),
            warnings: [],
          });
          return;
        }
        const body = await readBody(req);
        recordAdmin(req, body);
        if (action === 'install') {
          currentInstall = installJob();
          sendEnvelope(res, 202, currentInstall);
          return;
        }
        if (action === 'activate') {
          inferenceSource = 'local';
          engineState = 'running';
          sendEnvelope(res, 200, {
            activated: true,
            active: 'local',
            packId,
            modelId: 'qwen3-4b-instruct',
            reason: null,
            warnings: [],
            engine: engineView(),
            restartRequired: false,
          });
          return;
        }
        if (action === 'deactivate') {
          inferenceSource = 'heuristic';
          engineState = 'stopped';
          sendEnvelope(res, 200, {
            activated: false,
            active: 'heuristic',
            packId,
            modelId: null,
            reason: null,
            warnings: [],
            engine: engineView(),
            restartRequired: false,
          });
          return;
        }
        if (action === 'start') {
          engineState = 'running';
          sendEnvelope(res, 200, {
            packId,
            started: true,
            stopped: false,
            reason: null,
            warnings: [],
            engine: engineView(),
          });
          return;
        }
        if (action === 'stop') {
          engineState = 'stopped';
          sendEnvelope(res, 200, {
            packId,
            started: false,
            stopped: true,
            reason: null,
            warnings: [],
            engine: engineView(),
          });
          return;
        }
        if (action === 'remove') {
          sendEnvelope(res, 200, {
            packId,
            removed: true,
            wasActive: inferenceSource === 'local' && packId === ACTIVE_PACK,
            warnings: [],
          });
          return;
        }
        sendError(res, 404, 'not_found', '未知模型操作');
        return;
      }
      if (relative.startsWith('installs/')) {
        const parts = relative.split('/');
        const jobId = decodeURIComponent(parts[1] ?? '');
        if (parts[2] === 'cancel') {
          recordAdmin(req);
          currentInstall = installJob('cancelled');
          sendEnvelope(res, 200, currentInstall);
          return;
        }
        if (currentInstall && currentInstall.jobId === jobId) {
          sendEnvelope(res, 200, currentInstall);
          return;
        }
        sendError(res, 404, 'install_not_found', '安装任务不存在');
        return;
      }
      if (relative === 'traces') {
        const traces = readJsonEnv('FAKE_SIDECAR_TRACES_FILE', [defaultTrace]);
        const list = Array.isArray(traces) ? traces : Array.isArray(traces?.traces) ? traces.traces : [];
        res.end(JSON.stringify({ ok: true, data: { traces: list, total: list.length, warnings: [], degraded: false } }));
        return;
      }
      if (relative.startsWith('traces/')) {
        const detail = readJsonEnv('FAKE_SIDECAR_TRACE_DETAIL_FILE', defaultTraceDetail);
        // 模拟未来 sidecar 回归：即使响应里误带令牌字段，MCP 代理也必须剥离。
        res.end(JSON.stringify({
          ok: true,
          data: {
            ...detail,
            debug: {
              authorization: req.headers.authorization ?? null,
              tokenFile: tokenPath,
              token: hostToken,
            },
          },
        }));
        return;
      }
      if (relative.startsWith('recall/') && relative.endsWith('/feedback')) {
        const body = await readBody(req);
        const traceId = relative.split('/')[1] ?? '';
        const out = env.FAKE_SIDECAR_FEEDBACK_OUT;
        if (typeof out === 'string' && out.length > 0) {
          appendFileSync(out, `${JSON.stringify({ traceId, body })}\n`);
        }
        res.end(JSON.stringify({
          ok: true,
          data: {
            traceId,
            feedback: { useful: body.useful === true, at: Date.now() },
            quarantined: [],
            warnings: [],
            degraded: false,
          },
        }));
        return;
      }
    }
    res.end(JSON.stringify({ ok: true }));
  });
  const start = () => server.listen(0, '127.0.0.1', () => writeDiscovery(server.address().port));
  if (mode === 'slow') {
    setTimeout(start, Math.max(0, Number(env.FAKE_SIDECAR_DELAY_MS ?? 300)));
  } else {
    start();
  }
}
