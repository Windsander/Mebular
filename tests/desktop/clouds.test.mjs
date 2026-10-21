// E2-B · App 壳忆云切换：CL-02 双活拒绝 / CL-05 身份不匹配 / CL-09 成功·回滚·崩溃恢复
//
// 纯逻辑 + 真实注册表/切换引擎（不启 GUI、不碰真实 launchd）：
//   - probeHealthDetail / waitForDaemonDetail 带 homeKey instance 身份；
//   - ensureDaemon 只在 instance 匹配时 reused；
//   - migrateLegacyService 保留旧 manifest autostart；
//   - performCloudSwitch 停旧→写 current→起新→healthz→失败回滚；
//   - recoverSwitchIntent 崩溃恢复：目标健康=成功；否则回旧；都不健康=诊断且保留 intent/档案。

import { describe, it, expect, afterEach } from '@jest/globals';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensureDaemon,
  probeHealth,
  probeHealthDetail,
  waitForDaemonDetail,
} from '../../apps/desktop/src/main/daemon.mjs';
import {
  migrateLegacyService,
  performCloudSwitch,
  readCloudPrefs,
  recoverSwitchIntent,
} from '../../apps/desktop/src/main/clouds.mjs';
import * as profiles from '../../packages/mcp/src/profiles.mjs';
import * as cloudSwitch from '../../packages/mcp/src/cloud-switch.mjs';
import { IPC_CHANNELS, buildHandlerTable, sanitizeArgs } from '../../apps/desktop/src/main/ipc.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const modules = { profiles, switch: cloudSwitch };
const P1 = 18881;
const P2 = 18882;

const tempDirs = [];
afterEach(async () => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function makeRoot({ port1 = P1, port2 = P2, current = 'default' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'e2b-clouds-'));
  tempDirs.push(root);
  const p2Home = join(root, 'profiles', 'p2');
  await mkdir(p2Home, { recursive: true });
  await writeFile(join(root, 'config.json'), JSON.stringify({
    deviceId: 'device-default',
    mcp: { http: { host: '127.0.0.1', port: port1 } },
  }, null, 2));
  await writeFile(join(p2Home, 'config.json'), JSON.stringify({
    deviceId: 'device-p2',
    mcp: { http: { host: '127.0.0.1', port: port2 } },
  }, null, 2));
  await profiles.writeRegistry(root, {
    v: 1,
    current,
    profiles: [
      {
        id: 'default', name: '忆云 1', home: '.', kind: 'root',
        createdAt: '2026-01-01T00:00:00.000Z', lastUsedAt: null,
        masterFingerprint: null, deviceId: 'device-default',
      },
      {
        id: 'p2', name: '忆云 2', home: 'profiles/p2', kind: 'root',
        createdAt: '2026-01-02T00:00:00.000Z', lastUsedAt: null,
        masterFingerprint: null, deviceId: 'device-p2',
      },
    ],
  });
  return { root, defaultHome: root, p2Home };
}

function healthBody(home, cloudId = null) {
  return {
    status: 'ok',
    instance: profiles.homeKey(home),
    ...(cloudId ? { cloudId } : {}),
  };
}

function makeFetcher({ defaultHome, p2Home, running, failPorts = new Set(), mismatched = new Map() }) {
  return async (url) => {
    const port = Number(new URL(url).port);
    if (mismatched.has(port)) {
      return { ok: true, status: 200, json: async () => ({ instance: mismatched.get(port), cloudId: 'other' }) };
    }
    const expectedHome = port === P1 ? defaultHome : port === P2 ? p2Home : null;
    if (expectedHome === null || running.home !== expectedHome || failPorts.has(port)) {
      throw new Error('ECONNREFUSED');
    }
    const id = expectedHome === defaultHome ? 'default' : 'p2';
    return { ok: true, status: 200, json: async () => healthBody(expectedHome, id) };
  };
}

function noService(overrides = {}) {
  return {
    registeredServicesForDir: () => [],
    serviceStatus: () => ({ registered: false, running: false, autostart: null, unitPath: null }),
    installService: () => ({ ok: true, started: true }),
    uninstallService: () => ({ ok: true, removed: false }),
    manifestPath: (kind, home) => join(home, '.mebular', 'services', `${kind}.json`),
    ...overrides,
  };
}

