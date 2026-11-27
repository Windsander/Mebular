#!/usr/bin/env node
// 0.4.0 W7 真实介入证据：真实宿主（OpenCode 或 OpenChamber identity）+ 真实
// @mebular/opencode-plugin + 真实 MCP capability + 真实 Memory Runtime sidecar。
//
// 两种来源：
//   --source local：真实 Qwen3-4B GGUF + 真实 llama.cpp；两轮“种缓存 → 追问命中”，
//                   另一条新 cue 证明 prefetch_miss 是预期状态而不是能力通过。
//   --source host ：真实宿主 adapter 的 session-prior 生成/消费链路；宿主模型由
//                   fake OpenAI-compatible provider 返回严格 plan JSON（本文件把
//                   证据等级标为 RH+RS+FM，不冒充真实模型）。
//
// --host openchamber 只设置宿主显式身份（MEBULAR_HOST_APP / plugin hostApp），
// 不启动 OpenChamber Desktop UI；报告必须按 adapter identity 证据解读。
//
// 不读写用户真实 home；模型/引擎从 W7 缓存路径读取，不存在则失败而不是伪造。
//
// 用法：
//   node tests/integration/host-e2e/w7-intervention-evidence.mjs --source local --host opencode [--keep] [--json out.json]
//   OPENCODE_BIN=/path/to/opencode node ... --source host --host openchamber

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
const ENGINE_DIR = process.env.MEBULAR_W7_ENGINE_DIR
  || '/Users/sobertli/.mebular/memory-runtime/inference/engine/llama-b12017';
const MODEL_PATH = process.env.MEBULAR_W7_MODEL_PATH
  || '/Users/sobertli/.mebular/memory-runtime/models/qwen3-4b-instruct-q4_k_m/Qwen3-4B-Q4_K_M.gguf';
const HOST_PLAN_MARKER = 'You plan whether the next assistant turn should surface long-term memory';

const source = (process.argv.find((arg) => arg.startsWith('--source='))?.split('=')[1]
  ?? (process.argv.includes('--source') ? process.argv[process.argv.indexOf('--source') + 1] : 'local'));
const host = (process.argv.find((arg) => arg.startsWith('--host='))?.split('=')[1]
  ?? (process.argv.includes('--host') ? process.argv[process.argv.indexOf('--host') + 1] : 'opencode'));
const keep = process.argv.includes('--keep');
const jsonArg = process.argv.find((arg) => arg.startsWith('--json='));
const jsonOut = jsonArg ? jsonArg.slice('--json='.length) : null;
const agentId = host === 'openchamber' ? 'openchamber' : 'opencode';

