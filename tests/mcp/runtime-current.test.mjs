// Phase 5a · shared runtime current 指针：原子写/读、损坏回退、多版本选择、非敏感状态。
//
// 全部离线：runtime 布局用临时目录伪造完整 @mebular/core；provider 发现注入空
// registry/self，避免读取开发机真实 App/CLI。

import { describe, it, expect, afterEach } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearRuntimeCurrent,
  readRuntimeCurrent,
  runtimeCurrentPath,
  writeRuntimeCurrent,
} from '../../packages/mcp/src/runtime-current.mjs';
import {
  registerRuntimeProvider,
} from '../../packages/mcp/src/runtime-providers.mjs';
import {
  discoverRuntimeProviders,
  runtimeStatus,
} from '../../packages/mcp/src/runtime-supervisor.mjs';
import { installRuntime } from '../../packages/mcp/src/runtime-installer.mjs';

const tempDirs = [];

async function tempDir(prefix = 'runtime-current-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop(), { recursive: true, force: true });
  }
});

async function writeRuntime(root, version, { cli = true, packageVersion = version } = {}) {
  const runtimePath = join(root, 'runtime', version);
  const core = join(runtimePath, 'node_modules', '@mebular', 'core');
  await mkdir(join(core, 'packages', 'mcp', 'bin'), { recursive: true });
  await writeFile(join(core, 'package.json'), JSON.stringify({ name: '@mebular/core', version: packageVersion }), 'utf-8');
  if (cli) await writeFile(join(core, 'packages', 'mcp', 'bin', 'mebular.mjs'), '// fake runtime\n', 'utf-8');
  return {
    runtimePath,
    cliPath: join(core, 'packages', 'mcp', 'bin', 'mebular.mjs'),
  };
}

async function makeRoot() {
  const root = await tempDir();
  await writeFile(join(root, 'config.json'), JSON.stringify({
    mcp: { http: { host: '127.0.0.1', port: 17331, auth: 'none' } },
  }), 'utf-8');
  return root;
}

function envFor(root) {
  return { PATH: process.env.PATH ?? '', MEBULAR_CLOUD_ROOT: root };
}

function fakeNpm(writeVersion) {
  return (command, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const prefix = args[args.indexOf('--prefix') + 1];
    const spec = args[args.length - 1];
    const requested = spec.slice(spec.lastIndexOf('@') + 1);
    setImmediate(async () => {
      const core = join(prefix, 'node_modules', '@mebular', 'core');
      await mkdir(join(core, 'packages', 'mcp', 'bin'), { recursive: true });
      await writeFile(join(core, 'package.json'), JSON.stringify({ name: '@mebular/core', version: writeVersion ?? requested }), 'utf-8');
      await writeFile(join(core, 'packages', 'mcp', 'bin', 'mebular.mjs'), '// fake runtime\n', 'utf-8');
      child.emit('close', 0, null);
    });
    return child;
  };
}