function fakeChild(running, home) {
  return {
    home,
    killed: false,
    kill() {
      this.killed = true;
      if (running.home === home) running.home = null;
      return true;
    },
  };
}

describe('CL-05 · healthz 实例身份', () => {
  it('probeHealthDetail：200 且 instance 匹配 → ok；不匹配/缺失 → 明确原因', async () => {
    const http = { host: '127.0.0.1', port: P1 };
    const match = await probeHealthDetail(async () => ({
      ok: true, status: 200, json: async () => ({ instance: 'abc123def456' }),
    }), http, { expectedInstance: 'abc123def456' });
    expect(match).toMatchObject({ ok: true, instance: 'abc123def456' });

    const mismatch = await probeHealthDetail(async () => ({
      ok: true, status: 200, json: async () => ({ instance: 'other0000000' }),
    }), http, { expectedInstance: 'abc123def456' });
    expect(mismatch).toMatchObject({ ok: false, reason: 'instance_mismatch', instance: 'other0000000' });

    const missing = await probeHealthDetail(async () => ({
      ok: true, status: 200, json: async () => ({}),
    }), http, { expectedInstance: 'abc123def456' });
    expect(missing.ok).toBe(false);
    expect(missing.reason).toBe('instance_missing');

    // 旧布尔入口也接受身份选项（E2-B 调用方不必都改用 Detail）
    expect(await probeHealth(async () => ({
      ok: true, status: 200, json: async () => ({ instance: 'abc123def456' }),
    }), http, { expectedInstance: 'abc123def456' })).toBe(true);
    expect(await probeHealth(async () => ({
      ok: true, status: 200, json: async () => ({ instance: 'other0000000' }),
    }), http, { expectedInstance: 'abc123def456' })).toBe(false);
  });

  it('waitForDaemonDetail：instance 不匹配立即终止（不把别的忆云当目标）', async () => {
    let calls = 0;
    const result = await waitForDaemonDetail({
      fetchImpl: async () => {
        calls += 1;
        return { ok: true, status: 200, json: async () => ({ instance: 'other0000000' }) };
      },
      http: { host: '127.0.0.1', port: P2 },
      attempts: 20,
      intervalMs: 1,
      expectedInstance: 'target000000',
    });
    expect(result).toMatchObject({ ok: false, reason: 'instance_mismatch' });
    expect(calls).toBe(1);
  });

  it('ensureDaemon：端口上是另一张忆云 → conflict，绝不 reused / 绝不 spawn', async () => {
    let spawned = 0;
    const result = await ensureDaemon({
      home: '/h', http: { host: '127.0.0.1', port: P1 }, cliBin: '/x/mebular.mjs',
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ instance: 'other0000000' }) }),
      service: noService(),
      spawnFn: () => { spawned += 1; return fakeChild({ home: null }, '/h'); },
    });
    expect(result.mode).toBe('conflict');
    expect(result.reason).toBe('instance_mismatch');
    expect(result.message).toMatch(/端口 18881 上是另一张忆云/);
    expect(spawned).toBe(0);
  });

  it('ensureDaemon：instance 匹配 → reused', async () => {
    const home = '/tmp/same-home';
    const result = await ensureDaemon({
      home, http: { host: '127.0.0.1', port: P1 }, fetchImpl: async () => ({
        ok: true, status: 200, json: async () => ({ instance: profiles.homeKey(home) }),
      }),
      service: noService(),
      spawnFn: () => { throw new Error('should not spawn'); },
    });
    expect(result.mode).toBe('reused');
  });
});

