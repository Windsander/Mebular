// Phase 4b · DSH plugin-only runtime install: explicit consent, fixed npm
// source, atomic install, provider/init/start, failure recovery, loopback route
// and the attach lifecycle's explicit start/retry. Everything is offline: the
// npm/CLI children are fake and write into temp directories.

import { describe, it, expect, afterEach } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RUNTIME_INSTALL_VERSION,
  buildEmbedInfo,
  buildRuntimeInstallCommand,
  classifyRuntimeInstallFailure,
  createDaemonLifecycle,
  createRuntimeInstallHandler,
  createRuntimeInstallManager,
  sanitizeRuntimeInstallState,
} from '../../packages/dsh-plugin/index.js';

const HEALTH = { status: 'ok', name: 'mebular', version: '0.1.2' };
const EMBED = {
  ok: true,
  name: 'mebular',
  version: '0.1.2',
  embedProtocol: 1,
  consoleUrl: 'http://127.0.0.1:9333/console',
  embedUrl: 'http://127.0.0.1:9333/console/?embed=dsh',
  mcpUrl: 'http://127.0.0.1:9333/mcp',
  loopback: true,
  capabilities: { embedConsole: true },
};

const tempDirs = [];

async function tempRoot(prefix = 'dsh-install-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    await rm(dir, { recursive: true, force: true });
  }
});

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('waitFor timed out');
}

async function waitSettled(manager) {
  await waitFor(() => ['idle', 'done', 'failed'].includes(manager.getState().state));
  return manager.getState();
}

function discovery(provider = null) {
  return {
    cloudRoot: '/tmp/dsh-install-discovery',
    providers: provider === null ? [] : [provider],
    selected: provider,
    warnings: [],
  };
}

function provider(kind = 'app', path = '/opt/mebular/bin/mebular.mjs') {
  return { kind, path, source: 'registry', version: '0.1.2' };
}

function createFakeLifecycle({
  status = 'down',
  discoveredProvider = null,
  service = false,
  startStatus = 'up',
  startReason = 'start_failed',
  managed = true,
  state = null,
  reason = null,
} = {}) {
  let currentState = {
    status,
    state: status === 'up' ? 'up' : (state ?? 'download_required'),
    reason: status === 'up' ? null : (reason ?? 'download_required'),
    provider: discoveredProvider,
    service: { registered: service, running: service, foreign: false },
    managed: false,
    downloadRequired: status !== 'up',
  };
  let nextStart = startStatus;
  const calls = [];
  return {
    calls,
    get current() {
      return currentState;
    },
    setStart(value) {
      nextStart = value;
    },
    inspect: async () => ({ ...currentState }),
    startAfterInstall: async (options = {}) => {
      calls.push(options);
      if (nextStart === 'up') {
        currentState = {
          ...currentState,
          status: 'up',
          state: 'up',
          reason: null,
          managed,
          downloadRequired: false,
        };
      } else {
        currentState = {
          ...currentState,
          status: 'down',
          state: 'down',
          reason: startReason,
          managed: false,
          downloadRequired: true,
        };
      }
      return { ...currentState };
    },
  };
}

async function writeCore(prefix, version, content = '// fake shared runtime\n') {
  const core = join(prefix, 'node_modules', '@mebular', 'core');
  await mkdir(join(core, 'packages', 'mcp', 'bin'), { recursive: true });
  await writeFile(join(core, 'package.json'), `${JSON.stringify({ name: '@mebular/core', version })}\n`, 'utf-8');
  await writeFile(join(core, 'packages', 'mcp', 'bin', 'mebular.mjs'), content, 'utf-8');
}

/**
 * One fake child factory for npm and the installed CLI. Each call records the
 * exact argv so tests can assert the fixed command and reject client versions.
 */
