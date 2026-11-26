#!/usr/bin/env node
// Adapter provisioning E2E (W7): the *adapter* is the only writer of
// `~/.config/opencode/opencode.json`; a real opencode v2.4.1 process then loads
// the plugin written by that adapter and ingests a real turn.
//
// Flow:
//   1. temporary HOME / Mebular home / project / real sidecar;
//   2. real `mebular adapter ensure --host opencode --json` (detect → package →
//      plugins merge → next-start → readback verify);
//   3. assert the test never wrote opencode.json: it does not exist before the
//      adapter runs and its bytes stay identical for the rest of the run;
//   4. real `opencode serve` (the model/provider half of the config arrives via
//      OPENCODE_CONFIG_CONTENT, so the adapter stays the only config-file
//      writer), one real turn with an explicit fact;
//   5. wait for `/status.counts.ingested > 0` and a `/traces` entry with
//      `agentId=opencode`.
//
// No production code is mocked. Failures print a stable diagnostic without the
// host token, prompt body or memory text.
//
// Usage: node tests/integration/host-e2e/adapter-provision-opencode.mjs [--keep]
// Env:   OPENCODE_BIN (default: PATH, then the shared e2e-tools install)

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFakeOpenAI } from './lib/fake-openai.mjs';
import { requestSidecar, sidecarTokenFromFile, startRealRuntime } from './lib/real-runtime.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const cliBin = join(repoRoot, 'packages', 'mcp', 'bin', 'mebular.mjs');
const repoPluginDir = join(repoRoot, 'packages', 'opencode-plugin');
const SIDECAR_API = '/memory-runtime/v1';
const DEFAULT_OPENCODE_BIN = '/private/var/folders/86/gpjtr2p94dg7mz24pbkrj8pw0000gn/T/mebular-e2e-tools/node_modules/.bin/opencode';
const OPENCODE_BIN = process.env.OPENCODE_BIN
  || (existsSync(DEFAULT_OPENCODE_BIN) ? DEFAULT_OPENCODE_BIN : 'opencode');

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

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function parseSessionID(output) {
  for (const line of output.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed.sessionID === 'string' && parsed.sessionID.startsWith('ses')) return parsed.sessionID;
      if (typeof parsed?.data?.sessionID === 'string') return parsed.data.sessionID;
    } catch {
      // Non-JSON stderr/debug lines are ignored.
    }
  }
  return null;
}

