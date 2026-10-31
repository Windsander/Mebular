#!/usr/bin/env node
// 0.3.0 immersive journey: one user/cloud, two real devices, three real hosts.
//
//   DSH (device A, real Web UI + Chrome)  first turn ingest -> second turn recall
//        -> detail expand -> silence -> fail open
//   Hermes (device B, real MemoryProvider) cross-device detail + structured checkpoint
//   OpenCode / OpenChamber (device B)      correction -> delete -> no more recall
//
// Every host talks to a real Memory Runtime sidecar and the real MCP capability
// API. Device A and B are separate Mebular homes with the same user master key;
// they sync through the real P2PNode/SyncManager over an in-memory transport.
// No external network, no downloaded model, no real LLM: DSH/OpenCode use a
// test-only deterministic adapter, Hermes drives its documented provider seam.
//
// Usage:
//   node tests/integration/host-e2e/immersive-journey.mjs [--keep]
//
// The DSH browser evidence is written to docs/quality/0.3.0-immersive-ui by
// default (MEBULAR_EVIDENCE_DIR overrides it). Exit code is nonzero on any
// failed assertion, including a documented product defect.

import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findChrome } from '../../../scripts/lib/cdp.mjs';
import { createWorld } from '../../../scripts/lib/dsh-e2e-world.mjs';
import {
  packPackage,
  runCommand,
  tail,
  waitForValue,
} from '../../../scripts/lib/e2e-process.mjs';
import { IdentityManager } from '../../../dist/index.js';
import { createSyncHarness } from './lib/device-sync.mjs';
import { createFakeOpenAI } from './lib/fake-openai.mjs';
import {
  captureEvidence,
  dismissOnboarding,
  FAKE_REPLY,
  newSession,
  sendPrompt,
  sessionLogText,
  visibleMemoryFindings,
  waitForAssistantTurns,
} from './lib/dsh-ui.mjs';
import { requestSidecar, startRealRuntime } from './lib/real-runtime.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const pluginDir = join(repoRoot, 'packages', 'dsh-plugin');
const probeDir = join(repoRoot, 'tests', 'dsh', 'e2e', 'fixtures', 'memory-runtime-probe');
const fakeLlmDir = join(repoRoot, 'tests', 'dsh', 'e2e', 'fixtures', 'fake-llm');
const versionsPath = join(repoRoot, 'tests', 'dsh', 'e2e', 'versions.json');
const pythonScript = join(here, 'hermes-real-runtime.py');
const evidenceDir = resolve(process.env.MEBULAR_EVIDENCE_DIR ?? join(repoRoot, 'docs', 'quality', '0.3.0-immersive-ui'));

