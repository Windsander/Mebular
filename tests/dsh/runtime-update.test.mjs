// Phase 5b2b · DSH plugin shared runtime update/upgrade flow.
//
// Offline and deterministic: every CLI child is a fake EventEmitter, the
// lifecycle/manager get injected checks/probes, and no daemon, service or npm
// is started. Covers shared prompted/skip state, the explicit loopback upgrade
// route, own-child vs service ownership, busy lock handling and client views.

import { describe, it, expect } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import {
  RUNTIME_UPGRADE_PATH,
  buildEmbedInfo,
  createDaemonLifecycle,
  createEmbedInfoHandler,
  createRuntimeUpgradeHandler,
  createRuntimeUpgradeManager,
  sanitizeRuntimeUpdateState,
  sanitizeRuntimeUpgradeState,
} from '../../packages/dsh-plugin/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const clientPath = join(here, '..', '..', 'packages', 'dsh-plugin', 'client.js');
const clientSource = readFileSync(clientPath, 'utf-8');

const PROVIDER = {
  kind: 'shared',
  path: '/opt/mebular/runtime/0.1.2/node_modules/@mebular/core/packages/mcp/bin/mebular.mjs',
  source: 'current',
  version: '0.1.2',
};

const CHECK_AVAILABLE = {
  ok: true,
  action: 'check-update',
  status: 'update_available',
  decision: 'update_available',
  available: true,
  skipped: false,
  prompted: false,
  promptedVersion: null,
  promptedAt: null,
  currentVersion: '0.1.2',
  latestVersion: '0.2.0',
  checkedAt: '2026-10-26T00:00:00.000Z',
};

const CHECK_PROMPTED = {
  ...CHECK_AVAILABLE,
  prompted: true,
  promptedVersion: '0.2.0',
  promptedAt: '2026-10-26T00:01:00.000Z',
};

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  return child;
}

/**
 * Fake `mebular` CLI. Each handler receives the runtime args after the CLI path
 * (e.g. ['runtime','upgrade','--to','latest','--json']) and returns
 * `{ code, stdout }`.
 */
function fakeCli(handlers = {}) {
  const calls = [];
  const spawnFn = (command, args) => {
    calls.push({ command, args: [...args] });
    const child = fakeChild();
    const runtimeArgs = args.slice(1);
    const key = runtimeArgs.slice(1).join(' ');
    let result = { code: 0, stdout: '{}' };
    try {
      if (typeof handlers.default === 'function') result = handlers.default(runtimeArgs) ?? result;
      for (const [match, handler] of Object.entries(handlers)) {
        if (match === 'default') continue;
        if (key.startsWith(match)) {
          result = typeof handler === 'function' ? (handler(runtimeArgs) ?? result) : handler;
          break;
        }
      }
    } catch (error) {
      result = { code: 1, stderr: String(error?.message ?? error) };
    }
    setImmediate(() => {
      if (result.stdout) child.stdout.emit('data', Buffer.from(result.stdout));
      if (result.stderr) child.stderr.emit('data', Buffer.from(result.stderr));
      child.emit('close', result.code ?? 0, result.signal ?? null);
    });
    return child;
  };
  return { calls, spawnFn, runtimeCalls: () => calls.map((call) => call.args.slice(1)) };
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('waitFor timed out');
}

function fakeHttpReq({ method = 'GET', remoteAddress = '127.0.0.1' } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.socket = { remoteAddress };
  req.headers = {};
  setImmediate(() => req.emit('end'));
  return req;
}

function fakeHttpRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
    end(value) {
      try {
        this.body = value ? JSON.parse(value) : null;
      } catch {
        this.body = value;
      }
    },
  };
}

function lifecycleHarness(overrides = {}) {
  const warnings = [];
  const calls = { discovery: 0, checks: [], prompted: [], probes: [] };
  const lifecycle = createDaemonLifecycle({
    config: { lifecycle: 'attach', runtime: 'auto', persistence: 'child', bootstrap: 'prompt' },
    logger: { warn: (message) => warnings.push(message), info: () => {} },
    discoverProviders: async () => {
      calls.discovery += 1;
      return { cloudRoot: '/root', providers: [PROVIDER], selected: PROVIDER, warnings: [] };
    },
    exists: (file) => file === PROVIDER.path,
    runResolve: async () => ({ ok: true, data: { ok: true, mode: 'reused', version: '0.1.2' } }),
    probe: async ({ daemonUrl }) => {
      calls.probes.push(daemonUrl);
      return { reachable: false, health: null, embed: null };
    },
    cacheTtlMs: 0,
    runUpdateCheck: async (context) => {
      calls.checks.push(context);
      return { ok: true, data: overrides.check ?? CHECK_AVAILABLE };
    },
    ...overrides.options,
  });
  return { lifecycle, calls, warnings };
}

