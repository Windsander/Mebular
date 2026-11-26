// Adapter health (W1/W7): real local fake sidecar HTTP, discovery + host token,
// healthy / degraded / unavailable, and a single degraded repair attempt.

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensureAdapter,
  ensureAdaptersForConnected,
} from '../../packages/mcp/src/adapter-provision.mjs';
import { loadAdapterState, updateAdapterHost } from '../../packages/mcp/src/adapter-state.mjs';
import { getAdapter } from '../../packages/mcp/src/adapters/index.mjs';
import { APP_VERSION } from '../../packages/mcp/src/version.mjs';

jest.setTimeout(process.platform === 'win32' ? 30_000 : 20_000);

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const repoPluginDir = join(repoRoot, 'packages', 'opencode-plugin');
const HOST_TOKEN = 'adapter-health-host-token';

function jsonResponse(res, value, status = 200) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}

describe('adapter health', () => {
  let root;
  let home;
  let userHome;
  let configPath;
  let servers;

  const opts = (extra = {}) => ({
    home,
    userHome,
    cwd: userHome,
    env: {},
    adapterPackagePath: repoPluginDir,
    ...extra,
  });

  async function writeConfig(value) {
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, `${JSON.stringify(value, null, 2)}\n`);
  }

  async function startSidecar({ ingested = 0, traces = [] } = {}) {
    const calls = [];
    let state = { ingested, traces };
    const server = createServer((req, res) => {
      calls.push({ url: req.url, authorization: req.headers.authorization ?? null });
      if (req.url.startsWith('/memory-runtime/v1/status')) {
        jsonResponse(res, { ok: true, data: { state: 'ready', counts: { ingested: state.ingested, settled: state.ingested } } });
        return;
      }
      if (req.url.startsWith('/memory-runtime/v1/traces')) {
        jsonResponse(res, { ok: true, data: { traces: state.traces, total: state.traces.length } });
        return;
      }
      jsonResponse(res, { ok: false, error: { code: 'not_found' } }, 404);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const { port } = server.address();
    return {
      url: `http://127.0.0.1:${port}/memory-runtime/v1`,
      calls,
      set(next = {}) {
        state = { ...state, ...next };
      },
      async close() {
        await new Promise((resolve) => server.close(resolve));
      },
    };
  }

  async function writeDiscovery(url) {
    const tokenFile = join(home, 'memory-runtime', 'host-token');
    await mkdir(dirname(tokenFile), { recursive: true });
    await writeFile(tokenFile, JSON.stringify({ version: 1, token: HOST_TOKEN }), { mode: 0o600 });
    await writeFile(join(home, 'memory-runtime.json'), JSON.stringify({
      schema: 1,
      kind: 'mebular-memory-runtime',
      url,
      tokenFile,
      state: 'ready',
      updatedAt: Date.now(),
    }), { mode: 0o600 });
    return tokenFile;
  }

  async function seedInstalled(installedAt) {
    await updateAdapterHost('opencode', {
      connected: true,
      adapter: 'installed',
      version: APP_VERSION,
      installedAt,
    }, { home });
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'adapter-health-'));
    home = join(root, '.mebular');
    userHome = join(root, 'user');
    configPath = join(userHome, '.config', 'opencode', 'opencode.json');
    await mkdir(home, { recursive: true });
    await mkdir(userHome, { recursive: true });
    servers = [];
  });

  afterEach(async () => {
    for (const server of servers) {
      await new Promise((resolve) => server.close(resolve));
    }
    await rm(root, { recursive: true, force: true });
  });

  it('fresh host trace + ingested > 0: healthy, adapter active, lastIngestedAt = trace.at', async () => {
    const installedAt = Date.now() - 60_000;
    await seedInstalled(installedAt);
    const traceAt = Date.now();
    const sidecar = await startSidecar({
      ingested: 3,
      traces: [
        { id: 'tr_other', agentId: 'dsh', at: traceAt + 1 },
        { id: 'tr_open', agentId: 'opencode', at: traceAt },
      ],
    });
    const tokenFile = await writeDiscovery(sidecar.url);
    await writeConfig({ theme: 'dark', plugins: [] });

    const result = await ensureAdapter('opencode', opts({ healthOptions: { timeoutMs: 2000 } }));

    expect(result.ok).toBe(true);
    expect(result.health).toBe('healthy');
    expect(result.status).toBe('active');
    expect(result.lastIngestedAt).toBe(traceAt);
    expect(result.ingested).toBe(3);
    const state = loadAdapterState({ home }).hosts.opencode;
    expect(state).toMatchObject({
      adapter: 'active',
      installedAt,
      lastIngestedAt: traceAt,
      lastError: null,
    });
    expect(sidecar.calls.every((call) => call.authorization === `Bearer ${HOST_TOKEN}`)).toBe(true);
    expect(JSON.stringify(state)).not.toContain(HOST_TOKEN);
    expect(JSON.stringify(loadAdapterState({ home }))).not.toContain(tokenFile);
  });

  it('upgrade resets the health baseline: an old-version trace cannot make the new adapter healthy', async () => {
    const oldInstalledAt = Date.now() - 120_000;
    const oldTraceAt = Date.now() - 60_000;
    await updateAdapterHost('opencode', {
      connected: true,
      adapter: 'active',
      version: '0.3.4',
      installedAt: oldInstalledAt,
      lastIngestedAt: oldTraceAt,
    }, { home });
    const sidecar = await startSidecar({
      ingested: 2,
      traces: [{ id: 'tr_old', agentId: 'opencode', at: oldTraceAt }],
    });
    await writeDiscovery(sidecar.url);
    await writeConfig({ theme: 'dark', plugins: [] });

    const upgraded = await ensureAdapter('opencode', opts({ healthOptions: { timeoutMs: 2000 } }));

    expect(upgraded.ok).toBe(true);
    expect(upgraded.version).toBe(APP_VERSION);
    expect(upgraded.health).toBe('deferred');
    expect(upgraded.status).toBe('installed');
    const afterUpgrade = loadAdapterState({ home }).hosts.opencode;
    expect(afterUpgrade.version).toBe(APP_VERSION);
    expect(afterUpgrade.installedAt).toBeGreaterThan(oldInstalledAt);
    expect(afterUpgrade.adapter).toBe('installed');
    expect(afterUpgrade.lastIngestedAt).toBeUndefined();

    const newTraceAt = Date.now();
    sidecar.set({ ingested: 3, traces: [{ id: 'tr_new', agentId: 'opencode', at: newTraceAt }] });
    const settled = await ensureAdapter('opencode', opts({ healthOptions: { timeoutMs: 2000 } }));

    expect(settled.health).toBe('healthy');
    expect(settled.status).toBe('active');
    expect(settled.lastIngestedAt).toBe(newTraceAt);
    expect(loadAdapterState({ home }).hosts.opencode).toMatchObject({
      adapter: 'active',
      lastIngestedAt: newTraceAt,
    });
  });

  it('host context trace but ingested = 0: degraded with HEALTH_NO_INGEST', async () => {
    const installedAt = Date.now() - 60_000;
    await seedInstalled(installedAt);
    const sidecar = await startSidecar({
      ingested: 0,
      traces: [{ id: 'tr_ctx', agentId: 'opencode', at: Date.now() }],
    });
    await writeDiscovery(sidecar.url);
    await writeConfig({ theme: 'dark', plugins: [] });

    const result = await ensureAdapter('opencode', opts({ healthOptions: { timeoutMs: 2000 } }));

    expect(result.ok).toBe(true);
    expect(result.health).toBe('degraded');
    expect(result.healthCode).toBe('HEALTH_NO_INGEST');
    expect(result.status).toBe('degraded');
    expect(loadAdapterState({ home }).hosts.opencode).toMatchObject({
      adapter: 'degraded',
      lastError: 'HEALTH_NO_INGEST',
    });
  });

  it('trace older than installedAt (or another host only): no evidence stays installed/deferred', async () => {
    const installedAt = Date.now();
    await seedInstalled(installedAt);
    const sidecar = await startSidecar({
      ingested: 4,
      traces: [
        { id: 'tr_old', agentId: 'opencode', at: installedAt - 1 },
        { id: 'tr_dsh', agentId: 'dsh', at: installedAt + 10 },
      ],
    });
    await writeDiscovery(sidecar.url);
    await writeConfig({ theme: 'dark', plugins: [] });

    const result = await ensureAdapter('opencode', opts({ healthOptions: { timeoutMs: 2000 } }));

    expect(result.health).toBe('deferred');
    expect(result.status).toBe('installed');
    expect(loadAdapterState({ home }).hosts.opencode.adapter).toBe('installed');
    expect(loadAdapterState({ home }).hosts.opencode.lastError).toBeNull();
  });

  it('sidecar unavailable: HEALTH_UNAVAILABLE + deferred, never degraded', async () => {
    const installedAt = Date.now() - 60_000;
    await seedInstalled(installedAt);
    const sidecar = await startSidecar();
    await writeDiscovery(sidecar.url);
    await sidecar.close();
    await writeConfig({ theme: 'dark', plugins: [] });

    const result = await ensureAdapter('opencode', opts({ healthOptions: { timeoutMs: 300 } }));

    expect(result.ok).toBe(true);
    expect(result.health).toBe('deferred');
    expect(result.healthCode).toBe('HEALTH_UNAVAILABLE');
    expect(result.status).toBe('installed');
    expect(loadAdapterState({ home }).hosts.opencode).toMatchObject({
      adapter: 'installed',
      lastError: null,
    });
  });

  it('connected degraded host: one repair attempt, then recorded degraded (no loop)', async () => {
    const installedAt = Date.now() - 60_000;
    await updateAdapterHost('opencode', {
      connected: true,
      adapter: 'degraded',
      version: APP_VERSION,
      installedAt,
      lastError: 'HEALTH_NO_INGEST',
    }, { home });
    const sidecar = await startSidecar({
      ingested: 0,
      traces: [{ id: 'tr_ctx', agentId: 'opencode', at: Date.now() }],
    });
    await writeDiscovery(sidecar.url);
    await writeConfig({ theme: 'dark', plugins: [] });

    const adapter = getAdapter('opencode');
    const configure = jest.spyOn(adapter, 'configure');
    try {
      const result = await ensureAdaptersForConnected(opts({
        connectedHostIds: ['opencode'],
        healthOptions: { timeoutMs: 2000 },
      }));
      expect(configure).toHaveBeenCalledTimes(1);
      expect(result.hosts).toHaveLength(1);
      expect(result.hosts[0]).toMatchObject({ hostId: 'opencode', status: 'degraded' });
      expect(result.summary.degraded).toBe(1);
    } finally {
      configure.mockRestore();
    }

    const state = loadAdapterState({ home }).hosts.opencode;
    expect(state).toMatchObject({ adapter: 'degraded', lastError: 'HEALTH_NO_INGEST' });
  });
});
