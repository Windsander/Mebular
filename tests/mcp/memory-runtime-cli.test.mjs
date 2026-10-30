// W3b：`mebular memory-runtime status|start|stop|restart` CLI。
//
// 覆盖：稳定 JSON、与 `mebular runtime` 分离、真实 fake sidecar 的 start/status/restart/stop、
// 错误码（not_installed=3、capability token 缺失=5、用法=2）、不泄漏 token、status 零副作用。

import { describe, it, expect, afterEach } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pidAlive } from '../../packages/mcp/src/memory-runtime-supervisor.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI = join(ROOT, 'packages', 'mcp', 'bin', 'mebular.mjs');
const FAKE = join(ROOT, 'tests', 'mcp', 'fixtures', 'memory-runtime-fake-sidecar.mjs');

const dirs = [];
const pids = [];

async function tempDir(prefix = 'memory-runtime-cli-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const pid of pids.splice(0)) {
    if (!pidAlive(pid)) continue;
    try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ }
    const deadline = Date.now() + 1500;
    while (pidAlive(pid) && Date.now() < deadline) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
    if (pidAlive(pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
    }
  }
  while (dirs.length > 0) await rm(dirs.pop(), { recursive: true, force: true });
});

async function writeConfig(home, memoryRuntime) {
  await writeFile(join(home, 'config.json'), JSON.stringify({ memoryRuntime }, null, 2), 'utf-8');
}

async function writeCapabilityToken(home, token = 'capability-cli-secret') {
  const dir = join(home, 'memory-runtime');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(
    join(dir, 'capability-token'),
    JSON.stringify({ version: 1, token, issuedAt: Date.now(), expiresAt: 0, mcpPid: process.pid }),
    { mode: 0o600 },
  );
  return token;
}

function envFor(home, extra = {}) {
  const env = {
    ...process.env,
    PATH: '',
    MEBULAR_HOME: home,
    ...extra,
  };
  delete env.MEBULAR_CAPABILITY_TOKEN;
  delete env.MEBULAR_MEMORY_RUNTIME_DISABLE;
  return env;
}

function runCli(env, ...args) {
  return spawnSync(process.execPath, [CLI, 'memory-runtime', ...args, '--json'], {
    env,
    encoding: 'utf-8',
    timeout: 20_000,
  });
}

function parse(result) {
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout);
}

