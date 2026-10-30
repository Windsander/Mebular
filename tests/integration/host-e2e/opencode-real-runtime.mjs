#!/usr/bin/env node
// OpenCode / OpenChamber host E2E: real opencode 2.2 server + real
// @mebular/opencode-plugin + real MCP daemon with the Memory Capability API +
// real Memory Runtime sidecar + a fake OpenAI-compatible provider (no LLM).
//
// This replaces the former fake `/memory-runtime/v1` sidecar. Discovery,
// `/context`, `/ingest`, checkpoint PUT, the capability API and the
// MemoryService/GraphStore are all real. The fake provider only supplies a model
// response so OpenCode can execute a turn without external network access.
//
// Token-file: the real sidecar writes `{version,token,...}` to `host-token`
// and the OpenCode plugin reads that JSON record directly. No token override is
// injected, so the production discovery path is covered.
//
// If the opencode binary is unavailable, use --controller-fallback to drive the
// same plugin controller through its exported API against the real sidecar.

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
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

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function assertDiscovery(discovery, hostToken) {
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
  const info = await stat(discovery.tokenFile);
  check('host-token 文件权限 0600',
    process.platform === 'win32' || (info.mode & 0o077) === 0,
    (info.mode & 0o777).toString(8));
  const record = JSON.parse(await readFile(discovery.tokenFile, 'utf8'));
  check('host-token 文件包含真实 host token',
    record?.version === 1 && record?.token === hostToken,
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

async function waitForSidecar(runtime, predicate, { timeoutMs = 30000 } = {}) {
  return waitFor(async () => {
    const status = await runtime.sidecarStatus().catch(() => null);
    return status !== null && predicate(status) ? status : null;
  }, { timeoutMs, describe: 'sidecar status' });
}

async function main() {
  const keep = process.argv.includes('--keep');
  const forceControllerFallback = process.argv.includes('--force-controller-fallback')
    || process.env.HOST_E2E_FORCE_CONTROLLER === '1';
  const controllerFallback = process.argv.includes('--controller-fallback') || forceControllerFallback;
  const runRoot = join(tmpdir(), `mebular-opencode-host-e2e-${process.pid}-${Date.now()}`);
  const home = join(runRoot, 'home');
  const project = join(runRoot, 'project');
  const mebularHome = join(runRoot, 'mebular-home');
  const openchamberDir = join(home, '.config', 'openchamber');
  const configDir = join(home, '.config', 'opencode');
  await mkdir(configDir, { recursive: true });
  await mkdir(project, { recursive: true });
  await mkdir(join(mebularHome, 'memory-runtime'), { recursive: true });
  await mkdir(openchamberDir, { recursive: true });

  // Native OpenChamber memory must stay untouched. The sentinel makes an
  // accidental read/import/write visible in the host E2E.
  const nativeSentinel = `OPENCHAMBER-NATIVE-MEMORY-${Date.now()}`;
  const nativeMemoryPath = join(openchamberDir, 'memory.json');
  const nativeSettingsPath = join(openchamberDir, 'settings.json');
  await writeFile(nativeMemoryPath, JSON.stringify({
    version: 1,
    entries: [{ id: 'native-1', title: 'native', body: nativeSentinel }],
  }, null, 2), 'utf8');
  await writeFile(nativeSettingsPath, JSON.stringify({ agentMemoryToolEnabled: true }, null, 2), 'utf8');
  const nativeBefore = {
    memory: sha256(await readFile(nativeMemoryPath, 'utf8')),
    settings: sha256(await readFile(nativeSettingsPath, 'utf8')),
  };

  // Port 0 avoids colliding with a developer's sidecar or another suite.
  await writeFile(join(mebularHome, 'memory-runtime', 'config.json'), JSON.stringify({
    schema: 1,
    capture: 'local',
    trace: 'local',
    model: { source: 'heuristic' },
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
  const seedToken = `opencode-e2e-${suffix}`;
  const prompt = `以后默认用 ${seedToken} 主题`;
  const pluginOptions = {
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

  const baseEnv = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    MEBULAR_HOME: mebularHome,
    MEBULAR_MEMORY_RUNTIME_HOME: mebularHome,
    // Discovery supplies both the URL and the JSON host-token record.
    MEBULAR_MEMORY_RUNTIME_URL: '',
    MEBULAR_RUNTIME_URL: '',
    MEBULAR_RUNTIME_TOKEN: '',
    OPENCHAMBER_MEMORY_ENABLE: '1',
    OPENCHAMBER_DATA_DIR: openchamberDir,
    NO_COLOR: '1',
  };

  let serve = null;
  try {
    console.log('OpenCode / OpenChamber host E2E（真实 opencode + 真实 sidecar + 真实 capability）');
    console.log('====================================================================');
    await assertDiscovery(discovery, hostToken);

    const seeded = await runtime.seedMemory({
      text: `以后默认用 ${seedToken} 主题`,
      namespace: 'default',
      agentId: 'opencode',
    });
    check('真实 MCP capability 写入 heuristic seed', seeded.accepted.records === 1,
      JSON.stringify(seeded.records));

    const version = await runProcess('opencode', ['--version'], { timeoutMs: 20000 });
    const versionText = `${version.stdout}\n${version.stderr}`.trim();
    const supported = /v?2\.(?:[2-9]|[1-9]\d)\./.test(versionText);
    check('opencode 可启动且 >= 2.2', version.code === 0 && supported, versionText.split('\n')[0] ?? 'missing');

    if ((!supported || forceControllerFallback) && controllerFallback) {
      skip('真实 opencode 端到端', forceControllerFallback
        ? 'forced controller fallback'
        : 'binary missing/unsupported; controller fallback requested');
      return await runControllerFallback({ runtime, prompt, seedToken });
    }
    if (!supported) {
      check('真实 opencode 端到端前提满足', false, '未找到 >=2.2 的 opencode；加 --controller-fallback 可跑边界受控的 plugin API');
      return 1;
    }

    const port = await getFreePort();
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

    const contextStatus = await waitForSidecar(runtime, (status) => (status.counts?.contexts ?? 0) >= 1);
    check('真实 opencode context hook 走 sidecar /context', Boolean(contextStatus)
      && (contextStatus?.counts?.contexts ?? 0) >= 1,
    JSON.stringify(contextStatus?.counts));
    const traces = await waitFor(async () => {
      const entries = await runtime.sidecarTraces();
      return entries.some((trace) => String(trace.queryPreview ?? '').includes(seedToken)) ? entries : null;
    }, { timeoutMs: 15000, describe: 'sidecar context trace' });
    check('真实 sidecar trace 记录 OpenCode 原始 query',
      Array.isArray(traces)
      && traces.some((trace) => String(trace.queryPreview ?? '').includes(seedToken)
        && !String(trace.queryPreview ?? '').trim().startsWith('"')),
      JSON.stringify(traces?.map((trace) => trace.queryPreview)));

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

    const ingestStatus = await waitForSidecar(runtime, (status) => (status.counts?.ingested ?? 0) >= 1);
    check('真实 opencode 事件走 sidecar /ingest', Boolean(ingestStatus)
      && (ingestStatus?.counts?.ingested ?? 0) >= 1,
    JSON.stringify(ingestStatus?.counts));
    const rawFound = await waitFor(async () => {
      const entries = await runtime.sidecarRawEntries();
      return entries.some((chunk) => chunk.role === 'user' && String(chunk.text).includes(seedToken)) ? entries : null;
    }, { timeoutMs: 20000, describe: 'sidecar ingest raw' });
    check('真实 sidecar raw 含 OpenCode user 文本', Array.isArray(rawFound)
      && rawFound.some((chunk) => chunk.role === 'user' && String(chunk.text).includes(seedToken)),
    JSON.stringify(rawFound?.map((chunk) => `${chunk.role}:${String(chunk.text).slice(0, 60)}`)));
    const userChunk = rawFound?.find((chunk) => chunk.role === 'user'
      && String(chunk.text).includes(seedToken));
    check('真实 ingest 使用解包后的 user 文本', Boolean(userChunk)
      && !String(userChunk?.text ?? '').trim().startsWith('"'),
    userChunk ? JSON.stringify(userChunk.text).slice(0, 240) : 'no user chunk');
    check('真实 sidecar raw 含 assistant 文本',
      Array.isArray(rawFound) && rawFound.some((chunk) => chunk.role === 'assistant'),
      JSON.stringify(rawFound?.map((chunk) => chunk.role)));

    const settledRecord = await waitFor(async () => {
      const result = await runtime.recall(seedToken, {
        agentId: 'opencode',
        namespaces: ['default', 'user', 'agent:opencode', `task:${sessionID}`],
      });
      return result.records.find((record) => String(record.content).includes(seedToken)
        && String(record.namespace ?? '') !== 'default') ?? null;
    }, { timeoutMs: 30000, describe: 'runtime ingest settlement' });
    check('sidecar ingest 经 capability 沉降到真实 Runtime/GraphStore', Boolean(settledRecord),
      JSON.stringify(settledRecord));

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

    const checkpointStatus = await waitForSidecar(runtime, (status) => (status.counts?.checkpoints ?? 0) >= 1);
    if (!checkpointStatus) {
      console.log('  fake provider requests（诊断）：', JSON.stringify(provider.state.requests.map((entry) => ({
        content: entry.content.slice(0, 80),
        user: (entry.body?.messages ?? []).filter((message) => message?.role === 'user')
          .map((message) => String(message?.content).slice(0, 90)),
      })), null, 2).slice(0, 3000));
    }
    check('compaction 走真实 sidecar checkpoint', Boolean(checkpointStatus)
      && (checkpointStatus?.counts?.checkpoints ?? 0) >= 1,
    JSON.stringify(checkpointStatus?.counts));
    const checkpoint = await waitFor(() => runtime.sidecarCheckpoint(sessionID, 'opencode'), {
      timeoutMs: 15000,
      describe: 'real sidecar checkpoint',
    });
    check('真实 sidecar 持久化 OpenCode checkpoint', Boolean(checkpoint)
      && checkpoint.agentId === 'opencode'
      && checkpoint.threadId === sessionID
      && String(checkpoint.domain).startsWith('task:')
      && checkpoint.state?.kind === 'compaction', JSON.stringify(checkpoint));
    check('checkpoint 无旧 sync 字段', checkpoint?.sync === undefined);

    check('sidecar 请求记录不包含 host token', !JSON.stringify(await runtime.sidecarStatus()).includes(hostToken));
    check('discovery 文件不包含 host token', !JSON.stringify(discovery).includes(hostToken));

    // Everything under the OpenCode HOME (state, logs, database, session
    // history) must not contain the host token; the token file lives under a
    // separate Mebular home and is not part of this scan.
    const leaked = await scanForToken(home, hostToken);
    check('OpenCode state/log/session 不持久化 host token', leaked.length === 0, JSON.stringify(leaked));
    check('opencode serve 日志不含 host token', !`${serveOut}\n${serveErr}`.includes(hostToken));

    const nativeAfter = {
      memory: sha256(await readFile(nativeMemoryPath, 'utf8')),
      settings: sha256(await readFile(nativeSettingsPath, 'utf8')),
    };
    check('OpenChamber 原生 memory.json 未被改写', nativeAfter.memory === nativeBefore.memory);
    check('OpenChamber 原生 settings.json 未被改写', nativeAfter.settings === nativeBefore.settings);
    const sidecarRawText = (await runtime.sidecarRawChunks()).join('\n');
    const sidecarTraceText = JSON.stringify(await runtime.sidecarTraces());
    check('原生 memory 内容未进入 sidecar raw/trace',
      !sidecarRawText.includes(nativeSentinel) && !sidecarTraceText.includes(nativeSentinel));
    const nativeRecall = await runtime.recall(nativeSentinel, {
      agentId: 'opencode',
      namespaces: ['default', 'agent:opencode', 'user'],
    });
    check('原生 memory 内容未被导入 Runtime',
      !nativeRecall.records.some((record) => String(record.content).includes(nativeSentinel)),
      JSON.stringify(nativeRecall.records));
    check('OpenCode 未注册/调用 OpenChamber 原生 memory 工具',
      !JSON.stringify(provider.state.requests).includes('openchamber_memory'));

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
    if (keep) {
      console.log(`临时目录保留：${runRoot}（Mebular home：${mebularHome}）`);
      await runtime.close().catch(() => undefined);
    } else {
      await runtime.cleanup().catch(() => undefined);
      await rm(runRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  console.log(`\n${failed === 0 ? '✓' : '✗'} OpenCode host E2E：${passed} passed, ${failed} failed, ${skipped} skipped`);
  return failed === 0 ? 0 : 1;
}

async function runControllerFallback({ runtime, prompt, seedToken }) {
  // Boundary: no real OpenCode process. The plugin controller is driven through
  // its exported API with a faithful host-shaped ctx and real global fetch.
  const plugin = await import('../../../packages/opencode-plugin/index.js');
  const messages = [];
  let contextPayload = null;
  const ctx = {
    app: { version: '2.2.0' },
    options: { agentId: 'opencode', capture: 'local' },
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
  const controller = plugin.createController({
    ctx,
    env: {
      MEBULAR_HOME: runtime.home,
    },
  });
  await controller.start();
  const event = {
    sessionID: 'ses_controller_fallback',
    messages: [{ id: 'm1', role: 'user', content: prompt }],
    system: [],
  };
  await contextPayload.callback(event);
  check('controller fallback 注入真实 sidecar 记忆', event.system.some((entry) => String(entry.text).includes('<mebular_memory')
    && String(entry.text).includes(seedToken)), JSON.stringify(event.system).slice(0, 500));
  const status = await waitFor(async () => {
    const value = await runtime.sidecarStatus().catch(() => null);
    return value !== null && (value.counts?.contexts ?? 0) >= 1 ? value : null;
  }, { timeoutMs: 15000, describe: 'controller fallback context' });
  check('controller fallback 使用 discovery + /memory-runtime/v1/context', Boolean(status),
    JSON.stringify(status?.counts));
  await controller.dispose();
  console.log('\n边界：未启动真实 OpenCode；以上仅验证 plugin controller + 真实 sidecar。');
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    console.error(`✗ OpenCode host E2E 未捕获错误：${error?.stack ?? error}`);
    process.exitCode = 1;
  });
