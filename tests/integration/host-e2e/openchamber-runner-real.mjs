#!/usr/bin/env node
// OpenChamber public runner real-host E2E (Fleet 0.3.2 WS-D).
//
// Real boundary:
//   * real `opencode serve` (the OpenCode V2 plugin host OpenChamber uses);
//   * real `@mebular/opencode-plugin/fleet-runner` loaded as a plugin;
//   * real `@mebular/fleet` OpenChamberRunnerAgent over `POST /v1/run-once`;
//   * fake OpenAI-compatible provider, so no external LLM is called.
//
// Not covered here: the OpenChamber Desktop UI. Everything runs under a
// `mkdtemp` root with an isolated HOME/XDG/MEBULAR_HOME/OPENCODE_CONFIG, so no
// real user config, state or session is read or written.
//
// The test proves the two runner invariants Fleet depends on:
//   * one task = one NEW session (never resumes an existing session);
//   * the final assistant text comes back and an existing session is unchanged.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createFakeOpenAI } from './lib/fake-openai.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const fleetEntry = join(repoRoot, 'packages', 'fleet', 'dist', 'index.js');
const realRunnerPath = join(repoRoot, 'packages', 'opencode-plugin', 'fleet-runner.js');
const fakeReply = 'FLEET_RUNNER_OK';

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