describe('DSH lifecycle shared update check', () => {
  it('无 provider/CLI：不 check、不提示、不阻塞 start', async () => {
    let checks = 0;
    const lifecycle = createDaemonLifecycle({
      config: { lifecycle: 'attach', bootstrap: 'prompt' },
      discoverProviders: async () => ({ cloudRoot: '/root', providers: [], selected: null, warnings: [] }),
      probe: async () => ({ reachable: false, health: null, embed: null }),
      exists: () => false,
      runUpdateCheck: async () => { checks += 1; return { ok: true, data: CHECK_AVAILABLE }; },
      cacheTtlMs: 0,
    });
    await lifecycle.start();
    await waitFor(() => lifecycle.getState().update.state === 'disabled');
    expect(checks).toBe(0);
    const view = lifecycle.presentUpdate();
    expect(view).toMatchObject({ available: false, show: false, manual: false });
  });

  it('GET/presentUpdate 只读：check 有更新时返回 auto/show/manual，但从不写 prompted', async () => {
    const harness = lifecycleHarness();
    await harness.lifecycle.start();
    await waitFor(() => harness.lifecycle.getState().update.state === 'available');

    const view = harness.lifecycle.presentUpdate();
    expect(view).toMatchObject({
      state: 'available',
      currentVersion: '0.1.2',
      latestVersion: '0.2.0',
      available: true,
      skipped: false,
      prompted: false,
      show: true,
      auto: true,
      manual: true,
    });

    const handler = createEmbedInfoHandler({
      config: { lifecycle: 'attach' },
      lifecycle: harness.lifecycle,
    });
    const first = fakeHttpRes();
    await handler(fakeHttpReq({ method: 'GET' }), first);
    const second = fakeHttpRes();
    await handler(fakeHttpReq({ method: 'GET' }), second);
    expect(first.body.update).toMatchObject({
      available: true,
      prompted: false,
      show: true,
      auto: true,
      manual: true,
    });
    expect(second.body.update).toMatchObject({ auto: true });
    expect(first.body.update).not.toHaveProperty('token');

    // Sidebar/embed-info polling never persists prompted; no CLI write happened.
    expect(harness.calls.prompted).toHaveLength(0);
    expect(harness.calls.checks).toHaveLength(1);
    expect(harness.lifecycle.getState().update.prompted).toBe(false);
  });

  it('显式 prompted 确认后：本会话保持 banner，其他入口不再自动弹，手动更新保留', async () => {
    const harness = lifecycleHarness();
    await harness.lifecycle.start();
    await waitFor(() => harness.lifecycle.getState().update.state === 'available');
    expect(harness.lifecycle.presentUpdate()).toMatchObject({ show: true, auto: true, prompted: false });

    harness.lifecycle.markUpdatePrompted('0.2.0');
    const confirmed = harness.lifecycle.presentUpdate();
    expect(confirmed).toMatchObject({
      available: true,
      prompted: true,
      promptedVersion: '0.2.0',
      show: true,
      auto: false,
      manual: true,
    });

    const handler = createEmbedInfoHandler({
      config: { lifecycle: 'attach' },
      lifecycle: harness.lifecycle,
    });
    const res = fakeHttpRes();
    await handler(fakeHttpReq({ method: 'GET' }), res);
    expect(res.body.update).toMatchObject({
      prompted: true,
      promptedVersion: '0.2.0',
      show: true,
      auto: false,
      manual: true,
    });
    expect(harness.calls.prompted).toHaveLength(0);
  });

  it('共享 promptedVersion 已存在：不自动弹，但保留手动更新入口', async () => {
    const harness = lifecycleHarness({ check: CHECK_PROMPTED });
    await harness.lifecycle.start();
    await waitFor(() => harness.lifecycle.getState().update.state === 'available');
    const view = harness.lifecycle.presentUpdate();
    expect(view).toMatchObject({
      available: true,
      prompted: true,
      show: false,
      auto: false,
      manual: true,
    });
    expect(harness.calls.prompted).toHaveLength(0);
  });

  it('skip：embed-info 只暴露 skipped，不显示 banner/手动更新', async () => {
    const harness = lifecycleHarness({
      check: { ...CHECK_AVAILABLE, available: false, skipped: true, reason: 'skipped' },
    });
    await harness.lifecycle.start();
    await waitFor(() => harness.lifecycle.getState().update.state === 'skipped');
    expect(harness.lifecycle.presentUpdate()).toMatchObject({
      available: false,
      skipped: true,
      show: false,
      manual: false,
    });
  });

  it('离线/HTTP/busy：静默，不提示；check 不阻塞 start', async () => {
    for (const check of [
      { ok: false, status: 'offline', reason: 'offline' },
      { ok: false, status: 'http_error', reason: 'http_error' },
      { ok: true, status: 'busy', decision: null, available: false, latestVersion: '0.2.0', reason: 'busy' },
    ]) {
      const harness = lifecycleHarness({ check });
      await harness.lifecycle.start();
      await waitFor(() => ['unknown', 'idle'].includes(harness.lifecycle.getState().update.state));
      expect(harness.lifecycle.presentUpdate()).toMatchObject({ show: false, manual: false });
      expect(harness.calls.prompted).toHaveLength(0);
    }

    let releaseCheck;
    const gate = new Promise((resolve) => { releaseCheck = resolve; });
    const slow = createDaemonLifecycle({
      config: { lifecycle: 'attach', bootstrap: 'prompt' },
      discoverProviders: async () => ({ cloudRoot: '/root', providers: [PROVIDER], selected: PROVIDER, warnings: [] }),
      exists: () => true,
      runResolve: async () => ({ ok: true, data: { ok: true, mode: 'reused' } }),
      probe: async () => ({ reachable: false, health: null, embed: null }),
      cacheTtlMs: 0,
      runUpdateCheck: async () => {
        await gate;
        return { ok: true, data: CHECK_AVAILABLE };
      },
    });
    await Promise.race([
      slow.start(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('start blocked')), 200)),
    ]);
    expect(slow.getState().update.state).toBe('idle');
    releaseCheck();
    await waitFor(() => slow.getState().update.state === 'available');
    await slow.dispose();
  });
});

