#!/usr/bin/env node
// 0.4.0 shadow attribution E2E：real opencode >= 2.2 server + real
// @mebular/opencode-plugin + real MCP daemon with the Memory Capability API +
// real Memory Runtime sidecar configured with internal intervention.diagnosticShadow=true.
//
// It proves the host attributes outcomes to the *applied* intervention, not to
// the policy's shadow advice:
//   turn 1 (shadow): decision=silent (low confidence / broad cue),
//                    applied=speak because shadow keeps the baseline injection.
//   turn 2:          an explicit memory re-ask must become `reasked`; it must
//                    never become `missed`, even though the shadow decision
//                    said silent.
// The local policy counters must record the applied `spoken` in `diagnostic`
// (W6 keeps shadow/model out of the adaptive `global` bucket). The shadow
// `silent` advice must never be counted as silent or missed. Only the
// OpenAI-compatible provider is fake (same convention as
// opencode-real-runtime.mjs). No sidecar/plugin behaviour is mocked.

import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFakeOpenAI } from './lib/fake-openai.mjs';
import { requestSidecar, sidecarTokenFromFile, startRealRuntime } from './lib/real-runtime.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const pluginDir = join(repoRoot, 'packages', 'opencode-plugin');
const SIDECAR_API = '/memory-runtime/v1';
const OPENCODE_BIN = process.env.OPENCODE_BIN || 'opencode';

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `（${detail}）` : ''}`);
  return ok;
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

async function waitFor(predicate, { timeoutMs = 20000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await predicate();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
  }
  return null;
}

function opencodeConfig({ providerUrl, pluginOptions }) {
  return {
    $schema: 'https://opencode.ai/config.json',
    model: 'mock/mock',
    update: 'disable',
    plugins: [{ package: pluginDir, options: pluginOptions }],
    providers: {
      mock: {
        name: 'Intervention Shadow E2E Mock',
        package: '@opencode/ai/providers/openai-compatible',
        settings: { baseURL: `${providerUrl}/v1`, apiKey: 'intervention-e2e-not-a-secret' },
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
      // ignore non-JSON lines
    }
  }
  return null;
}

async function listTraces(discovery, threadId) {
  const query = `?limit=100${threadId ? `&threadId=${encodeURIComponent(threadId)}` : ''}`;
  const result = await requestSidecar(discovery, `/traces${query}`);
  if (result.status !== 200) {
    throw new Error(`GET /traces failed: ${result.status} ${JSON.stringify(result.body)}`);
  }
  return Array.isArray(result.data?.traces) ? result.data.traces : [];
}

async function fetchTrace(discovery, traceId) {
  const result = await requestSidecar(discovery, `/traces/${encodeURIComponent(traceId)}`);
  return result.status === 200 ? result.data : null;
}

async function findTrace(discovery, { threadId, includes, timeoutMs = 20000 }) {
  return waitFor(async () => {
    const traces = await listTraces(discovery, threadId);
    return traces.find((trace) => (
      trace.threadId === threadId && String(trace.queryPreview ?? '').includes(includes)
    )) ?? null;
  }, { timeoutMs });
}

async function waitOutcome(discovery, traceId, kind, { timeoutMs = 20000 } = {}) {
  return waitFor(async () => {
    const trace = await fetchTrace(discovery, traceId);
    return trace?.outcome?.kind === kind ? trace : null;
  }, { timeoutMs });
}

async function readPolicyState(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

// W6 起 policy state 是 v2：adaptive 计数在 global，非 heuristic（shadow/model）
// 只写 diagnostic。shadow E2E 的计数必须落在 diagnostic，global 必须保持 0。
const POLICY_COUNT_KEYS = ['spoken', 'silent', 'accepted', 'ignored', 'reasked', 'corrected', 'dismissed', 'missed', 'too_shallow', 'too_deep'];

function countOf(bucket, key) {
  return (bucket && typeof bucket === 'object' ? bucket[key] : undefined) ?? 0;
}

function countsAllZero(bucket) {
  return Boolean(bucket) && typeof bucket === 'object'
    && POLICY_COUNT_KEYS.every((key) => key in bucket && countOf(bucket, key) === 0);
}

/** diagnostic 除 allow 列出的键必须为 0；逐项核对完整 10 个计数（键必须都在）。 */
function diagnosticOnly(bucket, allowedKeys) {
  if (!bucket || typeof bucket !== 'object') return false;
  return POLICY_COUNT_KEYS.every((key) => key in bucket && (
    allowedKeys.includes(key) ? countOf(bucket, key) >= 1 : countOf(bucket, key) === 0
  ));
}

async function main() {
  const keep = process.argv.includes('--keep');
  const runRoot = join(tmpdir(), `mebular-intervention-shadow-e2e-${process.pid}-${Date.now()}`);
  const home = join(runRoot, 'home');
  const project = join(runRoot, 'project');
  const mebularHome = join(runRoot, 'mebular-home');
  const openchamberDir = join(home, '.config', 'openchamber');
  const configDir = join(home, '.config', 'opencode');
  const policyStatePath = join(mebularHome, 'memory-runtime', 'policy', 'state.json');
  await mkdir(configDir, { recursive: true });
  await mkdir(project, { recursive: true });
  await mkdir(join(mebularHome, 'memory-runtime'), { recursive: true });
  await mkdir(openchamberDir, { recursive: true });

  await writeFile(join(mebularHome, 'memory-runtime', 'config.json'), JSON.stringify({
    schema: 1,
    trace: 'local',
    model: { source: 'heuristic' },
    intervention: {
      // 0.4.0：旧 mode 不再启用 shadow；shadow 只能由内部 diagnostic 打开。
      // Shadow computes advice but keeps the baseline injection. A very high
      // minConfidence makes the advice silent for a broad/low-confidence cue
      // (the PolicyStore clamps the effective threshold to 0.80).
      mode: 'off',
      diagnosticShadow: true,
      minConfidence: 0.99,
      maxSilentStreak: 99,
      explorationRate: 0,
      outcomeWindowMs: 600000,
      policyTtlDays: 30,
      modelTimeoutMs: 500,
    },
    http: { host: '127.0.0.1', port: 0 },
  }, null, 2), 'utf8');

  const runtime = await startRealRuntime({
    auth: 'none',
    root: runRoot,
    memoryRuntime: { enabled: true },
    manageMemoryRuntime: true,
  });
  const discovery = await runtime.waitForSidecar();
  const hostToken = sidecarTokenFromFile(await readFile(discovery.tokenFile, 'utf8'));
  const provider = await createFakeOpenAI({ reply: 'OK' });
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const preferenceText = `我的偏好是深色模式 ${suffix}`;
  const pluginOptions = {
    agentId: 'opencode',
    recall: true,
    ingest: true,
    checkpoints: true,
    hideMemoryTools: true,
    modelSource: 'heuristic',
    recallTimeoutMs: 5000,
    ingestTimeoutMs: 5000,
    maxContextBytes: 8192,
    outcomes: true,
    outcomeTimeoutMs: 3000,
    outcomeWindowMs: 600000,
    outcomeIgnoredDelayMs: 900000,
  };
  await writeFile(join(configDir, 'opencode.json'), JSON.stringify(opencodeConfig({
    providerUrl: provider.url,
    pluginOptions,
  }), null, 2), 'utf8');

  const baseEnv = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    MEBULAR_HOME: mebularHome,
    MEBULAR_MEMORY_RUNTIME_HOME: mebularHome,
    MEBULAR_MEMORY_RUNTIME_URL: '',
    MEBULAR_RUNTIME_URL: '',
    MEBULAR_RUNTIME_TOKEN: '',
    OPENCHAMBER_MEMORY_ENABLE: '1',
    OPENCHAMBER_DATA_DIR: openchamberDir,
    NO_COLOR: '1',
  };

  let serve = null;
  try {
    console.log('0.4.0 shadow attribution E2E（真实 opencode + 真实 sidecar + 真实插件）');
    console.log('==========================================================================');

    check('真实 sidecar discovery 写出 /memory-runtime/v1',
      String(discovery.url).endsWith(SIDECAR_API), discovery.url);
    check('host-token 文件包含真实 host token',
      typeof hostToken === 'string' && hostToken.length > 0
      && !JSON.stringify(discovery).includes(hostToken));

    const version = await requestSidecar(discovery, '/version');
    check('/version 声明 shadow 能力且 mode=shadow',
      version.status === 200
      && version.data?.capabilities?.intervention?.shadow === true
      && version.data?.capabilities?.intervention?.mode === 'shadow',
      JSON.stringify(version.data?.capabilities?.intervention));

    const seeded = await runtime.seedMemory({
      text: preferenceText,
      namespace: 'user',
      agentId: 'opencode',
      threadId: `th_intervention_shadow_seed_${suffix}`,
      confirmation: 'explicit',
    });
    check('真实 capability 写入 user 域偏好 seed',
      seeded.accepted.records === 1, JSON.stringify({ records: seeded.accepted.records }));

    const opencodeVersion = await runProcess(OPENCODE_BIN, ['--version'], { timeoutMs: 20000 });
    const versionText = `${opencodeVersion.stdout}\n${opencodeVersion.stderr}`.trim();
    const supported = /v?2\.(?:[2-9]|[1-9]\d)\./.test(versionText);
    if (!check('opencode 可启动且 >= 2.2', opencodeVersion.code === 0 && supported,
      versionText.split('\n')[0] ?? `missing ${OPENCODE_BIN}`)) {
      console.log('  → 需要一个 >= 2.2 的 opencode 二进制；可用 OPENCODE_BIN 或 PATH 指定。');
      return 1;
    }

    const port = await getFreePort();
    serve = spawn(OPENCODE_BIN, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
      cwd: project,
      env: { ...process.env, ...baseEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let serveOut = '';
    let serveErr = '';
    serve.stdout.on('data', (chunk) => { serveOut += chunk.toString(); });
    serve.stderr.on('data', (chunk) => { serveErr += chunk.toString(); });
    const ready = await waitFor(() => /server listening on (http:\/\/\S+)/.test(serveOut), {
      timeoutMs: 30000,
    });
    check('真实 opencode serve 启动', Boolean(ready), (serveOut || serveErr).slice(-500));
    if (!ready) return 1;
    const serverUrl = /server listening on (http:\/\/\S+)/.exec(serveOut)?.[1];

    const turn = async (sessionID, prompt) => {
      const args = sessionID
        ? ['run', '--session', sessionID, '--server', serverUrl, '--format', 'json', prompt]
        : ['run', '--server', serverUrl, '--format', 'json', prompt];
      // 同 outcome E2E：首轮可能和刚启动的 server 竞争，未拿到 sessionID 时重试。
      const attempts = sessionID ? 1 : 3;
      let result;
      let id;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        result = await runProcess(OPENCODE_BIN, args, { env: baseEnv, cwd: project, timeoutMs: 120000 });
        id = sessionID ?? parseSessionID(result.stdout);
        if (result.code === 0 && !result.timedOut && typeof id === 'string' && id.startsWith('ses')) break;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
      }
      check(`真实 opencode turn 退出 0（${prompt.slice(0, 24)}…）`,
        result.code === 0 && !result.timedOut && typeof id === 'string' && id.startsWith('ses'),
        (result.stderr || result.stdout).slice(-400));
      return id;
    };

    // A low-confidence cue ("我的偏好") stays below the effective shadow
    // threshold. Shadow keeps the baseline injection, so decision=silent while
    // applied=speak.
    const sessionS = await turn(null, '我的偏好');
    const traceS1 = await findTrace(discovery, { threadId: sessionS, includes: '我的偏好' });
    check('S1 shadow 建议 silent，但真实注入按 baseline 发生（applied=speak）',
      traceS1?.decision?.action === 'silent'
      && traceS1?.decision?.enforced === false
      && traceS1?.applied?.action === 'speak'
      && traceS1?.applied?.wouldAction === 'silent'
      && (traceS1?.counts?.injected ?? 0) >= 1,
      JSON.stringify({
        decision: traceS1?.decision,
        applied: traceS1?.applied,
        counts: traceS1?.counts,
      }));
    check('S1 decision.action 与 applied.action 不同',
      traceS1?.decision?.action === 'silent' && traceS1?.applied?.action === 'speak',
      JSON.stringify({ decision: traceS1?.decision?.action, applied: traceS1?.applied?.action }));

    const stateS1 = await waitFor(async () => {
      const state = await readPolicyState(policyStatePath);
      return countOf(state?.diagnostic, 'spoken') >= 1 ? state : null;
    }, { timeoutMs: 10000 });
    check('shadow 的本机 policy 统计写 diagnostic.spoken，global 保持 0（W6）',
      Boolean(stateS1)
      && stateS1.version === 2
      // applied=speak 与 shadow 建议 silent 不同：只有真实生效的 speak 被计数。
      && diagnosticOnly(stateS1.diagnostic, ['spoken'])
      && countsAllZero(stateS1.global),
      JSON.stringify({ global: stateS1?.global, diagnostic: stateS1?.diagnostic }));

    // Explicit memory re-ask. With applied=speak this is `reasked`; if the host
    // attributed the shadow decision it would post `missed` instead.
    await turn(sessionS, '再说一遍刚才那个偏好');
    const traceS1Reasked = await waitOutcome(discovery, traceS1.id, 'reasked');
    const traceS1Final = await fetchTrace(discovery, traceS1.id);
    check('S2 下一轮显式记忆重问 → 真实 outcome 记录 reasked',
      traceS1Reasked?.outcome?.kind === 'reasked'
      && traceS1Reasked?.outcome?.source === 'host',
      JSON.stringify(traceS1Reasked?.outcome));
    check('S2 shadow 建议没有被当成实际沉默（无 missed）',
      traceS1Final?.outcome?.kind !== 'missed'
      && !(Array.isArray(traceS1Final?.outcomeHistory)
        && traceS1Final.outcomeHistory.some((entry) => entry?.kind === 'missed')),
      JSON.stringify({
        outcome: traceS1Final?.outcome,
        history: traceS1Final?.outcomeHistory,
      }));

    const stateS2 = await waitFor(async () => {
      const state = await readPolicyState(policyStatePath);
      return countOf(state?.diagnostic, 'reasked') >= 1 ? state : null;
    }, { timeoutMs: 10000 });
    check('shadow 的 outcome 也只写 diagnostic（reasked），global 保持 0 且无 missed',
      Boolean(stateS2)
      && stateS2.version === 2
      && countOf(stateS2.diagnostic, 'reasked') >= 1
      && countOf(stateS2.diagnostic, 'spoken') >= 1
      && countOf(stateS2.diagnostic, 'missed') === 0
      // 其余 outcome 诊断计数必须为 0（完整核对，不只 missed）。
      && ['accepted', 'ignored', 'corrected', 'dismissed', 'too_shallow', 'too_deep']
        .every((key) => countOf(stateS2.diagnostic, key) === 0)
      && countsAllZero(stateS2.global),
      JSON.stringify({ global: stateS2?.global, diagnostic: stateS2?.diagnostic }));

    if (serve.exitCode !== null) {
      check('opencode serve 全程存活', false, `exit=${serve.exitCode} ${serveErr.slice(-300)}`);
    } else {
      check('opencode serve 全程存活', true);
    }
  } finally {
    if (serve !== null) {
      try { serve.kill('SIGTERM'); } catch { /* best effort */ }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
      try { serve.kill('SIGKILL'); } catch { /* best effort */ }
    }
    await provider.close().catch(() => undefined);
    if (keep) {
      console.log(`临时目录保留：${runRoot}（Mebular home：${mebularHome}）`);
      await runtime.close().catch(() => undefined);
    } else {
      await runtime.cleanup().catch(() => undefined);
      await rm(runRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  console.log(`\n${failed === 0 ? '✓' : '✗'} Shadow attribution E2E：${passed} passed, ${failed} failed`);
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    console.error(`✗ Shadow attribution E2E 未捕获错误：${error?.stack ?? error}`);
    process.exitCode = 1;
  });