/** Only the model/provider half lives in the environment; `plugins` is adapter-owned. */
function opencodeModelConfig(providerUrl) {
  return {
    $schema: 'https://opencode.ai/config.json',
    model: 'mock/mock',
    update: 'disable',
    providers: {
      mock: {
        name: 'Adapter Provisioning E2E Mock',
        package: '@opencode/ai/providers/openai-compatible',
        settings: { baseURL: `${providerUrl}/v1`, apiKey: 'adapter-e2e-not-a-secret' },
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

async function listTraces(discovery) {
  const result = await requestSidecar(discovery, '/traces?limit=100');
  if (result.status !== 200) {
    throw new Error(`GET /traces failed: status=${result.status}`);
  }
  return Array.isArray(result.data?.traces) ? result.data.traces : [];
}

function redact(text, secrets, limit = 400) {
  let out = String(text ?? '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 8) out = out.split(secret).join('[redacted]');
  }
  const trimmed = out.trim();
  return trimmed.length > limit ? `${trimmed.slice(-limit)}` : trimmed;
}

function adapterStatePath(home) {
  return join(home, 'adapters.json');
}

async function main() {
  const keep = process.argv.includes('--keep');
  const runRoot = join(tmpdir(), `mebular-adapter-provision-opencode-${process.pid}-${Date.now()}`);
  const home = join(runRoot, 'home');
  const project = join(runRoot, 'project');
  const mebularHome = join(runRoot, 'mebular-home');
  const configDir = join(home, '.config', 'opencode');
  const configPath = join(configDir, 'opencode.json');

  // Host detection needs the config *directory*; the adapter must create the
  // config file itself. This is the core "no manual opencode.json" invariant.
  await mkdir(configDir, { recursive: true });
  await mkdir(project, { recursive: true });
  await mkdir(join(mebularHome, 'memory-runtime'), { recursive: true });

  await writeFile(join(mebularHome, 'memory-runtime', 'config.json'), JSON.stringify({
    schema: 1,
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
  const factToken = `adapter-fact-${suffix}`;
  const prompt = `请记住这个稳定事实：我的构建代号是 ${factToken}。只需回复 OK。`;
  const secrets = [hostToken, factToken, prompt];

  const baseEnv = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    MEBULAR_HOME: mebularHome,
    MEBULAR_MEMORY_RUNTIME_HOME: mebularHome,
    MEBULAR_USER_HOME: home,
    MEBULAR_MEMORY_RUNTIME_URL: '',
    MEBULAR_RUNTIME_URL: '',
    MEBULAR_RUNTIME_TOKEN: '',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    NO_COLOR: '1',
  };
  const pathParts = [
    dirname(OPENCODE_BIN),
    process.env.PATH ?? '',
  ].filter(Boolean);

  let serve = null;
  try {
    console.log('Adapter provisioning E2E（真实 opencode + 真实 adapter + 真实 sidecar）');
    console.log('====================================================================');

    check('真实 sidecar discovery 写出 /memory-runtime/v1',
      String(discovery.url).endsWith(SIDECAR_API), discovery.url);

    const version = await runProcess(OPENCODE_BIN, ['--version'], { timeoutMs: 20000 });
    const versionText = `${version.stdout}\n${version.stderr}`.trim();
    const supported = /v?2\.(?:[4-9]|[1-9]\d)\./.test(versionText);
    if (!check('opencode 可启动且 >= 2.4（adapter E2E 基线）',
      version.code === 0 && supported,
      redact(versionText.split('\n')[0] ?? `missing ${OPENCODE_BIN}`, secrets))) {
      console.log('  → 设置 OPENCODE_BIN 指向 opencode >= 2.4 后重试。');
      return 1;
    }
    const opencodeVersion = /v?(\d+\.\d+\.\d+)/.exec(versionText)?.[1] ?? null;

    // ---- The adapter is the only writer of opencode.json -----------------
    check('测试开始时 opencode.json 不存在（只有配置目录）',
      !existsSync(configPath) && existsSync(configDir));

    const ensureEnv = {
      ...baseEnv,
      PATH: pathParts.join(':'),
    };
    const ensure = await runProcess(process.execPath, [cliBin, 'adapter', 'ensure', '--host', 'opencode', '--json'], {
      env: ensureEnv,
      cwd: project,
      timeoutMs: 60000,
    });
    let ensureJson = null;
    try {
      ensureJson = JSON.parse(ensure.stdout.trim());
    } catch {
      ensureJson = null;
    }
    check('真实 `mebular adapter ensure --host opencode --json` 退出 0',
      ensure.code === 0 && !ensure.timedOut && ensureJson?.ok === true,
      ensure.code === 0 && ensureJson?.ok === true ? '' : redact(ensure.stderr || ensure.stdout, secrets));
    if (ensureJson?.ok !== true) {
      console.log('  诊断：ensure stdout/stderr 见上；未继续启动宿主。');
      return 1;
    }
    check('ensure 报告 installed + next-start（不杀进程）',
      ensureJson.status === 'installed'
      && ensureJson.activation === 'next-start'
      && ensureJson.changed === true
      && ensureJson.verified === true,
      JSON.stringify({
        status: ensureJson.status,
        activation: ensureJson.activation,
        changed: ensureJson.changed,
        verified: ensureJson.verified,
      }));
    check('ensure 回读检查全部通过（config-exists/entry-unique/options/package/version）',
      Array.isArray(ensureJson.checks)
      && ensureJson.checks.length > 0
      && ensureJson.checks.every((entry) => entry.ok === true),
      JSON.stringify(ensureJson.checks));

    const configText = await readFile(configPath, 'utf8');
    const configHash = sha256(configText);
    const configStat = await stat(configPath);
    const configDoc = JSON.parse(configText);
    const pluginEntries = Array.isArray(configDoc.plugins) ? configDoc.plugins : [];
    const mebularEntries = pluginEntries.filter((entry) => entry?.package === repoPluginDir);
    check('adapter 写入唯一的 plugins 条目（repo 包绝对路径）',
      mebularEntries.length === 1,
      JSON.stringify(pluginEntries.map((entry) => entry?.package ?? entry)));
    check('adapter 写入的插件选项含 agentId/recall/ingest',
      mebularEntries[0]?.options?.agentId === 'opencode'
      && mebularEntries[0]?.options?.recall === true
      && mebularEntries[0]?.options?.ingest === true,
      JSON.stringify(mebularEntries[0]?.options));
    check('适配器没有写入模型/provider 配置（该部分只走环境变量）',
      configDoc.model === undefined && configDoc.providers === undefined,
      JSON.stringify(Object.keys(configDoc)));

    const state = JSON.parse(await readFile(adapterStatePath(mebularHome), 'utf8'));
    const adapters = await readdir(join(mebularHome, 'adapters')).catch(() => []);
    check('adapters.json 记录 opencode=installed 与脱敏 configPath',
      state.hosts?.opencode?.adapter === 'installed'
      && state.hosts?.opencode?.version === ensureJson.version
      && state.hosts?.opencode?.activation === 'next-start'
      && state.hosts?.opencode?.configPath === '~/.config/opencode/opencode.json'
      && state.hosts?.opencode?.lastError === null,
      JSON.stringify({
        adapter: state.hosts?.opencode?.adapter,
        version: state.hosts?.opencode?.version,
        configPath: state.hosts?.opencode?.configPath,
      }));
    check('adapters.json 不含 host token / 事实正文',
      !JSON.stringify(state).includes(hostToken) && !JSON.stringify(state).includes(factToken));
    check('仓库包路径来源被记录（无 npm 下载、无 managed 目录写入）',
      ensureJson.source === 'manual' && adapters.length === 0,
      JSON.stringify({ source: ensureJson.source, managedEntries: adapters }));

    // Idempotency through the real CLI (still the only writer).
    const ensureAgain = await runProcess(process.execPath, [cliBin, 'adapter', 'ensure', '--host', 'opencode', '--json'], {
      env: ensureEnv,
      cwd: project,
      timeoutMs: 60000,
    });
    const ensureAgainJson = (() => {
      try { return JSON.parse(ensureAgain.stdout.trim()); } catch { return null; }
    })();
    check('第二次 ensure 幂等：changed=false 且配置字节不变',
      ensureAgain.code === 0
      && ensureAgainJson?.ok === true
      && ensureAgainJson.changed === false
      && sha256(await readFile(configPath, 'utf8')) === configHash,
      JSON.stringify({ changed: ensureAgainJson?.changed, exit: ensureAgain.code }));

    // ---- Real opencode loads the adapter-written plugin --------------------
    const port = await getFreePort();
    serve = spawn(OPENCODE_BIN, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
      cwd: project,
      env: {
        ...process.env,
        ...baseEnv,
        PATH: pathParts.join(':'),
        OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeModelConfig(provider.url)),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let serveOut = '';
    let serveErr = '';
    serve.stdout.on('data', (chunk) => { serveOut += chunk.toString(); });
    serve.stderr.on('data', (chunk) => { serveErr += chunk.toString(); });
    const ready = await waitFor(() => /server listening on (http:\/\/\S+)/.test(serveOut), {
      timeoutMs: 30000,
    });
    check('真实 opencode serve 启动',
      Boolean(ready),
      ready ? '' : redact(serveOut || serveErr, secrets));
    if (!ready) {
      console.log('  诊断：宿主未就绪；未继续 turn。');
      return 1;
    }
    const serverUrl = /server listening on (http:\/\/\S+)/.exec(serveOut)?.[1];

    const turn = await runProcess(OPENCODE_BIN, [
      'run', '--server', serverUrl, '--format', 'json', prompt,
    ], {
      env: { ...baseEnv, PATH: pathParts.join(':') },
      cwd: project,
      timeoutMs: 180000,
    });
    const sessionID = parseSessionID(turn.stdout);
    check('真实 opencode turn 退出 0 且拿到 sessionID',
      turn.code === 0 && !turn.timedOut && typeof sessionID === 'string' && sessionID.startsWith('ses'),
      turn.code === 0 && typeof sessionID === 'string' ? '' : redact(turn.stderr || turn.stdout, secrets));
    if (turn.code !== 0) {
      console.log('  诊断：turn 失败（见上），未产生可断言的 sidecar 数据。');
      return 1;
    }

    const contextStatus = await waitFor(async () => {
      const status = await runtime.sidecarStatus();
      return (status?.counts?.contexts ?? 0) >= 1 ? status : null;
    }, { timeoutMs: 30000 });
    check('插件已加载：真实 /context 计数 > 0（adapter 写入的 plugins 生效）',
      Boolean(contextStatus) && (contextStatus?.counts?.contexts ?? 0) >= 1,
      JSON.stringify(contextStatus?.counts ?? null));

    const ingestStatus = await waitFor(async () => {
      const status = await runtime.sidecarStatus();
      return (status?.counts?.ingested ?? 0) > 0 ? status : null;
    }, { timeoutMs: 45000 });
    check('真实 /status.counts.ingested > 0（自动采集生效）',
      Boolean(ingestStatus) && (ingestStatus?.counts?.ingested ?? 0) > 0,
      JSON.stringify(ingestStatus?.counts ?? null));

    const traces = await waitFor(async () => {
      const list = await listTraces(discovery);
      const matched = list.filter((trace) => trace?.agentId === 'opencode');
      return matched.length > 0 ? matched : null;
    }, { timeoutMs: 30000 });
    check('真实 /traces 出现 agentId=opencode 的记录',
      Array.isArray(traces) && traces.length > 0,
      JSON.stringify({
        traces: (traces ?? []).length,
        agentIds: [...new Set((traces ?? []).map((trace) => trace?.agentId ?? null))],
      }));
    check('trace 归属真实 turn（threadId 与 sessionID 一致）',
      Array.isArray(traces)
      && traces.some((trace) => trace?.threadId === sessionID),
      JSON.stringify({ sessionID, threads: [...new Set((traces ?? []).map((trace) => trace?.threadId ?? null))].slice(0, 4) }));

    const status = await requestSidecar(discovery, '/status');
    check('sidecar /status 可读且已沉降计数增长',
      status.status === 200
      && (status.data?.counts?.contexts ?? 0) >= 1
      && (status.data?.counts?.ingested ?? 0) > 0,
      JSON.stringify({
        contexts: status.data?.counts?.contexts ?? null,
        ingested: status.data?.counts?.ingested ?? null,
        settled: status.data?.counts?.settled ?? null,
      }));

    // ---- No other writer for the whole run -------------------------------
    const finalStat = await stat(configPath);
    check('运行结束后 opencode.json 字节仍未改变（adapter 是唯一写入者）',
      sha256(await readFile(configPath, 'utf8')) === configHash);
    check('运行结束后 opencode.json mtime 未改变（无第二次落盘）',
      finalStat.mtimeMs === configStat.mtimeMs,
      JSON.stringify({ afterEnsure: configStat.mtimeMs, afterRun: finalStat.mtimeMs }));
    check('openCode 进程存活到断言结束',
      serve.exitCode === null,
      serve.exitCode === null ? '' : redact(serveErr, secrets));

    check('诊断信息不含 host token / 事实正文',
      !JSON.stringify({ ensure: ensureJson }).includes(hostToken)
      && !JSON.stringify({ ensure: ensureJson }).includes(factToken));

    if (keep) {
      console.log(`临时目录保留：${runRoot}`);
      console.log(`opencode 版本：${opencodeVersion ?? versionText.split('\n')[0]}`);
    }
  } finally {
    if (serve !== null) {
      try { serve.kill('SIGTERM'); } catch { /* best effort */ }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
      try { serve.kill('SIGKILL'); } catch { /* best effort */ }
    }
    await provider.close().catch(() => undefined);
    if (keep) {
      await runtime.close().catch(() => undefined);
    } else {
      await runtime.cleanup().catch(() => undefined);
      await rm(runRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  console.log(`\n${failed === 0 ? '✓' : '✗'} Adapter provisioning E2E：${passed} passed, ${failed} failed`);
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    console.error(`✗ Adapter provisioning E2E 未捕获错误：${error?.stack ?? error}`);
    process.exitCode = 1;
  });
