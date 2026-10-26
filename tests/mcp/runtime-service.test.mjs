// Phase 5a · 共享 mebular-serve：current 优先、owner/provider 落 manifest、
// install/status/restart/uninstall 与冲突/回退语义。
//
// 不真装系统服务：@mebular/service 走真实 TS 实现，但平台命令用注入 run 替身；
// unit/manifest 落临时 serviceHome。

import { describe, it, expect, afterEach } from '@jest/globals';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  installRuntimeService,
  restartRuntimeService,
  runtimeServiceStatus,
  uninstallRuntimeService,
  RUNTIME_SERVICE_KIND,
} from '../../packages/mcp/src/runtime-service.mjs';
import {
  readRuntimeCurrent,
  runtimeCurrentPath,
  writeRuntimeCurrent,
} from '../../packages/mcp/src/runtime-current.mjs';
import { registerRuntimeProvider, runtimeProvidersPath } from '../../packages/mcp/src/runtime-providers.mjs';

const tempDirs = [];

async function tempDir(prefix = 'runtime-service-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop(), { recursive: true, force: true });
  }
});

async function writeRuntime(root, version = '0.1.2') {
  const runtimePath = join(root, 'runtime', version);
  const core = join(runtimePath, 'node_modules', '@mebular', 'core');
  await mkdir(join(core, 'packages', 'mcp', 'bin'), { recursive: true });
  await writeFile(join(core, 'package.json'), JSON.stringify({ name: '@mebular/core', version }), 'utf-8');
  const cliPath = join(core, 'packages', 'mcp', 'bin', 'mebular.mjs');
  await writeFile(cliPath, '// fake runtime\n', 'utf-8');
  return { runtimePath, cliPath };
}

async function writeCurrent(root, version = '0.1.2') {
  const layout = await writeRuntime(root, version);
  await writeRuntimeCurrent(root, {
    version,
    runtimePath: layout.runtimePath,
    cliPath: layout.cliPath,
    provider: 'shared',
    owner: 'shared',
    installedAt: '2026-01-01T00:00:00.000Z',
  });
  return layout;
}

function fakeRun() {
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...(args ?? [])]);
    if (cmd === 'systemctl' && args?.includes('is-active')) return { code: 0, stdout: 'active', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  return { calls, run };
}

function manifestPath(serviceHome) {
  return join(serviceHome, '.mebular', 'services', `${RUNTIME_SERVICE_KIND}.json`);
}

describe('共享 service：install / status / restart / uninstall', () => {
  it('current 优先；manifest 记录 runtimePath/version/provider/owner，重启走平台计划', async () => {
    const root = await tempDir('runtime-service-root-');
    const serviceHome = await tempDir('runtime-service-home-');
    const layout = await writeCurrent(root);
    const rec = fakeRun();

    const installed = await installRuntimeService({
      root,
      home: root,
      serviceHome,
      platform: 'linux',
      run: rec.run,
      now: 1700000000000,
    });
    expect(installed).toMatchObject({
      ok: true,
      registered: true,
      running: true,
      version: '0.1.2',
      provider: 'shared',
      owner: 'shared',
    });
    expect(installed.unitPath.startsWith(serviceHome)).toBe(true);
    const manifest = JSON.parse(await readFile(manifestPath(serviceHome), 'utf-8'));
    expect(manifest.runtime).toMatchObject({
      version: '0.1.2',
      runtimePath: layout.runtimePath,
      cliPath: layout.cliPath,
      provider: 'shared',
      owner: 'shared',
      cloudRoot: root,
      home: root,
    });
    expect(manifest.args[0]).toBe(layout.cliPath);

    const status = await runtimeServiceStatus({
      root,
      home: root,
      serviceHome,
      platform: 'linux',
      run: rec.run,
      now: 1700000000000,
    });
    expect(status).toMatchObject({
      ok: true,
      registered: true,
      running: true,
      version: '0.1.2',
      provider: 'shared',
      owner: 'shared',
      current: { version: '0.1.2' },
    });

    const restarted = await restartRuntimeService({
      root,
      home: root,
      serviceHome,
      platform: 'linux',
      run: rec.run,
      now: 1700000000000,
    });
    expect(restarted).toMatchObject({ ok: true, registered: true, restarted: true });
    expect(rec.calls.some((call) => call[0] === 'systemctl' && call.includes('restart'))).toBe(true);
  });

  it('uninstall 只移除 unit/manifest，不删 runtime/current/provider/数据', async () => {
    const root = await tempDir('runtime-service-root-');
    const serviceHome = await tempDir('runtime-service-home-');
    const layout = await writeCurrent(root);
    await registerRuntimeProvider(root, { kind: 'shared', path: layout.cliPath, version: '0.1.2', capabilities: ['serve'] });
    await writeFile(join(root, 'store.jsonl'), '{}\n', 'utf-8');
    const rec = fakeRun();
    await installRuntimeService({ root, home: root, serviceHome, platform: 'linux', run: rec.run });

    const removed = await uninstallRuntimeService({ root, home: root, serviceHome, platform: 'linux', run: rec.run });
    expect(removed).toMatchObject({ ok: true, removed: true, runtimePreserved: true });
    expect(existsSync(manifestPath(serviceHome))).toBe(false);
    expect(existsSync(layout.runtimePath)).toBe(true);
    expect(existsSync(runtimeCurrentPath(root))).toBe(true);
    expect(existsSync(runtimeProvidersPath(root))).toBe(true);
    expect(existsSync(join(root, 'store.jsonl'))).toBe(true);
    const status = await runtimeServiceStatus({ root, home: root, serviceHome, platform: 'linux', run: rec.run });
    expect(status.registered).toBe(false);
  });
});

