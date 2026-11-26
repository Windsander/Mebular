// Hermes adapter (W4): detect / package resolution / provider install /
// memory.provider selection / idempotency / version / forbidden paths /
// rollback / dry-run.
//
// Hermetic: every write goes to a temporary Mebular home + HERMES_HOME and a
// fake `hermes` CLI; the real `~/.hermes` is never written. When a real Hermes
// install exists, one read-only evidence test inspects it (detect + dry-run).

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  dryRun,
  ensureAdapter,
  rollbackAdapter,
} from '../../packages/mcp/src/adapter-provision.mjs';
import { adapterStatePath, loadAdapterState } from '../../packages/mcp/src/adapter-state.mjs';
import { connectClient } from '../../packages/mcp/src/clients.mjs';
import {
  PACKAGE_NAME,
  configPathFor,
  detect,
  ensurePackage,
  isForbiddenPath,
  parseProviderFromConfigText,
  verify,
} from '../../packages/mcp/src/adapters/hermes.mjs';
import { APP_VERSION } from '../../packages/mcp/src/version.mjs';

jest.setTimeout(process.platform === 'win32' ? 30_000 : 25_000);

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const repoProvider = join(repoRoot, 'integrations', 'hermes', 'mebular-memory');

const realUserHome = homedir();
const realHermesHome = join(realUserHome, '.hermes');
const realHermesCli = join(realUserHome, '.local', 'bin', 'hermes');
const hasRealHermes = existsSync(realHermesHome) && existsSync(realHermesCli);
const realHermesIt = hasRealHermes && process.platform !== 'win32' ? it : it.skip;

