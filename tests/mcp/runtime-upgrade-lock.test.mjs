// Phase 5b2a · 共享 runtime upgrade 锁/状态：跨入口单执行、陈旧回收、token 释放、
// 非敏感状态与失败回退。全程离线：installer/service 注入替身，不启动真实 daemon。

import { describe, it, expect, afterEach } from '@jest/globals';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RUNTIME_UPGRADE_LOCK_STALE_MS,
  RUNTIME_UPGRADE_STATE_WRITE_WARNING,
  acquireRuntimeUpgradeLock,
  inspectRuntimeUpgradeLock,
  normalizeRuntimeUpgradeState,
  publicRuntimeUpgradeState,
  readRuntimeUpgradeState,
  runtimeUpgradeLockPath,
  runtimeUpgradeStatePath,
  upgradeRuntime,
  writeRuntimeUpgradeState,
} from '../../packages/mcp/src/runtime-upgrade.mjs';
import { readRuntimeCurrent, writeRuntimeCurrent } from '../../packages/mcp/src/runtime-current.mjs';
import {
  readRuntimeProviders,
  registerExclusiveRuntimeProvider,
  registerRuntimeProvider,
} from '../../packages/mcp/src/runtime-providers.mjs';
import { readRuntimeUpdateState, writeRuntimeUpdateState } from '../../packages/mcp/src/runtime-update.mjs';

const tempDirs = [];

async function tempDir(prefix = 'runtime-upgrade-lock-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop(), { recursive: true, force: true });
  }
});

const FIXED_NOW = '2026-01-02T03:04:05.000Z';
const fixedNow = () => new Date(FIXED_NOW);

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
  const runtime = await writeRuntime(root, '0.1.1');
  await writeRuntimeCurrent(root, {
    version: '0.1.1',
    runtimePath: runtime.runtimePath,
    cliPath: runtime.cliPath,
    provider: 'shared',
    owner: 'shared',
    installedAt: '2026-01-01T00:00:00.000Z',
  });
  await registerRuntimeProvider(root, { kind: 'shared', path: runtime.cliPath, version: '0.1.1', capabilities: ['serve'] });
  return { root, runtime };
}

function fakeInstall() {
  const calls = [];
  return {
    calls,
    installRuntimeFn: async ({ version, root }) => {
      calls.push(version);
      const runtime = await writeRuntime(root, version);
      await writeRuntimeCurrent(root, {
        version,
        runtimePath: runtime.runtimePath,
        cliPath: runtime.cliPath,
        provider: 'shared',
        owner: 'shared',
        installedAt: FIXED_NOW,
      });
      await registerExclusiveRuntimeProvider(root, { kind: 'shared', path: runtime.cliPath, version, capabilities: ['serve'] });
      return { ok: true, runtimeInstalled: true, backupPath: null, warnings: [] };
    },
  };
}

const serviceNotRegistered = async () => ({
  ok: true,
  registered: false,
  running: false,
  autostart: null,
  runtime: null,
});

async function runtimeLock(root, fields = {}) {
  return acquireRuntimeUpgradeLock(root, {
    now: fixedNow,
    attempts: 1,
    entry: 'plugin',
    fromVersion: '0.1.1',
    toVersion: '0.1.2',
    ...fields,
  });
}

describe('runtime upgrade state', () => {
  it('规范化白名单字段并拒绝非法版本/reason/entry', () => {
    const normalized = normalizeRuntimeUpgradeState({
      upgrading: true,
      fromVersion: '0.1.1',
      toVersion: '0.1.2',
      startedAt: FIXED_NOW,
      finishedAt: null,
      reason: 'install_failed',
      available: true,
      entry: 'app',
      token: 'secret',
    }, { now: FIXED_NOW });
    expect(normalized).toMatchObject({
      v: 1,
      upgrading: true,
      fromVersion: '0.1.1',
      toVersion: '0.1.2',
      reason: 'install_failed',
      available: true,
      entry: 'app',
      updatedAt: FIXED_NOW,
    });
    expect(normalized.token).toBeUndefined();

    expect(() => normalizeRuntimeUpgradeState({ toVersion: 'latest' })).toThrow();
    expect(() => normalizeRuntimeUpgradeState({ reason: 'not valid!' })).toThrow();
    expect(() => normalizeRuntimeUpgradeState({ entry: 'dsh' })).toThrow();
    expect(() => normalizeRuntimeUpgradeState({ upgrading: 'yes' })).toThrow();
  });

  it('状态原子写 0600；损坏/缺失回退为空且不抛错', async () => {
    const { root } = await makeRoot();
    const written = await writeRuntimeUpgradeState(root, {
      upgrading: true,
      fromVersion: '0.1.1',
      toVersion: '0.1.2',
      startedAt: FIXED_NOW,
      entry: 'app',
      available: true,
    }, { now: FIXED_NOW });
    expect(publicRuntimeUpgradeState(written)).toMatchObject({
      upgrading: true,
      fromVersion: '0.1.1',
      toVersion: '0.1.2',
      entry: 'app',
      available: true,
    });
    const text = await readFile(runtimeUpgradeStatePath(root), 'utf-8');
    expect(text).not.toMatch(/secret|token|authorization/i);

    await writeFile(runtimeUpgradeStatePath(root), '{ not json', 'utf-8');
    const invalid = await readRuntimeUpgradeState(root);
    expect(invalid).toMatchObject({ source: 'invalid', state: { upgrading: false } });
    expect(invalid.warnings.join('\n')).toMatch(/upgrade-state 无法解析/);

    const missingRoot = await tempDir();
    const missing = await readRuntimeUpgradeState(missingRoot);
    expect(missing).toMatchObject({ source: 'missing', state: { upgrading: false, available: false } });
  });
});

