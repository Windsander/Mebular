// Adapter descriptor: DeepSeek Harness (DSH)
// (`@mebular/dsh-plugin` added to a DSH profile).
//
// Boundaries (see docs/integrations/DSH.md):
//   * the official CLI owns the profile: `dsh plugin --profile <profile> add
//     <absolute-path>`; this module never hand-writes DSH YAML;
//   * readback prefers `dsh --profile <profile> --dump-config`, then profile
//     files (`package.json` dependency / `cordis*.yml` entry);
//   * never touches DSH databases, session storage or transcripts;
//   * never downloads from npm: the package comes from the App bundle, a managed
//     directory, or (dev/tests) an injected path / this repository;
//   * never kills a host process: activation is an injected reload/restart
//     callback, otherwise `next-start`;
//   * idempotent configure, profile backup before the CLI runs, rollback via the
//     official `remove` command or the profile backup.

import { existsSync, readFileSync, readdirSync, statSync, accessSync, constants as fsConstants } from 'node:fs';
import { copyFile, cp, mkdir, rename, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_VERSION } from '../version.mjs';

export const PACKAGE_NAME = '@mebular/dsh-plugin';
export const PLUGIN_ID = 'mebular';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const MANAGED_DIR = 'adapters';
const MANAGED_NAME = 'dsh-plugin';
const PROFILE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PROFILE_FILES = ['package.json', 'cordis.yml', 'cordis.patch.yml', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'];
const DEPENDENCY_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const FORBIDDEN_SEGMENTS = new Set(['sessions', 'session', 'session-storage', 'storage', 'db', 'database']);
const FORBIDDEN_EXTENSIONS = /\.(?:db|sqlite|sqlite3|jsonl|log)$/i;

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

/** `<userHome>/.dsh`, or an explicit `dshHome` / `DSH_HOME` (tests inject one). */
export function resolveDshHome(options = {}, userHome = resolveUserHome(options)) {
  const explicit = options.dshHome;
  if (typeof explicit === 'string' && explicit.length > 0) return expandPath(explicit, userHome);
  const env = options.env ?? process.env;
  const fromEnv = env?.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return expandPath(fromEnv, userHome);
  return join(userHome, '.dsh');
}

function isExecutable(file) {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Locate the official CLI without running it. PATH is read from the injected env only. */
export function findDshCli(options = {}) {
  const env = options.env ?? process.env;
  const explicit = options.dshCliPath ?? options.cliPath ?? env?.DSH_CLI;
  if (typeof explicit === 'string' && explicit.length > 0) {
    const expanded = expandPath(explicit, resolveUserHome(options));
    return expanded && isExecutable(expanded) ? expanded : null;
  }
  const pathValue = typeof env?.PATH === 'string' ? env.PATH : '';
  const names = process.platform === 'win32' ? ['dsh.cmd', 'dsh.exe', 'dsh'] : ['dsh'];
  for (const dir of pathValue.split(delimiter)) {
    if (typeof dir !== 'string' || dir.length === 0) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

function listProfiles(dshHome) {
  const dir = join(dshHome, 'profiles');
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && PROFILE_ID_RE.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Resolve the target profile without guessing: explicit option, `DSH_PROFILE`,
 * or the only profile under `<dshHome>/profiles`. Multiple profiles without an
 * explicit choice is ambiguous and must fail closed.
 */
export function resolveProfile(options = {}, profiles = listProfiles(resolveDshHome(options))) {
  const env = options.env ?? process.env;
  const explicit = typeof options.profile === 'string' && options.profile.trim().length > 0
    ? options.profile.trim()
    : typeof env?.DSH_PROFILE === 'string' && env.DSH_PROFILE.trim().length > 0
      ? env.DSH_PROFILE.trim()
      : null;
  if (explicit) {
    if (!PROFILE_ID_RE.test(explicit)) return { id: null, source: 'invalid', profiles };
    return { id: explicit, source: options.profile ? 'option' : 'env', profiles };
  }
  if (profiles.length === 1) return { id: profiles[0], source: 'single', profiles };
  if (profiles.length === 0) return { id: null, source: 'none', profiles };
  return { id: null, source: 'ambiguous', profiles };
}

function profilePaths(profileDir) {
  const patchPath = join(profileDir, 'cordis.patch.yml');
  const cordisPath = join(profileDir, 'cordis.yml');
  const configPath = existsSync(patchPath) ? patchPath : existsSync(cordisPath) ? cordisPath : patchPath;
  return {
    profileDir,
    configPath,
    packagePath: join(profileDir, 'package.json'),
    patchPath,
    cordisPath,
    installedPackagePath: join(profileDir, 'node_modules', '@mebular', 'dsh-plugin'),
  };
}

function readManifest(dir) {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readJsonFile(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readTextFile(file) {
  try {
    return readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
}

function isProfileStructureKnown(profileDir) {
  if (!existsSync(profileDir)) return false;
  const packagePath = join(profileDir, 'package.json');
  if (existsSync(packagePath) && readJsonFile(packagePath) === null) return false;
  return PROFILE_FILES.some((name) => existsSync(join(profileDir, name)));
}

function specVersion(spec, options = {}) {
  if (typeof spec !== 'string' || spec.trim().length === 0) return null;
  let text = spec.trim();
  if (text.startsWith('npm:')) text = text.slice('npm:'.length);
  if (text.startsWith('workspace:')) text = text.slice('workspace:'.length);
  if (text.startsWith('file:')) {
    const raw = text.slice('file:'.length);
    const file = isAbsolute(raw) || raw === '~' || /^~[\\/]/.test(raw)
      ? expandPath(raw, resolveUserHome(options))
      : resolve(options.profileDir ?? '.', raw);
    const manifest = file ? readManifest(file) : null;
    return typeof manifest?.version === 'string' ? manifest.version : null;
  }
  const match = text.match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
  return match ? match[1] : null;
}

function specPath(spec) {
  if (typeof spec !== 'string') return null;
  const text = spec.trim();
  if (text.startsWith('file:')) return text.slice('file:'.length);
  return null;
}

function readMebularDependency(packagePath) {
  const manifest = readJsonFile(packagePath);
  if (!manifest) return null;
  for (const section of DEPENDENCY_SECTIONS) {
    const value = manifest[section]?.[PACKAGE_NAME];
    if (typeof value === 'string' && value.length > 0) return { section, spec: value };
  }
  return null;
}

/** Read-only profile readback: dependency, plugin entry, installed manifest. */
export function readProfileInstall(profileDir, options = {}) {
  const paths = profilePaths(profileDir);
  const readOptions = { ...options, profileDir };
  const result = {
    present: false,
    version: null,
    dependencySpec: null,
    entryPath: null,
    source: null,
  };
  const dependency = readMebularDependency(paths.packagePath);
  if (dependency) {
    result.present = true;
    result.source = 'dependency';
    result.dependencySpec = dependency.spec;
    const rawPath = specPath(dependency.spec);
    result.entryPath = rawPath
      ? (isAbsolute(rawPath) || rawPath === '~' || /^~[\\/]/.test(rawPath)
        ? expandPath(rawPath, resolveUserHome(options))
        : resolve(profileDir, rawPath))
      : null;
    result.version = specVersion(dependency.spec, readOptions);
  }
  const patch = readTextFile(paths.patchPath) ?? readTextFile(paths.cordisPath);
  if (typeof patch === 'string' && patch.includes(PACKAGE_NAME)) {
    result.present = true;
    if (result.source === null) result.source = 'profile-entry';
  }
  const installed = readManifest(paths.installedPackagePath);
  if (installed?.name === PACKAGE_NAME) {
    result.present = true;
    result.source = result.source ?? 'profile-entry';
    if (typeof installed.version === 'string') {
      result.version = installed.version;
      result.entryPath = result.entryPath ?? paths.installedPackagePath;
    }
  }
  return result;
}

function existingMatches(existing, expectedPath, expectedVersion) {
  if (!existing?.present) return false;
  if (existing.entryPath) {
    try {
      if (resolve(existing.entryPath) === resolve(expectedPath) && existing.version === expectedVersion) return true;
    } catch {
      // fall through to the version-only check
    }
  }
  return existing.version === expectedVersion;
}

function packageCandidates(options = {}) {
  const userHome = resolveUserHome(options);
  const explicit = options.adapterPackagePath ?? options.packagePath;
  if (typeof explicit === 'string' && explicit.length > 0) {
    return [{ path: expandPath(explicit, userHome), source: 'manual', exclusive: true }];
  }
  const candidates = [];
  const home = options.home ?? options.mebularHome;
  if (typeof home === 'string' && home.length > 0) {
    candidates.push({
      path: join(home, MANAGED_DIR, MANAGED_NAME, options.expectedVersion ?? APP_VERSION),
      source: 'managed-dir',
      managed: true,
    });
  }
  const resourcesPath = options.resourcesPath
    ?? (options.env ?? process.env).MEBULAR_RESOURCES_PATH
    ?? process.resourcesPath;
  if (typeof resourcesPath === 'string' && resourcesPath.length > 0) {
    candidates.push({ path: join(resourcesPath, MANAGED_DIR, MANAGED_NAME), source: 'bundled' });
    candidates.push({ path: join(resourcesPath, 'node_modules', '@mebular', 'dsh-plugin'), source: 'bundled' });
  }
  candidates.push({
    path: join(options.repoRoot ?? REPO_ROOT, 'packages', 'dsh-plugin'),
    source: 'manual',
  });
  return candidates;
}

async function stageBundledPackage(source, options, expectedVersion) {
  const home = options.home ?? options.mebularHome;
  if (typeof home !== 'string' || home.length === 0) return null;
  const target = join(home, MANAGED_DIR, MANAGED_NAME, expectedVersion);
  const existing = readManifest(target);
  if (existing?.name === PACKAGE_NAME && existing.version === expectedVersion) {
    return { path: target, changed: false, created: false };
  }
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    await mkdir(dirname(target), { recursive: true });
    await rm(tmp, { recursive: true, force: true });
    await cp(source, tmp, { recursive: true });
    await rm(target, { recursive: true, force: true });
    await rename(tmp, target);
    const staged = readManifest(target);
    if (staged?.name !== PACKAGE_NAME || staged.version !== expectedVersion) return null;
    return { path: target, changed: true, created: true };
  } catch {
    try { await rm(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    return null;
  }
}

/**
 * Ensure the adapter package is available. Bundled candidates may be staged to
 * `<home>/adapters/dsh-plugin/<version>`; managed dir and repository/dev paths
 * are used directly. No network access; the version must match the App.
 */
export async function ensurePackage(options = {}) {
  const expectedVersion = options.expectedVersion ?? APP_VERSION;
  const candidates = packageCandidates({ ...options, expectedVersion });
  let mismatch = null;
  for (const candidate of candidates) {
    if (!candidate?.path) continue;
    const manifest = readManifest(candidate.path);
    if (!manifest) {
      if (candidate.exclusive) return { ok: false, code: 'ADAPTER_PACKAGE_NOT_FOUND' };
      continue;
    }
    if (manifest.name !== PACKAGE_NAME || manifest.version !== expectedVersion) {
      mismatch = { version: manifest.version ?? null, name: manifest.name ?? null };
      if (candidate.exclusive) break;
      continue;
    }
    if (candidate.source === 'bundled' && (options.dryRun === true || options.stagePackage === false)) {
      if (options.dryRun === true) {
        const home = options.home ?? options.mebularHome;
        const plannedPath = typeof home === 'string' && home.length > 0
          ? join(home, MANAGED_DIR, MANAGED_NAME, expectedVersion)
          : resolve(candidate.path);
        const existingManaged = readManifest(plannedPath);
        const alreadyManaged = existingManaged?.name === PACKAGE_NAME && existingManaged.version === expectedVersion;
        return {
          ok: true,
          path: plannedPath,
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
    if (candidate.source === 'bundled' && options.stagePackage !== false) {
      const staged = await stageBundledPackage(candidate.path, options, expectedVersion);
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
      managedPath: null,
    };
  }
  if (mismatch) return { ok: false, code: 'ADAPTER_VERSION_MISMATCH', version: mismatch.version };
  return { ok: false, code: 'ADAPTER_PACKAGE_NOT_FOUND' };
}

/** DSH databases / session storage must never be written by provisioning. */
export function isForbiddenPath(file, options = {}) {
  if (typeof file !== 'string' || file.length === 0) return true;
  const absolute = resolve(file);
  const segments = absolute.split(sep).map((part) => part.toLowerCase());
  if (segments.some((part) => FORBIDDEN_SEGMENTS.has(part))) return true;
  if (FORBIDDEN_EXTENSIONS.test(basename(absolute))) return true;
  if (typeof options.forbiddenPath === 'string' && resolve(options.forbiddenPath) === absolute) return true;
  const roots = [
    ...(Array.isArray(options.forbiddenRoots) ? options.forbiddenRoots : []),
  ];
  if (roots.some((root) => typeof root === 'string' && (absolute === resolve(root) || absolute.startsWith(`${resolve(root)}${sep}`)))) return true;
  return (Array.isArray(options.forbiddenPaths) ? options.forbiddenPaths : []).some((entry) => (
    typeof entry === 'string' && resolve(entry) === absolute
  ));
}

function tsStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function backupRoot(options = {}) {
  const home = options.home ?? options.mebularHome;
  if (typeof home !== 'string' || home.length === 0) return null;
  return join(home, MANAGED_DIR, 'backups');
}

async function createProfileBackup(profileDir, options = {}) {
  const root = backupRoot(options);
  if (!root) return null;
  const target = join(root, `dsh-profile-${tsStamp()}-${process.pid}`);
  let copied = 0;
  try {
    for (const name of PROFILE_FILES) {
      const source = join(profileDir, name);
      if (!existsSync(source)) continue;
      await mkdir(target, { recursive: true, mode: 0o700 });
      await copyFile(source, join(target, name));
      copied += 1;
    }
    return copied > 0 ? target : null;
  } catch {
    try { await rm(target, { recursive: true, force: true }); } catch { /* ignore */ }
    return null;
  }
}

async function latestBackup(options = {}) {
  const root = backupRoot(options);
  if (!root) return null;
  try {
    const names = readdirSync(root)
      .filter((name) => name.startsWith('dsh-profile-'))
      .sort()
      .reverse();
    return names.length > 0 ? join(root, names[0]) : null;
  } catch {
    return null;
  }
}

async function restoreProfileBackup(backupDir, profileDir) {
  if (typeof backupDir !== 'string' || !existsSync(backupDir)) return false;
  let names = [];
  try {
    names = readdirSync(backupDir);
  } catch {
    return false;
  }
  let restored = false;
  for (const name of names) {
    if (!PROFILE_FILES.includes(name)) continue;
    try {
      await copyFile(join(backupDir, name), join(profileDir, name));
      restored = true;
    } catch {
      // Keep restoring the other files; the caller records a stable failure.
    }
  }
  return restored;
}

function cliEnv(options, dshHome) {
  return {
    ...process.env,
    ...(options.env ?? {}),
    ...(typeof dshHome === 'string' && dshHome.length > 0 ? { DSH_HOME: dshHome } : {}),
  };
}

function runCli(cliPath, args, options, dshHome) {
  return new Promise((resolvePromise) => {
    try {
      execFile(
        cliPath,
        args,
        {
          timeout: options.cliTimeoutMs ?? 15_000,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
          ...(typeof options.cwd === 'string' ? { cwd: options.cwd } : {}),
          env: cliEnv(options, dshHome),
        },
        (error, stdout, stderr) => {
          resolvePromise({
            ok: !error,
            code: typeof error?.code === 'number' ? error.code : error ? 1 : 0,
            stdout: typeof stdout === 'string' ? stdout.slice(0, 64 * 1024) : '',
            stderr: typeof stderr === 'string' ? stderr.slice(0, 64 * 1024) : '',
            timedOut: error?.killed === true,
          });
        },
      );
    } catch {
      resolvePromise({ ok: false, code: 1, stdout: '', stderr: '', timedOut: false });
    }
  });
}

async function readOfficialConfig(cliPath, profile, options, dshHome) {
  const result = await runCli(cliPath, ['--profile', profile, '--dump-config'], options, dshHome);
  if (!result.ok) return { ok: false, present: false };
  return { ok: true, present: result.stdout.includes(PACKAGE_NAME) };
}

function normalizeProfileTarget(options = {}) {
  const userHome = resolveUserHome(options);
  const dshHome = resolveDshHome(options, userHome);
  const explicitDir = typeof options.profileDir === 'string' && options.profileDir.length > 0
    ? expandPath(options.profileDir, userHome)
    : null;
  const resolved = resolveProfile(options, listProfiles(dshHome));
  const profile = resolved.id ?? (explicitDir ? basename(explicitDir) : null);
  const profileDir = explicitDir ?? (resolved.id ? join(dshHome, 'profiles', resolved.id) : null);
  return { userHome, dshHome, resolved, profile, profileDir };
}

/**
 * Detect DSH: CLI presence, `<dshHome>/profiles`, and a resolvable profile.
 * Pure read-only; never spawns the CLI and never guesses a port.
 */
export async function detect(options = {}) {
  const { dshHome, resolved, profile, profileDir } = normalizeProfileTarget(options);
  const cliPath = findDshCli(options);
  const paths = profileDir ? profilePaths(profileDir) : null;
  const profilesDir = join(dshHome, 'profiles');
  const profileHit = profileDir ? existsSync(profileDir) : false;
  const configHit = paths ? existsSync(paths.configPath) : false;
  return {
    detected: Boolean(cliPath) || existsSync(dshHome) || existsSync(profilesDir),
    configPath: paths?.configPath ?? null,
    dshHome,
    cliPath,
    profile: profile ?? null,
    profileDir: profileDir ?? null,
    profileSource: resolved.source,
    profileUnknown: profile === null,
    signals: [
      { kind: 'cli', source: 'dsh', hit: Boolean(cliPath) },
      { kind: 'profiles-dir', source: profilesDir, hit: existsSync(profilesDir) },
      { kind: 'profile-dir', source: profileDir ?? '', hit: profileHit },
      { kind: 'profile-config', source: paths?.configPath ?? '', hit: configHit },
    ],
  };
}

function lineDiff(before, after) {
  const a = String(before ?? '').split('\n');
  const b = String(after ?? '').split('\n');
  const out = [];
  const max = Math.max(a.length, b.length);
  for (let index = 0; index < max; index += 1) {
    if (a[index] === b[index]) continue;
    if (a[index] !== undefined) out.push(`- ${a[index]}`);
    if (b[index] !== undefined) out.push(`+ ${b[index]}`);
  }
  return out.join('\n');
}

function normalizedPackage(options = {}) {
  return options.packageInfo?.ok === true ? options.packageInfo : null;
}

/**
 * Configure the profile through the official CLI. `dryRun` only reports the
 * planned command and never spawns the CLI or writes a backup.
 */
export async function configure(options = {}) {
  const { dshHome, resolved, profile, profileDir } = normalizeProfileTarget(options);
  const expectedVersion = options.expectedVersion ?? APP_VERSION;
  if (!profile || !profileDir) return { ok: false, code: 'DSH_PROFILE_UNKNOWN', reason: resolved.source };
  if (isForbiddenPath(profileDir, options)) return { ok: false, code: 'FORBIDDEN_PATH' };
  const paths = profilePaths(profileDir);
  if (isForbiddenPath(paths.configPath, options)) return { ok: false, code: 'FORBIDDEN_PATH' };
  if (typeof options.configPath === 'string' && isForbiddenPath(options.configPath, options)) {
    return { ok: false, code: 'FORBIDDEN_PATH' };
  }
  if (!isProfileStructureKnown(profileDir)) return { ok: false, code: 'DSH_PROFILE_UNKNOWN', reason: 'structure' };

  const packageInfo = normalizedPackage(options) ?? await ensurePackage({
    ...options,
    expectedVersion,
    ...(options.dryRun === true ? { dryRun: true, stagePackage: false } : {}),
  });
  if (!packageInfo.ok) return packageInfo;

  const existing = readProfileInstall(profileDir, options);
  if (existingMatches(existing, packageInfo.path, expectedVersion)) {
    return {
      ok: true,
      changed: false,
      configPath: paths.configPath,
      backupPath: null,
      preview: '',
      command: null,
      existing,
    };
  }

  const command = ['plugin', '--profile', profile, 'add', packageInfo.path];
  if (options.dryRun === true) {
    return {
      ok: true,
      changed: true,
      dryRun: true,
      configPath: paths.configPath,
      backupPath: null,
      preview: `+ dsh ${command.join(' ')}`,
      command: ['dsh', ...command],
      existing,
    };
  }

  const cliPath = findDshCli(options);
  if (!cliPath) return { ok: false, code: 'DSH_CLI_NOT_FOUND' };

  const backupPath = await createProfileBackup(profileDir, options);
  const result = await runCli(cliPath, command, options, dshHome);
  if (!result.ok) {
    if (backupPath) await restoreProfileBackup(backupPath, profileDir);
    return {
      ok: false,
      code: result.timedOut ? 'DSH_PLUGIN_ADD_TIMEOUT' : 'DSH_PLUGIN_ADD_FAILED',
      configPath: paths.configPath,
      backupPath,
    };
  }

  const official = await readOfficialConfig(cliPath, profile, options, dshHome);
  const after = readProfileInstall(profileDir, options);
  const verified = (official.ok && official.present) || after.present;
  if (!verified) {
    if (backupPath) await restoreProfileBackup(backupPath, profileDir);
    return {
      ok: false,
      code: 'DSH_CONFIGURE_UNVERIFIED',
      configPath: paths.configPath,
      backupPath,
    };
  }

  return {
    ok: true,
    changed: true,
    configPath: paths.configPath,
    backupPath,
    preview: lineDiff('', `dsh ${command.join(' ')}`),
    command: ['dsh', ...command],
    existing: after,
  };
}

/** Activation: only injected safe callbacks; otherwise next-start. Never signals a process. */
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

function referencedManifest(existing, packageInfo) {
  if (existing?.entryPath) {
    const manifest = readManifest(existing.entryPath);
    if (manifest?.name === PACKAGE_NAME) return manifest;
  }
  if (packageInfo?.path) {
    const manifest = readManifest(packageInfo.path);
    if (manifest?.name === PACKAGE_NAME) return manifest;
  }
  return null;
}

/**
 * Verify readback: official dump-config when the CLI exists, else profile
 * files; package presence and version lockstep. Ingest health is left to repair.
 */
export async function verify(options = {}) {
  const { dshHome, resolved, profile, profileDir } = normalizeProfileTarget(options);
  const expectedVersion = options.expectedVersion ?? APP_VERSION;
  const checks = [];
  if (!profile || !profileDir) {
    return { ok: false, code: 'DSH_PROFILE_UNKNOWN', checks: [{ name: 'profile-known', ok: false }], ingested: null, reason: resolved.source };
  }
  checks.push({ name: 'profile-known', ok: true });
  if (isForbiddenPath(profileDir, options)) {
    return { ok: false, code: 'FORBIDDEN_PATH', checks: [...checks, { name: 'path-allowed', ok: false }], ingested: null };
  }
  if (!isProfileStructureKnown(profileDir)) {
    return { ok: false, code: 'VERIFY_STRUCTURE_UNKNOWN', checks: [...checks, { name: 'profile-structure', ok: false }], ingested: null };
  }
  checks.push({ name: 'profile-structure', ok: true });

  const existing = readProfileInstall(profileDir, options);
  const cliPath = findDshCli(options);
  let official = null;
  if (cliPath) {
    official = await readOfficialConfig(cliPath, profile, options, dshHome);
  }
  const entryOk = official?.ok ? official.present : existing.present;
  checks.push({ name: 'entry-present', ok: entryOk, source: official?.ok ? 'cli' : 'profile' });
  if (!entryOk) {
    return { ok: false, code: 'VERIFY_ENTRY_MISSING', checks, version: existing.version ?? null, ingested: null };
  }

  const packageInfo = normalizedPackage(options) ?? await ensurePackage({ ...options, expectedVersion, stagePackage: false });
  const manifest = referencedManifest(existing, packageInfo);
  const packageOk = manifest?.name === PACKAGE_NAME;
  checks.push({ name: 'package-exists', ok: packageOk });

  const installedVersion = existing.version
    ?? (existing.dependencySpec ? specVersion(existing.dependencySpec, options) : null)
    ?? (entryOk ? packageInfo.version : null);
  const versionOk = installedVersion === expectedVersion;
  checks.push({ name: 'version-lockstep', ok: versionOk });

  const ok = checks.every((check) => check.ok);
  return {
    ok,
    code: ok ? null : packageOk ? 'VERIFY_VERSION_MISMATCH' : 'VERIFY_PACKAGE_MISSING',
    checks,
    version: installedVersion ?? manifest?.version ?? null,
    ingested: null,
    health: 'deferred',
  };
}

/**
 * Rollback: official `dsh plugin remove` when available, otherwise restore the
 * profile backup. Databases and session storage are never touched.
 */
export async function rollback(options = {}) {
  const { dshHome, profile, profileDir } = normalizeProfileTarget(options);
  if (!profile || !profileDir) return { ok: false, code: 'DSH_PROFILE_UNKNOWN' };
  if (isForbiddenPath(profileDir, options)) return { ok: false, code: 'FORBIDDEN_PATH' };

  let removed = false;
  let restoredFrom = null;
  let usedBackup = null;
  const cliPath = findDshCli(options);
  let cliSucceeded = false;
  if (cliPath) {
    const result = await runCli(cliPath, ['plugin', '--profile', profile, 'remove', PACKAGE_NAME], options, dshHome);
    if (result.ok) {
      cliSucceeded = true;
      removed = true;
    }
  }

  if (!cliSucceeded) {
    const backupPath = options.backupPath ?? await latestBackup(options);
    if (backupPath && existsSync(backupPath)) {
      const restored = await restoreProfileBackup(backupPath, profileDir);
      if (!restored) return { ok: false, code: 'DSH_ROLLBACK_FAILED' };
      restoredFrom = 'backup';
      usedBackup = backupPath;
    } else if (!readProfileInstall(profileDir, options).present) {
      // Nothing to remove and nothing to restore: already clean.
      return { ok: true, removed: false, restoredFrom: null };
    } else {
      return { ok: false, code: 'DSH_ROLLBACK_UNAVAILABLE' };
    }
  }

  const home = options.home ?? options.mebularHome;
  const packageInfo = normalizedPackage(options);
  if (options.removePackage === true
    && packageInfo?.created === true
    && typeof packageInfo.managedPath === 'string'
    && typeof home === 'string') {
    const managedRoot = join(home, MANAGED_DIR);
    if (packageInfo.managedPath === managedRoot || packageInfo.managedPath.startsWith(`${managedRoot}${sep}`)) {
      try { await rm(packageInfo.managedPath, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  return { ok: true, removed, restoredFrom, backupPath: usedBackup };
}

export function createDshAdapter({ hostId = 'dsh', displayName = 'DeepSeek Harness (DSH)' } = {}) {
  return {
    hostId,
    displayName,
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

export const dshAdapter = createDshAdapter();