function redactEvidenceText(text) {
  return String(text ?? '')
    .replace(/token=[A-Za-z0-9_-]+/gu, 'token=<redacted>')
    .replace(/\/Users\/[^/\s"'\\)]+/gu, '<user>')
    .replace(/\/private\/var\/folders\/[^/\s"']+/gu, '<temp>')
    .replace(/\/var\/folders\/[^/\s"']+/gu, '<temp>');
}
const DSH_THREAD = 'dsh_memory-e2e-session';

let passed = 0;
let failed = 0;
const defects = [];
let pnpmTempRoot = null;

function check(name, ok, detail = '') {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `（${detail}）` : ''}`);
  return ok;
}

class StepError extends Error {}

function requireCheck(name, ok, detail = '') {
  if (!check(name, ok, detail)) throw new StepError(name);
  return true;
}

/** A failed contract assertion that is a product defect, not a harness failure. */
function defectCheck(name, ok, detail = '') {
  if (!ok) defects.push({ name, detail });
  return check(ok ? name : `[产品缺陷] ${name}`, ok, detail);
}

function parseArgs(argv) {
  const options = { keep: false, dshVersion: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--keep') options.keep = true;
    else if (arg === '--dsh-version') {
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

function whichPnpm() {
  try {
    return execFileSync('pnpm', ['--version'], { encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

async function ensurePnpm() {
  const existing = whichPnpm();
  if (existing) return existing;
  const dir = await mkdtemp(join(tmpdir(), 'mebular-immersive-pnpm-'));
  pnpmTempRoot = dir;
  console.log(`pnpm 未安装，安装临时副本：${dir}`);
  const result = await runCommand('npm install pnpm', 'npm', [
    'install', '--prefix', dir, '--no-audit', '--no-fund', '--offline', 'pnpm@10.34.8',
  ], { timeoutMs: 300000 });
  if (result.code !== 0) throw new Error(`临时 pnpm 安装失败：${tail(result.stderr || result.stdout, 800)}`);
  const bin = join(dir, 'node_modules', '.bin');
  process.env.PATH = `${bin}:${process.env.PATH ?? ''}`;
  return whichPnpm();
}

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

async function waitFor(predicate, { timeoutMs = 15000, intervalMs = 100, describe = 'condition' } = {}) {
  const result = await waitForValue(predicate, (value) => value === true, {
    timeoutMs,
    intervalMs,
    describe,
  });
  return result.ok ? result.value : null;
}

async function waitForValueOrThrow(read, predicate, { timeoutMs = 30000, intervalMs = 150, describe = 'condition' } = {}) {
  const result = await waitForValue(read, predicate, { timeoutMs, intervalMs, describe });
  if (!result.ok) {
    throw new Error(`${describe} 超时：${tail(JSON.stringify(result.value ?? null), 800)}`);
  }
  return result.value;
}

function evidenceFiles(prefix) {
  return {
    screenshot: `${prefix}.png`,
    dom: `${prefix}.html`,
    text: `${prefix}.txt`,
  };
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function writeJsonEvidence(name, value) {
  await mkdir(evidenceDir, { recursive: true });
  const path = join(evidenceDir, name);
  await writeFile(path, `${redactEvidenceText(JSON.stringify(value, null, 2))}\n`, 'utf8');
  return path;
}

async function writeTextEvidence(name, value) {
  await mkdir(evidenceDir, { recursive: true });
  const path = join(evidenceDir, name);
  await writeFile(path, redactEvidenceText(value), 'utf8');
  return path;
}

async function prepareSidecarConfig(runtimeRoot) {
  const home = join(runtimeRoot, 'mebular-home');
  await mkdir(join(home, 'memory-runtime'), { recursive: true });
  await writeFile(join(home, 'memory-runtime', 'config.json'), JSON.stringify({
    schema: 1,
    trace: 'local',
    model: { source: 'heuristic' },
    http: { host: '127.0.0.1', port: 0 },
  }, null, 2), 'utf8');
}

/** Hot-enable the real `memoryRuntime.enabled` switch through the admin API. */
async function enableMemoryRuntime(runtime) {
  const consoleResponse = await fetch(`${runtime.url}/console/`);
  const csrf = consoleResponse.headers.get('x-mebular-csrf');
  const cookie = (consoleResponse.headers.get('set-cookie') ?? '').split(';')[0];
  if (!csrf || !cookie) throw new Error('console CSRF bootstrap failed');
  const response = await fetch(`${runtime.url}/admin/api/config`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-mebular-csrf': csrf,
      cookie,
    },
    body: JSON.stringify({ patch: { memoryRuntime: { enabled: true } } }),
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

async function breakDiscoveryUrl(runtime) {
  const path = join(runtime.home, 'memory-runtime.json');
  const record = JSON.parse(await readFile(path, 'utf8'));
  record.url = 'http://127.0.0.1:1/memory-runtime/v1';
  record.healthUrl = 'http://127.0.0.1:1/memory-runtime/v1/health';
  record.updatedAt = Date.now();
  await writeFile(path, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600 });
}

function memoryPatch({ daemonUrl }) {
  return [
    '# 0.3.0 immersive journey: deterministic DSH provider + real Mebular adapter.',
    '- insert:',
    '    - id: fake-llm',
    '      name: \'@mebular/dsh-fake-llm\'',
    '      config:',
    `        reply: ${JSON.stringify(FAKE_REPLY)}`,
    '- id: agent-default-model',
    '  config:',
    '    provider: fake',
    '    model: fake',
    '- id: mebular',
    '  name: \'@mebular/dsh-plugin\'',
    '  config:',
    '    lifecycle: attach',
    '    panel: false',
    `    daemonUrl: ${JSON.stringify(daemonUrl)}`,
    '    memoryRuntime:',
    '      ingestFlushMs: 0',
    '      ingestRetryBaseMs: 50',
    '      ingestRetries: 2',
    '      discoveryRetryMs: 1000',
    '',
  ].join('\n');
}

function ordinaryRequests(observation) {
  return (observation?.requests ?? []).filter((entry) => entry.purpose === null);
}

function latestOrdinaryRequest(observation) {
  return ordinaryRequests(observation).at(-1) ?? null;
}

function requestsWithMemory(observation) {
  return ordinaryRequests(observation).filter((entry) => (
    entry.messages ?? []
  ).some((message) => message.source === 'mebular-memory'));
}

function messageTextOf(request) {
  return (request?.messages ?? [])
    .filter((message) => message.source === 'mebular-memory')
    .map((message) => message.text)
    .join('\n');
}

function memoryToolNames(request) {
  return (request?.tools ?? []).filter((name) => /^mcp__mebular__memory_/u.test(name));
}

function traceForQuery(traces, query) {
  return [...(traces ?? [])].reverse().find((trace) => String(trace.queryPreview ?? '').includes(query)) ?? null;
}

async function runPython(env, cwd) {
  return new Promise((resolvePromise) => {
    const child = spawn('python3', [pythonScript], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

function parseMarker(stdout) {
  const line = stdout.split('\n').find((entry) => entry.startsWith('HERMES_E2E_RESULT '));
  if (!line) return null;
  try {
    return JSON.parse(line.slice('HERMES_E2E_RESULT '.length));
  } catch {
    return null;
  }
}

function getFreePort() {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePromise(port));
    });
  });
}

function runProcess(command, args, { env, cwd, timeoutMs = 120000 } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* best effort */ }
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr, timedOut });
    });
  });
}

function opencodeConfig({ providerUrl, pluginDir: pluginPath }) {
  return {
    $schema: 'https://opencode.ai/config.json',
    model: 'mock/mock',
    update: 'disable',
    plugins: [{
      package: pluginPath,
      options: {
        agentId: 'opencode',
        recall: true,
        ingest: true,
        checkpoints: true,
        hideMemoryTools: true,
        modelSource: 'heuristic',
        recallTimeoutMs: 5000,
        ingestTimeoutMs: 5000,
        maxContextBytes: 8192,
      },
    }],
    providers: {
      mock: {
        name: 'Immersive Journey Mock',
        package: '@opencode/ai/providers/openai-compatible',
        settings: { baseURL: `${providerUrl}/v1`, apiKey: 'immersive-journey-not-a-secret' },
        models: {
          mock: {
            name: 'Mock',
            limit: { context: 100000, output: 4000 },
          },
        },
      },
    },
  };
}

function parseSessionID(output) {
  for (const line of output.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed.sessionID === 'string' && parsed.sessionID.startsWith('ses')) return parsed.sessionID;
      if (typeof parsed?.data?.sessionID === 'string') return parsed.data.sessionID;
    } catch {
      // ignore non-JSON diagnostic lines
    }
  }
  return null;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const versions = JSON.parse(await readFile(versionsPath, 'utf-8'));
  const dshVersion = options.dshVersion
    ?? (process.env.DSH_VERSION && process.env.DSH_VERSION.trim().length > 0 ? process.env.DSH_VERSION.trim() : null)
    ?? versions.current
    ?? versions.minimum;

  console.log('Mebular 0.3.0 immersive journey（真实 DSH Web / Hermes / OpenCode + 真实 sidecar + 真实同步）');
  console.log('=========================================================================================');
  console.log(`DSH 版本：${dshVersion}`);
  console.log(`证据目录：${evidenceDir}`);
  await mkdir(evidenceDir, { recursive: true });

  const preflight = [];
  preflight.push(check('repo build present（dist/index.js）', existsSync(join(repoRoot, 'dist', 'index.js'))));
  preflight.push(check('Mebular CLI present', existsSync(join(repoRoot, 'packages', 'mcp', 'bin', 'mebular.mjs'))));
  preflight.push(check('python3 present', (() => {
    try { execFileSync('python3', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
  })()));
  preflight.push(check('opencode present', (() => {
    try {
      const version = execFileSync('opencode', ['--version'], { encoding: 'utf8' });
      return /v?2\.(?:[2-9]|[1-9]\d)\./.test(version);
    } catch { return false; }
  })()));
  const chromePath = findChrome();
  preflight.push(check('Chrome/CDP present（真实 DSH Web 截图必需）', typeof chromePath === 'string' && chromePath.length > 0, chromePath ?? 'not found'));
  let pnpmVersion = null;
  try { pnpmVersion = await ensurePnpm(); } catch (error) { console.log(`  pnpm 准备失败：${error?.message ?? error}`); }
  preflight.push(check('pnpm available（dsh plugin add 需要）', Boolean(pnpmVersion), pnpmVersion ?? '未找到 pnpm'));
  if (preflight.some((value) => value !== true)) {
    console.log('\n前置条件不满足，未启动旅程（显式失败，不静默 skip）。');
    if (pnpmTempRoot) await rm(pnpmTempRoot, { recursive: true, force: true }).catch(() => undefined);
    return 1;
  }

  const root = await mkdtemp(join(tmpdir(), 'mebular-immersive-journey-'));
  const packDir = join(root, 'pack');
  await mkdir(packDir, { recursive: true });
  console.log(`临时根目录：${root}`);

  const sync = createSyncHarness();
  const master = await new IdentityManager().generateUserMasterKey();
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const namespaceList = [
    'default',
    'user',
    'agent:dsh',
    'agent:hermes',
    'agent:opencode',
    `task:${DSH_THREAD}`,
  ];

  let deviceA = null;
  let deviceB = null;
  let world = null;
  let provider = null;
  let serve = null;
  let opencodeHome = null;
  let exitCode = 1;
  const startedAt = new Date().toISOString();

  try {
    const pluginTarball = await packPackage(pluginDir, packDir, '@mebular/dsh-plugin');
    const probeTarball = await packPackage(probeDir, packDir, '@mebular/dsh-memory-runtime-probe');
    const fakeLlmTarball = await packPackage(fakeLlmDir, packDir, '@mebular/dsh-fake-llm');
    requireCheck('npm pack @mebular/dsh-plugin', pluginTarball.size > 0, pluginTarball.filename);
    requireCheck('npm pack memory runtime probe', probeTarball.size > 0, probeTarball.filename);
    requireCheck('npm pack fake DSH LLM', fakeLlmTarball.size > 0, fakeLlmTarball.filename);

    const dshInstall = join(root, 'dsh-install');
    const install = await runCommand('npm install dsh', 'npm', [
      'install', '--prefix', dshInstall,
      '--no-audit', '--no-fund', '--offline',
      `@deepseek-ai/dsh@${dshVersion}`,
    ], { timeoutMs: 900000 });
    requireCheck(`npm install @deepseek-ai/dsh@${dshVersion}（离线）`, install.code === 0, tail(install.stderr, 900));
    const dshBin = join(dshInstall, 'node_modules', '.bin', 'dsh');
    requireCheck('dsh binary present', existsSync(dshBin), dshBin);

    // ----- Device A (DSH) and device B (Hermes / OpenCode): same user, two homes.
    deviceA = await startRealRuntime({
      auth: 'none',
      root: join(root, 'device-a'),
      memoryRuntime: { enabled: false },
      manageMemoryRuntime: true,
      writesEnabled: true,
      master,
      deviceId: `device-a-${suffix}`,
      deviceName: 'Journey device A',
      network: sync.network(),
      sync: sync.sync(namespaceList),
    });
    check('设备 A 起始为轻量模式（无 sidecar discovery）', (await deviceA.sidecarDiscovery()) === null);
    check('设备 A 轻量模式未创建 memory-runtime 目录', !existsSync(join(deviceA.home, 'memory-runtime')));

    await prepareSidecarConfig(join(root, 'device-b'));
    deviceB = await startRealRuntime({
      auth: 'none',
      root: join(root, 'device-b'),
      memoryRuntime: { enabled: true },
      manageMemoryRuntime: true,
      master,
      deviceId: `device-b-${suffix}`,
      deviceName: 'Journey device B',
      network: sync.network(),
      sync: sync.sync(namespaceList),
    });
    const bDiscovery = await deviceB.waitForSidecar();
    check('设备 B 真实 sidecar 就绪（同一用户主公钥，独立 home）',
      bDiscovery.state === 'ready' && String(bDiscovery.url).endsWith('/memory-runtime/v1'), bDiscovery.url);
    const initialSync = await sync.connect(deviceA, deviceB);
    check('两台设备完成真实 P2P 认证与首次同步',
      initialSync.left?.peerDeviceId === deviceB.deviceId
      && initialSync.right?.peerDeviceId === deviceA.deviceId,
    JSON.stringify({ left: initialSync.left?.peerDeviceId, right: initialSync.right?.peerDeviceId }));

    // ----- DSH real Web UI with a deterministic provider.
    world = await createWorld({
      name: `immersive-${suffix}`,
      root: join(root, 'dsh-world'),
      repoRoot,
      dshBin,
      dshInstall,
      dshVersion,
      pluginTarball,
      probeTarball,
      extraPlugins: [{ specifier: '@mebular/dsh-fake-llm', tarball: fakeLlmTarball }],
    });
    const bundles = await world.installProfile({ patch: memoryPatch({ daemonUrl: deviceA.url }) });
    requireCheck('DSH profile 包含插件、probe 与 fake LLM',
      bundles.includes('@mebular/dsh-plugin')
      && bundles.includes('@mebular/dsh-memory-runtime-probe')
      && existsSync(join(world.state.dshHome, 'profiles', 'web', 'node_modules', '@mebular', 'dsh-fake-llm')),
    JSON.stringify(bundles));

    const llmOut = join(evidenceDir, 'dsh-llm-requests.json');
    const probeStartFile = join(world.state.artifactsDir, 'probe-start');
    const dshUrl = await world.startDsh({
      env: {
        MEBULAR_HOME: deviceA.home,
        MEBULAR_MEMORY_RUNTIME_HOME: deviceA.home,
        MEBULAR_MEMORY_RUNTIME_URL: '',
        MEBULAR_RUNTIME_URL: '',
        MEBULAR_RUNTIME_TOKEN: '',
        MEMORY_E2E_LLM_OUT: llmOut,
        MEMORY_E2E_OUT: join(world.state.artifactsDir, 'memory-runtime-probe.json'),
        MEMORY_E2E_START_FILE: probeStartFile,
        MEMORY_E2E_DETAIL_QUERY: '深色主题，我原话怎么说的？',
        MEMORY_E2E_SILENT_QUERY: `tomorrow weather small talk ${suffix}`,
      },
    });
    check('DSH Web 已启动', /^http:\/\/127\.0\.0\.1:\d+\//.test(dshUrl), world.redact(dshUrl));
    const dshPid = world.state.dsh?.proc?.pid ?? null;
    await world.openBrowser({ chromePath, url: dshUrl });
    check('真实 DSH Web 在 Chrome 中加载', (await world.state.page.evalJs('document.title')) === 'DeepSeek Harness');
    await dismissOnboarding(world.state.page);
    await newSession(world.state.page);

    // 1) Light mode: a real human turn, zero sidecar request.
    await sendPrompt(world.state.page, `你好，轻量模式 ${suffix}`);
    const lightTurn = await waitForAssistantTurns(world.state.page, 1);
    requireCheck('轻量模式第一轮真实对话完成', lightTurn.ok, JSON.stringify({ matches: lightTurn.matches }));
    await captureEvidence(world.state.page, evidenceDir, 'dsh-light');
    const lightObservation = JSON.parse(await readFile(llmOut, 'utf8'));
    const lightRequest = latestOrdinaryRequest(lightObservation);
    const lightOrdinaryCount = ordinaryRequests(lightObservation).length;
    check('轻量模式所有记忆源消息为空', lightRequest !== null && !(lightRequest.messages ?? []).some((message) => message.source === 'mebular-memory'),
      JSON.stringify(lightRequest?.messages?.map((message) => message.source)));
    check('轻量模式没有调用 sidecar /context', (await deviceA.sidecarDiscovery()) === null);
    check('轻量模式未生成 sidecar host token', !existsSync(join(deviceA.home, 'memory-runtime', 'host-token')));
    check('轻量模式轻量截图无记忆块', visibleMemoryFindings(lightTurn.text).length === 0,
      JSON.stringify(visibleMemoryFindings(lightTurn.text)));

    // 2) Hot switch to immersive; the already-running DSH must follow without restart.
    await prepareSidecarConfig(join(root, 'device-a'));
    const enabledAt = Date.now();
    const enableResult = await enableMemoryRuntime(deviceA);
    requireCheck('admin 热开关打开沉浸式', enableResult.status === 200
      && enableResult.body?.effectiveImmediately === true,
    JSON.stringify({ status: enableResult.status, body: enableResult.body }));
    const discoveryA = await deviceA.waitForSidecar({ timeoutMs: 30000 });
    const discoveryMs = Date.now() - enabledAt;
    check('sidecar discovery 在 5s 内出现', discoveryMs <= 5000, `${discoveryMs}ms`);
    check('discovery 声明 immersive + details', discoveryA.mode === 'immersive'
      && discoveryA.capabilities?.details === true, JSON.stringify({
      mode: discoveryA.mode,
      details: discoveryA.capabilities?.details,
    }));
    await sleep(1300); // one discovery poll at discoveryRetryMs=1000
    await writeFile(probeStartFile, 'start\n', 'utf8');
    check('DSH 进程未重启（模式热切换）', world.state.dsh?.proc?.pid === dshPid, `pid=${dshPid}`);

    // 2b) Same-session hot switch: the existing light conversation must hide
    // memory_* on its next turn, not only a newly created Agent.
    await sendPrompt(world.state.page, `同会话热切换 ${suffix}`);
    const hotTurn = await waitForAssistantTurns(world.state.page, 2);
    requireCheck('同会话热切换后真实对话完成', hotTurn.ok, JSON.stringify({ matches: hotTurn.matches }));
    const hotObservation = JSON.parse(await readFile(llmOut, 'utf8'));
    const hotRequest = latestOrdinaryRequest(hotObservation);
    check('同会话热切换后 model tools 立即隐藏 memory_*',
      hotRequest !== null && memoryToolNames(hotRequest).length === 0,
      JSON.stringify(memoryToolNames(hotRequest)));
    check('同会话热切换轮不携带历史注入',
      !(hotRequest?.messages ?? []).some((message) => message.source === 'mebular-memory'),
      JSON.stringify((hotRequest?.messages ?? []).map((message) => message.source).slice(-4)));

    // A new conversation starts its Agent after the mode switch; the light
    // conversation above is left intact and still has no memory injection.
    await newSession(world.state.page);

    // 3) First immersive human turn: real ingest + detail.
    const seedPrompt = '以后默认用深色主题，记住。';
    await sendPrompt(world.state.page, seedPrompt);
    const ingestTurn = await waitForAssistantTurns(world.state.page, 1);
    requireCheck('第一轮沉浸式真实对话完成', ingestTurn.ok, JSON.stringify({ matches: ingestTurn.matches }));
    const ingestStatus = await waitForValueOrThrow(
      async () => deviceA.sidecarStatus(),
      (value) => (value?.counts?.ingested ?? 0) >= 2 && (value?.counts?.settled ?? 0) >= 1,
      { timeoutMs: 30000, describe: 'DSH ingest/settlement' },
    );
    const seedDetails = await waitForValueOrThrow(
      async () => deviceA.resolveDetails({
        agentId: 'dsh',
        domains: ['user', 'default', 'agent:dsh'],
      }).catch(() => []),
      (values) => Array.isArray(values) && values.some((entry) => String(entry.text ?? '').includes(seedPrompt)),
      { timeoutMs: 30000, describe: 'DSH detail record' },
    );
    const seedDetail = seedDetails.find((entry) => String(entry.text ?? '').includes(seedPrompt));
    check('真实 DSH ingest 写入 user 域记录与详情（非本机 raw）',
      ingestStatus.counts.settled >= 1 && seedDetail?.domain === 'user',
      JSON.stringify({ counts: ingestStatus.counts, domain: seedDetail?.domain, detailId: seedDetail?.id }));
    const firstTraceAt = await waitForValueOrThrow(
      async () => (await deviceA.sidecarTraces()).find((trace) => String(trace.threadId ?? '').startsWith('dsh_session-')
        && String(trace.queryPreview ?? '').includes('深色主题')),
      (trace) => trace !== undefined,
      { timeoutMs: 30000, describe: 'DSH context trace' },
    );
    const followMs = Number(firstTraceAt.at ?? 0) - enabledAt;
    check('host 在 5s 内自动跟随沉浸式（首次 sidecar context）', followMs <= 5000, `${followMs}ms`);

    // 4) Second turn: recall is source-tagged context, not a user bubble.
    await sendPrompt(world.state.page, '我的主题偏好是什么？');
    const recallTurn = await waitForAssistantTurns(world.state.page, 2);
    requireCheck('第二轮真实对话完成', recallTurn.ok, JSON.stringify({ matches: recallTurn.matches }));
    const recallObservation = JSON.parse(await readFile(llmOut, 'utf8'));
    const recallRequests = requestsWithMemory(recallObservation);
    const recallRequest = recallRequests.at(-1) ?? null;
    const recallBlock = messageTextOf(recallRequest);
    check('第二轮模型请求包含唯一 source-tagged 记忆消息',
      recallRequest !== null
      && (recallRequest.messages ?? []).filter((message) => message.source === 'mebular-memory').length === 1,
    JSON.stringify(recallRequest?.messages?.map((message) => message.source)));
    check('注入不是 user 消息（source=mebular-memory）',
      !(recallRequest?.messages ?? []).some((message) => message.source === 'user' && message.text.includes('<mebular_memory')));
    check('第二轮只给 gist，不返回长原文', recallBlock.includes('gist:') && !recallBlock.includes(seedPrompt),
      tail(recallBlock, 700));
    await captureEvidence(world.state.page, evidenceDir, 'dsh-context');
    const recallDomFindings = visibleMemoryFindings(recallTurn.text, { detailText: seedPrompt });
    check('DSH DOM/截图不出现 <mebular_memory>、gist 或重复记忆正文', recallDomFindings.length === 0,
      JSON.stringify(recallDomFindings));

    // 5) Detail turn: verbatim + citation; expand through the sidecar.
    await sendPrompt(world.state.page, '深色主题，我原话怎么说的？');
    const detailTurn = await waitForAssistantTurns(world.state.page, 3);
    requireCheck('详情追问真实对话完成', detailTurn.ok, JSON.stringify({ matches: detailTurn.matches }));
    const detailObservation = JSON.parse(await readFile(llmOut, 'utf8'));
    const detailRequest = requestsWithMemory(detailObservation).at(-1) ?? null;
    const detailBlock = messageTextOf(detailRequest);
    check('详情注入为 verbatim + citation',
      detailBlock.includes('detail (verbatim)')
      && detailBlock.includes(seedPrompt)
      && /citation=/.test(detailBlock),
    tail(detailBlock, 900));
    await captureEvidence(world.state.page, evidenceDir, 'dsh-detail');
    const detailDomFindings = visibleMemoryFindings(detailTurn.text, { detailText: seedPrompt });
    check('DSH 详情 DOM/截图无记忆块/重复正文', detailDomFindings.length === 0, JSON.stringify(detailDomFindings));

    const detailTraces = await deviceA.sidecarTraces();
    const detailTrace = [...detailTraces].reverse().find((trace) => String(trace.threadId ?? '').startsWith('dsh_session-')
      && String(trace.queryPreview ?? '').includes('深色主题')
      && trace.expansions?.length > 0) ?? null;
    const detailFragment = detailTrace?.expansions?.[0];
    const expand = detailTrace?.recallId && detailFragment?.fragmentId
      ? await deviceA.sidecarExpand(detailTrace.recallId, {
        fragmentId: detailFragment.fragmentId,
        agentId: 'dsh',
        format: 'verbatim',
      })
      : null;
    check('sidecar /recall/:id/expand 返回域内详情（原话/citation/source=capability）',
      expand?.status === 200
      && String(expand?.data?.detail?.text ?? '').includes(seedPrompt)
      && expand?.data?.detail?.source === 'capability'
      && expand?.data?.detail?.stale === false,
    JSON.stringify({ status: expand?.status, detail: expand?.data?.detail }).slice(0, 900));
    defectCheck('侧车详情展开只返回用户原话（不混入助手回复）',
      expand?.data?.detail?.text === seedPrompt,
      JSON.stringify(expand?.data?.detail?.text ?? null).slice(0, 700));
    const capabilityDetail = seedDetail?.id
      ? await deviceA.getDetail(seedDetail.id, { agentId: 'dsh' }).catch(() => null)
      : null;
    check('capability /detail get 返回同一份域内详情（非本机 raw）',
      capabilityDetail?.detail?.text === seedPrompt
      && capabilityDetail?.detail?.domain === 'user',
    JSON.stringify(capabilityDetail?.detail ?? null).slice(0, 700));

    // 6) Silence: no empty block, no new injection.
    await sendPrompt(world.state.page, `明天天气怎么样 ${suffix}`);
    const silenceTurn = await waitForAssistantTurns(world.state.page, 4);
    requireCheck('无命中真实对话完成', silenceTurn.ok, JSON.stringify({ matches: silenceTurn.matches }));
    await captureEvidence(world.state.page, evidenceDir, 'dsh-silence');
    const silenceTrace = await waitForValueOrThrow(
      async () => {
        const traces = await deviceA.sidecarTraces();
        return traceForQuery(traces, '明天天气');
      },
      (trace) => trace !== null,
      { timeoutMs: 20000, describe: 'silence trace' },
    );
    check('sidecar 无命中 trace 为 no_hits 且不注入', silenceTrace.injected?.length === 0
      && silenceTrace.silenceReason === 'no_hits'
      && (silenceTrace.fragments === undefined || silenceTrace.fragments.length === 0),
    JSON.stringify({ reason: silenceTrace.silenceReason, injected: silenceTrace.injected?.length, fragments: silenceTrace.fragments?.length }));
    const silenceDomFindings = visibleMemoryFindings(silenceTurn.text, { detailText: seedPrompt });
    check('无命中 DOM/截图没有空记忆块', silenceDomFindings.length === 0, JSON.stringify(silenceDomFindings));
    const silenceObservation = JSON.parse(await readFile(llmOut, 'utf8'));
    const silenceRequest = latestOrdinaryRequest(silenceObservation);
    defectCheck('无命中轮次不再携带上一轮注入（live model history）',
      !(silenceRequest?.messages ?? []).some((message) => message.source === 'mebular-memory'),
      JSON.stringify((silenceRequest?.messages ?? []).map((message) => message.source).slice(-4)));

    // 7) Tool hiding on the real ordinary Agent.
    const finalObservation = JSON.parse(await readFile(llmOut, 'utf8'));
    const immersiveRequests = ordinaryRequests(finalObservation).slice(lightOrdinaryCount);
    const hidden = immersiveRequests.every((request) => memoryToolNames(request).length === 0);
    check('普通 DSH Agent 的 model tools 不含 memory_*', hidden,
      JSON.stringify(immersiveRequests.map((request) => memoryToolNames(request)).filter((names) => names.length > 0)));
    const toolSamples = immersiveRequests.flatMap((request) => request.tools ?? []);
    check('普通 DSH Agent 仍保留非记忆工具（task_* 或其它 MCP 工具）',
      toolSamples.some((name) => name.startsWith('mcp__mebular__task_'))
      || toolSamples.some((name) => !name.startsWith('mcp__mebular__memory_')),
    JSON.stringify([...new Set(toolSamples)].slice(0, 20)));

    // 8) DSH has no non-persistent model-context channel: every model-visible
    // message is logged. Accept a durable source-tagged snapshot, but require
    // that it never becomes an ordinary user message or user-visible history.
    await sleep(1500);
    const history = await sessionLogText(world.state.dshHome);
    await writeTextEvidence('dsh-session-history.txt', history);
    const memoryHistoryEvents = history.split(/\r?\n/u)
      .filter((line) => line.trim().startsWith('{'))
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((entry) => entry?.type === 'user/message'
        && JSON.stringify(entry.data?.content ?? '').includes('<mebular_memory'));
    const unsourcedMemoryEvents = memoryHistoryEvents.filter((entry) => entry.data?.source?.kind !== 'mebular-memory');
    const unsourcedGistEvents = unsourcedMemoryEvents.filter((entry) => JSON.stringify(entry.data?.content ?? '').includes('用户偏好：default=深色主题'));
    check('DSH durable session log 只留下 source-tagged 快照（平台限制，非普通 user 消息）',
      memoryHistoryEvents.length > 0
      && unsourcedMemoryEvents.length === 0
      && unsourcedGistEvents.length === 0,
      JSON.stringify({
        memoryEvents: memoryHistoryEvents.length,
        unsourced: unsourcedMemoryEvents.length,
        unsourcedGist: unsourcedGistEvents.length,
      }));

    // 9) Fail open: discovery points at a dead sidecar; the turn still completes.
    const discoveryBeforeFailOpen = await deviceA.sidecarDiscovery();
    const failOpenStatusBefore = await requestSidecar(discoveryBeforeFailOpen, '/status');
    const contextsBeforeFailOpen = failOpenStatusBefore.data?.counts?.contexts ?? 0;
    const discoveryRecord = JSON.parse(await readFile(join(deviceA.home, 'memory-runtime.json'), 'utf8'));
    await breakDiscoveryUrl(deviceA);
    await sleep(2200); // discovery TTL + one poll
    await sendPrompt(world.state.page, `sidecar 离线也要回答 ${suffix}`);
    const failOpenTurn = await waitForAssistantTurns(world.state.page, 5);
    requireCheck('sidecar 不可达时 DSH 仍完成对话（失败开放）', failOpenTurn.ok,
      JSON.stringify({ matches: failOpenTurn.matches }));
    await captureEvidence(world.state.page, evidenceDir, 'dsh-fail-open');
    const failOpenStatusAfter = await requestSidecar(discoveryBeforeFailOpen, '/status');
    const contextsAfterFailOpen = failOpenStatusAfter.data?.counts?.contexts ?? 0;
    check('失败开放时 DSH 不再发起新的 /context 请求', contextsAfterFailOpen === contextsBeforeFailOpen,
      `before=${contextsBeforeFailOpen} after=${contextsAfterFailOpen}`);
    // Restore the discovery document so the remaining cross-device checks can
    // read the same real sidecar.
    await writeFile(join(deviceA.home, 'memory-runtime.json'), `${JSON.stringify(discoveryRecord, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    const failOpenDomFindings = visibleMemoryFindings(failOpenTurn.text, { detailText: seedPrompt });
    check('失败开放 DOM/截图不出现记忆块', failOpenDomFindings.length === 0, JSON.stringify(failOpenDomFindings));

    await writeFile(llmOut, redactEvidenceText(await readFile(llmOut, 'utf8')), 'utf8');
    await writeJsonEvidence('dsh-evidence.json', {
      dshUrl: world.redact(dshUrl),
      artifacts: {
        light: evidenceFiles('dsh-light'),
        context: evidenceFiles('dsh-context'),
        detail: evidenceFiles('dsh-detail'),
        silence: evidenceFiles('dsh-silence'),
        failOpen: evidenceFiles('dsh-fail-open'),
      },
      discoveryMs,
      followMs,
      counts: {
        ingest: ingestStatus.counts,
        afterFailOpen: contextsAfterFailOpen,
      },
      injected: {
        recall: tail(recallBlock, 1200),
        detail: tail(detailBlock, 1200),
      },
      expand: expand?.data ?? null,
      historyHasInjection: history.includes('<mebular_memory'),
      tools: [...new Set(toolSamples)],
    });

    // ----- Hermes on device B: cross-device detail + structured checkpoint.
    const checkpoint = await waitForValueOrThrow(
      async () => deviceA.sidecarCheckpoint(DSH_THREAD, 'dsh'),
      (value) => value !== null && value.state?.contentMode === 'structured',
      { timeoutMs: 30000, describe: 'DSH structured checkpoint' },
    );
    check('DSH 真实 sidecar 已持久化结构化 checkpoint',
      checkpoint?.structured === true
      && checkpoint?.state?.schema === 2
      && String(checkpoint?.state?.goal ?? '').includes('Continue the memory e2e task'),
    JSON.stringify(checkpoint?.state ?? null).slice(0, 900));

    await sync.request(deviceA, deviceB);
    const detailOnB = await waitForValueOrThrow(
      async () => deviceB.getDetail(seedDetail.id, { agentId: 'hermes' }).catch(() => null),
      (value) => value?.detail?.text === seedPrompt,
      { timeoutMs: 30000, describe: 'cross-device detail on B' },
    );
    check('Hermes 设备 B 可展开设备 A 的域内详情（真实同步）',
      detailOnB.detail.text === seedPrompt
      && detailOnB.detail.provenance?.deviceId === deviceA.deviceId,
    JSON.stringify({ deviceId: detailOnB.detail.provenance?.deviceId, domain: detailOnB.detail.domain }));

    const hermesHome = join(root, 'hermes-home');
    await mkdir(hermesHome, { recursive: true });
    const hermesNative = `HERMES-NATIVE-MEMORY-${suffix}`;
    await writeFile(join(hermesHome, 'MEMORY.md'), `# native\n${hermesNative}\n`, 'utf8');
    const hermesNativeHash = sha256(await readFile(join(hermesHome, 'MEMORY.md'), 'utf8'));
    await writeFile(join(hermesHome, 'mebular-memory.json'), JSON.stringify({
      agent_id: 'hermes',
      extractor: 'heuristic',
      recall_timeout: 3,
      ingest_timeout: 3,
      checkpoint_timeout: 3,
      archive_flush_timeout: 3,
    }, null, 2), 'utf8');
    const hermesConfig = {
      session_id: DSH_THREAD,
      query: '我的主题偏好是什么？',
      detail_query: '深色主题，我原话怎么说的？',
      checkpoint_query: '继续上次的任务',
      turn_user: `hermes 跨设备续写 ${suffix}`,
      turn_assistant: '已接续设备 A 的任务。',
      compress_user: `hermes 压缩归档 ${suffix}`,
      compress_assistant: '压缩前回复。',
      secret_system_prompt: `SECRET HOST PROMPT ${suffix}`,
      next_session_id: 'hermes-s2',
      next_turn_user: `hermes 第二会话 ${suffix}`,
      next_turn_assistant: '第二个会话。',
      skip_pre_compress: true,
    };
    const python = await runPython({
      HERMES_HOME: hermesHome,
      MEBULAR_MEMORY_RUNTIME_HOME: deviceB.home,
      MEBULAR_HOME: deviceB.home,
      MEBULAR_MEMORY_RUNTIME_URL: '',
      MEBULAR_MEMORY_RUNTIME_TOKEN: '',
      MEBULAR_RUNTIME_URL: '',
      MEBULAR_RUNTIME_TOKEN: '',
      HERMES_E2E_CONFIG: JSON.stringify(hermesConfig),
      PYTHONDONTWRITEBYTECODE: '1',
    }, repoRoot);
    const hermes = parseMarker(python.stdout) ?? parseMarker(python.stderr);
    check('Hermes 真实 plugin 进程退出 0', python.code === 0, `code=${python.code}`);
    requireCheck('Hermes 结果可解析', hermes !== null && hermes.error === undefined, hermes?.error ?? tail(python.stderr, 500));
    check('Hermes 不注册公共工具', Array.isArray(hermes.tools) && hermes.tools.length === 0);
    check('Hermes 使用 discovery + tokenFile', hermes.status?.tokenSource === 'tokenFile'
      && hermes.status?.discovery === 'discovery', JSON.stringify(hermes.status));
    check('Hermes 设备 B prefetch 展开 A 的详情（verbatim）',
      String(hermes.detailPrefetch ?? '').includes('<mebular_memory')
      && String(hermes.detailPrefetch ?? '').includes('detail (verbatim)')
      && String(hermes.detailPrefetch ?? '').includes(seedPrompt),
    tail(String(hermes.detailPrefetch ?? ''), 900));
    check('Hermes 跨设备读取 DSH 结构化 checkpoint',
      String(hermes.checkpointPrefetch ?? '').includes('mebular_checkpoint')
      && String(hermes.checkpointPrefetch ?? '').includes('Continue the memory e2e task'),
    tail(String(hermes.checkpointPrefetch ?? ''), 1000));
    const hermesNativeAfter = sha256(await readFile(join(hermesHome, 'MEMORY.md'), 'utf8'));
    check('Hermes 原生 MEMORY.md 未被改写', hermesNativeAfter === hermesNativeHash);
    check('Hermes profile 不持久化 sidecar host token', !JSON.stringify(hermes.status ?? {}).includes('host-token'));
    await writeJsonEvidence('hermes-result.json', {
      result: hermes,
      pythonExit: python.code,
      stderr: tail(python.stderr, 1000),
      nativeMemoryHash: { before: hermesNativeHash, after: hermesNativeAfter },
    });
    await writeTextEvidence('hermes-prefetch.txt', [
      '# detail prefetch',
      String(hermes.detailPrefetch ?? ''),
      '',
      '# checkpoint prefetch',
      String(hermes.checkpointPrefetch ?? ''),
      '',
    ].join('\n'));

    // ----- OpenCode / OpenChamber on device B: correction + delete.
    opencodeHome = join(root, 'opencode-home');
    const project = join(root, 'opencode-project');
    const configDir = join(opencodeHome, '.config', 'opencode');
    const openchamberDir = join(opencodeHome, '.config', 'openchamber');
    await mkdir(configDir, { recursive: true });
    await mkdir(project, { recursive: true });
    await mkdir(openchamberDir, { recursive: true });
    const openchamberSentinel = `OPENCHAMBER-NATIVE-${suffix}`;
    await writeFile(join(openchamberDir, 'memory.json'), JSON.stringify({
      version: 1,
      entries: [{ id: 'native-1', title: 'native', body: openchamberSentinel }],
    }, null, 2), 'utf8');
    await writeFile(join(openchamberDir, 'settings.json'), JSON.stringify({ agentMemoryToolEnabled: true }, null, 2), 'utf8');
    const nativeBefore = {
      memory: sha256(await readFile(join(openchamberDir, 'memory.json'), 'utf8')),
      settings: sha256(await readFile(join(openchamberDir, 'settings.json'), 'utf8')),
    };

    const portToken = `port${suffix.replace(/[^a-zA-Z0-9]/g, '')}`;
    const portQuery = `项目端口是多少 ${portToken}`;
    // Correction semantics are exercised through the capability `supersedes`
    // path (same subject/predicate, different object). The sidecar's automatic
    // supersede detection is a separate rule covered by the C6c unit tests
    // (packages/memory-runtime/tests/sidecar/ingest.test.ts).
    const portFact = (object) => ({
      subject: portQuery,
      predicate: 'port',
      object,
      confidence: 0.9,
    });
    const oldRecord = await deviceB.seedMemoryWithDetail({
      text: `${portQuery} 7332`,
      detailText: `${portQuery} 7332`,
      kind: 'fact',
      content: portFact('7332'),
      namespace: 'agent:opencode',
      agentId: 'opencode',
    });
    provider = await createFakeOpenAI({ reply: 'OK' });
    const opencodeHomeEnv = {
      HOME: opencodeHome,
      XDG_CONFIG_HOME: join(opencodeHome, '.config'),
      XDG_DATA_HOME: join(opencodeHome, '.local', 'share'),
      XDG_CACHE_HOME: join(opencodeHome, '.cache'),
      XDG_STATE_HOME: join(opencodeHome, '.local', 'state'),
      MEBULAR_HOME: deviceB.home,
      MEBULAR_MEMORY_RUNTIME_HOME: deviceB.home,
      MEBULAR_MEMORY_RUNTIME_URL: '',
      MEBULAR_RUNTIME_URL: '',
      MEBULAR_RUNTIME_TOKEN: '',
      OPENCHAMBER_MEMORY_ENABLE: '1',
      OPENCHAMBER_DATA_DIR: openchamberDir,
      NO_COLOR: '1',
    };
    await writeFile(join(configDir, 'opencode.json'), JSON.stringify(opencodeConfig({
      providerUrl: provider.url,
      pluginDir: join(repoRoot, 'packages', 'opencode-plugin'),
    }), null, 2), 'utf8');

    const port = await getFreePort();
    serve = spawn('opencode', ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
      cwd: project,
      env: { ...process.env, ...opencodeHomeEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let serveOut = '';
    let serveErr = '';
    serve.stdout.on('data', (chunk) => { serveOut += chunk.toString(); });
    serve.stderr.on('data', (chunk) => { serveErr += chunk.toString(); });
    const serveReady = await waitFor(() => /server listening on (http:\/\/\S+)/.test(serveOut), {
      timeoutMs: 30000,
      describe: 'opencode serve ready',
    });
    requireCheck('真实 opencode serve 启动', serveReady, tail(serveOut || serveErr, 600));
    const serverUrl = /server listening on (http:\/\/\S+)/.exec(serveOut)?.[1];

    const runPrompt = async (prompt, label, matchText) => {
      const startIndex = provider.state.requests.length;
      const run = await runProcess('opencode', [
        'run', '--server', serverUrl, '--format', 'json', prompt,
      ], { env: opencodeHomeEnv, cwd: project, timeoutMs: 120000 });
      check(`OpenCode ${label} 退出 0`, run.code === 0 && !run.timedOut,
        (run.stderr || run.stdout).slice(-700));
      const sessionID = parseSessionID(run.stdout);
      const request = await waitForValueOrThrow(
        async () => provider.state.requests.slice(startIndex)
          .filter((entry) => JSON.stringify(entry.body ?? {}).includes(matchText))
          .at(-1),
        (value) => value !== undefined,
        { timeoutMs: 15000, describe: `OpenCode ${label} model request` },
      );
      const text = JSON.stringify(request?.body ?? {});
      return { run, sessionID, request, text };
    };

    const oldTurn = await runPrompt(portQuery, '旧端口召回', '7332');
    check('OpenCode 首轮模型请求包含旧端口 7332',
      oldTurn.text.includes('7332') && oldTurn.text.includes('<mebular_memory'),
    tail(oldTurn.text, 900));

    const newRecord = await deviceB.seedMemoryWithDetail({
      text: `${portQuery} 7331`,
      detailText: `${portQuery} 7331`,
      kind: 'fact',
      content: portFact('7331'),
      supersedes: [oldRecord.recordId],
      namespace: 'agent:opencode',
      agentId: 'opencode',
    });
    const correctedTurn = await runPrompt(portQuery, '修正后召回', '7331');
    check('OpenCode 修正后模型请求出现新端口 7331',
      correctedTurn.text.includes('7331') && correctedTurn.text.includes('<mebular_memory'),
    tail(correctedTurn.text, 900));
    check('修正后旧端口 7332 不再作为当前事实注入',
      !correctedTurn.text.includes('7332'),
      correctedTurn.text.includes('7332') ? '新旧端口同时出现在同一召回块' : 'clean');
    const oldStillCurrent = await deviceB.recall('7332', {
      agentId: 'opencode',
      namespaces: ['agent:opencode'],
    });
    check('capability query 默认不再返回已修正旧事实 7332',
      !oldStillCurrent.records.some((record) => String(record.content ?? '').includes('7332')),
      JSON.stringify(oldStillCurrent.records.map((record) => record.content)));
    const oldHistory = await deviceB.recall('7332', {
      agentId: 'opencode',
      namespaces: ['agent:opencode'],
      includeHistory: true,
    });
    const oldHistoricalRecord = oldHistory.records.find((record) => record.id === oldRecord.recordId) ?? null;
    check('capability includeHistory 返回旧记录且保留 validTo/supersededBy',
      oldHistoricalRecord !== null
      && typeof oldHistoricalRecord.validTo === 'number'
      && oldHistoricalRecord.validTo > 0
      && oldHistoricalRecord.supersededBy === newRecord.recordId,
      JSON.stringify({
        id: oldHistoricalRecord?.id,
        validTo: oldHistoricalRecord?.validTo,
        supersededBy: oldHistoricalRecord?.supersededBy,
        newRecordId: newRecord.recordId,
      }));
    const newStillCurrent = await deviceB.recall('7331', {
      agentId: 'opencode',
      namespaces: ['agent:opencode'],
    });
    check('修正后新记录 7331 成为当前事实',
      newStillCurrent.records.some((record) => record.id === newRecord.recordId),
      JSON.stringify(newStillCurrent.records.map((record) => ({ id: record.id, content: record.content }))));
    const oldDetailBeforeDelete = await deviceB.getDetail(oldRecord.detailId, { agentId: 'opencode' })
      .catch((error) => ({ error: String(error?.message ?? error) }));
    check('修正后旧详情仍可读（历史证据）',
      String(oldDetailBeforeDelete?.detail?.text ?? '').includes('7332'),
      JSON.stringify(oldDetailBeforeDelete?.detail ?? oldDetailBeforeDelete?.error ?? null).slice(0, 700));

    const deleted = await deviceB.deleteMemory([oldRecord.recordId], { agentId: 'opencode' });
    check('OpenCode 删除旧记录写墓碑并级联详情',
      Array.isArray(deleted.deleted) && deleted.deleted.includes(oldRecord.recordId)
      && Array.isArray(deleted.detailsDeleted) && deleted.detailsDeleted.includes(oldRecord.detailId),
    JSON.stringify(deleted));
    const oldDetailAfterDelete = await deviceB.getDetail(oldRecord.detailId, { agentId: 'opencode' }).catch((error) => ({ error: String(error?.message ?? error) }));
    check('删除后详情不可再读（墓碑/410）',
      oldDetailAfterDelete?.error !== undefined
      || ['deleted', 'detail_deleted'].includes(oldDetailAfterDelete?.detail?.availability?.[0]),
    JSON.stringify(oldDetailAfterDelete).slice(0, 700));
    const deletedTurn = await runPrompt(portQuery, '删除后召回', portToken);
    check('删除后下一轮不再召回旧端口 7332', !deletedTurn.text.includes('7332'),
      deletedTurn.text.includes('7332') ? '旧值仍在模型请求中' : 'clean');
    const deletedRecall = await deviceB.recall('7332', {
      agentId: 'opencode',
      namespaces: ['agent:opencode'],
    });
    check('删除后 capability query 0 命中旧端口', deletedRecall.records.length === 0,
      JSON.stringify(deletedRecall.records.map((record) => record.content)));
    await writeJsonEvidence('opencode-recall.json', {
      old: { recordId: oldRecord.recordId, detailId: oldRecord.detailId, request: tail(oldTurn.text, 2500) },
      new: { recordId: newRecord.recordId, detailId: newRecord.detailId, request: tail(correctedTurn.text, 2500) },
      supersede: {
        currentQuery: oldStillCurrent.records.map((record) => record.content),
        history: oldHistory.records
          .filter((record) => record.id === oldRecord.recordId)
          .map((record) => ({
            id: record.id,
            content: record.content,
            validTo: record.validTo,
            supersededBy: record.supersededBy,
          })),
        oldDetail: oldDetailBeforeDelete?.detail ?? oldDetailBeforeDelete?.error ?? null,
        newCurrent: newStillCurrent.records
          .filter((record) => record.id === newRecord.recordId)
          .map((record) => ({ id: record.id, content: record.content })),
      },
      deleted: { result: deleted, request: tail(deletedTurn.text, 2500) },
    });

    const openchamberAfter = {
      memory: sha256(await readFile(join(openchamberDir, 'memory.json'), 'utf8')),
      settings: sha256(await readFile(join(openchamberDir, 'settings.json'), 'utf8')),
    };
    check('OpenChamber 原生 memory.json 未被改写', openchamberAfter.memory === nativeBefore.memory);
    check('OpenChamber 原生 settings.json 未被改写', openchamberAfter.settings === nativeBefore.settings);
    const opencodeDetails = await deviceB.resolveDetails({
      agentId: 'opencode',
      domains: ['agent:opencode', 'user', 'default'],
    });
    const opencodeTraceText = JSON.stringify(await deviceB.sidecarTraces());
    check('OpenChamber 原生记忆未进入 sidecar 详情/trace',
      !opencodeDetails.some((entry) => String(entry.text ?? '').includes(openchamberSentinel))
      && !opencodeTraceText.includes(openchamberSentinel));
    await writeJsonEvidence('openchamber-hashes.json', {
      before: nativeBefore,
      after: openchamberAfter,
      sentinel: openchamberSentinel,
    });

    check('opencode serve 全程存活', serve.exitCode === null, `exit=${serve.exitCode}`);

    // ----- Final sync/delete convergence.
    await sync.request(deviceA, deviceB);
    const oldOnA = await waitForValueOrThrow(
      async () => deviceA.app.graph.getNode(oldRecord.detailId),
      (value) => value === null || value?.deletedAt !== undefined && value?.deletedAt !== null,
      { timeoutMs: 30000, describe: 'delete tombstone on device A' },
    );
    check('删除墓碑经真实同步到达设备 A',
      oldOnA === null || oldOnA?.deletedAt !== undefined && oldOnA?.deletedAt !== null,
    JSON.stringify(oldOnA).slice(0, 500));

    await writeJsonEvidence('journey-summary.json', {
      startedAt,
      finishedAt: new Date().toISOString(),
      passed,
      failed,
      defects,
      devices: {
        a: { deviceId: deviceA.deviceId, home: '<temp>/device-a' },
        b: { deviceId: deviceB.deviceId, home: '<temp>/device-b' },
      },
      dsh: { thread: DSH_THREAD, detailId: seedDetail.id, domain: seedDetail.domain },
      opencode: {
        old: { recordId: oldRecord.recordId, detailId: oldRecord.detailId },
        new: { recordId: newRecord.recordId, detailId: newRecord.detailId },
        supersede: {
          validTo: oldHistoricalRecord?.validTo ?? null,
          supersededBy: oldHistoricalRecord?.supersededBy ?? null,
        },
      },
      sync: { namespaces: namespaceList },
    });

    exitCode = failed === 0 ? 0 : 1;
  } catch (error) {
    console.error(`✗ immersive journey 未捕获错误：${error?.stack ?? error}`);
    exitCode = 1;
  } finally {
    if (serve !== null) {
      try { serve.kill('SIGTERM'); } catch { /* best effort */ }
      await sleep(300);
      try { serve.kill('SIGKILL'); } catch { /* best effort */ }
    }
    await provider?.close().catch(() => undefined);
    if (world !== null) {
      await world.cleanup({ keep: options.keep || exitCode !== 0 }).catch(() => undefined);
    }
    await deviceB?.close().catch(() => undefined);
    await deviceA?.close().catch(() => undefined);
    if (exitCode === 0 && !options.keep) {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
      if (pnpmTempRoot) await rm(pnpmTempRoot, { recursive: true, force: true }).catch(() => undefined);
    } else {
      console.log(`临时根目录保留：${root}`);
      if (pnpmTempRoot) console.log(`临时 pnpm 保留：${pnpmTempRoot}`);
    }
  }

  console.log(`\n${failed === 0 ? '✓' : '✗'} immersive journey：${passed} passed, ${failed} failed, ${defects.length} defects`);
  if (defects.length > 0) {
    console.log('产品缺陷：');
    for (const defect of defects) console.log(`  - ${defect.name}：${defect.detail}`);
  }
  console.log(`证据：${evidenceDir}`);
  return exitCode;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    console.error(`✗ immersive journey 未捕获错误：${error?.stack ?? error}`);
    process.exitCode = 1;
  });
