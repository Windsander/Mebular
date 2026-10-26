// Disposable world for one real DSH E2E scenario.
//
// Owns the scenario directory, a seeded Mebular home, a per-scenario DSH_HOME,
// the real daemon process, the real DSH Web process, and the headless Chrome
// page. The runner creates one world per scenario, so no two scenarios share a
// home, profile, runtime.json, port, artifact directory, or probe output.
//
// Artifacts are always written through redactText(): one-time DSH URL tokens,
// Authorization headers, token/secret values, the seed token, and all ephemeral
// home/CLI paths are stripped before a file is kept for CI.

import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { seedHome } from '../../tests/dsh/e2e/fixtures/seed-home.mjs';
import { connectCdp, launchChrome, openPage, sleep } from './cdp.mjs';
import {
  fetchJson,
  freePort,
  isProcessAlive,
  readJsonIfExists,
  readTextIfExists,
  runCommand,
  spawnLogged,
  stopProcess,
  tail,
  waitForHttpOk,
  waitForValue,
} from './e2e-process.mjs';
import { detectLeaks, redactText, redactValue } from './redact.mjs';

const IFRAME_SELECTOR = 'iframe[title="Mebular Console"]';
const SIDEBAR_SELECTOR = 'button[aria-label="Mebular"]';
const STATUS_SELECTOR = '[data-mebular-status]';

async function waitForServeReady(handle, timeoutMs = 45000) {
  const result = await waitForValue(
    async () => {
      if (handle.exitCode !== null) {
        throw new Error(`serve 提前退出（code=${handle.exitCode}）：${tail(handle.stderr, 600)}`);
      }
      const match = handle.stdout.match(/SERVE_READY (\{.*\})/);
      return match ? JSON.parse(match[1]) : null;
    },
    (value) => value !== null,
    { timeoutMs, describe: 'SERVE_READY' },
  );
  if (!result.ok) throw new Error(`serve 就绪超时：${result.error?.message ?? tail(handle.stderr, 600)}`);
  return result.value;
}

async function waitForDshUrl(handle, timeoutMs = 90000) {
  const result = await waitForValue(
    async () => {
      if (handle.exitCode !== null) {
        throw new Error(`DSH 提前退出（code=${handle.exitCode}）：${tail(handle.stderr, 900)}`);
      }
      const match = handle.stdout.match(/dsh web:\s+(http:\/\/\S+)/);
      return match ? match[1] : null;
    },
    (value) => typeof value === 'string' && value.length > 0,
    { timeoutMs, describe: 'DSH Web URL' },
  );
  if (!result.ok) throw new Error(`DSH Web URL 超时：${result.error?.message ?? tail(handle.stderr, 900)}`);
  return result.value;
}

function urlToken(url) {
  try {
    return new URL(url).searchParams.get('token');
  } catch {
    return null;
  }
}

/**
 * @param {{
 *   name: string,
 *   root: string,
 *   repoRoot: string,
 *   dshBin: string,
 *   dshInstall: string,
 *   dshVersion: string,
 *   pluginTarball: { path: string, filename: string },
 *   probeTarball: { path: string, filename: string },
 * }} options
 */