function createFakeTools(root, {
  npm = 'ok',
  npmVersion = null,
  npmStderr = '',
  npmError = null,
  npmContent = '// fake shared runtime\n',
  providerOk = true,
  initFails = false,
  hang = false,
} = {}) {
  const calls = [];
  const kills = [];
  let initFailure = initFails;

  const spawnFn = (command, args, options = {}) => {
    calls.push({ command, args: [...args], options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.exitCode = null;
    child.signalCode = null;
    let finished = false;
    const close = (code, signal) => {
      if (finished) return;
      finished = true;
      child.exitCode = code;
      child.signalCode = signal;
      child.emit('close', code, signal);
    };
    child.kill = (signal) => {
      kills.push(signal);
      if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        setImmediate(() => close(null, signal));
      }
      return true;
    };

    const run = async () => {
      const isNpm = args[0] === 'install' && args.includes('--prefix');
      if (isNpm) {
        if (hang) return null;
        if (npmError) throw npmError;
        if (npm === 'fail') return { code: 1, stderr: npmStderr };
        const prefix = args[args.indexOf('--prefix') + 1];
        const spec = args[args.length - 1];
        const requested = spec.slice(spec.lastIndexOf('@') + 1);
        await writeCore(prefix, npmVersion ?? requested, npmContent);
        return { code: 0 };
      }
      const cliPath = args[0];
      const commandName = args[1];
      if (commandName === 'init') {
        if (initFailure) return { code: 1, stderr: 'init failed' };
        const home = options.env?.MEBULAR_HOME ?? root;
        await mkdir(home, { recursive: true });
        await writeFile(join(home, 'config.json'), '{}\n', 'utf-8');
        return { code: 0, stdout: 'initialized\n' };
      }
      if (commandName === 'runtime' && args[2] === 'provider') {
        if (!providerOk) return { code: 2, stdout: JSON.stringify({ ok: false, reason: 'invalid_registry' }) };
        return {
          code: 0,
          stdout: JSON.stringify({
            ok: true,
            provider: { kind: 'shared', path: cliPath, version: RUNTIME_INSTALL_VERSION },
          }),
        };
      }
      if (commandName === 'runtime' && args[2] === 'resolve') {
        const home = options.env?.MEBULAR_HOME ?? root;
        return {
          code: 0,
          stdout: JSON.stringify({
            ok: true,
            mode: 'child',
            home,
            http: { scheme: 'http', host: '127.0.0.1', port: 9333 },
          }),
        };
      }
      return { code: 2, stdout: JSON.stringify({ ok: false, reason: 'unexpected_cli_command' }) };
    };

    Promise.resolve()
      .then(run)
      .then((result) => {
        if (result === null || finished) return;
        if (result.stdout) child.stdout.emit('data', Buffer.from(result.stdout));
        if (result.stderr) child.stderr.emit('data', Buffer.from(result.stderr));
        close(result.code ?? 0, null);
      })
      .catch((error) => child.emit('error', error));
    return child;
  };

  const npmCalls = () => calls.filter((call) => call.args[0] === 'install' && call.args.includes('--prefix'));
  const cliCalls = () => calls.filter((call) => call.command === process.execPath);
  const providerCalls = () => calls.filter((call) => call.args[2] === 'provider');
  const providerAdds = () => calls.filter((call) => call.args[2] === 'provider' && call.args[3] === 'add');
  const providerRemoves = () => calls.filter((call) => call.args[2] === 'provider' && call.args[3] === 'remove');
  const initCalls = () => calls.filter((call) => call.args[1] === 'init');
  return {
    calls,
    kills,
    spawnFn,
    npmCalls,
    cliCalls,
    providerCalls,
    providerAdds,
    providerRemoves,
    initCalls,
    failInit(value = true) {
      initFailure = value;
    },
  };
}

function managerFor(root, lifecycle, discover, tools, extra = {}) {
  return createRuntimeInstallManager({
    config: { bootstrap: 'prompt' },
    lifecycle,
    cloudRoot: root,
    env: {},
    userHome: root,
    platform: 'darwin',
    execPath: process.execPath,
    spawnFn: tools.spawnFn,
    discoverProviders: async () => discover(),
    detectService: async () => false,
    installTimeoutMs: 500,
    cliTimeoutMs: 500,
    installKillGraceMs: 10,
    ...extra,
  });
}

async function runtimeEntries(root) {
  try {
    return await readdir(join(root, 'runtime'));
  } catch {
    return [];
  }
}

async function expectCleanRuntimeDir(root) {
  const entries = await runtimeEntries(root);
  expect(entries.filter((entry) => entry.startsWith('.tmp-install-'))).toEqual([]);
  expect(entries).not.toContain('install.lock');
}

function request({ method = 'POST', remoteAddress = '127.0.0.1', body = null, contentType = 'application/json' } = {}) {
  return {
    method,
    body: body === null ? '' : typeof body === 'string' ? body : JSON.stringify(body),
    headers: contentType === null ? {} : { 'content-type': contentType },
    socket: { remoteAddress },
  };
}

function response() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
    },
    end(body) {
      this.body = body === undefined ? '' : String(body);
    },
  };
}

function fakeManager(overrides = {}) {
  const state = {
    state: 'installing',
    reason: null,
    detail: null,
    manualCommand: 'npm install -g @mebular/core@0.1.2',
    targetVersion: RUNTIME_INSTALL_VERSION,
    allowed: true,
    ...overrides.state,
  };
  return {
    startCalls: [],
    allowed: () => overrides.allowed !== false,
    denialReason: () => overrides.denialReason ?? null,
    start(action) {
      this.startCalls.push(action);
      return { accepted: true, state };
    },
    getState: () => state,
    dispose: async () => {},
  };
}

describe('Phase 4b install controller: explicit install only', () => {
  it('no provider + redetect: stays download_required, never runs npm/supervise/init', async () => {
    const root = await tempRoot();
    const lifecycle = createFakeLifecycle();
    const tools = createFakeTools(root);
    const manager = managerFor(root, lifecycle, () => discovery(null), tools);

    expect(tools.npmCalls()).toHaveLength(0);
    expect(manager.getState()).toMatchObject({ state: 'idle', allowed: true });

    const accepted = manager.start('redetect');
    expect(accepted.accepted).toBe(true);
    const state = await waitSettled(manager);

    expect(state).toMatchObject({ state: 'idle', reason: 'download_required' });
    expect(tools.npmCalls()).toHaveLength(0);
    expect(tools.providerCalls()).toHaveLength(0);
    expect(tools.initCalls()).toHaveLength(0);
    expect(lifecycle.calls).toHaveLength(0);
    expect(await runtimeEntries(root)).toEqual([]);
  });

  it('install -> validate -> provider -> init -> start, then reuse the healthy daemon', async () => {
    const root = await tempRoot();
    const lifecycle = createFakeLifecycle();
    const tools = createFakeTools(root);
    const manager = managerFor(root, lifecycle, () => discovery(null), tools);

    const accepted = manager.start('install');
    expect(accepted).toMatchObject({ accepted: true });
    expect(accepted.state).toMatchObject({ state: 'installing', targetVersion: RUNTIME_INSTALL_VERSION });

    const state = await waitSettled(manager);
    expect(state).toMatchObject({
      state: 'done',
      reason: null,
      installed: true,
      started: true,
      targetVersion: RUNTIME_INSTALL_VERSION,
      manualCommand: `npm install -g @mebular/core@${RUNTIME_INSTALL_VERSION}`,
    });
    expect(tools.npmCalls()).toHaveLength(1);
    expect(tools.npmCalls()[0].args).toEqual([
      'install',
      '--prefix',
      expect.stringContaining(join(root, 'runtime', '.tmp-install-')),
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      `@mebular/core@${RUNTIME_INSTALL_VERSION}`,
    ]);
    expect(tools.providerCalls()).toHaveLength(1);
    expect(tools.providerCalls()[0].args).toEqual(expect.arrayContaining([
      'provider', 'add', '--kind', 'shared', '--path', expect.stringContaining('mebular.mjs'),
      '--version', RUNTIME_INSTALL_VERSION, '--capabilities', 'serve',
    ]));
    expect(tools.initCalls()).toHaveLength(1);
    expect(lifecycle.calls).toEqual([{ restartOwned: false }]);
    expect(existsSync(join(root, 'runtime', RUNTIME_INSTALL_VERSION, 'node_modules', '@mebular', 'core', 'package.json'))).toBe(true);
    expect(existsSync(join(root, 'config.json'))).toBe(true);
    await expectCleanRuntimeDir(root);

    const again = manager.start('install');
    expect(again.accepted).toBe(true);
    const second = await waitSettled(manager);
    expect(second).toMatchObject({ state: 'done', reused: true });
    expect(tools.npmCalls()).toHaveLength(1);
    expect(lifecycle.calls).toHaveLength(1);
  });

  it('App/CLI/service already present: install only starts or attaches, never npm', async () => {
    for (const scenario of [
      { name: 'app provider', provider: provider('app'), service: false },
      { name: 'cli provider', provider: provider('cli', '/usr/local/bin/mebular'), service: false },
      { name: 'registered service', provider: null, service: true },
      { name: 'healthy daemon', provider: null, service: false, up: true },
    ]) {
      const root = await tempRoot();
      const lifecycle = createFakeLifecycle({
        status: scenario.up === true ? 'up' : 'down',
        discoveredProvider: scenario.provider,
        service: scenario.service,
      });
      const tools = createFakeTools(root);
      const manager = managerFor(root, lifecycle, () => discovery(scenario.provider), tools);

      manager.start('install');
      const state = await waitSettled(manager);
      expect(state.state).toBe('done');
      expect(tools.npmCalls()).toHaveLength(0);
      expect(tools.providerCalls()).toHaveLength(0);
      expect(tools.initCalls()).toHaveLength(0);
      expect(lifecycle.calls).toHaveLength(scenario.up === true ? 0 : 1);
    }
  });

  it('manual install + redetect discovers the new provider without downloading', async () => {
    const root = await tempRoot();
    const lifecycle = createFakeLifecycle();
    const tools = createFakeTools(root);
    let installed = null;
    const manager = managerFor(root, lifecycle, () => discovery(installed), tools);

    manager.start('redetect');
    expect(await waitSettled(manager)).toMatchObject({ state: 'idle', reason: 'download_required' });

    installed = provider('cli', '/usr/local/bin/mebular');
    manager.start('redetect');
    const state = await waitSettled(manager);
    expect(state).toMatchObject({ state: 'done', reused: true });
    expect(tools.npmCalls()).toHaveLength(0);
    expect(lifecycle.calls).toHaveLength(1);
  });
});

