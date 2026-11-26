// Adapter descriptor: OpenCode / OpenChamber
// (`@mebular/opencode-plugin` in the host's global `plugins` array).
//
// Boundaries (see packages/opencode-plugin/README.md):
//   * only `~/.config/opencode/opencode.json` → `plugins` is merged;
//   * never writes OpenChamber's `opencode.managed.json` or `run/instances/*`;
//   * never downloads from npm: package comes from the App bundle, a managed
//     directory, or (dev/tests) an injected path / this repository;
//   * never kills a host process: activation is an injected reload/restart
//     callback, otherwise `next-start`;
//   * idempotent merge, byte-level `.bak-<ts>`, atomic write, rollback.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { chmod, copyFile, cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_VERSION } from '../version.mjs';

export const PACKAGE_NAME = '@mebular/opencode-plugin';
export const PLUGIN_OPTIONS = Object.freeze({ agentId: 'opencode', recall: true, ingest: true });

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const MANAGED_DIR = 'adapters';
const MANAGED_NAME = 'opencode-plugin';

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

export function configPathFor(options = {}) {
  const explicit = options.configPath ?? options.primaryPath;
  const userHome = resolveUserHome(options);
  if (typeof explicit === 'string' && explicit.length > 0) return expandPath(explicit, userHome);
  return join(userHome, '.config', 'opencode', 'opencode.json');
}

/** 宿主是否可被视为存在（配置文件或配置目录）。纯只读，不 spawn CLI。 */
export function detect(options = {}) {
  const configPath = configPathFor(options);
  const fileHit = existsSync(configPath);
  const dirHit = existsSync(dirname(configPath));
  return {
    detected: fileHit || dirHit,
    configPath,
    signals: [
      { kind: 'config-file', source: 'opencode.json', hit: fileHit },
      { kind: 'config-dir', source: dirname(configPath), hit: dirHit },
    ],
  };
}

/** 禁写路径：OpenChamber 私有 managed config 及其 run/instances 副本。 */
export function isForbiddenPath(file, options = {}) {
  if (typeof file !== 'string' || file.length === 0) return true;
  if (basename(file) === 'opencode.managed.json') return true;
  const userHome = resolveUserHome(options);
  const openChamberDir = typeof options.openChamberDataDir === 'string' && options.openChamberDataDir.length > 0
    ? options.openChamberDataDir
    : join(userHome, '.config', 'openchamber');
  const roots = [
    join(openChamberDir, 'run', 'instances'),
    ...(Array.isArray(options.forbiddenRoots) ? options.forbiddenRoots : []),
  ];
  if (roots.some((root) => typeof root === 'string' && (file === root || file.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)))) return true;
  return (Array.isArray(options.forbiddenPaths) ? options.forbiddenPaths : []).includes(file);
}