describe('CL-02 · root active.lock 双活拒绝', () => {
  it('活 PID 占用另一 home → CLOUD_ALREADY_ACTIVE，旧守护不动', async () => {
    const { root, defaultHome, p2Home } = await makeRoot();
    const running = { home: defaultHome };
    const oldChild = fakeChild(running, defaultHome);
    await writeFile(join(root, 'active.lock'), JSON.stringify({
      pid: 4242, profileId: 'other', home: '/elsewhere', startedAt: '2026-01-01T00:00:00.000Z',
    }));
    let error = null;
    try {
      await performCloudSwitch({
        root, id: 'p2', home: defaultHome, cliBin: '/x/mebular.mjs',
        modules, fetchImpl: makeFetcher({ root, defaultHome, p2Home, running }),
        spawnFn: () => fakeChild(running, p2Home),
        service: noService(), serviceHome: '/os-home', managedChild: oldChild,
        pidAlive: (pid) => pid === 4242,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error?.code).toBe('CLOUD_ALREADY_ACTIVE');
    expect(error?.message).toMatch(/另一张忆云|已有忆云/);
    expect(oldChild.killed).toBe(false);
    expect(existsSync(join(root, 'profiles', 'p2'))).toBe(true);
  });
});

describe('服务迁移 · 保留旧 manifest autostart', () => {
  it('旧单 home 服务单元 → 新 serviceHome；--no-autostart 不被改成自启动', async () => {
    const { root, defaultHome } = await makeRoot();
    const legacyServiceHome = defaultHome;
    const serviceHome = join(root, '..', 'os-home');
    const legacyUnit = join(defaultHome, 'Library', 'LaunchAgents', 'com.mebular.mebular-serve.abc.plist');
    const legacyManifest = join(defaultHome, '.mebular', 'services', 'mebular-serve.json');
    await mkdir(dirname(legacyUnit), { recursive: true });
    await mkdir(dirname(legacyManifest), { recursive: true });
    await writeFile(legacyUnit, 'plist');
    await writeFile(legacyManifest, JSON.stringify({ autostart: false }));
    const calls = [];
    const service = noService({
      serviceStatus: (descriptor, options) => {
        const at = options?.home;
        if (at === legacyServiceHome) return { registered: true, running: true, autostart: false, unitPath: legacyUnit };
        return { registered: false, running: false, autostart: null, unitPath: '/nope' };
      },
      installService: (descriptor, options) => {
        calls.push({ descriptor, options });
        return { ok: true, started: true };
      },
      manifestPath: () => legacyManifest,
    });
    const result = await migrateLegacyService({
      service,
      descriptor: { kind: 'mebular-serve', args: ['/x/mebular.mjs', 'serve'], heartbeatDir: defaultHome, env: { MEBULAR_HOME: defaultHome, MEBULAR_CLOUD_ROOT: root } },
      home: defaultHome,
      serviceHome,
    });
    expect(result.migrated).toBe(true);
    expect(result.autostart).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].options).toMatchObject({ home: serviceHome, autostart: false });
    expect(existsSync(legacyUnit)).toBe(false);
    expect(existsSync(legacyManifest)).toBe(false);
  });
});

