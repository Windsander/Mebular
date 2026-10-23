#!/usr/bin/env node
// Mebular 桌面 App · 发布 runtime 冒烟（无 GUI、无固定端口、不留进程/临时目录）
//
// 从 <runtime>/node_modules/@mebular/core/packages/mcp/bin/mebular.mjs 启动 `serve`，
// 用系统分配的端口（--port 0）等待 /healthz，然后校验：
//   - /healthz                status=ok
//   - /app/embed/info         loopback=true / embedProtocol=1 / embedUrl 含 ?embed=dsh
//   - /console/?embed=dsh     CSP 允许 loopback frame，且没有 X-Frame-Options: DENY
//   - /console/               普通控制台仍 X-Frame-Options: DENY
//
// 用法：
//   node apps/desktop/scripts/smoke-runtime.mjs
//   node apps/desktop/scripts/smoke-runtime.mjs --runtime apps/desktop/runtime
//   node apps/desktop/scripts/smoke-runtime.mjs --runtime apps/desktop/dist/mac-arm64/Mebular.app/Contents/Resources
//
// 超时 / 断言失败均以非 0 退出。

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..');
const READY_TIMEOUT_MS = 45_000;
const HEALTH_TIMEOUT_MS = 20_000;

let passed = 0;
let failed = 0;
function check(label, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${label}${detail ? `（${detail}）` : ''}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label}${detail ? `（${detail}）` : ''}`);
  }
}

function fail(message) {
  console.error(`✗ [desktop:smoke-runtime] ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i]);
    if (token === '--help' || token === '-h') return { help: true };
    if (token === '--runtime') {
      const value = argv[i + 1];
      if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
        fail('参数 --runtime 缺少目录值');
      }
      out.runtime = value;
      i += 1;
      continue;
    }
    if (token.startsWith('--runtime=')) {
      const value = token.slice('--runtime='.length);
      if (value.length === 0) fail('参数 --runtime 缺少目录值');
      out.runtime = value;
      continue;
    }
    fail(`未知参数：${token}`);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(`用法：node apps/desktop/scripts/smoke-runtime.mjs [--runtime <dir>]

  --runtime <dir>  runtime 根目录（含 node_modules），默认 apps/desktop/runtime
                   也可以直接指向打包后的 <resources> 目录。
`);
  process.exit(0);
}

const runtimeDir = args.runtime ? resolve(process.cwd(), args.runtime) : join(appDir, 'runtime');
const cliBin = join(runtimeDir, 'node_modules', '@mebular', 'core', 'packages', 'mcp', 'bin', 'mebular.mjs');
if (!existsSync(cliBin)) {
  fail(`找不到 runtime CLI：${cliBin}\n  请先执行 apps/desktop 的 npm run prepare:runtime，或传入正确的 --runtime。`);
}

const home = mkdtempSync(join(tmpdir(), 'mebular-desktop-smoke-'));
const runtimeFile = join(home, 'runtime.json');

// 删除会干扰「安装包自带 console/locales」验证的测试用环境变量；home 必须隔离到临时目录。
const childEnv = { ...process.env };
for (const key of [
  'MEBULAR_CONSOLE_DIR', 'MEBULAR_LOCALES_DIR', 'MEBULAR_HTTP_HOST', 'MEBULAR_HTTP_PORT',
  'MEBULAR_STORAGE_PATH', 'MEBULAR_DEVICE_ID', 'MEBULAR_DEVICE_NAME', 'ELECTRON_RUN_AS_NODE',
]) {
  delete childEnv[key];
}
childEnv.MEBULAR_HOME = home;

console.log('Mebular 桌面发布 runtime 冒烟');
console.log('===============================');
console.log(`runtime: ${runtimeDir}`);
console.log(`home:    ${home}`);

let child = null;
let stdout = '';
let stderr = '';
let port = null;
let base = null;

function tail(text, max = 4000) {
  const value = String(text ?? '');
  return value.length > max ? value.slice(-max) : value;
}

