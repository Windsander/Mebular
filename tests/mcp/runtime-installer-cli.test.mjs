// `mebular runtime install|reinstall` CLI：稳定 JSON、退出码、manualCommand、
// 版本校验、usage、默认版本、失败清理。
//
// 成功路径用 PATH 上的假 npm 脚本（不联网）；失败路径用空 PATH 制造 npm_missing。

import { describe, it, expect, afterEach } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_VERSION } from '../../packages/mcp/src/version.mjs';
import {
  manualRuntimeInstallCommand,
  runtimeRootPath,
  runtimeVersionPath,
  sharedRuntimeCliPath,
} from '../../packages/mcp/src/runtime-installer.mjs';
import { readRuntimeProviders } from '../../packages/mcp/src/runtime-providers.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI = join(ROOT, 'packages', 'mcp', 'bin', 'mebular.mjs');
const POSIX_IT = process.platform === 'win32' ? it.skip : it;

const tempDirs = [];

async function tempDir(prefix = 'runtime-installer-cli-') {
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
  const root = await tempDir('runtime-installer-cli-root-');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'config.json'), JSON.stringify({
    deviceId: 'device-test',
    mcp: { http: { host: '127.0.0.1', port: 17331, auth: 'none' } },
  }, null, 2), 'utf-8');
  return root;
}

async function makeEmptyPath(root) {
  const dir = join(root, 'empty-path');
  await mkdir(dir, { recursive: true });
  return dir;
}

async function makeFakeNpm() {
  const dir = await tempDir('runtime-installer-cli-npm-');
  const script = join(dir, 'npm');
  await writeFile(script, [
    '#!/bin/sh',
    'set -e',
    'prefix=""',
    'version=""',
    'while [ "$#" -gt 0 ]; do',
    '  case "$1" in',
    '    --prefix) prefix="$2"; shift 2 ;;',
    '    @mebular/core@*) version="${1#@mebular/core@}"; shift ;;',
    '    *) shift ;;',
    '  esac',
    'done',
    '[ -n "$prefix" ]',
    '[ -n "$version" ]',
    'core="$prefix/node_modules/@mebular/core"',
    'mkdir -p "$core/packages/mcp/bin"',
    'printf \'{"name":"@mebular/core","version":"%s"}\\n\' "$version" > "$core/package.json"',
    'printf \'#!/usr/bin/env node\\n// fake shared runtime cli\\n\' > "$core/packages/mcp/bin/mebular.mjs"',
    'exit 0',
    '',
  ].join('\n'), 'utf-8');
  await chmod(script, 0o755);
  return dir;
}

function envFor(root, { pathDir = null, extra = {} } = {}) {
  const env = {
    ...process.env,
    MEBULAR_CLOUD_ROOT: root,
    MEBULAR_HOME: root,
    ...extra,
  };
  delete env.npm_execpath;
  delete env.npm_config_global;
  delete env.npm_config_argv;
  delete env.npm_config_prefix;
  env.PATH = pathDir === null
    ? join(root, 'empty-path')
    : [pathDir, process.env.PATH ?? ''].filter((entry) => entry.length > 0).join(delimiter);
  return env;
}

function runCli(env, ...args) {
  return spawnSync(process.execPath, [CLI, 'runtime', ...args], {
    env,
    encoding: 'utf-8',
    timeout: 30_000,
  });
}

function parse(result) {
  return JSON.parse(result.stdout);
}