describe('CL-09 · 切换状态机（成功 / 回滚）', () => {
  it('成功：停旧 → current=p2 → 起新 → healthz 匹配；旧档案目录保留', async () => {
    const { root, defaultHome, p2Home } = await makeRoot();
    const running = { home: defaultHome };
    const oldChild = fakeChild(running, defaultHome);
    const children = [];
    const result = await performCloudSwitch({
      root, id: 'p2', home: defaultHome, cliBin: '/x/mebular.mjs',
      modules, fetchImpl: makeFetcher({ root, defaultHome, p2Home, running }),
      spawnFn: (exec, args, options) => {
        const home = options.env.MEBULAR_HOME;
        const child = fakeChild(running, home);
        children.push(child);
        running.home = home;
        return child;
      },
      service: noService(), serviceHome: '/os-home', managedChild: oldChild,
      pidAlive: () => false,
    });
    expect(result).toMatchObject({ ok: true, changed: true, current: 'p2', previous: 'default', home: p2Home, mode: 'child' });
    expect(result.child?.home).toBe(p2Home);
    expect(oldChild.killed).toBe(true);
    const state = await profiles.readRegistry(root);
    expect(state.registry.current).toBe('p2');
    expect(existsSync(defaultHome)).toBe(true);
    expect(existsSync(p2Home)).toBe(true);
    expect(existsSync(cloudSwitch.switchIntentPath(root))).toBe(false);
    const prefs = await readCloudPrefs(root);
    expect(prefs.profiles.p2).toMatchObject({ mode: 'child', autostart: true });
  });

  it('服务托管：切换后仍走服务，autostart 沿用旧 manifest', async () => {
    const { root, defaultHome, p2Home } = await makeRoot();
    const running = { home: defaultHome };
    const installs = [];
    const uninstalls = [];
    const service = noService({
      serviceStatus: (descriptor, options) => {
        const at = options?.home;
        if (at === '/os-home' && descriptor.env?.MEBULAR_HOME === defaultHome) {
          return { registered: true, running: running.home === defaultHome, autostart: false, unitPath: '/old-service' };
        }
        return { registered: false, running: false, autostart: null, unitPath: null };
      },
      installService: (descriptor, options) => {
        installs.push({ home: descriptor.env.MEBULAR_HOME, options });
        running.home = descriptor.env.MEBULAR_HOME;
        return { ok: true, started: true };
      },
      uninstallService: (descriptor, options) => {
        uninstalls.push(options.home);
        running.home = null;
        return { ok: true, removed: true };
      },
    });
    const result = await performCloudSwitch({
      root, id: 'p2', home: defaultHome, cliBin: '/x/mebular.mjs',
      modules, fetchImpl: makeFetcher({ defaultHome, p2Home, running }),
      spawnFn: () => { throw new Error('service mode must not spawn'); },
      service, serviceHome: '/os-home', pidAlive: () => false,
    });
    expect(result).toMatchObject({ ok: true, current: 'p2', mode: 'service', child: null });
    expect(installs.at(-1)).toMatchObject({ home: p2Home, options: { home: '/os-home', autostart: false } });
    expect(uninstalls).toContain('/os-home');
    expect(existsSync(p2Home)).toBe(true);
  });

  it('失败回滚：新忆云不健康 → abort 新、current 回 default、旧守护重新拉起', async () => {
    const { root, defaultHome, p2Home } = await makeRoot();
    const running = { home: defaultHome };
    const oldChild = fakeChild(running, defaultHome);
    const children = [];
    let error = null;
    try {
      await performCloudSwitch({
        root, id: 'p2', home: defaultHome, cliBin: '/x/mebular.mjs',
        modules,
        fetchImpl: makeFetcher({ root, defaultHome, p2Home, running, failPorts: new Set([P2]) }),
        spawnFn: (exec, args, options) => {
          const home = options.env.MEBULAR_HOME;
          const child = fakeChild(running, home);
          children.push(child);
          running.home = home;
          return child;
        },
        service: noService(), serviceHome: '/os-home', managedChild: oldChild,
        pidAlive: () => false,
        verifyTimeoutMs: 100,
        verifyIntervalMs: 10,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error?.code).toBe('CLOUD_SWITCH_FAILED');
    expect(error?.rollback?.ok).toBe(true);
    expect(error?.child?.home).toBe(defaultHome);
    expect(running.home).toBe(defaultHome);
    expect(children.some((child) => child.home === p2Home && child.killed)).toBe(true);
    const state = await profiles.readRegistry(root);
    expect(state.registry.current).toBe('default');
    expect(existsSync(p2Home)).toBe(true);
    expect(existsSync(cloudSwitch.switchIntentPath(root))).toBe(false);
  });
});

describe('CL-09 · switch.intent.json 崩溃恢复', () => {
  async function writeIntent(root, from = 'default', to = 'p2', phase = 'starting') {
    await cloudSwitch.writeSwitchIntent(root, { from, to, at: '2026-01-01T00:00:00.000Z', phase });
  }

  it('目标健康 → 认定成功：current=to、清 intent', async () => {
    const { root, defaultHome, p2Home } = await makeRoot({ current: 'p2' });
    await writeIntent(root);
    const running = { home: p2Home };
    const result = await recoverSwitchIntent({
      root, cliBin: '/x/mebular.mjs', modules,
      fetchImpl: makeFetcher({ root, defaultHome, p2Home, running }),
      spawnFn: () => { throw new Error('should not start'); },
      service: noService(), serviceHome: '/os-home', pidAlive: () => false,
    });
    expect(result).toMatchObject({ recovered: true, status: 'committed', current: 'p2', home: p2Home });
    expect((await profiles.readRegistry(root)).registry.current).toBe('p2');
    expect(existsSync(cloudSwitch.switchIntentPath(root))).toBe(false);
  });

  it('目标不健康、旧健康 → 回旧：current=from、清 intent', async () => {
    const { root, defaultHome, p2Home } = await makeRoot({ current: 'p2' });
    await writeIntent(root);
    const running = { home: defaultHome };
    const result = await recoverSwitchIntent({
      root, cliBin: '/x/mebular.mjs', modules,
      fetchImpl: makeFetcher({ root, defaultHome, p2Home, running }),
      spawnFn: () => { throw new Error('old is healthy; should not start'); },
      service: noService(), serviceHome: '/os-home', pidAlive: () => false,
    });
    expect(result).toMatchObject({ recovered: true, status: 'rolled_back', current: 'default', home: defaultHome });
    expect((await profiles.readRegistry(root)).registry.current).toBe('default');
    expect(existsSync(cloudSwitch.switchIntentPath(root))).toBe(false);
  });

  it('两者都不健康 → 诊断；intent 与两张档案都保留，不删目录', async () => {
    const { root, defaultHome, p2Home } = await makeRoot({ current: 'p2' });
    await writeIntent(root);
    const running = { home: null };
    const result = await recoverSwitchIntent({
      root, cliBin: '/x/mebular.mjs', modules,
      fetchImpl: makeFetcher({ root, defaultHome, p2Home, running, failPorts: new Set([P1, P2]) }),
      spawnFn: () => fakeChild(running, defaultHome),
      service: noService(), serviceHome: '/os-home', pidAlive: () => false,
      verifyTimeoutMs: 50, verifyIntervalMs: 5,
    });
    expect(result).toMatchObject({ recovered: true, status: 'diagnostics', current: 'default', home: defaultHome });
    expect(result.message).toMatch(/诊断/);
    expect(existsSync(cloudSwitch.switchIntentPath(root))).toBe(true);
    expect((await profiles.readRegistry(root)).registry.profiles.map((entry) => entry.id)).toEqual(['default', 'p2']);
    expect(existsSync(defaultHome)).toBe(true);
    expect(existsSync(p2Home)).toBe(true);
  });
});

describe('E2-B · IPC / preload 契约', () => {
  it('白名单包含 cloud:list / cloud:switch / cloud:manage；switch 只接受 1 个字符串参数', () => {
    expect(IPC_CHANNELS).toEqual(expect.arrayContaining(['cloud:list', 'cloud:switch', 'cloud:manage']));
    expect(sanitizeArgs(['p2'], 'cloud:switch')).toEqual(['p2']);
    expect(sanitizeArgs(['p2', 'EXTRA'], 'cloud:switch')).toEqual(['p2']);
    expect(sanitizeArgs(['p2'], 'cloud:list')).toEqual([]);
    const table = buildHandlerTable({ 'cloud:switch': (id) => id, 'cloud:list': () => 'list' });
    expect(Object.keys(table)).toEqual(expect.arrayContaining(['cloud:switch', 'cloud:list']));
  });

  it('preload 暴露 cloudSwitch / cloudList / cloudManage（固定通道，不透传）', async () => {
    const source = await readFile(join(here, '..', '..', 'apps', 'desktop', 'src', 'preload', 'index.cjs'), 'utf-8');
    expect(source).toContain("cloudSwitch: (id) => ipcRenderer.invoke('cloud:switch'");
    expect(source).toContain("cloudList: () => ipcRenderer.invoke('cloud:list')");
    expect(source).toContain("cloudManage: () => ipcRenderer.invoke('cloud:manage')");
  });

  it('主进程：运行时 home / MEBULAR_CLOUD_ROOT / 托盘管理忆云 / 切换后刷新', async () => {
    const source = await readFile(join(here, '..', '..', 'apps', 'desktop', 'src', 'main', 'index.mjs'), 'utf-8');
    const daemonSource = await readFile(join(here, '..', '..', 'apps', 'desktop', 'src', 'main', 'daemon.mjs'), 'utf-8');
    const cloudSource = await readFile(join(here, '..', '..', 'apps', 'desktop', 'src', 'main', 'clouds.mjs'), 'utf-8');
    const navSource = await readFile(join(here, '..', '..', 'apps', 'desktop', 'src', 'main', 'console-nav.mjs'), 'utf-8');
    expect(source).toMatch(/let home\s*=/);
    expect(daemonSource).toContain('MEBULAR_CLOUD_ROOT');
    expect(cloudSource).toContain('MEBULAR_CLOUD_ROOT');
    expect(navSource).toContain("focus: 'clouds'");
    expect(source).toContain("'manage-clouds'");
    expect(source).toMatch(/updateTray\(\)[\s\S]*showConsoleWithRetry\(\)/);
  });
});