describe('Phase 4b install controller: terminal runtime conflicts block download', () => {
  const cases = [
    { state: 'profile_mismatch', reason: 'instance_mismatch', expected: 'instance_mismatch' },
    { state: 'service_conflict', reason: 'service_unknown', expected: 'service_unknown' },
    { state: 'version_mismatch', reason: 'version_mismatch', expected: 'version_mismatch' },
    { state: 'down', reason: 'port_in_use', expected: 'port_in_use' },
    { state: 'down', reason: 'CLOUD_ALREADY_ACTIVE', expected: 'CLOUD_ALREADY_ACTIVE' },
  ];

  for (const entry of cases) {
    it(`${entry.reason}: fails without npm, provider, init or start`, async () => {
      const root = await tempRoot();
      const lifecycle = createFakeLifecycle({ state: entry.state, reason: entry.reason });
      const tools = createFakeTools(root);
      const manager = managerFor(root, lifecycle, () => discovery(null), tools);

      manager.start('install');
      const state = await waitSettled(manager);

      expect(state).toMatchObject({ state: 'failed', reason: entry.expected, installed: false });
      expect(tools.npmCalls()).toHaveLength(0);
      expect(tools.providerCalls()).toHaveLength(0);
      expect(tools.initCalls()).toHaveLength(0);
      expect(lifecycle.calls).toHaveLength(0);
      expect(await runtimeEntries(root)).toEqual([]);
    });
  }
});

