#!/usr/bin/env node
// DSH host E2E: real DSH Web profile + real @mebular/dsh-plugin + real MCP
// daemon with the Memory Capability API + real Memory Runtime sidecar.
//
// The DSH plugin is the exact tarball packed from packages/dsh-plugin. It talks
// to the real MCP daemon (`daemonUrl`) and to the real sidecar at
// `/memory-runtime/v1` (discovery or explicit URL). The sidecar talks to the
// real capability API, which writes the real MemoryService/GraphStore. No fake
// sidecar and no legacy `/runtime/v1` host path are used.
//
// Covered scenarios:
//   auto-discovery  no memoryRuntime config; real discovery + host token; tap
//                   observes requests without configuring the host
//   no-discovery    light MCP: no sidecar, no discovery, zero sidecar requests
//   fail-open       discovery points at a down sidecar; the turn still completes
//
// Token-file: the real sidecar writes `{version,token,...}` to `host-token`
// and the DSH adapter reads that JSON record directly. The harness does not
// inject the token, so this suite covers the production discovery path.
//
// Usage:
//   node tests/integration/host-e2e/dsh-real-runtime.mjs
//   node tests/integration/host-e2e/dsh-real-runtime.mjs --scenario auto-discovery
//   node tests/integration/host-e2e/dsh-real-runtime.mjs --dsh-version 0.2.1-rc.2 --keep

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
import { requestSidecar, sidecarTokenFromFile, startRealRuntime } from './lib/real-runtime.mjs';
import { createRuntimeTap } from './lib/runtime-tap.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const pluginDir = join(repoRoot, 'packages', 'dsh-plugin');
const probeDir = join(repoRoot, 'tests', 'dsh', 'e2e', 'fixtures', 'memory-runtime-probe');
const versionsPath = join(repoRoot, 'tests', 'dsh', 'e2e', 'versions.json');
const THREAD_ID = 'dsh_memory-e2e-session';
const SIDECAR_API = '/memory-runtime/v1';

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
  if (options.scenarios.length === 0) options.scenarios = ['auto-discovery', 'no-discovery', 'fail-open'];
  for (const name of options.scenarios) {
    if (!['auto-discovery', 'no-discovery', 'fail-open'].includes(name)) {
      throw new Error(`未知场景 ${name}`);
    }
  }
  return options;
}

function memoryPatch({ daemonUrl, mode }) {
  // No per-host memoryRuntime enabled/capture/url configuration: discovery and
  // the sidecar mode own all of it. The timing knobs are test-only.
  return [
    `# DSH memory runtime E2E: automatic mode following (${mode}).`,
    '- id: mebular',
    "  name: '@mebular/dsh-plugin'",
    '  config:',
    '    lifecycle: attach',
    '    panel: false',
    `    daemonUrl: ${JSON.stringify(daemonUrl)}`,
    '    memoryRuntime:',
    '      ingestFlushMs: 0',
    '      ingestRetryBaseMs: 50',
    '      ingestRetries: 2',
    '',
  ].join('\n');
}

async function waitFor(predicate, { timeoutMs = 15000, intervalMs = 100, describe = 'condition' } = {}) {
  const result = await waitForValue(predicate, (value) => value === true, {
    timeoutMs,
    intervalMs,
    describe,
  });
  return result.ok;
}

async function startSidecar(runtimeRoot) {
  const home = join(runtimeRoot, 'mebular-home');
  await mkdir(join(home, 'memory-runtime'), { recursive: true });
  await writeFile(join(home, 'memory-runtime', 'config.json'), JSON.stringify({
    schema: 1,
    trace: 'local',
    model: { source: 'heuristic' },
    // Port 0 avoids colliding with a developer's sidecar or another suite.
    http: { host: '127.0.0.1', port: 0 },
  }, null, 2), 'utf8');

  const runtime = await startRealRuntime({
    auth: 'none',
    root: runtimeRoot,
    memoryRuntime: { enabled: true },
    manageMemoryRuntime: true,
  });
  const discovery = await runtime.waitForSidecar();
  return { runtime, discovery };
}