function readManifest(dir) {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
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
    ?? process.env.MEBULAR_RESOURCES_PATH
    ?? process.resourcesPath;
  if (typeof resourcesPath === 'string' && resourcesPath.length > 0) {
    candidates.push({ path: join(resourcesPath, MANAGED_DIR, MANAGED_NAME), source: 'bundled' });
    candidates.push({ path: join(resourcesPath, 'node_modules', '@mebular', 'opencode-plugin'), source: 'bundled' });
  }
  candidates.push({
    path: join(options.repoRoot ?? REPO_ROOT, 'packages', 'opencode-plugin'),
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
    if (staged?.name !== PACKAGE_NAME || staged.version !== expectedVersion) {
      return null;
    }
    return { path: target, changed: true, created: true };
  } catch {
    try { await rm(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    return null;
  }
}

/**
 * 确保 adapter 包可用。优先 bundle（可 staging 到 `<home>/adapters/...`），
 * 其次 managed dir，最后本仓库 `packages/opencode-plugin`（测试可注入绝对路径）。
 * 不访问网络；版本必须与 App lockstep。
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
      // Read-only resolution (verify/rollback): inspect the bundled package
      // itself; never stage it.
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

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function samePath(value, target) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (!(value.startsWith('/') || value.startsWith('./') || value.startsWith('../') || /^~[\\/]/.test(value))) return false;
  try {
    return resolve(value) === resolve(target);
  } catch {
    return false;
  }
}

function entryRefs(entry) {
  if (typeof entry === 'string') return [entry];
  if (!isPlainObject(entry)) return [];
  return ['package', 'path', 'module', 'plugin']
    .map((key) => entry[key])
    .filter((value) => typeof value === 'string' && value.length > 0);
}

function isMebularEntry(entry, pluginPath) {
  return entryRefs(entry).some((ref) => (
    ref === PACKAGE_NAME
    || samePath(ref, pluginPath)
    || (ref.startsWith('file:') && samePath(ref.slice('file:'.length), pluginPath))
  ));
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function canonicalEntry(existing, pluginPath) {
  const base = isPlainObject(existing) ? { ...existing } : {};
  const usePath = typeof base.path === 'string' && typeof base.package !== 'string';
  delete base.package;
  delete base.path;
  delete base.module;
  delete base.plugin;
  delete base.options;
  const options = {
    ...(isPlainObject(existing?.options) ? existing.options : {}),
    ...PLUGIN_OPTIONS,
  };
  const entry = { ...base };
  if (usePath) entry.path = pluginPath;
  else entry.package = pluginPath;
  entry.options = options;
  return entry;
}

/** 合并 `plugins` 数组：按 package/path 去重，保留用户其他插件。 */
export function mergePlugins(document, pluginPath) {
  if (!isPlainObject(document)) return { error: 'CONFIG_STRUCTURE_UNKNOWN' };
  const plugins = document.plugins;
  if (plugins !== undefined && !Array.isArray(plugins)) return { error: 'CONFIG_STRUCTURE_UNKNOWN' };
  const list = Array.isArray(plugins) ? plugins : [];
  const matches = [];
  list.forEach((entry, index) => {
    if (isMebularEntry(entry, pluginPath)) matches.push(index);
  });
  const entry = canonicalEntry(matches.length > 0 ? list[matches[0]] : null, pluginPath);
  const nextPlugins = [];
  list.forEach((item, index) => {
    if (matches.includes(index)) {
      if (index === matches[0]) nextPlugins.push(entry);
      return;
    }
    nextPlugins.push(item);
  });
  if (matches.length === 0) nextPlugins.push(entry);
  const changed = stableStringify(list) !== stableStringify(nextPlugins);
  return {
    changed,
    plugins: nextPlugins,
    entry,
    duplicates: Math.max(0, matches.length - 1),
    document: { ...document, plugins: nextPlugins },
  };
}

function removeMebularPlugins(document, pluginPath) {
  if (!isPlainObject(document)) return { error: 'CONFIG_STRUCTURE_UNKNOWN' };
  const plugins = document.plugins;
  if (!Array.isArray(plugins)) return { error: 'CONFIG_STRUCTURE_UNKNOWN' };
  const nextPlugins = plugins.filter((entry) => !isMebularEntry(entry, pluginPath));
  return {
    changed: nextPlugins.length !== plugins.length,
    plugins: nextPlugins,
    document: { ...document, plugins: nextPlugins },
  };
}

function tsStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function adapterBackupDir(file, options = {}) {
  const home = options.home ?? options.mebularHome;
  if (typeof home === 'string' && home.length > 0) return join(home, MANAGED_DIR, 'backups');
  return dirname(file);
}

async function uniqueBackupPath(file, options = {}, existingBackup) {
  if (typeof existingBackup === 'string' && existingBackup.length > 0) return existingBackup;
  const dir = adapterBackupDir(file, options);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const base = join(dir, `${basename(file)}.bak-${tsStamp()}`);
  if (!existsSync(base)) return base;
  for (let index = 1; index < 100; index += 1) {
    const candidate = `${base}-${index}`;
    if (!existsSync(candidate)) return candidate;
  }
  return `${base}-${process.pid}`;
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
  if (options.packageInfo?.ok === true) return options.packageInfo;
  return null;
}

/**
 * Replace only the top-level `plugins` value, keeping every other byte of the
 * host config intact (reuse the tested JSON splice from clients.mjs).
 */
async function formatPluginsWrite(existingText, plugins, fallbackDocument) {
  if (typeof existingText !== 'string' || existingText.trim().length === 0) {
    return `${JSON.stringify(fallbackDocument, null, 2)}\n`;
  }
  try {
    const { mergeJsonEntry } = await import('../clients.mjs');
    const merged = mergeJsonEntry(existingText, {
      format: 'opencode-json',
      entry: plugins,
      keyPath: ['plugins'],
      preserveFormatting: true,
    });
    if (typeof merged?.text === 'string' && merged.text.length > 0) return merged.text;
  } catch {
    // Fall back to full serialization if the splice is unavailable.
  }
  return `${JSON.stringify(fallbackDocument, null, 2)}\n`;
}

/**
 * 配置步骤：只合并 `plugins`，写前备份、原子写、结构未知不写。
 * `options.dryRun` 只返回 diff，不落盘。
 */
export async function configure(options = {}) {
  const configPath = configPathFor(options);
  if (isForbiddenPath(configPath, options)) return { ok: false, code: 'FORBIDDEN_PATH' };
  const packageInfo = normalizedPackage(options) ?? await ensurePackage({
    ...options,
    ...(options.dryRun === true ? { dryRun: true, stagePackage: false } : {}),
  });
  if (!packageInfo.ok) return packageInfo;
  const pluginPath = packageInfo.path;

  let existingText = null;
  try {
    existingText = await readFile(configPath, 'utf-8');
  } catch (error) {
    if (error?.code !== 'ENOENT') return { ok: false, code: 'CONFIG_UNREADABLE' };
  }

  let document = {};
  if (existingText !== null && existingText.trim().length > 0) {
    try {
      document = JSON.parse(existingText);
    } catch {
      return { ok: false, code: 'CONFIG_UNPARSEABLE' };
    }
    if (!isPlainObject(document)) return { ok: false, code: 'CONFIG_STRUCTURE_UNKNOWN' };
  }

  const merged = mergePlugins(document, pluginPath);
  if (merged.error) return { ok: false, code: merged.error };
  if (!merged.changed) {
    return {
      ok: true,
      changed: false,
      configPath,
      backupPath: null,
      entry: merged.entry,
      preview: '',
    };
  }

  const nextText = await formatPluginsWrite(existingText, merged.plugins, merged.document);
  if (options.dryRun === true) {
    return {
      ok: true,
      changed: true,
      dryRun: true,
      configPath,
      backupPath: null,
      entry: merged.entry,
      preview: lineDiff(existingText ?? '', nextText),
    };
  }

  let backupPath = null;
  let originalMode = 0o600;
  if (existingText !== null) {
    backupPath = await uniqueBackupPath(configPath, options, options.backupPath);
    await copyFile(configPath, backupPath);
    try {
      originalMode = (await stat(configPath)).mode & 0o777;
    } catch {
      originalMode = 0o600;
    }
  }
  try {
    await atomicWrite(configPath, nextText, originalMode);
  } catch {
    if (backupPath) {
      try { await copyFile(backupPath, configPath); } catch { /* ignore */ }
    }
    return { ok: false, code: 'WRITE_FAILED', rolledBack: Boolean(backupPath) };
  }
  return {
    ok: true,
    changed: true,
    configPath,
    backupPath,
    entry: merged.entry,
    preview: lineDiff(existingText ?? '', nextText),
  };
}

/** 激活：只调用注入的安全回调；没有能力即 next-start，绝不杀进程。 */
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

function entryPluginPath(entry, fallback) {
  const refs = entryRefs(entry);
  if (refs.length === 0) return fallback ?? null;
  const ref = refs[0];
  if (ref === PACKAGE_NAME) return fallback ?? null;
  if (ref.startsWith('file:')) return ref.slice('file:'.length);
  return ref;
}

/** 验证：配置回读 + 条目唯一 + 包存在 + 版本 lockstep。ingest 健康留给 repair。 */
export async function verify(options = {}) {
  const configPath = configPathFor(options);
  const expectedVersion = options.expectedVersion ?? APP_VERSION;
  const checks = [];
  if (!existsSync(configPath)) {
    return { ok: false, code: 'VERIFY_CONFIG_MISSING', checks: [{ name: 'config-exists', ok: false }], ingested: null };
  }
  checks.push({ name: 'config-exists', ok: true });
  let document;
  try {
    document = JSON.parse(await readFile(configPath, 'utf-8'));
  } catch {
    return { ok: false, code: 'VERIFY_CONFIG_UNPARSEABLE', checks: [...checks, { name: 'config-readable', ok: false }], ingested: null };
  }
  if (!isPlainObject(document) || !Array.isArray(document.plugins)) {
    return { ok: false, code: 'VERIFY_STRUCTURE_UNKNOWN', checks: [...checks, { name: 'plugins-array', ok: false }], ingested: null };
  }
  checks.push({ name: 'plugins-array', ok: true });
  const packageInfo = normalizedPackage(options) ?? await ensurePackage({ ...options, stagePackage: false });
  const pluginPath = packageInfo.ok ? packageInfo.path : null;
  const matches = document.plugins.filter((entry) => isMebularEntry(entry, pluginPath));
  const unique = matches.length === 1;
  checks.push({ name: 'entry-unique', ok: unique });
  if (!unique) {
    return { ok: false, code: 'VERIFY_ENTRY_MISSING', checks, ingested: null };
  }
  const entry = matches[0];
  const optionsOk = isPlainObject(entry) && isPlainObject(entry.options)
    && entry.options.agentId === PLUGIN_OPTIONS.agentId
    && entry.options.recall === true
    && entry.options.ingest === true;
  checks.push({ name: 'options', ok: optionsOk });

  const referenced = entryPluginPath(entry, pluginPath);
  const manifest = referenced ? readManifest(referenced) : null;
  const packageOk = manifest?.name === PACKAGE_NAME;
  checks.push({ name: 'package-exists', ok: packageOk });
  const versionOk = manifest?.version === expectedVersion;
  checks.push({ name: 'version-lockstep', ok: versionOk });

  const ok = checks.every((check) => check.ok);
  return {
    ok,
    code: ok ? null : packageOk ? 'VERIFY_OPTIONS_MISMATCH' : 'VERIFY_PACKAGE_MISSING',
    checks,
    version: manifest?.version ?? null,
    ingested: null,
    health: 'deferred',
  };
}

async function latestBackup(file, options = {}) {
  try {
    const dir = adapterBackupDir(file, options);
    const prefix = `${basename(file)}.bak-`;
    const candidates = readdirSync(dir).filter((name) => name.startsWith(prefix)).sort().reverse();
    return candidates.length > 0 ? join(dir, candidates[0]) : null;
  } catch {
    return null;
  }
}

/** 回滚：显式备份优先；否则最新备份；再否则移除 Mebular 自己的 plugin 条目。 */
export async function rollback(options = {}) {
  const home = options.home ?? options.mebularHome;
  const packageInfo = normalizedPackage(options);
  if (options.removePackage === true && packageInfo?.created === true && typeof packageInfo.managedPath === 'string' && typeof home === 'string') {
    const managedRoot = join(home, MANAGED_DIR);
    if (packageInfo.managedPath === managedRoot || packageInfo.managedPath.startsWith(`${managedRoot}${sep}`)) {
      try { await rm(packageInfo.managedPath, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  const configPath = configPathFor(options);
  if (!existsSync(configPath)) return { ok: true, removed: false, restoredFrom: null };

  const target = options.backupPath ?? await latestBackup(configPath, options);
  if (target && existsSync(target)) {
    const safety = await uniqueBackupPath(configPath, options);
    await copyFile(configPath, safety);
    try {
      await atomicWrite(configPath, await readFile(target, 'utf-8'));
    } catch {
      return { ok: false, code: 'ROLLBACK_FAILED' };
    }
    return { ok: true, removed: false, restoredFrom: 'backup', backupPath: safety };
  }

  let document;
  let existingText;
  try {
    existingText = await readFile(configPath, 'utf-8');
    document = JSON.parse(existingText);
  } catch {
    return { ok: false, code: 'CONFIG_UNPARSEABLE' };
  }
  const packageInfoForPath = normalizedPackage(options) ?? await ensurePackage({ ...options, stagePackage: false });
  const pluginPath = packageInfoForPath.ok ? packageInfoForPath.path : null;
  const removed = removeMebularPlugins(document, pluginPath);
  if (removed.error) return { ok: false, code: removed.error };
  if (!removed.changed) return { ok: true, removed: false, restoredFrom: null };

  const safety = await uniqueBackupPath(configPath, options);
  await copyFile(configPath, safety);
  try {
    await atomicWrite(configPath, await formatPluginsWrite(existingText, removed.plugins, removed.document));
  } catch {
    return { ok: false, code: 'ROLLBACK_FAILED' };
  }
  return { ok: true, removed: true, restoredFrom: null, backupPath: safety };
}

/**
 * descriptor 工厂。opencode/openchamber 共享同一份 global 配置，但状态按 hostId 分开。
 */
export function createOpenCodeAdapter({ hostId = 'opencode', displayName = 'OpenCode' } = {}) {
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

export const openCodeAdapter = createOpenCodeAdapter({ hostId: 'opencode', displayName: 'OpenCode' });
export const openChamberAdapter = createOpenCodeAdapter({ hostId: 'openchamber', displayName: 'OpenChamber' });
