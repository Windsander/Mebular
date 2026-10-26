#!/usr/bin/env node
/**
 * Real DSH happy-path E2E (Phase 1).
 *
 * One command that builds a disposable world and exercises the whole chain:
 *   seed temp Mebular home -> real `mebular serve` -> real npm tarball ->
 *   real @deepseek-ai/dsh -> real plugin install -> real DSH Web ->
 *   headless Chrome/CDP -> sidebar / status / iframe / Console dataset ->
 *   test-only probe plugin -> DSH ctx.tools.schemas() + ctx.tools.execute().
 *
 * No mocks of DSH, no Playwright, no real DeepSeek model call, and no reads or
 * writes under the developer's ~/.mebular or ~/.dsh.
 *
 * Usage:
 *   node scripts/verify-dsh-e2e.mjs [--dsh-version <version>] [--keep]
 *
 * Exit codes: 0 all checks passed; 1 any failure (artifacts kept and printed).
 */

import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import net from 'node:net';

import { seedHome } from '../tests/dsh/e2e/fixtures/seed-home.mjs';
import {
  connectCdp,
  findChrome,
  launchChrome,
  openPage,
  sleep,
} from './lib/cdp.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mebularBin = join(repoRoot, 'packages', 'mcp', 'bin', 'mebular.mjs');
const pluginDir = join(repoRoot, 'packages', 'dsh-plugin');
const probeDir = join(repoRoot, 'tests', 'dsh', 'e2e', 'fixtures', 'probe-plugin');
const versionsPath = join(repoRoot, 'tests', 'dsh', 'e2e', 'versions.json');

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}${detail ? `（${detail}）` : ''}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? `（${detail}）` : ''}`);
  }
  return ok;
};

class StepError extends Error {}

function requireCheck(name, ok, detail = '') {
  if (!check(name, ok, detail)) throw new StepError(name);
  return true;
}

function tail(text, max = 3000) {
  const value = String(text ?? '');
  return value.length <= max ? value : `…${value.slice(-max)}`;
}

function parseArgs(argv) {
  const options = { dshVersion: null, keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--keep') {
      options.keep = true;
    } else if (arg === '--dsh-version') {
      options.dshVersion = argv[index + 1] ?? null;
      index += 1;
    } else if (arg.startsWith('--dsh-version=')) {
      options.dshVersion = arg.slice('--dsh-version='.length);
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return options;
}

function freePort() {
  return new Promise((resolvePromise, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolvePromise(port));
    });
  });
}

function runCommand(label, command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 120000;
  return new Promise((resolvePromise) => {
    const started = Date.now();
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* Already gone. */ }
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', (error) => {
      clearTimeout(timer);
      resolvePromise({ label, code: null, stdout, stderr: `${stderr}${error.message}`, timedOut, elapsedMs: Date.now() - started });
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolvePromise({
        label,
        code,
        signal,
        stdout,
        stderr,
        timedOut,
        elapsedMs: Date.now() - started,
      });
    });
  });
}

function spawnLogged(label, command, args, options = {}) {
  const handle = {
    label,
    command,
    args,
    stdout: '',
    stderr: '',
    exitCode: null,
    signal: null,
    startedAt: Date.now(),
  };
  handle.proc = spawn(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  handle.proc.stdout.on('data', (chunk) => { handle.stdout += chunk.toString(); });
  handle.proc.stderr.on('data', (chunk) => { handle.stderr += chunk.toString(); });
  handle.proc.once('exit', (code, signal) => {
    handle.exitCode = code;
    handle.signal = signal;
  });
  return handle;
}

async function stopProcess(handle, { timeoutMs = 5000 } = {}) {
  if (!handle?.proc || handle.proc.exitCode !== null) return;
  try { handle.proc.kill('SIGTERM'); } catch { return; }
  const exited = await Promise.race([
    once(handle.proc, 'exit').then(() => true).catch(() => true),
    sleep(timeoutMs).then(() => false),
  ]);
  if (exited) return;
  try { handle.proc.kill('SIGKILL'); } catch { /* Already gone. */ }
  await Promise.race([
    once(handle.proc, 'exit').catch(() => undefined),
    sleep(2000),
  ]);
}

async function waitForValue(read, predicate, { timeoutMs = 30000, intervalMs = 150, describe = '条件' } = {}) {
  const started = Date.now();
  let last = null;
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      last = await read();
      if (predicate(last)) return { ok: true, value: last };
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  return { ok: false, value: last, error: lastError, describe };
}

async function waitForServeReady(handle, timeoutMs = 45000) {
  const result = await waitForValue(
    async () => {
      if (handle.exitCode !== null) throw new Error(`serve 提前退出（code=${handle.exitCode}）：${tail(handle.stderr, 600)}`);
      const match = handle.stdout.match(/SERVE_READY (\{.*\})/);
      return match ? JSON.parse(match[1]) : null;
    },
    (value) => value !== null,
    { timeoutMs, describe: 'SERVE_READY' },
  );
  if (!result.ok) throw new Error(`serve 就绪超时：${result.error?.message ?? tail(handle.stderr, 600)}`);
  return result.value;
}

async function waitForDshUrl(handle, timeoutMs = 90000) {
  const result = await waitForValue(
    async () => {
      if (handle.exitCode !== null) throw new Error(`DSH 提前退出（code=${handle.exitCode}）：${tail(handle.stderr, 900)}`);
      const match = handle.stdout.match(/dsh web:\s+(http:\/\/\S+)/);
      return match ? match[1] : null;
    },
    (value) => typeof value === 'string' && value.length > 0,
    { timeoutMs, describe: 'DSH Web URL' },
  );
  if (!result.ok) throw new Error(`DSH Web URL 超时：${result.error?.message ?? tail(handle.stderr, 900)}`);
  return result.value;
}

async function fetchJson(url, timeoutMs = 5000) {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'application/json' },
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}

async function waitForHttpOk(url, timeoutMs = 30000) {
  const result = await waitForValue(
    async () => {
      // The printed URL carries a one-time token; a cookie-less redirect would
      // land on 401. Accept the token entry (200) or its redirect (3xx); the
      // browser load below proves the authenticated page actually renders.
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
      return response.status;
    },
    (status) => status >= 200 && status < 400,
    { timeoutMs, intervalMs: 200, describe: `HTTP ${url}` },
  );
  return result;
}

async function packPackage(directory, packDir, label) {
  const result = await runCommand(`npm pack ${label}`, 'npm', [
    'pack', directory,
    '--pack-destination', packDir,
    '--json',
  ], { cwd: repoRoot, timeoutMs: 120000 });
  if (result.code !== 0) throw new Error(`npm pack ${label} 失败：${tail(result.stderr, 1200)}`);
  let entries = null;
  try {
    entries = JSON.parse(result.stdout.trim());
  } catch {
    entries = null;
  }
  const file = Array.isArray(entries) && entries[0]?.filename
    ? join(packDir, entries[0].filename)
    : await (async () => {
      const files = (await readdir(packDir)).filter((name) => name.endsWith('.tgz'));
      return files.length === 1 ? join(packDir, files[0]) : null;
    })();
  if (file === null || !existsSync(file)) throw new Error(`npm pack ${label} 未产出 tarball`);
  const info = await stat(file);
  return { path: file, size: info.size, filename: file.split('/').pop() };
}

function countMatches(text, pattern) {
  return [...String(text ?? '').matchAll(pattern)].length;
}

async function readJsonIfExists(path) {
  try {
    return JSON.parse(await readFile(path, 'utf-8'));
  } catch {
    return null;
  }
}

async function waitForProbe(path, timeoutMs = 150000) {
  const result = await waitForValue(
    async () => readJsonIfExists(path),
    (value) => value !== null && value.done === true,
    { timeoutMs, intervalMs: 500, describe: 'probe 输出' },
  );
  return result.value;
}

async function waitForFrameEval(page, urlPrefix, expression, predicate, timeoutMs = 30000) {
  const started = Date.now();
  let lastValue;
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const frames = await page.frameTree();
      const frame = frames.find((entry) => typeof entry.url === 'string' && entry.url.startsWith(urlPrefix));
      if (frame) {
        lastValue = await page.evalInFrameByUrl(urlPrefix, expression);
        if (predicate(lastValue)) return { ok: true, value: lastValue };
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  return { ok: false, value: lastValue, error: lastError };
}

function countLines(text, pattern) {
  return countMatches(text, pattern);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const versions = JSON.parse(await readFile(versionsPath, 'utf-8'));
  const dshVersion = options.dshVersion ?? versions.minimum ?? versions.current;
  if (typeof dshVersion !== 'string' || dshVersion.length === 0) {
    throw new Error('versions.json 缺少 minimum/current；请用 --dsh-version 指定');
  }

  console.log('DSH 真实 E2E（Phase 1 happy path）');
  console.log('==================================');

  // Static prerequisites. E2E is allowed to fail; it is never allowed to skip.
  const distEntry = join(repoRoot, 'dist', 'index.js');
  requireCheck(
    'repo build present（dist/index.js）',
    existsSync(distEntry),
    existsSync(distEntry) ? 'dist/index.js' : '先运行 npm ci / npm run build',
  );
  requireCheck('Mebular CLI present', existsSync(mebularBin));
  requireCheck('Console assets present', existsSync(join(repoRoot, 'packages', 'console', 'index.html')));
  let pnpmVersion = null;
  try {
    pnpmVersion = execFileSync('pnpm', ['--version'], { encoding: 'utf-8' }).trim();
  } catch {
    pnpmVersion = null;
  }
  requireCheck('pnpm available（dsh plugin add 需要）', Boolean(pnpmVersion), pnpmVersion ?? '未找到 pnpm');
  const chromePath = findChrome();
  requireCheck('Chrome/Chromium available', Boolean(chromePath), chromePath ?? '设置 CHROME_PATH');

  const tempRoot = await mkdtemp(join(tmpdir(), 'mebular-dsh-e2e-'));
  const mebularHome = join(tempRoot, 'mebular-home');
  const dshHome = join(tempRoot, 'dsh-home');
  const dshInstall = join(tempRoot, 'dsh-install');
  const packDir = join(tempRoot, 'pack');
  const artifactsDir = join(tempRoot, 'artifacts');
  const probeOut = join(artifactsDir, 'probe.json');
  await mkdir(packDir, { recursive: true });
  await mkdir(artifactsDir, { recursive: true });

  let daemon = null;
  let dsh = null;
  let chrome = null;
  let cdp = null;
  let page = null;
  let dumpConfigText = '';
  let seed = null;
  let dshUrl = null;
  let daemonPort = null;
  let probeResult = null;
  let failure = null;

  const mebularEnv = {
    ...process.env,
    MEBULAR_HOME: mebularHome,
    MEBULAR_USER_HOME: mebularHome,
    MEBULAR_CLOUD_ROOT: mebularHome,
  };

  async function collectArtifacts(reason) {
    const result = { reason, at: new Date().toISOString(), files: [] };
    const record = async (name, content) => {
      try {
        const path = join(artifactsDir, name);
        await writeFile(path, content, 'utf-8');
        result.files.push(name);
      } catch {
        // Best effort.
      }
    };
    try {
      await record('seed.json', JSON.stringify(seed, null, 2));
      await record('dsh-log.txt', `${dsh?.stdout ?? ''}\n${dsh?.stderr ?? ''}`);
      await record('daemon-log.txt', `${daemon?.stdout ?? ''}\n${daemon?.stderr ?? ''}`);
      await record('dsh-dump-config.yml', dumpConfigText);
      const runtime = await readJsonIfExists(join(mebularHome, 'runtime.json'));
      await record('runtime.json', JSON.stringify(runtime, null, 2));
      const profiles = await readJsonIfExists(join(mebularHome, 'profiles.json'));
      await record('profiles.json', JSON.stringify(profiles, null, 2));
      if (daemonPort !== null) {
        const origin = `http://127.0.0.1:${daemonPort}`;
        const health = await fetchJson(`${origin}/healthz`).catch(() => null);
        const embed = await fetchJson(`${origin}/app/embed/info`).catch(() => null);
        await record('healthz.json', JSON.stringify(health, null, 2));
        await record('embed-info.json', JSON.stringify(embed, null, 2));
      }
      const probe = await readJsonIfExists(probeOut);
      await record('probe.json', JSON.stringify(probe, null, 2));
      if (page !== null) {
        const errors = page.errors;
        await record('browser-errors.json', JSON.stringify(errors, null, 2));
        const dom = await page.dom().catch(() => '');
        await record('browser-dom.html', dom);
        const shot = await page.screenshot().catch(() => null);
        if (shot !== null) {
          const path = join(artifactsDir, 'screenshot.png');
          await writeFile(path, shot);
          result.files.push('screenshot.png');
        }
      }
    } catch (error) {
      result.error = String(error?.message ?? error);
    }
    return result;
  }

  try {
    console.log('\n→ 准备临时 Mebular home');
    seed = await seedHome(mebularHome, { memoryToken: `dsh-e2e-${randomUUID()}` });
    requireCheck('seed-home：身份 + 一个忆云 + 一条测试记忆', Boolean(seed.memoryId), `${seed.memoryId} / ${seed.memoryToken}`);
    requireCheck('seed-home：未使用默认 ~/.mebular', seed.home === mebularHome, seed.home);

    console.log('\n→ 启动真实 mebular serve');
    daemonPort = await freePort();
    daemon = spawnLogged('daemon', process.execPath, [
      mebularBin, 'serve', '--host', '127.0.0.1', '--port', String(daemonPort),
    ], { env: mebularEnv });
    const ready = await waitForServeReady(daemon);
    requireCheck('daemon SERVE_READY', ready.port === daemonPort, `port=${ready.port}`);
    const health = await fetchJson(`http://127.0.0.1:${daemonPort}/healthz`);
    requireCheck('GET /healthz 200 + status ok', health.status === 200 && health.json?.status === 'ok', `status=${health.status}`);
    const runtime = await readJsonIfExists(join(mebularHome, 'runtime.json'));
    requireCheck('runtime.json 指向同一个 daemon 端口', runtime?.http?.port === daemonPort, JSON.stringify(runtime?.http ?? null));

    console.log('\n→ 打包 @mebular/dsh-plugin 与 probe');
    const pluginTarball = await packPackage(pluginDir, packDir, '@mebular/dsh-plugin');
    requireCheck('npm pack @mebular/dsh-plugin', pluginTarball.size > 0, `${pluginTarball.filename} (${pluginTarball.size}B)`);
    const probeTarball = await packPackage(probeDir, packDir, '@mebular/dsh-e2e-probe');
    requireCheck('npm pack probe（测试专用）', probeTarball.size > 0, `${probeTarball.filename} (${probeTarball.size}B)`);

    console.log(`\n→ 安装真实 @deepseek-ai/dsh@${dshVersion} 到临时 prefix`);
    const install = await runCommand('npm install dsh', 'npm', [
      'install', '--prefix', dshInstall,
      '--no-audit', '--no-fund', '--prefer-offline',
      `@deepseek-ai/dsh@${dshVersion}`,
    ], { timeoutMs: 900000 });
    requireCheck(
      `npm install @deepseek-ai/dsh@${dshVersion}`,
      install.code === 0,
      install.code === 0 ? `${Math.round(install.elapsedMs / 1000)}s` : tail(install.stderr, 600),
    );
    const dshBin = join(dshInstall, 'node_modules', '.bin', 'dsh');
    requireCheck('dsh binary present', existsSync(dshBin), dshBin);

    console.log('\n→ 用 dsh 自身的 plugin 命令安装插件');
    const dshEnv = { ...process.env, DSH_HOME: dshHome, MEBULAR_HOME: mebularHome };
    const addPlugin = await runCommand('dsh plugin add mebular', dshBin, [
      'plugin', '--profile', 'web', 'add', pluginTarball.path,
    ], { env: dshEnv, timeoutMs: 300000 });
    requireCheck('dsh plugin add @mebular/dsh-plugin', addPlugin.code === 0, addPlugin.code === 0 ? '' : tail(addPlugin.stderr, 500));
    const addProbe = await runCommand('dsh plugin add probe', dshBin, [
      'plugin', '--profile', 'web', 'add', probeTarball.path,
    ], { env: dshEnv, timeoutMs: 300000 });
    requireCheck('dsh plugin add probe', addProbe.code === 0, addProbe.code === 0 ? '' : tail(addProbe.stderr, 500));

    const profilePkg = await readJsonIfExists(join(dshHome, 'profiles', 'web', 'package.json'));
    const bundles = profilePkg?.dsh?.profile?.bundles ?? [];
    requireCheck('profile bundles 包含两个插件', bundles.includes('@mebular/dsh-plugin') && bundles.includes('@mebular/dsh-e2e-probe'), JSON.stringify(bundles));

    console.log('\n→ 断言 dsh --dump-config');
    const dump = await runCommand('dsh --dump-config', dshBin, ['--profile', 'web', '--dump-config'], { env: dshEnv, timeoutMs: 120000 });
    dumpConfigText = `${dump.stdout}\n${dump.stderr}`;
    requireCheck('dsh --dump-config exits 0', dump.code === 0, tail(dump.stderr, 500));
    const mebularRows = countLines(dumpConfigText, /^\s*-\s*id:\s*mebular\s*$/gm);
    requireCheck('只有一条 mebular host row', mebularRows === 1, `rows=${mebularRows}`);
    const mebularNames = countLines(dumpConfigText, /^\s*name:\s*'@mebular\/dsh-plugin'\s*$/gm);
    requireCheck('mebular host 只出现一次', mebularNames === 1, `names=${mebularNames}`);
    const probeRows = countLines(dumpConfigText, /^\s*-\s*id:\s*mebular-e2e-probe\s*$/gm);
    requireCheck('probe row 只出现一次', probeRows === 1, `rows=${probeRows}`);
    const staticMcp = countLines(dumpConfigText, /@deepseek-ai\/dsh-mcp-client/gm);
    requireCheck('没有静态 MCP client row', staticMcp === 0, `mentions=${staticMcp}`);
    const staticServer = countLines(dumpConfigText, /serverName:\s*['"]?mebular['"]?/gm);
    requireCheck('没有静态 serverName: mebular', staticServer === 0, `mentions=${staticServer}`);

    console.log('\n→ 启动真实 DSH Web');
    dsh = spawnLogged('dsh-web', dshBin, [
      '--profile', 'web', '--no-open', '--host', '127.0.0.1', '--port', '0',
    ], {
      env: {
        ...dshEnv,
        PROBE_OUT: probeOut,
        PROBE_QUERY: seed.memoryToken,
      },
    });
    dshUrl = await waitForDshUrl(dsh);
    requireCheck('DSH Web 打印 URL', /^http:\/\/127\.0\.0\.1:\d+\//.test(dshUrl), dshUrl.replace(/token=[^&]+/, 'token=<redacted>'));
    const dshHttp = await waitForHttpOk(dshUrl, 30000);
    requireCheck('DSH Web 响应 token 入口', dshHttp.ok, `status=${dshHttp.value}`);

    console.log('\n→ headless Chrome / CDP 断言');
    chrome = await launchChrome(chromePath);
    cdp = connectCdp(chrome.wsUrl);
    await cdp.ready;
    page = await openPage(cdp, { url: dshUrl, timeoutMs: 60000 });
    const title = await page.evalJs('document.title');
    requireCheck('DSH Web 页面已加载', title === 'DeepSeek Harness', title);

    const sidebarPresent = await page.waitFor(
      'document.querySelectorAll(\'button[aria-label="Mebular"]\').length === 1',
      { timeout: 45000 },
    );
    requireCheck('侧边栏存在唯一的 Mebular 入口', sidebarPresent);

    const connected = await page.waitFor(
      'document.querySelector("[data-mebular-status]")?.getAttribute("data-mebular-status") === "connected"',
      { timeout: 30000 },
    );
    const statusDetail = await page.evalJs('document.querySelector("[data-mebular-status]")?.getAttribute("data-mebular-status") ?? "(missing)"');
    requireCheck('侧边栏状态为 connected', connected, statusDetail);

    await page.evalJs(`(() => {
      const button = document.querySelector('button[aria-label="Mebular"]');
      if (button && button.getAttribute('aria-current') !== 'page') button.click();
      return true;
    })()`);
    const iframePresent = await page.waitFor(
      '!!document.querySelector(\'iframe[title="Mebular Console"]\')',
      { timeout: 30000 },
    );
    requireCheck('Mebular 面板 iframe 已挂载', iframePresent);

    const iframeSrc = await page.evalJs('document.querySelector(\'iframe[title="Mebular Console"]\')?.src ?? ""');
    const expectedEmbedUrl = `http://127.0.0.1:${daemonPort}/console/?embed=dsh`;
    requireCheck('iframe src 指向 /console/?embed=dsh', iframeSrc === expectedEmbedUrl, iframeSrc);

    const embedFlag = await waitForFrameEval(
      page,
      `http://127.0.0.1:${daemonPort}/console/`,
      'document.documentElement.dataset.embed',
      (value) => value === 'dsh',
    );
    requireCheck('iframe 内 documentElement.dataset.embed === "dsh"', embedFlag.ok, String(embedFlag.value ?? embedFlag.error?.message ?? 'missing'));

    const consoleReady = await waitForFrameEval(
      page,
      `http://127.0.0.1:${daemonPort}/console/`,
      'document.readyState === "complete" && Boolean(document.querySelector("#app, main, .console-root, #starfield, canvas"))',
      (value) => value === true,
      15000,
    );
    requireCheck('Console 文档已就绪并渲染主容器', consoleReady.ok, String(consoleReady.value ?? ''));

    console.log('\n→ 等待 probe 通过真实 DSH registry 读工具');
    probeResult = await waitForProbe(probeOut);
    requireCheck('probe 写出结果', probeResult !== null);
    requireCheck('probe 通过 ctx.tools.schemas() 看到工具', probeResult.schemaCount > 0, `count=${probeResult.schemaCount}`);
    requireCheck(
      '关键 Mebular 工具已注册',
      probeResult.required?.['mcp__mebular__memory_write'] === true
        && probeResult.required?.['mcp__mebular__memory_query'] === true,
      `missing=${JSON.stringify(probeResult.missingRequired ?? [])}`,
    );
    requireCheck('不硬编码工具总数（只要求 > 0）', probeResult.schemaCount > 0, `count=${probeResult.schemaCount}`);
    const invocation = probeResult.invocation;
    requireCheck('probe 通过 ctx.tools.execute() 调用只读工具', invocation?.tool === 'mcp__mebular__memory_query' && invocation?.ok === true, invocation?.tool ?? '(none)');
    requireCheck('工具调用不是错误结果', invocation?.isError === false, String(invocation?.error ?? ''));
    const invocationText = typeof invocation?.text === 'string' ? invocation.text : '';
    requireCheck(
      '调用返回临时 home 的真实记忆（含本次 token）',
      invocationText.includes(seed.memoryToken),
      tail(invocationText, 300),
    );
    requireCheck(
      '调用返回本次 seed 的记忆 id',
      invocationText.includes(seed.memoryId),
      seed.memoryId,
    );

    const exceptions = page.errors.filter((entry) => entry.kind === 'exception');
    requireCheck('页面没有未捕获异常', exceptions.length === 0, JSON.stringify(exceptions).slice(0, 500));

    console.log('\n证据');
    console.log(`  侧边栏：button[aria-label="Mebular"] × 1；状态=${statusDetail}`);
    console.log(`  iframe：${iframeSrc}`);
    console.log(`  Console：dataset.embed=${embedFlag.value}`);
    console.log(`  工具：schemas=${probeResult.schemaCount}，必需工具=${Object.values(probeResult.required ?? {}).every(Boolean) ? 'present' : 'missing'}`);
    console.log(`  真实调用：${invocation.tool} -> ${tail(invocationText, 220)}`);
    console.log(`  seed：memoryId=${seed.memoryId} token=${seed.memoryToken}`);
  } catch (error) {
    failure = error;
    console.log(`\n✗ E2E 失败：${error?.message ?? error}`);
  } finally {
    if (failure !== null || options.keep) {
      const artifacts = await collectArtifacts(failure?.message ?? 'keep');
      console.log(`\nartifacts: ${artifactsDir}`);
      if (artifacts.error) console.log(`  artifact 收集告警：${artifacts.error}`);
      if (failure !== null) {
        console.log(`\ndaemon log（tail）:\n${tail(`${daemon?.stdout ?? ''}\n${daemon?.stderr ?? ''}`, 2500)}`);
        console.log(`\nDSH log（tail）:\n${tail(`${dsh?.stdout ?? ''}\n${dsh?.stderr ?? ''}`, 2500)}`);
        const probe = await readJsonIfExists(probeOut);
        if (probe !== null) console.log(`\nprobe（tail）:\n${tail(JSON.stringify(probe, null, 2), 2500)}`);
      }
    }

    await page?.close().catch(() => undefined);
    await cdp?.close().catch(() => undefined);
    await chrome?.close().catch(() => undefined);
    await stopProcess(dsh);
    await stopProcess(daemon);

    if (failure === null && !options.keep) {
      await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    } else {
      console.log(`\n临时目录保留：${tempRoot}`);
    }
  }

  console.log('\n==================================');
  console.log(`${failure === null ? '✓' : '✗'} DSH E2E：${passed} passed, ${failed} failed`);
  if (failure !== null) {
    console.log(`失败原因：${failure.message}`);
    return 1;
  }
  return 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    console.error(`✗ DSH E2E 未捕获错误：${error?.stack ?? error}`);
    process.exitCode = 1;
  });
