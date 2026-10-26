// Phase 5b1 · `mebular runtime check-update` / `update-state show` CLI：
// 稳定 JSON、退出码、usage；只读、离线（节流缓存路径不访问 registry）。

import { describe, it, expect, afterEach } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeRuntimeCurrent } from '../../packages/mcp/src/runtime-current.mjs';
import { writeRuntimeUpdateState } from '../../packages/mcp/src/runtime-update.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI = join(ROOT, 'packages', 'mcp', 'bin', 'mebular.mjs');

const tempDirs = [];

async function tempDir(prefix = 'runtime-update-cli-') {
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
  const runtime = await writeRuntime(root, '0.1.2');
  await writeRuntimeCurrent(root, {
    version: '0.1.2',
    runtimePath: runtime.runtimePath,
    cliPath: runtime.cliPath,
    provider: 'shared',
    owner: 'shared',
    installedAt: '2026-01-01T00:00:00.000Z',
  });
  return root;
}

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of [
    'MEBULAR_CLOUD_ROOT',
    'MEBULAR_CONFIG',
    'MEBULAR_STORAGE_PATH',
    'MEBULAR_USER_MASTER_KEY',
    'MEBULAR_USER_MASTER_KEY_FILE',
    'MEBULAR_ENDPOINTS_FILE',
    'MEBULAR_HTTP_PORT',
    'MEBULAR_HTTP_HOST',
  ]) {
    delete env[key];
  }
  return { ...env, ...extra };
}

function run(env, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    env,
    encoding: 'utf-8',
    timeout: 20_000,
  });
}

describe('mebular runtime check-update / update-state CLI', () => {
  it('节流缓存命中 → exit 0 + 稳定 JSON（不联网）', async () => {
    const root = await makeRoot();
    const nowIso = new Date().toISOString();
    await writeRuntimeUpdateState(root, {
      lastCheckedAt: nowIso,
      lastAttemptAt: nowIso,
      lastAttemptOk: true,
      latest: '0.2.0',
      current: '0.1.2',
      runningVersion: '0.1.2',
      available: true,
      skippedVersion: null,
      reason: null,
      failureReason: null,
    });
    const env = cleanEnv({ MEBULAR_CLOUD_ROOT: root, MEBULAR_HOME: root });

    const result = run(env, ['runtime', 'check-update', '--json']);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const json = JSON.parse(result.stdout);
    expect(json).toMatchObject({
      ok: true,
      action: 'check-update',
      command: 'check-update',
      status: 'throttled',
      decision: 'update_available',
      available: true,
      cached: true,
      throttled: true,
      currentVersion: '0.1.2',
      latestVersion: '0.2.0',
      runningVersion: '0.1.2',
    });
    expect(json.source.url).toBe('https://registry.npmjs.org/@mebular/core/latest');
    expect(result.stdout).not.toMatch(/token|secret|authorization/i);
  });

  it('update-state skip --version 写共享 skippedVersion 并同步 available=false', async () => {
    const root = await makeRoot();
    await writeRuntimeUpdateState(root, {
      lastCheckedAt: '2026-10-26T00:00:00.000Z',
      lastAttemptAt: '2026-10-26T00:00:00.000Z',
      lastAttemptOk: true,
      latest: '0.2.0',
      current: '0.1.2',
      available: true,
      skippedVersion: null,
      reason: null,
      failureReason: null,
    });
    const env = cleanEnv({ MEBULAR_CLOUD_ROOT: root, MEBULAR_HOME: root });
    const skip = run(env, ['runtime', 'update-state', 'skip', '--version', '0.2.0', '--json']);
    expect(skip.status).toBe(0);
    expect(JSON.parse(skip.stdout)).toMatchObject({
      ok: true,
      state: { skippedVersion: '0.2.0', available: false, reason: 'skipped' },
    });

    const missing = run(env, ['runtime', 'update-state', 'skip', '--json']);
    expect(missing.status).toBe(2);
    expect(JSON.parse(missing.stdout)).toMatchObject({ ok: false, reason: 'USAGE' });
  });

  it('update-state prompted --version 写共享 promptedVersion（不联网）', async () => {
    const root = await makeRoot();
    const env = cleanEnv({ MEBULAR_CLOUD_ROOT: root, MEBULAR_HOME: root });
    const prompted = run(env, ['runtime', 'update-state', 'prompted', '--version', '0.2.0', '--json']);
    expect(prompted.status).toBe(0);
    expect(JSON.parse(prompted.stdout)).toMatchObject({
      ok: true,
      state: { promptedVersion: '0.2.0', promptedAt: expect.any(String) },
    });

    const show = run(env, ['runtime', 'update-state', 'show', '--json']);
    expect(JSON.parse(show.stdout)).toMatchObject({
      state: { promptedVersion: '0.2.0' },
    });

    const missing = run(env, ['runtime', 'update-state', 'prompted', '--json']);
    expect(missing.status).toBe(2);
    expect(JSON.parse(missing.stdout)).toMatchObject({ ok: false, reason: 'USAGE' });
  });

  it('update-state show 只读诊断；非法子命令 exit 2 + USAGE', async () => {    const root = await makeRoot();
    await writeRuntimeUpdateState(root, {
      lastCheckedAt: '2026-10-26T00:00:00.000Z',
      lastAttemptAt: '2026-10-26T00:00:00.000Z',
      lastAttemptOk: true,
      latest: '0.2.0',
      current: '0.1.2',
      available: true,
    });
    const env = cleanEnv({ MEBULAR_CLOUD_ROOT: root, MEBULAR_HOME: root });

    const show = run(env, ['runtime', 'update-state', 'show', '--json']);
    expect(show.status).toBe(0);
    expect(JSON.parse(show.stdout)).toMatchObject({
      ok: true,
      root,
      source: 'main',
      state: { latest: '0.2.0', current: '0.1.2', available: true },
    });

    const bad = run(env, ['runtime', 'update-state', 'nope', '--json']);
    expect(bad.status).toBe(2);
    expect(JSON.parse(bad.stdout)).toMatchObject({ ok: false, reason: 'USAGE' });
  });

  it('上下文不可用 → exit 2 + cloud_unavailable（不联网）', async () => {
    const home = await tempDir('runtime-update-custom-home-');
    const env = cleanEnv({ MEBULAR_HOME: home });
    const result = run(env, ['runtime', 'check-update', '--json']);
    expect(result.status).toBe(2);
    const json = JSON.parse(result.stdout);
    expect(json).toMatchObject({
      ok: false,
      status: 'cloud_unavailable',
      reason: 'cloud_unavailable',
      available: false,
      cloudReason: 'custom_home',
    });
  });

  it('usage 暴露 check-update', () => {
    const result = spawnSync(process.execPath, [CLI, '--help'], {
      env: cleanEnv(),
      encoding: 'utf-8',
      timeout: 20_000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('runtime check-update');
    expect(result.stdout).toContain('runtime update-state show');
    expect(result.stdout).toContain('runtime update-state skip');
    expect(result.stdout).toContain('runtime update-state prompted');
  });
});