describe('runtime upgrade lock', () => {
  it('wx 创建、token 释放；重复释放返回 false', async () => {
    const { root } = await makeRoot();
    const lock = await runtimeLock(root);
    expect(lock.ok).toBe(true);
    expect(existsSync(runtimeUpgradeLockPath(root))).toBe(true);
    const payload = JSON.parse(await readFile(runtimeUpgradeLockPath(root), 'utf-8'));
    expect(payload).toMatchObject({ pid: process.pid, entry: 'plugin', command: 'upgrade', toVersion: '0.1.2' });

    expect(await lock.release()).toBe(true);
    expect(existsSync(runtimeUpgradeLockPath(root))).toBe(false);
    expect(await lock.release()).toBe(false);
  });

  it('另一个活着的入口持锁 → busy（不回收）', async () => {
    const { root } = await makeRoot();
    const holder = await runtimeLock(root);
    const second = await acquireRuntimeUpgradeLock(root, {
      now: fixedNow,
      pidAliveFn: () => true,
      attempts: 1,
      entry: 'app',
    });
    expect(second).toMatchObject({
      ok: false,
      reason: 'busy',
      holder: { pid: process.pid, entry: 'plugin', toVersion: '0.1.2' },
    });
    expect(await holder.release()).toBe(true);
  });

  it('PID 不存活或超时 → 回收陈旧锁并继续', async () => {
    const { root } = await makeRoot();
    await mkdir(join(root, 'runtime'), { recursive: true });
    await writeFile(runtimeUpgradeLockPath(root), JSON.stringify({
      v: 1,
      pid: 999999,
      token: 'dead',
      startedAt: FIXED_NOW,
      command: 'upgrade',
    }), 'utf-8');

    const dead = await inspectRuntimeUpgradeLock(root, { now: fixedNow, pidAliveFn: () => false });
    expect(dead).toMatchObject({ busy: false, stale: true });
    const lock = await acquireRuntimeUpgradeLock(root, { now: fixedNow, pidAliveFn: () => false, attempts: 1 });
    expect(lock).toMatchObject({ ok: true, staleRecovered: true });
    await lock.release();

    await writeFile(runtimeUpgradeLockPath(root), JSON.stringify({
      v: 1,
      pid: process.pid,
      token: 'old',
      startedAt: '2020-01-01T00:00:00.000Z',
      command: 'upgrade',
    }), 'utf-8');
    const aged = await inspectRuntimeUpgradeLock(root, { now: fixedNow, pidAliveFn: () => true });
    expect(aged).toMatchObject({ busy: false, stale: true });
    expect(aged.holder.ageMs).toBeGreaterThan(RUNTIME_UPGRADE_LOCK_STALE_MS);
  });
});