describe('DSH explicit runtime upgrade manager', () => {
  function managerHarness({
    snapshot = { status: 'up', managed: false, runtimeMode: 'reused', service: { registered: false } },
    cli,
    check = CHECK_AVAILABLE,
    options = {},
  } = {}) {
    const calls = { inspect: 0, stop: 0, startAfterInstall: [], refresh: 0, refreshUpdate: 0, markPrompted: [] };
    const lifecycle = {
      inspect: async () => {
        calls.inspect += 1;
        return snapshot;
      },
      stopOwnedChild: async () => {
        calls.stop += 1;
        return { stopped: true, stoppedOwned: true, runtimeMode: 'child' };
      },
      startAfterInstall: async (opts) => {
        calls.startAfterInstall.push(opts ?? null);
        return { status: 'up', reason: null, service: snapshot.service };
      },
      refresh: async () => {
        calls.refresh += 1;
        return { status: 'up', reason: null };
      },
      refreshUpdate: async () => { calls.refreshUpdate += 1; },
      markUpdatePrompted: (version) => { calls.markPrompted.push(version); },
    };
    const tools = cli ?? fakeCli({
      'check-update': () => ({ code: 0, stdout: JSON.stringify(check) }),
      'upgrade-state show': () => ({ code: 0, stdout: JSON.stringify({ ok: true, lock: { busy: false } }) }),
      upgrade: () => ({
        code: 0,
        stdout: JSON.stringify({
          ok: true,
          action: 'upgrade',
          to: '0.2.0',
          version: '0.2.0',
          previousCurrent: { version: '0.1.2' },
          runtimeChanged: true,
          serviceChanged: true,
        }),
      }),
    });
    const manager = createRuntimeUpgradeManager({
      config: { lifecycle: 'attach', runtime: 'auto', persistence: 'child' },
      lifecycle,
      cloudRoot: '/root',
      discoverProviders: async () => ({ cloudRoot: '/root', providers: [PROVIDER], selected: PROVIDER, warnings: [] }),
      exists: (file) => file === PROVIDER.path,
      spawnFn: tools.spawnFn,
      sleep: async () => {},
      upgradePollMs: 0,
      reconnectTimeoutMs: 20,
      ...options,
    });
    return { manager, lifecycle, calls, tools };
  }

  it('child：只停自己托管的 supervise，固定升级到 latest，成功后重启并 reconnect', async () => {
    const { manager, calls, tools } = managerHarness({
      snapshot: { status: 'up', managed: true, runtimeMode: 'child', service: { registered: false } },
    });
    const started = manager.start('update');
    expect(started.accepted).toBe(true);
    expect(started.state).toMatchObject({ state: 'updating', reason: 'provisioning', action: 'update' });
    await waitFor(() => manager.getState().state === 'done');

    expect(calls.stop).toBe(1);
    const runtimeCalls = tools.runtimeCalls();
    expect(runtimeCalls).toContainEqual(['runtime', 'upgrade', '--to', 'latest', '--json']);
    expect(runtimeCalls.some((args) => args.includes('0.2.0') && args.includes('upgrade'))).toBe(false);
    expect(calls.startAfterInstall).toEqual([{ restartOwned: true }]);
    expect(manager.getState()).toMatchObject({
      state: 'done',
      fromVersion: '0.1.2',
      toVersion: '0.2.0',
      reason: null,
      allowed: true,
    });
  });

  it('service：不杀外部 daemon，走共享 upgrade 更新 service 后重新 attach', async () => {
    const { manager, calls, tools } = managerHarness({
      snapshot: { status: 'up', managed: false, runtimeMode: 'service', service: { registered: true, running: true } },
    });
    manager.start('update');
    await waitFor(() => manager.getState().state === 'done');
    expect(calls.stop).toBe(0);
    expect(tools.runtimeCalls()).toContainEqual(['runtime', 'upgrade', '--to', 'latest', '--json']);
    expect(calls.startAfterInstall).toEqual([{ restartOwned: false }]);
  });

  it('失败：保留稳定 reason，并恢复旧 daemon/supervise，不重复升级', async () => {
    const tools = fakeCli({
      'check-update': () => ({ code: 0, stdout: JSON.stringify(CHECK_AVAILABLE) }),
      'upgrade-state show': () => ({ code: 0, stdout: JSON.stringify({ ok: true, lock: { busy: false } }) }),
      upgrade: () => ({ code: 2, stdout: JSON.stringify({ ok: false, reason: 'service_upgrade_failed', message: 'service failed' }) }),
    });
    const { manager, calls } = managerHarness({
      snapshot: { status: 'up', managed: true, runtimeMode: 'child', service: { registered: false } },
      cli: tools,
    });
    manager.start('update');
    await waitFor(() => manager.getState().state === 'failed');
    expect(manager.getState()).toMatchObject({ state: 'failed', reason: 'service_upgrade_failed' });
    expect(calls.stop).toBe(1);
    expect(calls.startAfterInstall).toEqual([{ restartOwned: true }]);
    expect(tools.runtimeCalls().filter((args) => args.includes('upgrade'))).toHaveLength(1);
  });

  it('共享 upgrade lock busy：有界等待，不执行第二次升级，只 reconnect', async () => {
    let lockReads = 0;
    const tools = fakeCli({
      'check-update': () => ({ code: 0, stdout: JSON.stringify(CHECK_AVAILABLE) }),
      'upgrade-state show': () => {
        lockReads += 1;
        return { code: 0, stdout: JSON.stringify({ ok: true, lock: { busy: true } }) };
      },
      upgrade: () => ({ code: 0, stdout: JSON.stringify({ ok: true, to: '0.2.0' }) }),
    });
    const { manager, calls } = managerHarness({
      cli: tools,
      options: { reconnectTimeoutMs: 5, upgradePollMs: 0 },
    });
    manager.start('update');
    await waitFor(() => manager.getState().state === 'failed');
    expect(manager.getState()).toMatchObject({ state: 'failed', reason: 'busy', busy: true });
    expect(lockReads).toBeGreaterThan(2);
    expect(tools.runtimeCalls().some((args) => args.includes('upgrade') && args.includes('--to'))).toBe(false);
    expect(calls.refresh).toBe(1);
  });

  it('CLI 返回 busy：等待后 reconnect，不再调用 upgrade', async () => {
    const tools = fakeCli({
      'check-update': () => ({ code: 0, stdout: JSON.stringify(CHECK_AVAILABLE) }),
      'upgrade-state show': () => ({ code: 0, stdout: JSON.stringify({ ok: true, lock: { busy: false } }) }),
      upgrade: () => ({ code: 2, stdout: JSON.stringify({ ok: false, busy: true, reason: 'busy' }) }),
    });
    const { manager, calls } = managerHarness({ cli: tools });
    manager.start('update');
    await waitFor(() => manager.getState().state === 'failed');
    expect(manager.getState()).toMatchObject({ state: 'failed', reason: 'busy' });
    expect(tools.runtimeCalls().filter((args) => args.includes('upgrade'))).toHaveLength(1);
    expect(calls.refresh).toBe(1);
  });

  it('skip：只写共享 update-state skip，升级不会发生', async () => {
    const tools = fakeCli({
      'check-update': () => ({ code: 0, stdout: JSON.stringify(CHECK_AVAILABLE) }),
      'update-state skip': () => ({ code: 0, stdout: JSON.stringify({ ok: true }) }),
      upgrade: () => { throw new Error('must not upgrade'); },
    });
    const { manager } = managerHarness({ cli: tools });
    const accepted = manager.start('skip');
    expect(accepted.accepted).toBe(true);
    await waitFor(() => manager.getState().state === 'done');
    expect(tools.runtimeCalls()).toContainEqual([
      'runtime', 'update-state', 'skip', '--version', '0.2.0', '--json',
    ]);
    expect(tools.runtimeCalls().some((args) => args.includes('upgrade'))).toBe(false);
  });

  it('later：本地动作，不写 skip、不跑任何 CLI', () => {
    const tools = fakeCli();
    const { manager } = managerHarness({ cli: tools });
    const result = manager.start('later');
    expect(result.accepted).toBe(true);
    expect(tools.calls).toHaveLength(0);
    expect(manager.getState().state).toBe('idle');
  });

  it('prompted：服务端自读 latest 并只写一次共享 prompted；不升级、不改变 upgrade 状态', async () => {
    const tools = fakeCli({
      'check-update': () => ({ code: 0, stdout: JSON.stringify(CHECK_AVAILABLE) }),
      'update-state prompted': () => ({
        code: 0,
        stdout: JSON.stringify({ ok: true, state: { promptedVersion: '0.2.0' } }),
      }),
      upgrade: () => { throw new Error('must not upgrade'); },
    });
    const { manager, calls } = managerHarness({ cli: tools });
    const first = manager.start('prompted');
    expect(first.accepted).toBe(true);
    expect(manager.getState().state).toBe('idle');
    await waitFor(() => tools.runtimeCalls().some((args) => args.includes('prompted')));
    expect(tools.runtimeCalls()).toContainEqual([
      'runtime', 'update-state', 'prompted', '--version', '0.2.0', '--json',
    ]);
    expect(calls.markPrompted).toEqual(['0.2.0']);
    expect(tools.runtimeCalls().some((args) => args.includes('upgrade'))).toBe(false);

    // 幂等：同一 latest 再次确认不再写 prompted（check 可以重读）。
    manager.start('prompted');
    await waitFor(() => tools.calls.length >= 2);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const promptedWrites = tools.runtimeCalls()
      .filter((args) => args.slice(1, 3).join(' ') === 'update-state prompted');
    expect(promptedWrites).toHaveLength(1);
    expect(manager.getState().state).toBe('idle');
  });

  it('prompted 写失败只 warning：不升级、不标记已提示、面板更新入口不受影响', async () => {
    const tools = fakeCli({
      'check-update': () => ({ code: 0, stdout: JSON.stringify(CHECK_AVAILABLE) }),
      'update-state prompted': () => ({ code: 2, stdout: JSON.stringify({ ok: false, reason: 'LOCKED' }) }),
    });
    const { manager, calls } = managerHarness({ cli: tools });
    expect(manager.start('prompted').accepted).toBe(true);
    await waitFor(() => tools.runtimeCalls().some((args) => args.includes('prompted')));
    expect(calls.markPrompted).toEqual([]);
    expect(manager.getState().state).toBe('idle');
    expect(manager.allowed()).toBe(true);
  });

  it('single-flight：升级中再次 start 不重复执行', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const tools = fakeCli({
      'check-update': () => ({ code: 0, stdout: JSON.stringify(CHECK_AVAILABLE) }),
      'upgrade-state show': () => ({ code: 0, stdout: JSON.stringify({ ok: true, lock: { busy: false } }) }),
    });
    const spawnFn = (command, args) => {
      const child = fakeChild();
      const runtimeArgs = args.slice(1);
      const key = runtimeArgs.slice(1).join(' ');
      setImmediate(async () => {
        if (key.startsWith('upgrade ')) {
          await gate;
          child.stdout.emit('data', Buffer.from(JSON.stringify({ ok: true, to: '0.2.0' })));
          child.emit('close', 0, null);
        } else if (key === 'check-update --json') {
          child.stdout.emit('data', Buffer.from(JSON.stringify(CHECK_AVAILABLE)));
          child.emit('close', 0, null);
        } else {
          child.stdout.emit('data', Buffer.from(JSON.stringify({ ok: true, lock: { busy: false } })));
          child.emit('close', 0, null);
        }
      });
      tools.calls.push({ command, args: [...args] });
      return child;
    };
    const { manager } = managerHarness({ cli: { ...tools, spawnFn } });
    expect(manager.start('update').accepted).toBe(true);
    await waitFor(() => manager.getState().state === 'updating');
    const second = manager.start('update');
    expect(second.accepted).toBe(false);
    release();
    await waitFor(() => manager.getState().state === 'done');
    expect(tools.runtimeCalls().filter((args) => args.includes('upgrade'))).toHaveLength(1);
  });

  it('runtime:external / pinned daemonUrl 拒绝升级', () => {
    const lifecycle = { inspect: async () => ({ status: 'up' }), refresh: async () => ({ status: 'up' }) };
    const external = createRuntimeUpgradeManager({
      config: { runtime: 'external' },
      lifecycle,
      cloudRoot: '/root',
      discoverProviders: async () => ({ selected: PROVIDER }),
      exists: () => true,
    });
    expect(external.allowed()).toBe(false);
    expect(external.denialReason()).toBe('runtime_external');
    expect(external.start('update')).toMatchObject({ accepted: false });

    const pinned = createRuntimeUpgradeManager({
      config: { daemonUrl: 'http://127.0.0.1:7000' },
      lifecycle,
      cloudRoot: '/root',
      discoverProviders: async () => ({ selected: PROVIDER }),
      exists: () => true,
    });
    expect(pinned.denialReason()).toBe('daemon_url_pinned');
  });
});