async function startRuntimeOnly(runtimeRoot) {
  const runtime = await startRealRuntime({
    auth: 'none',
    root: runtimeRoot,
    memoryRuntime: { enabled: false },
    manageMemoryRuntime: false,
  });
  return { runtime, discovery: null };
}

/** Point the discovery file at the tap so a production discovery path is observed. */
async function redirectDiscoveryToTap(runtime, discovery, tap) {
  const path = join(runtime.home, 'memory-runtime.json');
  const record = JSON.parse(await readFile(path, 'utf8'));
  record.url = `${tap.url}${SIDECAR_API}`;
  record.healthUrl = `${tap.url}${SIDECAR_API}/health`;
  record.updatedAt = Date.now();
  await writeFile(path, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600 });
  return { ...discovery, url: record.url, healthUrl: record.healthUrl };
}

/** Keep a valid discovery document but make every request fail. */
async function breakDiscoveryUrl(runtime) {
  const path = join(runtime.home, 'memory-runtime.json');
  const record = JSON.parse(await readFile(path, 'utf8'));
  record.url = `http://127.0.0.1:1${SIDECAR_API}`;
  record.healthUrl = `http://127.0.0.1:1${SIDECAR_API}/health`;
  record.updatedAt = Date.now();
  await writeFile(path, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600 });
}

function tapRequests(tap) {
  return tap === null ? [] : tap.allRequests();
}

function sidecarRequestsFromTap(tap) {
  return tapRequests(tap).filter((entry) => String(entry.path).startsWith(SIDECAR_API));
}

function assertDiscovery(discovery, hostToken) {
  check('真实 sidecar discovery 写出 /memory-runtime/v1',
    String(discovery.url).endsWith(SIDECAR_API), discovery.url);
  check('sidecar discovery 声明真实能力',
    discovery.kind === 'mebular-memory-runtime'
    && discovery.apiVersion === 1
    && discovery.capabilityApiVersion === 1
    && discovery.capabilities?.context === true
    && discovery.capabilities?.ingest === true
    && discovery.capabilities?.checkpoint === true,
    JSON.stringify({
      kind: discovery.kind,
      apiVersion: discovery.apiVersion,
      capabilityApiVersion: discovery.capabilityApiVersion,
      capabilities: discovery.capabilities,
    }));
  check('sidecar discovery 不含 token 明文',
    !JSON.stringify(discovery).includes(hostToken)
    && discovery.token === undefined
    && discovery.capabilityToken === undefined);
  check('sidecar discovery 使用 host-token tokenFile',
    typeof discovery.tokenFile === 'string'
    && discovery.tokenFile.endsWith('/memory-runtime/host-token'),
    discovery.tokenFile);
}

async function assertTokenFile(discovery, hostToken) {
  const info = await stat(discovery.tokenFile);
  check('host-token 文件权限 0600',
    process.platform === 'win32' || (info.mode & 0o077) === 0,
    (info.mode & 0o777).toString(8));
  const record = JSON.parse(await readFile(discovery.tokenFile, 'utf8'));
  check('host-token 文件包含真实 host token',
    record?.version === 1 && record?.token === hostToken && typeof record?.expiresAt === 'number',
    JSON.stringify({ version: record?.version, expiresAt: record?.expiresAt }));

  const missing = await fetch(`${discovery.url}/status`);
  check('无 host token 被真实 sidecar 拒绝', missing.status === 401, `status=${missing.status}`);
  const wrong = await fetch(`${discovery.url}/status`, {
    headers: { authorization: 'Bearer wrong-token' },
  });
  check('错误 host token 被真实 sidecar 拒绝', wrong.status === 401, `status=${wrong.status}`);
  const ok = await requestSidecar(discovery, '/status');
  check('真实 host token 可访问 /status', ok.status === 200 && ok.data != null, `status=${ok.status}`);
}

