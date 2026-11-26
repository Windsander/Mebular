// Adapter descriptor: Hermes Agent (`mebular` MemoryProvider).
//
// Boundaries (see docs/integrations/HERMES.md):
//   * installs *only* `$HERMES_HOME/plugins/mebular` (directory name == the
//     value of `memory.provider`, never `mebular-memory`);
//   * selects the provider through the official CLI
//     (`hermes config set memory.provider mebular`), then reads it back;
//   * never writes Hermes' internal DB / session storage / provider spool;
//   * never downloads from npm: the bundle comes from the App bundle, a managed
//     directory, or (dev/tests) this repository / an injected path;
//   * never kills a host process: activation is an injected reload/restart
//     callback, otherwise `next-start`;
//   * byte-level config backup, staged directory install, rollback.
//
// `sync_turn` ingest health is deliberately *not* checked here (verify only
// proves configuration); the existing repair/health flow owns ingest evidence.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { chmod, copyFile, cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_VERSION } from '../version.mjs';

export const PACKAGE_NAME = 'mebular';
export const PLUGIN_DIR_NAME = 'mebular';
export const CONFIG_KEY = 'memory.provider';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const MANAGED_DIR = 'adapters';
const MANAGED_NAME = 'hermes';

const FORBIDDEN_HOST_DIRS = [
  'sessions',
  'session',
  'db',
  'databases',
  'state',
  'data',
  'cache',
  'logs',
  'history',
  'memories',
  'mebular-memory',
];

/** assistant 落面以用户主目录为基（与 clients.mjs 的 `assistantUserHome` 同语义）。 */
export function resolveUserHome(options = {}) {
  if (typeof options.userHome === 'string' && options.userHome.length > 0) return options.userHome;
  const env = options.env ?? process.env;
  const fromEnv = env?.MEBULAR_USER_HOME;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  return homedir();
}

function expandPath(value, userHome) {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const text = value.trim();
  if (text === '~') return userHome;
  if (/^~[\\/]/.test(text)) return join(userHome, text.slice(2));
  return resolve(text);
}

/**
 * `$HERMES_HOME`: explicit option > injected env > process env > `~/.hermes`.
 * It is *not* Mebular's home (`MEBULAR_HOME`); mixing the two is a host bug.
 */
export function hermesHomeFor(options = {}) {
  const explicit = options.hermesHome;
  const userHome = resolveUserHome(options);
  if (typeof explicit === 'string' && explicit.length > 0) return expandPath(explicit, userHome);
  const env = options.env ?? process.env;
  const fromEnv = env?.HERMES_HOME;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return expandPath(fromEnv, userHome);
  return join(userHome, '.hermes');
}

export function configPathFor(options = {}) {
  const explicit = options.configPath ?? options.primaryPath;
  const userHome = resolveUserHome(options);
  if (typeof explicit === 'string' && explicit.length > 0) return expandPath(explicit, userHome);
  return join(hermesHomeFor(options), 'config.yaml');
}

export function providerPathFor(options = {}) {
  const explicit = options.providerPath;
  const userHome = resolveUserHome(options);
  if (typeof explicit === 'string' && explicit.length > 0) return expandPath(explicit, userHome);
  return join(hermesHomeFor(options), 'plugins', PLUGIN_DIR_NAME);
}

/** 禁写路径：Hermes 内部 DB / 会话存储 / provider spool，只允许 plugins/mebular 与配置。 */
export function isForbiddenPath(file, options = {}) {
  if (typeof file !== 'string' || file.length === 0) return true;
  if ((Array.isArray(options.forbiddenPaths) ? options.forbiddenPaths : []).includes(file)) return true;
  const hermesHome = hermesHomeFor(options);
  const roots = [
    ...FORBIDDEN_HOST_DIRS.map((name) => join(hermesHome, name)),
    ...(Array.isArray(options.forbiddenRoots) ? options.forbiddenRoots : []),
  ];
  if (roots.some((root) => typeof root === 'string' && (file === root || file.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)))) {
    return true;
  }
  const basenameHit = basename(file);
  if (basenameHit === 'auth.json' || basenameHit === '.env') return true;
  return false;
}

function tsStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function readTextFile(path) {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

function parsePluginYaml(text) {
  const name = /^name:\s*["']?([^"'\s#]+)["']?\s*(?:#.*)?$/m.exec(text ?? '');
  const version = /^version:\s*["']?([^"'\s#]+)["']?\s*(?:#.*)?$/m.exec(text ?? '');
  return { name: name ? name[1] : null, version: version ? version[1] : null };
}

function skipArtifacts(source) {
  const name = basename(source);
  return name !== '__pycache__' && !name.endsWith('.pyc') && !name.endsWith('.pyo');
}

/**
 * Read a provider bundle (a directory with `plugin.yaml` + `__init__.py`).
 * The fingerprint makes idempotency content-aware, not just version-aware.
 */
export function readBundle(dir) {
  if (typeof dir !== 'string' || dir.length === 0) return null;
  const yaml = readTextFile(join(dir, 'plugin.yaml'));
  if (yaml === null) return null;
  const init = readTextFile(join(dir, '__init__.py'));
  const manifest = parsePluginYaml(yaml);
  return {
    path: dir,
    name: manifest.name,
    version: manifest.version,
    hasInit: init !== null,
    fingerprint: init === null ? null : createHash('sha256').update(yaml).update('\0').update(init).digest('hex'),
  };
}

function bundleMatches(bundle, expectedVersion) {
  return bundle !== null
    && bundle.name === PACKAGE_NAME
    && bundle.version === expectedVersion
    && bundle.hasInit === true;
}

function sameBundle(a, b, expectedVersion) {
  return bundleMatches(a, expectedVersion)
    && bundleMatches(b, expectedVersion)
    && typeof a.fingerprint === 'string'
    && a.fingerprint === b.fingerprint;
}

function hermesCommand(options = {}) {
  return typeof options.hermesCommand === 'string' && options.hermesCommand.length > 0
    ? options.hermesCommand
    : 'hermes';
}

function cliEnv(options = {}, hermesHome = hermesHomeFor(options)) {
  const userHome = resolveUserHome(options);
  const provided = options.env ?? {};
  const basePath = typeof provided.PATH === 'string' && provided.PATH.length > 0
    ? provided.PATH
    : process.env.PATH;
  const extra = [join(userHome, '.local', 'bin'), dirname(process.execPath)];
  if (process.platform !== 'win32') extra.push('/usr/local/bin', '/opt/homebrew/bin');
  const parts = [...(typeof basePath === 'string' && basePath.length > 0 ? basePath.split(delimiter) : []), ...extra]
    .filter((entry) => typeof entry === 'string' && entry.length > 0);
  const env = { ...process.env, ...provided };
  if (parts.length > 0) env.PATH = [...new Set(parts)].join(delimiter);
  env.HERMES_HOME = hermesHome;
  return env;
}

function normalizeCliResult(result) {
  if (result === null || typeof result !== 'object') return { ok: false, code: 'CLI_FAILED', stdout: '', stderr: '' };
  return {
    ok: result.ok === true,
    code: result.code ?? (result.ok === true ? 0 : 1),
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
  };
}

/** Run the Hermes CLI. Never logs stdout/stderr (they may contain host state). */
function shellQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:@%+-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

async function runHermesCli(args, options = {}, { timeoutMs = 10_000 } = {}) {
  const command = hermesCommand(options);
  const env = cliEnv(options);
  const commandLine = [shellQuote(command), ...args.map(shellQuote)].join(' ');

  // Injected runners (tests / App-owned host control) are honored before
  // spawning a real process; they receive the same shell-style command line as
  // clients.mjs (`run` is the synchronous legacy alias).
  const injected = typeof options.runCli === 'function'
    ? async () => options.runCli({ command, args, env, timeoutMs })
    : typeof options.runAsync === 'function'
      ? async () => options.runAsync(commandLine, timeoutMs)
      : typeof options.run === 'function'
        ? async () => options.run(commandLine, timeoutMs)
        : null;
  if (injected) {
    try {
      return normalizeCliResult(await injected());
    } catch (error) {
      return { ok: false, code: error?.code ?? 'CLI_FAILED', stdout: '', stderr: '' };
    }
  }
  return await new Promise((resolvePromise) => {
    execFile(command, args, {
      timeout: timeoutMs,
      encoding: 'utf-8',
      maxBuffer: 1 << 20,
      windowsHide: true,
      env,
    }, (error, stdout, stderr) => {
      if (error) {
        resolvePromise({ ok: false, code: error.code ?? 1, stdout: stdout ?? '', stderr: stderr ?? '' });
        return;
      }
      resolvePromise({ ok: true, code: 0, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });
}

function unquote(value) {
  const text = String(value ?? '').trim();
  if (text === 'None' || text === 'null' || text === '~') return '';
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

/** Minimal read-only `memory.provider` parser for Hermes' config.yaml. */
export function parseProviderFromConfigText(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  let memoryIndent = null;
  for (const line of lines) {
    const top = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
    if (top) {
      if (top[1] !== 'memory') {
        memoryIndent = null;
        continue;
      }
      memoryIndent = 0;
      const inline = top[2].trim();
      if (inline.startsWith('{') && inline.endsWith('}')) {
        const match = /(?:^|[,{\s])provider\s*:\s*([^,}\s]+)/.exec(inline);
        if (match) return unquote(match[1]);
      }
      continue;
    }
    if (memoryIndent === null) continue;
    const child = /^(\s+)provider:\s*(.*)$/.exec(line);
    if (child) return unquote(child[2].replace(/\s+#.*$/, '').trim());
  }
  return null;
}

function parseProviderOutput(stdout) {
  const lines = String(stdout ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  const last = lines[lines.length - 1];
  const keyed = /^[^:]+:\s*(.*)$/.exec(last);
  return unquote(keyed ? keyed[1] : last);
}

/**
 * Read `memory.provider` through the CLI first, then the config file.
 * An empty CLI result falls back to the file so a stale CLI cannot mask a
 * correctly selected provider.
 */
export async function readProvider(options = {}) {
  const configPath = configPathFor(options);
  const cli = await runHermesCli(['config', 'get', CONFIG_KEY], options);
  if (cli.ok) {
    const value = parseProviderOutput(cli.stdout);
    if (value !== null && value !== '') return { value, source: 'cli' };
  }
  const text = readTextFile(configPath);
  if (text !== null) {
    const value = parseProviderFromConfigText(text);
    if (value !== null) return { value, source: 'file' };
  }
  if (cli.ok) return { value: '', source: 'cli' };
  return { value: null, source: null };
}

/** Host detection: config/dir signals plus `hermes --version` (read-only). */
export async function detect(options = {}) {
  const hermesHome = hermesHomeFor(options);
  const configPath = configPathFor(options);
  const configHit = existsSync(configPath);
  const dirHit = existsSync(hermesHome);
  const cli = await runHermesCli(['--version'], options, { timeoutMs: 2500 });
  const cliVersion = cli.ok ? String(cli.stdout ?? '').split(/\r?\n/)[0].trim() || null : null;
  return {
    detected: configHit || dirHit || cli.ok,
    hermesHome,
    configPath,
    cliVersion,
    signals: [
      { kind: 'config-file', source: configPath, hit: configHit },
      { kind: 'hermes-home', source: hermesHome, hit: dirHit },
      { kind: 'cli', source: `${hermesCommand(options)} --version`, hit: cli.ok === true, detail: `rc=${cli.code}` },
    ],
  };
}

function packageCandidates(options = {}, expectedVersion) {
  const userHome = resolveUserHome(options);
  const explicit = options.adapterPackagePath ?? options.packagePath;
  if (typeof explicit === 'string' && explicit.length > 0) {
    return [{ path: expandPath(explicit, userHome), source: 'manual', exclusive: true }];
  }
  const candidates = [];
  const home = options.home ?? options.mebularHome;
  if (typeof home === 'string' && home.length > 0) {
    candidates.push({
      path: join(home, MANAGED_DIR, MANAGED_NAME, expectedVersion),
      source: 'managed-dir',
    });
  }
  const resourcesPath = options.resourcesPath
    ?? process.env.MEBULAR_RESOURCES_PATH
    ?? process.resourcesPath;
  if (typeof resourcesPath === 'string' && resourcesPath.length > 0) {
    candidates.push({ path: join(resourcesPath, MANAGED_DIR, MANAGED_NAME), source: 'bundled' });
  }
  candidates.push({ path: join(REPO_ROOT, 'integrations', 'hermes', 'mebular-memory'), source: 'manual' });
  return candidates;
}

async function stageBundledPackage(source, options, expectedVersion) {
  const home = options.home ?? options.mebularHome;
  if (typeof home !== 'string' || home.length === 0) return null;
  const target = join(home, MANAGED_DIR, MANAGED_NAME, expectedVersion);
  const existing = readBundle(target);
  if (sameBundle(source, existing, expectedVersion)) {
    return { path: target, changed: false, created: false };
  }
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    await mkdir(dirname(target), { recursive: true });
    await rm(tmp, { recursive: true, force: true });
    await cp(source.path, tmp, { recursive: true, filter: skipArtifacts });
    const staged = readBundle(tmp);
    if (!sameBundle(source, staged, expectedVersion)) {
      await rm(tmp, { recursive: true, force: true });
      return null;
    }
    await rm(target, { recursive: true, force: true });
    await rename(tmp, target);
    return { path: target, changed: true, created: existing === null };
  } catch {
    try { await rm(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    return null;
  }
}

/**
 * Resolve the provider bundle. Order: explicit path, managed dir
 * (`<home>/adapters/hermes/<version>`), App bundle (`<resources>/adapters/hermes`),
 * repository checkout. Never npm; version must equal the App lockstep version.
 * `dryRun` and `stagePackage:false` are strictly read-only.
 */
export async function ensurePackage(options = {}) {
  const expectedVersion = options.expectedVersion ?? APP_VERSION;
  const candidates = packageCandidates(options, expectedVersion);
  let mismatch = null;
  for (const candidate of candidates) {
    if (!candidate?.path) continue;
    const bundle = readBundle(candidate.path);
    if (!bundle) {
      if (candidate.exclusive) return { ok: false, code: 'ADAPTER_PACKAGE_NOT_FOUND' };
      continue;
    }
    if (!bundleMatches(bundle, expectedVersion)) {
      mismatch = { version: bundle.version ?? null, name: bundle.name ?? null };
      if (candidate.exclusive) break;
      continue;
    }
    if (candidate.source === 'bundled') {
      const home = options.home ?? options.mebularHome;
      if (options.dryRun === true || options.stagePackage === false) {
        if (options.dryRun === true) {
          const plannedPath = typeof home === 'string' && home.length > 0
            ? join(home, MANAGED_DIR, MANAGED_NAME, expectedVersion)
            : resolve(candidate.path);
          const existing = readBundle(plannedPath);
          const alreadyManaged = sameBundle(bundle, existing, expectedVersion);
          return {
            ok: true,
            path: plannedPath,
            sourcePath: resolve(candidate.path),
            version: expectedVersion,
            source: 'managed-dir',
            changed: !alreadyManaged,
            created: false,
            planned: !alreadyManaged,
            managedPath: plannedPath,
          };
        }
        return {
          ok: true,
          path: resolve(candidate.path),
          version: expectedVersion,
          source: 'bundled',
          changed: false,
          created: false,
          planned: false,
          managedPath: null,
        };
      }
      const staged = await stageBundledPackage(bundle, options, expectedVersion);
      if (staged) {
        return {
          ok: true,
          path: staged.path,
          version: expectedVersion,
          source: 'managed-dir',
          changed: staged.changed,
          created: staged.created,
          planned: false,
          managedPath: staged.created ? staged.path : null,
        };
      }
    }
    return {
      ok: true,
      path: resolve(candidate.path),
      version: expectedVersion,
      source: candidate.source,
      changed: false,
      created: false,
      planned: false,
      managedPath: null,
    };
  }
  if (mismatch) return { ok: false, code: 'ADAPTER_VERSION_MISMATCH', version: mismatch.version };
  return { ok: false, code: 'ADAPTER_PACKAGE_NOT_FOUND' };
}

async function uniqueBackupPath(base) {
  const stamp = tsStamp();
  let candidate = `${base}.bak-${stamp}`;
  for (let index = 1; existsSync(candidate); index += 1) {
    candidate = `${base}.bak-${stamp}-${index}`;
  }
  return candidate;
}

function latestProviderBackup(target) {
  try {
    const dir = dirname(target);
    const prefix = `${basename(target)}.bak-`;
    const names = readdirSync(dir).filter((name) => name.startsWith(prefix)).sort();
    return names.length > 0 ? join(dir, names[names.length - 1]) : null;
  } catch {
    return null;
  }
}

function configBackupDir(options = {}) {
  const home = options.home ?? options.mebularHome;
  if (typeof home === 'string' && home.length > 0) return join(home, MANAGED_DIR, 'backups');
  return dirname(configPathFor(options));
}

function latestConfigBackup(options = {}) {
  try {
    const dir = configBackupDir(options);
    const prefix = `${basename(configPathFor(options))}.bak-`;
    const names = readdirSync(dir).filter((name) => name.startsWith(prefix)).sort();
    return names.length > 0 ? join(dir, names[names.length - 1]) : null;
  } catch {
    return null;
  }
}

function latestConfigAbsentMarker(options = {}) {
  try {
    const dir = configBackupDir(options);
    const names = readdirSync(dir).filter((name) => name.startsWith('config.absent-')).sort();
    return names.length > 0 ? join(dir, names[names.length - 1]) : null;
  } catch {
    return null;
  }
}

async function markConfigAbsent(options) {
  const dir = configBackupDir(options);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const stamp = tsStamp();
  let marker = join(dir, `config.absent-${stamp}`);
  for (let index = 1; existsSync(marker); index += 1) marker = join(dir, `config.absent-${stamp}-${index}`);
  await writeFile(marker, '', { encoding: 'utf-8', mode: 0o600 });
  return marker;
}

function latestProviderAbsentMarker(options = {}) {
  try {
    const dir = configBackupDir(options);
    const names = readdirSync(dir).filter((name) => name.startsWith('provider.absent-')).sort();
    return names.length > 0 ? join(dir, names[names.length - 1]) : null;
  } catch {
    return null;
  }
}

async function markProviderAbsent(options) {
  const dir = configBackupDir(options);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const stamp = tsStamp();
  let marker = join(dir, `provider.absent-${stamp}`);
  for (let index = 1; existsSync(marker); index += 1) marker = join(dir, `provider.absent-${stamp}-${index}`);
  await writeFile(marker, '', { encoding: 'utf-8', mode: 0o600 });
  return marker;
}

async function clearProviderAbsentMarkers(options) {
  try {
    const dir = configBackupDir(options);
    const names = readdirSync(dir).filter((name) => name.startsWith('provider.absent-'));
    await Promise.all(names.map((name) => rm(join(dir, name), { force: true })));
  } catch {
    // Diagnostic markers only.
  }
}

async function backupConfig(configPath, options) {
  const dir = configBackupDir(options);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const target = await uniqueBackupPath(join(dir, basename(configPath)));
  await copyFile(configPath, target);
  return target;
}

async function atomicWrite(file, text, mode = 0o600) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(tmp, text, { encoding: 'utf-8', mode });
    try { await chmod(tmp, mode); } catch { /* Windows 无 POSIX mode */ }
    await rename(tmp, file);
  } catch (error) {
    try { await rm(tmp, { force: true }); } catch { /* ignore */ }
    throw error;
  }
}

async function installProvider(sourcePath, options, expectedVersion) {
  const target = providerPathFor(options);
  if (isForbiddenPath(target, options)) return { ok: false, code: 'FORBIDDEN_PATH' };
  const source = readBundle(sourcePath);
  if (!bundleMatches(source, expectedVersion)) return { ok: false, code: 'ADAPTER_PACKAGE_INVALID' };
  const existing = readBundle(target);
  if (sameBundle(source, existing, expectedVersion) && options.force !== true) {
    return { ok: true, changed: false, backupPath: null, target };
  }
  if (options.dryRun === true) {
    return { ok: true, changed: true, planned: true, backupPath: null, target };
  }

  const pluginsDir = dirname(target);
  const stage = join(pluginsDir, `.mebular-stage-${process.pid}-${Date.now()}`);
  try {
    await mkdir(pluginsDir, { recursive: true });
    await rm(stage, { recursive: true, force: true });
    await cp(sourcePath, stage, { recursive: true, filter: skipArtifacts });
    if (!bundleMatches(readBundle(stage), expectedVersion)) {
      await rm(stage, { recursive: true, force: true });
      return { ok: false, code: 'PROVIDER_STAGE_FAILED' };
    }

    let backupPath = null;
    if (existsSync(target)) {
      backupPath = await uniqueBackupPath(target);
      await rename(target, backupPath);
    }
    try {
      await rename(stage, target);
    } catch {
      await rm(stage, { recursive: true, force: true });
      if (backupPath) {
        try { await rename(backupPath, target); } catch { /* ignore */ }
      }
      return { ok: false, code: 'PROVIDER_INSTALL_FAILED' };
    }
    return { ok: true, changed: true, backupPath, target };
  } catch {
    try { await rm(stage, { recursive: true, force: true }); } catch { /* ignore */ }
    return { ok: false, code: 'PROVIDER_INSTALL_FAILED' };
  }
}

async function undoProvider(install, options) {
  if (!install?.changed) return;
  const target = install.target ?? providerPathFor(options);
  if (install.backupPath && existsSync(install.backupPath)) {
    try {
      if (existsSync(target)) await rm(target, { recursive: true, force: true });
      await rename(install.backupPath, target);
    } catch {
      // Leave the backup in place for an explicit rollback.
    }
    return;
  }
  try { await rm(target, { recursive: true, force: true }); } catch { /* ignore */ }
}

async function undoConfig(configPath, configExisted, backupPath, absentMarker) {
  try {
    if (backupPath && existsSync(backupPath)) {
      const text = await readFile(backupPath, 'utf-8');
      let mode = 0o600;
      try { mode = (await stat(configPath)).mode & 0o777; } catch { /* newly created */ }
      await atomicWrite(configPath, text, mode);
    } else if (!configExisted && existsSync(configPath)) {
      await rm(configPath, { force: true });
    }
    if (absentMarker && existsSync(absentMarker)) await rm(absentMarker, { force: true });
  } catch {
    // Best effort; the config backup remains available for explicit rollback.
  }
}

function previewText(sourcePath, target, currentValue) {
  return [
    `install provider: ${sourcePath} -> ${target}`,
    `config ${CONFIG_KEY}: ${currentValue === null ? '(unset)' : JSON.stringify(currentValue)} -> ${JSON.stringify(PACKAGE_NAME)}`,
  ].join('\n');
}

/**
 * Configure: install the provider directory (staged + backup), then select it
 * through `hermes config set memory.provider mebular` and read it back.
 * `dryRun` performs read-only checks and returns the planned changes.
 */
export async function configure(options = {}) {
  const expectedVersion = options.expectedVersion ?? APP_VERSION;
  const hermesHome = hermesHomeFor(options);
  const configPath = configPathFor(options);
  const providerTarget = providerPathFor(options);
  if (isForbiddenPath(providerTarget, options) || isForbiddenPath(configPath, options)) {
    return { ok: false, code: 'FORBIDDEN_PATH' };
  }

  const packageInfo = options.packageInfo?.ok === true
    ? options.packageInfo
    : await ensurePackage({
      ...options,
      hermesHome,
      ...(options.dryRun === true ? { dryRun: true, stagePackage: false } : {}),
    });
  if (!packageInfo?.ok) return packageInfo;

  const sourcePath = options.dryRun === true && typeof packageInfo.sourcePath === 'string'
    ? packageInfo.sourcePath
    : packageInfo.path;
  const source = readBundle(sourcePath);
  if (!bundleMatches(source, expectedVersion)) return { ok: false, code: 'ADAPTER_PACKAGE_INVALID' };

  const current = await readProvider({ ...options, hermesHome, configPath });
  const needsInstall = !sameBundle(source, readBundle(providerTarget), expectedVersion);
  const needsConfig = current.value !== PACKAGE_NAME;
  const changed = needsInstall || needsConfig;

  if (options.dryRun === true) {
    return {
      ok: true,
      changed,
      dryRun: true,
      configPath,
      providerPath: providerTarget,
      backupPath: null,
      entry: { provider: PACKAGE_NAME },
      preview: previewText(sourcePath, providerTarget, current.value),
    };
  }

  let providerAbsentMarker = null;
  if (needsInstall && !existsSync(providerTarget)) {
    try {
      providerAbsentMarker = await markProviderAbsent(options);
    } catch {
      return { ok: false, code: 'PROVIDER_BACKUP_FAILED' };
    }
  }

  const install = await installProvider(packageInfo.path, { ...options, hermesHome }, expectedVersion);
  if (!install.ok) {
    if (providerAbsentMarker) {
      try { await rm(providerAbsentMarker, { force: true }); } catch { /* ignore */ }
    }
    return install;
  }
  if (install.backupPath) await clearProviderAbsentMarkers(options);
  if (!install.changed && providerAbsentMarker) {
    try { await rm(providerAbsentMarker, { force: true }); } catch { /* ignore */ }
    providerAbsentMarker = null;
  }

  let configBackup = null;
  let configAbsentMarker = null;
  if (needsConfig) {
    const configExisted = existsSync(configPath);
    if (configExisted) {
      try {
        configBackup = await backupConfig(configPath, options);
      } catch {
        await undoProvider(install, options);
        if (providerAbsentMarker) {
          try { await rm(providerAbsentMarker, { force: true }); } catch { /* ignore */ }
        }
        return { ok: false, code: 'CONFIG_BACKUP_FAILED', rolledBack: install.changed === true };
      }
    } else {
      try {
        configAbsentMarker = await markConfigAbsent(options);
      } catch {
        await undoProvider(install, options);
        if (providerAbsentMarker) {
          try { await rm(providerAbsentMarker, { force: true }); } catch { /* ignore */ }
        }
        return { ok: false, code: 'CONFIG_BACKUP_FAILED', rolledBack: install.changed === true };
      }
    }
    const set = await runHermesCli(['config', 'set', CONFIG_KEY, PACKAGE_NAME], options);
    if (!set.ok) {
      await undoProvider(install, options);
      await undoConfig(configPath, configExisted, configBackup, configAbsentMarker);
      if (providerAbsentMarker) {
        try { await rm(providerAbsentMarker, { force: true }); } catch { /* ignore */ }
      }
      return {
        ok: false,
        code: set.code === 'ENOENT' ? 'HERMES_CLI_UNAVAILABLE' : 'CONFIG_SET_FAILED',
        rolledBack: true,
      };
    }
    const readback = await readProvider({ ...options, hermesHome, configPath });
    if (readback.value !== PACKAGE_NAME) {
      await undoProvider(install, options);
      await undoConfig(configPath, configExisted, configBackup, configAbsentMarker);
      if (providerAbsentMarker) {
        try { await rm(providerAbsentMarker, { force: true }); } catch { /* ignore */ }
      }
      return { ok: false, code: 'CONFIG_VERIFY_FAILED', rolledBack: true };
    }
  }

  return {
    ok: true,
    changed,
    configPath,
    providerPath: providerTarget,
    backupPath: configBackup,
    configAbsentMarker,
    providerBackupPath: install.backupPath ?? null,
    entry: { provider: PACKAGE_NAME },
    preview: changed ? previewText(sourcePath, providerTarget, current.value) : '',
  };
}

/** Activation: injected reload/restart only; otherwise the next Hermes session. */
export async function activate(options = {}) {
  if (options.canRestartHost === true && typeof options.reloadHost === 'function') {
    try {
      await options.reloadHost();
      return { ok: true, activation: 'reload' };
    } catch {
      return { ok: false, code: 'ACTIVATION_FAILED', activation: 'next-start' };
    }
  }
  if (options.canRestartHost === true && typeof options.restartHost === 'function') {
    try {
      await options.restartHost();
      return { ok: true, activation: 'restart' };
    } catch {
      return { ok: false, code: 'ACTIVATION_FAILED', activation: 'next-start' };
    }
  }
  return { ok: true, activation: 'next-start' };
}

/**
 * Verify configuration only: provider dir + manifest, `memory.provider=mebular`,
 * version lockstep. `sync_turn` ingest health belongs to repair.
 */
export async function verify(options = {}) {
  const expectedVersion = options.expectedVersion ?? APP_VERSION;
  const target = providerPathFor(options);
  const checks = [];
  const bundle = readBundle(target);
  checks.push({ name: 'provider-dir', ok: bundle !== null });
  if (!bundle) {
    return { ok: false, code: 'VERIFY_PROVIDER_MISSING', checks, ingested: null, health: 'deferred' };
  }
  const nameOk = bundle.name === PACKAGE_NAME;
  checks.push({ name: 'provider-name', ok: nameOk });
  checks.push({ name: 'provider-entry', ok: bundle.hasInit === true });
  const versionOk = bundle.version === expectedVersion;
  checks.push({ name: 'version-lockstep', ok: versionOk });

  const provider = await readProvider(options);
  const selected = provider.value === PACKAGE_NAME;
  checks.push({ name: 'config-provider', ok: selected });

  let code = null;
  if (!nameOk || bundle.hasInit !== true) code = 'VERIFY_PROVIDER_INVALID';
  else if (!versionOk) code = 'VERIFY_VERSION_MISMATCH';
  else if (!selected) code = 'VERIFY_PROVIDER_NOT_SELECTED';
  const ok = code === null;
  return {
    ok,
    code,
    checks,
    version: bundle.version ?? null,
    provider: provider.value,
    ingested: null,
    health: 'deferred',
  };
}

async function restoreProvider(target, backup) {
  const current = existsSync(target) ? `${target}.rollback-${tsStamp()}` : null;
  try {
    if (current) await rename(target, current);
    try {
      await rename(backup, target);
    } catch {
      if (current) {
        try { await rename(current, target); } catch { /* ignore */ }
      }
      return false;
    }
    if (current) {
      try { await rm(current, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Roll back the provider directory and config. Hermes DB / session storage and
 * the provider's own `mebular-memory` spool are never touched.
 */
export async function rollback(options = {}) {
  const target = providerPathFor(options);
  const providerBackup = options.providerBackupPath ?? latestProviderBackup(target);
  const providerAbsentMarker = latestProviderAbsentMarker(options);
  let providerRestored = false;
  let removed = false;
  let ok = true;

  if (providerBackup && existsSync(providerBackup)) {
    providerRestored = await restoreProvider(target, providerBackup);
    if (!providerRestored) ok = false;
  } else if (providerAbsentMarker) {
    try {
      if (existsSync(target)) {
        await rm(target, { recursive: true, force: true });
        removed = true;
      }
      await rm(providerAbsentMarker, { force: true });
    } catch {
      ok = false;
    }
  }
  if (providerRestored) {
    try { await clearProviderAbsentMarkers(options); } catch { /* ignore */ }
  }

  const configPath = configPathFor(options);
  const configBackup = options.backupPath ?? latestConfigBackup(options);
  const absentMarker = latestConfigAbsentMarker(options);
  let configRestored = false;
  let configRemoved = false;
  if (configBackup && existsSync(configBackup)) {
    try {
      const text = await readFile(configBackup, 'utf-8');
      let mode = 0o600;
      try { mode = (await stat(configPath)).mode & 0o777; } catch { /* newly created */ }
      await atomicWrite(configPath, text, mode);
      configRestored = true;
    } catch {
      ok = false;
    }
  } else if (absentMarker && existsSync(absentMarker)) {
    try {
      if (existsSync(configPath)) {
        await rm(configPath, { force: true });
        configRemoved = true;
      }
      await rm(absentMarker, { force: true });
    } catch {
      ok = false;
    }
  }

  if (options.removePackage === true && options.packageInfo?.created === true
    && typeof options.packageInfo.managedPath === 'string') {
    const home = options.home ?? options.mebularHome;
    if (typeof home === 'string' && home.length > 0) {
      const managedRoot = join(home, MANAGED_DIR);
      if (options.packageInfo.managedPath === managedRoot
        || options.packageInfo.managedPath.startsWith(`${managedRoot}${sep}`)) {
        try { await rm(options.packageInfo.managedPath, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }
  }

  return {
    ok,
    code: ok ? null : 'ROLLBACK_FAILED',
    removed,
    restoredFrom: providerRestored || configRestored ? 'backup' : null,
    providerRestored,
    configRestored,
    configRemoved,
  };
}

export function createHermesAdapter() {
  return {
    hostId: 'hermes',
    displayName: 'Hermes',
    status: 'supported',
    package: { name: PACKAGE_NAME, version: APP_VERSION, source: 'bundled' },
    detect,
    ensurePackage,
    configure,
    activate,
    verify,
    rollback,
  };
}

export const hermesAdapter = createHermesAdapter();
