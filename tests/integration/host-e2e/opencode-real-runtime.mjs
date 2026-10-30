#!/usr/bin/env node
// OpenCode / OpenChamber host E2E: real opencode 2.2 server + real
// @mebular/opencode-plugin + real Runtime HTTP + a fake OpenAI-compatible
// provider (no real LLM).
//
// Covered: plugin load, context recall injection into the real outgoing model
// request, real ingest from host events, compaction checkpoint PUT, bearer
// Runtime auth, and the request-only/untrusted block shape.
//
// If the opencode binary is unavailable, use --controller-fallback to drive the
// same plugin controller through its exported API against the real Runtime and
// report that boundary explicitly.

import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFakeOpenAI } from './lib/fake-openai.mjs';
import { startRealRuntime } from './lib/real-runtime.mjs';
import { createRuntimeTap } from './lib/runtime-tap.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const pluginDir = join(repoRoot, 'packages', 'opencode-plugin');

let passed = 0;
let failed = 0;
let skipped = 0;
function check(name, ok, detail = '') {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `（${detail}）` : ''}`);
  return ok;
}
function skip(name, detail = '') {
  skipped += 1;
  console.log(`  - ${name}${detail ? `（${detail}）` : ''}`);
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
        name: 'Host E2E Mock',
        package: '@opencode/ai/providers/openai-compatible',
        settings: { baseURL: `${providerUrl}/v1`, apiKey: 'host-e2e-not-a-secret' },
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

async function scanForToken(dir, token) {
  const hits = [];
  async function walk(current) {
    let entries = [];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        const text = await readFile(path, 'utf8').catch(() => '');
        if (text.includes(token)) hits.push(path);
      }
    }
  }
  await walk(dir);
  return hits;
}

function parseSessionID(output) {
  for (const line of output.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed.sessionID === 'string' && parsed.sessionID.startsWith('ses')) return parsed.sessionID;
      if (typeof parsed?.data?.sessionID === 'string') return parsed.data.sessionID;
    } catch {
      // ignore
    }
  }
  return null;
}

async function main() {
  const keep = process.argv.includes('--keep');
  const forceControllerFallback = process.argv.includes('--force-controller-fallback')
    || process.env.HOST_E2E_FORCE_CONTROLLER === '1';
  const controllerFallback = process.argv.includes('--controller-fallback') || forceControllerFallback;
  const runRoot = join(tmpdir(), `mebular-opencode-host-e2e-${process.pid}-${Date.now()}`);
  const home = join(runRoot, 'home');
  const project = join(runRoot, 'project');
  const configDir = join(home, '.config', 'opencode');
  await mkdir(configDir, { recursive: true });
  await mkdir(project, { recursive: true });

  const provider = await createFakeOpenAI({ reply: 'OK' });
  const runtime = await startRealRuntime({ auth: 'bearer', token: `opencode-host-token-${Date.now()}` });
  const tap = await createRuntimeTap(runtime.url, { name: 'opencode-real-runtime' });
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const seedToken = `opencode-e2e-${suffix}`;
  const prompt = `Remember ${seedToken} for the theme`;
  const pluginOptions = {
    runtimeUrl: tap.url,
    token: runtime.token,
    agentId: 'opencode',
    capture: 'local',
    recall: true,
    ingest: true,
    checkpoints: true,
    hideMemoryTools: true,
    modelSource: 'heuristic',
    recallTimeoutMs: 5000,
    ingestTimeoutMs: 5000,
    maxContextBytes: 8192,
  };
  await writeFile(join(configDir, 'opencode.json'), JSON.stringify(opencodeConfig({
    providerUrl: provider.url,
    pluginOptions,
  }), null, 2), 'utf8');

  let serve = null;
  try {
    console.log('OpenCode / OpenChamber host E2E（真实 opencode + 真实 Runtime）');
    console.log('==========================================================');
    // OpenCode may store message content as a JSON-encoded string. The plugin
    // unwraps it before recall/ingest, so the Runtime sees the same plain text
    // the user typed.
    const seeded = await runtime.seedCandidate({
      candidate: {
        kind: 'fact',
        data: { subject: 'user', predicate: 'theme', object: prompt },
      },
      namespace: 'default',
      agentId: 'opencode',
    });
    check('Runtime host-candidate seed 写入', seeded.accepted.records === 1, JSON.stringify(seeded.records));

    const version = await runProcess('opencode', ['--version'], { timeoutMs: 20000 });
    const versionText = `${version.stdout}\n${version.stderr}`.trim();
    const supported = /v?2\.(?:[2-9]|[1-9]\d)\./.test(versionText);
    check('opencode 可启动且 >= 2.2', version.code === 0 && supported, versionText.split('\n')[0] ?? 'missing');

    if ((!supported || forceControllerFallback) && controllerFallback) {
      skip('真实 opencode 端到端', forceControllerFallback
        ? 'forced controller fallback'
        : 'binary missing/unsupported; controller fallback requested');
      return await runControllerFallback({ runtime, tap, prompt, seedToken });
    }
    if (!supported) {
      check('真实 opencode 端到端前提满足', false, '未找到 >=2.2 的 opencode；加 --controller-fallback 可跑边界受控的 plugin API');
      return 1;
    }

    const port = await getFreePort();
    const baseEnv = {
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_DATA_HOME: join(home, '.local', 'share'),
      XDG_CACHE_HOME: join(home, '.cache'),
      XDG_STATE_HOME: join(home, '.local', 'state'),
      NO_COLOR: '1',
    };
    serve = spawn('opencode', ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
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
      describe: 'opencode serve ready',
    });
    check('真实 opencode serve 启动', Boolean(ready), (serveOut || serveErr).slice(-600));
    if (!ready) return 1;
    const serverUrl = /server listening on (http:\/\/\S+)/.exec(serveOut)?.[1];

    const run = await runProcess('opencode', [
      'run', '--server', serverUrl, '--format', 'json', prompt,
    ], { env: baseEnv, cwd: project, timeoutMs: 120000 });
    check('真实 opencode run 退出 0', run.code === 0 && !run.timedOut,
      (run.stderr || run.stdout).slice(-700));
    const sessionID = parseSessionID(run.stdout);
    check('opencode 返回真实 sessionID', typeof sessionID === 'string' && sessionID.startsWith('ses'), sessionID ?? 'missing');
    if (typeof sessionID !== 'string') return 1;

    const contextRequest = await waitFor(() => tap.runtimeRequests().find((entry) => entry.method === 'POST'
      && entry.path === '/runtime/v1/context'
      && String(entry.body?.query).includes(suffix)), { timeoutMs: 15000, describe: 'context request' });
    check('插件走真实 /context', Boolean(contextRequest) && contextRequest.ok,
      contextRequest ? `status=${contextRequest.status}` : 'missing');
    check('OpenCode context query 已解包 JSON 字符串',
      String(contextRequest?.body?.query ?? '') === prompt,
      contextRequest ? JSON.stringify(contextRequest.body?.query).slice(0, 120) : 'missing');
    check('真实 /context 返回 seed 记忆', JSON.stringify(contextRequest?.response).includes(seedToken),
      contextRequest ? JSON.stringify(contextRequest.response).slice(0, 400) : 'missing');

    const injected = await waitFor(() => provider.state.requests.find((entry) => {
      const text = (entry.body?.messages ?? []).map((message) => (
        typeof message?.content === 'string'
          ? message.content
          : Array.isArray(message?.content)
            ? message.content.map((part) => part?.text ?? '').join('\n')
            : ''
      )).join('\n');
      return text.includes('<mebular_memory') && text.includes(seedToken);
    }), { timeoutMs: 15000, describe: 'model request with memory block' });
    check('真实模型请求包含 request-only 不可信记忆块', Boolean(injected));
    const injectedText = JSON.stringify(injected?.body ?? {});
    check('注入块标记 trust=untrusted 且不写会话历史', injectedText.includes('trust=\\"untrusted\\"')
      && injectedText.includes('purpose=\\"background\\"'));

    const ingestRequest = await waitFor(() => tap.runtimeRequests().find((entry) => entry.method === 'POST'
      && entry.path === '/runtime/v1/ingest'
      && entry.body?.threadId === sessionID
      && (entry.body?.chunks ?? []).some((chunk) => String(chunk.text).includes(`opencode-e2e-${suffix}`))),
    { timeoutMs: 20000, describe: 'ingest request' });
    check('真实 opencode 事件走 /ingest', Boolean(ingestRequest) && ingestRequest.ok,
      ingestRequest ? `status=${ingestRequest.status}` : 'missing');

    const raw = await waitFor(async () => {
      const chunks = await runtime.rawChunks();
      const text = chunks.map((chunk) => chunk.text).join('\n');
      return text.includes(`opencode-e2e-${suffix}`) ? chunks : null;
    }, { timeoutMs: 15000, describe: 'raw capture' });
    check('真实 Runtime 落本地 raw', Array.isArray(raw) && raw.length > 0, `chunks=${raw?.length ?? 0}`);

    const ingestedUser = raw?.find((chunk) => chunk.role === 'user'
      && String(chunk.text).includes(seedToken));
    check('真实 ingest 使用解包后的 user 文本', Boolean(ingestedUser)
      && !String(ingestedUser?.text ?? '').trim().startsWith('"'),
    ingestedUser ? JSON.stringify(ingestedUser.text).slice(0, 240) : 'no user chunk');

    const compact = await runProcess('opencode', [
      'api', '--server', serverUrl, 'post', `/api/session/${sessionID}/compact`, '--data', '{}',
    ], { env: baseEnv, cwd: project, timeoutMs: 60000 });
    check('opencode compact API 接受', compact.code === 0 && !compact.timedOut,
      (compact.stderr || compact.stdout).slice(-600));

    // Compaction is admitted at the next step boundary; a follow-up turn makes
    // the real host execute it and emit session.compaction.ended.
    const followUp = await runProcess('opencode', [
      'run', '--session', sessionID, '--server', serverUrl, '--format', 'json', '继续',
    ], { env: baseEnv, cwd: project, timeoutMs: 120000 });
    check('compact 后 follow-up turn 退出 0', followUp.code === 0 && !followUp.timedOut,
      (followUp.stderr || followUp.stdout).slice(-600));

    const checkpointRequest = await waitFor(() => tap.runtimeRequests().find((entry) => entry.method === 'PUT'
      && entry.path === `/runtime/v1/checkpoints/${sessionID}`
      && entry.body?.agentId === 'opencode'), { timeoutMs: 30000, describe: 'checkpoint PUT' });
    if (!checkpointRequest) {
      console.log('  fake provider requests（诊断）：', JSON.stringify(provider.state.requests.map((entry) => ({
        content: entry.content.slice(0, 80),
        user: (entry.body?.messages ?? []).filter((message) => message?.role === 'user')
          .map((message) => String(message?.content).slice(0, 90)),
      })), null, 2).slice(0, 3000));
    }
    check('compaction 走真实 checkpoint PUT', Boolean(checkpointRequest) && checkpointRequest.ok,
      checkpointRequest ? `status=${checkpointRequest.status}` : 'missing');
    const checkpoint = await waitFor(() => runtime.checkpoint(sessionID, 'opencode'), {
      timeoutMs: 15000,
      describe: 'real checkpoint',
    });
    check('真实 Runtime 持久化 OpenCode checkpoint', Boolean(checkpoint)
      && checkpoint.agentId === 'opencode'
      && checkpoint.state?.kind === 'compaction', JSON.stringify(checkpoint));

    const status = await runtime.status();
    check('真实 Runtime status 无 token 泄漏', !JSON.stringify(status).includes(runtime.token));
    check('tap 状态不包含 bearer token', !JSON.stringify(tap.state).includes(runtime.token));

    // The user-supplied plugin option is written to OpenCode config by the
    // harness itself, so exclude that file. Everything else (state, logs,
    // database, session history) must not contain the Runtime token.
    const configPath = join(configDir, 'opencode.json');
    const leaked = (await scanForToken(home, runtime.token)).filter((path) => path !== configPath);
    check('OpenCode state/log/session 不持久化 Runtime token', leaked.length === 0, JSON.stringify(leaked));
    check('opencode serve 日志不含 Runtime token', !`${serveOut}\n${serveErr}`.includes(runtime.token));

    if (serve !== null && serve.exitCode !== null) {
      check('opencode serve 全程存活', false, `exit=${serve.exitCode} ${serveErr.slice(-400)}`);
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
    await tap.close().catch(() => undefined);
    if (keep) {
      console.log(`临时目录保留：${runRoot}（Runtime home：${runtime.home}）`);
      await runtime.close().catch(() => undefined);
    } else {
      await runtime.cleanup().catch(() => undefined);
      await rm(runRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  console.log(`\n${failed === 0 ? '✓' : '✗'} OpenCode host E2E：${passed} passed, ${failed} failed, ${skipped} skipped`);
  return failed === 0 ? 0 : 1;
}

async function runControllerFallback({ runtime, tap, prompt, seedToken }) {
  // Boundary: no real OpenCode process. The plugin controller is driven through
  // its exported API with a faithful host-shaped ctx and real global fetch.
  const plugin = await import('../../../packages/opencode-plugin/index.js');
  const messages = [];
  let contextPayload = null;
  const ctx = {
    app: { version: '2.2.0' },
    options: { runtimeUrl: tap.url, token: runtime.token, agentId: 'opencode', capture: 'local' },
    session: {
      hook: async (name, callback) => {
        contextPayload = { name, callback };
        return { dispose: async () => {} };
      },
      context: async () => messages,
      generate: async () => ({ text: '[]' }),
    },
    event: {
      subscribe: async () => ({
        async *[Symbol.asyncIterator]() {
          // No host events in the fallback; the context hook is invoked directly.
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
          yield undefined;
        },
      }),
    },
    tool: { transform: async () => ({ dispose: async () => {} }) },
  };
  const controller = plugin.createController({ ctx, env: {}, homeDir: runtime.root });
  await controller.start();
  const event = {
    sessionID: 'ses_controller_fallback',
    messages: [{ id: 'm1', role: 'user', content: prompt }],
    system: [],
  };
  await contextPayload.callback(event);
  check('controller fallback 注入真实 Runtime 记忆', event.system.some((entry) => String(entry.text).includes('<mebular_memory')
    && String(entry.text).includes(seedToken)), JSON.stringify(event.system).slice(0, 500));
  check('controller fallback 使用真实 /context', tap.runtimeRequests().some((entry) => entry.path === '/runtime/v1/context'));
  await controller.dispose();
  console.log('\n边界：未启动真实 OpenCode；以上仅验证 plugin controller + 真实 Runtime。');
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    console.error(`✗ OpenCode host E2E 未捕获错误：${error?.stack ?? error}`);
    process.exitCode = 1;
  });
