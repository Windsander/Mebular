// 共享 Runtime 安装器（Phase 4a）：布局 / 版本校验 / 原子替换 / 锁 / 失败映射 / 脱敏。
//
// 全部离线：npm 用假 spawn，安装内容由假 npm 写入临时 prefix；不访问 registry，
// 不启动真实 daemon/service。

import { describe, it, expect, afterEach } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RUNTIME_CLI_RELATIVE,
  RUNTIME_INSTALL_LOCK_FILE,
  RUNTIME_STAGING_PREFIX,
  assertRuntimeVersion,
  buildNpmInstallCommand,
  classifyNpmInstallFailure,
  installRuntime,
  manualRuntimeInstallCommand,
  reinstallRuntime,
  runtimeInstallLockPath,
  runtimeRootPath,
  runtimeVersionPath,
  sharedRuntimeCliPath,
} from '../../packages/mcp/src/runtime-installer.mjs';
import {
  readRuntimeProviders,
  registerRuntimeProvider,
} from '../../packages/mcp/src/runtime-providers.mjs';

const tempDirs = [];

async function tempDir(prefix = 'runtime-installer-') {
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

async function makeRoot() {
  const root = await tempDir('runtime-installer-root-');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'config.json'), JSON.stringify({
    deviceId: 'device-test',
    mcp: { http: { host: '127.0.0.1', port: 17331, auth: 'none' } },
  }, null, 2), 'utf-8');
  return root;
}

function prefixFromArgs(args) {
  const index = args.indexOf('--prefix');
  return index >= 0 ? args[index + 1] : null;
}

function versionFromArgs(args) {
  const spec = args[args.length - 1] ?? '';
  return spec.slice(spec.lastIndexOf('@') + 1);
}

async function writeCore(prefix, version, content) {
  const core = join(prefix, 'node_modules', '@mebular', 'core');
  await mkdir(join(core, 'packages', 'mcp', 'bin'), { recursive: true });
  await writeFile(join(core, 'package.json'), `${JSON.stringify({ name: '@mebular/core', version })}\n`, 'utf-8');
  await writeFile(join(core, 'packages', 'mcp', 'bin', 'mebular.mjs'), content, 'utf-8');
}

/**
 * 假 npm：解析 `--prefix` 与 `@mebular/core@<version>`，按配置写入安装布局后退出。
 * hang=true 时不退出，用于超时/取消；gate 用于并发测试。
 */
function fakeNpm({
  exitCode = 0,
  stdout = '',
  stderr = '',
  write = true,
  writeVersion = null,
  cliContent = '// fake shared runtime\n',
  hang = false,
  gate = null,
} = {}) {
  const calls = [];
  const killSignals = [];
  const spawnFn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.pid = 7000 + calls.length;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let finished = false;
    let timer = null;

    const finish = async () => {
      if (finished) return;
      finished = true;
      if (timer !== null) clearTimeout(timer);
      if (gate) await gate;
      if (write) {
        await writeCore(
          prefixFromArgs(args),
          writeVersion ?? versionFromArgs(args),
          cliContent,
        );
      }
      if (stdout.length > 0) child.stdout.emit('data', Buffer.from(stdout));
      if (stderr.length > 0) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('close', exitCode, null);
    };

    child.kill = (signal) => {
      killSignals.push(signal);
      if (!finished && (signal === 'SIGTERM' || signal === 'SIGKILL')) {
        finished = true;
        if (timer !== null) clearTimeout(timer);
        setImmediate(() => child.emit('close', null, signal));
      }
      return true;
    };

    if (!hang) {
      timer = setTimeout(() => {
        finish().catch((error) => child.emit('error', error));
      }, 0);
    }
    return child;
  };
  return { calls, killSignals, spawnFn };
}

async function runtimeEntries(root) {
  try {
    return await readdir(runtimeRootPath(root));
  } catch {
    return [];
  }
}