describe('POST /mebular/runtime/upgrade route', () => {
  it('route constant is fixed and loopback-only', () => {
    expect(RUNTIME_UPGRADE_PATH).toBe('/mebular/runtime/upgrade');
  });

  function fakeReq({
    method = 'POST',
    remoteAddress = '127.0.0.1',
    contentType = 'application/json',
    body = '{}',
  } = {}) {
    const req = new EventEmitter();
    req.method = method;
    req.socket = { remoteAddress };
    req.headers = contentType === null ? {} : { 'content-type': contentType };
    if (body !== null) {
      setImmediate(() => {
        req.emit('data', Buffer.from(body));
        req.emit('end');
      });
    }
    return req;
  }

  function fakeRes() {
    return {
      statusCode: 200,
      headers: {},
      body: null,
      setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
      end(value) {
        try {
          this.body = value ? JSON.parse(value) : null;
        } catch {
          this.body = value;
        }
      },
    };
  }

  function manager(calls = [], { allowed = true } = {}) {
    return {
      allowed: () => allowed,
      denialReason: () => (allowed ? null : 'runtime_external'),
      getState: () => sanitizeRuntimeUpgradeState({ state: 'idle' }),
      start: (action) => {
        calls.push(action);
        return { accepted: action !== 'later', state: sanitizeRuntimeUpgradeState({ state: action }) };
      },
    };
  }

  it('loopback POST JSON：默认 update，只接受固定 action，202', async () => {
    const calls = [];
    const handler = createRuntimeUpgradeHandler({ manager: manager(calls) });
    const res = fakeRes();
    await handler(fakeReq({ body: JSON.stringify({ action: 'update' }) }), res);
    expect(res.statusCode).toBe(202);
    expect(res.body).toMatchObject({ ok: true, accepted: true, action: 'update' });
    expect(res.body).not.toHaveProperty('version');
    expect(calls).toEqual(['update']);

    const prompted = fakeRes();
    await handler(fakeReq({ body: JSON.stringify({ action: 'prompted' }) }), prompted);
    expect(prompted.statusCode).toBe(202);
    expect(prompted.body).toMatchObject({ ok: true, accepted: true, action: 'prompted' });
    expect(calls).toEqual(['update', 'prompted']);
  });

  it('远端一律 404；非 POST 405；非 JSON/非法 JSON/任意 version/url 均 400', async () => {
    const calls = [];
    const handler = createRuntimeUpgradeHandler({ manager: manager(calls) });

    const remote = fakeRes();
    await handler(fakeReq({ remoteAddress: '10.0.0.5' }), remote);
    expect(remote.statusCode).toBe(404);

    const method = fakeRes();
    await handler(fakeReq({ method: 'GET', body: null }), method);
    expect(method.statusCode).toBe(405);
    expect(method.headers.allow).toBe('POST');

    const contentType = fakeRes();
    await handler(fakeReq({ contentType: 'text/plain' }), contentType);
    expect(contentType.statusCode).toBe(400);

    const invalidJson = fakeRes();
    await handler(fakeReq({ body: '{' }), invalidJson);
    expect(invalidJson.statusCode).toBe(400);

    const version = fakeRes();
    await handler(fakeReq({ body: JSON.stringify({ action: 'update', version: '9.9.9' }) }), version);
    expect(version.statusCode).toBe(400);
    expect(version.body.error).toBe('unsupported_parameters');

    const url = fakeRes();
    await handler(fakeReq({ body: JSON.stringify({ url: 'https://evil.example/x.tgz' }) }), url);
    expect(url.statusCode).toBe(400);

    const action = fakeRes();
    await handler(fakeReq({ body: JSON.stringify({ action: 'install' }) }), action);
    expect(action.statusCode).toBe(400);
    expect(action.body.error).toBe('invalid_action');
    expect(calls).toEqual([]);
  });

  it('not allowed → 403，不调用 manager', async () => {
    const calls = [];
    const handler = createRuntimeUpgradeHandler({
      config: { runtime: 'external' },
      manager: manager(calls, { allowed: false }),
    });
    const res = fakeRes();
    await handler(fakeReq({ body: JSON.stringify({ action: 'update' }) }), res);
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ ok: false, error: 'upgrade_not_allowed', reason: 'runtime_external' });
    expect(calls).toEqual([]);
  });
});