function readPortFromRuntimeFile() {
  try {
    const data = JSON.parse(readFileSync(runtimeFile, 'utf-8'));
    const value = data?.http?.port;
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function readPortFromStdout() {
  for (const line of String(stdout).split('\n')) {
    const match = /^(?:SERVE_READY|PROVISION_READY) (\{.*\})$/.exec(line.trim());
    if (!match) continue;
    try {
      const data = JSON.parse(match[1]);
      if (Number.isInteger(data.port) && data.port > 0) return data.port;
    } catch {
      // 继续找下一行
    }
  }
  return null;
}

function wait(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function hasExited(target) {
  return !target || target.exitCode !== null || typeof target.signalCode === 'string';
}

function waitForExit(target, timeoutMs) {
  if (hasExited(target)) return Promise.resolve(true);
  return new Promise((resolvePromise) => {
    let done = false;
    const finish = (exited) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      target.off?.('exit', onExit);
      resolvePromise(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    target.once('exit', onExit);
  });
}

async function stopChild() {
  if (hasExited(child)) return true;
  child.kill('SIGTERM');
  if (await waitForExit(child, 5000)) return true;
  try {
    child.kill('SIGKILL');
  } catch {
    // 已退出
  }
  return waitForExit(child, 3000);
}

function cleanupSync() {
  if (child && !hasExited(child)) {
    try {
      child.kill('SIGKILL');
    } catch {
      // 已退出
    }
  }
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // 清理失败不覆盖原始错误；进程退出后 OS 会回收
  }
}

async function waitForPort(deadline) {
  while (Date.now() < deadline) {
    const fromFile = readPortFromRuntimeFile();
    if (fromFile) return fromFile;
    const fromStdout = readPortFromStdout();
    if (fromStdout) return fromStdout;
    if (hasExited(child)) {
      throw new Error(`serve 提前退出（code=${child.exitCode ?? 'null'}, signal=${child.signalCode ?? 'none'}）\n${tail(stderr)}`);
    }
    await wait(100);
  }
  throw new Error(`等待 serve 启动超时（${READY_TIMEOUT_MS}ms）\n${tail(stderr)}`);
}

async function fetchWithTimeout(url, timeoutMs = 3000) {
  return fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
}

async function waitForHealth(deadline) {
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetchWithTimeout(`${base}/healthz`);
      if (res.ok) return { res, body: await res.json() };
      lastError = new Error(`/healthz HTTP ${res.status}`);
    } catch (error) {
      lastError = error;
    }
    if (hasExited(child)) {
      throw new Error(`serve 在健康检查期间退出（code=${child.exitCode ?? 'null'}, signal=${child.signalCode ?? 'none'}）\n${tail(stderr)}`);
    }
    await wait(150);
  }
  throw new Error(`等待 /healthz 超时（${HEALTH_TIMEOUT_MS}ms）：${String(lastError?.message ?? lastError)}`);
}

const hardTimeout = setTimeout(() => {
  console.error(`✗ [desktop:smoke-runtime] 总超时（${READY_TIMEOUT_MS + HEALTH_TIMEOUT_MS}ms）`);
  cleanupSync();
  process.exit(1);
}, READY_TIMEOUT_MS + HEALTH_TIMEOUT_MS);
hardTimeout.unref();

try {
  child = spawn(process.execPath, [cliBin, 'serve', '--host', '127.0.0.1', '--port', '0'], {
    cwd: runtimeDir,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.on('error', (error) => {
    stderr += `\nspawn error: ${String(error?.message ?? error)}`;
  });
  child.stdout.on('data', (chunk) => {
    stdout = tail(`${stdout}${chunk}`, 20000);
  });
  child.stderr.on('data', (chunk) => {
    stderr = tail(`${stderr}${chunk}`, 20000);
  });

  port = await waitForPort(Date.now() + READY_TIMEOUT_MS);
  base = `http://127.0.0.1:${port}`;
  console.log(`port:    ${port}（系统分配）`);
  const { res: healthRes, body: health } = await waitForHealth(Date.now() + HEALTH_TIMEOUT_MS);

  check('/healthz 返回 200 且 status=ok',
    healthRes.status === 200 && health?.status === 'ok',
    `HTTP ${healthRes.status}, status=${String(health?.status)}`);

  const infoRes = await fetchWithTimeout(`${base}/app/embed/info`);
  const info = await infoRes.json().catch(() => null);
  check('/app/embed/info：loopback=true、embedProtocol=1',
    infoRes.status === 200 && info?.loopback === true && info?.embedProtocol === 1,
    `HTTP ${infoRes.status}, loopback=${String(info?.loopback)}, embedProtocol=${String(info?.embedProtocol)}`);
  check('/app/embed/info：embedUrl 指向 ?embed=dsh',
    typeof info?.embedUrl === 'string' && info.embedUrl.includes('?embed=dsh'),
    String(info?.embedUrl));

  const embedRes = await fetchWithTimeout(`${base}/console/?embed=dsh`);
  const embedCsp = embedRes.headers.get('content-security-policy') ?? '';
  const embedXfo = embedRes.headers.get('x-frame-options');
  check('/console/?embed=dsh 返回 200', embedRes.status === 200, `HTTP ${embedRes.status}`);
  check('embed CSP 允许 loopback frame',
    embedCsp.includes('frame-ancestors http://127.0.0.1:*'),
    embedCsp);
  check('embed 响应没有 X-Frame-Options: DENY',
    embedXfo === null || String(embedXfo).toUpperCase() !== 'DENY',
    embedXfo === null ? 'absent' : String(embedXfo));

  const plainRes = await fetchWithTimeout(`${base}/console/`);
  const plainXfo = plainRes.headers.get('x-frame-options');
  check('普通 /console/ 仍 X-Frame-Options: DENY',
    plainRes.status === 200 && String(plainXfo ?? '').toUpperCase() === 'DENY',
    `HTTP ${plainRes.status}, XFO=${String(plainXfo)}`);
} catch (error) {
  failed += 1;
  console.error(`  ✗ runtime 冒烟异常：${String(error?.message ?? error)}`);
  if (stdout.trim()) console.error(`--- serve stdout ---\n${tail(stdout)}`);
  if (stderr.trim()) console.error(`--- serve stderr ---\n${tail(stderr)}`);
} finally {
  const exited = await stopChild();
  if (!exited) {
    failed += 1;
    console.error('  ✗ serve 子进程未能退出');
  }
  cleanupSync();
  clearTimeout(hardTimeout);
}

console.log('===============================');
if (failed === 0) {
  console.log(`✓ 发布 runtime 冒烟通过（${passed} 项）`);
  process.exit(0);
}
console.log(`✗ 发布 runtime 冒烟失败（${failed}/${passed + failed}）`);
process.exit(1);
