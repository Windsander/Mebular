// W3b：MCP Memory Runtime sidecar supervisor。
//
// 覆盖：enabled 启动 fake sidecar / disabled 零副作用 / 已有健康 attach /
// profile·home 不匹配拒绝接管 / 崩溃退避与重启上限 / 启动超时 / stop / token 注入不泄漏 /
// 可执行文件解析优先级。

import { describe, it, expect, afterEach } from '@jest/globals';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MemoryRuntimeSupervisor,
  resolveMemoryRuntimeCommand,
} from '../../packages/mcp/src/memory-runtime-supervisor.mjs';

const FAKE = fileURLToPath(new URL('./fixtures/memory-runtime-fake-sidecar.mjs', import.meta.url));
const cleanups = [];
const dirs = [];

async function tempDir(prefix = 'memory-runtime-supervisor-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()().catch(() => undefined);
  }
  while (dirs.length > 0) {
    await rm(dirs.pop(), { recursive: true, force: true });
  }
});

async function waitFor(check, { timeoutMs = 5000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error('waitFor timeout');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
  }
}

async function writeCapabilityToken(home, token = 'capability-secret-token') {
  const dir = join(home, 'memory-runtime');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(
    join(dir, 'capability-token'),
    JSON.stringify({ version: 1, token, issuedAt: Date.now(), expiresAt: 0, mcpPid: process.pid }),
    { mode: 0o600 },
  );
  return token;
}

function enabledConfig(extra = {}) {
  return {
    memoryRuntime: {
      enabled: true,
      command: FAKE,
      startTimeoutMs: 3000,
      ...extra,
    },
  };
}

function envFor(home, extra = {}) {
  return {
    MEBULAR_HOME: home,
    PATH: '',
    ...extra,
  };
}