describe('mebular memory-runtime CLI', () => {
  it('status：无 sidecar 时稳定 JSON，不创建 memory-runtime 目录', async () => {
    const home = await tempDir();
    const result = runCli(envFor(home), 'status');
    expect(result.status).toBe(0);
    const json = parse(result);
    expect(json).toMatchObject({
      ok: true,
      kind: 'memory-runtime',
      action: 'status',
      enabled: false,
      state: 'stopped',
      reason: 'disabled',
    });
    expect(existsSync(join(home, 'memory-runtime'))).toBe(false);
    expect(JSON.stringify(json)).not.toMatch(/token|secret/i);
  });

  it('start → status → restart → stop：真实进程生命周期，JSON 稳定且不泄漏 token', async () => {
    const home = await tempDir();
    const envOut = join(home, 'fake-env.json');
    const spawnsOut = join(home, 'spawns.txt');
    await writeConfig(home, { enabled: true, command: FAKE, startTimeoutMs: 3000 });
    const capabilityToken = await writeCapabilityToken(home);
    const env = envFor(home, {
      FAKE_SIDECAR_ENV_OUT: envOut,
      FAKE_SIDECAR_SPAWNS_OUT: spawnsOut,
    });

    const started = runCli(env, 'start');
    expect(started.status).toBe(0);
    const first = parse(started);
    expect(first).toMatchObject({
      ok: true,
      kind: 'memory-runtime',
      action: 'start',
      enabled: true,
      state: 'ready',
      managed: true,
      attached: false,
    });
    expect(typeof first.pid).toBe('number');
    pids.push(first.pid);
    const fakeEnv = JSON.parse(await readFile(envOut, 'utf-8'));
    expect(fakeEnv.argv[0]).toBe('serve');
    expect(fakeEnv.argv).not.toContain('--parent-pid');
    expect(fakeEnv.env.MEBULAR_CAPABILITY_TOKEN).toBe(capabilityToken);
    expect(fakeEnv.env.MEBULAR_MEMORY_RUNTIME_TOKEN).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(started.stdout).not.toContain(fakeEnv.env.MEBULAR_MEMORY_RUNTIME_TOKEN);
    expect(started.stdout).not.toMatch(/tokenFile|host-token/);

    const again = runCli(env, 'start');
    expect(again.status).toBe(0);
    expect(parse(again)).toMatchObject({
      ok: true,
      action: 'start',
      state: 'ready',
      pid: first.pid,
      managed: false,
      attached: true,
    });

    const status = runCli(env, 'status');
    expect(status.status).toBe(0);
    const statusJson = parse(status);
    expect(statusJson).toMatchObject({
      ok: true,
      action: 'status',
      state: 'ready',
      pid: first.pid,
      managed: false,
      attached: true,
    });
    expect(status.stdout).not.toContain(fakeEnv.env.MEBULAR_CAPABILITY_TOKEN);

    const restarted = runCli(env, 'restart');
    expect(restarted.status).toBe(0);
    const second = parse(restarted);
    expect(second).toMatchObject({ ok: true, action: 'restart', state: 'ready', managed: true });
    expect(second.pid).not.toBe(first.pid);
    pids.push(second.pid);
    expect(pidAlive(first.pid)).toBe(false);

    const stopped = runCli(env, 'stop');
    expect(stopped.status).toBe(0);
    const stopJson = parse(stopped);
    expect(stopJson).toMatchObject({ ok: true, action: 'stop', state: 'stopped', pid: null });
    expect(pidAlive(second.pid)).toBe(false);
    expect(existsSync(join(home, 'memory-runtime.json'))).toBe(false);
    expect((await readFile(spawnsOut, 'utf-8')).trim().split('\n')).toHaveLength(2);
  });

  it('start 未安装 sidecar：退出码 3', async () => {
    const home = await tempDir();
    await writeConfig(home, { enabled: true, command: join(home, 'missing-sidecar.mjs') });
    const result = runCli(envFor(home), 'start');
    expect(result.status).toBe(3);
    const json = parse(result);
    expect(json).toMatchObject({ ok: false, state: 'not_installed', error: { code: 'not_installed' } });
  });

  it('start 缺少 capability token：退出码 5，不 spawn', async () => {
    const home = await tempDir();
    await writeConfig(home, { enabled: true, command: FAKE, startTimeoutMs: 500 });
    const result = runCli(envFor(home), 'start');
    expect(result.status).toBe(5);
    const json = parse(result);
    expect(json).toMatchObject({ ok: false, state: 'failed', error: { code: 'capability_token_missing' } });
    expect(existsSync(join(home, 'memory-runtime.json'))).toBe(false);
  });

  it('已有存活启动锁但 discovery 未就绪：退出码 7（sidecar_starting）', async () => {
    const home = await tempDir();
    await writeConfig(home, { enabled: true, command: FAKE, startTimeoutMs: 120 });
    await writeCapabilityToken(home);
    await mkdir(join(home, 'memory-runtime'), { recursive: true, mode: 0o700 });
    await writeFile(join(home, 'memory-runtime', 'start.lock'), JSON.stringify({
      pid: process.pid,
      port: null,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      cloudId: null,
      profileId: null,
      command: 'serve',
    }), { mode: 0o600 });

    const result = runCli(envFor(home), 'start');
    expect(result.status).toBe(7);
    const json = parse(result);
    expect(json).toMatchObject({ ok: false, state: 'failed', error: { code: 'sidecar_starting' } });
  });

  it('stop 无实例幂等成功；未知动作退出码 2', async () => {
    const home = await tempDir();
    const stop = runCli(envFor(home), 'stop');
    expect(stop.status).toBe(0);
    expect(parse(stop)).toMatchObject({ ok: true, action: 'stop', state: 'stopped' });

    const usage = runCli(envFor(home), 'bogus');
    expect(usage.status).toBe(2);
    expect(parse(usage)).toMatchObject({ ok: false, error: { code: 'usage' } });
  });
});