function loadClientInternals({ lang = 'en' } = {}) {
  let registration = null;
  const fakeWindow = {
    __MEBULAR_DSH_TEST__: true,
    __ModuleLoader__: { load(value) { registration = value; } },
  };
  runInNewContext(clientSource, {
    window: fakeWindow,
    document: { documentElement: { lang } },
    URL,
  }, { filename: clientPath });
  expect(registration).not.toBeNull();
  const exported = registration.factory((name) => {
    expect(name).toBe('react');
    return { createElement: () => null, useEffect: () => {}, useState: () => [null, () => {}] };
  });
  return exported.__test;
}

function updateInfo(overrides = {}) {
  return {
    update: {
      state: 'available',
      currentVersion: '0.1.2',
      latestVersion: '0.2.0',
      available: true,
      skipped: false,
      prompted: true,
      show: true,
      auto: true,
      manual: true,
      reason: null,
    },
    upgrade: { state: 'idle', reason: null, fromVersion: null, toVersion: null },
    ...overrides,
  };
}

describe('DSH client update banner', () => {
  it('有更新且未跳过：banner + 更新/稍后/跳过此版本', () => {
    const { updateView, text } = loadClientInternals();
    const view = updateView(text(), updateInfo());
    expect(view).toMatchObject({
      kind: 'available',
      heading: 'Update available',
      actions: ['update', 'later', 'skip'],
    });
    expect(view.message).toContain('0.1.2');
    expect(view.message).toContain('0.2.0');
  });

  it('prompted 但非本会话展示：不弹 banner（头部仍可手动更新）', () => {
    const { updateView, text } = loadClientInternals();
    const info = updateInfo({
      update: { ...updateInfo().update, show: false, auto: false, manual: true },
    });
    expect(updateView(text(), info)).toBeNull();
    expect(info.update.manual).toBe(true);
  });

  it('稍后（dismissedVersion）不再显示；skip 后不显示；updating/failed 有稳定文案', () => {
    const { updateView, text } = loadClientInternals();
    expect(updateView(text(), updateInfo(), { dismissedVersion: '0.2.0' })).toBeNull();
    expect(updateView(text(), updateInfo({
      update: { ...updateInfo().update, available: false, skipped: true, show: false, manual: false },
    }))).toBeNull();

    const updating = updateView(text(), updateInfo({ upgrade: { state: 'updating', reason: null } }));
    expect(updating).toMatchObject({ kind: 'updating', actions: [] });
    expect(updating.body).toContain('Installing');

    const failed = updateView(text(), updateInfo({
      upgrade: { state: 'failed', reason: 'service_upgrade_failed', fromVersion: '0.1.2', toVersion: '0.2.0' },
    }));
    expect(failed).toMatchObject({ kind: 'failed', reason: 'service_upgrade_failed', actions: ['update', 'later'] });
    expect(failed.body).toContain('service_upgrade_failed');

    const busy = updateView(text(), updateInfo({ upgrade: { state: 'failed', reason: 'busy' } }));
    expect(busy.body).toContain('Another Mebular entry point');
  });

  it('中文文案存在，banner 不依赖颜色且 header 不再插入常驻提示行', () => {
    const { updateView, text } = loadClientInternals({ lang: 'zh-CN' });
    const view = updateView(text(), updateInfo());
    expect(view.heading).toBe('发现更新');
    expect(view.actions).toEqual(['update', 'later', 'skip']);
    expect(clientSource).not.toContain('serviceHint');
  });

  it('store：later 不发请求；prompted 每版本只发一次；skip/update body 仅 action', async () => {
    const { createEmbedInfoStore } = loadClientInternals();
    const calls = [];
    const store = createEmbedInfoStore({
      fetchImpl: async (url, init = {}) => {
        calls.push({ url, init });
        if (init.method === 'POST') {
          const body = JSON.parse(init.body);
          return {
            ok: true,
            status: 202,
            json: async () => ({
              ok: true,
              accepted: true,
              action: body.action,
              upgrade: { state: body.action === 'prompted' ? 'idle' : 'done', toVersion: '0.2.0' },
            }),
          };
        }
        return { ok: true, status: 200, json: async () => updateInfo() };
      },
      setIntervalFn: () => 1,
      clearIntervalFn: () => {},
    });
    const unsubscribe = store.subscribe(() => {});
    await store.refresh();
    store.later('0.2.0');
    expect(store.getSnapshot().dismissedVersion).toBe('0.2.0');
    expect(calls.filter((call) => call.init.method === 'POST')).toHaveLength(0);

    // Banner rendered -> confirm; repeated renders must not POST twice.
    await store.confirmPrompted('0.2.0');
    await store.confirmPrompted('0.2.0');
    const promptedPosts = calls.filter((call) => call.init.method === 'POST');
    expect(promptedPosts).toHaveLength(1);
    expect(promptedPosts[0].url).toBe('/mebular/runtime/upgrade');
    expect(JSON.parse(promptedPosts[0].init.body)).toEqual({ action: 'prompted' });

    await store.upgrade('skip');
    const skip = calls.filter((call) => call.init.method === 'POST').at(-1);
    expect(skip.url).toBe('/mebular/runtime/upgrade');
    expect(JSON.parse(skip.init.body)).toEqual({ action: 'skip' });

    await store.upgrade('update');
    const update = calls.filter((call) => call.init.method === 'POST').at(-1);
    expect(update.url).toBe('/mebular/runtime/upgrade');
    expect(JSON.parse(update.init.body)).toEqual({ action: 'update' });
    expect(store.getSnapshot().dismissedVersion).toBe('0.2.0');
    unsubscribe();
  });
});