async function fakeHealthServer() {
  const server = createServer((req, res) => {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    if (req.url?.endsWith('/health')) {
      res.end(JSON.stringify({ ok: true, state: 'ready', ready: true, degraded: false }));
      return;
    }
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  cleanups.push(() => new Promise((resolvePromise) => {
    server.close(() => resolvePromise());
    server.closeAllConnections?.();
  }));
  return server.address().port;
}

async function writeDiscovery(home, {
  port,
  pid = process.pid,
  profileId = 'default',
  cloudId = null,
  tokenFile = join(home, 'memory-runtime', 'host-token'),
} = {}) {
  const base = `http://127.0.0.1:${port}/memory-runtime/v1`;
  await writeFile(join(home, 'memory-runtime.json'), JSON.stringify({
    schema: 1,
    kind: 'mebular-memory-runtime',
    pid,
    host: '127.0.0.1',
    port,
    url: base,
    healthUrl: `${base}/health`,
    cloudId,
    profileId,
    runtimeVersion: '0.3.0',
    apiVersion: 1,
    capabilityApiVersion: 1,
    minMcpVersion: '0.3.0',
    maxMcpVersion: '0.3.x',
    state: 'ready',
    degraded: false,
    tokenFile,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    capabilities: { models: ['heuristic'] },
  }), { mode: 0o600 });
}

describe('MemoryRuntimeSupervisor：生命周期', () => {
  it('enabled：启动 fake sidecar，注入 token/home，ready 后状态可读且不泄漏 token', async () => {
    const home = await tempDir();
    const capabilityToken = await writeCapabilityToken(home, 'cap-secret-abc');
    const envOut = join(home, 'fake-env.json');
    let spawns = 0;
    const supervisor = new MemoryRuntimeSupervisor({
      home,
      config: enabledConfig(),
      env: envFor(home, { FAKE_SIDECAR_ENV_OUT: envOut }),
      profileId: () => 'default',
      mcpUrl: () => 'http://127.0.0.1:7331',
      spawnImpl: (...args) => {
        spawns += 1;
        return spawn(...args);
      },
    });
    cleanups.push(() => supervisor.dispose());

    const status = await supervisor.start();
    expect(spawns).toBe(1);
    expect(status).toMatchObject({
      enabled: true,
      state: 'ready',
      degraded: false,
      managed: true,
      attached: false,
      commandSource: 'config',
    });
    const record = JSON.parse(await readFile(envOut, 'utf-8'));
    expect(record.argv[0]).toBe('serve');
    expect(record.argv).toContain('--parent-pid');
    expect(record.env.MEBULAR_MEMORY_RUNTIME_HOME).toBe(join(home, 'memory-runtime'));
    expect(record.env.MEBULAR_CAPABILITY_TOKEN).toBe(capabilityToken);
    expect(record.env.MEBULAR_MEMORY_RUNTIME_TOKEN).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(record.env.MEBULAR_MCP_URL).toMatch(/^http:\/\/127\.0\.0\.1:/);

    const json = JSON.stringify(await supervisor.status());
    expect(json).not.toContain(capabilityToken);
    expect(json).not.toContain(record.env.MEBULAR_MEMORY_RUNTIME_TOKEN);
    expect(json).not.toMatch(/tokenFile|host-token/);

    await supervisor.stop({ includeAttached: false });
    expect(await supervisor.status()).toMatchObject({ state: 'stopped', pid: null });
  });

  it('disabled：不创建目录/token/discovery/进程', async () => {
    const home = await tempDir();
    let spawns = 0;
    const supervisor = new MemoryRuntimeSupervisor({
      home,
      config: { memoryRuntime: { enabled: false } },
      env: envFor(home),
      spawnImpl: () => { spawns += 1; throw new Error('must not spawn'); },
    });
    cleanups.push(() => supervisor.dispose());

    const status = await supervisor.start();
    expect(spawns).toBe(0);
    expect(status).toMatchObject({ enabled: false, state: 'stopped', reason: 'disabled' });
    expect(existsSync(join(home, 'memory-runtime'))).toBe(false);
    expect(existsSync(join(home, 'memory-runtime.json'))).toBe(false);
  });

  it('MEBULAR_MEMORY_RUNTIME_DISABLE=1：即使 enabled 也不自动启动', async () => {
    const home = await tempDir();
    let spawns = 0;
    const supervisor = new MemoryRuntimeSupervisor({
      home,
      config: enabledConfig(),
      env: envFor(home, { MEBULAR_MEMORY_RUNTIME_DISABLE: '1' }),
      spawnImpl: () => { spawns += 1; throw new Error('must not spawn'); },
    });
    cleanups.push(() => supervisor.dispose());

    expect(await supervisor.start()).toMatchObject({ state: 'stopped', reason: 'disabled' });
    expect(spawns).toBe(0);
    expect(existsSync(join(home, 'memory-runtime'))).toBe(false);
  });

  it('已有健康 sidecar：attach，不重复 spawn', async () => {
    const home = await tempDir();
    await writeCapabilityToken(home);
    const port = await fakeHealthServer();
    await writeDiscovery(home, { port, profileId: 'default' });
    let spawns = 0;
    const supervisor = new MemoryRuntimeSupervisor({
      home,
      config: enabledConfig(),
      env: envFor(home),
      profileId: () => 'default',
      spawnImpl: () => { spawns += 1; throw new Error('must not spawn'); },
    });
    cleanups.push(() => supervisor.dispose());

    const status = await supervisor.start();
    expect(spawns).toBe(0);
    expect(status).toMatchObject({
      state: 'ready',
      managed: false,
      attached: true,
      pid: process.pid,
      runtimeVersion: '0.3.0',
    });
    // attach 的实例不随 MCP 关闭而停止。
    await supervisor.dispose();
    expect(existsSync(join(home, 'memory-runtime.json'))).toBe(true);
  });

  it('profile / home 不匹配：拒绝接管且不 spawn', async () => {
    const home = await tempDir();
    const port = await fakeHealthServer();
    await writeDiscovery(home, { port, profileId: 'other' });
    let spawns = 0;
    const supervisor = new MemoryRuntimeSupervisor({
      home,
      config: enabledConfig(),
      env: envFor(home),
      profileId: () => 'default',
      spawnImpl: () => { spawns += 1; throw new Error('must not spawn'); },
    });
    cleanups.push(() => supervisor.dispose());

    expect(await supervisor.start()).toMatchObject({
      state: 'failed',
      error: { code: 'profile_mismatch' },
    });
    expect(spawns).toBe(0);

    const homeMismatch = await tempDir();
    await writeDiscovery(homeMismatch, {
      port,
      tokenFile: join(homeMismatch, 'other', 'host-token'),
    });
    const other = new MemoryRuntimeSupervisor({
      home: homeMismatch,
      config: enabledConfig(),
      env: envFor(homeMismatch),
      spawnImpl: () => { spawns += 1; throw new Error('must not spawn'); },
    });
    cleanups.push(() => other.dispose());
    expect(await other.start()).toMatchObject({
      state: 'failed',
      error: { code: 'home_mismatch' },
    });
    expect(spawns).toBe(0);
  });
});

describe('MemoryRuntimeSupervisor：崩溃与超时', () => {
  it('崩溃退避：最多 2 次重启后进入 restart_limit', async () => {
    const home = await tempDir();
    await writeCapabilityToken(home);
    const spawnsOut = join(home, 'spawns.txt');
    let spawns = 0;
    const supervisor = new MemoryRuntimeSupervisor({
      home,
      config: enabledConfig({ startTimeoutMs: 1000 }),
      env: envFor(home, {
        FAKE_SIDECAR_MODE: 'crash',
        FAKE_SIDECAR_EXIT_AFTER_MS: '5',
        FAKE_SIDECAR_SPAWNS_OUT: spawnsOut,
      }),
      startTimeoutMs: 1000,
      healthPollMs: 20,
      restartBackoffMs: 20,
      restartBackoffMaxMs: 40,
      maxRestartsInWindow: 2,
      spawnImpl: (...args) => {
        spawns += 1;
        return spawn(...args);
      },
    });
    cleanups.push(() => supervisor.dispose());

    await supervisor.start();
    const limited = await waitFor(async () => {
      const status = await supervisor.status();
      return status.error?.code === 'restart_limit' ? status : null;
    }, { timeoutMs: 5000 });
    expect(limited.state).toBe('failed');
    expect(spawns).toBe(3);
    expect((await readFile(spawnsOut, 'utf-8')).trim().split('\n')).toHaveLength(3);
  });

  it('启动超时：start_timeout，不阻塞调用方', async () => {
    const home = await tempDir();
    await writeCapabilityToken(home);
    let spawns = 0;
    const supervisor = new MemoryRuntimeSupervisor({
      home,
      config: enabledConfig({ startTimeoutMs: 120 }),
      env: envFor(home, { FAKE_SIDECAR_MODE: 'hang' }),
      startTimeoutMs: 120,
      healthPollMs: 20,
      maxRestartsInWindow: 0,
      spawnImpl: (...args) => {
        spawns += 1;
        return spawn(...args);
      },
    });
    cleanups.push(() => supervisor.dispose());

    const startedAt = Date.now();
    const status = await supervisor.start();
    expect(Date.now() - startedAt).toBeLessThan(2500);
    expect(spawns).toBe(1);
    expect(status).toMatchObject({
      state: 'failed',
      error: { code: 'start_timeout' },
    });
  });
});

describe('MemoryRuntimeSupervisor：命令解析', () => {
  it('优先级：memoryRuntime.command > MEBULAR_MEMORY_RUNTIME_BIN > 包内 bin', async () => {
    const home = await tempDir();
    const configured = join(home, 'configured.mjs');
    const fromEnv = join(home, 'env.mjs');
    await writeFile(configured, '// configured\n');
    await writeFile(fromEnv, '// env\n');

    expect(resolveMemoryRuntimeCommand({
      config: { memoryRuntime: { command: configured } },
      env: envFor(home, { MEBULAR_MEMORY_RUNTIME_BIN: fromEnv }),
    })).toMatchObject({ ok: true, command: configured, source: 'config' });

    expect(resolveMemoryRuntimeCommand({
      config: {},
      env: envFor(home, { MEBULAR_MEMORY_RUNTIME_BIN: fromEnv }),
    })).toMatchObject({ ok: true, command: fromEnv, source: 'env' });

    const bundled = resolveMemoryRuntimeCommand({ config: {}, env: envFor(home) });
    expect(bundled).toMatchObject({ ok: true, source: 'bundled' });
    expect(bundled.command).toContain('memory-runtime');
    expect(bundled.command).toContain('mebular-memory-runtime.mjs');
  });

  it('显式 env 指向不存在文件：not_installed，不静默回退', async () => {
    const home = await tempDir();
    expect(resolveMemoryRuntimeCommand({
      config: {},
      env: envFor(home, { MEBULAR_MEMORY_RUNTIME_BIN: join(home, 'missing') }),
    })).toMatchObject({ ok: false, source: 'env', reason: 'not_installed' });
  });
});