describe('current 指针：原子读写与损坏回退', () => {
  it('写入后读取 usable；文件权限/摘要为非敏感字段，且没有临时文件残留', async () => {
    const root = await makeRoot();
    const layout = await writeRuntime(root, '0.1.2');
    const current = await writeRuntimeCurrent(root, {
      version: '0.1.2',
      runtimePath: layout.runtimePath,
      cliPath: layout.cliPath,
      provider: 'shared',
      owner: 'shared',
      installedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(current).toMatchObject({
      v: 1,
      version: '0.1.2',
      runtimePath: layout.runtimePath,
      cliPath: layout.cliPath,
      provider: 'shared',
      owner: 'shared',
      installedAt: '2026-01-01T00:00:00.000Z',
    });
    const raw = await readFile(runtimeCurrentPath(root), 'utf-8');
    expect(raw).not.toMatch(/token|privateKey|secret/i);
    expect(existsSync(`${runtimeCurrentPath(root)}.tmp-${process.pid}`)).toBe(false);
    const state = await readRuntimeCurrent(root);
    expect(state).toMatchObject({ source: 'main', usable: true, current: { version: '0.1.2' } });
  });

  it('损坏/半成品 current 回退：不 usable、带 warning、不阻塞 status', async () => {
    const root = await makeRoot();
    await mkdir(join(root, 'runtime'), { recursive: true });
    await writeFile(runtimeCurrentPath(root), '{broken', 'utf-8');
    const corrupt = await readRuntimeCurrent(root);
    expect(corrupt.source).toBe('invalid');
    expect(corrupt.usable).toBe(false);
    expect(corrupt.warnings.length).toBeGreaterThan(0);

    const layout = await writeRuntime(root, '0.1.2', { cli: false });
    await writeRuntimeCurrent(root, {
      version: '0.1.2',
      runtimePath: layout.runtimePath,
      cliPath: layout.cliPath,
      provider: 'shared',
      owner: 'shared',
    });
    const half = await readRuntimeCurrent(root);
    expect(half).toMatchObject({ source: 'invalid', usable: false });
    expect(half.warnings.join(' ')).toContain('cli_missing');

    const status = await runtimeStatus({
      env: envFor(root),
      probeHealthFn: async () => ({ ok: false, reason: 'unreachable' }),
      probePortFn: async () => false,
      service: {
        async status() {
          return { ok: true, registered: false, running: false, label: null, autostart: null, foreign: false, unitPath: null };
        },
      },
      registryProviders: [],
      includeSelf: false,
      includeStandardApp: false,
    });
    expect(status.ok).toBe(true);
    expect(status.currentUsable).toBe(false);
    expect(status.current).toMatchObject({ version: '0.1.2' });
    expect(status.warnings.join(' ')).toContain('cli_missing');
  });

  it('clear 只删 current，不删除 runtime 目录', async () => {
    const root = await makeRoot();
    const layout = await writeRuntime(root, '0.1.2');
    await writeRuntimeCurrent(root, {
      version: '0.1.2',
      runtimePath: layout.runtimePath,
      cliPath: layout.cliPath,
      provider: 'shared',
      owner: 'shared',
    });
    expect(await clearRuntimeCurrent(root)).toBe(true);
    expect(existsSync(runtimeCurrentPath(root))).toBe(false);
    expect(existsSync(layout.cliPath)).toBe(true);
  });
});

describe('provider 发现：shared 多版本优先 current', () => {
  it('current 指向 v2 时选中 v2，即使 registry 先注册 v1', async () => {
    const root = await makeRoot();
    const v1 = await writeRuntime(root, '0.1.1');
    const v2 = await writeRuntime(root, '0.1.2');
    await registerRuntimeProvider(root, { kind: 'shared', path: v1.cliPath, version: '0.1.1', capabilities: ['serve'] });
    await registerRuntimeProvider(root, { kind: 'shared', path: v2.cliPath, version: '0.1.2', capabilities: ['serve'] });
    await writeRuntimeCurrent(root, {
      version: '0.1.2',
      runtimePath: v2.runtimePath,
      cliPath: v2.cliPath,
      provider: 'shared',
      owner: 'shared',
    });
    const discovery = await discoverRuntimeProviders({
      root,
      env: envFor(root),
      includeSelf: false,
      includeStandardApp: false,
    });
    expect(discovery.selected).toMatchObject({ kind: 'shared', path: v2.cliPath, version: '0.1.2', source: 'current' });
    expect(discovery.entries.filter((entry) => entry.kind === 'shared')).toHaveLength(2);
  });

  it('current 缺失且存在多个 shared → 按旧规则选择并 warning', async () => {
    const root = await makeRoot();
    const v1 = await writeRuntime(root, '0.1.1');
    const v2 = await writeRuntime(root, '0.1.2');
    await registerRuntimeProvider(root, { kind: 'shared', path: v1.cliPath, version: '0.1.1', capabilities: ['serve'] });
    await registerRuntimeProvider(root, { kind: 'shared', path: v2.cliPath, version: '0.1.2', capabilities: ['serve'] });
    const discovery = await discoverRuntimeProviders({
      root,
      env: envFor(root),
      includeSelf: false,
      includeStandardApp: false,
    });
    expect(discovery.selected).toMatchObject({ kind: 'shared', source: 'registry' });
    expect(discovery.warnings.join(' ')).toContain('多个 shared runtime');
  });

  it('current 无效时回退到有效 shared，并暴露 warning', async () => {
    const root = await makeRoot();
    const good = await writeRuntime(root, '0.1.2');
    const half = await writeRuntime(root, '0.1.3', { cli: false });
    await registerRuntimeProvider(root, { kind: 'shared', path: good.cliPath, version: '0.1.2', capabilities: ['serve'] });
    await writeRuntimeCurrent(root, {
      version: '0.1.3',
      runtimePath: half.runtimePath,
      cliPath: half.cliPath,
      provider: 'shared',
      owner: 'shared',
    });
    const discovery = await discoverRuntimeProviders({
      root,
      env: envFor(root),
      includeSelf: false,
      includeStandardApp: false,
    });
    expect(discovery.selected).toMatchObject({ path: good.cliPath, source: 'registry' });
    expect(discovery.currentUsable).toBe(false);
    expect(discovery.warnings.join(' ')).toContain('cli_missing');
  });

  it('App/CLI provider 仍优先于 shared current', async () => {
    const root = await makeRoot();
    const shared = await writeRuntime(root, '0.1.2');
    const cliPath = join(root, 'bin', 'mebular.mjs');
    await mkdir(join(root, 'bin'), { recursive: true });
    await writeFile(cliPath, '// cli\n', 'utf-8');
    await registerRuntimeProvider(root, { kind: 'cli', path: cliPath, version: '0.1.2', capabilities: ['serve'] });
    await writeRuntimeCurrent(root, {
      version: '0.1.2',
      runtimePath: shared.runtimePath,
      cliPath: shared.cliPath,
      provider: 'shared',
      owner: 'shared',
    });
    const discovery = await discoverRuntimeProviders({
      root,
      env: envFor(root),
      includeSelf: false,
      includeStandardApp: false,
    });
    expect(discovery.selected).toMatchObject({ kind: 'cli', path: cliPath });
  });
});

describe('installer 写 current / 失败保留旧 current', () => {
  it('安装成功后写 current；reused 幂等安装也保证 current 存在', async () => {
    const root = await makeRoot();
    const installed = await installRuntime({
      version: '0.1.2',
      root,
      env: {},
      spawnFn: fakeNpm(),
      pidAliveFn: () => false,
    });
    expect(installed).toMatchObject({ ok: true, reused: false, current: { version: '0.1.2' } });
    const state = await readRuntimeCurrent(root);
    expect(state).toMatchObject({ source: 'main', usable: true, current: { version: '0.1.2' } });
    expect(state.current.runtimePath).toBe(installed.runtimePath);

    await clearRuntimeCurrent(root);
    const reused = await installRuntime({
      version: '0.1.2',
      root,
      env: {},
      spawnFn: fakeNpm(),
      pidAliveFn: () => false,
    });
    expect(reused.ok).toBe(true);
    expect(reused.reused).toBe(true);
    expect((await readRuntimeCurrent(root)).usable).toBe(true);
  });

  it('安装失败不写/不覆盖旧 current', async () => {
    const root = await makeRoot();
    const old = await writeRuntime(root, '0.1.1');
    await writeRuntimeCurrent(root, {
      version: '0.1.1',
      runtimePath: old.runtimePath,
      cliPath: old.cliPath,
      provider: 'shared',
      owner: 'shared',
    });
    const failSpawn = (_command, _args) => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      setImmediate(() => {
        child.stderr.emit('data', Buffer.from('E404 not found'));
        child.emit('close', 1, null);
      });
      return child;
    };
    const failed = await installRuntime({
      version: '0.1.2',
      root,
      env: {},
      spawnFn: failSpawn,
      pidAliveFn: () => false,
    });
    expect(failed.ok).toBe(false);
    const state = await readRuntimeCurrent(root);
    expect(state.current).toMatchObject({ version: '0.1.1', runtimePath: old.runtimePath });
  });
});