async function assertEnabled({ runtime, tap, probe, seedToken, detailText, hostToken }) {
  check('pre-step 首次注入 recall', probe.preStep?.injected === true, JSON.stringify(probe.preStep));
  check('注入来源为 mebular-memory（不是 source.kind=user）',
    probe.preStep?.injectedSource === 'mebular-memory', String(probe.preStep?.injectedSource));
  check('同 turn/surface/query 第二次不重复注入',
    probe.preStep?.secondMessageCount === 1, JSON.stringify(probe.preStep));
  check('第二轮（新 message id）再次召回并注入',
    probe.preStep?.nextTurnInjected === true, JSON.stringify(probe.preStep));
  check('详情追问注入 sidecar detail block',
    probe.preStep?.detailInjected === true
    && probe.preStep?.detailSource === 'mebular-memory'
    && String(probe.preStep?.detailText ?? '').includes(detailText),
    JSON.stringify({ injected: probe.preStep?.detailInjected, text: probe.preStep?.detailText?.slice?.(0, 300) }));
  check('无命中话题保持沉默，不注入空块',
    probe.preStep?.silenceInjected === false,
    JSON.stringify({ injected: probe.preStep?.silenceInjected }));
  check('compaction 后新 turn 注入结构化 checkpoint',
    probe.preStep?.checkpointInjected === true
    && probe.preStep?.checkpointSource === 'mebular-memory'
    && String(probe.preStep?.checkpointText ?? '').includes('Continue the memory e2e task')
    && String(probe.preStep?.checkpointText ?? '').includes('Verify the next turn injects the checkpoint'),
    JSON.stringify({ injected: probe.preStep?.checkpointInjected, text: probe.preStep?.checkpointText?.slice?.(0, 400) }));

  check('工具初始遮蔽 memory_*', Array.isArray(probe.tools?.initialDeny)
    && probe.tools.initialDeny.includes('mcp__mebular__memory_query')
    && probe.tools.initialDeny.includes('mcp__mebular__memory_write'), JSON.stringify(probe.tools?.initialDeny));
  check('task_* 保持可见', probe.tools?.taskKept === true, JSON.stringify(probe.tools));
  check('tools/change 动态补入新工具', Array.isArray(probe.tools?.replayedDeny)
    && probe.tools.replayedDeny.includes('mcp__mebular__memory_new_tool'), JSON.stringify(probe.tools?.replayedDeny));

  const status = await waitForStatus(runtime, (value) => (value?.counts?.contexts ?? 0) >= 2
    && (value?.counts?.ingested ?? 0) >= 1
    && (value?.counts?.checkpoints ?? 0) >= 1);
  check('真实 sidecar 记录 context 请求', (status?.counts?.contexts ?? 0) >= 2,
    JSON.stringify(status?.counts));
  check('真实 sidecar 记录 ingest 请求', (status?.counts?.ingested ?? 0) >= 1,
    JSON.stringify(status?.counts));
  check('真实 sidecar 记录 checkpoint 提交', (status?.counts?.checkpoints ?? 0) >= 1,
    JSON.stringify(status?.counts));
  check('真实 sidecar 记录 duplicate_turn 静默', (status?.counts?.recallSilent ?? 0) >= 1,
    JSON.stringify(status?.counts));
  check('真实 sidecar outbox 已清空', (status?.outbox?.items ?? 0) === 0,
    JSON.stringify(status?.outbox));
  check('sidecar /status 不含 host token', !JSON.stringify(status).includes(hostToken));

  const traces = await runtime.sidecarTraces();
  check('真实 sidecar trace 记录 human query',
    traces.length >= 2
    && traces.some((trace) => String(trace.queryPreview ?? '').includes('memory e2e query')),
    JSON.stringify(traces.map((trace) => trace.queryPreview)));

  // Detail is the authoritative, domain-shared object. The adapter must be
  // able to render it from the sidecar response without any local raw copy.
  const detailsResult = await waitForValue(async () => {
    const values = await runtime.resolveDetails({
      agentId: 'dsh',
      domains: ['default', 'user', 'agent:dsh'],
    }).catch(() => []);
    return values.length > 0 ? values : null;
  }, (value) => value !== null, { describe: 'real capability detail records' });
  const details = detailsResult.value ?? [];
  const detailBlob = details.map((entry) => `${entry.domain}:${entry.text ?? ''}`).join('\n');
  check('真实 capability 可读取域内详情（非本机 raw）',
    details.some((entry) => String(entry.text ?? '').includes(detailText)),
    detailBlob.slice(0, 500));
  check('详情带同域 citation 与可用性', details.every((entry) => Array.isArray(entry.availability)
    && entry.availability.includes('available')
    && Array.isArray(entry.recordIds)
    && entry.recordIds.length > 0),
  JSON.stringify(details.map((entry) => ({
    domain: entry.domain,
    availability: entry.availability,
    recordIds: entry.recordIds,
  }))));

  const stored = await waitFor(async () => {
    const checkpoint = await runtime.sidecarCheckpoint(THREAD_ID, 'dsh').catch(() => null);
    return checkpoint?.state?.compactionId === 'memory-e2e-compaction'
      && checkpoint?.state?.contentMode === 'structured';
  }, { describe: 'real sidecar checkpoint' });
  const checkpoint = await runtime.sidecarCheckpoint(THREAD_ID, 'dsh');
  check('真实 sidecar 已持久化 compaction checkpoint', stored, JSON.stringify(checkpoint));
  check('checkpoint 保留 DSH 状态、结构化字段与 summary', checkpoint?.agentId === 'dsh'
    && checkpoint?.state?.kind === 'dsh-compaction'
    && checkpoint?.state?.contentMode === 'structured'
    && checkpoint?.structured === true
    && checkpoint?.state?.task?.key === `task:${THREAD_ID}`
    && String(checkpoint?.state?.goal ?? '').includes('Continue the memory e2e task')
    && Array.isArray(checkpoint?.state?.nextSteps)
    && checkpoint.state.nextSteps.length > 0
    && String(checkpoint?.summary ?? '').includes('Continue the memory e2e task')
    && String(checkpoint?.domain).startsWith('task:'), JSON.stringify(checkpoint));

  // The prototype route is gone; hosts only use /memory-runtime/v1.
  const legacy = await runtime.legacyRuntimeStatus();
  check('旧 /runtime/v1 已移除（404）',
    legacy.status === 404 && legacy.deprecatedHeader === null,
    `status=${legacy.status} deprecated=${legacy.deprecatedHeader ?? 'none'}`);
  check('旧 /runtime/v1 不返回 DSH ingest',
    !JSON.stringify(legacy.body ?? {}).includes('memory e2e ingest')
    && !JSON.stringify(legacy.body ?? {}).includes('memory e2e assistant'),
    JSON.stringify(legacy.body).slice(0, 300));

  const requests = sidecarRequestsFromTap(tap);
  check('自动 discovery 收到请求（host 未配置 URL）', requests.length > 0, `count=${requests.length}`);
  check('自动 discovery 请求全部认证为 bearer',
    requests.every((request) => request.auth === 'bearer'),
    JSON.stringify(requests.slice(0, 8).map((request) => `${request.path}:${request.auth}`)));
  check('自动 discovery 请求未被真实 sidecar 拒绝',
    requests.every((request) => request.ok),
    JSON.stringify(requests.filter((request) => !request.ok).map((request) => `${request.path}:${request.status}`)));

  const contexts = requests.filter((request) => request.method === 'POST'
    && request.path === `${SIDECAR_API}/context`);
  check('pre-step recall 走真实 /memory-runtime/v1/context', contexts.length >= 4,
    `count=${contexts.length}`);
  check('context 请求带 DSH agent 与 human turn',
    contexts.every((request) => request.body?.agentId === 'dsh'
      && request.body?.turnKind === 'human'
      && typeof request.body?.query === 'string'),
    JSON.stringify(contexts.map((request) => request.body?.query)));
  check('context 响应包含 seed 记忆',
    contexts.some((request) => JSON.stringify(request.response).includes(seedToken)),
    JSON.stringify(contexts.map((request) => request.status)));

  const ingests = requests.filter((request) => request.method === 'POST'
    && request.path === `${SIDECAR_API}/ingest`);
  const ingestText = ingests.map((request) => (request.body?.chunks ?? []).map((chunk) => chunk.text).join('\n')).join('\n');
  check('第一轮真实 ingest 包含 user 与 assistant 文本',
    ingests.length > 0 && ingestText.includes('memory e2e ingest') && ingestText.includes('memory e2e assistant'),
    `count=${ingests.length}`);
  check('ingest 复用 requestId（Idempotency-Key === body.requestId）',
    ingests.length > 0
    && ingests.every((request) => request.idempotencyKey === request.body?.requestId),
    ingests.map((request) => request.idempotencyKey ?? 'missing').join(','));

  const checkpoints = requests.filter((request) => request.method === 'PUT'
    && request.path === `${SIDECAR_API}/checkpoints/${THREAD_ID}`);
  check('compaction checkpoint 走真实 PUT', checkpoints.length > 0
    && checkpoints.every((request) => request.ok)
    && checkpoints.at(-1)?.body?.state?.compactionId === 'memory-e2e-compaction'
    && checkpoints.at(-1)?.body?.sync === undefined,
  JSON.stringify(checkpoints.map((request) => request.status)));
  check('sidecar 路径全部为 /memory-runtime/v1',
    requests.every((request) => String(request.path).startsWith(SIDECAR_API)),
    JSON.stringify(requests.map((request) => request.path)));
  const captured = requests.filter((request) => (
    Object.prototype.hasOwnProperty.call(request.body ?? {}, 'capture')
    || Object.prototype.hasOwnProperty.call(request.body ?? {}, 'rawCapture')
  ));
  check('所有 DSH 请求都不带 capture/rawCapture 字段', captured.length === 0,
    JSON.stringify(captured.map((request) => request.path)));
}

