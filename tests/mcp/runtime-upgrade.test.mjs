// Phase 5a · runtime upgrade：显式升级、current/provider/service 切换与失败回滚。
//
// 离线：installer 用假 npm 写完整 runtime 布局；service 状态/安装用注入替身，
// 不执行系统服务命令、不启动 daemon。

import { describe, it, expect, afterEach } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { upgradeRuntime } from '../../packages/mcp/src/runtime-upgrade.mjs';
import { readRuntimeCurrent, writeRuntimeCurrent } from '../../packages/mcp/src/runtime-current.mjs';
import {
  readRuntimeProviders,
  registerRuntimeProvider,
} from '../../packages/mcp/src/runtime-providers.mjs';

const tempDirs = [];

async function tempDir(prefix = 'runtime-upgrade-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop(), { recursive: true, force: true });
  }
});

async function writeRuntime(root, version) {
  const runtimePath = join(root, 'runtime', version);
  const core = join(runtimePath, 'node_modules', '@mebular', 'core');
  await mkdir(join(core, 'packages', 'mcp', 'bin'), { recursive: true });
  await writeFile(join(core, 'package.json'), JSON.stringify({ name: '@mebular/core', version }), 'utf-8');
  const cliPath = join(core, 'packages', 'mcp', 'bin', 'mebular.mjs');
  await writeFile(cliPath, '// fake runtime\n', 'utf-8');
  return { runtimePath, cliPath };
}

async function makeRoot() {
  const root = await tempDir();
  await writeFile(join(root, 'config.json'), JSON.stringify({
    mcp: { http: { host: '127.0.0.1', port: 17331, auth: 'none' } },
  }), 'utf-8');
  return root;
}

async function seedOld(root) {
  const old = await writeRuntime(root, '0.1.1');
  await writeRuntimeCurrent(root, {
    version: '0.1.1',
    runtimePath: old.runtimePath,
    cliPath: old.cliPath,
    provider: 'shared',
    owner: 'shared',
    installedAt: '2026-01-01T00:00:00.000Z',
  });
  await registerRuntimeProvider(root, { kind: 'shared', path: old.cliPath, version: '0.1.1', capabilities: ['serve'] });
  return old;
}

function fakeNpm({ fail = false } = {}) {
  const calls = [];
  const spawnFn = (command, args) => {
    calls.push({ command, args: [...args] });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const prefix = args[args.indexOf('--prefix') + 1];
    const spec = args[args.length - 1];
    const version = spec.slice(spec.lastIndexOf('@') + 1);
    setImmediate(async () => {
      if (fail) {
        child.stderr.emit('data', Buffer.from('E404 not found'));
        child.emit('close', 1, null);
        return;
      }
      const core = join(prefix, 'node_modules', '@mebular', 'core');
      await mkdir(join(core, 'packages', 'mcp', 'bin'), { recursive: true });
      await writeFile(join(core, 'package.json'), JSON.stringify({ name: '@mebular/core', version }), 'utf-8');
      await writeFile(join(core, 'packages', 'mcp', 'bin', 'mebular.mjs'), '// fake runtime\n', 'utf-8');
      child.emit('close', 0, null);
    });
    return child;
  };
  return { calls, spawnFn };
}

function serviceStatus({ registered = true, runtime }) {
  return async () => ({
    ok: true,
    registered,
    running: registered,
    autostart: true,
    runtime,
    version: runtime?.version ?? null,
    runtimePath: runtime?.runtimePath ?? null,
    cliPath: runtime?.cliPath ?? null,
    provider: runtime?.provider ?? null,
    owner: runtime?.owner ?? null,
    execPath: process.execPath,
  });
}