describe('upgradeRuntime shared lock/state', () => {
  it('busy：不安装、不写 current/provider/service，返回稳定 busy', async () => {
    const { root, runtime } = await makeRoot();
    const holder = await runtimeLock(root);
    const install = fakeInstall();
    let serviceCalls = 0;
    const result = await upgradeRuntime({
      to: '0.1.2',
      root,
      home: root,
      entry: 'app',
      now: fixedNow,
      pidAliveFn: () => true,
      lockAttempts: 1,
      installRuntimeFn: install.installRuntimeFn,
      serviceStatusFn: async () => {
        serviceCalls += 1;
        return serviceNotRegistered();
      },
    });
    expect(result).toMatchObject({
      ok: false,
      action: 'upgrade',
      reason: 'busy',
      busy: true,
      runtimeChanged: false,
      serviceChanged: false,
      current: { version: '0.1.1' },
      previousCurrent: { version: '0.1.1' },
    });
    expect(install.calls).toHaveLength(0);
    expect(serviceCalls).toBe(0);
    expect((await readRuntimeCurrent(root)).current).toMatchObject({
      version: '0.1.1',
      runtimePath: runtime.runtimePath,
    });
    expect((await readRuntimeProviders(root)).registry.providers.find((p) => p.kind === 'shared')).toMatchObject({
      version: '0.1.1',
    });
    expect((await readRuntimeUpgradeState(root)).source).toBe('missing');
    expect(await holder.release()).toBe(true);
  });

  it('成功：写 upgrading→finished、entry/from/to/available，并标记 update-state 已应用', async () => {
    const { root } = await makeRoot();
    await writeRuntimeUpdateState(root, {
      lastCheckedAt: '2026-01-02T00:00:00.000Z',
      lastAttemptAt: '2026-01-02T00:00:00.000Z',
      lastAttemptOk: true,
      latest: '0.1.2',
      current: '0.1.1',
      runningVersion: '0.1.1',
      available: true,
      skippedVersion: null,
      reason: null,
      failureReason: null,
    });
    const install = fakeInstall();
    const result = await upgradeRuntime({
      to: '0.1.2',
      root,
      home: root,
      entry: 'app',
      now: fixedNow,
      installRuntimeFn: install.installRuntimeFn,
      serviceStatusFn: serviceNotRegistered,
    });
    expect(result).toMatchObject({
      ok: true,
      version: '0.1.2',
      runtimeChanged: true,
      serviceChanged: false,
      daemonStarted: false,
      upgradeState: {
        upgrading: false,
        fromVersion: '0.1.1',
        toVersion: '0.1.2',
        startedAt: FIXED_NOW,
        finishedAt: FIXED_NOW,
        reason: null,
        available: false,
        entry: 'app',
      },
    });
    expect(existsSync(runtimeUpgradeLockPath(root))).toBe(false);
    const state = await readRuntimeUpgradeState(root);
    expect(state).toMatchObject({
      source: 'main',
      state: { upgrading: false, fromVersion: '0.1.1', toVersion: '0.1.2', available: false },
    });
    const updateState = await readRuntimeUpdateState(root);
    expect(updateState.state).toMatchObject({
      latest: '0.1.2',
      current: '0.1.2',
      available: false,
      reason: null,
      failureReason: null,
      skippedVersion: null,
    });
    const providers = await readRuntimeProviders(root);
    expect(providers.registry.providers.find((p) => p.kind === 'shared')).toMatchObject({ version: '0.1.2' });
  });

  it('安装失败：旧 current/provider 保留，upgrade state 记录 reason 且 available=true', async () => {
    const { root, runtime } = await makeRoot();
    const result = await upgradeRuntime({
      to: '0.1.2',
      root,
      home: root,
      entry: 'plugin',
      now: fixedNow,
      installRuntimeFn: async () => ({ ok: false, reason: 'http_error', message: 'E404 not found' }),
      serviceStatusFn: serviceNotRegistered,
    });
    expect(result).toMatchObject({
      ok: false,
      reason: 'http_error',
      runtimeChanged: false,
      serviceChanged: false,
      upgradeState: {
        upgrading: false,
        fromVersion: '0.1.1',
        toVersion: '0.1.2',
        reason: 'http_error',
        available: true,
        entry: 'plugin',
      },
    });
    expect((await readRuntimeCurrent(root)).current).toMatchObject({
      version: '0.1.1',
      runtimePath: runtime.runtimePath,
    });
    expect((await readRuntimeState(root)).state).toMatchObject({ reason: 'http_error', available: true });
    expect(existsSync(runtimeUpgradeLockPath(root))).toBe(false);
  });

  it('state 写失败不破坏升级结果', async () => {
    const { root } = await makeRoot();
    const install = fakeInstall();
    const result = await upgradeRuntime({
      to: '0.1.2',
      root,
      home: root,
      entry: 'cli',
      now: fixedNow,
      installRuntimeFn: install.installRuntimeFn,
      serviceStatusFn: serviceNotRegistered,
      writeUpgradeStateFn: async () => {
        throw new Error('EACCES');
      },
    });
    expect(result).toMatchObject({ ok: true, version: '0.1.2' });
    expect(result.warnings).toContain(RUNTIME_UPGRADE_STATE_WRITE_WARNING);
  });

  it('service 更新失败：回滚 current/provider，state 记录 service_upgrade_failed', async () => {
    const { root, runtime } = await makeRoot();
    const install = fakeInstall();
    let serviceCalls = 0;
    const result = await upgradeRuntime({
      to: '0.1.2',
      root,
      home: root,
      entry: 'app',
      now: fixedNow,
      installRuntimeFn: install.installRuntimeFn,
      serviceStatusFn: async () => ({
        ok: true,
        registered: true,
        running: true,
        autostart: true,
        runtime: {
          version: '0.1.1',
          runtimePath: runtime.runtimePath,
          cliPath: runtime.cliPath,
          provider: 'shared',
          owner: 'shared',
          execPath: process.execPath,
        },
        version: '0.1.1',
        runtimePath: runtime.runtimePath,
        cliPath: runtime.cliPath,
        provider: 'shared',
        owner: 'shared',
        execPath: process.execPath,
      }),
      installServiceFn: async (params) => {
        serviceCalls += 1;
        if (params.sourceOverride) return { ok: true, running: true };
        return { ok: false, running: false, message: 'restart failed' };
      },
    });
    expect(result).toMatchObject({
      ok: false,
      reason: 'service_upgrade_failed',
      serviceRestored: true,
      runtimeChanged: false,
      serviceChanged: false,
      upgradeState: { reason: 'service_upgrade_failed', available: true },
    });
    expect(serviceCalls).toBe(2);
    expect((await readRuntimeCurrent(root)).current).toMatchObject({ version: '0.1.1' });
  });
});

async function readRuntimeState(root) {
  return readRuntimeUpgradeState(root);
}
