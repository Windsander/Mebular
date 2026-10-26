// `mebular runtime` CLI：稳定 JSON / 退出码 / 只读 resolve/status / Phase 1 不下载。
//
// 不启动真实守护：resolve/status 只探测；ensure 用 --start service 覆盖“未注册服务”分支，
// 该分支在 Phase 1 明确失败且不会 spawn。

import { describe, it, expect, afterEach } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeRegistry } from '../../packages/mcp/src/profiles.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI = join(ROOT, 'packages', 'mcp', 'bin', 'mebular.mjs');

const tempDirs = [];

async function tempDir(prefix = 'runtime-cli-') {
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

async function freePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const port = server.address().port;
  await new Promise((resolvePromise) => server.close(resolvePromise));
  return port;
}

function entry(id, name, home, extra = {}) {
  return {
    id,
    name,
    home,
    kind: 'delegated',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastUsedAt: null,
    masterFingerprint: null,
    deviceId: 'device-test',
    ...extra,
  };
}

async function makeRoot({ current = 'default' } = {}) {
  const root = await tempDir('runtime-cli-root-');
  const serviceHome = await tempDir('runtime-cli-service-');
  const port = await freePort();
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'config.json'), JSON.stringify({
    deviceId: 'device-test',
    mcp: { http: { host: '127.0.0.1', port, auth: 'none' } },
  }, null, 2), 'utf-8');
  await writeRegistry(root, {
    v: 1,
    current,
    profiles: [
      entry('default', '忆云 1', '.', { kind: 'root' }),
      entry('p_a', '忆云 2', 'profiles/p_a'),
    ],
  });
  return { root, serviceHome, port };
}

function envFor(root, serviceHome, { includeHome = true, extra = {} } = {}) {
  const env = {
    ...process.env,
    MEBULAR_CLOUD_ROOT: root,
    MEBULAR_SERVICE_UNIT_HOME: serviceHome,
    ...extra,
  };
  delete env.MEBULAR_HTTP_PORT;
  delete env.MEBULAR_HTTP_HOST;
  if (includeHome) env.MEBULAR_HOME = root;
  else delete env.MEBULAR_HOME;
  return env;
}

function runCli(env, ...args) {
  return spawnSync(process.execPath, [CLI, 'runtime', ...args, '--json'], {
    env,
    encoding: 'utf-8',
    timeout: 20_000,
  });
}

describe('mebular runtime CLI：resolve / status / ensure', () => {
  it('status 输出稳定 JSON（daemon down 仍 ok:true），不含 child/token', async () => {
    const { root, serviceHome, port } = await makeRoot();
    const result = runCli(envFor(root, serviceHome), 'status');
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const json = JSON.parse(result.stdout);
    expect(json).toMatchObject({
      ok: true,
      mode: 'down',
      cloudRoot: root,
      profileId: 'default',
      home: root,
      http: { host: '127.0.0.1', port },
      daemon: { status: 'down' },
    });
    expect(json).not.toHaveProperty('child');
    expect(result.stdout).not.toMatch(/token|privateKey|secret/i);
  });

  it('resolve 跟随 current profile（未显式 MEBULAR_HOME）且只读', async () => {
    const { root, serviceHome } = await makeRoot({ current: 'p_a' });
    const result = runCli(envFor(root, serviceHome, { includeHome: false }), 'resolve');
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json).toMatchObject({
      ok: true,
      mode: 'child',
      profileId: 'p_a',
      home: join(root, 'profiles', 'p_a'),
      provider: { kind: 'cli', source: 'self' },
      daemon: { status: 'down' },
      // service loader 可用：无 service 注册是正常 registered:false，不是 service_unknown。
      service: { ok: true, registered: false, running: false },
    });
    expect(json).not.toHaveProperty('child');
  });

  it('已注册 service 时 --start child 仍解析为 service（不 spawn 第二个 daemon）', async () => {
    const { root, serviceHome } = await makeRoot();
    const serviceState = await tempDir('runtime-cli-service-state-');
    await mkdir(serviceState, { recursive: true });
    await writeFile(join(serviceState, 'mebular-serve.json'), JSON.stringify({
      kind: 'mebular-serve',
      label: 'com.mebular.mebular-serve.test',
      sha: 'test',
      autostart: true,
      args: [],
      execPath: process.execPath,
      unitPath: '',
      installedAt: new Date().toISOString(),
    }), 'utf-8');

    const result = runCli(envFor(root, serviceHome, {
      extra: { MEBULAR_SERVICE_HOME: serviceState },
    }), 'resolve', '--start', 'child');
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json).toMatchObject({
      ok: true,
      mode: 'service',
      service: { registered: true },
    });
    expect(json.provider).toBe(null);
  });

  it('supervise 命令已接线：未注册 service 时输出 JSON 并 exit 2（不 spawn）', async () => {
    const { root, serviceHome } = await makeRoot();
    const result = runCli(envFor(root, serviceHome), 'supervise', '--start', 'service');
    expect(result.status).toBe(2);
    const json = JSON.parse(result.stdout);
    expect(json).toMatchObject({
      ok: false,
      mode: 'error',
      reason: 'service_not_registered',
    });
  });

  it('ensure --start service 且未注册 → exit 2 + service_not_registered（不下载/不启动）', async () => {
    const { root, serviceHome } = await makeRoot();
    const result = runCli(envFor(root, serviceHome), 'ensure', '--start', 'service');
    expect(result.status).toBe(2);
    const json = JSON.parse(result.stdout);
    expect(json).toMatchObject({
      ok: false,
      mode: 'error',
      reason: 'service_not_registered',
    });
    expect(json).not.toHaveProperty('child');
  });

  it('非法 --start / --port → exit 2 + JSON 错误', async () => {
    const { root, serviceHome } = await makeRoot();
    const badStart = runCli(envFor(root, serviceHome), 'resolve', '--start', 'nope');
    expect(badStart.status).toBe(2);
    expect(JSON.parse(badStart.stdout)).toMatchObject({ ok: false, reason: 'INVALID_START_MODE' });

    const badPort = runCli(envFor(root, serviceHome), 'resolve', '--port', '99999');
    expect(badPort.status).toBe(2);
    expect(JSON.parse(badPort.stdout)).toMatchObject({ ok: false, reason: 'INVALID_PORT' });
  });
});