export async function createWorld(options) {
  const name = options.name;
  const scenarioDir = join(options.root, `scenario-${name}`);
  const mebularHome = join(scenarioDir, 'mebular-home');
  const dshHome = join(scenarioDir, 'dsh-home');
  const artifactsDir = join(scenarioDir, 'artifacts');
  const probeOut = join(artifactsDir, 'probe.json');
  await mkdir(artifactsDir, { recursive: true });

  const seed = await seedHome(mebularHome, { memoryToken: `dsh-e2e-${randomUUID()}` });

  const baseEnv = { ...process.env };
  for (const key of [
    'MEBULAR_HTTP_PORT', 'MEBULAR_CLI', 'PROBE_OUT', 'PROBE_QUERY', 'PROBE_EXPECT',
    'PROBE_TIMEOUT_MS', 'DSH_HOME', 'MEBULAR_HOME', 'MEBULAR_USER_HOME', 'MEBULAR_CLOUD_ROOT',
  ]) {
    delete baseEnv[key];
  }
  Object.assign(baseEnv, {
    DSH_HOME: dshHome,
    MEBULAR_HOME: mebularHome,
    MEBULAR_USER_HOME: mebularHome,
    MEBULAR_CLOUD_ROOT: mebularHome,
    NO_COLOR: '1',
    FORCE_COLOR: '0',
  });

  const daemonHandles = [];
  const dshHandles = [];
  const artifactTexts = new Map();
  const state = {
    name,
    scenarioDir,
    mebularHome,
    dshHome,
    artifactsDir,
    probeOut,
    dshVersion: options.dshVersion,
    daemon: null,
    daemonPort: null,
    daemonPorts: [],
    dsh: null,
    dshUrl: null,
    dshToken: null,
    dshPid: null,
    chrome: null,
    cdp: null,
    page: null,
    dumpConfigText: '',
    profileBundles: [],
    headers: null,
    // Daemon children this scenario proved the plugin spawned. Cleanup may stop
    // only these PIDs (and only while their command line still names Mebular),
    // never an external daemon.
    ownedChildPids: [],
    startedAt: new Date().toISOString(),
  };

  function secrets() {
    const values = new Set([seed.memoryToken]);
    if (typeof state.dshToken === 'string' && state.dshToken.length > 0) {
      values.add(state.dshToken);
      try { values.add(decodeURIComponent(state.dshToken)); } catch { /* Not encoded. */ }
    }
    return [...values];
  }

  function paths() {
    return [
      { value: scenarioDir, label: '<scenario>' },
      { value: mebularHome, label: '<mebular-home>' },
      { value: dshHome, label: '<dsh-home>' },
      { value: options.dshInstall, label: '<dsh-install>' },
      { value: options.root, label: '<e2e-root>' },
      { value: options.repoRoot, label: '<repo>' },
    ];
  }

  function redact(text) {
    return redactText(text, { secrets: secrets(), paths: paths() });
  }

  function daemonLog() {
    return daemonHandles.map((handle, index) => [
      `# daemon[${index}] pid=${handle.proc?.pid ?? 'n/a'} exit=${handle.exitCode ?? 'running'}`,
      handle.stdout,
      handle.stderr,
    ].join('\n')).join('\n\n');
  }

  function dshLog() {
    return dshHandles.map((handle, index) => [
      `# dsh[${index}] pid=${handle.proc?.pid ?? 'n/a'} exit=${handle.exitCode ?? 'running'}`,
      handle.stdout,
      handle.stderr,
    ].join('\n')).join('\n\n');
  }

  async function startDaemon(daemonOptions = {}) {
    if (state.daemon !== null && state.daemon.proc.exitCode === null) {
      throw new Error(`${name}: daemon 已在运行，拒绝重复启动`);
    }
    const port = Number.isInteger(daemonOptions.port) ? daemonOptions.port : await freePort();
    const handle = spawnLogged('daemon', process.execPath, [
      join(options.repoRoot, 'packages', 'mcp', 'bin', 'mebular.mjs'),
      'serve', '--host', '127.0.0.1', '--port', String(port),
    ], { cwd: options.repoRoot, env: { ...baseEnv, ...(daemonOptions.env ?? {}) } });
    daemonHandles.push(handle);
    state.daemon = handle;
    state.daemonPort = port;
    state.daemonPorts.push(port);

    const ready = await waitForServeReady(handle);
    if (ready.port !== port) throw new Error(`${name}: SERVE_READY 端口 ${ready.port} != ${port}`);
    const health = await fetchJson(`http://127.0.0.1:${port}/healthz`);
    if (health.status !== 200 || health.json?.status !== 'ok') {
      throw new Error(`${name}: /healthz 未就绪（status=${health.status}）`);
    }
    return { port, ready, health, pid: handle.proc.pid };
  }

  async function stopDaemon() {
    const handle = state.daemon;
    if (handle === null) return null;
    const pid = handle.proc.pid;
    await stopProcess(handle);
    state.daemon = null;
    return { pid, exitCode: handle.exitCode, signal: handle.signal };
  }

  /**
   * Stop the DSH Web process started by this scenario. DSH handles SIGTERM,
   * disposes the plugin tree (which stops a managed child it owns), then exits.
   * Kept as a helper so managed scenarios can prove child shutdown while the
   * external daemon (if any) survives.
   */
  async function stopDsh({ timeoutMs = 15000 } = {}) {
    const handle = state.dsh;
    if (handle === null) return null;
    const pid = handle.proc.pid;
    await stopProcess(handle, { timeoutMs });
    if (state.dsh === handle) state.dsh = null;
    return { pid, exitCode: handle.exitCode, signal: handle.signal };
  }

  /** Wait until a PID is gone (or the timeout expires). @returns {Promise<boolean>} */
  async function waitForExit(pid, timeoutMs = 15000) {
    const result = await waitForValue(
      async () => isProcessAlive(pid),
      (alive) => alive === false,
      { timeoutMs, intervalMs: 250, describe: `pid ${pid} 退出` },
    );
    return result.ok;
  }

  /**
   * Record a daemon PID the plugin is expected to own. Only this scenario's
   * managed child is tracked; external daemons are never passed here.
   */
  function trackOwnedChild(pid) {
    if (!Number.isInteger(pid) || pid <= 0 || pid === state.dshPid) return false;
    if (!state.ownedChildPids.includes(pid)) state.ownedChildPids.push(pid);
    return true;
  }

  /** Best-effort command line of a PID, used to avoid killing a reused PID. */
  async function processCommand(pid) {
    if (process.platform === 'win32') return null;
    const result = await runCommand('ps', 'ps', ['-o', 'command=', '-p', String(pid)], { timeoutMs: 5000 });
    return result.code === 0 ? result.stdout.trim() : null;
  }

  /**
   * Failure-path cleanup for tracked managed children. Runs only after DSH was
   * stopped, so a normal managed lifecycle leaves nothing to do. A PID whose
   * command line no longer names Mebular is left alone (possible PID reuse).
   */
  async function stopTrackedChildren() {
    for (const pid of [...state.ownedChildPids]) {
      if (!isProcessAlive(pid)) continue;
      const command = await processCommand(pid);
      if (command !== null && !/mebular/i.test(command)) continue;
      try { process.kill(pid, 'SIGTERM'); } catch { /* Best effort. */ }
      if (!(await waitForExit(pid, 5000))) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* Best effort. */ }
        await waitForExit(pid, 2000);
      }
    }
  }

  async function installProfile(profileOptions = {}) {
    const withProbe = profileOptions.withProbe !== false;
    const runProfileCommand = async (label, args, timeoutMs = 300000) => {
      const result = await runCommand(label, options.dshBin, args, {
        cwd: options.repoRoot,
        env: { ...baseEnv },
        timeoutMs,
      });
      if (result.code !== 0) {
        throw new Error(`${name}: ${label} 失败：${tail(result.stderr || result.stdout, 1200)}`);
      }
      return result;
    };

    await runProfileCommand('dsh plugin add @mebular/dsh-plugin', [
      'plugin', '--profile', 'web', 'add', options.pluginTarball.path,
    ]);
    if (withProbe) {
      await runProfileCommand('dsh plugin add probe', [
        'plugin', '--profile', 'web', 'add', options.probeTarball.path,
      ]);
    }

    if (typeof profileOptions.patch === 'string') {
      await writeFile(join(dshHome, 'profiles', 'web', 'cordis.patch.yml'), profileOptions.patch, 'utf-8');
    }

    const profilePkg = await readJsonIfExists(join(dshHome, 'profiles', 'web', 'package.json'));
    state.profileBundles = profilePkg?.dsh?.profile?.bundles ?? [];
    return state.profileBundles;
  }

  async function dumpConfig() {
    const result = await runCommand('dsh --dump-config', options.dshBin, [
      '--profile', 'web', '--dump-config',
    ], {
      cwd: options.repoRoot,
      env: { ...baseEnv },
      timeoutMs: 120000,
    });
    state.dumpConfigText = `${result.stdout}\n${result.stderr}`;
    if (result.code !== 0) {
      throw new Error(`${name}: dsh --dump-config 失败：${tail(result.stderr, 900)}`);
    }
    return state.dumpConfigText;
  }

  async function startDsh(dshOptions = {}) {
    if (state.dsh !== null && state.dsh.proc.exitCode === null) {
      throw new Error(`${name}: DSH 已在运行，拒绝重复启动`);
    }
    const env = { ...baseEnv, ...(dshOptions.env ?? {}) };
    if (typeof dshOptions.probeExpect === 'string') {
      Object.assign(env, {
        PROBE_OUT: probeOut,
        PROBE_QUERY: seed.memoryToken,
        PROBE_EXPECT: dshOptions.probeExpect,
        PROBE_TIMEOUT_MS: '180000',
      });
    }
    const handle = spawnLogged('dsh-web', options.dshBin, [
      '--profile', 'web', '--no-open', '--host', '127.0.0.1', '--port', '0',
    ], { cwd: options.repoRoot, env });
    dshHandles.push(handle);
    state.dsh = handle;
    state.dshPid = handle.proc.pid;

    const url = await waitForDshUrl(handle);
    state.dshUrl = url;
    state.dshToken = urlToken(url);
    const http = await waitForHttpOk(url, 30000);
    if (!http.ok) throw new Error(`${name}: DSH Web 入口未响应（status=${http.value}）`);
    return url;
  }

  async function openBrowser(browserOptions = {}) {
    const chromePath = browserOptions.chromePath;
    if (typeof chromePath !== 'string' || chromePath.length === 0) {
      throw new Error(`${name}: openBrowser 需要 chromePath`);
    }
    state.chrome = await launchChrome(chromePath);
    state.cdp = connectCdp(state.chrome.wsUrl);
    await state.cdp.ready;
    state.page = await openPage(state.cdp, {
      url: browserOptions.url ?? state.dshUrl,
      timeoutMs: 60000,
    });
    return state.page;
  }

  function pageOrThrow() {
    if (state.page === null) throw new Error(`${name}: 浏览器页面尚未打开`);
    return state.page;
  }

  async function probeState() {
    return readJsonIfExists(probeOut);
  }

  async function waitForProbe(predicate, waitOptions = {}) {
    return waitForValue(
      async () => probeState(),
      (value) => value !== null && predicate(value),
      {
        timeoutMs: waitOptions.timeoutMs ?? 60000,
        intervalMs: waitOptions.intervalMs ?? 500,
        describe: waitOptions.describe ?? 'probe 状态',
      },
    );
  }

  async function waitForStatus(status, timeoutMs = 45000) {
    const page = pageOrThrow();
    return page.waitFor(
      `document.querySelector(${JSON.stringify(STATUS_SELECTOR)})?.getAttribute("data-mebular-status") === ${JSON.stringify(status)}`,
      { timeout: timeoutMs },
    );
  }

  async function openPanel() {
    const page = pageOrThrow();
    return page.evalJs(`(() => {
      const button = document.querySelector(${JSON.stringify(SIDEBAR_SELECTOR)});
      if (button && button.getAttribute('aria-current') !== 'page') button.click();
      return Boolean(button);
    })()`);
  }

  async function waitForIframe(timeoutMs = 45000) {
    const page = pageOrThrow();
    return page.waitFor(`!!document.querySelector(${JSON.stringify(IFRAME_SELECTOR)})`, { timeout: timeoutMs });
  }

  async function waitForNoIframe(timeoutMs = 45000) {
    const page = pageOrThrow();
    return page.waitFor(`!document.querySelector(${JSON.stringify(IFRAME_SELECTOR)})`, { timeout: timeoutMs });
  }

  async function iframeSrc() {
    const page = pageOrThrow();
    return page.evalJs(`document.querySelector(${JSON.stringify(IFRAME_SELECTOR)})?.src ?? ""`);
  }

  async function pageText() {
    return pageOrThrow().evalJs('document.body?.innerText ?? ""');
  }

  async function fetchDshJson(path) {
    const page = pageOrThrow();
    return page.evalJs(`(async () => {
      const response = await fetch(${JSON.stringify(path)}, {
        cache: 'no-store',
        headers: { accept: 'application/json' },
      });
      const json = await response.json().catch(() => null);
      return { status: response.status, json };
    })()`);
  }

  async function waitForFrameEval(urlPrefix, expression, predicate, timeoutMs = 30000) {
    const page = pageOrThrow();
    const started = Date.now();
    let lastValue;
    let lastError = null;
    while (Date.now() - started < timeoutMs) {
      try {
        const frames = await page.frameTree();
        const frame = frames.find((entry) => typeof entry.url === 'string' && entry.url.startsWith(urlPrefix));
        if (frame) {
          lastValue = await page.evalInFrameByUrl(urlPrefix, expression);
          if (predicate(lastValue)) return { ok: true, value: lastValue };
        }
      } catch (error) {
        lastError = error;
      }
      await sleep(250);
    }
    return { ok: false, value: lastValue, error: lastError };
  }

  async function recordJson(name, value) {
    const safe = redactValue(value ?? null, { secrets: secrets(), paths: paths() });
    const text = JSON.stringify(safe, null, 2);
    await writeFile(join(artifactsDir, name), `${text}\n`, 'utf-8');
    artifactTexts.set(name, text);
  }

  async function recordText(name, value) {
    const text = redactText(value ?? '', { secrets: secrets(), paths: paths() });
    await writeFile(join(artifactsDir, name), text, 'utf-8');
    artifactTexts.set(name, text);
  }

  async function collectArtifacts(reason) {
    const files = [];
    const record = async (name, writer) => {
      try {
        await writer();
        files.push(name);
      } catch {
        // Best effort.
      }
    };

    await record('scenario.json', () => recordJson('scenario.json', {
      name,
      reason,
      at: new Date().toISOString(),
      dshVersion: state.dshVersion,
      dshUrl: state.dshUrl,
      daemonPorts: state.daemonPorts,
      daemonPid: state.daemon?.proc?.pid ?? null,
      dshPid: state.dshPid,
      profileBundles: state.profileBundles,
    }));
    await record('seed.json', () => recordJson('seed.json', {
      ...seed,
      memoryToken: '<redacted>',
    }));
    await record('dsh-log.txt', () => recordText('dsh-log.txt', dshLog()));
    await record('daemon-log.txt', () => recordText('daemon-log.txt', daemonLog()));
    await record('dsh-dump-config.yml', () => recordText('dsh-dump-config.yml', state.dumpConfigText));
    await record('runtime.json', async () => {
      const text = await readTextIfExists(join(mebularHome, 'runtime.json'));
      // A managed daemon removes runtime.json when it exits; keep the artifact
      // a valid JSON document instead of writing an empty file.
      await recordText('runtime.json', text === null ? 'null\n' : text);
    });
    await record('profiles.json', async () => {
      await recordText('profiles.json', await readTextIfExists(join(mebularHome, 'profiles.json')));
    });
    if (state.daemonPort !== null) {
      const origin = `http://127.0.0.1:${state.daemonPort}`;
      await record('healthz.json', async () => {
        const health = await fetchJson(`${origin}/healthz`).catch(() => null);
        await recordJson('healthz.json', health);
      });
      await record('embed-info.json', async () => {
        const embed = await fetchJson(`${origin}/app/embed/info`).catch(() => null);
        await recordJson('embed-info.json', embed);
      });
    }
    if (state.page !== null) {
      await record('dsh-embed-info.json', async () => {
        const info = await fetchDshJson('/mebular/embed-info').catch(() => null);
        await recordJson('dsh-embed-info.json', info);
      });
      await record('browser-errors.json', () => recordJson('browser-errors.json', state.page.errors));
      await record('browser-dom.html', async () => {
        const dom = await state.page.dom().catch(() => '');
        await recordText('browser-dom.html', dom);
      });
      try {
        const shot = await state.page.screenshot();
        await writeFile(join(artifactsDir, 'screenshot.png'), shot);
        files.push('screenshot.png');
      } catch {
        // Best effort.
      }
    }
    await record('probe.json', async () => {
      const probe = await probeState();
      await recordJson('probe.json', probe);
    });
    if (state.headers !== null) await record('headers.json', () => recordJson('headers.json', state.headers));

    // Audit what was actually written, not what redactText returned.
    const leaks = [];
    for (const [file, text] of artifactTexts) {
      const found = detectLeaks(text, { secrets: secrets(), paths: paths() });
      if (file.endsWith('.json')) {
        try {
          JSON.parse(text);
        } catch {
          found.push('invalid-json');
        }
      }
      if (found.length > 0) leaks.push({ file, found });
    }
    const audit = {
      at: new Date().toISOString(),
      files: [...artifactTexts.keys()],
      leaks,
    };
    const auditText = redactText(JSON.stringify(audit, null, 2), { secrets: secrets(), paths: paths() });
    await writeFile(join(artifactsDir, 'redaction-audit.json'), `${auditText}\n`, 'utf-8');
    files.push('redaction-audit.json');

    return { dir: artifactsDir, files, leaks };
  }

  async function removePlugin(specifier) {
    const result = await runCommand('dsh plugin remove', options.dshBin, [
      'plugin', '--profile', 'web', 'remove', specifier,
    ], {
      cwd: options.repoRoot,
      env: { ...baseEnv },
      timeoutMs: 300000,
    });
    if (result.code !== 0) {
      throw new Error(`${name}: dsh plugin remove 失败：${tail(result.stderr || result.stdout, 1200)}`);
    }
    return result;
  }

  async function cleanup({ keep = false } = {}) {
    await state.page?.close().catch(() => undefined);
    await state.cdp?.close().catch(() => undefined);
    await state.chrome?.close().catch(() => undefined);
    for (const handle of [...dshHandles].reverse()) await stopProcess(handle);
    await stopTrackedChildren();
    for (const handle of [...daemonHandles].reverse()) await stopProcess(handle);
    state.page = null;
    state.cdp = null;
    state.chrome = null;
    state.dsh = null;
    state.daemon = null;
    if (!keep) {
      await rm(scenarioDir, { recursive: true, force: true }).catch(() => undefined);
    }
    return { retained: keep, dir: scenarioDir };
  }

  return {
    name,
    dir: scenarioDir,
    seed,
    state,
    env: baseEnv,
    startDaemon,
    stopDaemon,
    stopDsh,
    waitForExit,
    trackOwnedChild,
    installProfile,
    dumpConfig,
    startDsh,
    openBrowser,
    probeState,
    waitForProbe,
    waitForStatus,
    openPanel,
    waitForIframe,
    waitForNoIframe,
    iframeSrc,
    pageText,
    fetchDshJson,
    waitForFrameEval,
    collectArtifacts,
    removePlugin,
    cleanup,
    redact,
    isProcessAlive,
    sleep,
  };
}
