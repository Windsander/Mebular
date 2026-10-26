#!/usr/bin/env node
/**
 * 共享 Runtime 共存 E2E（Phase 6）。
 *
 * 全程离线、可重复、不依赖外网 / DSH / Electron / 真实系统 service / 真实 npm：
 *   - 真实 `mebular runtime` CLI 子进程；
 *   - fake provider / fake daemon（真实 HTTP /healthz、真实端口、真实 SIGTERM）；
 *   - fake npm（写入固定布局的 @mebular/core，可延迟/失败）；
 *   - 真实 service 安装器 + 注入的 launchctl 命令替身（manifest/unit 仍是产品代码写的）。
 *
 * 覆盖：健康 attach、两入口冷启动单 daemon、child 所有权、外部 daemon 不被杀、
 * App/CLI provider 不下载、runtime current/provider/service 解析、安装/current/provider
 * 原子性、install/update/upgrade 跨入口锁、升级失败回滚、service manifest 与卸载保留数据。
 *
 * 用法：
 *   node scripts/verify-runtime-coexistence.mjs
 *   npm run verify:runtime:coexistence
 *
 * 输出稳定的 PASS/FAIL 行与一行 RUNTIME_COEXISTENCE_SUMMARY JSON；失败退出 1。
 * 只写系统临时目录，结束时清理子进程与临时目录。Windows 上的 launchctl/service
 * 替身不在本脚本范围（见 docs/architecture/RUNTIME-COEXISTENCE.md 已知限制）。
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(repoRoot, 'packages', 'mcp', 'bin', 'mebular.mjs');
const mcpSrc = join(repoRoot, 'packages', 'mcp', 'src');

const checks = [];
const scenarios = [];

function check(label, condition, detail = '') {
  const ok = condition === true;
  checks.push({ label, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok || detail === '' ? '' : ` — ${detail}`}`);
  return ok;
}

function equal(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  return check(label, ok, ok ? '' : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function homeKey(home) {
  const normalized = resolve(home).replace(/[/\\]+$/, '') || resolve(home);
  return createHash('sha256').update(normalized).digest('hex').slice(0, 12);
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return fallback;
  }
}

function readJsonl(path) {
  try {
    return readFileSync(path, 'utf-8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function listDir(path) {
  try {
    return readdirSync(path).sort();
  } catch {
    return [];
  }
}

function killRecordedDaemons(dir, depth = 0) {
  if (depth > 4) return;
  for (const name of listDir(dir)) {
    const path = join(dir, name);
    if (name === '.e2e-runtime') {
      for (const entry of listDir(path)) {
        if (!entry.startsWith('daemon-') || !entry.endsWith('.json')) continue;
        const record = readJson(join(path, entry));
        if (record && Number.isInteger(record.pid) && pidAlive(record.pid)) {
          try { process.kill(record.pid, 'SIGKILL'); } catch { /* already gone */ }
        }
      }
      continue;
    }
    if (name.startsWith('.')) continue;
    try {
      if (readdirSync(path, { withFileTypes: true }).some(() => true)) killRecordedDaemons(path, depth + 1);
    } catch {
      // file or unreadable: ignore
    }
  }
}

function jsonFromOutput(text) {
  const trimmed = String(text ?? '').trim();
  if (trimmed.length === 0) throw new Error('empty JSON output');
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error(`invalid JSON output: ${trimmed.slice(0, 300)}`);
  }
}

function freePort() {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolvePromise(port));
    });
  });
}

async function waitFor(label, read, predicate, { timeoutMs = 15000, intervalMs = 50 } = {}) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    try {
      last = await read();
      if (predicate(last)) return last;
    } catch (error) {
      last = { error: String(error?.message ?? error) };
    }
    await sleep(intervalMs);
  }
  throw new Error(`timeout waiting for ${label}; last=${JSON.stringify(last)?.slice(0, 500)}`);
}

async function fetchHealth(port, timeoutMs = 800) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function spawnNode(args, { env = process.env, cwd = repoRoot, killAfterMs = 90000 } = {}) {
  const proc = spawn(process.execPath, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const handle = {
    proc,
    stdout: '',
    stderr: '',
    exitCode: null,
    signal: null,
  };
  proc.stdout.on('data', (chunk) => { handle.stdout += chunk.toString(); });
  proc.stderr.on('data', (chunk) => { handle.stderr += chunk.toString(); });
  proc.once('exit', (code, signal) => {
    handle.exitCode = code;
    handle.signal = signal;
  });
  const timer = setTimeout(() => {
    if (handle.exitCode === null) {
      try { proc.kill('SIGKILL'); } catch { /* already gone */ }
    }
  }, killAfterMs);
  timer.unref?.();
  proc.once('exit', () => clearTimeout(timer));
  return handle;
}

function waitExit(handle, timeoutMs = 15000) {
  if (handle.exitCode !== null || handle.proc.exitCode !== null) {
    return Promise.resolve({ code: handle.exitCode ?? handle.proc.exitCode, signal: handle.signal });
  }
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`process ${handle.proc.pid} did not exit in ${timeoutMs}ms; stdout=${handle.stdout.slice(-500)} stderr=${handle.stderr.slice(-800)}`));
    }, timeoutMs);
    handle.proc.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal });
    });
  });
}

async function stopProcess(handle, { signal = 'SIGTERM', timeoutMs = 10000 } = {}) {
  if (handle.exitCode !== null) return { code: handle.exitCode, signal: handle.signal };
  try { handle.proc.kill(signal); } catch { /* already gone */ }
  try {
    return await waitExit(handle, timeoutMs);
  } catch {
    try { handle.proc.kill('SIGKILL'); } catch { /* already gone */ }
    return waitExit(handle, 3000).catch(() => ({ code: null, signal: 'SIGKILL' }));
  }
}

async function waitJson(handle, { timeoutMs = 20000, predicate = () => true } = {}) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = jsonFromOutput(handle.stdout);
      if (predicate(value)) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(50);
  }
  throw new Error(
    `timeout waiting for JSON from pid ${handle.proc.pid}: ${lastError?.message ?? 'no JSON'}`
    + `; stdout=${handle.stdout.slice(-500)} stderr=${handle.stderr.slice(-800)}`,
  );
}

async function runNode(args, options = {}) {
  const handle = spawnNode(args, options);
  const { code, signal } = await waitExit(handle, options.timeoutMs ?? 60000);
  return {
    code,
    signal,
    stdout: handle.stdout,
    stderr: handle.stderr,
    json: (() => {
      try { return jsonFromOutput(handle.stdout); } catch { return null; }
    })(),
  };
}

function runtimeEnv({ root, userHome, port, binDir, extra = {} }) {
  const env = { ...process.env };
  for (const key of [
    'MEBULAR_HOME',
    'MEBULAR_HTTP_HOST',
    'MEBULAR_HTTP_PORT',
    'MEBULAR_SERVICE_UNIT_HOME',
    'NODE_OPTIONS',
  ]) {
    delete env[key];
  }
  return {
    ...env,
    HOME: userHome,
    MEBULAR_CLOUD_ROOT: root,
    MEBULAR_HTTP_HOST: '127.0.0.1',
    MEBULAR_HTTP_PORT: String(port),
    MEBULAR_SERVICE_HOME: join(userHome, '.mebular', 'services'),
    PATH: `${binDir}${process.platform === 'win32' ? ';' : ':'}${env.PATH ?? ''}`,
    ...extra,
  };
}

function runCli(args, { root, userHome, port, binDir, extraEnv = {}, timeoutMs = 60000 } = {}) {
  return runNode([cliPath, ...args], {
    env: runtimeEnv({ root, userHome, port, binDir, extra: extraEnv }),
    timeoutMs,
  });
}

function spawnSupervise({ root, userHome, port, binDir, extraEnv = {} }) {
  return spawnNode([cliPath, 'runtime', 'supervise', '--json'], {
    env: runtimeEnv({ root, userHome, port, binDir, extra: extraEnv }),
  });
}

function eventsPath(root) {
  return join(root, '.e2e-runtime', 'starts.jsonl');
}