describe('mebular runtime install|reinstall CLI', () => {
  POSIX_IT('install 成功：exit 0、稳定 JSON、布局/provider 就位', async () => {
    const root = await makeRoot();
    const pathDir = await makeFakeNpm();
    const env = envFor(root, { pathDir });
    const result = runCli(env, 'install', '--json', '--version', '0.1.2');

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const json = parse(result);
    expect(json).toMatchObject({
      ok: true,
      code: null,
      reason: null,
      command: 'install',
      version: '0.1.2',
      runtimePath: runtimeVersionPath(root, '0.1.2'),
      cliPath: sharedRuntimeCliPath(root, '0.1.2'),
      runtimeInstalled: true,
      providerRegistered: true,
      manualCommand: manualRuntimeInstallCommand('0.1.2'),
    });
    expect(existsSync(json.cliPath)).toBe(true);
    expect(existsSync(join(runtimeRootPath(root), 'install.lock'))).toBe(false);
    expect(await readFile(json.cliPath, 'utf-8')).toContain('fake shared runtime');

    const providers = await readRuntimeProviders(root);
    expect(providers.registry.providers.find((provider) => provider.kind === 'shared')).toMatchObject({
      path: json.cliPath,
      version: '0.1.2',
      capabilities: ['serve'],
    });
  });

  POSIX_IT('install 未指定 --version 时使用当前 APP_VERSION', async () => {
    const root = await makeRoot();
    const pathDir = await makeFakeNpm();
    const result = runCli(envFor(root, { pathDir }), 'install', '--json');
    expect(result.status).toBe(0);
    expect(parse(result)).toMatchObject({
      ok: true,
      version: APP_VERSION,
      cliPath: sharedRuntimeCliPath(root, APP_VERSION),
    });
  });

  POSIX_IT('支持 --version=<semver> 形式', async () => {
    const root = await makeRoot();
    const pathDir = await makeFakeNpm();
    const result = runCli(envFor(root, { pathDir }), 'install', '--json', '--version=1.2.3');
    expect(result.status).toBe(0);
    expect(parse(result)).toMatchObject({ ok: true, version: '1.2.3' });
  });

  POSIX_IT('reinstall 成功：明确覆盖并保留旧目录 backup', async () => {
    const root = await makeRoot();
    const pathDir = await makeFakeNpm();
    const env = envFor(root, { pathDir });
    const first = runCli(env, 'install', '--json', '--version', '0.1.2');
    expect(first.status).toBe(0);
    const firstJson = parse(first);
    const oldCli = await readFile(firstJson.cliPath, 'utf-8');

    const second = runCli(env, 'reinstall', '--json', '--version', '0.1.2');
    expect(second.status).toBe(0);
    const json = parse(second);
    expect(json).toMatchObject({
      ok: true,
      command: 'reinstall',
      version: '0.1.2',
      reused: false,
      changed: true,
      providerRegistered: true,
    });
    expect(json.backupPath).toContain(join(root, 'runtime', '.backup-0.1.2-'));
    expect(await readFile(join(json.backupPath, 'node_modules', '@mebular', 'core', 'packages', 'mcp', 'bin', 'mebular.mjs'), 'utf-8')).toBe(oldCli);
    expect(existsSync(json.cliPath)).toBe(true);
  });

  it('npm 缺失：exit 2、npm_missing、manualCommand/version 稳定，无半安装', async () => {
    const root = await makeRoot();
    await makeEmptyPath(root);
    const result = runCli(envFor(root), 'install', '--json', '--version', '0.1.2');

    expect(result.status).toBe(2);
    const json = parse(result);
    expect(json).toMatchObject({
      ok: false,
      code: 'npm_missing',
      reason: 'npm_missing',
      version: '0.1.2',
      manualCommand: manualRuntimeInstallCommand('0.1.2'),
      runtimeInstalled: false,
      providerRegistered: false,
    });
    expect(existsSync(runtimeVersionPath(root, '0.1.2'))).toBe(false);
    expect(existsSync(join(runtimeRootPath(root), 'install.lock'))).toBe(false);
  });

  it('非法版本：exit 2、unsupported_version、manualCommand=null', async () => {
    const root = await makeRoot();
    const result = runCli(envFor(root), 'install', '--json', '--version', 'not-semver');

    expect(result.status).toBe(2);
    const json = parse(result);
    expect(json).toMatchObject({
      ok: false,
      code: 'unsupported_version',
      reason: 'unsupported_version',
      requestedVersion: 'not-semver',
      manualCommand: null,
      runtimeInstalled: false,
    });
  });

  it('usage：只列已实现 runtime 命令，未知/缺少子命令 exit 2', async () => {
    const root = await makeRoot();
    const env = envFor(root);

    const missing = runCli(env, '--json');
    expect(missing.status).toBe(2);
    const missingJson = parse(missing);
    expect(missingJson).toMatchObject({ ok: false, reason: 'USAGE' });
    expect(missingJson.message).toContain('install');
    expect(missingJson.message).toContain('reinstall');
    expect(missingJson.message).toContain('upgrade');
    expect(missingJson.message).not.toContain('check-update');

    const unknown = runCli(env, 'nope', '--json');
    expect(unknown.status).toBe(2);
    expect(parse(unknown)).toMatchObject({ ok: false, reason: 'USAGE' });
  });
});