describe('runtime upgrade', () => {
  it('成功：安装新版本、切 current/provider、service 更新并重启；旧 runtime 保留', async () => {
    const root = await makeRoot();
    const old = await seedOld(root);
    const npm = fakeNpm();
    const serviceCalls = [];
    const result = await upgradeRuntime({
      to: '0.1.2',
      root,
      home: root,
      installOptions: { spawnFn: npm.spawnFn, pidAliveFn: () => false },
      serviceStatusFn: serviceStatus({
        runtime: {
          version: '0.1.1',
          runtimePath: old.runtimePath,
          cliPath: old.cliPath,
          provider: 'shared',
          owner: 'shared',
          execPath: process.execPath,
        },
      }),
      installServiceFn: async (params) => {
        serviceCalls.push(params);
        return {
          ok: true,
          running: true,
          runtime: {
            version: params.currentState.current.version,
            runtimePath: params.currentState.current.runtimePath,
            cliPath: params.currentState.current.cliPath,
          },
          warnings: [],
        };
      },
    });
    expect(result).toMatchObject({
      ok: true,
      to: '0.1.2',
      current: { version: '0.1.2' },
      previousCurrent: { version: '0.1.1' },
      runtimeChanged: true,
      serviceChanged: true,
      serviceUpdated: true,
      daemonStarted: false,
    });
    expect(serviceCalls).toHaveLength(1);
    expect(serviceCalls[0].currentState.current).toMatchObject({ version: '0.1.2' });
    expect(existsSync(old.runtimePath)).toBe(true);
    const current = await readRuntimeCurrent(root);
    expect(current).toMatchObject({ usable: true, current: { version: '0.1.2' } });
    const providers = await readRuntimeProviders(root);
    expect(providers.registry.providers.filter((entry) => entry.kind === 'shared')).toHaveLength(1);
    expect(providers.registry.providers.find((entry) => entry.kind === 'shared')).toMatchObject({ version: '0.1.2' });
  });

  it('安装失败：旧 current/provider 保留，service 不被触碰', async () => {
    const root = await makeRoot();
    const old = await seedOld(root);
    const npm = fakeNpm({ fail: true });
    let serviceCalled = 0;
    const result = await upgradeRuntime({
      to: '0.1.2',
      root,
      home: root,
      installOptions: { spawnFn: npm.spawnFn, pidAliveFn: () => false },
      serviceStatusFn: serviceStatus({
        runtime: {
          version: '0.1.1',
          runtimePath: old.runtimePath,
          cliPath: old.cliPath,
          provider: 'shared',
          owner: 'shared',
        },
      }),
      installServiceFn: async () => {
        serviceCalled += 1;
        return { ok: true, running: true };
      },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('http_error');
    expect(serviceCalled).toBe(0);
    const current = await readRuntimeCurrent(root);
    expect(current).toMatchObject({ current: { version: '0.1.1' } });
    const providers = await readRuntimeProviders(root);
    expect(providers.registry.providers.find((entry) => entry.kind === 'shared')).toMatchObject({ version: '0.1.1' });
  });

  it('service 更新失败：回滚 current/provider，并尝试恢复旧 service', async () => {
    const root = await makeRoot();
    const old = await seedOld(root);
    const npm = fakeNpm();
    const calls = [];
    const result = await upgradeRuntime({
      to: '0.1.2',
      root,
      home: root,
      installOptions: { spawnFn: npm.spawnFn, pidAliveFn: () => false },
      serviceStatusFn: serviceStatus({
        runtime: {
          version: '0.1.1',
          runtimePath: old.runtimePath,
          cliPath: old.cliPath,
          provider: 'shared',
          owner: 'shared',
          execPath: process.execPath,
        },
      }),
      installServiceFn: async (params) => {
        calls.push(params);
        if (params.sourceOverride) return { ok: true, running: true, runtime: params.sourceOverride };
        return { ok: false, running: false, message: 'service restart failed' };
      },
    });
    expect(result).toMatchObject({
      ok: false,
      reason: 'service_upgrade_failed',
      serviceRestored: true,
      current: { version: '0.1.1' },
    });
    expect(calls).toHaveLength(2);
    expect(calls[1].sourceOverride).toMatchObject({ cliPath: old.cliPath, version: '0.1.1' });
    const current = await readRuntimeCurrent(root);
    expect(current).toMatchObject({ usable: true, current: { version: '0.1.1' } });
    const providers = await readRuntimeProviders(root);
    expect(providers.registry.providers.find((entry) => entry.kind === 'shared')).toMatchObject({
      version: '0.1.1',
      path: old.cliPath,
    });
  });

  it('无 service：只切 current/provider，不启动 daemon', async () => {
    const root = await makeRoot();
    await seedOld(root);
    const npm = fakeNpm();
    let serviceCalled = 0;
    const result = await upgradeRuntime({
      to: '0.1.2',
      root,
      home: root,
      installOptions: { spawnFn: npm.spawnFn, pidAliveFn: () => false },
      serviceStatusFn: serviceStatus({ registered: false, runtime: null }),
      installServiceFn: async () => {
        serviceCalled += 1;
        return { ok: true, running: true };
      },
    });
    expect(result).toMatchObject({
      ok: true,
      runtimeChanged: true,
      serviceChanged: false,
      daemonStarted: false,
      restartRequired: false,
    });
    expect(serviceCalled).toBe(0);
    expect((await readRuntimeCurrent(root)).current).toMatchObject({ version: '0.1.2' });
  });

  it('非法版本 / service 未知：拒绝且不改变 current', async () => {
    const root = await makeRoot();
    const old = await seedOld(root);
    const invalid = await upgradeRuntime({ to: 'latest', root, home: root });
    expect(invalid).toMatchObject({ ok: false, reason: 'unsupported_version' });

    let serviceCalled = 0;
    const unknown = await upgradeRuntime({
      to: '0.1.2',
      root,
      home: root,
      serviceStatusFn: async () => ({
        ok: false,
        reason: 'service_unknown',
        message: 'cannot read service',
      }),
      installServiceFn: async () => {
        serviceCalled += 1;
        return { ok: true };
      },
    });
    expect(unknown).toMatchObject({ ok: false, reason: 'service_unknown' });
    expect(serviceCalled).toBe(0);
    expect((await readRuntimeCurrent(root)).current).toMatchObject({
      version: '0.1.1',
      runtimePath: old.runtimePath,
    });
  });
});