function daemonRecords(root) {
  const dir = join(root, '.e2e-runtime');
  let names = [];
  try {
    names = readdirSync(dir).filter((name) => name.startsWith('daemon-') && name.endsWith('.json'));
  } catch {
    names = [];
  }
  return names
    .map((name) => readJson(join(dir, name)))
    .filter((entry) => entry !== null);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FAKE_RUNTIME = `// Fake Mebular runtime provider/daemon for coexistence E2E.
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { basename, dirname, join, resolve } from 'node:path';

const env = process.env;
const root = resolve(env.MEBULAR_CLOUD_ROOT || env.MEBULAR_HOME || process.cwd());
const home = resolve(env.MEBULAR_HOME || root);
const version = env.MEBULAR_RUNTIME_VERSION || '0.0.0-e2e';
const provider = env.MEBULAR_RUNTIME_PROVIDER || 'cli';
const args = process.argv.slice(2);
const portIndex = args.indexOf('--port');
const port = Number(portIndex >= 0 ? args[portIndex + 1] : (env.MEBULAR_HTTP_PORT || 7331));
const stateDir = join(root, '.e2e-runtime');
mkdirSync(stateDir, { recursive: true });
appendFileSync(join(stateDir, 'starts.jsonl'), JSON.stringify({
  pid: process.pid,
  root,
  home,
  version,
  provider,
  port,
  at: new Date().toISOString(),
}) + '\\n');
const instance = createHash('sha256').update(home.replace(/[/\\\\]+$/, '') || home).digest('hex').slice(0, 12);
const profileId = home === root ? 'default' : (dirname(home).endsWith('/profiles') ? basename(home) : 'default');
const daemonFile = join(stateDir, 'daemon-' + process.pid + '.json');
const heartbeatPath = join(home, 'service.heartbeat');
let listening = false;
let closing = false;
const beat = () => {
  try {
    mkdirSync(home, { recursive: true });
    const tmp = heartbeatPath + '.tmp-' + process.pid;
    writeFileSync(tmp, JSON.stringify({ pid: process.pid, ts: Date.now(), role: 'mebular-serve', sha: 'e2e' }), { mode: 0o600 });
    renameSync(tmp, heartbeatPath);
  } catch { /* heartbeat is best-effort */ }
};
beat();
const heartbeat = setInterval(beat, 500);
heartbeat.unref?.();
const cleanup = () => {
  clearInterval(heartbeat);
  try { rmSync(daemonFile, { force: true }); } catch {}
  try {
    const runtimeFile = join(home, 'runtime.json');
    const record = JSON.parse(readFileSync(runtimeFile, 'utf-8'));
    if (record.pid === process.pid) rmSync(runtimeFile, { force: true });
  } catch {}
};
const finish = (code) => {
  if (closing && code === 0 && !listening) return;
  closing = true;
  cleanup();
  process.exit(code);
};
const server = http.createServer((req, res) => {
  if (req.url && req.url.startsWith('/healthz')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      name: 'mebular',
      version,
      instance,
      cloudId: profileId,
      home,
      pid: process.pid,
    }));
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});
server.on('error', (error) => {
  appendFileSync(join(stateDir, 'errors.jsonl'), JSON.stringify({ pid: process.pid, code: error.code || 'error' }) + '\\n');
  cleanup();
  process.exit(error.code === 'EADDRINUSE' ? 3 : 1);
});
const listen = () => {
  server.listen(port, '127.0.0.1', () => {
    listening = true;
    writeFileSync(daemonFile, JSON.stringify({ pid: process.pid, root, home, port, version, provider }), { mode: 0o600 });
    try {
      writeFileSync(join(home, 'runtime.json'), JSON.stringify({
        version,
        pid: process.pid,
        http: { host: '127.0.0.1', port },
        consolePath: '/console',
        mcpPath: '/mcp',
        embedProtocol: 1,
      }), { mode: 0o600 });
    } catch {}
  });
};
const delay = Number(env.MEBULAR_E2E_START_DELAY_MS || 0);
if (delay > 0) setTimeout(listen, delay);
else listen();
const shutdown = () => {
  if (closing) return;
  closing = true;
  clearInterval(heartbeat);
  if (!listening) { cleanup(); process.exit(0); return; }
  server.close(() => finish(0));
  setTimeout(() => finish(0), 500).unref?.();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
`;

const FAKE_NPM = `#!/usr/bin/env node
// Fake npm: installs a fixed @mebular/core layout or fails deterministically.
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);
const prefixIndex = args.indexOf('--prefix');
const prefix = prefixIndex >= 0 ? args[prefixIndex + 1] : null;
const spec = args.find((entry) => entry.startsWith('@mebular/core@'));
const version = spec ? spec.slice('@mebular/core@'.length) : '0.0.0';
if (process.env.FAKE_NPM_COUNTER) {
  mkdirSync(dirname(process.env.FAKE_NPM_COUNTER), { recursive: true });
  appendFileSync(process.env.FAKE_NPM_COUNTER, JSON.stringify({ pid: process.pid, version, at: new Date().toISOString() }) + '\\n');
}
const delay = Number(process.env.FAKE_NPM_DELAY_MS || 0);
if (delay > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, delay));
const mode = process.env.FAKE_NPM_MODE || 'ok';
if (mode === 'offline') {
  console.error('npm error code ENOTFOUND');
  console.error('npm error network request to https://registry.npmjs.org/@mebular/core failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org');
  process.exit(1);
}
if (mode === 'integrity') {
  console.error('npm error code EINTEGRITY');
  console.error('npm error integrity checksum failed for @mebular/core');
  process.exit(1);
}
if (mode === 'http404') {
  console.error('npm error code E404');
  console.error('npm error 404 Not Found - GET https://registry.npmjs.org/@mebular/core');
  process.exit(1);
}
if (mode === 'half') {
  mkdirSync(join(prefix, 'node_modules', '@mebular', 'core'), { recursive: true });
  writeFileSync(join(prefix, 'node_modules', '@mebular', 'core', 'package.json'), JSON.stringify({ name: '@mebular/core', version: '0.0.0-bad' }));
  console.error('npm error code ENOENT');
  process.exit(1);
}
if (prefix === null || !spec) {
  console.error('fake npm: unsupported invocation');
  process.exit(2);
}
const core = join(prefix, 'node_modules', '@mebular', 'core');
const bin = join(core, 'packages', 'mcp', 'bin');
mkdirSync(bin, { recursive: true });
writeFileSync(join(core, 'package.json'), JSON.stringify({ name: '@mebular/core', version }, null, 2));
copyFileSync(process.env.FAKE_RUNTIME_SOURCE, join(bin, 'mebular.mjs'));
writeFileSync(join(core, 'packages', 'mcp', 'package.json'), JSON.stringify({ name: '@mebular/mcp', version }, null, 2));
console.log('added 1 package');
`;

const UPDATE_HARNESS = `// Offline check-update harness: real checkRuntimeUpdate + shared update lock.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { checkRuntimeUpdate } from ${JSON.stringify(pathToFileURL(join(mcpSrc, 'runtime-update.mjs')).href)};

const root = process.env.E2E_ROOT;
const counter = process.env.E2E_FETCH_COUNTER;
const latest = process.env.E2E_LATEST;
const fetchImpl = async (url) => {
  if (counter) {
    mkdirSync(dirname(counter), { recursive: true });
    appendFileSync(counter, JSON.stringify({ url, pid: process.pid, at: new Date().toISOString() }) + '\\n');
  }
  const delay = Number(process.env.E2E_FETCH_DELAY_MS || 0);
  if (delay > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, delay));
  return {
    ok: true,
    status: 200,
    async json() {
      return { name: '@mebular/core', version: latest };
    },
  };
};
const result = await checkRuntimeUpdate({
  root,
  force: process.env.E2E_FORCE !== '0',
  entry: process.env.E2E_ENTRY || 'cli',
  fetchImpl,
});
process.stdout.write(JSON.stringify(result));
process.exit(result.ok === true || result.status === 'busy' ? 0 : 2);
`;

const UPGRADE_HARNESS = `// Offline upgrade harness: real upgrade.lock + installer + fake npm.
import { upgradeRuntime } from ${JSON.stringify(pathToFileURL(join(mcpSrc, 'runtime-upgrade.mjs')).href)};

const result = await upgradeRuntime({
  to: process.env.E2E_TO,
  root: process.env.E2E_ROOT,
  entry: process.env.E2E_ENTRY || 'cli',
  env: process.env,
  serviceStatusFn: async () => ({ ok: true, registered: false, running: false, autostart: null, runtime: null }),
  installOptions: {
    npmPath: process.env.E2E_NPM_PATH,
    timeoutMs: 60000,
  },
});
process.stdout.write(JSON.stringify(result));
process.exit(result.ok === true ? 0 : 2);
`;

const LOCK_HOLDER_HARNESS = `// Hold runtime/upgrade.lock for a bounded time (another entry mid-upgrade).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { acquireRuntimeUpgradeLock } from ${JSON.stringify(pathToFileURL(join(mcpSrc, 'runtime-upgrade.mjs')).href)};

const root = process.env.E2E_ROOT;
const lock = await acquireRuntimeUpgradeLock(root, {
  entry: 'plugin',
  fromVersion: '9.9.10',
  toVersion: '9.9.11',
  attempts: 1,
});
if (lock.ok !== true) {
  process.stdout.write(JSON.stringify({ ok: false, reason: lock.reason || 'busy', holder: lock.holder ?? null }));
  process.exit(2);
}
mkdirSync(dirname(process.env.E2E_LOCK_READY), { recursive: true });
writeFileSync(process.env.E2E_LOCK_READY, 'locked');
await new Promise((resolvePromise) => setTimeout(resolvePromise, Number(process.env.E2E_LOCK_HOLD_MS || 900)));
await lock.release();
process.stdout.write(JSON.stringify({ ok: true, released: true }));
process.exit(0);
`;

const RECONNECT_HARNESS = `// App entry orchestrator: busy preflight -> bounded wait -> ensure (no second upgrade).
import { performRuntimeUpdate } from ${JSON.stringify(pathToFileURL(join(repoRoot, 'apps', 'desktop', 'src', 'main', 'runtime-updates.mjs')).href)};
import { inspectRuntimeUpgradeLock } from ${JSON.stringify(pathToFileURL(join(mcpSrc, 'runtime-upgrade.mjs')).href)};

const root = process.env.E2E_ROOT;
let upgradeCalls = 0;
let ensureCalls = 0;
const result = await performRuntimeUpdate({
  root,
  home: root,
  to: '9.9.11',
  entry: 'app',
  upgradeStatusFn: async () => {
    const lock = await inspectRuntimeUpgradeLock(root);
    return { busy: lock.busy === true, holder: lock.holder ?? null };
  },
  upgradeFn: async () => {
    upgradeCalls += 1;
    return { ok: true, action: 'upgrade' };
  },
  ensureFn: async () => {
    ensureCalls += 1;
    return { ok: true, mode: 'reused' };
  },
  reconnectTimeoutMs: 5000,
  reconnectIntervalMs: 40,
});
process.stdout.write(JSON.stringify({ result, upgradeCalls, ensureCalls }));
process.exit(result.busy === true && result.reconnectRequired === false ? 0 : 2);
`;

const SERVICE_HARNESS = `// Offline service harness: real @mebular/service manifest/unit + fake launchctl commands.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { resolveRuntimeContext } from ${JSON.stringify(pathToFileURL(join(mcpSrc, 'runtime-supervisor.mjs')).href)};
import { readRuntimeCurrent } from ${JSON.stringify(pathToFileURL(join(mcpSrc, 'runtime-current.mjs')).href)};
import {
  installRuntimeService,
  resolveRuntimeServiceSource,
  runtimeServiceStatus,
  uninstallRuntimeService,
} from ${JSON.stringify(pathToFileURL(join(mcpSrc, 'runtime-service.mjs')).href)};

// Load the worktree's service dist explicitly: a worktree may share node_modules
// with the primary checkout, so a bare import could resolve stale code.
const serviceLib = await import(${JSON.stringify(pathToFileURL(join(repoRoot, 'packages', 'service', 'dist', 'index.js')).href)});

const mode = process.argv[2] || 'install';
const root = process.env.E2E_ROOT;
const userHome = process.env.HOME;
const serviceHome = join(userHome, '.mebular', 'services');
const stateDir = join(root, '.e2e-runtime');
mkdirSync(stateDir, { recursive: true });
const statePath = join(stateDir, 'service-state.json');
const instancePath = join(stateDir, 'service-instance.json');
process.env.MEBULAR_SERVICE_HOME = serviceHome;

const readState = () => {
  try { return JSON.parse(readFileSync(statePath, 'utf-8')); } catch { return null; }
};
const writeState = (state) => writeFileSync(statePath, JSON.stringify(state, null, 2));
const sleepSync = (ms) => { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

const kill = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try { process.kill(pid, 'SIGTERM'); } catch { return; }
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; }
    sleepSync(50);
  }
  try { process.kill(pid, 'SIGKILL'); } catch {}
};

const startDaemon = (state, unitPath) => {
  const port = state.port;
  const child = spawn(state.execPath, state.args, {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      ...state.environment,
      MEBULAR_HTTP_PORT: String(port),
      MEBULAR_E2E_START_DELAY_MS: '0',
    },
  });
  child.unref();
  const record = join(root, '.e2e-runtime', 'daemon-' + child.pid + '.json');
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (existsSync(record)) {
      state.loaded = true;
      state.pid = child.pid;
      state.unitPath = unitPath;
      state.label = basename(unitPath, '.plist');
      writeState(state);
      return true;
    }
    sleepSync(25);
  }
  try { process.kill(child.pid, 'SIGKILL'); } catch {}
  return false;
};

const createRun = (state) => (cmd, argv) => {
  if (cmd !== 'launchctl') {
    return { code: 0, stdout: '', stderr: '' };
  }
  const action = argv[0];
  if (action === 'print') {
    const label = String(argv[1] || '').split('/').pop();
    if (!state || state.loaded !== true || state.label !== label) {
      return { code: 1, stdout: '', stderr: 'Could not find service' };
    }
    const envLines = Object.entries(state.environment)
      .map(([key, value]) => '        ' + key + ' => ' + value)
      .join('\\n');
    const argLines = state.args.map((entry) => '        ' + entry).join('\\n');
    return {
      code: 0,
      stderr: '',
      stdout: [
        argv[1] + ' = {',
        '\\tlabel = ' + label,
        '\\tpath = ' + state.unitPath,
        '\\tprogram = ' + state.execPath,
        '\\targuments = {',
        argLines,
        '\\t}',
        '\\tenvironment = {',
        envLines,
        '\\t}',
        '\\tworking directory = ' + state.home,
        '}',
      ].join('\\n'),
    };
  }
  if (action === 'bootstrap' || action === 'load') {
    const unitPath = argv[argv.length - 1];
    if (!state.loaded) {
      if (!startDaemon(state, unitPath)) return { code: 1, stdout: '', stderr: 'fake bootstrap failed' };
    }
    return { code: 0, stdout: '', stderr: '' };
  }
  if (action === 'bootout') {
    if (state && state.loaded === true) {
      kill(state.pid);
      state.loaded = false;
      state.pid = null;
      writeState(state);
    }
    return { code: 0, stdout: '', stderr: '' };
  }
  if (action === 'kickstart') {
    return { code: 0, stdout: '', stderr: '' };
  }
  return { code: 0, stdout: '', stderr: '' };
};

const context = await resolveRuntimeContext({ env: process.env });
if (!context.ok) {
  process.stdout.write(JSON.stringify({ ok: false, reason: context.reason || 'cloud_unavailable' }));
  process.exit(2);
}
const currentState = await readRuntimeCurrent(root);
const current = currentState.current;

if (mode === 'source') {
  const source = resolveRuntimeServiceSource({
    currentState,
    fallbackProvider: currentState.usable ? null : {
      kind: process.env.E2E_FALLBACK_KIND || 'app',
      path: process.env.E2E_FALLBACK_PATH,
      version: process.env.E2E_FALLBACK_VERSION || '9.9.8',
      owner: process.env.E2E_FALLBACK_KIND || 'app',
      execPath: process.execPath,
    },
  });
  process.stdout.write(JSON.stringify(source));
  process.exit(0);
}

if (mode === 'install') {
  const state = {
    loaded: false,
    pid: null,
    label: null,
    unitPath: null,
    home: context.home,
    port: context.http.port,
    execPath: current ? (current.owner === 'app' ? process.execPath : process.execPath) : process.execPath,
    args: [current.cliPath, 'serve', '--port', String(context.http.port)],
    environment: {
      MEBULAR_HOME: context.home,
      MEBULAR_CLOUD_ROOT: root,
      MEBULAR_RUNTIME_PROVIDER: 'shared',
      MEBULAR_RUNTIME_OWNER: 'shared',
      MEBULAR_RUNTIME_VERSION: current.version,
      MEBULAR_RUNTIME_PATH: current.cliPath,
      MEBULAR_RUNTIME_ROOT: current.runtimePath,
    },
  };
  writeState(state);
  const run = createRun(state);
  const install = await installRuntimeService({
    root,
    home: context.home,
    serviceHome: userHome,
    currentState,
    run,
    serviceLib,
    platform: 'darwin',
    now: Date.now(),
    sha: 'e2e',
  });
  const status = await runtimeServiceStatus({
    root,
    home: context.home,
    serviceHome: userHome,
    currentState,
    run,
    serviceLib,
    platform: 'darwin',
  });
  writeFileSync(instancePath, JSON.stringify({ pid: state.pid, label: state.label, unitPath: state.unitPath }, null, 2));
  const manifest = install.manifestPath ? JSON.parse(readFileSync(install.manifestPath, 'utf-8')) : null;
  process.stdout.write(JSON.stringify({
    install,
    status,
    manifest,
    manifestKeys: manifest ? Object.keys(manifest) : null,
    manifestRuntime: manifest?.runtime ?? null,
    current: currentState.current,
    home: context.home,
  }));
  process.exit(install.ok === true && install.running === true ? 0 : 2);
}

if (mode === 'status') {
  const run = createRun(readState());
  const status = await runtimeServiceStatus({
    root,
    home: context.home,
    serviceHome: userHome,
    currentState,
    run,
    serviceLib,
    platform: 'darwin',
  });
  process.stdout.write(JSON.stringify(status));
  process.exit(status.ok === true ? 0 : 2);
}

if (mode === 'uninstall') {
  const run = createRun(readState());
  const result = await uninstallRuntimeService({
    root,
    home: context.home,
    serviceHome: userHome,
    run,
    serviceLib,
    platform: 'darwin',
  });
  process.stdout.write(JSON.stringify(result));
  process.exit(result.ok === true ? 0 : 2);
}

process.stdout.write(JSON.stringify({ ok: false, reason: 'unknown_mode' }));
process.exit(2);
`;

function writeFixture(dir, name, content, { executable = false } = {}) {
  const path = join(dir, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (executable) chmodSync(path, 0o755);
  return path;
}

function buildFixtures() {
  const dir = mkdtempSync(join(tmpdir(), 'mebular-runtime-e2e-fixtures-'));
  const provider = writeFixture(dir, 'fake-runtime.mjs', FAKE_RUNTIME);
  const npmScript = writeFixture(dir, 'fake-npm.mjs', FAKE_NPM, { executable: true });
  const updateHarness = writeFixture(dir, 'check-update-harness.mjs', UPDATE_HARNESS);
  const upgradeHarness = writeFixture(dir, 'upgrade-harness.mjs', UPGRADE_HARNESS);
  const lockHolder = writeFixture(dir, 'lock-holder.mjs', LOCK_HOLDER_HARNESS);
  const reconnectHarness = writeFixture(dir, 'reconnect-harness.mjs', RECONNECT_HARNESS);
  const serviceHarness = writeFixture(dir, 'service-harness.mjs', SERVICE_HARNESS);
  const binDir = join(dir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const npmShim = join(binDir, process.platform === 'win32' ? 'npm.cmd' : 'npm');
  if (process.platform === 'win32') {
    writeFileSync(npmShim, `@echo off\r\n"${process.execPath}" "${npmScript}" %*\r\n`);
  } else {
    writeFileSync(npmShim, `#!/bin/sh\nexec "${process.execPath}" "${npmScript}" "$@"\n`);
    chmodSync(npmShim, 0o755);
  }
  return {
    dir,
    provider,
    npmScript,
    npmShim,
    updateHarness,
    upgradeHarness,
    lockHolder,
    reconnectHarness,
    serviceHarness,
    binDir,
  };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

let fixtures = null;
let sandbox = null;
const liveProcesses = new Set();

async function scenario(name, fn) {
  scenarios.push(name);
  const dir = mkdtempSync(join(sandbox, `${String(scenarios.length).padStart(2, '0')}-`));
  try {
    await fn({
      dir,
      root: join(dir, 'cloud'),
      userHome: join(dir, 'home'),
      dataMarker: join(dir, 'cloud', 'store.jsonl'),
    });
  } catch (error) {
    check(`${name}: scenario completed`, false, String(error?.stack ?? error).split('\n').slice(0, 6).join(' | '));
  } finally {
    for (const handle of liveProcesses) {
      if (handle.exitCode === null) {
        try { handle.proc.kill('SIGKILL'); } catch { /* already gone */ }
      }
    }
    liveProcesses.clear();
    killRecordedDaemons(dir);
    await sleep(100);
  }
}

function track(handle) {
  liveProcesses.add(handle);
  return handle;
}

function writeData(root, userHome) {
  mkdirSync(root, { recursive: true });
  mkdirSync(userHome, { recursive: true });
  writeFileSync(join(root, 'store.jsonl'), '{"kind":"e2e-data"}\n');
  writeFileSync(join(userHome, '.e2e-home-marker'), 'keep\n');
}

async function startExternalDaemon({ root, userHome, port, provider, binDir, delayMs = 0 }) {
  const handle = spawnNode([provider], {
    env: runtimeEnv({
      root,
      userHome,
      port,
      binDir,
      extra: {
        MEBULAR_HOME: root,
        MEBULAR_RUNTIME_PROVIDER: 'external',
        MEBULAR_RUNTIME_VERSION: '9.9.0',
        ...(delayMs > 0 ? { MEBULAR_E2E_START_DELAY_MS: String(delayMs) } : {}),
      },
    }),
  });
  track(handle);
  await waitFor(`external daemon :${port}`, () => fetchHealth(port), (health) => health !== null, { timeoutMs: 10000 });
  return handle;
}

async function installFakeRuntime({ root, userHome, binDir, version, counter, action = 'install', extraEnv = {} }) {
  const result = await runCli(['runtime', action, '--version', version, '--json'], {
    root,
    userHome,
    port: 7331,
    binDir,
    extraEnv: {
      FAKE_RUNTIME_SOURCE: fixtures.provider,
      ...(counter ? { FAKE_NPM_COUNTER: counter } : {}),
      ...extraEnv,
    },
    timeoutMs: 60000,
  });
  return result;
}

function readProviders(root) {
  const state = readJson(join(root, 'runtime-providers.json'), { providers: [] });
  return Array.isArray(state.providers) ? state.providers : [];
}

function readCurrent(root) {
  return readJson(join(root, 'runtime', 'current.json'));
}

function summarize() {
  const passed = checks.filter((entry) => entry.ok).length;
  const failed = checks.filter((entry) => !entry.ok);
  console.log('');
  console.log(`RUNTIME_COEXISTENCE_SUMMARY ${JSON.stringify({
    scenarios: scenarios.length,
    checks: checks.length,
    passed,
    failed: failed.length,
    skipped: [],
  })}`);
  if (failed.length > 0) {
    console.log('FAILED_CHECKS:');
    for (const entry of failed) console.log(` - ${entry.label}${entry.detail ? `: ${entry.detail}` : ''}`);
  }
  return failed.length === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

async function main() {
  if (process.platform === 'win32') {
    console.log('SKIP runtime coexistence E2E: the fake launchctl/service fixture is POSIX-only.');
    console.log('RUNTIME_COEXISTENCE_SUMMARY {"scenarios":0,"checks":0,"passed":0,"failed":0,"skipped":["win32"]}');
    return 0;
  }

  sandbox = mkdtempSync(join(tmpdir(), 'mebular-runtime-coexistence-'));
  fixtures = buildFixtures();

  // 1. 健康 daemon → attach；端口/instance 是真实 HTTP。
  await scenario('health-daemon-attach', async ({ root, userHome, dataMarker }) => {
    writeData(root, userHome);
    const port = await freePort();
    const external = await startExternalDaemon({
      root, userHome, port, provider: fixtures.provider, binDir: fixtures.binDir,
    });
    const externalPid = external.proc.pid;
    const events = readJsonl(eventsPath(root));
    check('health attach: external daemon recorded one start', events.length === 1, `events=${events.length}`);
    const result = await runCli(['runtime', 'resolve', '--json', '--port', String(port)], {
      root, userHome, port, binDir: fixtures.binDir,
    });
    check('health attach: CLI exited 0', result.code === 0, result.stderr.slice(-400));
    check('health attach: mode reused', result.json?.mode === 'reused', JSON.stringify(result.json));
    check('health attach: instance matches homeKey', result.json?.instance === homeKey(root),
      `instance=${result.json?.instance} expected=${homeKey(root)}`);
    check('health attach: no second provider start', readJsonl(eventsPath(root)).length === 1);
    check('health attach: data marker untouched', existsSync(dataMarker));
    check('health attach: external daemon still alive', pidAlive(externalPid));
    await stopProcess(external);
    await waitFor('external daemon gone', () => pidAlive(externalPid), (alive) => alive === false, { timeoutMs: 5000 });
  });

  // 2. 两个入口同时冷启动：一个 start lock 持有者、一个 attach，只有一个 daemon。
  await scenario('cold-start-one-daemon', async ({ root, userHome }) => {
    writeData(root, userHome);
    const port = await freePort();
    const registered = await runCli([
      'runtime', 'provider', 'add', '--kind', 'cli', '--path', fixtures.provider, '--version', '9.9.0', '--json',
    ], { root, userHome, port, binDir: fixtures.binDir });
    check('cold start: fake CLI provider registered', registered.code === 0, registered.stderr.slice(-300));
    const first = track(spawnSupervise({
      root, userHome, port, binDir: fixtures.binDir,
      extraEnv: { MEBULAR_E2E_START_DELAY_MS: '1200' },
    }));
    const lockPath = join(root, 'runtime-start.lock');
    await waitFor('start lock', () => readJson(lockPath), (lock) => lock?.pid === first.proc.pid, { timeoutMs: 8000 });
    const lock = readJson(lockPath);
    check('cold start: start lock holder is the first entry', lock?.pid === first.proc.pid);
    const second = track(spawnSupervise({
      root, userHome, port, binDir: fixtures.binDir,
      extraEnv: { MEBULAR_E2E_START_DELAY_MS: '1200' },
    }));
    const [firstResult, secondResult] = await Promise.all([
      waitJson(first),
      waitJson(second),
    ]);
    const modes = [firstResult.mode, secondResult.mode].sort();
    equal('cold start: exactly one child and one reused', modes, ['child', 'reused']);
    check('cold start: only one provider process started', readJsonl(eventsPath(root)).length === 1,
      `starts=${readJsonl(eventsPath(root)).length}`);
    const records = daemonRecords(root);
    check('cold start: exactly one daemon record', records.length === 1, `records=${records.length}`);
    const health = await waitFor('daemon health', () => fetchHealth(port), (value) => value !== null);
    check('cold start: health instance matches homeKey', health.instance === homeKey(root));
    check('cold start: start lock released after ready', !existsSync(lockPath));
    const childEntry = firstResult.mode === 'child' ? first : second;
    const childPid = records[0]?.pid;
    check('cold start: daemon pid alive', pidAlive(childPid));
    const stopped = await stopProcess(childEntry);
    check('cold start: child owner exits cleanly on SIGTERM', stopped.code === 0, `code=${stopped.code}`);
    await waitFor('child daemon exit', () => pidAlive(childPid), (alive) => alive === false, { timeoutMs: 8000 });
    check('cold start: only owned child was stopped', !pidAlive(childPid));
    const healthAfter = await fetchHealth(port);
    check('cold start: port is free after owner exit', healthAfter === null);
  });

  // 3. 一个 child 入口退出后，另一个入口可以重新启动同一 profile。
  await scenario('restart-after-child-exit', async ({ root, userHome }) => {
    writeData(root, userHome);
    const port = await freePort();
    const registered = await runCli([
      'runtime', 'provider', 'add', '--kind', 'cli', '--path', fixtures.provider, '--version', '9.9.0', '--json',
    ], { root, userHome, port, binDir: fixtures.binDir });
    check('restart: fake CLI provider registered', registered.code === 0, registered.stderr.slice(-300));
    const first = track(spawnSupervise({ root, userHome, port, binDir: fixtures.binDir }));
    const firstResult = await waitJson(first);
    check('restart: first entry owns child', firstResult.mode === 'child', JSON.stringify(firstResult));
    const firstPid = daemonRecords(root)[0]?.pid;
    await stopProcess(first);
    await waitFor('first daemon exit', () => pidAlive(firstPid), (alive) => alive === false, { timeoutMs: 8000 });
    const second = track(spawnSupervise({ root, userHome, port, binDir: fixtures.binDir }));
    const secondResult = await waitJson(second);
    check('restart: second entry starts the same profile', secondResult.mode === 'child');
    check('restart: second daemon has a new pid', daemonRecords(root)[0]?.pid !== firstPid,
      `first=${firstPid} second=${daemonRecords(root)[0]?.pid}`);
    check('restart: exactly one daemon record', daemonRecords(root).length === 1);
    await stopProcess(second);
  });

  // 4. 只停自己的 supervise，不杀外部 daemon（attach 两次后外部仍在）。
  await scenario('external-daemon-not-killed', async ({ root, userHome }) => {
    writeData(root, userHome);
    const port = await freePort();
    const external = await startExternalDaemon({
      root, userHome, port, provider: fixtures.provider, binDir: fixtures.binDir,
    });
    const externalPid = external.proc.pid;
    for (let index = 0; index < 2; index += 1) {
      const entry = track(spawnSupervise({ root, userHome, port, binDir: fixtures.binDir }));
      const result = await waitJson(entry);
      check(`external: attach ${index + 1} is reused`, result.mode === 'reused', JSON.stringify(result));
      const exit = await waitExit(entry);
      check(`external: attach ${index + 1} exits 0`, exit.code === 0);
      check(`external: external daemon alive after attach ${index + 1}`, pidAlive(externalPid));
    }
    check('external: still exactly one provider start', readJsonl(eventsPath(root)).length === 1);
    await stopProcess(external);
  });

  // 5. App/CLI provider 复用，不下载 runtime；无 current 时 fallback 到 App/CLI。
  await scenario('provider-app-no-download', async ({ root, userHome }) => {
    writeData(root, userHome);
    const port = await freePort();
    const add = await runCli([
      'runtime', 'provider', 'add',
      '--kind', 'app', '--path', fixtures.provider, '--version', '9.9.8', '--json',
    ], { root, userHome, port, binDir: fixtures.binDir });
    check('provider app: provider registered', add.code === 0 && add.json?.created === true, JSON.stringify(add.json));
    const resolve = await runCli(['runtime', 'resolve', '--json', '--port', String(port)], {
      root, userHome, port, binDir: fixtures.binDir,
    });
    check('provider app: resolve exits 0', resolve.code === 0, resolve.stderr.slice(-400));
    check('provider app: resolve selects app provider', resolve.json?.provider?.kind === 'app',
      JSON.stringify(resolve.json?.provider));
    check('provider app: no current runtime is installed', readCurrent(root) === null);
    check('provider app: no runtime directory exists', !existsSync(join(root, 'runtime')));
    const entry = track(spawnSupervise({ root, userHome, port, binDir: fixtures.binDir }));
    const ready = await waitJson(entry);
    check('provider app: supervise starts a child from app provider', ready.mode === 'child', JSON.stringify(ready));
    const events = readJsonl(eventsPath(root));
    check('provider app: started provider kind is app', events[0]?.provider === 'app', JSON.stringify(events[0]));
    check('provider app: fake npm was never invoked', !existsSync(join(root, '.e2e-runtime', 'npm-runs.jsonl')));
    check('provider app: no shared runtime was downloaded', !existsSync(join(root, 'runtime')));
    check('provider app: no current written', readCurrent(root) === null);
    await stopProcess(entry);

    const cliResolve = await runCli(['runtime', 'resolve', '--json', '--port', String(port)], {
      root, userHome, port, binDir: fixtures.binDir,
    });
    check('provider app: CLI self provider remains discoverable', cliResolve.json?.providers?.available?.some((item) => item.kind === 'cli') === true);
  });

  // 6. runtime install/current/provider 原子性 + service source 解析。
  await scenario('install-current-provider-atomic', async ({ root, userHome, dir }) => {
    writeData(root, userHome);
    const npmCounter = join(root, '.e2e-runtime', 'npm-runs.jsonl');
    const first = await installFakeRuntime({
      root, userHome, binDir: fixtures.binDir, version: '9.9.9', counter: npmCounter,
    });
    check('install: CLI exited 0', first.code === 0, first.stderr.slice(-500));
    check('install: result ok', first.json?.ok === true, JSON.stringify(first.json));
    check('install: current points at 9.9.9', readCurrent(root)?.version === '9.9.9', JSON.stringify(readCurrent(root)));
    check('install: provider registered as shared', readProviders(root).some((entry) => entry.kind === 'shared' && entry.version === '9.9.9'));
    check('install: installed package version matches', readJson(join(root, 'runtime', '9.9.9', 'node_modules', '@mebular', 'core', 'package.json'))?.version === '9.9.9');
    check('install: no staging/backup directories', listDir(join(root, 'runtime')).every((name) => !name.startsWith('.')), JSON.stringify(listDir(join(root, 'runtime'))));
    const installRuns = readJsonl(npmCounter).length;
    check('install: fake npm ran exactly once', installRuns === 1, `runs=${installRuns}`);

    const sourceShared = await runNode([fixtures.serviceHarness, 'source'], {
      env: runtimeEnv({ root, userHome, port: 7331, binDir: fixtures.binDir, extra: { E2E_ROOT: root } }),
    });
    check('current: service source is shared', sourceShared.json?.provider === 'shared' && sourceShared.json?.owner === 'shared',
      `${JSON.stringify(sourceShared.json)} stderr=${sourceShared.stderr.slice(-500)}`);
    check('current: service source version is current version', sourceShared.json?.version === '9.9.9', sourceShared.stderr.slice(-400));
    check('current: service source currentSource is main', sourceShared.json?.currentSource === 'main', sourceShared.stderr.slice(-400));

    const resolve = await runCli(['runtime', 'resolve', '--json', '--port', '7444'], {
      root, userHome, port: 7444, binDir: fixtures.binDir,
    });
    check('current: resolve sees a usable shared current', resolve.json?.currentUsable === true
      && resolve.json?.current?.version === '9.9.9', JSON.stringify(resolve.json?.current));
    check('current: resolve lists current as a shared provider', resolve.json?.providers?.entries?.some(
      (entry) => entry.kind === 'shared' && entry.source === 'current' && entry.version === '9.9.9',
    ) === true, JSON.stringify(resolve.json?.providers?.entries));
    check('current: documented provider priority keeps an available CLI entry win over shared',
      resolve.json?.provider?.kind === 'cli', JSON.stringify(resolve.json?.provider));
    check('current: resolve still reports child (no daemon)', resolve.json?.mode === 'child');

    const show = await runCli(['runtime', 'current', 'show', '--json'], { root, userHome, port: 7444, binDir: fixtures.binDir });
    check('current: current show exits 0', show.code === 0 && show.json?.usable === true);
    check('current: provider list contains shared', readProviders(root).filter((entry) => entry.kind === 'shared').length === 1);

    // 无 current 时：service 来源回退到 App，再回退到 CLI；都不下载。
    const noCurrentRoot = join(dir, 'no-current');
    const noCurrentHome = join(dir, 'no-current-home');
    mkdirSync(noCurrentRoot, { recursive: true });
    mkdirSync(noCurrentHome, { recursive: true });
    const sourceApp = await runNode([fixtures.serviceHarness, 'source'], {
      env: runtimeEnv({
        root: noCurrentRoot,
        userHome: noCurrentHome,
        port: 7331,
        binDir: fixtures.binDir,
        extra: {
          E2E_ROOT: noCurrentRoot,
          E2E_FALLBACK_KIND: 'app',
          E2E_FALLBACK_PATH: fixtures.provider,
          E2E_FALLBACK_VERSION: '9.9.8',
        },
      }),
    });
    check('fallback: no current + app provider -> app source', sourceApp.json?.provider === 'app'
      && sourceApp.json?.owner === 'app' && sourceApp.json?.currentSource === 'fallback', `${JSON.stringify(sourceApp.json)} stderr=${sourceApp.stderr.slice(-500)}`);
    const sourceCli = await runNode([fixtures.serviceHarness, 'source'], {
      env: runtimeEnv({
        root: noCurrentRoot,
        userHome: noCurrentHome,
        port: 7331,
        binDir: fixtures.binDir,
        extra: {
          E2E_ROOT: noCurrentRoot,
          E2E_FALLBACK_KIND: 'cli',
          E2E_FALLBACK_PATH: fixtures.provider,
          E2E_FALLBACK_VERSION: '9.9.8',
        },
      }),
    });
    check('fallback: no current + CLI provider -> cli source', sourceCli.json?.provider === 'cli'
      && sourceCli.json?.owner === 'cli', `${JSON.stringify(sourceCli.json)} stderr=${sourceCli.stderr.slice(-500)}`);
    check('fallback: no download or current written', !existsSync(join(noCurrentRoot, 'runtime')));

    // 失败重装：旧 current/runtime/provider 保留，无半安装。
    const offline = await installFakeRuntime({
      root, userHome, binDir: fixtures.binDir, version: '9.9.9',
      counter: npmCounter,
      action: 'reinstall',
      extraEnv: { FAKE_NPM_MODE: 'offline' },
    });
    check('reinstall failure: CLI exit 2', offline.code === 2, `code=${offline.code}`);
    check('reinstall failure: reason offline', offline.json?.reason === 'offline', JSON.stringify(offline.json));
    check('reinstall failure: current still 9.9.9', readCurrent(root)?.version === '9.9.9');
    check('reinstall failure: runtime directory preserved', existsSync(join(root, 'runtime', '9.9.9', 'node_modules', '@mebular', 'core', 'package.json')));
    check('reinstall failure: provider still 9.9.9', readProviders(root).filter((entry) => entry.kind === 'shared').length === 1
      && readProviders(root).find((entry) => entry.kind === 'shared')?.version === '9.9.9');
    check('reinstall failure: no staging directory left', listDir(join(root, 'runtime')).every((name) => !name.startsWith('.tmp-install-')));
    check('reinstall failure: data marker preserved', existsSync(join(root, 'store.jsonl')));

    const newVersionFail = await installFakeRuntime({
      root, userHome, binDir: fixtures.binDir, version: '9.9.12',
      counter: npmCounter,
      extraEnv: { FAKE_NPM_MODE: 'http404' },
    });
    check('install new version failure: reason http_error', newVersionFail.json?.reason === 'http_error', JSON.stringify(newVersionFail.json));
    check('install new version failure: current unchanged', readCurrent(root)?.version === '9.9.9');
    check('install new version failure: target directory absent', !existsSync(join(root, 'runtime', '9.9.12')));
    check('install new version failure: no staging left', listDir(join(root, 'runtime')).every((name) => !name.startsWith('.tmp-install-')));
  });

  // 7. 两个入口同时 install：install lock 只放行一个。
  await scenario('install-lock-one-winner', async ({ root, userHome }) => {
    writeData(root, userHome);
    const counter = join(root, '.e2e-runtime', 'npm-runs.jsonl');
    const envExtra = {
      FAKE_RUNTIME_SOURCE: fixtures.provider,
      FAKE_NPM_COUNTER: counter,
      FAKE_NPM_DELAY_MS: '1200',
    };
    const args = ['runtime', 'install', '--version', '9.9.10', '--json'];
    const first = track(spawnNode([cliPath, ...args], {
      env: runtimeEnv({ root, userHome, port: 7331, binDir: fixtures.binDir, extra: envExtra }),
    }));
    const second = track(spawnNode([cliPath, ...args], {
      env: runtimeEnv({ root, userHome, port: 7331, binDir: fixtures.binDir, extra: envExtra }),
    }));
    const [a, b] = await Promise.all([waitJson(first), waitJson(second)]);
    await Promise.all([waitExit(first), waitExit(second)]);
    const okCount = [a, b].filter((entry) => entry.ok === true).length;
    const locked = [a, b].filter((entry) => entry.reason === 'install_locked').length;
    check('install lock: exactly one winner', okCount === 1, JSON.stringify([a.reason, b.reason]));
    check('install lock: exactly one install_locked', locked === 1, JSON.stringify([a.reason, b.reason]));
    check('install lock: current is 9.9.10', readCurrent(root)?.version === '9.9.10');
    check('install lock: fake npm ran once', readJsonl(counter).length === 1, `runs=${readJsonl(counter).length}`);
    check('install lock: no staging left', listDir(join(root, 'runtime')).every((name) => !name.startsWith('.tmp-install-')));
  });

  // 8. check-update 跨入口共享 lock：一个请求，另一个 busy；skip 两端共享。
  await scenario('update-check-lock', async ({ root, userHome }) => {
    writeData(root, userHome);
    const install = await installFakeRuntime({ root, userHome, binDir: fixtures.binDir, version: '9.9.10' });
    check('update lock: base runtime installed', install.json?.ok === true, JSON.stringify(install.json));
    const fetchCounter = join(root, '.e2e-runtime', 'fetch-runs.jsonl');
    const makeHarness = (entry) => track(spawnNode([fixtures.updateHarness], {
      env: runtimeEnv({
        root, userHome, port: 7331, binDir: fixtures.binDir,
        extra: {
          E2E_ROOT: root,
          E2E_FETCH_COUNTER: fetchCounter,
          E2E_LATEST: '9.9.11',
          E2E_FETCH_DELAY_MS: '900',
          E2E_ENTRY: entry,
        },
      }),
    }));
    const first = makeHarness('app');
    const second = makeHarness('plugin');
    const [a, b] = await Promise.all([waitJson(first), waitJson(second)]);
    await Promise.all([waitExit(first), waitExit(second)]);
    const available = [a, b].filter((entry) => entry.status === 'update_available');
    const busy = [a, b].filter((entry) => entry.status === 'busy');
    check('update lock: exactly one entry fetched update', available.length === 1, JSON.stringify([a.status, b.status]));
    check('update lock: other entry reports busy', busy.length === 1, JSON.stringify([a.status, b.status]));
    check('update lock: fake registry fetched once', readJsonl(fetchCounter).length === 1,
      `fetches=${readJsonl(fetchCounter).length}`);
    check('update lock: latest version is 9.9.11', available[0]?.latestVersion === '9.9.11');
    check('update lock: available entry reports prompted false initially', available[0]?.prompted === false
      || available[0]?.prompted === undefined, JSON.stringify(available[0]?.prompted));

    const skip = await runCli(['runtime', 'update-state', 'skip', '--version', '9.9.11', '--json'], {
      root, userHome, port: 7331, binDir: fixtures.binDir,
    });
    check('update lock: skip writes shared state', skip.code === 0 && skip.json?.state?.skippedVersion === '9.9.11', JSON.stringify(skip.json));
    const prompted = await runCli(['runtime', 'update-state', 'prompted', '--version', '9.9.11', '--json'], {
      root, userHome, port: 7331, binDir: fixtures.binDir,
    });
    check('update lock: prompted writes shared state', prompted.code === 0 && prompted.json?.state?.promptedVersion === '9.9.11');
    const skippedHarness = await runNode([fixtures.updateHarness], {
      env: runtimeEnv({
        root, userHome, port: 7331, binDir: fixtures.binDir,
        extra: {
          E2E_ROOT: root,
          E2E_FETCH_COUNTER: join(root, '.e2e-runtime', 'fetch-runs-2.jsonl'),
          E2E_LATEST: '9.9.11',
          E2E_ENTRY: 'cli',
        },
      }),
    });
    check('update lock: skipped version is not offered', skippedHarness.json?.decision === 'skipped'
      && skippedHarness.json?.available === false, JSON.stringify(skippedHarness.json));
    check('update lock: prompted version is shared', skippedHarness.json?.prompted === true);
  });

  // 9. upgrade 跨入口共享 lock：一个执行，另一个 busy；current/provider 收敛到新版本。
  await scenario('upgrade-lock-and-apply', async ({ root, userHome }) => {
    writeData(root, userHome);
    const install = await installFakeRuntime({ root, userHome, binDir: fixtures.binDir, version: '9.9.10' });
    check('upgrade lock: base runtime installed', install.json?.ok === true);
    const npmCounter = join(root, '.e2e-runtime', 'npm-runs.jsonl');
    const makeHarness = (entry) => track(spawnNode([fixtures.upgradeHarness], {
      env: runtimeEnv({
        root, userHome, port: 7331, binDir: fixtures.binDir,
        extra: {
          E2E_ROOT: root,
          E2E_TO: '9.9.11',
          E2E_ENTRY: entry,
          E2E_NPM_PATH: fixtures.npmScript,
          FAKE_RUNTIME_SOURCE: fixtures.provider,
          FAKE_NPM_COUNTER: npmCounter,
          FAKE_NPM_DELAY_MS: '1000',
        },
      }),
    }));
    const first = makeHarness('app');
    const second = makeHarness('plugin');
    const [a, b] = await Promise.all([waitJson(first), waitJson(second)]);
    await Promise.all([waitExit(first), waitExit(second)]);
    const okCount = [a, b].filter((entry) => entry.ok === true).length;
    const busy = [a, b].filter((entry) => entry.busy === true || entry.reason === 'busy').length;
    check('upgrade lock: exactly one upgrade runs', okCount === 1, JSON.stringify([a.reason, b.reason]));
    check('upgrade lock: other entry is busy', busy === 1, JSON.stringify([a.reason, b.reason]));
    check('upgrade lock: fake npm ran once', readJsonl(npmCounter).length === 1, `runs=${readJsonl(npmCounter).length}`);
    check('upgrade lock: current is 9.9.11', readCurrent(root)?.version === '9.9.11');
    check('upgrade lock: provider shared is 9.9.11', readProviders(root).find((entry) => entry.kind === 'shared')?.version === '9.9.11');
    const upgradeState = await runCli(['runtime', 'upgrade-state', 'show', '--json'], {
      root, userHome, port: 7331, binDir: fixtures.binDir,
    });
    check('upgrade lock: state is not upgrading', upgradeState.json?.state?.upgrading === false, JSON.stringify(upgradeState.json?.state));
    check('upgrade lock: state records target 9.9.11', upgradeState.json?.state?.toVersion === '9.9.11');
    check('upgrade lock: upgrade.lock released', upgradeState.json?.lock?.busy === false);
    check('upgrade lock: data marker preserved', existsSync(join(root, 'store.jsonl')));
  });

  // 10. busy 的另一入口有界等待并 reconnect，不重复执行升级。
  await scenario('update-busy-reconnect', async ({ root, userHome }) => {
    writeData(root, userHome);
    const install = await installFakeRuntime({ root, userHome, binDir: fixtures.binDir, version: '9.9.10' });
    check('busy reconnect: base runtime installed', install.json?.ok === true);
    const readyPath = join(root, '.e2e-runtime', 'lock-ready');
    const holder = track(spawnNode([fixtures.lockHolder], {
      env: runtimeEnv({
        root, userHome, port: 7331, binDir: fixtures.binDir,
        extra: {
          E2E_ROOT: root,
          E2E_LOCK_READY: readyPath,
          E2E_LOCK_HOLD_MS: '900',
        },
      }),
    }));
    await waitFor('upgrade lock ready', () => existsSync(readyPath), (ready) => ready === true, { timeoutMs: 8000 });
    const reconnect = await runNode([fixtures.reconnectHarness], {
      env: runtimeEnv({
        root, userHome, port: 7331, binDir: fixtures.binDir,
        extra: { E2E_ROOT: root },
      }),
      timeoutMs: 30000,
    });
    check('busy reconnect: orchestrator exits 0', reconnect.code === 0, reconnect.stderr.slice(-600));
    check('busy reconnect: entry reports busy', reconnect.json?.result?.busy === true, JSON.stringify(reconnect.json?.result));
    check('busy reconnect: upgrade was not executed twice', reconnect.json?.upgradeCalls === 0, JSON.stringify(reconnect.json));
    check('busy reconnect: entry re-ensured the runtime', reconnect.json?.ensureCalls === 1, JSON.stringify(reconnect.json));
    check('busy reconnect: wait settled without timeout', reconnect.json?.result?.reconnectRequired === false);
    const holderExit = await waitExit(holder, 8000);
    check('busy reconnect: lock holder released', holderExit.code === 0);
    const state = await runCli(['runtime', 'upgrade-state', 'show', '--json'], {
      root, userHome, port: 7331, binDir: fixtures.binDir,
    });
    check('busy reconnect: shared upgrade lock is idle', state.json?.lock?.busy === false, JSON.stringify(state.json?.lock));
    check('busy reconnect: current was not changed by the waiting entry', readCurrent(root)?.version === '9.9.10');
  });

  // 11. 升级失败：保留旧 current/runtime/provider/service，不半安装。
  await scenario('upgrade-failure-rollback', async ({ root, userHome }) => {
    writeData(root, userHome);
    const install = await installFakeRuntime({ root, userHome, binDir: fixtures.binDir, version: '9.9.11' });
    check('upgrade failure: base runtime installed', install.json?.ok === true);
    const npmCounter = join(root, '.e2e-runtime', 'npm-runs.jsonl');
    const result = await runNode([fixtures.upgradeHarness], {
      env: runtimeEnv({
        root, userHome, port: 7331, binDir: fixtures.binDir,
        extra: {
          E2E_ROOT: root,
          E2E_TO: '9.9.12',
          E2E_ENTRY: 'app',
          E2E_NPM_PATH: fixtures.npmScript,
          FAKE_RUNTIME_SOURCE: fixtures.provider,
          FAKE_NPM_COUNTER: npmCounter,
          FAKE_NPM_MODE: 'offline',
        },
      }),
      timeoutMs: 60000,
    });
    check('upgrade failure: result not ok', result.json?.ok === false, JSON.stringify(result.json));
    check('upgrade failure: reason offline', result.json?.reason === 'offline', JSON.stringify(result.json));
    check('upgrade failure: current remains 9.9.11', readCurrent(root)?.version === '9.9.11');
    check('upgrade failure: provider remains 9.9.11', readProviders(root).find((entry) => entry.kind === 'shared')?.version === '9.9.11');
    check('upgrade failure: old runtime directory preserved', existsSync(join(root, 'runtime', '9.9.11', 'node_modules', '@mebular', 'core', 'package.json')));
    check('upgrade failure: failed target directory absent', !existsSync(join(root, 'runtime', '9.9.12')));
    check('upgrade failure: no staging left', listDir(join(root, 'runtime')).every((name) => !name.startsWith('.tmp-install-')));
    check('upgrade failure: data marker preserved', existsSync(join(root, 'store.jsonl')));
    const state = await runCli(['runtime', 'upgrade-state', 'show', '--json'], { root, userHome, port: 7331, binDir: fixtures.binDir });
    check('upgrade failure: state records failed rollback', state.json?.state?.upgrading === false
      && state.json?.state?.reason === 'offline', JSON.stringify(state.json?.state));
  });

  // 12. service：current -> shared descriptor/manifest；入口退出 daemon 继续；卸载保留 runtime/provider/data。
  await scenario('service-shared-and-uninstall', async ({ root, userHome }) => {
    writeData(root, userHome);
    const port = await freePort();
    const install = await installFakeRuntime({ root, userHome, binDir: fixtures.binDir, version: '9.9.11' });
    check('service: shared runtime installed', install.json?.ok === true, JSON.stringify(install.json));
    const dataText = readFileSync(join(root, 'store.jsonl'), 'utf-8');
    const serviceEnv = runtimeEnv({ root, userHome, port, binDir: fixtures.binDir, extra: {
      E2E_ROOT: root,
      E2E_HTTP_PORT: String(port),
    } });
    const serviceInstall = await runNode([fixtures.serviceHarness, 'install'], {
      env: serviceEnv,
      timeoutMs: 60000,
    });
    check('service: install exits 0', serviceInstall.code === 0, serviceInstall.stderr.slice(-800));
    const info = serviceInstall.json;
    check('service: install ok and started', info?.install?.ok === true && info?.install?.running === true, JSON.stringify(info?.install));
    check('service: manifest file was returned', typeof info?.install?.manifestPath === 'string', JSON.stringify(info?.install?.manifestPath));
    check('service: manifest is readable', info?.manifest !== null && typeof info?.manifest === 'object', JSON.stringify(info?.manifestKeys));
    check('service: status registered/running', info?.status?.registered === true && info?.status?.running === true, JSON.stringify(info?.status));
    check('service: status version is current 9.9.11', info?.status?.version === '9.9.11');
    check('service: manifest runtime block present', info?.manifestRuntime !== null && typeof info?.manifestRuntime === 'object',
      `keys=${JSON.stringify(info?.manifestKeys)} runtime=${JSON.stringify(info?.manifestRuntime)} path=${info?.install?.manifestPath}`);
    check('service: manifest runtime.version 9.9.11', info?.manifest?.runtime?.version === '9.9.11', JSON.stringify(info?.manifestRuntime));
    check('service: manifest runtime.provider shared', info?.manifest?.runtime?.provider === 'shared');
    check('service: manifest runtime.owner shared', info?.manifest?.runtime?.owner === 'shared');
    check('service: manifest runtime.cliPath points at shared current', info?.manifest?.runtime?.cliPath === readCurrent(root)?.cliPath);
    check('service: manifest runtime.runtimePath points at runtime/<version>', info?.manifest?.runtime?.runtimePath === join(root, 'runtime', '9.9.11'));
    check('service: manifest runtime.home is profile home', info?.manifest?.runtime?.home === info?.home, `${info?.manifest?.runtime?.home} vs ${info?.home}`);
    check('service: manifest runtime.cloudRoot is shared root', info?.manifest?.runtime?.cloudRoot === root);
    check('service: unit lives outside cloudRoot', typeof info?.install?.unitPath === 'string'
      && info.install.unitPath.startsWith(userHome) && !info.install.unitPath.startsWith(root));
    const daemonPid = info?.status?.heartbeat?.pid ?? readJson(join(root, '.e2e-runtime', 'service-instance.json'))?.pid;
    check('service: daemon pid recorded', Number.isInteger(daemonPid), String(daemonPid));
    check('service: daemon survives the installing entry exit', pidAlive(daemonPid));
    await waitFor('service daemon health', () => fetchHealth(port), (health) => health !== null, { timeoutMs: 5000 });

    const attach = await runCli(['runtime', 'resolve', '--json', '--port', String(port)], {
      root, userHome, port, binDir: fixtures.binDir,
    });
    check('service: another entry attaches to the service daemon', attach.json?.mode === 'reused', JSON.stringify(attach.json));
    check('service: no second daemon started', readJsonl(eventsPath(root)).length === 1, `starts=${readJsonl(eventsPath(root)).length}`);

    const serviceUninstall = await runNode([fixtures.serviceHarness, 'uninstall'], {
      env: serviceEnv,
      timeoutMs: 30000,
    });
    check('uninstall: exits 0', serviceUninstall.code === 0, serviceUninstall.stderr.slice(-500));
    check('uninstall: service removed', serviceUninstall.json?.ok === true && serviceUninstall.json?.removed === true, JSON.stringify(serviceUninstall.json));
    await waitFor('service daemon stopped', () => pidAlive(daemonPid), (alive) => alive === false, { timeoutMs: 6000 });
    check('uninstall: service daemon stopped', !pidAlive(daemonPid));
    check('uninstall: runtime current preserved', readCurrent(root)?.version === '9.9.11');
    check('uninstall: runtime directory preserved', existsSync(join(root, 'runtime', '9.9.11', 'node_modules', '@mebular', 'core', 'package.json')));
    check('uninstall: shared provider preserved', readProviders(root).some((entry) => entry.kind === 'shared' && entry.version === '9.9.11'));
    check('uninstall: data preserved byte-for-byte', readFileSync(join(root, 'store.jsonl'), 'utf-8') === dataText);
    check('uninstall: unit file removed', serviceUninstall.json?.unitPath === null || !existsSync(serviceUninstall.json.unitPath));
    check('uninstall: manifest removed', serviceUninstall.json?.manifestPath === null || !existsSync(serviceUninstall.json.manifestPath));
  });

  // 13. 入口退出/卸载不删除 runtime/provider/data；CLI 诊断不应有副作用。
  await scenario('entry-exit-preserves-shared-state', async ({ root, userHome }) => {
    writeData(root, userHome);
    const install = await installFakeRuntime({ root, userHome, binDir: fixtures.binDir, version: '9.9.11' });
    check('preserve: base runtime installed', install.json?.ok === true);
    const beforeCurrent = readFileSync(join(root, 'runtime', 'current.json'), 'utf-8');
    const beforeProviders = readFileSync(join(root, 'runtime-providers.json'), 'utf-8');
    const beforeData = readFileSync(join(root, 'store.jsonl'), 'utf-8');
    for (const args of [
      ['runtime', 'status', '--json'],
      ['runtime', 'resolve', '--json'],
      ['runtime', 'current', 'show', '--json'],
      ['runtime', 'provider', 'list', '--json'],
    ]) {
      const result = await runCli(args, { root, userHome, port: 7331, binDir: fixtures.binDir });
      check(`preserve: ${args.join(' ')} exits 0`, result.code === 0, result.stderr.slice(-300));
    }
    check('preserve: current byte-identical after entry diagnostics', readFileSync(join(root, 'runtime', 'current.json'), 'utf-8') === beforeCurrent);
    check('preserve: providers byte-identical after entry diagnostics', readFileSync(join(root, 'runtime-providers.json'), 'utf-8') === beforeProviders);
    check('preserve: data byte-identical after entry diagnostics', readFileSync(join(root, 'store.jsonl'), 'utf-8') === beforeData);
    check('preserve: runtime directory still present', existsSync(join(root, 'runtime', '9.9.11')));
  });

  return summarize();
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (error) {
  console.error(`FATAL ${error?.stack ?? error}`);
  console.log(`RUNTIME_COEXISTENCE_SUMMARY ${JSON.stringify({
    scenarios: scenarios.length,
    checks: checks.length,
    passed: checks.filter((entry) => entry.ok).length,
    failed: checks.filter((entry) => !entry.ok).length + 1,
    skipped: [],
  })}`);
  exitCode = 1;
} finally {
  for (const handle of liveProcesses) {
    if (handle.exitCode === null) {
      try { handle.proc.kill('SIGKILL'); } catch { /* already gone */ }
    }
  }
  liveProcesses.clear();
  if (sandbox !== null) await sleep(150);
  if (sandbox !== null) killRecordedDaemons(sandbox);
  for (const dir of [sandbox, fixtures?.dir]) {
    if (typeof dir === 'string' && dir.length > 0) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}
process.exit(exitCode);
