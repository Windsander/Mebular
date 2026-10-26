// Phase 5b2a · `mebular runtime upgrade-state show` / `runtime upgrade --to latest`：
// 稳定 JSON、busy 尊重共享锁、latest 只来自共享 check 缓存（离线）。

import { describe, it, expect, afterEach } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeRuntimeCurrent } from '../../packages/mcp/src/runtime-current.mjs';
import {
  runtimeUpgradeLockPath,
  writeRuntimeUpgradeState,
} from '../../packages/mcp/src/runtime-upgrade.mjs';
import { writeRuntimeUpdateState } from '../../packages/mcp/src/runtime-update.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI = join(ROOT, 'packages', 'mcp', 'bin', 'mebular.mjs');

const tempDirs = [];

async function tempDir(prefix = 'runtime-upgrade-cli-') {
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
  return { root, runtime };
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

describe('mebular runtime upgrade-state / upgrade --to latest', () => {
  it('upgrade-state show 输出共享状态（只读，不联网）', async () => {
    const { root } = await makeRoot();
    await writeRuntimeUpgradeState(root, {
      upgrading: false,
      fromVersion: '0.1.1',
      toVersion: '0.1.2',
      startedAt: '2026-10-26T00:00:00.000Z',
      finishedAt: '2026-10-26T00:01:00.000Z',
      reason: 'http_error',
      available: true,
      entry: 'app',
    });
    const env = cleanEnv({ MEBULAR_CLOUD_ROOT: root, MEBULAR_HOME: root });
    const result = run(env, ['runtime', 'upgrade-state', 'show', '--json']);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const json = JSON.parse(result.stdout);
    expect(json).toMatchObject({
      ok: true,
      root,
      source: 'main',
      state: {
        upgrading: false,
        fromVersion: '0.1.1',
        toVersion: '0.1.2',
        reason: 'http_error',
        available: true,
        entry: 'app',
      },
    });
    expect(result.stdout).not.toMatch(/token|authorization/i);

    const bad = run(env, ['runtime', 'upgrade-state', 'nope', '--json']);
    expect(bad.status).toBe(2);
    expect(JSON.parse(bad.stdout)).toMatchObject({ ok: false, reason: 'USAGE' });
  });

  it('--to latest 无可用更新 → exit 2，不安装/不改 current', async () => {
    const { root } = await makeRoot();
    const nowIso = new Date().toISOString();
    await writeRuntimeUpdateState(root, {
      lastCheckedAt: nowIso,
      lastAttemptAt: nowIso,
      lastAttemptOk: true,
      latest: '0.1.2',
      current: '0.1.2',
      runningVersion: '0.1.2',
      available: false,
      skippedVersion: null,
      reason: null,
      failureReason: null,
    });
    const env = cleanEnv({ MEBULAR_CLOUD_ROOT: root, MEBULAR_HOME: root });
    const result = run(env, ['runtime', 'upgrade', '--to', 'latest', '--json']);
    expect(result.status).toBe(2);
    const json = JSON.parse(result.stdout);
    expect(json).toMatchObject({
      ok: false,
      action: 'upgrade',
      reason: 'up_to_date',
      to: 'latest',
      latestVersion: '0.1.2',
      available: false,
    });
    expect(json.runtimeChanged).toBe(false);
  });

  it('共享 upgrade.lock 被活进程持有 → busy exit 2，不安装', async () => {
    const { root } = await makeRoot();
    await mkdir(join(root, 'runtime'), { recursive: true });
    await writeFile(runtimeUpgradeLockPath(root), JSON.stringify({
      v: 1,
      pid: process.pid,
      token: 'held-by-other-entry',
      startedAt: new Date().toISOString(),
      command: 'upgrade',
      entry: 'plugin',
      toVersion: '0.2.0',
    }), 'utf-8');
    const env = cleanEnv({ MEBULAR_CLOUD_ROOT: root, MEBULAR_HOME: root });
    const result = run(env, ['runtime', 'upgrade', '--to', '0.2.0', '--json']);
    expect(result.status).toBe(2);
    const json = JSON.parse(result.stdout);
    expect(json).toMatchObject({
      ok: false,
      action: 'upgrade',
      reason: 'busy',
      busy: true,
      runtimeChanged: false,
      serviceChanged: false,
      lock: { pid: process.pid, entry: 'plugin' },
    });
  });

  it('usage 暴露 upgrade-state / --to latest', () => {
    const result = spawnSync(process.execPath, [CLI, '--help'], {
      env: cleanEnv(),
      encoding: 'utf-8',
      timeout: 20_000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('runtime upgrade-state show');
    expect(result.stdout).toContain('--to V|latest');
  });
});
