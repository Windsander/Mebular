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
const mode = env.FAKE_SIDECAR_MODE ?? 'ready';
const profileId = env.FAKE_SIDECAR_PROFILE_ID ?? 'default';
const cloudId = env.FAKE_SIDECAR_CLOUD_ID ?? null;

mkdirSync(dataDir, { recursive: true, mode: 0o700 });

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
    tokenFile: join(dataDir, 'host-token'),
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
  server = createServer((req, res) => {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    if (req.url?.endsWith('/health')) {
      res.end(JSON.stringify({ ok: true, state: 'ready', ready: true, degraded: false, pid: process.pid, profileId, cloudId }));
      return;
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