const FAKE_CLI = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const home = process.env.HERMES_HOME || path.join(process.env.HOME || '', '.hermes');
const config = path.join(home, 'config.yaml');
const log = process.env.FAKE_HERMES_LOG;
if (log) {
  try { fs.appendFileSync(log, args.join(' ') + '\\n'); } catch {}
}
function readText() {
  try { return fs.readFileSync(config, 'utf8'); } catch { return ''; }
}
function provider(text) {
  const lines = text.split(/\\r?\\n/);
  let inside = false;
  for (const line of lines) {
    if (/^memory:\\s*(?:#.*)?$/.test(line)) { inside = true; continue; }
    if (inside && /^[A-Za-z0-9_.-]+:/.test(line)) { inside = false; }
    if (!inside) continue;
    const match = /^\\s+provider:\\s*(.*)$/.exec(line);
    if (match) return match[1].replace(/\\s+#.*$/, '').trim().replace(/^['"]|['"]$/g, '');
  }
  return '';
}
function writeProvider(text, value) {
  const lines = text.split(/\\r?\\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^memory:\\s*(?:#.*)?$/.test(lines[i])) { start = i; break; }
  }
  if (start === -1) {
    let next = text;
    if (next.length > 0 && !next.endsWith('\\n')) next += '\\n';
    return next + 'memory:\\n  provider: ' + value + '\\n';
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^[A-Za-z0-9_.-]+:/.test(lines[i])) { end = i; break; }
  }
  for (let i = start + 1; i < end; i += 1) {
    if (/^\\s+provider:\\s*/.test(lines[i])) {
      lines[i] = lines[i].replace(/^(\\s+)provider:\\s*.*$/, '$1provider: ' + value);
      return lines.join('\\n');
    }
  }
  lines.splice(start + 1, 0, '  provider: ' + value);
  return lines.join('\\n');
}
if (args[0] === '--version') {
  console.log('Hermes Agent v9.9.9 (fake) · hermetic');
  process.exit(0);
}
if (args[0] === 'config' && args[1] === 'get' && args[2] === 'memory.provider') {
  console.log(provider(readText()));
  process.exit(0);
}
if (args[0] === 'config' && args[1] === 'set' && args[2] === 'memory.provider') {
  const value = args[3] === undefined ? '' : args[3];
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(config, writeProvider(readText(), value));
  process.exit(0);
}
process.exit(2);
`;

describe('hermes adapter', () => {
  let root;
  let home;
  let userHome;
  let hermesHome;
  let fakeBin;
  let logPath;
  let configPath;

  const opts = (extra = {}) => ({
    home,
    userHome,
    hermesHome,
    cwd: userHome,
    env: {
      PATH: fakeBin,
      HERMES_HOME: hermesHome,
      FAKE_HERMES_LOG: logPath,
    },
    adapterPackagePath: repoProvider,
    ...extra,
  });

  async function makeBundle(dir, { name = PACKAGE_NAME, version = APP_VERSION, init = 'PROVIDER = True\n' } = {}) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'plugin.yaml'), `name: ${name}\nversion: ${version}\ndescription: fixture\n`);
    await writeFile(join(dir, '__init__.py'), init);
    return dir;
  }

  async function writeConfig(value) {
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, value);
  }

  async function configBackups() {
    try {
      return (await readdir(join(home, 'adapters', 'backups'))).filter((name) => name.startsWith('config.yaml.bak-'));
    } catch {
      return [];
    }
  }

  async function providerBackups() {
    try {
      return (await readdir(join(hermesHome, 'plugins'))).filter((name) => name.startsWith('mebular.bak-'));
    } catch {
      return [];
    }
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'adapter-hermes-'));
    home = join(root, '.mebular');
    userHome = join(root, 'user');
    hermesHome = join(userHome, '.hermes');
    fakeBin = join(root, 'bin');
    logPath = join(root, 'hermes.log');
    configPath = join(hermesHome, 'config.yaml');
    await mkdir(home, { recursive: true });
    await mkdir(userHome, { recursive: true });
    await mkdir(fakeBin, { recursive: true });
    if (process.platform === 'win32') {
      // `execFile` cannot launch extensionless POSIX scripts on Windows. Use a
      // standard `.cmd` shim so the test exercises the same PATH/PATHEXT path
      // as a pipx/legacy Hermes install; the adapter routes it through cmd.exe.
      const script = join(fakeBin, 'hermes-fake.js');
      await writeFile(script, FAKE_CLI);
      await writeFile(
        join(fakeBin, 'hermes.cmd'),
        `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`,
      );
    } else {
      const cli = join(fakeBin, 'hermes');
      await writeFile(cli, FAKE_CLI, { mode: 0o755 });
    }
    await writeFile(logPath, '');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // ---------- detect ----------

  it('detect: config/dir/CLI signals; absent host is not detected', async () => {
    await mkdir(hermesHome, { recursive: true });
    const found = await detect(opts());
    expect(found.detected).toBe(true);
    expect(found.hermesHome).toBe(hermesHome);
    expect(found.cliVersion).toContain('Hermes');
    expect(found.signals.find((signal) => signal.kind === 'cli')?.hit).toBe(true);

    const emptyBin = join(root, 'empty-bin');
    await mkdir(emptyBin, { recursive: true });
    const absent = await detect({
      home,
      userHome,
      hermesHome: join(root, 'no-hermes'),
      env: { PATH: emptyBin },
      hermesCommand: join(root, 'missing-hermes'),
    });
    expect(absent.detected).toBe(false);
  });

  // ---------- ensurePackage ----------

  it('ensurePackage: repo bundle is lockstep; version mismatch fails closed', async () => {
    const ok = await ensurePackage(opts());
    expect(ok.ok).toBe(true);
    expect(ok.path).toBe(repoProvider);
    expect(ok.version).toBe(APP_VERSION);
    expect(ok.source).toBe('manual');

    const bad = await makeBundle(join(root, 'bad-bundle'), { version: '0.0.0' });
    const mismatch = await ensurePackage(opts({ adapterPackagePath: bad }));
    expect(mismatch).toMatchObject({ ok: false, code: 'ADAPTER_VERSION_MISMATCH' });
  });

  it('ensurePackage: App bundle dry-run is read-only, real install stages into <home>/adapters', async () => {
    const resources = join(root, 'resources');
    await makeBundle(join(resources, 'adapters', 'hermes'));

    const planned = await ensurePackage(opts({
      adapterPackagePath: undefined,
      resourcesPath: resources,
      dryRun: true,
    }));
    expect(planned.ok).toBe(true);
    expect(planned.source).toBe('managed-dir');
    expect(planned.planned).toBe(true);
    expect(planned.path).toBe(join(home, 'adapters', 'hermes', APP_VERSION));
    expect(existsSync(join(home, 'adapters'))).toBe(false);

    const dry = await dryRun('hermes', opts({
      adapterPackagePath: undefined,
      resourcesPath: resources,
      connected: true,
    }));
    expect(dry.ok).toBe(true);
    expect(dry.dryRun).toBe(true);
    expect(dry.changed).toBe(true);
    expect(dry.preview).toContain(join(resources, 'adapters', 'hermes'));
    expect(existsSync(join(home, 'adapters'))).toBe(false);
    expect(existsSync(join(hermesHome, 'plugins'))).toBe(false);

    const staged = await ensurePackage(opts({
      adapterPackagePath: undefined,
      resourcesPath: resources,
    }));
    expect(staged.ok).toBe(true);
    expect(staged.source).toBe('managed-dir');
    expect(staged.path).toBe(join(home, 'adapters', 'hermes', APP_VERSION));
    expect(existsSync(join(staged.path, 'plugin.yaml'))).toBe(true);
    expect(existsSync(join(staged.path, '__init__.py'))).toBe(true);
  });

  // ---------- configure / idempotency ----------

  it('configure: installs plugins/mebular, sets memory.provider, is idempotent', async () => {
    await writeConfig('theme: dark\n');
    const first = await ensureAdapter('hermes', opts({ connected: true }));
    expect(first.ok).toBe(true);
    expect(first.status).toBe('installed');
    expect(first.activation).toBe('next-start');
    expect(first.changed).toBe(true);

    expect(existsSync(join(hermesHome, 'plugins', 'mebular', 'plugin.yaml'))).toBe(true);
    expect(existsSync(join(hermesHome, 'plugins', 'mebular', '__init__.py'))).toBe(true);
    const text = await readFile(configPath, 'utf-8');
    expect(text).toContain('theme: dark');
    expect(parseProviderFromConfigText(text)).toBe('mebular');
    expect(await configBackups()).toHaveLength(1);

    const state = loadAdapterState({ home });
    expect(state.hosts.hermes).toMatchObject({
      detected: true,
      connected: true,
      adapter: 'installed',
      version: APP_VERSION,
      activation: 'next-start',
      lastError: null,
    });
    expect(state.hosts.hermes.configPath).toBe(join('~', '.hermes', 'config.yaml'));

    const second = await ensureAdapter('hermes', opts({ connected: true }));
    expect(second.ok).toBe(true);
    expect(second.changed).toBe(false);
    expect(await configBackups()).toHaveLength(1);
    expect(await providerBackups()).toHaveLength(0);
  });

  it('version mismatch: fails without touching config or provider dir', async () => {
    const old = await makeBundle(join(root, 'old-provider'), { version: '0.0.0' });
    await writeConfig('theme: dark\n');
    const before = await readFile(configPath, 'utf-8');
    const result = await ensureAdapter('hermes', opts({ adapterPackagePath: old, connected: true }));
    expect(result.ok).toBe(false);
    expect(result.code).toBe('ADAPTER_VERSION_MISMATCH');
    expect(await readFile(configPath, 'utf-8')).toBe(before);
    expect(existsSync(join(hermesHome, 'plugins', 'mebular'))).toBe(false);
  });

  it('forbidden: session/DB/spool paths are rejected; plugins/mebular is allowed', async () => {
    const sessionTarget = join(hermesHome, 'sessions', 'mebular');
    const result = await ensureAdapter('hermes', opts({ providerPath: sessionTarget, connected: true }));
    expect(result.ok).toBe(false);
    expect(result.code).toBe('FORBIDDEN_PATH');
    expect(existsSync(sessionTarget)).toBe(false);
    expect(isForbiddenPath(join(hermesHome, 'mebular-memory', 'queue.jsonl'), opts())).toBe(true);
    expect(isForbiddenPath(join(hermesHome, 'auth.json'), opts())).toBe(true);
    expect(isForbiddenPath(join(hermesHome, 'plugins', 'mebular'), opts())).toBe(false);
  });

  it('rollback: restores provider dir + exact config bytes; spool is untouched', async () => {
    const previousProvider = join(hermesHome, 'plugins', 'mebular');
    await mkdir(previousProvider, { recursive: true });
    await writeFile(join(previousProvider, 'plugin.yaml'), 'name: mebular\nversion: 0.0.1\n');
    await writeFile(join(previousProvider, '__init__.py'), 'MARKER = "old"\n');
    const oldConfig = 'theme: dark\nmemory:\n  provider: ""\n  memory_enabled: true\n';
    await writeConfig(oldConfig);
    const spool = join(hermesHome, 'mebular-memory', 'queue.jsonl');
    await mkdir(dirname(spool), { recursive: true });
    await writeFile(spool, '{"pending":true}\n');

    const result = await ensureAdapter('hermes', opts({ connected: true }));
    expect(result.ok).toBe(true);
    expect(parseProviderFromConfigText(await readFile(configPath, 'utf-8'))).toBe('mebular');
    expect(await readFile(join(previousProvider, '__init__.py'), 'utf-8')).toContain('Mebular');
    expect(await providerBackups()).toHaveLength(1);

    const rolledBack = await rollbackAdapter('hermes', opts());
    expect(rolledBack.ok).toBe(true);
    expect(rolledBack.status).toBe('absent');
    expect(rolledBack.restoredFrom).toBe('backup');
    expect(await readFile(configPath, 'utf-8')).toBe(oldConfig);
    expect(await readFile(join(previousProvider, 'plugin.yaml'), 'utf-8')).toContain('0.0.1');
    expect(await readFile(join(previousProvider, '__init__.py'), 'utf-8')).toBe('MARKER = "old"\n');
    expect(await readFile(spool, 'utf-8')).toBe('{"pending":true}\n');
    expect(loadAdapterState({ home }).hosts.hermes.adapter).toBe('absent');
  });

  it('rollback: leaves a pre-existing provider when this run only changed config', async () => {
    const source = await makeBundle(join(root, 'source-provider'));
    const target = await makeBundle(join(hermesHome, 'plugins', 'mebular'));
    await writeConfig('theme: dark\nmemory:\n  provider: ""\n');

    const result = await ensureAdapter('hermes', opts({
      adapterPackagePath: source,
      canRestartHost: true,
      reloadHost: async () => { throw new Error('boom'); },
    }));
    expect(result.ok).toBe(false);
    expect(result.code).toBe('ACTIVATION_FAILED');
    expect(existsSync(join(target, 'plugin.yaml'))).toBe(true);
    expect(parseProviderFromConfigText(await readFile(configPath, 'utf-8'))).toBe('');
  });

  it('rollback: removes a config file that did not exist before provisioning', async () => {
    expect(existsSync(configPath)).toBe(false);
    const result = await ensureAdapter('hermes', opts());
    expect(result.ok).toBe(true);
    expect(existsSync(configPath)).toBe(true);
    expect(parseProviderFromConfigText(await readFile(configPath, 'utf-8'))).toBe('mebular');

    const rolledBack = await rollbackAdapter('hermes', opts());
    expect(rolledBack.ok).toBe(true);
    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(join(hermesHome, 'plugins', 'mebular'))).toBe(false);
  });

  it('dry run: no provider/config/state/backup writes and no config set', async () => {
    const before = 'theme: dark\nmemory:\n  provider: ""\n';
    await writeConfig(before);
    const result = await dryRun('hermes', opts({ connected: true }));
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.status).toBe('planned');
    expect(result.changed).toBe(true);
    expect(result.preview).toContain(join(hermesHome, 'plugins', 'mebular'));
    expect(result.preview).toContain('memory.provider');

    expect(existsSync(join(hermesHome, 'plugins'))).toBe(false);
    expect(existsSync(join(home, 'adapters'))).toBe(false);
    expect(existsSync(adapterStatePath(home))).toBe(false);
    expect(await readFile(configPath, 'utf-8')).toBe(before);

    const log = await readFile(logPath, 'utf-8');
    expect(log).toContain('config get memory.provider');
    expect(log).not.toContain('config set memory.provider');
  });

  // ---------- verify ----------

  it('verify: provider dir, version lockstep and memory.provider are all required', async () => {
    await writeConfig('theme: dark\n');
    expect((await ensureAdapter('hermes', opts())).ok).toBe(true);
    const healthy = await verify(opts());
    expect(healthy.ok).toBe(true);
    expect(healthy.health).toBe('deferred');
    expect(healthy.ingested).toBeNull();

    const selected = await readFile(configPath, 'utf-8');
    await writeConfig(selected.replace(/^(\s*)provider:.*$/m, '$1provider: ""'));
    const unselected = await verify(opts());
    expect(unselected.ok).toBe(false);
    expect(unselected.code).toBe('VERIFY_PROVIDER_NOT_SELECTED');

    await writeConfig('theme: dark\nmemory:\n  provider: mebular\n');
    await writeFile(join(hermesHome, 'plugins', 'mebular', 'plugin.yaml'), 'name: mebular\nversion: 0.0.0\n');
    const mismatch = await verify(opts());
    expect(mismatch.ok).toBe(false);
    expect(mismatch.code).toBe('VERIFY_VERSION_MISMATCH');

    await rm(join(hermesHome, 'plugins', 'mebular'), { recursive: true, force: true });
    const missing = await verify(opts());
    expect(missing.ok).toBe(false);
    expect(missing.code).toBe('VERIFY_PROVIDER_MISSING');
  });

  // ---------- activation ----------

  it('activation: next-start by default, injected reload only, failure rolls back', async () => {
    await writeConfig('theme: dark\n');
    const next = await ensureAdapter('hermes', opts());
    expect(next.activation).toBe('next-start');

    await writeConfig('theme: dark\nmemory:\n  provider: ""\n');
    await rm(join(hermesHome, 'plugins', 'mebular'), { recursive: true, force: true });
    const reloadHost = jest.fn(async () => undefined);
    const reloaded = await ensureAdapter('hermes', opts({ canRestartHost: true, reloadHost }));
    expect(reloaded.ok).toBe(true);
    expect(reloaded.activation).toBe('reload');
    expect(reloadHost).toHaveBeenCalledTimes(1);

    await writeConfig('theme: dark\nmemory:\n  provider: ""\n');
    await rm(join(hermesHome, 'plugins', 'mebular'), { recursive: true, force: true });
    const before = await readFile(configPath, 'utf-8');
    const failed = await ensureAdapter('hermes', opts({
      canRestartHost: true,
      reloadHost: async () => { throw new Error('reload failed'); },
    }));
    expect(failed.ok).toBe(false);
    expect(failed.code).toBe('ACTIVATION_FAILED');
    expect(await readFile(configPath, 'utf-8')).toBe(before);
    expect(existsSync(join(hermesHome, 'plugins', 'mebular'))).toBe(false);
    expect(loadAdapterState({ home }).hosts.hermes).toMatchObject({
      adapter: 'degraded',
      lastError: 'ACTIVATION_FAILED',
    });
  });

  // ---------- connectClient hook ----------

  function mcpRunAsync() {
    return async (command) => {
      if (command === 'hermes --version') {
        return { ok: true, code: 0, stdout: 'Hermes Agent v9.9.9 (fake)\n', stderr: '' };
      }
      if (command === 'hermes config get memory.provider') {
        const text = existsSync(configPath) ? await readFile(configPath, 'utf-8') : '';
        return { ok: true, code: 0, stdout: `${parseProviderFromConfigText(text) ?? ''}\n`, stderr: '' };
      }
      if (command === 'hermes config set memory.provider mebular') {
        const text = existsSync(configPath) ? await readFile(configPath, 'utf-8') : '';
        let next;
        if (/^memory:\s*$/m.test(text)) {
          next = /^(\s+)provider:.*$/m.test(text)
            ? text.replace(/^(\s+)provider:.*$/m, '$1provider: mebular')
            : text.replace(/^memory:\s*$/m, 'memory:\n  provider: mebular');
        } else {
          next = `${text}${text.endsWith('\n') || text.length === 0 ? '' : '\n'}memory:\n  provider: mebular\n`;
        }
        await mkdir(dirname(configPath), { recursive: true });
        await writeFile(configPath, next);
        return { ok: true, code: 0, stdout: '', stderr: '' };
      }
      if (command.startsWith('hermes config set --force mcp_servers.mebular ')) {
        const textExists = existsSync(configPath);
        const text = textExists ? await readFile(configPath, 'utf-8') : '';
        if (!text.includes('mcp_servers:')) {
          await mkdir(dirname(configPath), { recursive: true });
          await writeFile(configPath, `${text}${text.endsWith('\n') || text.length === 0 ? '' : '\n'}mcp_servers:\n  mebular:\n    url: http://127.0.0.1:7331/mcp\n    enabled: true\n`);
        }
        return { ok: true, code: 0, stdout: '', stderr: '' };
      }
      if (command === 'hermes config get mcp_servers') {
        return { ok: true, code: 0, stdout: 'mebular:\n  url: http://127.0.0.1:7331/mcp\n', stderr: '' };
      }
      return { ok: false, code: 1, stdout: '', stderr: '' };
    };
  }

  it('connectClient("hermes"): MCP write succeeds and adapter result is additive', async () => {
    await writeConfig('theme: dark\n');
    const result = await connectClient('hermes', opts({
      runAsync: mcpRunAsync(),
      skipSkills: true,
      mcpUrl: 'http://127.0.0.1:7331/mcp',
    }));
    expect(result.ok).toBe(true);
    expect(result.adapter?.ok).toBe(true);
    const text = await readFile(configPath, 'utf-8');
    expect(text).toContain('mcp_servers:');
    expect(parseProviderFromConfigText(text)).toBe('mebular');
    expect(existsSync(join(hermesHome, 'plugins', 'mebular', 'plugin.yaml'))).toBe(true);
    expect(loadAdapterState({ home }).hosts.hermes).toMatchObject({
      connected: true,
      adapter: 'installed',
    });
  });

  it('connectClient: adapter failure never fails the MCP connection', async () => {
    await writeConfig('theme: dark\n');
    const result = await connectClient('hermes', opts({
      runAsync: mcpRunAsync(),
      skipSkills: true,
      adapterPackagePath: join(root, 'missing-provider'),
    }));
    expect(result.ok).toBe(true);
    expect(result.adapter?.ok).toBe(false);
    expect(result.adapter?.code).toBe('ADAPTER_PACKAGE_NOT_FOUND');
    expect(existsSync(join(hermesHome, 'plugins', 'mebular'))).toBe(false);
    expect(loadAdapterState({ home }).hosts.hermes).toMatchObject({
      connected: true,
      adapter: 'degraded',
      lastError: 'ADAPTER_PACKAGE_NOT_FOUND',
    });
  });

  // ---------- config parsing ----------

  it('config readback: parses empty, quoted and inline memory.provider values', () => {
    expect(parseProviderFromConfigText('memory:\n  provider: mebular\n')).toBe('mebular');
    expect(parseProviderFromConfigText('memory:\n  provider: ""\n')).toBe('');
    expect(parseProviderFromConfigText("memory:\n  provider: 'mebular'\n")).toBe('mebular');
    expect(parseProviderFromConfigText('memory: {memory_enabled: true, provider: mebular}\n')).toBe('mebular');
    expect(parseProviderFromConfigText('theme: dark\n')).toBeNull();
  });

  // ---------- real host evidence (read-only) ----------

  realHermesIt('real Hermes: detect + dry-run are strictly read-only', async () => {
    const beforeConfig = existsSync(configPathFor({ hermesHome: realHermesHome }))
      ? await readFile(configPathFor({ hermesHome: realHermesHome }))
      : null;
    const realPlugins = join(realHermesHome, 'plugins');
    const beforePlugins = existsSync(realPlugins) ? await readdir(realPlugins) : [];

    const evidence = await detect({
      home,
      userHome: realUserHome,
      hermesHome: realHermesHome,
      hermesCommand: realHermesCli,
      env: { ...process.env },
    });
    expect(evidence.detected).toBe(true);

    const result = await dryRun('hermes', {
      home,
      userHome: realUserHome,
      hermesHome: realHermesHome,
      hermesCommand: realHermesCli,
      adapterPackagePath: repoProvider,
      env: { ...process.env },
    });
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.preview).toContain(join(realHermesHome, 'plugins', 'mebular'));

    expect(existsSync(join(home, 'adapters'))).toBe(false);
    expect(existsSync(adapterStatePath(home))).toBe(false);
    const afterConfig = existsSync(configPathFor({ hermesHome: realHermesHome }))
      ? await readFile(configPathFor({ hermesHome: realHermesHome }))
      : null;
    expect(Buffer.compare(afterConfig ?? Buffer.from(''), beforeConfig ?? Buffer.from(''))).toBe(0);
    const afterPlugins = existsSync(realPlugins) ? await readdir(realPlugins) : [];
    expect(afterPlugins).toEqual(beforePlugins);
  });

  // Real CLI write path in an isolated HERMES_HOME. A fresh data root has no
  // committed dependency environment; Hermes normally bootstraps one (network +
  // hundreds of MB). We set HERMES_DISABLE_LAZY_INSTALLS=1 so it fails fast with
  // an explicit reason instead, and record HERMES_CLI_ENV_UNSUPPORTED rather
  // than touching the real home or pretending the write happened.
  realHermesIt('real Hermes CLI: isolated HERMES_HOME write path or explicit unsupported boundary', async () => {
    const realConfig = join(realHermesHome, 'config.yaml');
    const beforeBytes = existsSync(realConfig) ? await readFile(realConfig) : null;
    const beforeStat = existsSync(realConfig) ? statSync(realConfig) : null;
    const beforeHash = beforeBytes === null ? null : createHash('sha256').update(beforeBytes).digest('hex');

    const tempHome = await mkdtemp(join(tmpdir(), 'hermes-real-cli-'));
    const tempConfig = join(tempHome, 'config.yaml');
    const env = {
      ...process.env,
      HERMES_HOME: tempHome,
      HERMES_DISABLE_LAZY_INSTALLS: '1',
    };

    let outcome;
    try {
      try {
        execFileSync(realHermesCli, ['config', 'set', 'memory.provider', 'mebular'], {
          env,
          encoding: 'utf-8',
          timeout: 20_000,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const written = existsSync(tempConfig) ? await readFile(tempConfig, 'utf-8') : null;
        const readback = execFileSync(realHermesCli, ['config', 'get', 'memory.provider'], {
          env,
          encoding: 'utf-8',
          timeout: 15_000,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        outcome = { ok: true, written, readback: String(readback).trim() };
      } catch (error) {
        outcome = {
          ok: false,
          code: error?.code ?? null,
          signal: error?.signal ?? null,
          stdout: String(error?.stdout ?? ''),
          stderr: String(error?.stderr ?? ''),
        };
      }
    } finally {
      await rm(tempHome, { recursive: true, force: true });
    }

    // The isolated attempt must not have modified the real Hermes config.
    const afterBytes = existsSync(realConfig) ? await readFile(realConfig) : null;
    const afterStat = existsSync(realConfig) ? statSync(realConfig) : null;
    const afterHash = afterBytes === null ? null : createHash('sha256').update(afterBytes).digest('hex');
    expect(afterStat?.mtimeMs ?? null).toBe(beforeStat?.mtimeMs ?? null);
    expect(afterStat?.size ?? null).toBe(beforeStat?.size ?? null);
    expect(afterHash).toBe(beforeHash);

    if (outcome.ok) {
      expect(outcome.written).not.toBeNull();
      expect(parseProviderFromConfigText(outcome.written)).toBe('mebular');
      expect(outcome.readback).toBe('mebular');
      console.log('[hermes-real] isolated HERMES_HOME write succeeded (config set + get)');
      return;
    }

    const combined = `${outcome.stderr}\n${outcome.stdout}`;
    const fixedReason = /no dependency environment is committed|preparing dependencies for this data root/i.test(combined);
    if (!fixedReason) {
      throw new Error(`real hermes config set failed unexpectedly (code=${outcome.code}, signal=${outcome.signal}): ${combined.trim()}`);
    }
    console.warn(`[hermes-real] HERMES_CLI_ENV_UNSUPPORTED: ${combined.trim().split('\n')[0]}`);
    expect(outcome.stdout).not.toContain('mebular');
  });
});