describe('Phase 4b install controller: failure mapping and recovery', () => {
  const cases = [
    { name: 'npm missing', options: { npmError: Object.assign(new Error('missing npm'), { code: 'ENOENT' }) }, reason: 'npm_missing' },
    { name: 'offline', options: { npm: 'fail', npmStderr: 'npm ERR! getaddrinfo ENOTFOUND registry.npmjs.org' }, reason: 'offline' },
    { name: 'registry unreachable', options: { npm: 'fail', npmStderr: 'npm ERR! request to https://registry.npmjs.org failed, reason ECONNREFUSED' }, reason: 'registry_unreachable' },
    { name: 'http 404', options: { npm: 'fail', npmStderr: 'npm ERR! code E404 404 Not Found - GET https://registry.npmjs.org/@mebular%2fcore' }, reason: 'http_error' },
    { name: 'permission denied', options: { npm: 'fail', npmStderr: 'npm ERR! EACCES: permission denied, mkdir' }, reason: 'permission_denied' },
    { name: 'disk full', options: { npm: 'fail', npmStderr: 'npm ERR! ENOSPC: no space left on device' }, reason: 'disk_full' },
    { name: 'integrity mismatch', options: { npmVersion: '9.9.9' }, reason: 'integrity_mismatch' },
  ];

  for (const entry of cases) {
    it(`${entry.name}: stable reason, manual command, no half-install/start`, async () => {
      const root = await tempRoot();
      const lifecycle = createFakeLifecycle();
      const tools = createFakeTools(root, entry.options);
      const manager = managerFor(root, lifecycle, () => discovery(null), tools);

      manager.start('install');
      const state = await waitSettled(manager);

      expect(state).toMatchObject({
        state: 'failed',
        reason: entry.reason,
        targetVersion: RUNTIME_INSTALL_VERSION,
        manualCommand: `npm install -g @mebular/core@${RUNTIME_INSTALL_VERSION}`,
      });
      expect(state.detail === null || typeof state.detail === 'string').toBe(true);
      expect(tools.providerCalls()).toHaveLength(0);
      expect(tools.initCalls()).toHaveLength(0);
      expect(lifecycle.calls).toHaveLength(0);
      expect(existsSync(join(root, 'runtime', RUNTIME_INSTALL_VERSION))).toBe(false);
      await expectCleanRuntimeDir(root);
    });
  }

  it('timeout/cancel: cancelled, child killed, no staging or lock', async () => {
    const root = await tempRoot();
    const lifecycle = createFakeLifecycle();
    const tools = createFakeTools(root, { hang: true });
    const manager = managerFor(root, lifecycle, () => discovery(null), tools, {
      installTimeoutMs: 30,
      installKillGraceMs: 0,
    });

    manager.start('install');
    const state = await waitSettled(manager);

    expect(state).toMatchObject({ state: 'failed', reason: 'cancelled' });
    expect(tools.kills.length).toBeGreaterThan(0);
    expect(lifecycle.calls).toHaveLength(0);
    await expectCleanRuntimeDir(root);
  });

  it('install lock held by a live process: install_locked without npm', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'runtime'), { recursive: true });
    await writeFile(join(root, 'runtime', 'install.lock'), JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      version: RUNTIME_INSTALL_VERSION,
    }), 'utf-8');
    const lifecycle = createFakeLifecycle();
    const tools = createFakeTools(root);
    const manager = managerFor(root, lifecycle, () => discovery(null), tools);

    manager.start('install');
    const state = await waitSettled(manager);
    expect(state).toMatchObject({ state: 'failed', reason: 'install_locked' });
    expect(tools.npmCalls()).toHaveLength(0);
    expect(lifecycle.calls).toHaveLength(0);
    expect(existsSync(join(root, 'runtime', RUNTIME_INSTALL_VERSION))).toBe(false);
  });

  it('init failure is retryable without reinstalling or overwriting identity', async () => {
    const root = await tempRoot();
    const lifecycle = createFakeLifecycle();
    const tools = createFakeTools(root, { initFails: true });
    const manager = managerFor(root, lifecycle, () => discovery(null), tools);

    manager.start('install');
    const failed = await waitSettled(manager);
    expect(failed).toMatchObject({ state: 'failed', reason: 'init_failed', installed: true });
    expect(tools.npmCalls()).toHaveLength(1);
    expect(tools.providerCalls()).toHaveLength(1);
    expect(lifecycle.calls).toHaveLength(0);

    tools.failInit(false);
    manager.start('retry');
    const retried = await waitSettled(manager);
    expect(retried.state).toBe('done');
    expect(tools.npmCalls()).toHaveLength(1);
    expect(tools.initCalls()).toHaveLength(2);
    expect(lifecycle.calls).toHaveLength(1);
  });

  it('start failure retries without another download', async () => {
    const root = await tempRoot();
    const lifecycle = createFakeLifecycle({ startStatus: 'down' });
    const tools = createFakeTools(root);
    const manager = managerFor(root, lifecycle, () => discovery(null), tools);

    manager.start('install');
    expect(await waitSettled(manager)).toMatchObject({ state: 'failed', reason: 'start_failed', installed: true });
    expect(tools.npmCalls()).toHaveLength(1);

    lifecycle.setStart('up');
    manager.start('retry');
    const retried = await waitSettled(manager);
    expect(retried.state).toBe('done');
    expect(tools.npmCalls()).toHaveLength(1);
    expect(lifecycle.calls).toHaveLength(2);
  });

  it('provider registration failure keeps the installed runtime but starts nothing', async () => {
    const root = await tempRoot();
    const lifecycle = createFakeLifecycle();
    const tools = createFakeTools(root, { providerOk: false });
    const manager = managerFor(root, lifecycle, () => discovery(null), tools);

    manager.start('install');
    const state = await waitSettled(manager);
    expect(state).toMatchObject({ state: 'failed', reason: 'provider_registration_failed', installed: true });
    expect(existsSync(join(root, 'runtime', RUNTIME_INSTALL_VERSION))).toBe(true);
    expect(tools.initCalls()).toHaveLength(0);
    expect(lifecycle.calls).toHaveLength(0);
  });

  it('failed reinstall preserves the old runtime, provider and start count', async () => {
    const root = await tempRoot();
    const lifecycle = createFakeLifecycle();
    const tools = createFakeTools(root, { npmContent: '// v1\n' });
    let selected = null;
    const manager = managerFor(root, lifecycle, () => discovery(selected), tools);

    manager.start('install');
    expect((await waitSettled(manager)).state).toBe('done');
    const marker = join(root, 'runtime', RUNTIME_INSTALL_VERSION, 'old-marker');
    await writeFile(marker, 'keep me', 'utf-8');
    selected = provider('shared', join(root, 'runtime', RUNTIME_INSTALL_VERSION, 'node_modules', '@mebular', 'core', 'packages', 'mcp', 'bin', 'mebular.mjs'));

    // A broken reinstall: the fake npm writes into staging then fails.
    const brokenRoot = root;
    const broken = managerFor(brokenRoot, lifecycle, () => discovery(selected), createFakeTools(root, {
      npm: 'fail',
      npmStderr: 'npm ERR! code E404 404 Not Found',
    }));
    broken.start('reinstall');
    const failed = await waitSettled(broken);
    expect(failed.state).toBe('failed');
    expect(failed.reason).toBe('http_error');

    expect(existsSync(marker)).toBe(true);
    const cli = await readFile(join(root, 'runtime', RUNTIME_INSTALL_VERSION, 'node_modules', '@mebular', 'core', 'packages', 'mcp', 'bin', 'mebular.mjs'), 'utf-8');
    expect(cli).toContain('// v1');
    expect(tools.providerCalls()).toHaveLength(1);
    expect(lifecycle.calls).toHaveLength(1);
    expect(await runtimeEntries(root)).not.toContain('install.lock');
  });

  it('successful reinstall restarts only an owned supervise and keeps the backup', async () => {
    const root = await tempRoot();
    const lifecycle = createFakeLifecycle();
    const first = createFakeTools(root, { npmContent: '// v1\n' });
    let selected = null;
    const manager = managerFor(root, lifecycle, () => discovery(selected), first);

    manager.start('install');
    expect((await waitSettled(manager)).state).toBe('done');
    selected = provider('shared', join(root, 'runtime', RUNTIME_INSTALL_VERSION, 'node_modules', '@mebular', 'core', 'packages', 'mcp', 'bin', 'mebular.mjs'));

    const second = createFakeTools(root, { npmContent: '// v2\n' });
    const reinstaller = managerFor(root, lifecycle, () => discovery(selected), second);
    reinstaller.start('reinstall');
    const done = await waitSettled(reinstaller);

    expect(done.state).toBe('done');
    expect(second.npmCalls()).toHaveLength(1);
    expect(lifecycle.calls).toEqual([
      { restartOwned: false },
      { restartOwned: true },
    ]);
    const cli = await readFile(join(root, 'runtime', RUNTIME_INSTALL_VERSION, 'node_modules', '@mebular', 'core', 'packages', 'mcp', 'bin', 'mebular.mjs'), 'utf-8');
    expect(cli).toContain('// v2');
    const entries = await runtimeEntries(root);
    expect(entries.some((entry) => entry.startsWith('.backup-'))).toBe(true);
    expect(entries).not.toContain('install.lock');
    expect(entries.filter((entry) => entry.startsWith('.tmp-install-'))).toEqual([]);
  });

  it('reinstall start failure restores old files/provider and restarts the owned daemon', async () => {
    const root = await tempRoot();
    const cliPath = join(root, 'runtime', RUNTIME_INSTALL_VERSION, 'node_modules', '@mebular', 'core', 'packages', 'mcp', 'bin', 'mebular.mjs');

    const first = createFakeTools(root, { npmContent: '// v1\n' });
    const firstManager = managerFor(root, createFakeLifecycle(), () => discovery(null), first);
    firstManager.start('install');
    expect((await waitSettled(firstManager)).state).toBe('done');
    const marker = join(root, 'runtime', RUNTIME_INSTALL_VERSION, 'old-marker');
    await writeFile(marker, 'keep me', 'utf-8');

    const lifecycleCalls = [];
    let state = {
      status: 'up',
      state: 'up',
      reason: null,
      managed: true,
      downloadRequired: false,
      service: { registered: false, running: false, foreign: false },
      provider: null,
    };
    const restartFailureLifecycle = {
      calls: lifecycleCalls,
      inspect: async () => ({ ...state }),
      startAfterInstall: async (options = {}) => {
        lifecycleCalls.push(options);
        if (options.restartOwned === true) {
          // The explicit reinstall stopped the owned supervise, then the new
          // runtime failed to become ready.
          state = {
            ...state,
            status: 'down',
            state: 'down',
            reason: 'managed_start_failed',
            managed: false,
            downloadRequired: true,
          };
        } else {
          state = { ...state, status: 'up', state: 'up', reason: null, managed: true, downloadRequired: false };
        }
        return { ...state };
      },
    };
    const selected = { kind: 'shared', path: cliPath, source: 'registry', version: '0.1.1' };
    const second = createFakeTools(root, { npmContent: '// v2\n' });
    const reinstaller = managerFor(root, restartFailureLifecycle, () => discovery(selected), second);

    reinstaller.start('reinstall');
    const failed = await waitSettled(reinstaller);

    expect(failed.state).toBe('failed');
    expect(failed.reason).toBe('start_failed');
    expect(failed.detail).toContain('previous_daemon_restarted');
    expect(lifecycleCalls).toEqual([{ restartOwned: true }, { restartOwned: false }]);
    expect(existsSync(marker)).toBe(true);
    const restored = await readFile(cliPath, 'utf-8');
    expect(restored).toContain('// v1');

    const adds = second.providerAdds();
    expect(adds).toHaveLength(2);
    expect(adds[0].args).toEqual(expect.arrayContaining(['--version', RUNTIME_INSTALL_VERSION]));
    expect(adds[1].args).toEqual(expect.arrayContaining(['--path', cliPath, '--version', '0.1.1']));
    expect(second.providerRemoves()).toHaveLength(0);
    await expectCleanRuntimeDir(root);
  });

  it('reinstall start failure removes the new provider path and re-registers the old one', async () => {
    const root = await tempRoot();
    const oldCli = join(root, 'old-runtime', 'mebular.mjs');
    await mkdir(join(root, 'old-runtime'), { recursive: true });
    await writeFile(oldCli, '// old runtime\n', 'utf-8');
    const newCli = join(root, 'runtime', RUNTIME_INSTALL_VERSION, 'node_modules', '@mebular', 'core', 'packages', 'mcp', 'bin', 'mebular.mjs');

    let state = {
      status: 'up',
      state: 'up',
      reason: null,
      managed: true,
      downloadRequired: false,
      service: { registered: false, running: false, foreign: false },
      provider: null,
    };
    const lifecycleCalls = [];
    const lifecycle = {
      calls: lifecycleCalls,
      inspect: async () => ({ ...state }),
      startAfterInstall: async (options = {}) => {
        lifecycleCalls.push(options);
        if (options.restartOwned === true) {
          state = {
            ...state,
            status: 'down',
            state: 'down',
            reason: 'managed_start_failed',
            managed: false,
            downloadRequired: true,
          };
        } else {
          state = { ...state, status: 'up', state: 'up', reason: null, managed: true };
        }
        return { ...state };
      },
    };
    const tools = createFakeTools(root, { npmContent: '// v2\n' });
    const manager = managerFor(
      root,
      lifecycle,
      () => discovery({ kind: 'shared', path: oldCli, source: 'registry', version: '0.1.1' }),
      tools,
    );

    manager.start('reinstall');
    const failed = await waitSettled(manager);

    expect(failed).toMatchObject({ state: 'failed', reason: 'start_failed' });
    expect(lifecycleCalls).toEqual([{ restartOwned: true }, { restartOwned: false }]);
    expect(existsSync(newCli)).toBe(true);
    expect(await readFile(oldCli, 'utf-8')).toContain('// old runtime');

    const adds = tools.providerAdds();
    expect(adds.map((call) => call.args[call.args.indexOf('--version') + 1])).toEqual(['0.1.2', '0.1.1']);
    expect(adds[1].args).toEqual(expect.arrayContaining(['--path', oldCli]));
    const removes = tools.providerRemoves();
    expect(removes.map((call) => call.args[call.args.indexOf('--path') + 1])).toEqual([oldCli, newCli]);
    expect(await runtimeEntries(root)).toContain('0.1.2');
  });

  it('reinstall recovery failure is reported when the old daemon cannot be restarted', async () => {
    const root = await tempRoot();
    const cliPath = join(root, 'runtime', RUNTIME_INSTALL_VERSION, 'node_modules', '@mebular', 'core', 'packages', 'mcp', 'bin', 'mebular.mjs');
    const first = createFakeTools(root, { npmContent: '// v1\n' });
    const firstManager = managerFor(root, createFakeLifecycle(), () => discovery(null), first);
    firstManager.start('install');
    expect((await waitSettled(firstManager)).state).toBe('done');

    let state = {
      status: 'up',
      state: 'up',
      reason: null,
      managed: true,
      downloadRequired: false,
      service: { registered: false, running: false, foreign: false },
      provider: null,
    };
    const lifecycle = {
      calls: [],
      inspect: async () => ({ ...state }),
      startAfterInstall: async (options = {}) => {
        lifecycle.calls.push(options);
        state = {
          ...state,
          status: 'down',
          state: 'down',
          reason: 'managed_start_failed',
          managed: false,
          downloadRequired: true,
        };
        return { ...state };
      },
    };
    const tools = createFakeTools(root, { npmContent: '// v2\n' });
    const manager = managerFor(
      root,
      lifecycle,
      () => discovery({ kind: 'shared', path: cliPath, source: 'registry', version: '0.1.1' }),
      tools,
    );

    manager.start('reinstall');
    const failed = await waitSettled(manager);

    expect(failed.state).toBe('failed');
    expect(failed.reason).toBe('start_failed');
    expect(failed.detail).toContain('previous_daemon_restart_failed');
    expect(lifecycle.calls).toEqual([{ restartOwned: true }, { restartOwned: false }]);
  });

  it('service registration is attached, not reinstalled or restarted', async () => {
    const root = await tempRoot();
    const lifecycle = createFakeLifecycle({ service: true, startStatus: 'up' });
    const tools = createFakeTools(root);
    const manager = managerFor(root, lifecycle, () => discovery(provider('shared', '/opt/mebular/bin/mebular.mjs')), tools);

    manager.start('reinstall');
    const state = await waitSettled(manager);

    expect(state.state).toBe('done');
    expect(tools.npmCalls()).toHaveLength(0);
    expect(lifecycle.calls).toEqual([{ restartOwned: false }]);
  });

  it('repeated clicks are single-flight: one npm install, one start', async () => {
    const root = await tempRoot();
    const lifecycle = createFakeLifecycle();
    const tools = createFakeTools(root, { hang: true });
    const manager = managerFor(root, lifecycle, () => discovery(null), tools, {
      installTimeoutMs: 200,
      installKillGraceMs: 0,
    });

    const first = manager.start('install');
    await waitFor(() => tools.npmCalls().length === 1);
    const startedAt = manager.getState().startedAt;
    const second = manager.start('install');
    const third = manager.start('reinstall');

    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(false);
    expect(third.accepted).toBe(false);
    expect(manager.getState().startedAt).toBe(startedAt);
    expect(tools.npmCalls()).toHaveLength(1);
    expect(lifecycle.calls).toHaveLength(0);

    await manager.dispose();
    await waitSettled(manager);
  });

  it('dispose during install cancels and leaves no staging/lock/child', async () => {
    const root = await tempRoot();
    const lifecycle = createFakeLifecycle();
    const tools = createFakeTools(root, { hang: true });
    const manager = managerFor(root, lifecycle, () => discovery(null), tools, {
      installTimeoutMs: 5000,
      installKillGraceMs: 0,
    });

    manager.start('install');
    await waitFor(() => tools.npmCalls().length === 1);
    await manager.dispose();
    const state = manager.getState();
    expect(state).toMatchObject({ state: 'failed', reason: 'cancelled' });
    expect(tools.kills.length).toBeGreaterThan(0);
    expect(lifecycle.calls).toHaveLength(0);
    await expectCleanRuntimeDir(root);
  });
});

