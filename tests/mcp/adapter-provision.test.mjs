// Adapter provisioning (W1/W2/W5): registry / state / merge / idempotency /
// backup / rollback / forbidden paths / version / unsupported.
//
// Hermetic: every write goes to a temporary home; the real
// `~/.config/opencode` is never touched.

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  dryRun,
  ensureAdapter,
  ensureAdaptersForConnected,
  repairAdapter,
  rollbackAdapter,
} from '../../packages/mcp/src/adapter-provision.mjs';
import {
  adapterStatePath,
  loadAdapterState,
  publicAdapterState,
  updateAdapterHost,
} from '../../packages/mcp/src/adapter-state.mjs';
import {
  createUnsupportedAdapter,
  getAdapter,
  listAdapters,
} from '../../packages/mcp/src/adapters/index.mjs';
import { mergePlugins, PACKAGE_NAME } from '../../packages/mcp/src/adapters/opencode.mjs';
import { connectClient } from '../../packages/mcp/src/clients.mjs';
import { APP_VERSION } from '../../packages/mcp/src/version.mjs';

jest.setTimeout(process.platform === 'win32' ? 30_000 : 20_000);

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const repoPluginDir = join(repoRoot, 'packages', 'opencode-plugin');

describe('adapter provisioning', () => {
  let root;
  let home;
  let userHome;
  let configPath;

  const opts = (extra = {}) => ({
    home,
    userHome,
    cwd: userHome,
    env: {},
    adapterPackagePath: repoPluginDir,
    ...extra,
  });

  async function makePlugin(dir, { name = PACKAGE_NAME, version = APP_VERSION } = {}) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name, version, type: 'module', main: 'index.js' }));
    await writeFile(join(dir, 'index.js'), 'export const fixture = true;\n');
    return dir;
  }

  async function writeConfig(value) {
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
  }

  async function readConfig() {
    return JSON.parse(await readFile(configPath, 'utf-8'));
  }

  async function adapterBackups() {
    try {
      return (await readdir(join(home, 'adapters', 'backups'))).filter((name) => name.includes('.bak-'));
    } catch {
      return [];
    }
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'adapter-provision-'));
    home = join(root, '.mebular');
    userHome = join(root, 'user');
    configPath = join(userHome, '.config', 'opencode', 'opencode.json');
    await mkdir(home, { recursive: true });
    await mkdir(userHome, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // ---------- W1 registry / unsupported ----------

  it('registry: opencode/openchamber/hermes supported, dsh pending, MCP-only unsupported', () => {
    expect(getAdapter('opencode').status).toBe('supported');
    expect(getAdapter('openchamber').status).toBe('supported');
    expect(getAdapter('dsh').status).toBe('pending');
    expect(getAdapter('hermes').status).toBe('supported');
    expect(getAdapter('claude-code').status).toBe('unsupported');
    expect(getAdapter('generic').status).toBe('unsupported');
    expect(getAdapter('unknown-host')).toBeNull();
    const ids = listAdapters().map((adapter) => adapter.hostId);
    expect(ids).toEqual(expect.arrayContaining(['opencode', 'openchamber', 'dsh', 'hermes', 'cursor']));
    const custom = createUnsupportedAdapter({ hostId: 'custom-mcp', displayName: 'Custom' });
    expect(custom.status).toBe('unsupported');
  });

  it('unsupported host: never writes config, records stable unsupported state', async () => {
    const result = await ensureAdapter('cursor', opts({ connected: true }));
    expect(result.ok).toBe(false);
    expect(result.code).toBe('ADAPTER_UNSUPPORTED');
    expect(existsSync(configPath)).toBe(false);
    const state = loadAdapterState({ home });
    expect(state.hosts.cursor).toMatchObject({ connected: true, adapter: 'unsupported', lastError: 'ADAPTER_UNSUPPORTED' });
  });

  it('dsh placeholder returns ADAPTER_UNAVAILABLE (no fake install)', async () => {
    const result = await ensureAdapter('dsh', opts({ connected: true }));
    expect(result.ok).toBe(false);
    expect(result.code).toBe('ADAPTER_UNAVAILABLE');
    expect(existsSync(configPath)).toBe(false);
  });

  // ---------- W2 OpenCode / OpenChamber ----------

  it('new config: creates plugins entry with absolute package path + required options', async () => {
    await mkdir(dirname(configPath), { recursive: true });
    const result = await ensureAdapter('opencode', opts({ connected: true }));
    expect(result.ok).toBe(true);
    expect(result.status).toBe('installed');
    expect(result.changed).toBe(true);
    expect(result.activation).toBe('next-start');
    expect(result.verified).toBe(true);

    const config = await readConfig();
    expect(config.plugins).toHaveLength(1);
    expect(config.plugins[0].package).toBe(repoPluginDir);
    expect(config.plugins[0].options).toEqual({ agentId: 'opencode', recall: true, ingest: true });

    const state = loadAdapterState({ home });
    expect(state.hosts.opencode).toMatchObject({
      detected: true,
      connected: true,
      adapter: 'installed',
      version: APP_VERSION,
      activation: 'next-start',
      lastError: null,
    });
    expect(state.hosts.opencode.configPath).toBe('~/.config/opencode/opencode.json');
    if (process.platform !== 'win32') {
      expect((await stat(adapterStatePath(home))).mode & 0o777).toBe(0o600);
    }
  });

  it('existing config: preserves user plugins/keys and dedupes Mebular entries', async () => {
    const fixturePlugin = await makePlugin(join(root, 'plugin-copy'));
    await writeConfig({
      theme: 'dark',
      plugins: [
        'user-plugin',
        { package: PACKAGE_NAME, options: { userOption: 'keep' } },
        { package: fixturePlugin, options: { duplicate: true } },
      ],
    });
    const result = await ensureAdapter('opencode', opts({ adapterPackagePath: fixturePlugin }));
    expect(result.ok).toBe(true);
    const config = await readConfig();
    expect(config.theme).toBe('dark');
    expect(config.plugins[0]).toBe('user-plugin');
    const mebular = config.plugins.filter((entry) => typeof entry === 'object' && entry.package === fixturePlugin);
    expect(mebular).toHaveLength(1);
    expect(mebular[0].options).toMatchObject({ userOption: 'keep', agentId: 'opencode', recall: true, ingest: true });
  });

  it('idempotent: second ensure changes nothing and adds no backup', async () => {
    await writeConfig({ theme: 'dark', plugins: [] });
    const first = await ensureAdapter('opencode', opts());
    expect(first.changed).toBe(true);
    const backupsAfterFirst = await adapterBackups();
    expect(backupsAfterFirst).toHaveLength(1);

    const second = await ensureAdapter('opencode', opts());
    expect(second.ok).toBe(true);
    expect(second.changed).toBe(false);
    const backupsAfterSecond = await adapterBackups();
    expect(backupsAfterSecond).toHaveLength(1);
  });

  it('invalid JSON / unknown structure: never writes', async () => {
    await writeConfig('{ not json');
    const invalid = await ensureAdapter('opencode', opts());
    expect(invalid.ok).toBe(false);
    expect(invalid.code).toBe('CONFIG_UNPARSEABLE');
    expect(await readFile(configPath, 'utf-8')).toBe('{ not json');
    expect(await adapterBackups()).toHaveLength(0);

    await writeConfig({ plugins: { not: 'an array' } });
    const unknown = await ensureAdapter('opencode', opts());
    expect(unknown.ok).toBe(false);
    expect(unknown.code).toBe('CONFIG_STRUCTURE_UNKNOWN');
    expect((await readConfig()).plugins).toEqual({ not: 'an array' });
  });

  it('forbidden path: refuses OpenChamber managed config and run/instances', async () => {
    const managed = join(userHome, '.config', 'openchamber', 'opencode.managed.json');
    await mkdir(dirname(managed), { recursive: true });
    const result = await ensureAdapter('openchamber', opts({ configPath: managed, force: true, connected: true }));
    expect(result.ok).toBe(false);
    expect(result.code).toBe('FORBIDDEN_PATH');
    expect(existsSync(managed)).toBe(false);

    const instance = join(userHome, '.config', 'openchamber', 'run', 'instances', 'a', 'opencode.managed.json');
    const second = await ensureAdapter('opencode', opts({ configPath: instance, force: true }));
    expect(second.code).toBe('FORBIDDEN_PATH');
    expect(existsSync(instance)).toBe(false);
  });

  it('bundle package: staged into <home>/adapters and used, no npm download', async () => {
    const resources = join(root, 'resources');
    const bundled = join(resources, 'adapters', 'opencode-plugin');
    await makePlugin(bundled);
    await mkdir(dirname(configPath), { recursive: true });
    const result = await ensureAdapter('opencode', opts({ adapterPackagePath: undefined, resourcesPath: resources }));
    expect(result.ok).toBe(true);
    expect(result.source).toBe('managed-dir');
    const managedDir = join(home, 'adapters', 'opencode-plugin', APP_VERSION);
    expect(existsSync(join(managedDir, 'package.json'))).toBe(true);
    const config = await readConfig();
    expect(config.plugins[0].package).toBe(managedDir);

    const second = await ensureAdapter('opencode', opts({ adapterPackagePath: undefined, resourcesPath: resources }));
    expect(second.ok).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.source).toBe('managed-dir');
  });

  it('version mismatch: fails closed without touching config', async () => {
    const oldPlugin = await makePlugin(join(root, 'old-plugin'), { version: '0.0.0' });
    await writeConfig({ theme: 'dark', plugins: [] });
    const before = await readFile(configPath, 'utf-8');
    const result = await ensureAdapter('opencode', opts({ adapterPackagePath: oldPlugin }));
    expect(result.ok).toBe(false);
    expect(result.code).toBe('ADAPTER_VERSION_MISMATCH');
    expect(await readFile(configPath, 'utf-8')).toBe(before);
  });

  it('backup + rollback restores the exact pre-connect bytes', async () => {
    await writeConfig({ theme: 'dark', plugins: ['user-plugin'] });
    const before = await readFile(configPath, 'utf-8');
    const result = await ensureAdapter('opencode', opts());
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    const rollback = await rollbackAdapter('opencode', opts());
    expect(rollback.ok).toBe(true);
    expect(rollback.status).toBe('absent');
    expect(await readFile(configPath, 'utf-8')).toBe(before);
    expect(loadAdapterState({ home }).hosts.opencode.adapter).toBe('absent');
  });

  it('dry run with a bundled candidate: no <home>/adapters writes, config/state untouched', async () => {
    const resources = join(root, 'resources-dry');
    await makePlugin(join(resources, 'adapters', 'opencode-plugin'));
    await writeConfig({ theme: 'dark', plugins: ['user-plugin'] });
    const before = await readFile(configPath, 'utf-8');
    const result = await dryRun('opencode', opts({ adapterPackagePath: undefined, resourcesPath: resources }));
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.status).toBe('planned');
    expect(result.changed).toBe(true);
    expect(result.source).toBe('managed-dir');
    expect(result.preview).toContain(join(home, 'adapters', 'opencode-plugin', APP_VERSION));
    expect(existsSync(join(home, 'adapters'))).toBe(false);
    expect(existsSync(adapterStatePath(home))).toBe(false);
    expect(await readFile(configPath, 'utf-8')).toBe(before);
  });

  it('dry run: reports planned change but writes neither config nor state', async () => {
    await writeConfig({ theme: 'dark' });
    const before = await readFile(configPath, 'utf-8');
    const result = await dryRun('opencode', opts());
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.status).toBe('planned');
    expect(await readFile(configPath, 'utf-8')).toBe(before);
    expect(existsSync(adapterStatePath(home))).toBe(false);
  });

  it('activation: uses injected reload callback, otherwise next-start, never kills', async () => {
    await writeConfig({ theme: 'dark' });
    const reloadHost = jest.fn(async () => undefined);
    const reloaded = await ensureAdapter('opencode', opts({ canRestartHost: true, reloadHost }));
    expect(reloaded.ok).toBe(true);
    expect(reloaded.activation).toBe('reload');
    expect(reloadHost).toHaveBeenCalledTimes(1);

    await writeConfig({ theme: 'dark' });
    const next = await ensureAdapter('opencode', opts());
    expect(next.activation).toBe('next-start');
  });

  it('activation failure rolls back config and records degraded', async () => {
    await writeConfig({ theme: 'dark' });
    const before = await readFile(configPath, 'utf-8');
    const result = await ensureAdapter('opencode', opts({
      canRestartHost: true,
      reloadHost: async () => { throw new Error('reload failed'); },
    }));
    expect(result.ok).toBe(false);
    expect(result.code).toBe('ACTIVATION_FAILED');
    expect(await readFile(configPath, 'utf-8')).toBe(before);
    expect(loadAdapterState({ home }).hosts.opencode).toMatchObject({
      adapter: 'degraded',
      lastError: 'ACTIVATION_FAILED',
    });
  });

  // ---------- W5 connected-only fan-out / hooks ----------

  it('ensureAdaptersForConnected: only connected=true hosts are touched', async () => {
    const none = await ensureAdaptersForConnected(opts({ connectedHostIds: [] }));
    expect(none.ok).toBe(true);
    expect(none.summary.total).toBe(0);
    expect(existsSync(configPath)).toBe(false);

    await updateAdapterHost('opencode', { connected: false, adapter: 'absent' }, { home });
    await updateAdapterHost('openchamber', { connected: false, adapter: 'absent' }, { home });
    const nothing = await ensureAdaptersForConnected(opts());
    expect(nothing.summary.total).toBe(0);
    expect(existsSync(configPath)).toBe(false);

    await updateAdapterHost('openchamber', { connected: true }, { home });
    const one = await ensureAdaptersForConnected(opts());
    expect(one.summary.total).toBe(1);
    expect(one.hosts[0].hostId).toBe('openchamber');
    const state = loadAdapterState({ home });
    expect(state.hosts.opencode.connected).toBe(false);
    expect(state.hosts.opencode.adapter).toBe('absent');
    expect(state.hosts.openchamber.adapter).toBe('installed');
  });

  it('repairAdapter: refuses unconnected hosts, repairs connected ones', async () => {
    await updateAdapterHost('opencode', { connected: false }, { home });
    const refused = await repairAdapter('opencode', opts());
    expect(refused.ok).toBe(false);
    expect(refused.code).toBe('NOT_CONNECTED');
    expect(existsSync(configPath)).toBe(false);

    await updateAdapterHost('opencode', { connected: true }, { home });
    const repaired = await repairAdapter('opencode', opts());
    expect(repaired.ok).toBe(true);
    expect(repaired.status).toBe('installed');
  });

  it('connectClient: additive adapter field; MCP success is independent of adapter failure', async () => {
    await writeConfig({ theme: 'dark' });
    const ok = await connectClient('opencode', opts());
    expect(ok.ok).toBe(true);
    expect(ok.adapter?.ok).toBe(true);
    const config = await readConfig();
    expect(config.mcp.servers.mebular).toBeTruthy();
    expect(config.plugins).toHaveLength(1);
    expect(loadAdapterState({ home }).hosts.opencode.connected).toBe(true);

    await writeConfig({ theme: 'dark' });
    const failed = await connectClient('opencode', opts({ adapterPackagePath: join(root, 'missing-adapter') }));
    expect(failed.ok).toBe(true);
    expect(failed.adapter?.ok).toBe(false);
    expect(failed.adapter?.code).toBe('ADAPTER_PACKAGE_NOT_FOUND');
    expect((await readConfig()).mcp.servers.mebular).toBeTruthy();
    expect(loadAdapterState({ home }).hosts.opencode).toMatchObject({
      connected: true,
      adapter: 'degraded',
      lastError: 'ADAPTER_PACKAGE_NOT_FOUND',
    });
  });

  // ---------- state hygiene ----------

  it('adapters.json: corrupt file fails open, atomic rewrite is 0600', async () => {
    await writeFile(adapterStatePath(home), '{ not json');
    const broken = loadAdapterState({ home });
    expect(broken.corrupted).toBe(true);
    expect(broken.hosts).toEqual({});
    expect(publicAdapterState({ home }).corrupted).toBe(true);

    await updateAdapterHost('opencode', { connected: true, adapter: 'installed', lastError: 'raw message /tmp/secret' }, { home });
    const fixed = loadAdapterState({ home });
    expect(fixed.corrupted).toBe(false);
    expect(fixed.hosts.opencode.lastError).toBeNull();
    if (process.platform !== 'win32') {
      expect((await stat(adapterStatePath(home))).mode & 0o777).toBe(0o600);
    }
  });

  it('mergePlugins is pure and idempotent', () => {
    const first = mergePlugins({ plugins: ['x'] }, '/abs/plugin');
    expect(first.changed).toBe(true);
    const second = mergePlugins(first.document, '/abs/plugin');
    expect(second.changed).toBe(false);
    expect(second.plugins).toHaveLength(2);
  });

  // ---------- real package evidence ----------

  it('real @mebular/opencode-plugin: config write/readback + module load', async () => {
    await writeConfig({ theme: 'dark', plugins: [] });
    const result = await ensureAdapter('opencode', opts());
    expect(result.ok).toBe(true);
    expect(result.version).toBe(APP_VERSION);

    const config = await readConfig();
    const entry = config.plugins.find((item) => item?.package === repoPluginDir);
    expect(entry).toBeTruthy();
    expect(entry.options).toMatchObject({ agentId: 'opencode', recall: true, ingest: true });

    const manifest = JSON.parse(await readFile(join(repoPluginDir, 'package.json'), 'utf-8'));
    expect(manifest.name).toBe(PACKAGE_NAME);
    expect(manifest.version).toBe(APP_VERSION);

    const module = await import(pathToFileURL(join(repoPluginDir, 'index.js')).href);
    expect(module.PACKAGE_NAME).toBe(PACKAGE_NAME);
    expect(typeof module.default?.setup).toBe('function');
  });
});
