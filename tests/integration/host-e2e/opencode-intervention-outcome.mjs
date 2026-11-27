#!/usr/bin/env node
// 0.4.0 intervention outcome E2E：real opencode >= 2.2 server + real
// @mebular/opencode-plugin + real MCP daemon with the Memory Capability API +
// real Memory Runtime sidecar. The only fake is the OpenAI-compatible provider
// that lets OpenCode finish a turn without an external LLM (same convention as
// opencode-real-runtime.mjs).
//
// It drives the full outcome loop over real HTTP:
//   user turn -> plugin /context -> sidecar decision -> model request
//   next user turn -> plugin attributes the previous decision -> POST /recall/:id/outcome
//   sidecar trace/policy stats -> /traces, /status, /intervention/reset
//
// Scenarios:
//   1. speak -> re-ask            => reasked
//   2. silent (chitchat) -> memory follow-up => missed
//   3. gist -> "具体/细节" request => too_shallow
//   4. detail -> "太长了/简单点" request => too_deep
//   5. POST /intervention/reset clears local policy stats but keeps traces and memory
//   6. privacy: policy state / traces / Console view contain no detail body,
//      no host token, and no raw-query tail beyond the existing redacted preview.
//
// No production code is imported by path and no sidecar/plugin behaviour is
// mocked. The script uses a temporary home and never touches a real Mebular home.

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

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

// `opencode run --server` 偶发在 server 刚打印 listening 时拿不到连接，退出码 1
// 且 stderr 只有 "Could not reach server at ..."。这属于宿主启动竞争，不是产品
// 断言失败；只对这种传输层症状做有界重试，其它失败立即交给最终 check 判定。
const TRANSIENT_TRANSPORT_PATTERNS = [
  /could not reach server/i,
  /econnrefused/i,
  /econnreset/i,
  /connection refused/i,
  /socket hang up/i,
  /fetch failed/i,
  /eai_again/i,
  /etimedout/i,
];

