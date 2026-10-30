#!/usr/bin/env node
/**
 * Real DSH memory runtime E2E.
 *
 * Reuses the existing disposable world (`scripts/lib/dsh-e2e-world.mjs`) and
 * installs the real `@mebular/dsh-plugin` plus a test-only probe into a real
 * `@deepseek-ai/dsh` Web profile. The Runtime is a local fake HTTP server:
 * no external model, no Mebular identity/secrets and no user home are touched.
 *
 * Covered:
 *   - pre-step recall injection and same-anchor dedupe, new-turn re-recall;
 *   - memory tool masking and tools/change replay;
 *   - compaction checkpoint PUT;
 *   - ingest retry with one requestId/idempotency-key and duplicate-event dedupe;
 *   - bearer authentication (valid token, no token leak in the fake state);
 *   - disabled memoryRuntime: zero /memory-runtime/v1 requests and no injection.
 *
 * Usage:
 *   node tests/dsh/e2e/memory-runtime-e2e.mjs [--scenario enabled|disabled]
 *     [--dsh-version <version>] [--keep]
 *
 * Prerequisites (fail loudly, never skip): repo build, Mebular CLI, pnpm,
 * network/npm cache for `@deepseek-ai/dsh`. Chrome is not required.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
import { createFakeRuntime } from './fake-runtime-server.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const pluginDir = join(repoRoot, 'packages', 'dsh-plugin');
const probeDir = join(repoRoot, 'tests', 'dsh', 'e2e', 'fixtures', 'memory-runtime-probe');
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
}

function parseArgs(argv) {
  const options = { scenarios: [], dshVersion: null, keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--keep') {
      options.keep = true;
    } else if (arg === '--scenario') {
      const value = argv[index + 1] ?? '';
      if (value.length === 0) throw new Error('--scenario 需要 enabled 或 disabled');
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
  if (options.scenarios.length === 0) options.scenarios = ['enabled', 'disabled'];
  for (const name of options.scenarios) {
    if (name !== 'enabled' && name !== 'disabled') {
      throw new Error(`未知场景 ${name}；可选 enabled, disabled`);
    }
  }
  return options;
}

function memoryPatch({ daemonUrl, sidecarUrl, enabled, token }) {
  const runtime = enabled
    ? [
      '    memoryRuntime:',
      '      enabled: true',
      `      url: ${JSON.stringify(sidecarUrl)}`,
      '      recall: true',
      '      ingest: true',
      '      checkpoints: true',
      '      hideMemoryTools: true',
      '      auth: bearer',
      `      token: ${JSON.stringify(token)}`,
      '      domains:',
      '        - user',
      '        - agent:dsh',
      '        - default',
      '      ingestFlushMs: 0',
      '      ingestRetryBaseMs: 5',
      '      ingestRetries: 2',
    ]
    : ['    memoryRuntime: false'];
  return [
    '# Memory runtime E2E: attach to the fake sidecar, no panel/browser.',
    '- id: mebular',
    "  name: '@mebular/dsh-plugin'",
    '  config:',
    '    lifecycle: attach',
    '    panel: false',
    `    daemonUrl: ${JSON.stringify(daemonUrl)}`,
    ...runtime,
    '',
  ].join('\n');
}

function runtimeRequests(state) {
  return (state?.requests ?? []).filter((request) => String(request.path).startsWith('/memory-runtime/v1'));
}

function findIngestAttempts(state, requestId) {
  return (state?.ingests ?? []).filter((entry) => entry.requestId === requestId);
}

async function runScenario({ name, world, runtime, resultPath }) {
  console.log(`\n▶ ${name}`);
  try {
    const dshUrl = await world.startDsh({
      probeExpect: null,
      env: { MEMORY_E2E_OUT: resultPath },
    });
    check('DSH Web 已启动', /^http:\/\/127\.0\.0\.1:\d+\//.test(dshUrl), world.redact(dshUrl));

    const result = await waitForValue(
      async () => readJsonIfExists(resultPath),
      (value) => value !== null && (value.done === true || typeof value.error === 'string'),
      { timeoutMs: 90000, intervalMs: 250, describe: 'memory runtime probe' },
    );
    const probe = result.value;
    requireCheck('probe 完成', result.ok && probe?.done === true && !probe?.error, probe?.error ?? tail(JSON.stringify(probe ?? null), 500));
    return await assertScenario({ name, world, runtime, probe });
  } catch (error) {
    const dshLog = `${world.state.dsh?.stdout ?? ''}\n${world.state.dsh?.stderr ?? ''}`;
    console.log(`  DSH log（tail）：${world.redact(tail(dshLog, 2400))}`);
    throw error;
  }
}

async function assertScenario({ name, world, runtime, probe }) {
  const response = await fetch(`${runtime.url}/__state`);
  const server = await response.json();
  check('fake Runtime /__state 可读', response.status === 200 && server !== null, `status=${response.status}`);
  await mkdir(world.state.artifactsDir, { recursive: true });
  await writeFile(
    join(world.state.artifactsDir, 'fake-runtime-state.json'),
    `${JSON.stringify(server, null, 2)}\n`,
    'utf-8',
  );

  if (name === 'enabled') {
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

    const runtimeOnly = runtimeRequests(server);
    check('Runtime 请求全部通过 bearer 认证', runtimeOnly.length > 0
      && runtimeOnly.every((request) => request.auth === 'bearer' && request.authorized === true),
    JSON.stringify(runtimeOnly.map((request) => `${request.path}:${request.auth}`)));
    check('fake Runtime 未记录 401', (server.unauthorized ?? 0) === 0, String(server.unauthorized ?? 'missing'));

    const recalls = runtimeOnly.filter((request) => request.path === '/memory-runtime/v1/context');
    // 新 turn / tool surface 可能产生多次 context；去重由 probe 的 secondMessageCount 断言，
    // 这里只要求至少两次且请求全部经过 bearer 认证，避免把测试夹具扩展误判为回归。
    check('context 请求至少两次且未重复注入', recalls.length >= 2, `count=${recalls.length}`);

    const accepted = (server.ingests ?? []).find((entry) => entry.duplicate === false);
    requireCheck('ingest 至少一次成功', accepted !== undefined, JSON.stringify(server.ingests ?? []));
    check('ingest 请求不带 legacy sync', accepted?.hasSync !== true, JSON.stringify(accepted));
    const attempts = findIngestAttempts(server, accepted.requestId);
    check('重试复用同一 requestId', attempts.length === 3 && attempts.every((entry) => entry.key === accepted.key), `attempts=${attempts.length}`);
    check('重复 session 事件只入队一次', Array.isArray(accepted.messageIds)
      && new Set(accepted.messageIds).size === accepted.messageIds.length
      && accepted.messageIds.includes('memory-e2e-session:1')
      && accepted.messageIds.includes('memory-e2e-session:2'),
    JSON.stringify(accepted.messageIds));

    const committed = (server.checkpoints ?? []).find((entry) => entry.committed === true
      && entry.compactionId === 'memory-e2e-compaction');
    check('compaction checkpoint 已提交', committed !== undefined
      && typeof committed?.summary === 'string'
      && committed.summary.includes('Continue the memory e2e task')
      && committed?.stateSchema === 2
      && ['structured', 'summary_only'].includes(committed?.contentMode),
    JSON.stringify(committed));
    check('checkpoint 写入 task 域且不带 sync', committed?.domain === 'task:dsh_memory-e2e-session'
      && committed?.hasSync !== true, JSON.stringify(committed));

    check('fake Runtime state 不含 bearer token', !JSON.stringify(server).includes(runtime.token), 'token redacted');
  } else {
    check('关闭态不注入 recall', probe.preStep?.injected === false, JSON.stringify(probe.preStep));
    check('关闭态不遮蔽工具', probe.tools?.initialDeny === null, JSON.stringify(probe.tools));
    check('关闭态没有 /memory-runtime/v1 请求', runtimeRequests(server).length === 0, `count=${runtimeRequests(server).length}`);
  }

  const artifacts = await world.collectArtifacts(`memory-runtime-${name}`).catch(() => null);
  check('artifacts 已脱敏（无敏感片段）', artifacts !== null && artifacts.leaks.length === 0,
    artifacts === null ? 'collect failed' : JSON.stringify(artifacts.leaks));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const versions = JSON.parse(await readFile(versionsPath, 'utf-8'));
  const dshVersion = options.dshVersion
    ?? (process.env.DSH_VERSION && process.env.DSH_VERSION.trim().length > 0 ? process.env.DSH_VERSION.trim() : null)
    ?? versions.current
    ?? versions.minimum;

  console.log('DSH memory runtime E2E（fake Runtime，无外部模型）');
  console.log('===============================================');
  console.log(`场景：${options.scenarios.join(', ')}`);
  console.log(`DSH 版本：${dshVersion}`);

  const preflight = [];
  preflight.push(check('repo build present（dist/index.js）', existsSync(join(repoRoot, 'dist', 'index.js'))));
  preflight.push(check('Mebular CLI present', existsSync(join(repoRoot, 'packages', 'mcp', 'bin', 'mebular.mjs'))));
  let pnpmVersion = null;
  try {
    pnpmVersion = execFileSync('pnpm', ['--version'], { encoding: 'utf-8' }).trim();
  } catch {
    pnpmVersion = null;
  }
  preflight.push(check('pnpm available（dsh plugin add 需要）', Boolean(pnpmVersion), pnpmVersion ?? '未找到 pnpm'));
  if (preflight.some((value) => value !== true)) {
    console.log('\n前置条件不满足，未启动任何场景。');
    return 1;
  }

  const root = await mkdtemp(join(tmpdir(), 'mebular-memory-runtime-e2e-'));
  const packDir = join(root, 'pack');
  const dshInstall = join(root, 'dsh-install');
  await mkdir(packDir, { recursive: true });
  console.log(`临时根目录：${root}`);

  const runtimes = [];
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

    for (const scenario of options.scenarios) {
      const token = `memory-e2e-token-${scenario}`;
      const runtime = await createFakeRuntime({
        auth: 'bearer',
        token,
        records: [{ id: 'memory-e2e-record', type: 'fact', content: 'memory e2e recalled fact', why: 'e2e' }],
        ingestFailTimes: scenario === 'enabled' ? 2 : 0,
      });
      runtimes.push(runtime);
      const world = await createWorld({
        name: `memory-runtime-${scenario}`,
        root,
        repoRoot,
        dshBin,
        dshInstall,
        dshVersion,
        pluginTarball,
        probeTarball,
      });
      const resultPath = join(world.state.artifactsDir, 'memory-runtime-probe.json');
      try {
        const bundles = await world.installProfile({
          patch: memoryPatch({
            daemonUrl: runtime.url,
            sidecarUrl: runtime.sidecarUrl,
            enabled: scenario === 'enabled',
            token,
          }),
        });
        requireCheck('profile 包含插件与 probe', bundles.includes('@mebular/dsh-plugin')
          && bundles.includes('@mebular/dsh-memory-runtime-probe'), JSON.stringify(bundles));
        await runScenario({
          name: scenario,
          world,
          runtime: { ...runtime, token },
          resultPath,
        });
      } finally {
        await world.cleanup({ keep: options.keep || failed > 0 });
      }
    }

    console.log(`\n${failed === 0 ? '✓' : '✗'} DSH memory runtime E2E：${passed} passed, ${failed} failed`);
    exitCode = failed === 0 ? 0 : 1;
  } catch (error) {
    console.error(`✗ DSH memory runtime E2E 失败：${error?.stack ?? error}`);
    exitCode = 1;
  } finally {
    for (const runtime of runtimes) await runtime.close().catch(() => undefined);
    if (exitCode === 0 && !options.keep) {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    } else {
      console.log(`临时根目录保留：${root}`);
    }
  }
  return exitCode;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    console.error(`✗ DSH memory runtime E2E 未捕获错误：${error?.stack ?? error}`);
    process.exitCode = 1;
  });