async function waitForStatus(runtime, predicate, { timeoutMs = 15000 } = {}) {
  let last = null;
  const ok = await waitFor(async () => {
    last = await runtime.sidecarStatus().catch(() => null);
    return last !== null && predicate(last) === true;
  }, { timeoutMs, describe: 'sidecar status' });
  return ok ? last ?? await runtime.sidecarStatus() : last;
}

async function runScenario({ mode, root, dshBin, dshInstall, dshVersion, pluginTarball, probeTarball, options }) {
  console.log(`\n▶ ${mode}`);
  const runtimeRoot = join(root, `runtime-${mode}-${Date.now()}`);
  const withSidecar = mode !== 'no-discovery';
  const { runtime, discovery } = withSidecar
    ? await startSidecar(runtimeRoot)
    : await startRuntimeOnly(runtimeRoot);
  const hostToken = discovery === null
    ? ''
    : sidecarTokenFromFile(await readFile(discovery.tokenFile, 'utf8'));
  // The tap forwards the full `/memory-runtime/v1/...` path, so its target is
  // the sidecar origin rather than the discovery base URL (which already
  // contains that prefix).
  const tap = discovery === null
    ? null
    : await createRuntimeTap(new URL(discovery.url).origin, { name: `dsh-sidecar-${mode}` });
  let world = null;
  try {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const seedToken = `dsh-real-seed-${suffix}`;
    const detailToken = `dsh-real-detail-${suffix}`;
    const detailText = `我默认用深色主题 ${detailToken}`;

    if (discovery !== null) {
      assertDiscovery(discovery, hostToken);
      await assertTokenFile(discovery, hostToken);
      const seed = await runtime.seedMemoryWithDetail({
        text: `原话 ${seedToken} My memory e2e query is ${seedToken}`,
        detailText,
        namespace: 'default',
        agentId: 'dsh',
      });
      requireCheck('真实 MCP capability 写入记录与详情', seed.accepted.records === 1
        && typeof seed.recordId === 'string'
        && typeof seed.detailId === 'string',
      JSON.stringify({ records: seed.records, detailId: seed.detailId }));
      if (mode === 'auto-discovery' && tap !== null) {
        await redirectDiscoveryToTap(runtime, discovery, tap);
      }
      if (mode === 'fail-open') {
        await breakDiscoveryUrl(runtime);
      }
    }

    world = await createWorld({
      name: `real-sidecar-${mode}`,
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
      patch: memoryPatch({ daemonUrl: runtime.url, mode }),
    });
    requireCheck('profile 包含插件与 probe', bundles.includes('@mebular/dsh-plugin')
      && bundles.includes('@mebular/dsh-memory-runtime-probe'), JSON.stringify(bundles));

    const dshUrl = await world.startDsh({
      probeExpect: null,
      env: {
        MEMORY_E2E_OUT: resultPath,
        MEMORY_E2E_DETAIL_QUERY: `原话 ${seedToken}`,
        MEMORY_E2E_SILENT_QUERY: `tomorrow weather small talk ${suffix}`,
        // The real sidecar lives under the Runtime home; keep the plugin's
        // discovery and token lookup pointed there. No host URL/token config.
        MEBULAR_HOME: runtime.home,
        MEBULAR_MEMORY_RUNTIME_HOME: runtime.home,
        MEBULAR_MEMORY_RUNTIME_URL: '',
        MEBULAR_RUNTIME_URL: '',
        MEBULAR_RUNTIME_TOKEN: '',
      },
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

    if (mode === 'auto-discovery') {
      await assertEnabled({ runtime, tap, probe, seedToken, detailText, hostToken });
    } else if (mode === 'no-discovery') {
      check('轻量/无 discovery 不注入 recall', probe.preStep?.injected === false, JSON.stringify(probe.preStep));
      check('轻量/无 discovery 不遮蔽工具', probe.tools?.initialDeny === null, JSON.stringify(probe.tools));
      check('轻量/无 discovery 不产生 context/ingest/checkpoint 请求',
        tap === null && discovery === null, 'no sidecar was started');
      const legacy = await runtime.legacyRuntimeStatus();
      check('轻量态旧 /runtime/v1 已移除（404）',
        legacy.status === 404 && legacy.deprecatedHeader === null,
        `status=${legacy.status} deprecated=${legacy.deprecatedHeader ?? 'none'}`);
    } else {
      check('sidecar 不可达时仍完成对话（失败开放）', probeResult.ok && probe?.done === true,
        JSON.stringify(probe.preStep));
      check('sidecar 不可达时不注入记忆', probe.preStep?.injected === false, JSON.stringify(probe.preStep));
      check('sidecar 不可达时不抛错、不阻塞', probe?.error === null, String(probe?.error));
    }

    const artifacts = await world.collectArtifacts(`dsh-real-runtime-${mode}`).catch(() => null);
    check('artifacts 已脱敏（无敏感片段）', artifacts !== null && artifacts.leaks.length === 0,
      artifacts === null ? 'collect failed' : JSON.stringify(artifacts.leaks));
    if (tap !== null) {
      check('tap 状态不包含 host token', !JSON.stringify(tap.state).includes(hostToken));
    }
    if (discovery !== null && mode !== 'fail-open') {
      check('Memory capability status 不含 host token', !JSON.stringify(await runtime.status()).includes(hostToken));
    }
    console.log(`  artifacts：${world.state.artifactsDir}`);
  } finally {
    await tap?.close().catch(() => undefined);
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

  console.log('DSH host E2E（真实 DSH + 真实 MCP capability + 真实 sidecar，无外部模型）');
  console.log('========================================================================');
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
