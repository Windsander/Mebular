// W3b：`mebular memory-runtime status|start|stop|restart` CLI。
//
// 覆盖：稳定 JSON、与 `mebular runtime` 分离、真实 fake sidecar 的 start/status/restart/stop、
// 错误码（not_installed=3、capability token 缺失=5、用法=2）、不泄漏 token、status 零副作用。

import { describe, it, expect, afterEach } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryRuntimeSupervisor, pidAlive } from '../../packages/mcp/src/memory-runtime-supervisor.mjs';
import { appendMemoryRuntimeLog } from '../../packages/mcp/src/memory-runtime-diagnostics.mjs';

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

  it('manual：热禁用/恢复与 MCP dispose 保留 PID，显式 restart/stop 轮换并停止', async () => {
    const home = await tempDir();
    await writeConfig(home, { enabled: true, command: FAKE, startTimeoutMs: 3000 });
    await writeCapabilityToken(home, 'manual-capability-a');
    const env = envFor(home, { FAKE_SIDECAR_RECOVER_ON_CAPABILITY_FILE: '1' });
    const started = runCli(env, 'start');
    expect(started.status).toBe(0);
    const first = parse(started);
    pids.push(first.pid);
    const firstDiscovery = JSON.parse(await readFile(join(home, 'memory-runtime.json'), 'utf-8'));
    const firstHostToken = JSON.parse(await readFile(firstDiscovery.tokenFile, 'utf-8')).token;
    const config = { memoryRuntime: { enabled: true, command: FAKE, startTimeoutMs: 3000 } };
    const supervisor = new MemoryRuntimeSupervisor({
      home,
      config,
      env,
      profileId: () => 'default',
    });
    expect(await supervisor.start()).toMatchObject({ state: 'ready', attached: true, managed: false });

    config.memoryRuntime.enabled = false;
    await rm(join(home, 'memory-runtime', 'capability-token'), { force: true });
    expect(await supervisor.stop({ includeAttached: false })).toMatchObject({ state: 'stopped', error: null });
    expect(pidAlive(first.pid)).toBe(true);
    const dormant = await fetch(`${firstDiscovery.url}/status`, {
      headers: { authorization: `Bearer ${firstHostToken}` },
    });
    expect((await dormant.json()).data).toMatchObject({ mode: 'mcp', state: 'stopped' });
    expect(existsSync(join(home, 'memory-runtime.json'))).toBe(false);
    const rejected = await fetch(`${firstDiscovery.url}/ingest`, {
      method: 'POST',
      headers: { authorization: `Bearer ${firstHostToken}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(rejected.status).toBe(409);
    expect((await rejected.json()).error.code).toBe('mode_mismatch');

    await writeCapabilityToken(home, 'manual-capability-b');
    const restartedMcp = new MemoryRuntimeSupervisor({
      home,
      config: { memoryRuntime: { enabled: true, command: FAKE, startTimeoutMs: 3000 } },
      env,
      profileId: () => 'default',
    });
    expect(await restartedMcp.start()).toMatchObject({ state: 'ready', attached: true, pid: first.pid });
    await restartedMcp.dispose();
    expect(pidAlive(first.pid)).toBe(true);

    const restarted = runCli(env, 'restart');
    expect(restarted.status).toBe(0);
    const second = parse(restarted);
    pids.push(second.pid);
    expect(second.pid).not.toBe(first.pid);
    const secondDiscovery = JSON.parse(await readFile(join(home, 'memory-runtime.json'), 'utf-8'));
    const secondHostToken = JSON.parse(await readFile(secondDiscovery.tokenFile, 'utf-8')).token;
    expect(secondHostToken).not.toBe(firstHostToken);
    expect(pidAlive(first.pid)).toBe(false);
    expect(runCli(env, 'stop').status).toBe(0);
    expect(pidAlive(second.pid)).toBe(false);
  }, 45000);

  it('discovery 刚删除且 sidecar 仍 immersive 时 CLI restart/stop 仍可通过 start.lock 停止', async () => {
    const home = await tempDir();
    await writeConfig(home, { enabled: true, command: FAKE, startTimeoutMs: 3000 });
    await writeCapabilityToken(home);
    const env = envFor(home, { FAKE_SIDECAR_HEARTBEAT_MS: '5000' });
    const started = runCli(env, 'start');
    expect(started.status).toBe(0);
    const first = parse(started);
    pids.push(first.pid);
    await rm(join(home, 'memory-runtime.json'), { force: true });

    const restarted = runCli(env, 'restart');
    expect(restarted.status).toBe(0);
    const second = parse(restarted);
    pids.push(second.pid);
    expect(second.pid).not.toBe(first.pid);
    expect(pidAlive(first.pid)).toBe(false);
    const secondDiscovery = JSON.parse(await readFile(join(home, 'memory-runtime.json'), 'utf-8'));
    expect(secondDiscovery.pid).toBe(second.pid);

    await rm(join(home, 'memory-runtime.json'), { force: true });
    const stopped = runCli(env, 'stop');
    expect(stopped.status).toBe(0);
    expect(parse(stopped)).toMatchObject({ ok: true, action: 'stop', state: 'stopped' });
    expect(pidAlive(second.pid)).toBe(false);
    expect(existsSync(join(home, 'memory-runtime', 'start.lock'))).toBe(false);
  }, 30000);

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

  it('logs/doctor 只输出脱敏诊断，不含 token、正文或真实 home', async () => {
    const home = await tempDir();
    await writeConfig(home, { enabled: false });
    const dataDir = join(home, 'memory-runtime');
    const secret = 'sk-cli-SECRET_SENTINEL_1234567890';
    const bodySentinel = 'RAW_CLI_BODY_SENTINEL';
    const homeSentinel = '/Users/real-user/very-private';
    await appendMemoryRuntimeLog(dataDir, {
      level: 'error',
      event: 'outbox_replay_error',
      code: 'timeout',
      stage: 'replay',
      possibleCommit: true,
      token: secret,
      authorization: `Bearer ${secret}`,
      body: { text: bodySentinel },
      message: `failed under ${homeSentinel}`,
    });
    await mkdir(join(dataDir, 'outbox', 'dead'), { recursive: true, mode: 0o700 });
    await writeFile(join(dataDir, 'outbox', 'dead', 'ob_cli_dead.json'), JSON.stringify({
      version: 1,
      id: 'ob_cli_dead',
      requestId: 'req_cli_dead',
      endpoint: '/internal-object',
      method: 'POST',
      body: { kind: 'context_checkpoint', expectedRevision: 7, token: secret, text: bodySentinel },
      createdAt: Date.now() - 10_000,
      attempts: 2,
      lastAttemptAt: Date.now() - 5_000,
      lastError: 'revision_mismatch',
      error: 'revision_mismatch',
      deadAt: Date.now() - 5_000,
      lastFailure: {
        code: 'revision_mismatch',
        at: Date.now() - 5_000,
        disposition: 'conflict',
        stage: 'replay',
        details: { currentRevision: 8, expectedRevision: 7, hostId: 'h_other' },
      },
    }), { mode: 0o600 });

    const logs = runCli(envFor(home), 'logs', '--limit', '20');
    expect(logs.status).toBe(0);
    const logsJson = parse(logs);
    expect(logsJson).toMatchObject({ ok: true, action: 'logs', count: 1 });
    expect(logs.stdout).not.toContain(secret);
    expect(logs.stdout).not.toContain(bodySentinel);
    expect(logs.stdout).not.toContain('/Users/real-user');
    expect(logsJson.entries[0]).toMatchObject({ event: 'outbox_replay_error', code: 'timeout' });

    const doctor = runCli(envFor(home), 'doctor');
    expect(doctor.status).toBe(0);
    const doctorJson = parse(doctor);
    expect(doctorJson).toMatchObject({
      ok: true,
      action: 'doctor',
      counts: { dead: 1 },
      outbox: {
        dead: 1,
        lastConflict: {
          code: 'revision_mismatch',
          expectedRevision: 7,
          currentRevision: 8,
          hostId: 'h_other',
        },
      },
    });
    expect(doctorJson.logs.files).toBeGreaterThan(0);
    expect(doctorJson.disk.totalBytes).toBeGreaterThan(0);
    expect(doctor.stdout).not.toContain(secret);
    expect(doctor.stdout).not.toContain(bodySentinel);
    expect(doctor.stdout).not.toContain('/Users/real-user');
    expect(doctor.stdout).not.toContain(home);
  });

  it('outbox list/show/rebuild/purge 是显式人工路径且保留原 revision', async () => {
    const home = await tempDir();
    await writeConfig(home, { enabled: false });
    const dataDir = join(home, 'memory-runtime');
    await mkdir(join(dataDir, 'outbox', 'dead'), { recursive: true, mode: 0o700 });
    await writeFile(join(dataDir, 'outbox', 'dead', 'ob_manual.json'), JSON.stringify({
      version: 1,
      id: 'ob_manual',
      requestId: 'req_manual_stable',
      endpoint: '/internal-object',
      method: 'POST',
      body: { kind: 'context_checkpoint', expectedRevision: 2 },
      createdAt: Date.now() - 1_000,
      attempts: 1,
      lastAttemptAt: Date.now() - 500,
      lastError: 'revision_mismatch',
      error: 'revision_mismatch',
      deadAt: Date.now() - 500,
    }), { mode: 0o600 });

    const list = runCli(envFor(home), 'outbox', 'list');
    expect(list.status).toBe(0);
    const listJson = parse(list);
    expect(listJson.items).toEqual([
      expect.objectContaining({
        id: 'ob_manual',
        requestId: 'req_manual_stable',
        operation: 'checkpoint',
        revision: 2,
        reason: 'revision_mismatch',
      }),
    ]);
    expect(list.stdout).not.toContain('"body"');

    const show = runCli(envFor(home), 'outbox', 'show', 'ob_manual');
    expect(show.status).toBe(0);
    expect(parse(show)).toMatchObject({ ok: true, item: { id: 'ob_manual', revision: 2 } });

    const rebuilt = runCli(envFor(home), 'outbox', 'rebuild', 'ob_manual');
    expect(rebuilt.status).toBe(0);
    expect(parse(rebuilt)).toMatchObject({
      ok: true,
      item: { id: 'ob_manual', requestId: 'req_manual_stable', revision: 2 },
    });
    const active = JSON.parse(await readFile(join(dataDir, 'outbox', 'ob_manual.json'), 'utf-8'));
    expect(active.body.expectedRevision).toBe(2);
    expect(active.requestId).toBe('req_manual_stable');
    expect(active.meta).toMatchObject({ manualRebuild: true });

    const purged = runCli(envFor(home), 'outbox', 'purge', 'ob_manual');
    expect(purged.status).toBe(0);
    expect(parse(purged)).toMatchObject({ ok: true, removed: 1 });
    expect(existsSync(join(dataDir, 'outbox', 'ob_manual.json'))).toBe(false);
  });

  it('rebuild 清理 finalize/reconcile 并保留更早 expiresAt', async () => {
    const home = await tempDir();
    await writeConfig(home, { enabled: false });
    const dataDir = join(home, 'memory-runtime');
    const deadline = Date.now() + 60_000;
    await mkdir(join(dataDir, 'outbox', 'dead'), { recursive: true, mode: 0o700 });
    await mkdir(join(dataDir, 'outbox', 'reconcile'), { recursive: true, mode: 0o700 });
    await writeFile(join(dataDir, 'outbox', 'dead', 'ob_finalize.json'), JSON.stringify({
      version: 1,
      id: 'ob_finalize',
      requestId: 'req_finalize',
      endpoint: '/detail',
      method: 'POST',
      body: { items: [] },
      createdAt: Date.now() - 1_000,
      expiresAt: deadline,
      attempts: 1,
      lastAttemptAt: Date.now() - 500,
      lastError: 'validation_failed',
      error: 'validation_failed',
      deadAt: Date.now() - 500,
      meta: { kind: 'detail', needsFinalize: true, finalizeOutcome: 'dead', extractionIds: ['ex_1'] },
    }), { mode: 0o600 });
    await writeFile(join(dataDir, 'outbox', 'reconcile', 'ob_finalize.json'), JSON.stringify({
      version: 1,
      id: 'ob_finalize',
      outcome: 'dead',
      attempts: 1,
      at: Date.now() - 500,
      item: { version: 1, id: 'ob_finalize' },
    }), { mode: 0o600 });

    const rebuilt = runCli(envFor(home), 'outbox', 'rebuild', 'ob_finalize');
    expect(rebuilt.status).toBe(0);
    const active = JSON.parse(await readFile(join(dataDir, 'outbox', 'ob_finalize.json'), 'utf-8'));
    expect(active.expiresAt).toBe(deadline);
    expect(active.meta).toMatchObject({ manualRebuild: true });
    expect(active.meta.needsFinalize).toBeUndefined();
    expect(active.meta.finalizeOutcome).toBeUndefined();
    expect(existsSync(join(dataDir, 'outbox', 'reconcile', 'ob_finalize.json'))).toBe(false);
    expect(existsSync(join(dataDir, 'outbox', 'dead', 'ob_finalize.json'))).toBe(false);
  });

  it('rebuild 严格拒绝裸/NaN expected-revision，合法整数才覆盖', async () => {
    const home = await tempDir();
    await writeConfig(home, { enabled: false });
    const dataDir = join(home, 'memory-runtime');
    await mkdir(join(dataDir, 'outbox', 'dead'), { recursive: true, mode: 0o700 });
    const dead = {
      version: 1,
      id: 'ob_strict_revision',
      requestId: 'req_strict_revision',
      endpoint: '/internal-object',
      method: 'POST',
      body: { kind: 'context_checkpoint', expectedRevision: 2 },
      createdAt: Date.now() - 1_000,
      expiresAt: Date.now() + 60_000,
      attempts: 1,
      lastAttemptAt: Date.now() - 500,
      lastError: 'revision_mismatch',
      error: 'revision_mismatch',
      deadAt: Date.now() - 500,
    };
    await writeFile(join(dataDir, 'outbox', 'dead', 'ob_strict_revision.json'), JSON.stringify(dead), { mode: 0o600 });

    for (const args of [
      ['outbox', 'rebuild', 'ob_strict_revision', '--expected-revision'],
      ['outbox', 'rebuild', 'ob_strict_revision', '--expected-revision=NaN'],
      ['outbox', 'rebuild', 'ob_strict_revision', '--expected-revision=1.5'],
    ]) {
      const result = runCli(envFor(home), ...args);
      expect(result.status).toBe(2);
      expect(parse(result)).toMatchObject({ ok: false, error: { code: 'usage' } });
      expect(existsSync(join(dataDir, 'outbox', 'ob_strict_revision.json'))).toBe(false);
      const unchanged = JSON.parse(await readFile(join(dataDir, 'outbox', 'dead', 'ob_strict_revision.json'), 'utf-8'));
      expect(unchanged.body.expectedRevision).toBe(2);
    }

    const valid = runCli(envFor(home), 'outbox', 'rebuild', 'ob_strict_revision', '--expected-revision', '4');
    expect(valid.status).toBe(0);
    const active = JSON.parse(await readFile(join(dataDir, 'outbox', 'ob_strict_revision.json'), 'utf-8'));
    expect(active.body.expectedRevision).toBe(4);
  });

  it('outbox 拒绝 MCP runtime 安装根、活跃 start.lock 与 in-flight lease', async () => {
    const home = await tempDir();
    await writeConfig(home, { enabled: false });
    const forbidden = join(home, 'runtime');
    await mkdir(join(forbidden, 'outbox', 'dead'), { recursive: true, mode: 0o700 });
    await writeFile(join(forbidden, 'outbox', 'dead', 'ob_forbidden.json'), JSON.stringify({
      version: 1, id: 'ob_forbidden', requestId: 'req_forbidden', endpoint: '/write',
      method: 'POST', body: {}, createdAt: Date.now(), attempts: 1, lastAttemptAt: null, lastError: null,
    }), { mode: 0o600 });
    const forbiddenEnv = envFor(home, { MEBULAR_MEMORY_RUNTIME_HOME: forbidden });
    const forbiddenResult = runCli(forbiddenEnv, 'outbox', 'rebuild', 'ob_forbidden');
    expect(forbiddenResult.status).toBe(1);
    expect(parse(forbiddenResult)).toMatchObject({ ok: false, error: { code: 'data_dir_forbidden' } });
    expect(existsSync(join(forbidden, 'outbox', 'ob_forbidden.json'))).toBe(false);

    const dataDir = join(home, 'memory-runtime');
    await mkdir(join(dataDir, 'outbox', 'dead'), { recursive: true, mode: 0o700 });
    const dead = {
      version: 1, id: 'ob_locked', requestId: 'req_locked', endpoint: '/write',
      method: 'POST', body: {}, createdAt: Date.now() - 100, attempts: 1,
      lastAttemptAt: null, lastError: null, error: 'validation_failed', deadAt: Date.now(),
    };
    await writeFile(join(dataDir, 'outbox', 'dead', 'ob_locked.json'), JSON.stringify(dead), { mode: 0o600 });
    await writeFile(join(dataDir, 'start.lock'), JSON.stringify({ pid: process.pid, command: 'serve' }), { mode: 0o600 });
    const locked = runCli(envFor(home), 'outbox', 'rebuild', 'ob_locked');
    expect(locked.status).toBe(1);
    expect(parse(locked)).toMatchObject({ ok: false, error: { code: 'sidecar_running' } });
    expect(existsSync(join(dataDir, 'outbox', 'ob_locked.json'))).toBe(false);

    await rm(join(dataDir, 'start.lock'), { force: true });
    await writeFile(join(dataDir, 'outbox', 'ob_locked.json'), JSON.stringify({
      ...dead,
      replayLeaseUntil: Date.now() + 60_000,
      replayLeaseOwner: 'owner-live',
    }), { mode: 0o600 });
    await rm(join(dataDir, 'outbox', 'dead', 'ob_locked.json'), { force: true });
    const inFlight = runCli(envFor(home), 'outbox', 'purge', 'ob_locked');
    expect(inFlight.status).toBe(1);
    expect(parse(inFlight)).toMatchObject({ ok: false, error: { code: 'outbox_in_flight' } });
    expect(existsSync(join(dataDir, 'outbox', 'ob_locked.json'))).toBe(true);
  });

  it('logs 读取 legacy 原始行时二次脱敏 /opt、/root 与 Windows 路径', async () => {
    const home = await tempDir();
    await writeConfig(home, { enabled: false });
    const logsDir = join(home, 'memory-runtime', 'logs');
    await mkdir(logsDir, { recursive: true, mode: 0o700 });
    const secret = 'sk-legacy-CLI_SECRET_1234567890';
    await appendFile(join(logsDir, 'runtime.jsonl'), `${JSON.stringify({
      ts: Date.now(),
      level: 'error',
      event: 'legacy_leak',
      token: secret,
      home: '/opt/legacy/private',
      root: '/root/.mebular',
      win: 'C:\\Users\\legacy\\AppData',
      message: 'RAW_LEGACY_BODY',
    })}\n`);

    const result = runCli(envFor(home), 'logs', '--tail', '20');
    expect(result.status).toBe(0);
    const json = parse(result);
    expect(json).toMatchObject({ ok: true, action: 'logs', count: 1 });
    expect(result.stdout).not.toContain(secret);
    expect(result.stdout).not.toContain('/opt/legacy');
    expect(result.stdout).not.toContain('/root/.mebular');
    expect(result.stdout).not.toContain('C:\\\\Users');
    expect(result.stdout).not.toContain('RAW_LEGACY_BODY');
    expect(result.stdout).toContain('[path]');
    expect(result.stdout).toContain('[redacted]');
    expect(json.entries[0]).toMatchObject({ event: 'legacy_leak' });
  });
});