function isTransientTransportFailure(stdout, stderr) {
  const text = `${stdout ?? ''}\n${stderr ?? ''}`;
  return TRANSIENT_TRANSPORT_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Real readiness probe: use the same `opencode` CLI client path as
 * `opencode run --server` and require a V2 `/api/info` JSON body. The serve
 * log line alone only proves the listener started; it does not prove the CLI
 * client can complete a request yet.
 */
async function waitForServerHealth(serverUrl, { env, cwd, timeoutMs = 30000, intervalMs = 250 } = {}) {
  const startedAt = Date.now();
  let attempts = 0;
  let lastDetail = '';
  while (Date.now() - startedAt < timeoutMs) {
    attempts += 1;
    const probe = await runProcess(OPENCODE_BIN, ['api', 'GET', '/api/info', '--server', serverUrl], {
      env,
      cwd,
      timeoutMs: 8000,
    });
    const text = `${probe.stdout}\n${probe.stderr}`.trim();
    if (probe.code === 0 && !probe.timedOut) {
      try {
        const info = JSON.parse(probe.stdout);
        if (typeof info?.version === 'string' && info.version.length > 0) {
          return { ok: true, attempts, elapsedMs: Date.now() - startedAt, version: info.version, detail: '' };
        }
        lastDetail = `unexpected /api/info payload: ${probe.stdout.slice(0, 200)}`;
      } catch {
        lastDetail = `unparseable /api/info payload: ${probe.stdout.slice(0, 200)}`;
      }
    } else {
      lastDetail = text.slice(-300);
    }
    await sleep(intervalMs);
  }
  return { ok: false, attempts, elapsedMs: Date.now() - startedAt, version: null, detail: lastDetail };
}

function opencodeConfig({ providerUrl, pluginOptions }) {
  return {
    $schema: 'https://opencode.ai/config.json',
    model: 'mock/mock',
    update: 'disable',
    plugins: [{ package: pluginDir, options: pluginOptions }],
    providers: {
      mock: {
        name: 'Intervention E2E Mock',
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

const POLICY_COUNT_KEYS = ['spoken', 'silent', 'accepted', 'ignored', 'reasked', 'corrected', 'dismissed', 'missed', 'too_shallow', 'too_deep'];

/** 完整核对 10 个计数：键必须都在且值为 0（避免只查 3 个的旧断言）。 */
function countsAllZero(counts) {
  return Boolean(counts) && typeof counts === 'object'
    && POLICY_COUNT_KEYS.every((key) => key in counts && (counts[key] ?? 0) === 0);
}

// W6 起 policy state 是 v2：adaptive 计数在 global，model/shadow/gate 只写
// diagnostic。reset 必须同时清空三者，而不是只清 v1 的单层计数。
function policyAllZero(state) {
  if (!state || state.version !== 2) return false;
  if (!countsAllZero(state.global ?? {})) return false;
  if (!countsAllZero(state.diagnostic ?? {})) return false;
  return state.domains && typeof state.domains === 'object' && Object.keys(state.domains).length === 0;
}

async function readPolicyState(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    return null;
  }
}

async function main() {
  const keep = process.argv.includes('--keep');
  const runRoot = join(tmpdir(), `mebular-intervention-outcome-e2e-${process.pid}-${Date.now()}`);
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
      mode: 'heuristic',
      minConfidence: 0.45,
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
  const seedToken = `intervention-e2e-${suffix}`;
  const commandToken = `deploy-${suffix}`;
  const detailSecret = `DETAIL-BODY-SECRET-${suffix}`;
  const rawQuerySecret = `RAW-QUERY-TAIL-SECRET-${suffix}`;
  const memoryText = `以后 deepwork 主题用 ${seedToken}`;
  const shallowMemoryText = 'deepwork 主题';
  const detailMemoryText = 'deepwork 主题怎么配置';
  const detailText = `deepwork 主题的原始记录：${detailSecret}；命令是 ${commandToken}`;
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
    // The suite makes many real turns; keep attribution inside the window even
    // on a slow host. The sidecar config uses the same 10-minute window.
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
    console.log('0.4.0 intervention outcome E2E（真实 opencode + 真实 sidecar + 真实插件）');
    console.log('==========================================================================');

    check('真实 sidecar discovery 写出 /memory-runtime/v1',
      String(discovery.url).endsWith(SIDECAR_API), discovery.url);
    check('host-token 文件包含真实 host token',
      typeof hostToken === 'string' && hostToken.length > 0
      && !JSON.stringify(discovery).includes(hostToken));

    const version = await requestSidecar(discovery, '/version');
    check('/version 声明 intervention decision/outcome/shadow/reset 能力',
      version.status === 200
      && version.data?.capabilities?.intervention?.decision === true
      && version.data?.capabilities?.intervention?.outcome === true
      && version.data?.capabilities?.intervention?.shadow === true
      && version.data?.capabilities?.intervention?.reset === true
      && version.data?.capabilities?.intervention?.mode === 'heuristic',
      JSON.stringify(version.data?.capabilities?.intervention));

    const seeded = await runtime.seedMemoryWithDetail({
      text: memoryText,
      detailText,
      namespace: 'user',
      agentId: 'opencode',
      threadId: `th_intervention_seed_${suffix}`,
      // The capability API requires an explicit user confirmation before an
      // agent writes the user domain. This is the same real gate the host uses.
      confirmation: 'explicit',
    });
    const seededShallow = await runtime.seedMemory({
      text: shallowMemoryText,
      namespace: 'user',
      agentId: 'opencode',
      threadId: `th_intervention_shallow_${suffix}`,
      confirmation: 'explicit',
    });
    const seededDetail = await runtime.seedMemoryWithDetail({
      text: detailMemoryText,
      detailText,
      namespace: 'user',
      agentId: 'opencode',
      threadId: `th_intervention_detail_${suffix}`,
      confirmation: 'explicit',
    });
    check('真实 capability 写入 memory + detail seed',
      seeded.accepted.records === 1 && typeof seeded.detailId === 'string'
      && seededShallow.accepted.records === 1
      && seededDetail.accepted.records === 1 && typeof seededDetail.detailId === 'string',
      JSON.stringify({
        records: seeded.accepted.records,
        shallow: seededShallow.accepted.records,
        detail: seededDetail.accepted.records,
        detailId: seededDetail.detailId,
      }));

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
    if (!ready) {
      check('真实 opencode serve 启动', false, (serveOut || serveErr).slice(-500));
      return 1;
    }
    const serverUrl = /server listening on (http:\/\/\S+)/.exec(serveOut)?.[1];

    // 不只依赖 listening 日志：用真实 CLI 客户端探一次 V2 health，确认
    // `opencode run --server` 走的客户端路径已经可用。
    const health = await waitForServerHealth(serverUrl, { env: baseEnv, cwd: project });
    console.log(`  · serve health /api/info：${health.ok ? 'ready' : 'not ready'}`
      + `（${health.attempts} 次探测 / ${health.elapsedMs}ms${health.version ? `，v${health.version}` : ''}）`);
    check('真实 opencode serve 启动', health.ok,
      health.ok
        ? `server listening + /api/info ${health.attempts} 次探测 / ${health.elapsedMs}ms`
        : `health 未就绪：${health.attempts} 次探测 / ${health.elapsedMs}ms；${health.detail}`);
    if (!health.ok) return 1;

    // 可选的有界 warmup：首轮 `Could not reach server` 就是这条真实 run 路径与
    // server 启动竞争。warmup 自身不是断言（保持 47 项契约不变），只吸收启动
    // 抖动；上限 3 次、每次等待 120s、失败原因写日志，非传输类失败立即停止。
    const parsedWarmupAttempts = Number.parseInt(process.env.MEBULAR_OUTCOME_WARMUP_ATTEMPTS ?? '3', 10);
    const warmupAttempts = Number.isFinite(parsedWarmupAttempts)
      ? Math.max(0, parsedWarmupAttempts)
      : 3;
    if (warmupAttempts === 0) {
      console.log('  · warmup 已跳过（MEBULAR_OUTCOME_WARMUP_ATTEMPTS=0）');
    }
    for (let attempt = 1; attempt <= warmupAttempts; attempt += 1) {
      const startedAt = Date.now();
      const warmup = await runProcess(OPENCODE_BIN, [
        'run', '--archived', '--server', serverUrl, '--format', 'json', 'hi',
      ], { env: baseEnv, cwd: project, timeoutMs: 120000 });
      const warmupSession = parseSessionID(warmup.stdout);
      const warmupOk = warmup.code === 0 && !warmup.timedOut
        && typeof warmupSession === 'string' && warmupSession.startsWith('ses');
      console.log(`  · warmup run ${attempt}/${warmupAttempts}：${warmupOk ? 'ok' : 'failed'}`
        + `（${Date.now() - startedAt}ms${warmupSession ? `，${warmupSession}` : ''}）`);
      if (warmupOk) break;
      if (!isTransientTransportFailure(warmup.stdout, warmup.stderr)) {
        console.log(`  · warmup 非传输类失败，停止重试：${(warmup.stderr || warmup.stdout).slice(-200)}`);
        break;
      }
      await sleep(500 * attempt);
    }

    const turn = async (sessionID, prompt) => {
      const args = sessionID
        ? ['run', '--session', sessionID, '--server', serverUrl, '--format', 'json', prompt]
        : ['run', '--server', serverUrl, '--format', 'json', prompt];
      // 首轮最多 3 次、后续轮最多 2 次；只有传输层症状才重试，真实断言失败
      // 不在重试里被吞掉。最终仍由同一个 check 判定，断言数不变。
      const maxAttempts = sessionID ? 2 : 3;
      let result = null;
      let id = sessionID ?? null;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        result = await runProcess(OPENCODE_BIN, args, { env: baseEnv, cwd: project, timeoutMs: 120000 });
        id = sessionID ?? parseSessionID(result.stdout);
        const ok = result.code === 0 && !result.timedOut
          && typeof id === 'string' && id.startsWith('ses');
        if (ok) break;
        if (!isTransientTransportFailure(result.stdout, result.stderr) || attempt === maxAttempts) {
          if (attempt > 1) {
            console.log(`  · turn 重试耗尽 ${attempt}/${maxAttempts}（${prompt.slice(0, 24)}…）：`
              + `${(result.stderr || result.stdout).slice(-200)}`);
          }
          break;
        }
        console.log(`  · turn 传输失败重试 ${attempt}/${maxAttempts}（${prompt.slice(0, 24)}…）：`
          + `${(result.stderr || result.stdout).slice(-200)}`);
        await sleep(300 * attempt);
      }
      check(`真实 opencode turn 退出 0（${prompt.slice(0, 24)}…）`,
        result.code === 0 && !result.timedOut && typeof id === 'string' && id.startsWith('ses'),
        (result.stderr || result.stdout).slice(-400));
      return id;
    };

    // ---- Scenario A: speak -> re-asked => reasked --------------------------
    const sessionA = await turn(null, `以后 deepwork 主题用 ${seedToken}`);
    const traceA1 = await findTrace(discovery, { threadId: sessionA, includes: seedToken });
    check('A1 真实 /context 走 heuristic 并注入记忆',
      traceA1?.decision?.action === 'speak'
      && traceA1?.decision?.depth === 'gist'
      && traceA1?.applied?.action === 'speak'
      && (traceA1?.counts?.injected ?? 0) >= 1,
      JSON.stringify({ decision: traceA1?.decision, applied: traceA1?.applied }));
    check('A1 trace 可经真实 GET /traces/:id 读取',
      Boolean(traceA1) && Boolean(await fetchTrace(discovery, traceA1.id)));
    const injected = await waitFor(() => provider.state.requests.find((entry) => {
      const text = (entry.body?.messages ?? []).map((message) => (
        typeof message?.content === 'string'
          ? message.content
          : Array.isArray(message?.content)
            ? message.content.map((part) => part?.text ?? '').join('\n')
            : ''
      )).join('\n');
      return text.includes('<mebular_memory') && text.includes(seedToken);
    }), { timeoutMs: 15000 });
    check('A1 注入进入真实 outgoing model request 且标记 untrusted/request-only',
      Boolean(injected)
      && JSON.stringify(injected.body).includes('trust=\\"untrusted\\"')
      && JSON.stringify(injected.body).includes('purpose=\\"background\\"'));
    await turn(sessionA, '再说一遍 deepwork 主题是什么');
    const traceA1Reasked = await waitOutcome(discovery, traceA1.id, 'reasked');
    check('A2 用户重问 → 真实 /recall/:id/outcome 记录 reasked',
      traceA1Reasked?.outcome?.kind === 'reasked'
      && traceA1Reasked?.outcome?.source === 'host',
      JSON.stringify(traceA1Reasked?.outcome));

    // ---- Scenario B: silent -> explicit memory follow-up => missed ----------
    const sessionB = await turn(null, '你好');
    const traceB1 = await findTrace(discovery, { threadId: sessionB, includes: '你好' });
    check('B1 闲聊得到 silent 决策且未注入片段（gate trace policyEligible=false）',
      traceB1?.decision?.action === 'silent'
      && traceB1?.decision?.reason === 'chitchat'
      && traceB1?.applied?.fragments === 0
      && (traceB1?.counts?.injected ?? 0) === 0
      // W6：chitchat 是 gate/non-intervention，trace 必须显式标 policyEligible=false，
      // 否则后续 missed 会被错误写进 policy global/diagnostic。
      && traceB1?.applied?.policyEligible === false
      && traceB1?.applied?.adaptiveEligible === undefined,
      JSON.stringify({ decision: traceB1?.decision, applied: traceB1?.applied }));
    await turn(sessionB, '你还记得刚才那个 deepwork 主题吗');
    const traceB1Missed = await waitOutcome(discovery, traceB1.id, 'missed');
    check('B2 显式记忆追问 → 真实 outcome 记录 missed',
      traceB1Missed?.outcome?.kind === 'missed'
      && traceB1Missed?.outcome?.source === 'host',
      JSON.stringify(traceB1Missed?.outcome));

    // ---- Scenario C: gist -> detail request => too_shallow -----------------
    const sessionC = await turn(null, 'deepwork 主题');
    const traceC1 = await findTrace(discovery, { threadId: sessionC, includes: 'deepwork 主题' });
    check('C1 宽 cue 得到 gist 决策',
      traceC1?.decision?.action === 'speak' && traceC1?.decision?.depth === 'gist',
      JSON.stringify(traceC1?.decision));
    await turn(sessionC, '具体说说 deepwork 主题的细节');
    const traceC1Shallow = await waitOutcome(discovery, traceC1.id, 'too_shallow');
    check('C2 gist 后要求具体 → 真实 outcome 记录 too_shallow',
      traceC1Shallow?.outcome?.kind === 'too_shallow',
      JSON.stringify(traceC1Shallow?.outcome));

    // ---- Scenario D: detail -> shorter request => too_deep -----------------
    const sessionD = await turn(null, 'deepwork 主题怎么配置');
    const traceD1 = await findTrace(discovery, { threadId: sessionD, includes: '怎么配置' });
    check('D1 追问配置意图得到 detail 决策',
      traceD1?.decision?.action === 'speak' && traceD1?.decision?.depth === 'detail',
      JSON.stringify(traceD1?.decision));
    await turn(sessionD, '太长了，简单点说');
    const traceD1Deep = await waitOutcome(discovery, traceD1.id, 'too_deep');
    check('D2 detail 后嫌太长 → 真实 outcome 记录 too_deep',
      traceD1Deep?.outcome?.kind === 'too_deep',
      JSON.stringify(traceD1Deep?.outcome));

    // ---- Privacy probe: a >200-char query whose unique tail must not persist.
    // This turn does not need recall; it only proves the stored preview is both
    // capped and free of the raw-query tail.
    const rawQueryC = `隐私探针 ${'。'.repeat(220)} ${rawQuerySecret}`;
    const sessionP = await turn(null, rawQueryC);
    const traceP1 = await findTrace(discovery, { threadId: sessionP, includes: '隐私探针' });
    check('隐私探针 turn 生成真实 silent trace',
      traceP1?.decision?.action === 'silent'
      && String(traceP1?.queryPreview ?? '').length === 200
      && !String(traceP1?.queryPreview ?? '').includes(rawQuerySecret),
      JSON.stringify({ length: String(traceP1?.queryPreview ?? '').length }));

    // ---- Policy stats persisted locally ------------------------------------
    const stateBefore = await waitFor(async () => {
      const state = await readPolicyState(policyStatePath);
      const counts = state?.global ?? {};
      return (counts.spoken ?? 0) > 0 && (counts.reasked ?? 0) > 0
        && (counts.too_shallow ?? 0) > 0 && (counts.too_deep ?? 0) > 0
        ? state
        : null;
    }, { timeoutMs: 10000 });
    check('本机 policy/state.json 持久化 spoken 与 outcome 计数（gate 不进 diagnostic）',
      Boolean(stateBefore)
      && stateBefore.version === 2
      && (stateBefore.global.spoken ?? 0) > 0
      // W6：B1 是 gate/non-intervention（policyEligible=false），missed 只落
      // trace，不得进入 policy global/diagnostic；旧 0.3 断言要求 missed=1。
      && (stateBefore.global.missed ?? 0) === 0
      // 本场景的 eligible 决策都是 heuristic/adaptive，diagnostic 必须完整为空：
      // 逐项核对 10 个计数（不只 spoken/silent/missed）。
      && countsAllZero(stateBefore.diagnostic)
      && Object.keys(stateBefore.domains ?? {}).length > 0,
      JSON.stringify({
        global: stateBefore?.global,
        diagnostic: stateBefore?.diagnostic,
        domains: Object.keys(stateBefore?.domains ?? {}),
      }));

    // ---- Reset: stats cleared, traces + memory kept ------------------------
    const tracesBefore = await listTraces(discovery);
    const memoryBefore = await runtime.recall('deepwork', {
      agentId: 'opencode',
      namespaces: ['user'],
    });
    const reset = await requestSidecar(discovery, '/intervention/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    check('POST /intervention/reset 返回真实成功结果',
      reset.status === 200 && reset.data?.reset === true
      && reset.data?.policyVersion === 'v0-rules'
      && Number(reset.data?.removedDomains) >= 1,
      JSON.stringify(reset.data));
    const stateAfter = await readPolicyState(policyStatePath);
    check('reset 后本机 policy 统计清零',
      policyAllZero(stateAfter), JSON.stringify(stateAfter?.global));
    const statusAfter = await requestSidecar(discovery, '/status');
    check('reset 后 /status.policy 无降级/错误',
      statusAfter.status === 200
      && statusAfter.data?.policy?.degraded === false
      && statusAfter.data?.policy?.lastError === null,
      JSON.stringify(statusAfter.data?.policy));
    const tracesAfter = await listTraces(discovery);
    const memoryAfter = await runtime.recall('deepwork', {
      agentId: 'opencode',
      namespaces: ['user'],
    });
    check('reset 不删 trace：数量不变且旧 trace 仍可读',
      tracesAfter.length === tracesBefore.length
      && Boolean(await fetchTrace(discovery, traceA1.id))
      && Boolean(await fetchTrace(discovery, traceB1.id)),
      JSON.stringify({ before: tracesBefore.length, after: tracesAfter.length }));
    check('reset 不删记忆：capability 仍可召回 seed',
      memoryBefore.records.some((record) => String(record.content ?? '').includes(seedToken))
      && memoryAfter.records.some((record) => String(record.content ?? '').includes(seedToken)),
      JSON.stringify({ before: memoryBefore.records.length, after: memoryAfter.records.length }));

    // ---- Late outcome for a pre-reset trace must not re-dirty policy state --
    const lateOutcome = await requestSidecar(
      discovery,
      `/recall/${encodeURIComponent(traceA1.id)}/outcome`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'accepted',
          source: 'host',
          confidence: 0.6,
          note: 'late outcome for a pre-reset trace',
        }),
      },
    );
    const traceA1AfterLate = await fetchTrace(discovery, traceA1.id);
    const stateAfterLate = await readPolicyState(policyStatePath);
    check('reset 前旧 trace 的迟到 outcome 不写入（recorded=false + outcome_before_reset）',
      lateOutcome.status === 200
      && lateOutcome.data?.recorded === false
      && Array.isArray(lateOutcome.data?.warnings)
      && lateOutcome.data.warnings.includes('outcome_before_reset')
      && traceA1AfterLate?.outcome?.kind === 'reasked',
      JSON.stringify({ recorded: lateOutcome.data?.recorded, warnings: lateOutcome.data?.warnings }));
    check('迟到 outcome 不重新写脏 policy/state.json',
      policyAllZero(stateAfterLate), JSON.stringify(stateAfterLate?.global));

    // ---- Privacy: policy state / trace / Console view ---------------------
    const policyText = JSON.stringify(stateAfter ?? {}) + JSON.stringify(stateBefore ?? {});
    const traceListText = JSON.stringify(tracesAfter);
    const traceFullText = JSON.stringify(await fetchTrace(discovery, traceC1.id))
      + JSON.stringify(await fetchTrace(discovery, traceD1.id));
    const consoleResponse = await fetch(`${runtime.url}/admin/api/memory-runtime/traces?limit=100`);
    const consoleBody = await consoleResponse.json().catch(() => null);
    const consoleText = JSON.stringify(consoleBody ?? {});
    check('Console 真实 admin 代理可读取 trace（浏览器不接触 host token）',
      consoleResponse.status === 200
      && Array.isArray(consoleBody?.traces)
      && consoleBody.traces.length === tracesAfter.length,
      JSON.stringify({ status: consoleResponse.status, traces: consoleBody?.traces?.length }));

    check('隐私：policy state 不含 raw query / detail 正文 / host token',
      !policyText.includes(rawQuerySecret)
      && !policyText.includes(detailSecret)
      && !policyText.includes(hostToken)
      && !policyText.includes(seedToken));
    check('隐私：trace 不含 raw query 尾部 / detail 正文 / host token',
      !traceListText.includes(rawQuerySecret)
      && !traceFullText.includes(rawQuerySecret)
      && !traceListText.includes(detailSecret)
      && !traceFullText.includes(detailSecret)
      && !traceListText.includes(hostToken)
      && !traceFullText.includes(hostToken));
    check('隐私：Console view 不含 raw query 尾部 / detail 正文 / host token',
      !consoleText.includes(rawQuerySecret)
      && !consoleText.includes(detailSecret)
      && !consoleText.includes(hostToken));
    const traceC1Full = await fetchTrace(discovery, traceC1.id);
    check('隐私：trace 不保存 rawQuery/query 原始正文字段',
      traceC1Full?.rawQuery === undefined
      && traceC1Full?.query === undefined
      && String(traceC1Full?.queryPreview ?? '').length <= 200,
      JSON.stringify({ queryPreviewLength: String(traceC1Full?.queryPreview ?? '').length }));
    // 0.4.0 W4 协议：新协议不带 note（token 请求带 note → 400
    // outcome_note_unsupported）；旧 0.3 无 token note 接受但忽略、不落盘。
    // 旧断言要求 trace 上存在固定 note 字符串，属于 0.3 契约，已失效。
    const noteProbeText = 'raw note must never be stored';
    const noteProbe = await requestSidecar(discovery, '/context', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mebular-host-app': 'opencode' },
      body: JSON.stringify({
        agentId: 'opencode',
        threadId: `th_note_protocol_${suffix}`,
        turnId: `turn_note_protocol_${suffix}`,
        query: 'deepwork 主题',
      }),
    });
    const noteTraceId = noteProbe.data?.traceId;
    const noteBindingToken = noteProbe.data?.bindingToken;
    const noteWithToken = await requestSidecar(
      discovery,
      `/recall/${encodeURIComponent(String(noteTraceId ?? 'tr_missing'))}/outcome`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'accepted',
          source: 'host',
          host: 'opencode',
          bindingToken: noteBindingToken,
          note: noteProbeText,
        }),
      },
    );
    const noteTraceAfterReject = await fetchTrace(discovery, String(noteTraceId ?? ''));
    check('隐私/协议：新协议 outcome 不含 note；带 token 的 note 被 400 outcome_note_unsupported',
      noteProbe.status === 200
      && typeof noteTraceId === 'string'
      && typeof noteBindingToken === 'string' && noteBindingToken.length > 0
      && traceA1Reasked?.outcome?.note === undefined
      && traceB1Missed?.outcome?.note === undefined
      && noteWithToken.status === 400
      && noteWithToken.body?.error?.code === 'outcome_note_unsupported'
      && (noteTraceAfterReject?.outcome ?? null) === null,
      JSON.stringify({
        storedReasked: traceA1Reasked?.outcome,
        storedMissed: traceB1Missed?.outcome,
        rejectStatus: noteWithToken.status,
        rejectCode: noteWithToken.body?.error?.code,
      }));
    const legacyNote = await requestSidecar(
      discovery,
      `/recall/${encodeURIComponent(String(noteTraceId ?? 'tr_missing'))}/outcome`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'accepted',
          source: 'host',
          note: noteProbeText,
        }),
      },
    );
    const noteTraceAfterLegacy = await fetchTrace(discovery, String(noteTraceId ?? ''));
    check('协议：旧 0.3 无 token note 返回 200 ignored 且不落盘',
      legacyNote.status === 200
      && legacyNote.data?.recorded === false
      && Array.isArray(legacyNote.data?.warnings)
      && legacyNote.data.warnings.includes('outcome_note_ignored')
      && (noteTraceAfterLegacy?.outcome ?? null) === null
      && !JSON.stringify(noteTraceAfterLegacy ?? {}).includes(noteProbeText),
      JSON.stringify({
        status: legacyNote.status,
        recorded: legacyNote.data?.recorded,
        warnings: legacyNote.data?.warnings,
        outcome: noteTraceAfterLegacy?.outcome ?? null,
      }));

    // ---- Post-reset trace still records outcomes normally ------------------
    const sessionE = await turn(null, 'deepwork 主题');
    const traceE1 = await findTrace(discovery, { threadId: sessionE, includes: 'deepwork 主题' });
    check('reset 后新 trace 仍走真实 heuristic 并注入记忆',
      traceE1?.decision?.action === 'speak'
      && traceE1?.applied?.action === 'speak'
      && (traceE1?.counts?.injected ?? 0) >= 1,
      JSON.stringify({ decision: traceE1?.decision, applied: traceE1?.applied }));
    await turn(sessionE, '再说一遍 deepwork 主题是什么');
    const traceE1Reasked = await waitOutcome(discovery, traceE1.id, 'reasked');
    check('reset 后新 trace 的 outcome 正常写入',
      traceE1Reasked?.outcome?.kind === 'reasked'
      && traceE1Reasked?.outcome?.source === 'host',
      JSON.stringify(traceE1Reasked?.outcome));
    const stateAfterPostReset = await waitFor(async () => {
      const state = await readPolicyState(policyStatePath);
      const counts = state?.global ?? {};
      return (counts.spoken ?? 0) > 0 && (counts.reasked ?? 0) > 0 ? state : null;
    }, { timeoutMs: 10000 });
    check('reset 后新 outcome 恢复写本机 policy 统计',
      Boolean(stateAfterPostReset)
      && (stateAfterPostReset.global.spoken ?? 0) >= 1
      && (stateAfterPostReset.global.reasked ?? 0) >= 1,
      JSON.stringify(stateAfterPostReset?.global));

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

  console.log(`\n${failed === 0 ? '✓' : '✗'} Intervention outcome E2E：${passed} passed, ${failed} failed`);
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    console.error(`✗ Intervention outcome E2E 未捕获错误：${error?.stack ?? error}`);
    process.exitCode = 1;
  });