describe('共享 service：缺少 current / 冲突不覆盖', () => {
  it('current 不可用且无 fallback → runtime_required，不写 unit/manifest', async () => {
    const root = await tempDir('runtime-service-root-');
    const serviceHome = await tempDir('runtime-service-home-');
    const result = await installRuntimeService({ root, home: root, serviceHome, platform: 'linux', run: fakeRun().run });
    expect(result).toMatchObject({ ok: false, reason: 'runtime_required' });
    expect(existsSync(manifestPath(serviceHome))).toBe(false);
    expect(existsSync(join(serviceHome, '.config', 'systemd', 'user', 'mebular-mebular-serve.service'))).toBe(false);
  });

  it('已有另一 home/cloudRoot 的 manifest → service_conflict，且原 manifest 不被覆盖', async () => {
    const root = await tempDir('runtime-service-root-');
    const serviceHome = await tempDir('runtime-service-home-');
    await writeCurrent(root);
    const unitPath = join(serviceHome, 'foreign.plist');
    await writeFile(unitPath, 'foreign', 'utf-8');
    const existing = {
      kind: RUNTIME_SERVICE_KIND,
      label: 'com.mebular.mebular-serve.other',
      sha: 'x',
      autostart: true,
      args: ['/other/runtime/mebular.mjs', 'serve'],
      execPath: process.execPath,
      unitPath,
      installedAt: '2026-01-01T00:00:00.000Z',
      runtime: {
        version: '0.1.1',
        runtimePath: '/other/runtime/0.1.1',
        cliPath: '/other/runtime/mebular.mjs',
        provider: 'shared',
        owner: 'shared',
        cloudRoot: root,
        home: '/other/home',
      },
    };
    await mkdir(join(serviceHome, '.mebular', 'services'), { recursive: true });
    await writeFile(manifestPath(serviceHome), JSON.stringify(existing), 'utf-8');

    const result = await installRuntimeService({
      root,
      home: root,
      serviceHome,
      platform: 'linux',
      run: fakeRun().run,
    });
    expect(result).toMatchObject({ ok: false, reason: 'service_conflict' });
    const after = JSON.parse(await readFile(manifestPath(serviceHome), 'utf-8'));
    expect(after).toMatchObject({ label: existing.label, runtime: { home: '/other/home' } });
  });

  it('无 current 但有显式 App provider → 记录 owner/provider，不下载 runtime', async () => {
    const root = await tempDir('runtime-service-root-');
    const serviceHome = await tempDir('runtime-service-home-');
    const cliPath = join(root, 'app', 'mebular.mjs');
    await mkdir(join(root, 'app'), { recursive: true });
    await writeFile(cliPath, '// app cli\n', 'utf-8');
    const rec = fakeRun();
    const result = await installRuntimeService({
      root,
      home: root,
      serviceHome,
      platform: 'linux',
      run: rec.run,
      fallbackProvider: {
        path: cliPath,
        kind: 'app',
        owner: 'app',
        version: '0.1.2',
        execPath: process.execPath,
        electron: true,
      },
    });
    expect(result).toMatchObject({ ok: true, provider: 'app', owner: 'app', version: '0.1.2' });
    const manifest = JSON.parse(await readFile(manifestPath(serviceHome), 'utf-8'));
    expect(manifest.runtime).toMatchObject({ provider: 'app', owner: 'app', cliPath, runtimePath: null });
    expect(await readRuntimeCurrent(root)).toMatchObject({ source: 'missing', usable: false });
  });

  it('uninstall 拒绝移除另一个 home 的 manifest', async () => {
    const root = await tempDir('runtime-service-root-');
    const serviceHome = await tempDir('runtime-service-home-');
    const unitPath = join(serviceHome, 'foreign.plist');
    await writeFile(unitPath, 'foreign', 'utf-8');
    await mkdir(join(serviceHome, '.mebular', 'services'), { recursive: true });
    await writeFile(manifestPath(serviceHome), JSON.stringify({
      kind: RUNTIME_SERVICE_KIND,
      label: 'com.mebular.mebular-serve.other',
      unitPath,
      args: [],
      execPath: process.execPath,
      runtime: {
        version: '0.1.2',
        runtimePath: null,
        cliPath: '/other/mebular.mjs',
        provider: 'shared',
        owner: 'shared',
        cloudRoot: root,
        home: '/other/home',
      },
    }), 'utf-8');

    const result = await uninstallRuntimeService({ root, home: root, serviceHome, platform: 'linux', run: fakeRun().run });
    expect(result).toMatchObject({ ok: false, reason: 'service_conflict' });
    expect(existsSync(manifestPath(serviceHome))).toBe(true);
  });

  it('current 无效时不覆盖已有 service（同一 home 也不写半 unit）', async () => {
    const root = await tempDir('runtime-service-root-');
    const serviceHome = await tempDir('runtime-service-home-');
    const layout = await writeRuntime(root, '0.1.2');
    await writeFile(runtimeCurrentPath(root), JSON.stringify({
      v: 1,
      version: '0.1.2',
      runtimePath: layout.runtimePath,
      cliPath: layout.cliPath,
      provider: 'shared',
      owner: 'shared',
      installedAt: '2026-01-01T00:00:00.000Z',
    }), 'utf-8');
    await rm(layout.cliPath, { force: true });
    const existing = {
      kind: RUNTIME_SERVICE_KIND,
      label: 'com.mebular.mebular-serve.same',
      sha: 'x',
      autostart: true,
      args: ['/old/runtime/mebular.mjs', 'serve'],
      execPath: process.execPath,
      unitPath: '',
      installedAt: '2026-01-01T00:00:00.000Z',
      runtime: {
        version: '0.1.1',
        runtimePath: '/old/runtime/0.1.1',
        cliPath: '/old/runtime/mebular.mjs',
        provider: 'shared',
        owner: 'shared',
        cloudRoot: root,
        home: root,
      },
    };
    await mkdir(join(serviceHome, '.mebular', 'services'), { recursive: true });
    await writeFile(manifestPath(serviceHome), JSON.stringify(existing), 'utf-8');

    const result = await installRuntimeService({ root, home: root, serviceHome, platform: 'linux', run: fakeRun().run });
    expect(result).toMatchObject({ ok: false, reason: 'runtime_required' });
    const after = JSON.parse(await readFile(manifestPath(serviceHome), 'utf-8'));
    expect(after).toMatchObject({ runtime: { version: '0.1.1', cliPath: '/old/runtime/mebular.mjs' } });
  });
});