function tail(text, max = 800) {
  const value = String(text ?? '');
  return value.length <= max ? value : value.slice(-max);
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
      env: env ?? process.env,
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

async function waitForValue(predicate, { timeoutMs = 30000, intervalMs = 100, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms${lastError ? `: ${lastError.message}` : ''}`);
}

function parseSessionID(output) {
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed.sessionID === 'string' && parsed.sessionID.startsWith('ses')) {
        return parsed.sessionID;
      }
      if (typeof parsed?.data?.sessionID === 'string' && parsed.data.sessionID.startsWith('ses')) {
        return parsed.data.sessionID;
      }
    } catch {
      // Ignore non-JSON diagnostic lines.
    }
  }
  return null;
}

function parseVersion(text) {
  const match = /v?(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? ''));
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

async function resolveOpenCode() {
  const explicit = process.argv.includes('--opencode-bin')
    ? process.argv[process.argv.indexOf('--opencode-bin') + 1]
    : process.env.OPENCODE_BIN;
  const bin = typeof explicit === 'string' && explicit.trim().length > 0 ? explicit.trim() : 'opencode';
  const result = await runProcess(bin, ['--version'], { timeoutMs: 20000 });
  const version = parseVersion(`${result.stdout}\n${result.stderr}`);
  if (result.code !== 0 || version === null || version.major < 2) {
    throw new Error(
      `no usable OpenCode V2 host at ${bin}: ${tail(result.stderr || result.stdout)}`,
    );
  }
  return { bin, text: `${result.stdout}\n${result.stderr}`.trim() };
}

async function createPluginDirectory(runRoot) {
  const directory = join(runRoot, 'fleet-runner-plugin');
  await mkdir(directory, { recursive: true });
  const packageJson = JSON.parse(await readFile(join(repoRoot, 'packages', 'opencode-plugin', 'package.json'), 'utf8'));
  // OpenCode V2 loads a plugin from a DIRECTORY (a file path is rejected), but
  // that directory's entry point may re-export the workspace plugin file. This
  // keeps the real runner source under test without copying it.
  await writeFile(join(directory, 'package.json'), JSON.stringify({
    name: 'mebular-fleet-runner-e2e',
    version: typeof packageJson.version === 'string' ? packageJson.version : '0.0.0',
    private: true,
    type: 'module',
    main: 'index.js',
  }, null, 2), 'utf8');
  const runnerUrl = pathToFileURL(realRunnerPath).href;
  await writeFile(join(directory, 'index.js'), [
    `export { default } from ${JSON.stringify(runnerUrl)};`,
    `export * from ${JSON.stringify(runnerUrl)};`,
    '',
  ].join('\n'), 'utf8');
  return directory;
}

function opencodeConfig({ providerUrl, pluginDirectory, runnerOptions }) {
  return {
    $schema: 'https://opencode.ai/config.json',
    model: 'mock/mock',
    update: 'disable',
    plugins: [{ package: pluginDirectory, options: runnerOptions }],
    providers: {
      mock: {
        name: 'Fleet Runner E2E Mock',
        package: '@opencode/ai/providers/openai-compatible',
        settings: { baseURL: `${providerUrl}/v1`, apiKey: 'fleet-runner-e2e-not-a-secret' },
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

function isolatedEnv({ home, project, mebularHome, configPath, password }) {
  const env = { ...process.env };
  // Never inherit the developer's real OpenCode/OpenChamber config, service
  // password or session id.
  for (const key of Object.keys(env)) {
    if (key.startsWith('OPENCHAMBER_')) delete env[key];
    if (key.startsWith('OPENCODE_')) delete env[key];
    if (key.startsWith('MEBULAR_')) delete env[key];
  }
  return {
    ...env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    MEBULAR_HOME: mebularHome,
    OPENCODE_CONFIG: configPath,
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_PASSWORD: password,
    NO_COLOR: '1',
    TMPDIR: project,
  };
}

function taskFor(intent, taskId) {
  return {
    taskId,
    from: { device: 'device-A', agent: 'planner' },
    to: { device: 'device-B', agent: 'openchamber' },
    intent,
    status: 'created',
    attempts: 0,
    trace: { chain: [] },
    terminal: false,
    lastEventId: `${taskId}#created`,
  };
}

function basicAuthorization(password) {
  return `Basic ${Buffer.from(`opencode:${password}`, 'utf8').toString('base64')}`;
}

async function main() {
  const keep = process.argv.includes('--keep');
  if (!existsSync(fleetEntry)) {
    console.error(`✗ 缺少 ${fleetEntry}；先运行 npm run build`);
    return 1;
  }
  if (!existsSync(realRunnerPath)) {
    console.error(`✗ 缺少 ${realRunnerPath}`);
    return 1;
  }

  const runRoot = await mkdtemp(join(tmpdir(), `mebular-openchamber-runner-e2e-${process.pid}-`));
  const home = join(runRoot, 'home');
  const project = join(runRoot, 'project');
  const mebularHome = join(runRoot, 'mebular-home');
  const configDir = join(home, '.config', 'opencode');
  const configPath = join(configDir, 'opencode.json');
  const discoveryFile = join(mebularHome, 'openchamber-runner.json');
  await mkdir(configDir, { recursive: true });
  await mkdir(project, { recursive: true });
  await mkdir(mebularHome, { recursive: true });

  const host = await resolveOpenCode();
  const provider = await createFakeOpenAI({ reply: fakeReply });
  const pluginDirectory = await createPluginDirectory(runRoot);
  const password = `fleet-runner-e2e-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const runnerOptions = {
    enabled: true,
    discoveryFile,
    requestTimeoutMs: 60_000,
  };
  await writeFile(configPath, JSON.stringify(opencodeConfig({
    providerUrl: provider.url,
    pluginDirectory,
    runnerOptions,
  }), null, 2), 'utf8');

  const env = isolatedEnv({ home, project, mebularHome, configPath, password });

  let serve = null;
  let serveOut = '';
  let serveErr = '';
  try {
    console.log('OpenChamber public runner 真实宿主 E2E（Fleet 0.3.2 WS-D）');
    console.log('============================================================');
    console.log(`  opencode：${host.bin}（${host.text.split('\n')[0]}）`);
    console.log(`  plugin：${realRunnerPath}`);
    console.log(`  隔离 root：${runRoot}`);

    const port = await getFreePort();
    serve = spawn(host.bin, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
      cwd: project,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serve.stdout.on('data', (chunk) => { serveOut += chunk.toString(); });
    serve.stderr.on('data', (chunk) => { serveErr += chunk.toString(); });

    const serverUrl = await waitForValue(() => {
      if (serve.exitCode !== null) {
        throw new Error(`opencode serve exited ${serve.exitCode}: ${tail(serveErr || serveOut)}`);
      }
      return /server listening on (http:\/\/\S+)/.exec(serveOut)?.[1] ?? null;
    }, { timeoutMs: 40000, label: 'opencode serve ready' });
    check('真实 opencode serve 启动', true, serverUrl);

    // 1. An existing session created through the real CLI.
    const sentinelPrompt = `sentinel-${Date.now()}`;
    const sentinelRun = await runProcess(host.bin, [
      'run', '--server', serverUrl, '--format', 'json', sentinelPrompt,
    ], { env, cwd: project, timeoutMs: 120000 });
    check('真实 opencode run 创建 sentinel session', sentinelRun.code === 0 && !sentinelRun.timedOut,
      tail(sentinelRun.stderr || sentinelRun.stdout));
    const sentinelID = parseSessionID(sentinelRun.stdout);
    if (!check('sentinel sessionID 已解析', typeof sentinelID === 'string' && sentinelID.startsWith('ses'),
      sentinelID ?? 'missing')) {
      return 1;
    }

    const auth = { authorization: basicAuthorization(password) };
    const api = async (path) => {
      const response = await fetch(`${serverUrl}${path}`, { headers: auth });
      const text = await response.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* keep text */ }
      return { status: response.status, text, json };
    };

    const sentinelSession = await api(`/api/session/${sentinelID}`);
    check('sentinel session 在宿主中存在', sentinelSession.status === 200
      && sentinelSession.json?.data?.id === sentinelID, `status=${sentinelSession.status}`);
    const sentinelContextBefore = await api(`/api/session/${sentinelID}/context`);
    check('sentinel session context 可读', sentinelContextBefore.status === 200
      && Array.isArray(sentinelContextBefore.json?.data), `status=${sentinelContextBefore.status}`);
    const sentinelBefore = JSON.stringify(sentinelContextBefore.json?.data ?? null);

    // 2. The runner plugin starts lazily on the first host request and writes
    //    its discovery file.
    const discovery = await waitForValue(async () => {
      try {
        const parsed = JSON.parse(await readFile(discoveryFile, 'utf8'));
        return parsed && typeof parsed.port === 'number' ? parsed : null;
      } catch {
        return null;
      }
    }, { timeoutMs: 40000, label: 'runner discovery' });

    check('discovery schema/kind/pid/port', discovery.schema === 1
      && discovery.kind === 'mebular-openchamber-runner'
      && discovery.pid === serve.pid
      && Number.isInteger(discovery.port)
      && discovery.port > 0
      && discovery.host === '127.0.0.1', JSON.stringify({
      schema: discovery.schema,
      kind: discovery.kind,
      pid: discovery.pid,
      host: discovery.host,
      port: discovery.port,
    }));
    check('discovery token 非空且未写日志', typeof discovery.token === 'string'
      && discovery.token.length >= 32
      && !`${serveOut}\n${serveErr}`.includes(discovery.token),
    `token length=${typeof discovery.token === 'string' ? discovery.token.length : 'missing'}`);
    const discoveryInfo = await stat(discoveryFile);
    check('discovery 文件权限 0600', process.platform === 'win32'
      || (discoveryInfo.mode & 0o077) === 0, (discoveryInfo.mode & 0o777).toString(8));

    const runnerUrl = `http://127.0.0.1:${discovery.port}`;
    const health = await fetch(`${runnerUrl}/health`);
    const healthBody = await health.text();
    check('runner /health 正常且不含 token', health.status === 200
      && JSON.parse(healthBody).ok === true
      && healthBody.includes(`"pid":${serve.pid}`)
      && !healthBody.includes(discovery.token), healthBody.slice(0, 200));

    const postRun = async (body, token) => {
      const headers = { 'content-type': 'application/json' };
      if (token !== undefined) headers.authorization = `Bearer ${token}`;
      const response = await fetch(`${runnerUrl}/v1/run-once`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      const text = await response.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* keep text */ }
      return { status: response.status, text, json };
    };

    const rejected = await postRun({ prompt: 'x', sessionId: sentinelID }, discovery.token);
    check('携带 sessionId 的请求被 400 拒绝（new session only）',
      rejected.status === 400
      && rejected.json?.error === 'BAD_REQUEST'
      && /new session only/i.test(String(rejected.json?.message ?? '')),
      `status=${rejected.status} ${rejected.text.slice(0, 200)}`);
    const noToken = await postRun({ prompt: 'x' });
    check('无 token 被 401 拒绝', noToken.status === 401 && noToken.json?.error === 'UNAUTHORIZED',
      `status=${noToken.status}`);
    const wrongToken = await postRun({ prompt: 'x' }, 'wrong-token');
    check('错误 token 被 401 拒绝', wrongToken.status === 401, `status=${wrongToken.status}`);

    // 3. Fleet's real adapter over the real runner.
    const fleet = await import(pathToFileURL(fleetEntry).href);
    const agent = new fleet.OpenChamberRunnerAgent({
      discoveryFile,
      env,
      timeoutMs: 60000,
    });
    const intent = `fleet runner e2e ${Date.now()}`;
    const taskId = `oc-e2e-${Date.now()}`;
    const outcome = await agent.execute(taskFor(intent, taskId));
    check('Fleet OpenChamberRunnerAgent 成功返回文本', outcome.ok === true
      && String(outcome.resultRef ?? '').includes(fakeReply),
    JSON.stringify(outcome).slice(0, 500));
    const newSessionID = /^session:(.+)$/.exec(String(outcome.reason ?? ''))?.[1];
    check('Fleet 结果携带新 sessionId', typeof newSessionID === 'string' && newSessionID.startsWith('ses'),
      newSessionID ?? String(outcome.reason ?? 'missing'));
    if (newSessionID !== undefined) {
      check('新 sessionId 不等于 sentinel sessionID', newSessionID !== sentinelID,
        `new=${newSessionID} sentinel=${sentinelID}`);
      const newSession = await api(`/api/session/${newSessionID}`);
      check('新 session 在宿主中存在', newSession.status === 200
        && newSession.json?.data?.id === newSessionID, `status=${newSession.status}`);
      const newContext = await api(`/api/session/${newSessionID}/context`);
      const newText = JSON.stringify(newContext.json?.data ?? {});
      check('新 session 的 assistant 文本包含 fake reply', newContext.status === 200
        && newText.includes(fakeReply), `status=${newContext.status}`);
    }

    const sentinelContextAfter = await api(`/api/session/${sentinelID}/context`);
    const sentinelAfter = JSON.stringify(sentinelContextAfter.json?.data ?? null);
    check('sentinel session context 未被 runner 改写', sentinelContextAfter.status === 200
      && sentinelAfter === sentinelBefore,
    `before=${sentinelBefore.length}B after=${sentinelAfter.length}B`);

    const healthResult = await agent.health();
    check('Fleet health 探测 /health 为 ok', healthResult.status === 'ok',
      JSON.stringify(healthResult));

    // 4. Fail-closed negatives: missing discovery and a wrong bearer token.
    const missingAgent = new fleet.OpenChamberRunnerAgent({
      discoveryFile: join(runRoot, 'missing-runner.json'),
      timeoutMs: 3000,
    });
    const missingOutcome = await missingAgent.execute(taskFor('missing discovery', `${taskId}-missing`));
    check('discovery 缺失 → ADAPTER_UNAVAILABLE', missingOutcome.ok === false
      && missingOutcome.reason === 'ADAPTER_UNAVAILABLE', JSON.stringify(missingOutcome));

    const badDiscoveryFile = join(runRoot, 'bad-token-runner.json');
    await writeFile(badDiscoveryFile, JSON.stringify({
      ...discovery,
      token: 'wrong-token',
      updatedAt: Date.now(),
    }), { mode: 0o600 });
    const badTokenAgent = new fleet.OpenChamberRunnerAgent({
      discoveryFile: badDiscoveryFile,
      timeoutMs: 5000,
    });
    const badTokenOutcome = await badTokenAgent.execute(taskFor('wrong token', `${taskId}-token`));
    check('错误 discovery token → AUTH_FAILED', badTokenOutcome.ok === false
      && badTokenOutcome.reason === 'AUTH_FAILED', JSON.stringify(badTokenOutcome));

    skip('超时/abort 负例', 'fake provider 即时返回；runner/client 超时由单测覆盖');

    check('fake provider 收到 sentinel 与 Fleet 两次真实 turn',
      provider.state.requests.length >= 2
      && provider.state.requests.some((entry) => JSON.stringify(entry.body).includes(sentinelPrompt))
      && provider.state.requests.some((entry) => JSON.stringify(entry.body).includes(intent)),
    `requests=${provider.state.requests.length}`);
    check('runner token 未出现在宿主日志', !`${serveOut}\n${serveErr}`.includes(discovery.token));
    check('OpenCode 全程存活', serve.exitCode === null, `exit=${serve.exitCode ?? 'alive'}`);
  } finally {
    if (serve !== null) {
      const exited = new Promise((resolvePromise) => {
        if (serve.exitCode !== null) resolvePromise();
        else serve.once('exit', resolvePromise);
      });
      try { serve.kill('SIGTERM'); } catch { /* best effort */ }
      const stopped = await Promise.race([
        exited.then(() => true),
        new Promise((resolvePromise) => setTimeout(() => resolvePromise(false), 5000)),
      ]);
      if (!stopped) {
        try { serve.kill('SIGKILL'); } catch { /* best effort */ }
        await Promise.race([
          exited,
          new Promise((resolvePromise) => setTimeout(resolvePromise, 5000)),
        ]);
      }
      check('opencode serve 已停止，无遗留进程', !isAlive(serve.pid), `pid=${serve.pid}`);
    }
    await provider.close().catch(() => undefined);
    if (keep) {
      console.log(`临时目录保留：${runRoot}`);
    } else {
      await rm(runRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  console.log('\n边界：真实 opencode serve + 真实 @mebular/opencode-plugin/fleet-runner；'
    + 'OpenAI 模型为 fake provider；非 OpenChamber Desktop UI；未访问真实用户配置或 session。');
  console.log(`${failed === 0 ? '✓' : '✗'} OpenChamber runner E2E：${passed} passed, ${failed} failed, ${skipped} skipped`);
  return failed === 0 ? 0 : 1;
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    console.error(`✗ OpenChamber runner E2E 未捕获错误：${error?.stack ?? error}`);
    process.exitCode = 1;
  });