describe('buildEmbedInfo update state', () => {
  it('update/upgrade 与 install 分离，并且只保留白名单字段', () => {
    const info = buildEmbedInfo({
      daemonUrl: 'http://127.0.0.1:7331',
      status: 'up',
      reachable: true,
      update: {
        ...CHECK_AVAILABLE,
        show: true,
        manual: true,
        token: 'should-drop',
      },
      upgrade: {
        state: 'failed',
        reason: 'busy',
        fromVersion: '0.1.2',
        toVersion: '0.2.0',
        secret: 'should-drop',
      },
      install: { state: 'done' },
    });
    expect(info.update).toMatchObject({
      state: 'available',
      currentVersion: '0.1.2',
      latestVersion: '0.2.0',
      available: true,
      skipped: false,
      prompted: false,
      show: true,
      manual: true,
    });
    expect(info.update).not.toHaveProperty('token');
    expect(info.upgrade).toMatchObject({ state: 'failed', reason: 'busy', toVersion: '0.2.0' });
    expect(info.upgrade).not.toHaveProperty('secret');
    expect(info.install).toMatchObject({ state: 'done' });
  });

  it('sanitizers 拒绝未知 reason/state，并保持 availability 一致', () => {
    expect(sanitizeRuntimeUpdateState({ state: 'evil', available: true, skipped: true, latestVersion: '0.2.0' }))
      .toMatchObject({ state: 'skipped', available: true, skipped: true, manual: false });
    expect(sanitizeRuntimeUpgradeState({ state: 'failed', reason: 'evil' }))
      .toMatchObject({ state: 'failed', reason: 'upgrade_failed' });
  });
});