const checks = [];
function check(id, name, ok, detail = '') {
  checks.push({ id, name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? '✓' : '✗'} [${id}] ${name}${detail ? `（${detail}）` : ''}`);
  return Boolean(ok);
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
        name: 'W7 Evidence Mock',
        package: '@opencode/ai/providers/openai-compatible',
        settings: { baseURL: `${providerUrl}/v1`, apiKey: 'w7-evidence-not-a-secret' },
        models: { mock: { name: 'Mock', limit: { context: 100000, output: 4000 } } },
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
      if (typeof parsed?.data?.sessionID === 'string' && parsed.data.sessionID.startsWith('ses')) return parsed.data.sessionID;
    } catch {
      // ignore non-JSON lines
    }
  }
  return null;
}

async function listTraces(discovery, threadId) {
  const query = `?limit=100${threadId ? `&threadId=${encodeURIComponent(threadId)}` : ''}`;
  const result = await requestSidecar(discovery, `/traces${query}`);
  if (result.status !== 200) throw new Error(`GET /traces failed: ${result.status}`);
  return Array.isArray(result.data?.traces) ? result.data.traces : [];
}

async function fetchTrace(discovery, traceId) {
  const result = await requestSidecar(discovery, `/traces/${encodeURIComponent(traceId)}`);
  return result.status === 200 ? result.data : null;
}

function traceIdOf(trace) {
  return trace?.id ?? trace?.traceId ?? null;
}

function metaOf(trace) {
  return trace?.interventionMeta ?? trace?.decision?.planner ?? null;
}

async function stageEngine(runtimeRoot) {
  const engineHome = join(runtimeRoot, 'mebular-home', 'memory-runtime', 'inference', 'engine');
  await mkdir(join(engineHome, 'current'), { recursive: true });
  await cp(ENGINE_DIR, join(engineHome, 'current', 'llama-b12017'), { recursive: true });
  const now = Date.now();
  await writeFile(join(engineHome, 'state.json'), JSON.stringify({
    schema: 1,
    release: 'b12017',
    platform: 'darwin',
    arch: 'x64',
    asset: 'llama-b12017-bin-macos-x64.tar.gz',
    sha256: 'f51371545526a8655f30bdf2e2f157d00d7ed9bddf1939106b09ac76148e59e5',
    archiveType: 'tar.gz',
    binaryPath: 'llama-b12017/llama-server',
    binaryReady: true,
    installedAt: now,
    verifiedAt: now,
  }), { mode: 0o600 });
}

function sha256File(path) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolvePromise(hash.digest('hex')));
  });
}

async function main() {
  if (!['local', 'host', 'heuristic'].includes(source)) throw new Error(`unsupported --source ${source}`);
  if (!['opencode', 'openchamber'].includes(host)) throw new Error(`unsupported --host ${host}`);

  const runRoot = await mkdtemp(join(tmpdir(), `mebular-w7-${source}-${host}-`));
  const home = join(runRoot, 'home');
  const project = join(runRoot, 'project');
  const configDir = join(home, '.config', 'opencode');
  const runtimeRoot = join(runRoot, 'runtime');
  await mkdir(configDir, { recursive: true });
  await mkdir(project, { recursive: true });
  await mkdir(runtimeRoot, { recursive: true });

  const modelSha = source === 'local' ? await sha256File(MODEL_PATH).catch(() => null) : null;
  if (source === 'local') await stageEngine(runtimeRoot);

  const sidecarConfig = {
    schema: 1,
    trace: 'local',
    model: {
      source,
      ...(source === 'local'
        ? { local: { path: MODEL_PATH, threads: 8 } }
        : {}),
    },
    intervention: {
      minConfidence: 0.3,
      maxSilentStreak: 99,
      explorationRate: 0,
      outcomeWindowMs: 600000,
      modelTimeoutMs: 2000,
    },
    context: { deadlineMs: 1500 },
    http: { host: '127.0.0.1', port: 0 },
  };

  const provider = await createFakeOpenAI({
    reply: 'OK',
    replyFor: source === 'host'
      ? (body) => {
        const text = (body?.messages ?? [])
          .filter((message) => message?.role === 'user')
          .map((message) => (typeof message?.content === 'string'
            ? message.content
            : Array.isArray(message?.content)
              ? message.content.map((part) => part?.text ?? '').join('\n')
              : ''))
          .join('\n');
        if (!text.includes(HOST_PLAN_MARKER)) return null;
        return JSON.stringify({
          action: 'speak',
          depth: 'detail',
          confidence: 0.92,
          reasonCode: 'high_relevance',
        });
      }
      : null,
  });

  const pluginOptions = {
    agentId,
    hostApp: host,
    recall: true,
    ingest: true,
    checkpoints: true,
    hideMemoryTools: true,
    modelSource: source,
    recallTimeoutMs: 5000,
    ingestTimeoutMs: 5000,
    maxContextBytes: 8192,
    maxFragments: 1,
    outcomes: true,
    outcomeTimeoutMs: 3000,
    outcomeWindowMs: 600000,
    outcomeIgnoredDelayMs: 900000,
    hostPlanTimeoutMs: 10000,
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
    MEBULAR_HOME: join(runtimeRoot, 'mebular-home'),
    MEBULAR_MEMORY_RUNTIME_HOME: join(runtimeRoot, 'mebular-home'),
    MEBULAR_MEMORY_RUNTIME_URL: '',
    MEBULAR_RUNTIME_URL: '',
    MEBULAR_RUNTIME_TOKEN: '',
    MEBULAR_HOST_APP: host === 'openchamber' ? 'openchamber' : 'opencode',
    NO_COLOR: '1',
  };

  const runtime = await startRealRuntime({
    auth: 'none',
    root: runtimeRoot,
    memoryRuntime: { enabled: true },
    manageMemoryRuntime: true,
    sidecarConfig,
  });
  let serve = null;
  const result = {
    source,
    host,
    identity: host === 'openchamber' ? 'adapter-identity-only' : 'opencode-host',
    evidenceLevel: source === 'local' ? 'R-RSM' : source === 'host' ? 'RH+RS+FM' : 'RH+RS',
    model: source === 'local'
      ? { id: 'Qwen3-4B-Q4_K_M.gguf', sha256: modelSha, engine: 'llama.cpp b12017' }
      : { id: 'fake-openai-plan-json', note: 'host model replaced by deterministic plan JSON; not R-RSM' },
    checks,
    traces: [],
    timing: {},
  };

  try {
    const discovery = await runtime.waitForSidecar({ timeoutMs: 60000 });
    const hostToken = sidecarTokenFromFile(await readFile(discovery.tokenFile, 'utf8'));
    check('sidecar-discovery', '真实 sidecar discovery + host token', String(discovery.url).endsWith(SIDECAR_API) && hostToken.length > 0);

    const version = await requestSidecar(discovery, '/version');
    const caps = version.data?.capabilities?.intervention;
    check('capabilities', 'intervention 能力位与 configuredSource', caps?.hostPlan === true && caps?.configuredSource === source,
      JSON.stringify(caps));

    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const cueToken = `W7${source.toUpperCase()}`;
    const memoryText = `以后 deepwork 主题统一用深色主题，标记 ${cueToken}-${suffix}`;
    const secondMemoryText = `deepwork 的快捷键和常用命令，标记 ${cueToken}-ALT-${suffix}`;
    const seeded = await runtime.seedMemory({
      text: memoryText,
      namespace: 'default',
      agentId,
      threadId: `th_w7_${source}`,
    });
    const seededAlt = await runtime.seedMemory({
      text: secondMemoryText,
      namespace: 'default',
      agentId,
      threadId: `th_w7_${source}`,
    });
    check('seed', '真实 capability 写入两条 seed', seeded.accepted.records === 1
      && seededAlt.accepted.records === 1, JSON.stringify({ first: seeded.accepted, second: seededAlt.accepted }));

    const opencodeVersion = await runProcess(OPENCODE_BIN, ['--version'], { timeoutMs: 20000 });
    const versionText = `${opencodeVersion.stdout}\n${opencodeVersion.stderr}`.trim();
    check('opencode-version', '真实 opencode >= 2.2', opencodeVersion.code === 0 && /v?2\.(?:[2-9]|[1-9]\d)\./.test(versionText),
      versionText.split('\n')[0] ?? 'missing');

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
    const ready = await waitFor(() => /server listening on (http:\/\/\S+)/.test(serveOut), { timeoutMs: 30000 });
    check('opencode-serve', '真实 opencode serve 启动', Boolean(ready), (serveOut || serveErr).slice(-300));
    if (!ready) throw new Error('opencode serve did not start');
    const serverUrl = /server listening on (http:\/\/\S+)/.exec(serveOut)?.[1];

    const turn = async (sessionID, prompt) => {
      const args = sessionID
        ? ['run', '--session', sessionID, '--server', serverUrl, '--format', 'json', prompt]
        : ['run', '--server', serverUrl, '--format', 'json', prompt];
      const started = Date.now();
      const output = await runProcess(OPENCODE_BIN, args, { env: baseEnv, cwd: project, timeoutMs: 120000 });
      const id = sessionID ?? parseSessionID(output.stdout);
      return { ...output, id, latencyMs: Date.now() - started };
    };

    const first = await turn(null, 'deepwork');
    check('turn-1', '真实 opencode turn 1 退出 0', first.code === 0 && typeof first.id === 'string',
      (first.stderr || first.stdout).slice(-300));
    if (first.code !== 0) throw new Error('first turn failed');
    const threadId = first.id;
    result.sessionId = threadId;
    const trace1Summary = await waitFor(() => listTraces(discovery, threadId).then((traces) => traces.find((trace) => trace.id ?? trace.traceId) ?? null), { timeoutMs: 60000 });
    const trace1 = trace1Summary ? await fetchTrace(discovery, traceIdOf(trace1Summary)) : null;
    result.traceCountAtTrace1 = (await listTraces(discovery, null)).length;
    const allTraces = await listTraces(discovery, null);
    result.traceThreadIds = allTraces.map((entry) => entry.threadId);
    check('trace-1', '真实 /context trace + host identity',
      trace1?.hostApp === host,
      JSON.stringify({ id: traceIdOf(trace1), hostApp: trace1?.hostApp }));
    result.traces.push({ phase: 'turn1', traceId: traceIdOf(trace1), meta: metaOf(trace1) });

    if (source === 'heuristic') {
      check('heuristic-turn', 'heuristic /context 真实决策', Boolean(metaOf(trace1)?.resolvedSource === 'heuristic'), JSON.stringify(metaOf(trace1)));
    } else if (source === 'local') {
      check('local-first-turn', '第一轮 local 未预取，heuristic + prefetched=false',
        metaOf(trace1)?.prefetched === false && metaOf(trace1)?.resolvedSource === null
        && ['first_turn', 'prefetch_miss'].includes(metaOf(trace1)?.prefetchState ?? ''),
        JSON.stringify(metaOf(trace1)));

      const pollStart = Date.now();
      let hitTurn = null;
      let hitTrace = null;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 5000));
        const attemptTurn = await turn(threadId, 'deepwork');
        const traces = await listTraces(discovery, threadId);
        const trace = traces.find((entry) => entry.turnId && metaOf(entry)?.prefetched === true
          && metaOf(entry)?.resolvedSource === 'local');
        if (trace) {
          hitTurn = attemptTurn;
          hitTrace = trace;
          break;
        }
      }
      result.timing.prefetchReadyMs = hitTrace ? Date.now() - pollStart : null;
      const debugTraces = await listTraces(discovery, threadId);
      result.localAttempts = debugTraces.slice(0, 8).map((entry) => ({ q: entry.queryPreview, silence: entry.silenceReason, meta: metaOf(entry), candidates: entry.candidates?.map((c) => ({ id: c.id, filtered: c.filteredReason })) }));
      check('local-hit', '第二轮同 cue 命中真实本地 Qwen3-4B 预取',
        Boolean(hitTrace && metaOf(hitTrace)?.resolvedSource === 'local'),
        JSON.stringify(metaOf(hitTrace)));
      check('local-hit-not-fallback', '命中未触发 fallback', metaOf(hitTrace)?.fallbackReason === undefined,
        JSON.stringify(metaOf(hitTrace)?.fallbackReason));
      if (hitTrace) result.traces.push({ phase: 'local-hit', traceId: traceIdOf(hitTrace), meta: metaOf(hitTrace) });

      const freshTurn = await turn(threadId, '下周旅行预算怎么安排');
      const freshTrace = await waitFor(async () => {
        const traces = await listTraces(discovery, threadId);
        const fresh = traces.filter((entry) => String(entry.queryPreview ?? '').includes('旅行预算'));
        return fresh.length > 0 ? fresh[fresh.length - 1] : null;
      }, { timeoutMs: 20000 });
      check('local-new-cue', '新 cue 第一轮 heuristic + prefetched=false（预期负向，不算能力失败）',
        metaOf(freshTrace)?.prefetched === false,
        JSON.stringify(metaOf(freshTrace)));
      result.traces.push({ phase: 'local-new-cue', traceId: traceIdOf(freshTrace), meta: metaOf(freshTrace) });
      check('local-new-cue-turn', '新 cue turn 退出 0', freshTurn.code === 0);
    } else {
      check('host-first-turn', '第一轮 host 无 plan，立即 heuristic',
        metaOf(trace1)?.prefetched === false
        && ['host_plan_missing', 'host_plan_overridden_by_hard_rule'].includes(metaOf(trace1)?.fallbackReason ?? ''),
        JSON.stringify(metaOf(trace1)));

      let hostTrace = null;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 3000));
        await turn(threadId, 'deepwork');
        const traces = await listTraces(discovery, threadId);
        hostTrace = traces.find((entry) => metaOf(entry)?.prefetched === true
          && metaOf(entry)?.resolvedSource === 'host') ?? null;
        if (hostTrace) break;
      }
      check('host-hit', '真实宿主 session-prior 命中并消费',
        Boolean(hostTrace && metaOf(hostTrace)?.resolvedSource === 'host'),
        JSON.stringify(metaOf(hostTrace)));
      check('host-hit-source', '命中元数据 resolvedSource=host 且 prefetched=true',
        metaOf(hostTrace)?.resolvedSource === 'host' && metaOf(hostTrace)?.prefetched === true,
        JSON.stringify({ source: metaOf(hostTrace)?.source, prefetched: metaOf(hostTrace)?.prefetched }));
      if (hostTrace) result.traces.push({ phase: 'host-hit', traceId: traceIdOf(hostTrace), meta: metaOf(hostTrace) });

      const freshTurn = await turn(threadId, '完全不同的新话题：下周旅行预算怎么安排');
      const freshTrace = await waitFor(async () => {
        const traces = await listTraces(discovery, threadId);
        const fresh = traces.filter((entry) => String(entry.queryPreview ?? '').includes('旅行预算'));
        return fresh.length > 0 ? fresh[fresh.length - 1] : null;
      }, { timeoutMs: 20000 });
      check('host-new-cue', '新 cue 不命中 host plan（prefetched=false）',
        metaOf(freshTrace)?.prefetched === false,
        JSON.stringify(metaOf(freshTrace)));
      result.traces.push({ phase: 'host-new-cue', traceId: traceIdOf(freshTrace), meta: metaOf(freshTrace) });
      check('host-new-cue-turn', '新 cue turn 退出 0', freshTurn.code === 0);
    }

    // Outcome binding token：真实插件下一轮上报，trace 记录 outcome。
    const reaskTurn = await turn(threadId, '再说一遍 deepwork 主题');
    check('outcome-turn', 'outcome 轮退出 0', reaskTurn.code === 0);
    const outcomeTrace = await waitFor(async () => {
      const traces = await listTraces(discovery, threadId);
      return traces.find((entry) => entry.outcome?.source === 'host' && entry.outcome?.kind) ?? null;
    }, { timeoutMs: 25000, intervalMs: 500 });
    check('outcome', '真实宿主 outcome 归因落 trace（source=host）', Boolean(outcomeTrace),
      JSON.stringify(outcomeTrace?.outcome));

    // bindingToken 负向：伪造 token 必须被拒绝。
    const forged = await requestSidecar(discovery, '/recall/forged-trace/outcome', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentId,
        threadId,
        turnId: 'forged',
        kind: 'accepted',
        source: 'host',
        bindingToken: 'forged',
      }),
    });
    check('binding-forged', '伪造 bindingToken 被拒绝', forged.status >= 400 && forged.status < 500,
      String(forged.status));

    const privacyFile = join(runtimeRoot, 'mebular-home', 'memory-runtime', 'traces.jsonl');
    const longTail = `W7-RAW-TAIL-${suffix}-${'x'.repeat(240)}`;
    await turn(threadId, `上下文检查 ${longTail}`);
    const privacy = await readFile(privacyFile, 'utf8');
    check('privacy', 'trace 不含 seed 正文或 raw query 尾部', !privacy.includes(memoryText)
      && !privacy.includes(secondMemoryText) && !privacy.includes(longTail),
      'no raw body/tail in traces');

    result.summary = {
      passed: checks.filter((entry) => entry.ok).length,
      failed: checks.filter((entry) => !entry.ok).length,
      traceCount: (await listTraces(discovery, threadId)).length,
    };
  } catch (error) {
    result.error = String(error?.stack ?? error);
    console.error('W7 evidence run failed:', error);
  } finally {
    if (serve) {
      try { serve.kill('SIGTERM'); } catch { /* best effort */ }
    }
    await provider.close().catch(() => undefined);
    await runtime.close().catch(() => undefined);
    if (keep) {
      result.runRoot = runRoot;
      console.log(`KEEP run root: ${runRoot}`);
    } else {
      await rm(runRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  if (jsonOut) {
    await writeFile(jsonOut, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    console.log(`JSON written: ${jsonOut}`);
  }
  console.log(JSON.stringify({
    source,
    host,
    evidenceLevel: result.evidenceLevel,
    passed: result.summary?.passed ?? 0,
    failed: result.summary?.failed ?? checks.filter((entry) => !entry.ok).length,
    error: result.error ?? null,
  }));
  process.exitCode = (result.summary?.failed ?? 1) === 0 && !result.error ? 0 : 1;
}

await main();