describe('Phase 4b install route: loopback-only explicit POST', () => {
  const config = { bootstrap: 'prompt' };

  it('POST JSON returns 202 and accepts only the single documented action', async () => {
    const manager = fakeManager();
    const handler = createRuntimeInstallHandler({ config, manager });

    for (const action of ['install', 'retry', 'reinstall', 'redetect']) {
      const res = response();
      await handler(request({ body: { action } }), res);
      expect(res.statusCode).toBe(202);
      expect(JSON.parse(res.body)).toMatchObject({ ok: true, accepted: true, action });
    }
    const empty = response();
    await handler(request(), empty);
    expect(empty.statusCode).toBe(400);
    expect(JSON.parse(empty.body).error).toBe('invalid_json');
  });

  it('requires application/json even for an empty body; explicit {} installs once', async () => {
    const manager = fakeManager();
    const handler = createRuntimeInstallHandler({ config, manager });

    for (const options of [
      { body: null, contentType: null },
      { body: null, contentType: 'text/plain' },
      { body: null, contentType: 'application/x-www-form-urlencoded' },
    ]) {
      const res = response();
      await handler(request(options), res);
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe('invalid_content_type');
    }
    expect(manager.startCalls).toHaveLength(0);

    const emptyJson = response();
    await handler(request(), emptyJson);
    expect(emptyJson.statusCode).toBe(400);
    expect(JSON.parse(emptyJson.body).error).toBe('invalid_json');
    expect(manager.startCalls).toHaveLength(0);

    const json = response();
    await handler(request({ body: {} }), json);
    expect(json.statusCode).toBe(202);
    expect(JSON.parse(json.body)).toMatchObject({ ok: true, accepted: true, action: 'install' });
    expect(manager.startCalls).toEqual(['install']);
  });

  it('remote peers get 404 for every method; loopback non-POST gets 405', async () => {
    const handler = createRuntimeInstallHandler({ config, manager: fakeManager() });
    for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
      const res = response();
      await handler(request({ method, remoteAddress: '10.0.0.5' }), res);
      expect(res.statusCode).toBe(404);
      expect(res.body).toBe('');
    }
    const res = response();
    await handler(request({ method: 'GET' }), res);
    expect(res.statusCode).toBe(405);
    expect(res.headers.allow).toBe('POST');
  });

  it('rejects arbitrary version/url/registry and malformed bodies', async () => {
    const manager = fakeManager();
    const handler = createRuntimeInstallHandler({ config, manager });
    for (const body of [
      { version: '9.9.9' },
      { url: 'https://example.com/runtime.tgz' },
      { registry: 'https://evil.test' },
      { action: 'install', tarball: '/tmp/x' },
      { action: 'latest' },
      { action: 42 },
    ]) {
      const res = response();
      await handler(request({ body }), res);
      expect(res.statusCode).toBe(400);
      expect(manager.startCalls).toHaveLength(0);
    }
    const wrongType = response();
    await handler(request({ body: { action: 'install' }, contentType: 'text/plain' }), wrongType);
    expect(wrongType.statusCode).toBe(400);
    const invalidJson = response();
    await handler(request({ body: '{not json' }), invalidJson);
    expect(invalidJson.statusCode).toBe(400);
  });

  it('bootstrap:never / runtime:external / pinned URL are denied without running anything', async () => {
    for (const [managerConfig, reason] of [
      [{ bootstrap: 'never' }, 'bootstrap_never'],
      [{ bootstrap: 'prompt', runtime: 'external' }, 'runtime_external'],
      [{ daemonUrl: 'http://127.0.0.1:9999' }, 'daemon_url_pinned'],
    ]) {
      const root = await tempRoot();
      const lifecycle = createFakeLifecycle();
      const tools = createFakeTools(root);
      const manager = createRuntimeInstallManager({
        config: managerConfig,
        lifecycle,
        cloudRoot: root,
        env: {},
        userHome: root,
        spawnFn: tools.spawnFn,
        discoverProviders: async () => discovery(null),
        detectService: async () => false,
      });
      const handler = createRuntimeInstallHandler({ config: managerConfig, manager });
      const res = response();
      await handler(request({ body: { action: 'install' } }), res);
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body)).toMatchObject({ error: 'install_not_allowed', reason });
      expect(manager.getState().state).toBe('idle');
      expect(tools.npmCalls()).toHaveLength(0);
      expect(lifecycle.calls).toHaveLength(0);
    }
  });

  it('two POSTs during one install return 202 and start a single flow', async () => {
    const root = await tempRoot();
    const lifecycle = createFakeLifecycle();
    const tools = createFakeTools(root, { hang: true });
    const manager = managerFor(root, lifecycle, () => discovery(null), tools, {
      installTimeoutMs: 300,
      installKillGraceMs: 0,
    });
    const handler = createRuntimeInstallHandler({ config, manager });

    const first = response();
    await handler(request({ body: { action: 'install' } }), first);
    await waitFor(() => tools.npmCalls().length === 1);
    const startedAt = JSON.parse(first.body).install.startedAt;
    const second = response();
    await handler(request({ body: { action: 'install' } }), second);

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(JSON.parse(second.body)).toMatchObject({ ok: true, accepted: false });
    expect(JSON.parse(second.body).install.startedAt).toBe(startedAt);
    expect(tools.npmCalls()).toHaveLength(1);
    await manager.dispose();
  });
});