async function assertNoStagingOrLock(root) {
  const entries = await runtimeEntries(root);
  expect(entries.filter((entry) => entry.startsWith(RUNTIME_STAGING_PREFIX))).toEqual([]);
  expect(entries).not.toContain(RUNTIME_INSTALL_LOCK_FILE);
}

async function waitUntil(predicate, { timeoutMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new Error('waitUntil timeout');
}

describe('runtime 版本与 npm 命令构造', () => {
  it('严格 semver + 路径安全；非法版本抛 unsupported_version', () => {
    expect(assertRuntimeVersion('0.1.2')).toBe('0.1.2');
    expect(assertRuntimeVersion('1.2.3-beta.1+build.5')).toBe('1.2.3-beta.1+build.5');
    for (const bad of ['', 'v0.1.2', '../1.2.3', '1.2', '1.2.3/../../x', 'latest', '1.2.3 4']) {
      expect(() => assertRuntimeVersion(bad)).toThrow(/unsupported|不支持/);
      try {
        assertRuntimeVersion(bad);
      } catch (error) {
        expect(error.code).toBe('unsupported_version');
      }
    }
  });

  it('npm 命令参数固定；Windows 仅 npm.cmd 允许 shell', () => {
    const prefix = join('/tmp', 'runtime-prefix');
    const posix = buildNpmInstallCommand({
      version: '0.1.2',
      prefix,
      platform: 'darwin',
      env: {},
    });
    expect(posix.command).toBe('npm');
    expect(posix.shell).toBe(false);
    expect(posix.args).toEqual([
      'install',
      '--prefix',
      prefix,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '@mebular/core@0.1.2',
    ]);

    const win = buildNpmInstallCommand({
      version: '0.1.2',
      prefix,
      platform: 'win32',
      env: { npm_execpath: '/usr/local/lib/node_modules/npm/bin/npm-cli.js' },
    });
    expect(win.command).toBe('npm.cmd');
    expect(win.shell).toBe(true);
    expect(win.args).toEqual(posix.args);

    const winCmd = buildNpmInstallCommand({
      version: '0.1.2',
      prefix,
      platform: 'win32',
      npmPath: 'C:\\nodejs\\npm.cmd',
      env: {},
    });
    expect(winCmd.command).toBe('C:\\nodejs\\npm.cmd');
    expect(winCmd.shell).toBe(true);

    const winSpaces = buildNpmInstallCommand({
      version: '0.1.2',
      prefix: 'C:\\Users\\Jane Doe\\.mebular\\runtime\\tmp',
      platform: 'win32',
      npmPath: 'C:\\Program Files\\nodejs\\npm.cmd',
      env: {},
    });
    expect(winSpaces.command).toBe('"C:\\Program Files\\nodejs\\npm.cmd"');
    expect(winSpaces.args).toContain('"C:\\Users\\Jane Doe\\.mebular\\runtime\\tmp"');
    expect(winSpaces.shell).toBe(true);

    const js = buildNpmInstallCommand({
      version: '0.1.2',
      prefix,
      platform: 'darwin',
      npmPath: '/usr/local/lib/node_modules/npm/bin/npm-cli.js',
      env: {},
    });
    expect(js.command).toBe(process.execPath);
    expect(js.args[0]).toBe('/usr/local/lib/node_modules/npm/bin/npm-cli.js');
    expect(js.shell).toBe(false);
  });
});

describe('共享 runtime 首次安装', () => {
  it('安装到 runtime/<version>，校验 CLI/版本并注册 kind:shared provider', async () => {
    const root = await makeRoot();
    const cliProvider = join(root, 'cli-mebular.mjs');
    await writeFile(cliProvider, '// cli provider\n', 'utf-8');
    await registerRuntimeProvider(root, { kind: 'cli', path: cliProvider, version: '0.1.2' });

    const fake = fakeNpm({ cliContent: '// installed cli\n' });
    const result = await installRuntime({
      root,
      version: '0.1.2',
      spawnFn: fake.spawnFn,
      platform: 'darwin',
      npmPath: 'npm',
      now: () => '2026-01-01T00:00:00.000Z',
    });

    expect(result.ok).toBe(true);
    expect(result.code).toBe(null);
    expect(result.command).toBe('install');
    expect(result.version).toBe('0.1.2');
    expect(result.runtimePath).toBe(runtimeVersionPath(root, '0.1.2'));
    expect(result.cliPath).toBe(sharedRuntimeCliPath(root, '0.1.2'));
    expect(result.runtimeInstalled).toBe(true);
    expect(result.providerRegistered).toBe(true);
    expect(result.reused).toBe(false);
    expect(result.changed).toBe(true);
    expect(result.manualCommand).toBe(manualRuntimeInstallCommand('0.1.2'));
    expect(result.restartRequired).toBe(false);

    expect(existsSync(result.cliPath)).toBe(true);
    expect(await readFile(result.cliPath, 'utf-8')).toBe('// installed cli\n');

    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0];
    expect(call.command).toBe('npm');
    expect(call.options.shell).toBe(false);
    expect(call.args.slice(0, 2)).toEqual(['install', '--prefix']);
    expect(call.args[2]).toContain(join(root, 'runtime', RUNTIME_STAGING_PREFIX));
    expect(call.args.slice(3)).toEqual([
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '@mebular/core@0.1.2',
    ]);

    const state = await readRuntimeProviders(root);
    expect(state.registry.providers).toHaveLength(2);
    const shared = state.registry.providers.find((provider) => provider.kind === 'shared');
    expect(shared).toMatchObject({
      kind: 'shared',
      path: result.cliPath,
      version: '0.1.2',
      capabilities: ['serve'],
    });
    expect(state.registry.providers.find((provider) => provider.kind === 'cli')).toBeTruthy();

    await assertNoStagingOrLock(root);
    expect(await runtimeEntries(root)).toContain('0.1.2');
  });

  it('同版本 install 幂等：复用现有 runtime，不再次 spawn npm', async () => {
    const root = await makeRoot();
    const first = fakeNpm();
    const initial = await installRuntime({ root, version: '0.1.2', spawnFn: first.spawnFn, npmPath: 'npm' });
    expect(initial.ok).toBe(true);

    const second = fakeNpm({ cliContent: '// should not install\n' });
    const result = await installRuntime({ root, version: '0.1.2', spawnFn: second.spawnFn, npmPath: 'npm' });
    expect(result.ok).toBe(true);
    expect(result.reused).toBe(true);
    expect(result.changed).toBe(false);
    expect(result.runtimeInstalled).toBe(true);
    expect(result.providerRegistered).toBe(true);
    expect(second.calls).toHaveLength(0);
    expect(await readFile(result.cliPath, 'utf-8')).toBe('// fake shared runtime\n');
    await assertNoStagingOrLock(root);
  });

  it('目标目录损坏时备份旧目录后重建（不静默覆盖）', async () => {
    const root = await makeRoot();
    const target = runtimeVersionPath(root, '0.1.2');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'junk.txt'), 'junk', 'utf-8');

    const fake = fakeNpm();
    const result = await installRuntime({ root, version: '0.1.2', spawnFn: fake.spawnFn, npmPath: 'npm' });
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.previous).toMatchObject({ valid: false });
    expect(result.backupPath).toContain(join(root, 'runtime', '.backup-0.1.2-'));
    expect(await readFile(join(result.backupPath, 'junk.txt'), 'utf-8')).toBe('junk');
    expect(existsSync(result.cliPath)).toBe(true);
    await assertNoStagingOrLock(root);
  });

  it('检测到运行中的 daemon 时只返回 restartRequired，不杀进程', async () => {
    const root = await makeRoot();
    await writeFile(join(root, 'active.lock'), JSON.stringify({
      pid: process.pid,
      home: root,
      profileId: 'default',
      startedAt: new Date().toISOString(),
    }), 'utf-8');

    const fake = fakeNpm();
    const result = await installRuntime({ root, version: '0.1.2', spawnFn: fake.spawnFn, npmPath: 'npm' });
    expect(result.ok).toBe(true);
    expect(result.restartRequired).toBe(true);
    expect(result.running).toMatchObject({ daemonRunning: true });
    expect(existsSync(join(root, 'active.lock'))).toBe(true);
  });
});

