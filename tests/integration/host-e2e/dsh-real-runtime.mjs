#!/usr/bin/env node
// DSH host E2E: real DSH Web profile + real @mebular/dsh-plugin + real Runtime.
//
// This is the fake-runtime E2E's sibling: same disposable DSH world and probe,
// but the Runtime URL points at a tap in front of the real Mebular Runtime
// HTTP server (temp home, heuristic, capture=local). The tap exists only to
// observe which requests the real DSH plugin made; it forwards every request
// and every response unchanged.
//
// Covered scenarios:
//   enabled-bearer  real Runtime auth=bearer + DSH memoryRuntime.auth=bearer
//   enabled-none    real Runtime auth=none   + DSH memoryRuntime.auth=none
//   disabled        memoryRuntime:false      + zero /runtime/v1 requests
//
// Usage:
//   node tests/integration/host-e2e/dsh-real-runtime.mjs
//   node tests/integration/host-e2e/dsh-real-runtime.mjs --scenario enabled-bearer
//   node tests/integration/host-e2e/dsh-real-runtime.mjs --dsh-version 0.2.1-rc.2 --keep

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createWorld } from '../../../scripts/lib/dsh-e2e-world.mjs';
import {
  packPackage,
  readJsonIfExists,
  runCommand,
  tail,
  waitForValue,
} from '../../../scripts/lib/e2e-process.mjs';
import { startRealRuntime } from './lib/real-runtime.mjs';
import { createRuntimeTap } from './lib/runtime-tap.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const pluginDir = join(repoRoot, 'packages', 'dsh-plugin');
const probeDir = join(repoRoot, 'tests', 'dsh', 'e2e', 'fixtures', 'memory-runtime-probe');
const versionsPath = join(repoRoot, 'tests', 'dsh', 'e2e', 'versions.json');
const THREAD_ID = 'dsh_memory-e2e-session';

let passed = 0;
let failed = 0;
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
}

