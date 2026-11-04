// sidecar 进程集成：serve 启动、写 discovery、health/status、优雅停止；
// capability 握手（fake MCP）与版本不兼容退出码。

import { describe, it, expect, afterEach, jest } from '@jest/globals';
import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import {
  getSidecarStatus,
  getSidecarVersion,
  isSidecarProcessAlive,
  startSidecar,
  type SidecarHandle,
} from '../../src/sidecar/main.js';
import { bearer } from './helpers.js';

const homes: string[] = [];
const handles: SidecarHandle[] = [];
const fakeServers: Server[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.stop().catch(() => undefined);
  for (const child of children.splice(0)) {
    if (!isSidecarProcessAlive(child.pid ?? -1)) continue;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill('SIGTERM');
    });
  }
  for (const server of fakeServers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function temp() {
  const home = await mkdtemp(join(tmpdir(), 'mebular-memory-runtime-main-'));
  homes.push(home);
  return home;
}

async function waitFor(check: () => Promise<unknown>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() >= deadline) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function fakeCapability(version: Record<string, unknown>, identity: Record<string, unknown> = {}): Promise<string> {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    res.setHeader('content-type', 'application/json');
    if (path.endsWith('/version')) {
      res.end(JSON.stringify({
        ok: true,
        requestId: 'req_fake',
        capabilityVersion: 1,
        data: version,
        warnings: [],
        degraded: false,
      }));
      return;
    }
    if (path.endsWith('/status')) {
      res.end(JSON.stringify({
        ok: true,
        requestId: 'req_fake',
        capabilityVersion: 1,
        data: { initialized: true, identity },
        warnings: [],
        degraded: false,
      }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false, error: { code: 'not_found', message: 'no', retryable: false } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  fakeServers.push(server);
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/internal/memory/v1`;
}

const VERSION_OK = {
  capabilityApiVersion: 1,
  schemaVersion: 1,
  mcpVersion: '0.3.1',
  coreVersion: '0.3.1',
  features: {},
  limits: {},
};

async function controlledCapability(token: string) {
  const state = {
    enabled: true,
    token,
    writeGate: null as Promise<void> | null,
    writeStarted: 0,
    writeSuccessEvenWhenDisabled: false,
    writeResults: null as Array<Record<string, unknown>> | null,
    detailGate: null as Promise<void> | null,
    detailStarted: 0,
    requests: [] as Array<{ path: string; authorization: string | null }>,
  };
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const authorization = typeof req.headers.authorization === 'string' ? req.headers.authorization : null;
    state.requests.push({ path, authorization });
    res.setHeader('content-type', 'application/json');
    const fail = (status: number, code: string) => {
      res.statusCode = status;
      res.end(JSON.stringify({ ok: false, error: { code, message: code, retryable: false } }));
    };
    if (!state.enabled) {
      fail(404, 'capability_disabled');
      return;
    }
    if (authorization !== `Bearer ${state.token}`) {
      fail(401, 'capability_token_invalid');
      return;
    }
    if (path.endsWith('/version')) {
      res.end(JSON.stringify({ ok: true, requestId: 'req_fake', data: VERSION_OK, warnings: [], degraded: false }));
      return;
    }
    if (path.endsWith('/status')) {
      res.end(JSON.stringify({
        ok: true,
        requestId: 'req_fake',
        data: { initialized: true, identity: { profileId: 'default' } },
        warnings: [],
        degraded: false,
      }));
      return;
    }
    if (path.endsWith('/detail') && state.detailGate) {
      state.detailStarted += 1;
      await state.detailGate;
      if (!state.enabled) {
        fail(404, 'capability_disabled');
        return;
      }
    }
    if (state.writeGate) {
      state.writeStarted += 1;
      await state.writeGate;
      if (!state.enabled && !state.writeSuccessEvenWhenDisabled) {
        fail(404, 'capability_disabled');
        return;
      }
    }
    if (path.endsWith('/write') && state.writeResults) {
      res.end(JSON.stringify({
        ok: true,
        requestId: 'req_fake',
        data: {
          results: state.writeResults,
          created: state.writeResults.filter((result) => result.status === 'created').length,
          duplicates: state.writeResults.filter((result) => result.status === 'duplicate').length,
          failed: state.writeResults.filter((result) => result.status === 'failed').length,
          partial: state.writeResults.some((result) => result.status === 'failed'),
        },
        warnings: [],
        degraded: false,
      }));
      return;
    }
    res.end(JSON.stringify({ ok: true, requestId: 'req_fake', data: { created: 1 }, warnings: [], degraded: false }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  fakeServers.push(server);
  const address = server.address() as AddressInfo;
  return { state, url: `http://127.0.0.1:${address.port}/internal/memory/v1` };
}

async function startRealSidecarProcess(home: string, capabilityUrl: string, token: string) {
  const dataDir = join(home, 'memory-runtime');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await writeFile(join(dataDir, 'capability-token'), JSON.stringify({
    version: 1, token, issuedAt: Date.now(), expiresAt: 0, mcpPid: process.pid,
  }), { mode: 0o600 });
  const moduleUrl = pathToFileURL(join(process.cwd(), 'packages/memory-runtime/dist/sidecar/main.js')).href;
  const script = `
    import { startSidecar } from ${JSON.stringify(moduleUrl)};
    const handle = await startSidecar({ heartbeatMs: 50, env: process.env });
    process.once('SIGTERM', () => { void handle.stop(); });
    process.once('SIGINT', () => { void handle.stop(); });
    await handle.wait();
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MEBULAR_HOME: home,
      MEBULAR_MEMORY_RUNTIME_HOME: dataDir,
      MEBULAR_CAPABILITY_URL: capabilityUrl,
      MEBULAR_CAPABILITY_TOKEN: token,
    },
    stdio: 'ignore',
  });
  children.push(child);
  await waitFor(async () => {
    try {
      return JSON.parse(await readFile(join(home, 'memory-runtime.json'), 'utf8')).pid === child.pid;
    } catch {
      return false;
    }
  });
  return {
    child,
    discovery: JSON.parse(await readFile(join(home, 'memory-runtime.json'), 'utf8')) as any,
  };
}

describe('memory-runtime sidecar process', () => {
  it('serve（跳过握手）写 discovery、提供 health/status、停止后清理 token 与 discovery', async () => {
    const home = await temp();
    const handle = await startSidecar({
      home,
      port: 0,
      skipHandshake: true,
      hostToken: 'host-token',
      env: { MEBULAR_HOME: home },
    });
    handles.push(handle);

    expect(handle.paths.dataDir).toBe(join(home, 'memory-runtime'));
    expect(handle.discovery.pid).toBe(process.pid);
    expect(handle.discovery.port).toBe(handle.server.listenedPort);
    expect(handle.discovery.state).toBe('ready');
    expect(handle.discovery.mode).toBe('immersive');
    expect(handle.discovery.degraded).toBe(false);
    expect(handle.discovery.capabilities.ingest).toBe(true);
    const lock = JSON.parse(await readFile(join(home, 'memory-runtime', 'start.lock'), 'utf8'));
    // 同一实例的 lock 与 discovery 必须共享 startedAt，强杀后才能确认清理归属。
    expect(lock.startedAt).toBe(handle.discovery.startedAt);
    if (process.platform !== 'win32') {
      expect((await stat(join(home, 'memory-runtime.json'))).mode & 0o777).toBe(0o600);
      expect((await stat(join(home, 'memory-runtime', 'host-token'))).mode & 0o777).toBe(0o600);
    }

    const health = await fetch(handle.healthUrl);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, state: 'ready', ready: true });

    const noAuth = await fetch(`${handle.url}/status`);
    expect(noAuth.status).toBe(401);

    const status = await fetch(`${handle.url}/status`, { headers: bearer('host-token') });
    expect(status.status).toBe(200);
    const body = await status.json() as any;
    expect(body.data.mode).toBe('immersive');
    expect(body.data.counts).toMatchObject({ stagingChunks: 0, traces: 0, outbox: 0 });
    expect(body.data.details).toMatchObject({
      available: true,
      staging: { hours: 24 },
      cache: { days: 30 },
    });
    expect(body.data.identity.hostId).toMatch(/^h_/);

    const version = await fetch(`${handle.url}/version`, { headers: bearer('host-token') });
    expect(version.status).toBe(200);
    expect((await version.json() as any).data.mode).toBe('immersive');

    await handle.stop();
    await handle.stop();
    handles.splice(handles.indexOf(handle), 1);

    await expect(stat(join(home, 'memory-runtime.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(home, 'memory-runtime', 'host-token'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await getSidecarStatus({ home, env: { MEBULAR_HOME: home } })).toMatchObject({
      discovered: false,
      state: 'stopped',
    });
  });

  it('serve 握手成功时从 capability status 读取 cloudId/profileId', async () => {
    const home = await temp();
    const capabilityUrl = await fakeCapability(VERSION_OK, { cloudId: 'cl_fake', profileId: 'default', hostId: 'h_fake' });

    const handle = await startSidecar({
      home,
      port: 0,
      env: {
        MEBULAR_HOME: home,
        MEBULAR_CAPABILITY_URL: capabilityUrl,
        MEBULAR_CAPABILITY_TOKEN: 'cap-token',
      },
    });
    handles.push(handle);

    expect(handle.capability.reachable).toBe(true);
    expect(handle.capability.version).toBe(1);
    expect(handle.discovery.cloudId).toBe('cl_fake');
    expect(handle.discovery.profileId).toBe('default');
    expect(handle.discovery.degraded).toBe(false);

    const status = await fetch(`${handle.url}/status`, { headers: bearer(handle.server.hostToken) });
    const body = await status.json() as any;
    expect(body.data.capability).toMatchObject({ reachable: true, version: 1 });
    expect(body.data.identity).toMatchObject({ cloudId: 'cl_fake', profileId: 'default', hostId: 'h_fake' });

    await handle.stop();
    handles.splice(handles.indexOf(handle), 1);
  });

  it('版本不兼容退出码 2，且不留下 discovery/host token', async () => {
    const home = await temp();
    const capabilityUrl = await fakeCapability({ ...VERSION_OK, mcpVersion: '0.4.0' });

    await expect(startSidecar({
      home,
      port: 0,
      env: {
        MEBULAR_HOME: home,
        MEBULAR_CAPABILITY_URL: capabilityUrl,
        MEBULAR_CAPABILITY_TOKEN: 'cap-token',
      },
    })).rejects.toMatchObject({ code: 'version_incompatible', exitCode: 2 });

    await expect(stat(join(home, 'memory-runtime.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(home, 'memory-runtime', 'host-token'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('未提供 capability token 时退出码 5', async () => {
    const home = await temp();
    await expect(startSidecar({ home, port: 0, env: { MEBULAR_HOME: home } }))
      .rejects.toMatchObject({ code: 'capability_token_missing', exitCode: 5 });
  });

  it('撤销后 dormant 且零新增副作用；轮换文件恢复，queued 始终不 flush', async () => {
    const home = await temp();
    const dataDir = join(home, 'memory-runtime');
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const capabilityTokenPath = join(dataDir, 'capability-token');
    const writeCapability = async (token: string) => writeFile(capabilityTokenPath, JSON.stringify({
      version: 1, token, issuedAt: Date.now(), expiresAt: 0, mcpPid: process.pid,
    }), { mode: 0o600 });
    await writeCapability('token-a');
    const capability = await controlledCapability('token-a');
    const handle = await startSidecar({
      home,
      port: 0,
      heartbeatMs: 50,
      hostToken: 'host-token',
      env: {
        MEBULAR_HOME: home,
        MEBULAR_CAPABILITY_URL: capability.url,
        MEBULAR_CAPABILITY_TOKEN: 'token-a',
      },
    });
    handles.push(handle);
    await handle.local.outbox.enqueue({
      id: 'ob_disabled',
      requestId: 'req_disabled',
      endpoint: '/write',
      body: { value: 'pending' },
      createdAt: Date.now(),
    });
    const before = await handle.local.outbox.stats();
    const stopSpy = jest.spyOn(handle.settlement.replayer, 'stop');
    const extractSpy = jest.spyOn(handle.model, 'extractCandidates');

    capability.state.enabled = false;
    await waitFor(async () => JSON.parse(await readFile(join(home, 'memory-runtime.json'), 'utf8')).mode === 'mcp');
    const dormantStatus = await fetch(`${handle.url}/status`, { headers: bearer('host-token') });
    expect((await dormantStatus.json() as any).data).toMatchObject({
      mode: 'mcp', capability: { reachable: false, error: 'capability_disabled' },
    });
    const dormantVersion = await fetch(`${handle.url}/version`, { headers: bearer('host-token') });
    expect((await dormantVersion.json() as any).data).toMatchObject({
      mode: 'mcp', capabilities: { ingest: false, checkpoint: false, self: false },
    });
    const rejectedPaths: Array<[string, string]> = [
      ['POST', 'ingest'],
      ['POST', 'recall'],
      ['POST', 'context'],
      ['POST', 'compact'],
      ['PUT', 'checkpoints/thread'],
      ['PUT', 'self/agent'],
    ];
    for (const [method, path] of rejectedPaths) {
      const response = await fetch(`${handle.url}/${path}`, {
        method,
        headers: { ...bearer('host-token'), 'content-type': 'application/json' },
        body: '{}',
      });
      expect(response.status).toBe(409);
      expect((await response.json() as any).error.code).toBe('mode_mismatch');
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await handle.local.outbox.stats()).toEqual(before);
    expect(extractSpy).not.toHaveBeenCalled();
    expect(capability.state.requests.some((request) => request.path.endsWith('/write'))).toBe(false);

    capability.state.token = 'token-b';
    capability.state.enabled = true;
    await writeCapability('token-b');
    await waitFor(async () => JSON.parse(await readFile(join(home, 'memory-runtime.json'), 'utf8')).mode === 'immersive');
    const status = await fetch(`${handle.url}/status`, { headers: bearer('host-token') });
    expect((await status.json() as any).data.capability).toMatchObject({ reachable: true, error: null });
    expect(capability.state.requests.some((request) => request.path.endsWith('/version')
      && request.authorization === 'Bearer token-b')).toBe(true);

    await handle.stop();
    handles.splice(handles.indexOf(handle), 1);
    expect(stopSpy).toHaveBeenCalled();
    for (const call of stopSpy.mock.calls) expect(call[0]).toEqual({ flushMs: 0 });
    expect(await handle.local.outbox.stats()).toEqual(before);
    expect(capability.state.requests.some((request) => request.path.endsWith('/write'))).toBe(false);
  }, 15000);

  it('默认 5000ms heartbeat：撤销后旧 URL/token 零副作用，重启用才恢复准入', async () => {
    const home = await temp();
    const capability = await controlledCapability('heartbeat-token');
    const handle = await startSidecar({
      home,
      port: 0,
      // 不缩短 heartbeat：真实默认值必须能在 supervisor 的有界等待内进入 dormant。
      hostToken: 'host-token',
      env: {
        MEBULAR_HOME: home,
        MEBULAR_CAPABILITY_URL: capability.url,
        MEBULAR_CAPABILITY_TOKEN: 'heartbeat-token',
      },
    });
    handles.push(handle);
    await handle.local.outbox.enqueue({
      id: 'ob_heartbeat',
      requestId: 'req_heartbeat',
      endpoint: '/write',
      body: { value: 'pending' },
      createdAt: Date.now(),
    });
    const before = await handle.local.outbox.stats();
    const extractSpy = jest.spyOn(handle.model, 'extractCandidates');
    // 停掉定时重放，确保本用例只观察“禁用后”的 replay 副作用。
    await handle.settlement.replayer.stop({ flushMs: 0 });

    capability.state.enabled = false;
    await waitFor(async () => {
      const discovery = JSON.parse(await readFile(join(home, 'memory-runtime.json'), 'utf8'));
      return discovery.mode === 'mcp' && discovery.state === 'stopped';
    }, 15_000);
    const requestsBefore = capability.state.requests.length;
    expect(extractSpy).not.toHaveBeenCalled();
    expect(await handle.local.outbox.stats()).toEqual(before);
    // dormant 下即使直接触发 replay，也不得产生新的 capability 写或删除 pending。
    await handle.settlement.replayer.replayOnce();
    expect(await handle.local.outbox.stats()).toEqual(before);
    expect(capability.state.requests.slice(requestsBefore)
      .some((request) => request.path.endsWith('/write'))).toBe(false);

    for (const [method, path] of [
      ['POST', 'ingest'],
      ['POST', 'recall'],
      ['POST', 'context'],
    ] as Array<[string, string]>) {
      const response = await fetch(`${handle.url}/${path}`, {
        method,
        headers: { ...bearer('host-token'), 'content-type': 'application/json' },
        body: '{}',
      });
      expect(response.status).toBe(409);
      expect((await response.json() as any).error.code).toBe('mode_mismatch');
    }

    capability.state.token = 'heartbeat-token-b';
    await writeFile(join(home, 'memory-runtime', 'capability-token'), JSON.stringify({
      version: 1, token: 'heartbeat-token-b', issuedAt: Date.now(), expiresAt: 0, mcpPid: process.pid,
    }), { mode: 0o600 });
    capability.state.enabled = true;
    await waitFor(async () => {
      const discovery = JSON.parse(await readFile(join(home, 'memory-runtime.json'), 'utf8'));
      return discovery.mode === 'immersive';
    }, 15_000);
    const resumed = await fetch(`${handle.url}/status`, { headers: bearer('host-token') });
    expect((await resumed.json() as any).data.capability).toMatchObject({ reachable: true, error: null });
  }, 45000);

  it('capability 401 刷新只重读文件：文件被撤销后不复用 stale env，也不复活 token 文件', async () => {
    const home = await temp();
    const dataDir = join(home, 'memory-runtime');
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const tokenPath = join(dataDir, 'capability-token');
    await writeFile(tokenPath, JSON.stringify({
      version: 1, token: 'token-a', issuedAt: Date.now(), expiresAt: 0, mcpPid: process.pid,
    }), { mode: 0o600 });
    const capability = await controlledCapability('token-a');
    const handle = await startSidecar({
      home,
      port: 0,
      heartbeatMs: 50,
      hostToken: 'host-token',
      env: {
        MEBULAR_HOME: home,
        MEBULAR_CAPABILITY_URL: capability.url,
        MEBULAR_CAPABILITY_TOKEN: 'token-a',
      },
    });
    handles.push(handle);
    await rm(tokenPath, { force: true });
    capability.state.token = 'token-b';
    await waitFor(async () => {
      const status = await fetch(`${handle.url}/status`, { headers: bearer('host-token') });
      return (await status.json() as any).data.capability.error === 'capability_token_invalid';
    });
    await expect(stat(tokenPath)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 12000);

  it('能力仍有效时同一 token 不自动恢复；新 capability 代际才允许 resume', async () => {
    const home = await temp();
    const dataDir = join(home, 'memory-runtime');
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const tokenPath = join(dataDir, 'capability-token');
    await writeFile(tokenPath, JSON.stringify({
      version: 1, token: 'resume-token-a', issuedAt: Date.now(), expiresAt: 0, mcpPid: process.pid,
    }), { mode: 0o600 });
    const capability = await controlledCapability('resume-token-a');
    const handle = await startSidecar({
      home,
      port: 0,
      heartbeatMs: 50,
      hostToken: 'host-token',
      env: {
        MEBULAR_HOME: home,
        MEBULAR_CAPABILITY_URL: capability.url,
        MEBULAR_CAPABILITY_TOKEN: 'resume-token-a',
      },
    });
    handles.push(handle);
    capability.state.enabled = false;
    await waitFor(async () => {
      try {
        const discovery = JSON.parse(await readFile(join(home, 'memory-runtime.json'), 'utf8'));
        return discovery.mode === 'mcp' && discovery.state === 'stopped';
      } catch {
        return false;
      }
    }, 15000);
    // 同一 token 仍然有效：旧实现会在下一个 heartbeat 自动恢复 immersive。
    capability.state.enabled = true;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const dormant = await fetch(`${handle.url}/status`, { headers: bearer('host-token') });
    expect((await dormant.json() as any).data.mode).toBe('mcp');
    const stillDormant = JSON.parse(await readFile(join(home, 'memory-runtime.json'), 'utf8'));
    expect(stillDormant.mode).toBe('mcp');

    capability.state.token = 'resume-token-b';
    await writeFile(tokenPath, JSON.stringify({
      version: 1, token: 'resume-token-b', issuedAt: Date.now(), expiresAt: 0, mcpPid: process.pid,
    }), { mode: 0o600 });
    await waitFor(async () => {
      try {
        return JSON.parse(await readFile(join(home, 'memory-runtime.json'), 'utf8')).mode === 'immersive';
      } catch {
        return false;
      }
    }, 15000);
    const resumed = await fetch(`${handle.url}/status`, { headers: bearer('host-token') });
    expect((await resumed.json() as any).data.capability.reachable).toBe(true);
  }, 30000);

  it('多 chunk staging 在逐块写入边界响应 drain，不得继续增长或发布 clean stopped', async () => {
    const home = await temp();
    const capability = await controlledCapability('staging-token');
    const handle = await startSidecar({
      home,
      port: 0,
      heartbeatMs: 50,
      hostToken: 'host-token',
      env: {
        MEBULAR_HOME: home,
        MEBULAR_CAPABILITY_URL: capability.url,
        MEBULAR_CAPABILITY_TOKEN: 'staging-token',
      },
    });
    handles.push(handle);
    const originalPut = handle.local.store.putStagingChunk.bind(handle.local.store);
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    let secondStarted = false;
    handle.local.store.putStagingChunk = async (...args: Parameters<typeof originalPut>) => {
      calls += 1;
      if (calls === 2) {
        secondStarted = true;
        await gate;
      }
      return originalPut(...args);
    };
    const pending = fetch(`${handle.url}/ingest`, {
      method: 'POST',
      headers: { ...bearer('host-token'), 'content-type': 'application/json' },
      body: JSON.stringify({
        agentId: 'opencode',
        extractor: 'host',
        chunks: [
          { role: 'user', text: '第一个 chunk' },
          { role: 'assistant', text: '第二个 chunk' },
        ],
      }),
    });
    await waitFor(async () => secondStarted);
    const before = await handle.local.stats();
    capability.state.enabled = false;
    await waitFor(async () => {
      const discovery = JSON.parse(await readFile(join(home, 'memory-runtime.json'), 'utf8'));
      return discovery.mode === 'mcp';
    });
    release();
    const response = await pending;
    expect(response.status).toBe(409);
    expect((await response.json() as any).error.code).toBe('mode_mismatch');
    const after = await handle.local.stats();
    expect(after.stagingChunks).toBe(before.stagingChunks);
  }, 15000);

  it('record 成功后 detail 阶段遇到 drain：返回 409 mode_mismatch，不得伪装 200 partial', async () => {
    const home = await temp();
    const capability = await controlledCapability('detail-drain-token');
    capability.state.writeResults = [{
      status: 'created',
      id: 'mem_detail_1',
      kind: 'observation',
      domain: 'agent:opencode',
    }];
    let release = () => {};
    capability.state.detailGate = new Promise<void>((resolve) => { release = resolve; });
    const handle = await startSidecar({
      home,
      port: 0,
      heartbeatMs: 50,
      hostToken: 'host-token',
      env: {
        MEBULAR_HOME: home,
        MEBULAR_CAPABILITY_URL: capability.url,
        MEBULAR_CAPABILITY_TOKEN: 'detail-drain-token',
      },
    });
    handles.push(handle);
    const pending = fetch(`${handle.url}/ingest`, {
      method: 'POST',
      headers: { ...bearer('host-token'), 'content-type': 'application/json' },
      body: JSON.stringify({
        agentId: 'opencode',
        chunks: [{ role: 'user', text: '项目使用 pnpm workspace' }],
        candidates: [{ kind: 'observation', content: { content: '项目使用 pnpm workspace' } }],
      }),
    });
    await waitFor(async () => capability.state.detailStarted === 1);
    capability.state.enabled = false;
    await waitFor(async () => {
      const discovery = JSON.parse(await readFile(join(home, 'memory-runtime.json'), 'utf8'));
      return discovery.mode === 'mcp';
    });
    release();
    const response = await pending;
    expect(response.status).toBe(409);
    expect((await response.json() as any).error.code).toBe('mode_mismatch');
  }, 15000);

  it('in-flight replay 撤销后不重写 retry 元数据，clean 前原始 outbox 字节不变', async () => {
    const home = await temp();
    const capability = await controlledCapability('replay-token');
    const handle = await startSidecar({
      home,
      port: 0,
      heartbeatMs: 50,
      hostToken: 'host-token',
      env: {
        MEBULAR_HOME: home,
        MEBULAR_CAPABILITY_URL: capability.url,
        MEBULAR_CAPABILITY_TOKEN: 'replay-token',
      },
    });
    handles.push(handle);
    await handle.local.outbox.enqueue({
      id: 'ob_in_flight', requestId: 'req_in_flight', endpoint: '/write', body: { value: 'pending' },
    });
    const itemPath = join(handle.paths.dataDir, 'outbox', 'ob_in_flight.json');
    const before = await readFile(itemPath, 'utf8');
    let release = () => {};
    capability.state.writeGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const replay = handle.settlement.replayer.replayOnce();
    await waitFor(async () => capability.state.writeStarted === 1);
    capability.state.enabled = false;
    release();
    await replay;
    await waitFor(async () => {
      const discovery = JSON.parse(await readFile(join(home, 'memory-runtime.json'), 'utf8'));
      return discovery.mode === 'mcp' && discovery.state === 'stopped';
    });
    expect(await readFile(itemPath, 'utf8')).toBe(before);
    expect(await handle.local.outbox.get('ob_in_flight')).toMatchObject({ attempts: 0, lastAttemptAt: null });
    expect(await handle.local.outbox.deadCount()).toBe(0);
  }, 12000);

  it('in-flight replay 晚到成功后不删除 pending、不当作新提交，且不得发布 clean stopped', async () => {
    const home = await temp();
    const capability = await controlledCapability('replay-late-token');
    const handle = await startSidecar({
      home,
      port: 0,
      heartbeatMs: 50,
      hostToken: 'host-token',
      env: {
        MEBULAR_HOME: home,
        MEBULAR_CAPABILITY_URL: capability.url,
        MEBULAR_CAPABILITY_TOKEN: 'replay-late-token',
      },
    });
    handles.push(handle);
    await handle.local.outbox.enqueue({
      id: 'ob_late_success', requestId: 'req_late_success', endpoint: '/write', body: { value: 'pending' },
    });
    const itemPath = join(handle.paths.dataDir, 'outbox', 'ob_late_success.json');
    const before = await readFile(itemPath, 'utf8');
    const settled = jest.spyOn(handle.settlement.ingest, 'applyReplayedOutbox');
    let release = () => {};
    capability.state.writeGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const replay = handle.settlement.replayer.replayOnce();
    await waitFor(async () => capability.state.writeStarted === 1);
    capability.state.writeSuccessEvenWhenDisabled = true;
    capability.state.enabled = false;
    await waitFor(async () => {
      const discovery = JSON.parse(await readFile(join(home, 'memory-runtime.json'), 'utf8'));
      return discovery.mode === 'mcp';
    });
    release();
    await replay;
    await waitFor(async () => {
      const status = await fetch(`${handle.url}/status`, { headers: bearer('host-token') });
      return (await status.json() as any).data.state === 'degraded';
    });
    expect(settled).not.toHaveBeenCalled();
    expect(await readFile(itemPath, 'utf8')).toBe(before);
    expect(await handle.local.outbox.get('ob_late_success')).toMatchObject({ attempts: 0, lastAttemptAt: null });
    expect(await handle.local.outbox.deadCount()).toBe(0);
    const discovery = JSON.parse(await readFile(join(home, 'memory-runtime.json'), 'utf8'));
    expect(discovery).toMatchObject({ mode: 'mcp', state: 'degraded' });
    const status = await fetch(`${handle.url}/status`, { headers: bearer('host-token') });
    expect((await status.json() as any).data.warnings).toContain('dormant_incomplete');
  }, 15000);

  it('in-flight ingest 写入在休眠后成功：返回 409、不写详情/outbox，且不发布 clean stopped', async () => {
    const home = await temp();
    const capability = await controlledCapability('ingest-late-token');
    const handle = await startSidecar({
      home,
      port: 0,
      heartbeatMs: 50,
      hostToken: 'host-token',
      env: {
        MEBULAR_HOME: home,
        MEBULAR_CAPABILITY_URL: capability.url,
        MEBULAR_CAPABILITY_TOKEN: 'ingest-late-token',
      },
    });
    handles.push(handle);
    const before = await handle.local.outbox.stats();
    let release = () => {};
    capability.state.writeGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = fetch(`${handle.url}/ingest`, {
      method: 'POST',
      headers: { ...bearer('host-token'), 'content-type': 'application/json' },
      body: JSON.stringify({
        agentId: 'opencode',
        chunks: [{ role: 'user', text: '记住：项目使用 pnpm workspace' }],
        candidates: [{ kind: 'observation', content: { content: '项目使用 pnpm workspace' } }],
      }),
    });
    await waitFor(async () => capability.state.writeStarted === 1);
    capability.state.writeSuccessEvenWhenDisabled = true;
    capability.state.enabled = false;
    await waitFor(async () => {
      const discovery = JSON.parse(await readFile(join(home, 'memory-runtime.json'), 'utf8'));
      return discovery.mode === 'mcp';
    });
    release();
    const response = await pending;
    expect(response.status).toBe(409);
    expect((await response.json() as any).error.code).toBe('mode_mismatch');
    expect(await handle.local.outbox.stats()).toEqual(before);
    expect(capability.state.requests.some((request) => request.path.endsWith('/detail'))).toBe(false);
    await waitFor(async () => {
      const status = await fetch(`${handle.url}/status`, { headers: bearer('host-token') });
      return (await status.json() as any).data.state === 'degraded';
    });
    const discovery = JSON.parse(await readFile(join(home, 'memory-runtime.json'), 'utf8'));
    expect(discovery).toMatchObject({ mode: 'mcp', state: 'degraded' });
  }, 15000);

  it('in-flight ingest 遇到 capability_disabled：不新建 outbox、不 queued，收尾后可为 clean stopped', async () => {
    const home = await temp();
    const capability = await controlledCapability('ingest-disabled-token');
    const handle = await startSidecar({
      home,
      port: 0,
      heartbeatMs: 50,
      hostToken: 'host-token',
      env: {
        MEBULAR_HOME: home,
        MEBULAR_CAPABILITY_URL: capability.url,
        MEBULAR_CAPABILITY_TOKEN: 'ingest-disabled-token',
      },
    });
    handles.push(handle);
    const before = await handle.local.outbox.stats();
    let release = () => {};
    capability.state.writeGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = fetch(`${handle.url}/ingest`, {
      method: 'POST',
      headers: { ...bearer('host-token'), 'content-type': 'application/json' },
      body: JSON.stringify({
        agentId: 'opencode',
        chunks: [{ role: 'user', text: '记住：不要入队' }],
        candidates: [{ kind: 'observation', content: { content: '不要入队' } }],
      }),
    });
    await waitFor(async () => capability.state.writeStarted === 1);
    capability.state.enabled = false;
    await waitFor(async () => {
      const discovery = JSON.parse(await readFile(join(home, 'memory-runtime.json'), 'utf8'));
      return discovery.mode === 'mcp';
    });
    release();
    const response = await pending;
    expect(response.status).toBe(409);
    expect(await handle.local.outbox.stats()).toEqual(before);
    await waitFor(async () => {
      const discovery = JSON.parse(await readFile(join(home, 'memory-runtime.json'), 'utf8'));
      return discovery.mode === 'mcp' && discovery.state === 'stopped';
    });
    const status = await fetch(`${handle.url}/status`, { headers: bearer('host-token') });
    const body = await status.json() as any;
    expect(body.data.warnings).not.toContain('dormant_incomplete');
  }, 15000);

  it('host 请求未结束时仅为 draining，完成后才发布 clean dormant', async () => {
    const home = await temp();
    const capability = await controlledCapability('drain-token');
    const handle = await startSidecar({
      home,
      port: 0,
      heartbeatMs: 50,
      hostToken: 'host-token',
      env: {
        MEBULAR_HOME: home,
        MEBULAR_CAPABILITY_URL: capability.url,
        MEBULAR_CAPABILITY_TOKEN: 'drain-token',
      },
    });
    handles.push(handle);
    let finish = () => {};
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const ingest = jest.spyOn(handle.settlement, 'handleIngest').mockImplementation(async () => {
      await gate;
      return { status: 200, data: { accepted: true }, warnings: [], degraded: false } as any;
    });
    const pending = fetch(`${handle.url}/ingest`, {
      method: 'POST',
      headers: { ...bearer('host-token'), 'content-type': 'application/json' },
      body: '{}',
    });
    await waitFor(async () => ingest.mock.calls.length === 1);
    capability.state.enabled = false;
    await waitFor(async () => {
      const response = await fetch(`${handle.url}/status`, { headers: bearer('host-token') });
      const body = await response.json() as any;
      return body.data.mode === 'mcp' && body.data.state === 'degraded';
    });
    const discoveryDuringDrain = JSON.parse(await readFile(join(home, 'memory-runtime.json'), 'utf8'));
    expect(discoveryDuringDrain.state).not.toBe('stopped');
    finish();
    expect((await pending).status).toBe(200);
    await waitFor(async () => {
      const discovery = JSON.parse(await readFile(join(home, 'memory-runtime.json'), 'utf8'));
      return discovery.mode === 'mcp' && discovery.state === 'stopped';
    });
  }, 12000);

  it('模型停止失败时保持 mcp+degraded/dormant_incomplete，不伪装 clean', async () => {
    const home = await temp();
    const capability = await controlledCapability('model-stop-token');
    const handle = await startSidecar({
      home,
      port: 0,
      heartbeatMs: 50,
      hostToken: 'host-token',
      env: {
        MEBULAR_HOME: home,
        MEBULAR_CAPABILITY_URL: capability.url,
        MEBULAR_CAPABILITY_TOKEN: 'model-stop-token',
      },
    });
    handles.push(handle);
    const inference = await handle.inferenceService.status();
    jest.spyOn(handle.inferenceService, 'status').mockResolvedValue({
      ...inference,
      install: null,
      engine: { ...inference.engine, state: 'running', packId: 'qwen3-4b-instruct-q4_k_m' },
    });
    jest.spyOn(handle.inferenceService, 'stopEngine').mockRejectedValue(new Error('injected engine stop failure'));
    capability.state.enabled = false;
    await waitFor(async () => {
      const discovery = JSON.parse(await readFile(join(home, 'memory-runtime.json'), 'utf8'));
      return discovery.mode === 'mcp' && discovery.state === 'degraded';
    });
    const response = await fetch(`${handle.url}/status`, { headers: bearer('host-token') });
    const body = await response.json() as any;
    expect(body.data.warnings).toContain('dormant_incomplete');
    const discovery = JSON.parse(await readFile(join(home, 'memory-runtime.json'), 'utf8'));
    expect(discovery).toMatchObject({ mode: 'mcp', state: 'degraded' });
  }, 12000);

  it('replayer/model dispose 故障仍有界关闭 HTTP 并清理 discovery/token/lock', async () => {
    const home = await temp();
    const handle = await startSidecar({
      home,
      port: 0,
      skipHandshake: true,
      hostToken: 'host-token',
      env: { MEBULAR_HOME: home },
    });
    handles.push(handle);
    const stopSpy = jest.spyOn(handle.settlement.replayer, 'stop').mockImplementation(async () => {
      throw new Error('injected replayer stop failure');
    });
    jest.spyOn(handle.inferenceService, 'dispose').mockImplementation(async () => {
      throw new Error('injected inference dispose failure');
    });
    jest.spyOn(handle.model, 'dispose').mockImplementation(() => {
      throw new Error('injected synchronous model dispose failure');
    });

    await handle.stop();
    handles.splice(handles.indexOf(handle), 1);
    expect(stopSpy).toHaveBeenCalledWith({ flushMs: 0 });
    await expect(fetch(handle.healthUrl)).rejects.toThrow();
    await expect(stat(join(home, 'memory-runtime.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(handle.paths.hostTokenPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(handle.paths.startLockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('模型 degraded 与恢复由持续心跳刷新，不保留启动快照', async () => {
    const home = await temp();
    const handle = await startSidecar({
      home,
      port: 0,
      heartbeatMs: 50,
      skipHandshake: true,
      hostToken: 'host-token',
      env: { MEBULAR_HOME: home },
    });
    handles.push(handle);
    const healthy = { ...await handle.model.status(), degraded: false, reason: null, warnings: [] };
    let current: Awaited<ReturnType<typeof handle.model.status>> = {
      ...healthy,
      degraded: true,
      reason: 'model_test_failure',
      warnings: ['model_test_failure'],
    };
    jest.spyOn(handle.model, 'status').mockImplementation(async () => current);
    jest.spyOn(handle.model, 'currentStatus').mockImplementation(() => current);
    await waitFor(async () => JSON.parse(await readFile(join(home, 'memory-runtime.json'), 'utf8')).degraded === true)
      .catch(async () => {
        throw new Error(`model did not degrade: ${await readFile(join(home, 'memory-runtime.json'), 'utf8')}`);
      });
    current = { ...healthy, degraded: false, reason: null, warnings: [] };
    await waitFor(async () => JSON.parse(await readFile(join(home, 'memory-runtime.json'), 'utf8')).degraded === false)
      .catch(async () => {
        throw new Error(`model did not recover: ${await readFile(join(home, 'memory-runtime.json'), 'utf8')}`);
      });
    const status = await fetch(`${handle.url}/status`, { headers: bearer('host-token') });
    expect((await status.json() as any).data.model).toMatchObject({ degraded: false, reason: null });
  }, 12000);

  it('真实外部 sidecar 进程：撤销保留 PID，轮换恢复与操作者重启生成新身份', async () => {
    const home = await temp();
    const capability = await controlledCapability('process-token-a');
    const first = await startRealSidecarProcess(home, capability.url, 'process-token-a');
    expect(isSidecarProcessAlive(first.child.pid!)).toBe(true);

    capability.state.enabled = false;
    await waitFor(async () => JSON.parse(await readFile(join(home, 'memory-runtime.json'), 'utf8')).mode === 'mcp');
    expect(isSidecarProcessAlive(first.child.pid!)).toBe(true);
    const tokenA = JSON.parse(await readFile(first.discovery.tokenFile, 'utf8')).token;
    const rejected = await fetch(`${first.discovery.url}/ingest`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenA}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(rejected.status).toBe(409);

    capability.state.enabled = true;
    capability.state.token = 'process-token-b';
    await writeFile(join(home, 'memory-runtime', 'capability-token'), JSON.stringify({
      version: 1, token: 'process-token-b', issuedAt: Date.now(), expiresAt: 0, mcpPid: process.pid,
    }), { mode: 0o600 });
    await waitFor(async () => JSON.parse(await readFile(join(home, 'memory-runtime.json'), 'utf8')).mode === 'immersive');
    expect(capability.state.requests.some((request) => request.path.endsWith('/version')
      && request.authorization === 'Bearer process-token-b')).toBe(true);

    const exited = new Promise<void>((resolve) => first.child.once('exit', () => resolve()));
    first.child.kill('SIGTERM');
    await exited;
    const second = await startRealSidecarProcess(home, capability.url, 'process-token-b');
    expect(second.child.pid).not.toBe(first.child.pid);
    expect(second.discovery.startedAt).not.toBe(first.discovery.startedAt);
    const tokenB = JSON.parse(await readFile(second.discovery.tokenFile, 'utf8')).token;
    expect(tokenB).not.toBe(tokenA);
    const status = await fetch(`${second.discovery.url}/status`, {
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(status.status).toBe(200);
    expect((await status.json() as any).data.capability.reachable).toBe(true);
  }, 20000);

  it('version 命令返回 sidecar/API/capability 版本', () => {
    expect(getSidecarVersion()).toMatchObject({
      ok: true,
      runtimeVersion: '0.3.0',
      apiVersion: 1,
      capabilityApiVersion: 1,
      minMcpVersion: '0.3.0',
      maxMcpVersion: '0.3.x',
      mode: 'immersive',
      capabilities: { details: true },
      details: { stagingHours: 24, cacheDays: 30 },
    });
  });
});