describe('Phase 4b embed-info contract', () => {
  it('exposes only non-sensitive install state', () => {
    const info = buildEmbedInfo({
      daemonUrl: 'http://127.0.0.1:7331',
      reachable: false,
      install: {
        state: 'failed',
        reason: 'offline',
        detail: 'registry unreachable',
        manualCommand: 'npm install -g @mebular/core@0.1.2',
        targetVersion: '0.1.2',
        startedAt: '2026-01-01T00:00:00.000Z',
        finishedAt: '2026-01-01T00:01:00.000Z',
        allowed: true,
        token: 'secret',
        home: '/Users/me/.mebular',
      },
    });
    expect(info.install).toEqual({
      state: 'failed',
      reason: 'offline',
      detail: 'registry unreachable',
      manualCommand: 'npm install -g @mebular/core@0.1.2',
      targetVersion: '0.1.2',
      action: null,
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:01:00.000Z',
      reused: false,
      installed: false,
      started: false,
      allowed: true,
    });
    expect(JSON.stringify(info)).not.toContain('secret');
    expect(JSON.stringify(info)).not.toContain('/Users/me');
  });

  it('sanitizes unknown states/reasons and defaults to idle', () => {
    expect(sanitizeRuntimeInstallState({ state: 'evil', reason: 'token=abc', allowed: 'yes' })).toMatchObject({
      state: 'idle',
      reason: null,
      allowed: false,
    });
  });
});

