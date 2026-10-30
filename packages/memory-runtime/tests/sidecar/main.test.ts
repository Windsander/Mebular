// sidecar 进程集成：serve 启动、写 discovery、health/status、优雅停止；
// capability 握手（fake MCP）与版本不兼容退出码。

import { describe, it, expect, afterEach } from '@jest/globals';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  getSidecarStatus,
  getSidecarVersion,
  startSidecar,
  type SidecarHandle,
} from '../../src/sidecar/main.js';
import { bearer } from './helpers.js';

const homes: string[] = [];
const handles: SidecarHandle[] = [];
const fakeServers: Server[] = [];

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.stop().catch(() => undefined);
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
    expect(handle.discovery.degraded).toBe(false);
    expect(handle.discovery.capabilities.ingest).toBe(false);
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
    expect(body.data.counts).toMatchObject({ rawChunks: 0, traces: 0, outbox: 0 });
    expect(body.data.identity.hostId).toMatch(/^h_/);

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

  it('version 命令返回 sidecar/API/capability 版本', () => {
    expect(getSidecarVersion()).toMatchObject({
      ok: true,
      runtimeVersion: '0.3.0',
      apiVersion: 1,
      capabilityApiVersion: 1,
      minMcpVersion: '0.3.0',
      maxMcpVersion: '0.3.x',
    });
  });
});