describe('重装：备份旧 runtime、失败保留旧版本', () => {
  it('同版本 reinstall 先把旧目录 rename 为 backup，再换入新目录', async () => {
    const root = await makeRoot();
    const old = fakeNpm({ cliContent: '// old runtime\n' });
    const initial = await installRuntime({ root, version: '0.1.2', spawnFn: old.spawnFn, npmPath: 'npm' });
    expect(initial.ok).toBe(true);

    const next = fakeNpm({ cliContent: '// new runtime\n' });
    const result = await reinstallRuntime({
      root,
      version: '0.1.2',
      spawnFn: next.spawnFn,
      platform: 'darwin',
      npmPath: 'npm',
    });

    expect(result.ok).toBe(true);
    expect(result.command).toBe('reinstall');
    expect(result.reused).toBe(false);
    expect(result.changed).toBe(true);
    expect(result.previous).toMatchObject({ version: '0.1.2', valid: true });
    expect(result.backupPath).toContain(join(root, 'runtime', '.backup-0.1.2-'));
    expect(await readFile(join(result.backupPath, RUNTIME_CLI_RELATIVE), 'utf-8')).toBe('// old runtime\n');
    expect(await readFile(result.cliPath, 'utf-8')).toBe('// new runtime\n');
    expect(next.calls).toHaveLength(1);

    const state = await readRuntimeProviders(root);
    expect(state.registry.providers.filter((provider) => provider.kind === 'shared')).toHaveLength(1);
    expect(state.registry.providers.find((provider) => provider.kind === 'shared').path).toBe(result.cliPath);
    await assertNoStagingOrLock(root);
  });

  it('reinstall npm 失败：旧 runtime 与旧 provider 原样保留，无半安装', async () => {
    const root = await makeRoot();
    const old = fakeNpm({ cliContent: '// stable old runtime\n' });
    const initial = await installRuntime({ root, version: '0.1.2', spawnFn: old.spawnFn, npmPath: 'npm' });
    expect(initial.ok).toBe(true);
    const providerBefore = await readFile(join(root, 'runtime-providers.json'), 'utf-8');
    const cliBefore = await readFile(initial.cliPath, 'utf-8');

    const failing = fakeNpm({
      exitCode: 1,
      stderr: 'npm ERR! code E404\nnpm ERR! 404 Not Found - GET https://registry.npmjs.org/@mebular%2fcore\n',
    });
    const result = await reinstallRuntime({
      root,
      version: '0.1.2',
      spawnFn: failing.spawnFn,
      npmPath: 'npm',
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('http_error');
    expect(result.reason).toBe('http_error');
    expect(result.status).toBe(404);
    expect(result.runtimeInstalled).toBe(false);
    expect(result.providerRegistered).toBe(false);
    expect(result.targetPreserved).toBe(true);
    expect(result.manualCommand).toBe(manualRuntimeInstallCommand('0.1.2'));
    expect(await readFile(initial.cliPath, 'utf-8')).toBe(cliBefore);
    expect(await readFile(join(root, 'runtime-providers.json'), 'utf-8')).toBe(providerBefore);
    expect(await runtimeEntries(root)).not.toEqual(expect.arrayContaining([expect.stringMatching(/^\.backup-/)]));
    await assertNoStagingOrLock(root);
  });

  it('reinstall 安装后版本不匹配：integrity_mismatch，旧 runtime 保留', async () => {
    const root = await makeRoot();
    const old = fakeNpm({ cliContent: '// old\n' });
    const initial = await installRuntime({ root, version: '0.1.2', spawnFn: old.spawnFn, npmPath: 'npm' });
    expect(initial.ok).toBe(true);

    const wrongVersion = fakeNpm({ writeVersion: '9.9.9' });
    const result = await reinstallRuntime({
      root,
      version: '0.1.2',
      spawnFn: wrongVersion.spawnFn,
      npmPath: 'npm',
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('integrity_mismatch');
    expect(result.detail).toBe('version_mismatch');
    expect(result.installedVersion).toBe('9.9.9');
    expect(await readFile(initial.cliPath, 'utf-8')).toBe('// old\n');
    expect(await runtimeEntries(root)).not.toEqual(expect.arrayContaining([expect.stringMatching(/^\.backup-/)]));
    await assertNoStagingOrLock(root);
  });
});

describe('安装失败原因映射与清理', () => {
  const cases = [
    {
      name: 'npm 缺失（spawn ENOENT）',
      expected: 'npm_missing',
      make: () => ({
        calls: [],
        killSignals: [],
        spawnFn: () => {
          const error = new Error('spawn npm ENOENT');
          error.code = 'ENOENT';
          throw error;
        },
      }),
    },
    {
      name: '离线（DNS）',
      expected: 'offline',
      make: () => fakeNpm({
        exitCode: 1,
        stderr: 'npm ERR! code ENOTFOUND\nnpm ERR! network request to https://registry.npmjs.org/@mebular%2fcore failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org\n',
      }),
    },
    {
      name: 'registry 不可达（ECONNREFUSED）',
      expected: 'registry_unreachable',
      make: () => fakeNpm({
        exitCode: 1,
        stderr: 'npm ERR! code ECONNREFUSED\nnpm ERR! network connect ECONNREFUSED 127.0.0.1:4873\n',
      }),
    },
    {
      name: 'HTTP 404',
      expected: 'http_error',
      make: () => fakeNpm({
        exitCode: 1,
        stderr: 'npm ERR! code E404\nnpm ERR! 404 Not Found - GET https://registry.npmjs.org/@mebular%2fcore - Not found\n',
      }),
    },
    {
      name: '权限不足',
      expected: 'permission_denied',
      make: () => fakeNpm({
        exitCode: 1,
        stderr: 'npm ERR! code EACCES\nnpm ERR! syscall mkdir\nnpm ERR! Error: EACCES: permission denied, mkdir\n',
      }),
    },
    {
      name: '磁盘不足',
      expected: 'disk_full',
      make: () => fakeNpm({
        exitCode: 1,
        stderr: 'npm ERR! code ENOSPC\nnpm ERR! ENOSPC: no space left on device, write\n',
      }),
    },
    {
      name: 'integrity 校验失败',
      expected: 'integrity_mismatch',
      make: () => fakeNpm({
        exitCode: 1,
        stderr: 'npm ERR! code EINTEGRITY\nnpm ERR! sha512-abc integrity checksum failed for @mebular/core\n',
      }),
    },
  ];

  it.each(cases)('$name → $expected，且无半安装/锁残留', async ({ expected, make }) => {
    const root = await makeRoot();
    const fake = make();
    const result = await installRuntime({
      root,
      version: '0.1.2',
      spawnFn: fake.spawnFn,
      platform: 'darwin',
      npmPath: 'npm',
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe(expected);
    expect(result.reason).toBe(expected);
    expect(result.runtimeInstalled).toBe(false);
    expect(result.providerRegistered).toBe(false);
    expect(result.version).toBe('0.1.2');
    expect(result.manualCommand).toBe(manualRuntimeInstallCommand('0.1.2'));
    expect(existsSync(runtimeVersionPath(root, '0.1.2'))).toBe(false);
    await assertNoStagingOrLock(root);
  });

  it('非法 --version → unsupported_version，不 spawn npm', async () => {
    const root = await makeRoot();
    const fake = fakeNpm();
    const result = await installRuntime({
      root,
      version: 'v0.1.2',
      spawnFn: fake.spawnFn,
      npmPath: 'npm',
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('unsupported_version');
    expect(result.manualCommand).toBe(null);
    expect(result.requestedVersion).toBe('v0.1.2');
    expect(fake.calls).toHaveLength(0);
  });

  it('超时 → cancelled + timedOut，发送 SIGTERM 并清理', async () => {
    const root = await makeRoot();
    const fake = fakeNpm({ hang: true });
    const result = await installRuntime({
      root,
      version: '0.1.2',
      spawnFn: fake.spawnFn,
      npmPath: 'npm',
      timeoutMs: 30,
      killGraceMs: 10,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('cancelled');
    expect(result.timedOut).toBe(true);
    expect(fake.killSignals).toContain('SIGTERM');
    expect(fake.calls).toHaveLength(1);
    expect(existsSync(runtimeVersionPath(root, '0.1.2'))).toBe(false);
    await assertNoStagingOrLock(root);
  });

  it('取消（AbortSignal）→ cancelled，发送 SIGTERM 并清理', async () => {
    const root = await makeRoot();
    const fake = fakeNpm({ hang: true });
    const controller = new AbortController();
    const promise = installRuntime({
      root,
      version: '0.1.2',
      spawnFn: fake.spawnFn,
      npmPath: 'npm',
      signal: controller.signal,
      timeoutMs: 10_000,
      killGraceMs: 10,
    });
    await waitUntil(() => fake.calls.length === 1);
    controller.abort();
    const result = await promise;

    expect(result.ok).toBe(false);
    expect(result.code).toBe('cancelled');
    expect(result.detail).toBe('aborted');
    expect(fake.killSignals).toContain('SIGTERM');
    expect(existsSync(runtimeVersionPath(root, '0.1.2'))).toBe(false);
    await assertNoStagingOrLock(root);
  });

  it('失败日志脱敏：不输出 token/registry 凭据', async () => {
    const root = await makeRoot();
    const secret = 'super-secret-token-value';
    const fake = fakeNpm({
      exitCode: 1,
      stderr: `npm ERR! code E404\nnpm ERR! //registry.npmjs.org/:_authToken=${secret}\nnpm ERR! 404 Not Found\n`,
    });
    const result = await installRuntime({
      root,
      version: '0.1.2',
      spawnFn: fake.spawnFn,
      npmPath: 'npm',
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('_authToken=super');
    expect(result.code).toBe('http_error');
  });
});

describe('安装锁与 provider 注册表 fail-closed', () => {
  it('已有存活安装锁 → install_locked，不 spawn；不删除他人锁', async () => {
    const root = await makeRoot();
    await mkdir(runtimeRootPath(root), { recursive: true });
    const lockPath = runtimeInstallLockPath(root);
    await writeFile(lockPath, JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      version: '0.1.2',
      mode: 'install',
    }), 'utf-8');

    const fake = fakeNpm();
    const result = await installRuntime({ root, version: '0.1.2', spawnFn: fake.spawnFn, npmPath: 'npm' });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('install_locked');
    expect(result.holderPid).toBe(process.pid);
    expect(fake.calls).toHaveLength(0);
    expect(existsSync(lockPath)).toBe(true);
  });

  it('陈旧锁可回收；同时清理残留 staging 目录', async () => {
    const root = await makeRoot();
    await mkdir(runtimeRootPath(root), { recursive: true });
    await writeFile(runtimeInstallLockPath(root), JSON.stringify({
      pid: 424242,
      startedAt: new Date().toISOString(),
    }), 'utf-8');
    const stale = join(runtimeRootPath(root), `${RUNTIME_STAGING_PREFIX}stale`);
    await mkdir(stale, { recursive: true });
    await writeFile(join(stale, 'leftover.txt'), 'x', 'utf-8');

    const fake = fakeNpm();
    const result = await installRuntime({
      root,
      version: '0.1.2',
      spawnFn: fake.spawnFn,
      npmPath: 'npm',
      pidAliveFn: (pid) => pid === process.pid,
    });
    expect(result.ok).toBe(true);
    expect(existsSync(stale)).toBe(false);
    await assertNoStagingOrLock(root);
  });

  it('两个并发安装：一个持锁执行，另一个 install_locked', async () => {
    const root = await makeRoot();
    let release;
    const gate = new Promise((resolvePromise) => { release = resolvePromise; });
    const first = fakeNpm({ gate });
    const firstPromise = installRuntime({
      root,
      version: '0.1.2',
      spawnFn: first.spawnFn,
      npmPath: 'npm',
    });
    await waitUntil(() => first.calls.length === 1);

    const second = fakeNpm();
    const secondResult = await installRuntime({
      root,
      version: '0.1.2',
      spawnFn: second.spawnFn,
      npmPath: 'npm',
    });
    expect(secondResult.code).toBe('install_locked');
    expect(second.calls).toHaveLength(0);

    release();
    const firstResult = await firstPromise;
    expect(firstResult.ok).toBe(true);
    await assertNoStagingOrLock(root);
  });

  it('provider 注册表损坏 → 安装文件保留但明确 provider_registration_failed（不覆盖损坏文件）', async () => {
    const root = await makeRoot();
    const registryPath = join(root, 'runtime-providers.json');
    const corrupt = '{not-json';
    await writeFile(registryPath, corrupt, 'utf-8');

    const fake = fakeNpm();
    const result = await installRuntime({ root, version: '0.1.2', spawnFn: fake.spawnFn, npmPath: 'npm' });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('provider_registration_failed');
    expect(result.providerRegistered).toBe(false);
    expect(result.providerErrorCode).toBe('RUNTIME_PROVIDERS_INVALID');
    expect(result.runtimeInstalled).toBe(true);
    expect(result.targetPreserved).toBe(true);
    expect(existsSync(result.cliPath)).toBe(true);
    expect(await readFile(registryPath, 'utf-8')).toBe(corrupt);
  });
});

describe('classifyNpmInstallFailure（稳定分类）', () => {
  it('按错误码/stderr 分类，未知失败归入 http_error', () => {
    expect(classifyNpmInstallFailure({ spawnError: { code: 'ENOENT' } }).reason).toBe('npm_missing');
    expect(classifyNpmInstallFailure({ stderr: 'getaddrinfo ENOTFOUND registry.npmjs.org' }).reason).toBe('offline');
    expect(classifyNpmInstallFailure({ stderr: 'connect ECONNRESET' }).reason).toBe('registry_unreachable');
    expect(classifyNpmInstallFailure({ stderr: 'npm ERR! code E404' })).toMatchObject({ reason: 'http_error', status: 404 });
    expect(classifyNpmInstallFailure({ stderr: 'npm ERR! code ETARGET\nNo matching version found for @mebular/core@9.9.9' }))
      .toMatchObject({ reason: 'unsupported_version', status: 404 });
    expect(classifyNpmInstallFailure({ stderr: 'ENOSPC: no space left on device' }).reason).toBe('disk_full');
    expect(classifyNpmInstallFailure({ stderr: 'EACCES: permission denied' }).reason).toBe('permission_denied');
    expect(classifyNpmInstallFailure({ stderr: 'npm ERR! code EINTEGRITY' }).reason).toBe('integrity_mismatch');
    expect(classifyNpmInstallFailure({ exitCode: 1, stderr: 'something odd' }).reason).toBe('http_error');
  });
});