describe('Phase 4b fixed npm command and classifier', () => {
  it('builds the frozen argv; Windows npm.cmd is the only shell', () => {
    const posix = buildRuntimeInstallCommand({ version: '0.1.2', prefix: '/tmp/prefix', platform: 'darwin' });
    expect(posix).toMatchObject({
      command: 'npm',
      shell: false,
      args: ['install', '--prefix', '/tmp/prefix', '--ignore-scripts', '--no-audit', '--no-fund', '@mebular/core@0.1.2'],
    });
    const win = buildRuntimeInstallCommand({ version: '0.1.2', prefix: 'C:\\tmp\\p', platform: 'win32' });
    expect(win).toMatchObject({ command: 'npm.cmd', shell: true });
  });

  it('classifies stable reasons without leaking secrets', () => {
    const classified = classifyRuntimeInstallFailure({
      exitCode: 1,
      stderr: 'npm ERR! code E404 404 Not Found token=abc123',
    });
    expect(classified.reason).toBe('http_error');
    expect(classified.detail).not.toContain('abc123');
  });
});

describe('Phase 4b lifecycle: explicit startAfterInstall/retry', () => {
  function resolveDoc(port = 9333) {
    return {
      ok: true,
      mode: 'child',
      http: { scheme: 'http', host: '127.0.0.1', port },
      instance: 'instance-test',
      version: '0.1.2',
      profileId: 'work',
      profile: { id: 'work', name: 'Work' },
      service: { registered: false, running: false, foreign: false },
      providers: { selected: { kind: 'cli', source: 'path', version: '0.1.2' } },
    };
  }

  function supervise(readyDoc) {
    let resolveExit;
    const exited = new Promise((resolvePromise) => { resolveExit = resolvePromise; });
    const handle = {
      stopCalls: 0,
      ready: Promise.resolve({ ok: true, data: readyDoc }),
      exited,
      getState: () => ({ exited: false }),
      stop: async () => {
        handle.stopCalls += 1;
        resolveExit({ code: 0, signal: null });
        return { stopped: true, reason: null };
      },
    };
    return handle;
  }

  it('attach never starts on activation; startAfterInstall starts once and dispose stops only it', async () => {
    let healthy = false;
    const handles = [];
    const lifecycle = createDaemonLifecycle({
      config: { lifecycle: 'attach', bootstrap: 'prompt' },
      env: {},
      discoverProviders: async () => discovery(provider('cli', '/opt/mebular/bin/mebular.mjs')),
      runResolve: async () => ({ ok: true, data: healthy ? { ...resolveDoc(), mode: 'reused' } : resolveDoc() }),
      startSupervise: () => {
        healthy = true;
        const handle = supervise(resolveDoc());
        handles.push(handle);
        return handle;
      },
      probe: async () => ({
        reachable: healthy,
        health: healthy ? HEALTH : null,
        embed: healthy ? EMBED : null,
      }),
      startTimeoutMs: 500,
      pollIntervalMs: 5,
      cacheTtlMs: 0,
    });

    const attached = await lifecycle.start();
    expect(attached.status).toBe('down');
    expect(handles).toHaveLength(0);

    const started = await lifecycle.startAfterInstall();
    expect(started).toMatchObject({ status: 'up', managed: true });
    expect(handles).toHaveLength(1);

    const again = await lifecycle.startAfterInstall();
    expect(again.status).toBe('up');
    expect(handles).toHaveLength(1);

    await lifecycle.dispose();
    expect(handles[0].stopCalls).toBe(1);
  });

  it('concurrent explicit starts are single-flight', async () => {
    let healthy = false;
    let starts = 0;
    const lifecycle = createDaemonLifecycle({
      config: { lifecycle: 'attach' },
      env: {},
      discoverProviders: async () => discovery(provider('cli', '/opt/mebular/bin/mebular.mjs')),
      runResolve: async () => ({ ok: true, data: healthy ? { ...resolveDoc(), mode: 'reused' } : resolveDoc() }),
      startSupervise: () => {
        starts += 1;
        healthy = true;
        return supervise(resolveDoc());
      },
      probe: async () => ({ reachable: healthy, health: healthy ? HEALTH : null, embed: healthy ? EMBED : null }),
      startTimeoutMs: 500,
      pollIntervalMs: 5,
      cacheTtlMs: 0,
    });

    const [first, second] = await Promise.all([
      lifecycle.startAfterInstall(),
      lifecycle.startAfterInstall(),
    ]);
    expect(first.status).toBe('up');
    expect(second.status).toBe('up');
    expect(starts).toBe(1);
    await lifecycle.dispose();
  });

  it('restartOwned stops only the owned supervise before starting the replaced runtime', async () => {
    let healthy = false;
    const handles = [];
    const lifecycle = createDaemonLifecycle({
      config: { lifecycle: 'attach' },
      env: {},
      discoverProviders: async () => discovery(provider('shared', '/opt/mebular/bin/mebular.mjs')),
      runResolve: async () => ({ ok: true, data: healthy ? { ...resolveDoc(), mode: 'reused' } : resolveDoc() }),
      startSupervise: () => {
        healthy = true;
        const handle = supervise(resolveDoc());
        handles.push(handle);
        return handle;
      },
      probe: async () => ({ reachable: healthy, health: healthy ? HEALTH : null, embed: healthy ? EMBED : null }),
      startTimeoutMs: 500,
      pollIntervalMs: 5,
      cacheTtlMs: 0,
    });

    await lifecycle.startAfterInstall();
    expect(handles).toHaveLength(1);
    healthy = false;
    await lifecycle.startAfterInstall({ restartOwned: true });
    expect(handles).toHaveLength(2);
    expect(handles[0].stopCalls).toBe(1);
    await lifecycle.dispose();
    expect(handles[1].stopCalls).toBe(1);
  });

  it('restartOwned never stops or restarts an external healthy daemon', async () => {
    let starts = 0;
    const lifecycle = createDaemonLifecycle({
      config: { lifecycle: 'attach' },
      env: {},
      discoverProviders: async () => discovery(provider('shared', '/opt/mebular/bin/mebular.mjs')),
      runResolve: async () => ({ ok: true, data: { ...resolveDoc(), mode: 'reused' } }),
      startSupervise: () => {
        starts += 1;
        return supervise(resolveDoc());
      },
      probe: async () => ({ reachable: true, health: HEALTH, embed: EMBED }),
      startTimeoutMs: 200,
      pollIntervalMs: 5,
      cacheTtlMs: 0,
    });

    const state = await lifecycle.startAfterInstall({ restartOwned: true });
    expect(state).toMatchObject({ status: 'up', managed: false });
    expect(starts).toBe(0);
    await lifecycle.dispose();
  });

  it('retry re-inspects an attach-only lifecycle without starting', async () => {
    let probes = 0;
    const lifecycle = createDaemonLifecycle({
      config: { lifecycle: 'attach' },
      env: {},
      discoverProviders: async () => discovery(null),
      probe: async () => {
        probes += 1;
        return { reachable: false, health: null, embed: null };
      },
      cacheTtlMs: 0,
    });
    await lifecycle.start();
    const before = probes;
    const state = await lifecycle.retry();
    expect(state.status).toBe('down');
    expect(probes).toBeGreaterThan(before);
    await lifecycle.dispose();
  });
});