function whichPnpm() {
  try {
    return execFileSync('pnpm', ['--version'], { encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

/**
 * `dsh plugin add` shells out to pnpm. This machine may not have pnpm on PATH;
 * install a disposable copy under the temp root and prepend it to PATH before
 * createWorld captures the environment. No global/user install is performed.
 */
async function ensurePnpm() {
  const existing = whichPnpm();
  if (existing) return existing;
  const dir = await mkdtemp(join(tmpdir(), 'mebular-host-e2e-pnpm-'));
  pnpmTempRoot = dir;
  console.log(`pnpm 未安装，安装临时副本：${dir}`);
  const result = await runCommand('npm install pnpm', 'npm', [
    'install', '--prefix', dir, '--no-audit', '--no-fund', '--prefer-offline', 'pnpm@10.34.8',
  ], { timeoutMs: 300000 });
  if (result.code !== 0) {
    throw new Error(`临时 pnpm 安装失败：${tail(result.stderr || result.stdout, 800)}`);
  }
  const bin = join(dir, 'node_modules', '.bin');
  process.env.PATH = `${bin}:${process.env.PATH ?? ''}`;
  return whichPnpm();
}

function parseArgs(argv) {
  const options = { scenarios: [], dshVersion: null, keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--keep') {
      options.keep = true;
    } else if (arg === '--scenario') {
      const value = argv[index + 1] ?? '';
      if (value.length === 0) throw new Error('--scenario 需要场景名');
      options.scenarios.push(value);
      index += 1;
    } else if (arg.startsWith('--scenario=')) {
      options.scenarios.push(arg.slice('--scenario='.length));
    } else if (arg === '--dsh-version') {
      options.dshVersion = argv[index + 1] ?? null;
      index += 1;
    } else if (arg.startsWith('--dsh-version=')) {
      options.dshVersion = arg.slice('--dsh-version='.length);
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  if (options.scenarios.length === 0) options.scenarios = ['enabled-bearer', 'enabled-none', 'disabled'];
  for (const name of options.scenarios) {
    if (!['enabled-bearer', 'enabled-none', 'disabled'].includes(name)) {
      throw new Error(`未知场景 ${name}`);
    }
  }
  return options;
}

function memoryPatch({ daemonUrl, mode, token }) {
  if (mode === 'disabled') {
    return [
      '# Memory runtime E2E: real Runtime, feature explicitly disabled.',
      '- id: mebular',
      "  name: '@mebular/dsh-plugin'",
      '  config:',
      '    lifecycle: attach',
      '    panel: false',
      `    daemonUrl: ${JSON.stringify(daemonUrl)}`,
      '    memoryRuntime: false',
      '',
    ].join('\n');
  }
  const auth = mode === 'enabled-bearer' ? 'bearer' : 'none';
  const tokenLine = mode === 'enabled-bearer' ? [`      token: ${JSON.stringify(token)}`] : [];
  return [
    `# Memory runtime E2E: real Runtime, auth=${auth}.`,
    '- id: mebular',
    "  name: '@mebular/dsh-plugin'",
    '  config:',
    '    lifecycle: attach',
    '    panel: false',
    `    daemonUrl: ${JSON.stringify(daemonUrl)}`,
    '    memoryRuntime:',
    '      enabled: true',
    '      recall: true',
    '      ingest: true',
    '      checkpoints: true',
    '      hideMemoryTools: true',
    `      auth: ${auth}`,
    ...tokenLine,
    '      ingestFlushMs: 0',
    '      ingestRetryBaseMs: 50',
    '      ingestRetries: 2',
    '',
  ].join('\n');
}

function runtimeRequests(state) {
  return (state?.requests ?? []).filter((request) => String(request.path).startsWith('/runtime/v1'));
}

async function waitFor(predicate, { timeoutMs = 15000, intervalMs = 100, describe = 'condition' } = {}) {
  const result = await waitForValue(predicate, (value) => value === true, {
    timeoutMs,
    intervalMs,
    describe,
  });
  return result.ok;
}

async function assertEnabled({ mode, runtime, tap, probe, seedToken }) {
  check('pre-step 首次注入 recall', probe.preStep?.injected === true, JSON.stringify(probe.preStep));
  check('注入来源为 mebular-memory', probe.preStep?.injectedSource === 'mebular-memory', String(probe.preStep?.injectedSource));
  check('同 turn/surface/query 第二次不重复注入', probe.preStep?.secondMessageCount === 1, JSON.stringify(probe.preStep));
  check('新 turn 再次注入', probe.preStep?.nextTurnInjected === true, JSON.stringify(probe.preStep));

  check('工具初始遮蔽 memory_*', Array.isArray(probe.tools?.initialDeny)
    && probe.tools.initialDeny.includes('mcp__mebular__memory_query')
    && probe.tools.initialDeny.includes('mcp__mebular__memory_write'), JSON.stringify(probe.tools?.initialDeny));
  check('task_* 保持可见', probe.tools?.taskKept === true, JSON.stringify(probe.tools));
  check('tools/change 动态补入新工具', Array.isArray(probe.tools?.replayedDeny)
    && probe.tools.replayedDeny.includes('mcp__mebular__memory_new_tool'), JSON.stringify(probe.tools?.replayedDeny));

  const requests = runtimeRequests(tap.state);
  check('真实 Runtime 收到 /runtime/v1 请求', requests.length > 0, `count=${requests.length}`);
  check('请求认证模式符合场景', requests.every((request) => request.auth === (mode === 'enabled-bearer' ? 'bearer' : 'missing')),
    JSON.stringify(requests.slice(0, 8).map((request) => `${request.path}:${request.auth}`)));
  check('真实 Runtime 未拒绝任何插件请求', requests.every((request) => request.ok),
    JSON.stringify(requests.filter((request) => !request.ok).map((request) => `${request.path}:${request.status}`)));

  const recalls = requests.filter((request) => request.method === 'POST' && request.path === '/runtime/v1/recall');
  check('pre-step recall 走真实 /recall', recalls.length === 2, `count=${recalls.length}`);
  check('真实 Runtime recall 返回 seed 记录', recalls.some((request) => JSON.stringify(request.response).includes(seedToken)),
    JSON.stringify(recalls.map((request) => request.status)));

  const ingests = requests.filter((request) => request.method === 'POST' && request.path === '/runtime/v1/ingest');
  const ingestText = ingests.map((request) => (request.body?.chunks ?? []).map((chunk) => chunk.text).join('\n')).join('\n');
  check('真实 Runtime 收到 ingest', ingests.length > 0 && ingestText.includes('memory e2e ingest')
    && ingestText.includes('memory e2e assistant'), `count=${ingests.length}`);
  check('ingest 复用 requestId（重复 session 事件只入队一次）', ingests[0]?.idempotencyKey === ingests[0]?.body?.requestId,
    ingests[0]?.idempotencyKey ?? 'missing');

  const checkpoints = requests.filter((request) => request.method === 'PUT'
    && request.path === `/runtime/v1/checkpoints/${THREAD_ID}`);
  check('compaction checkpoint 走真实 PUT', checkpoints.length > 0
    && checkpoints.every((request) => request.ok)
    && checkpoints.at(-1)?.body?.state?.compactionId === 'memory-e2e-compaction',
    JSON.stringify(checkpoints.map((request) => request.status)));

  const stored = await waitFor(async () => {
    const checkpoint = await runtime.checkpoint(THREAD_ID, 'dsh').catch(() => null);
    return checkpoint?.state?.compactionId === 'memory-e2e-compaction'
      && String(checkpoint.summary).includes('memory e2e compacted summary');
  }, { describe: 'real Runtime checkpoint' });
  check('真实 Runtime 已持久化 compaction checkpoint', stored);
  const checkpoint = await runtime.checkpoint(THREAD_ID, 'dsh');
  check('checkpoint 保留 DSH 状态与 summary', checkpoint?.agentId === 'dsh'
    && checkpoint?.state?.kind === 'dsh-compaction'
    && checkpoint?.summary === 'memory e2e compacted summary', JSON.stringify(checkpoint));

  const rawFound = await waitFor(async () => {
    const raw = await runtime.rawChunks();
    const text = raw.map((chunk) => chunk.text).join('\n');
    return text.includes('memory e2e ingest') && text.includes('memory e2e assistant');
  }, { describe: 'real Runtime raw chunks' });
  const raw = await runtime.rawChunks();
  const dshRaw = raw.filter((chunk) => String(chunk.threadId).startsWith('dsh_'));
  check('真实 Runtime 本地 raw 含 DSH ingest 内容', rawFound && dshRaw.length >= 2,
    `chunks=${raw.length}, dsh=${dshRaw.length}`);
  check('DSH raw 只带 DSH thread（过程数据只在本地）',
    dshRaw.length >= 2 && dshRaw.every((chunk) => String(chunk.threadId).startsWith('dsh_')),
    JSON.stringify(dshRaw.map((chunk) => chunk.threadId)));

  const status = await runtime.status();
  check('真实 Runtime capture 未写入图（仅 seed 一条 MemoryRecord）',
    status?.counts?.memoryRecords === 1, JSON.stringify(status?.counts));
  check('真实 Runtime status 计数反映 raw', status?.counts?.localRawChunks >= 2, JSON.stringify(status?.counts));
  check('真实 Runtime status 无 token 泄漏', !JSON.stringify(status).includes(runtime.token));
}

async function runScenario({ mode, root, dshBin, dshInstall, dshVersion, pluginTarball, probeTarball, options }) {
  console.log(`\n▶ ${mode}`);
  const runtime = await startRealRuntime({
    auth: mode === 'enabled-bearer' ? 'bearer' : 'none',
    token: `dsh-real-${mode}-${Date.now()}`,
  });
  const tap = await createRuntimeTap(runtime.url, { name: `dsh-${mode}` });
  let world = null;
  try {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const seedToken = `dsh-real-seed-${suffix}`;
    const seed = await runtime.seedMemory({
      text: `My memory e2e query is ${seedToken}`,
      namespace: 'default',
      agentId: 'dsh',
    });
    requireCheck('真实 Runtime heuristic seed 写入', seed.accepted.records === 1, JSON.stringify(seed.records));

    if (mode === 'enabled-bearer') {
      const missing = await fetch(`${runtime.url}/runtime/v1/status`);
      check('无 bearer 被真实 Runtime 拒绝', missing.status === 401, `status=${missing.status}`);
      const wrong = await fetch(`${runtime.url}/runtime/v1/status`, {
        headers: { authorization: 'Bearer wrong-token' },
      });
      check('错误 bearer 被真实 Runtime 拒绝', wrong.status === 401, `status=${wrong.status}`);
    }

    world = await createWorld({
      name: `real-runtime-${mode}`,
      root,
      repoRoot,
      dshBin,
      dshInstall,
      dshVersion,
      pluginTarball,
      probeTarball,
    });
    const resultPath = join(world.state.artifactsDir, 'memory-runtime-probe.json');
    const bundles = await world.installProfile({
      patch: memoryPatch({ daemonUrl: tap.url, mode, token: runtime.token }),
    });
    requireCheck('profile 包含插件与 probe', bundles.includes('@mebular/dsh-plugin')
      && bundles.includes('@mebular/dsh-memory-runtime-probe'), JSON.stringify(bundles));

    const dshUrl = await world.startDsh({
      probeExpect: null,
      env: { MEMORY_E2E_OUT: resultPath },
    });
    check('DSH Web 已启动', /^http:\/\/127\.0\.0\.1:\d+\//.test(dshUrl), world.redact(dshUrl));

    const probeResult = await waitForValue(
      async () => readJsonIfExists(resultPath),
      (value) => value !== null && (value.done === true || typeof value.error === 'string'),
      { timeoutMs: 90000, intervalMs: 250, describe: 'memory runtime probe' },
    );
    const probe = probeResult.value;
    requireCheck('probe 完成', probeResult.ok && probe?.done === true && !probe?.error,
      probe?.error ?? tail(JSON.stringify(probe ?? null), 500));

    if (mode === 'disabled') {
      check('关闭态不注入 recall', probe.preStep?.injected === false, JSON.stringify(probe.preStep));
      check('关闭态不遮蔽工具', probe.tools?.initialDeny === null, JSON.stringify(probe.tools));
      check('关闭态没有 /runtime/v1 请求', runtimeRequests(tap.state).length === 0,
        `count=${runtimeRequests(tap.state).length}`);
      check('关闭态没有绕过 tap 的 Runtime 写', (await runtime.status())?.counts?.memoryRecords === 1,
        JSON.stringify((await runtime.status())?.counts));
    } else {
      await assertEnabled({ mode, runtime, tap, probe, seedToken });
    }

    const artifacts = await world.collectArtifacts(`dsh-real-runtime-${mode}`).catch(() => null);
    check('artifacts 已脱敏（无敏感片段）', artifacts !== null && artifacts.leaks.length === 0,
      artifacts === null ? 'collect failed' : JSON.stringify(artifacts.leaks));
    check('tap 状态不包含 bearer token', !JSON.stringify(tap.state).includes(runtime.token));
    console.log(`  artifacts：${world.state.artifactsDir}`);
  } finally {
    await tap.close().catch(() => undefined);
    if (world !== null) {
      await world.cleanup({ keep: options.keep || failed > 0 }).catch(() => undefined);
    }
    if (options.keep) {
      console.log(`  临时 Runtime home 保留：${runtime.home}`);
      await runtime.close().catch(() => undefined);
    } else {
      await runtime.cleanup().catch(() => undefined);
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const versions = JSON.parse(await readFile(versionsPath, 'utf-8'));
  const dshVersion = options.dshVersion
    ?? (process.env.DSH_VERSION && process.env.DSH_VERSION.trim().length > 0 ? process.env.DSH_VERSION.trim() : null)
    ?? versions.current
    ?? versions.minimum;

  console.log('DSH host E2E（真实 DSH + 真实 Runtime HTTP，无外部模型）');
  console.log('======================================================');
  console.log(`场景：${options.scenarios.join(', ')}`);
  console.log(`DSH 版本：${dshVersion}`);

  const preflight = [];
  preflight.push(check('repo build present（dist/index.js）', existsSync(join(repoRoot, 'dist', 'index.js'))));
  preflight.push(check('Mebular CLI present', existsSync(join(repoRoot, 'packages', 'mcp', 'bin', 'mebular.mjs'))));
  let pnpmVersion = null;
  try {
    pnpmVersion = await ensurePnpm();
  } catch (error) {
    pnpmVersion = null;
    console.log(`  pnpm 准备失败：${error?.message ?? error}`);
  }
  preflight.push(check('pnpm available（dsh plugin add 需要）', Boolean(pnpmVersion), pnpmVersion ?? '未找到 pnpm'));
  if (preflight.some((value) => value !== true)) {
    console.log('\n前置条件不满足，未启动任何场景。');
    if (pnpmTempRoot) await rm(pnpmTempRoot, { recursive: true, force: true }).catch(() => undefined);
    return 1;
  }

  const root = await mkdtemp(join(tmpdir(), 'mebular-dsh-real-runtime-e2e-'));
  const packDir = join(root, 'pack');
  const dshInstall = join(root, 'dsh-install');
  await mkdir(packDir, { recursive: true });
  console.log(`临时根目录：${root}`);

  let exitCode = 0;
  try {
    const pluginTarball = await packPackage(pluginDir, packDir, '@mebular/dsh-plugin');
    const probeTarball = await packPackage(probeDir, packDir, '@mebular/dsh-memory-runtime-probe');
    requireCheck('npm pack @mebular/dsh-plugin', pluginTarball.size > 0, pluginTarball.filename);
    requireCheck('npm pack memory runtime probe', probeTarball.size > 0, probeTarball.filename);

    const install = await runCommand('npm install dsh', 'npm', [
      'install', '--prefix', dshInstall,
      '--no-audit', '--no-fund', '--prefer-offline',
      `@deepseek-ai/dsh@${dshVersion}`,
    ], { timeoutMs: 900000 });
    requireCheck(`npm install @deepseek-ai/dsh@${dshVersion}`, install.code === 0, tail(install.stderr, 900));
    const dshBin = join(dshInstall, 'node_modules', '.bin', 'dsh');
    requireCheck('dsh binary present', existsSync(dshBin), dshBin);

    for (const mode of options.scenarios) {
      await runScenario({
        mode,
        root,
        dshBin,
        dshInstall,
        dshVersion,
        pluginTarball,
        probeTarball,
        options,
      });
    }

    console.log(`\n${failed === 0 ? '✓' : '✗'} DSH host E2E：${passed} passed, ${failed} failed`);
    exitCode = failed === 0 ? 0 : 1;
  } catch (error) {
    console.error(`✗ DSH host E2E 失败：${error?.stack ?? error}`);
    exitCode = 1;
  } finally {
    if (exitCode === 0 && !options.keep) {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
      if (pnpmTempRoot) await rm(pnpmTempRoot, { recursive: true, force: true }).catch(() => undefined);
    } else {
      console.log(`临时根目录保留：${root}`);
    }
  }
  return exitCode;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    console.error(`✗ DSH host E2E 未捕获错误：${error?.stack ?? error}`);
    process.exitCode = 1;
  });
