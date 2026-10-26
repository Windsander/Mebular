// @mebular/dsh-plugin host plugin.
//
// Boundary: this file is pure ESM with Node built-ins only. It never imports
// @mebular/*, never reads Mebular configuration or secrets, and never writes to
// the Mebular home directory. The single external module is the official DSH
// MCP bridge peer, loaded lazily at apply time (never at module top level).
//
// Lifecycle:
//   - `attach` (default): resolve + probe an existing daemon. Never spawn or stop.
//   - `managed`: reuse a healthy daemon; otherwise spawn `mebular runtime
//     supervise` once through the shared Runtime Supervisor. The plugin owns the
//     supervise process, not the daemon; dispose sends SIGTERM to supervise,
//     which stops only the child it started. Service installs are never done.
//   - `auto`: same as `managed` (explicit opt-in to starting a runtime).
//
// `runtime: external` forces attach-only; an explicit `daemonUrl` pins one URL
// and is also attach-only. Without a CLI/provider the legacy
// MEBULAR_HTTP_PORT / <home>/runtime.json attach fallback is kept; otherwise the
// panel reports `download_required` and nothing is spawned or downloaded.
//
// The MCP bridge mounts the official @deepseek-ai/dsh-mcp-client plugin on the
// same effective daemon URL the panel uses. That URL is refreshed from the
// shared supervisor's `runtime resolve --json`, so a non-default profile/port
// is followed by the status route, the bridge, and the panel.

import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';

export const name = '@mebular/dsh-plugin';

export const EMBED_INFO_PATH = '/mebular/embed-info';

/** Loopback-only explicit user action: install/start the shared runtime. */
export const RUNTIME_INSTALL_PATH = '/mebular/runtime/install';

/**
 * Pinned `@mebular/core` version for the plugin-only bootstrap. It must track
 * this package's version (enforced by scripts/verify-dsh-plugin.mjs); clients
 * can never supply a version, tag, URL or registry.
 */
export const RUNTIME_INSTALL_VERSION = '0.1.2';

export const RUNTIME_INSTALL_ACTIONS = Object.freeze(['install', 'retry', 'reinstall', 'redetect']);

/** Console discovery contract version, shared with packages/mcp. */
export const EMBED_PROTOCOL = 1;

/** Browser global injected by the host through DSH's webServer.tapIndex. */
export const PANEL_GLOBAL = '__MEBULAR_DSH__';

/** DSH system-prompt section name for Agent-visible Mebular availability. */
export const AGENT_STATUS_SECTION = 'mebular:status';

/**
 * Explicit section order. Sits after first-party MCP server guidance (3100)
 * and before the generated tools SDK (5000), without taking an existing named
 * first-party slot.
 */
export const AGENT_STATUS_ORDER = 3200;

const DEFAULT_PORT = 7331;
const DEFAULT_PROBE_TIMEOUT_MS = 1200;
const DEFAULT_CACHE_TTL_MS = 1000;
const DEFAULT_MANAGED_START_TIMEOUT_MS = 20000;
const DEFAULT_MANAGED_POLL_INTERVAL_MS = 500;
/**
 * Stop window for the plugin-owned `runtime supervise` process. It must cover
 * the supervisor's own child cleanup budget (SIGTERM → 2s → SIGKILL → 5s) plus
 * margin; killing supervise earlier would orphan the daemon child.
 */
export const DEFAULT_SUPERVISE_STOP_GRACE_MS = 10000;
export const DEFAULT_SUPERVISE_KILL_WAIT_MS = 5000;
const DEFAULT_BRIDGE_POLL_INTERVAL_MS = 2000;
const DEFAULT_RESOLVE_TIMEOUT_MS = 5000;
const DEFAULT_CLI_NAME = 'mebular';
const RUNTIME_FILE = 'runtime.json';
const RUNTIME_PROVIDERS_FILE = 'runtime-providers.json';
const MAX_JSON_BYTES = 512 * 1024;
const MAX_LOG_LINE = 500;
const RUNTIME_PROVIDER_KINDS = new Set(['app', 'cli', 'shared']);

const RUNTIME_DIR = 'runtime';
const RUNTIME_INSTALL_LOCK_FILE = 'install.lock';
const RUNTIME_PACKAGE_NAME = '@mebular/core';
const RUNTIME_CLI_RELATIVE = join('node_modules', '@mebular', 'core', 'packages', 'mcp', 'bin', 'mebular.mjs');
const RUNTIME_PACKAGE_RELATIVE = join('node_modules', '@mebular', 'core', 'package.json');
const RUNTIME_STAGING_PREFIX = '.tmp-install-';
const RUNTIME_BACKUP_PREFIX = '.backup-';
const DEFAULT_INSTALL_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_CLI_TIMEOUT_MS = 20_000;
const DEFAULT_INSTALL_KILL_GRACE_MS = 500;
const MAX_INSTALL_LOG_BYTES = 64 * 1024;
const MAX_INSTALL_BODY_BYTES = 8 * 1024;
const SEMVER_RE = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Stable install failure reasons surfaced by the panel and Agent logs. */
export const RUNTIME_INSTALL_REASONS = Object.freeze([
  'offline',
  'registry_unreachable',
  'http_error',
  'integrity_mismatch',
  'disk_full',
  'permission_denied',
  'npm_missing',
  'unsupported_version',
  'cancelled',
  'install_locked',
  'provider_registration_failed',
  'init_failed',
  'start_failed',
  'runtime_resolve_failed',
  'install_failed',
]);

const INSTALL_REASON_SET = new Set([
  ...RUNTIME_INSTALL_REASONS,
  'download_required',
]);


/** Standard App bundle runtime entry, mirroring the shared supervisor layout. */
const APP_PROVIDER_TAIL = ['node_modules', '@mebular', 'core', 'packages', 'mcp', 'bin', 'mebular.mjs'];

/** Official DSH MCP bridge. Supplied by the DSH host as a peer dependency. */
export const MCP_CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client';

/**
 * Parse an absolute HTTP(S) URL and return its normalized href.
 * @param {unknown} value
 * @returns {string | null}
 */
function httpUrl(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.href;
  } catch {
    return null;
  }
}

/** @param {unknown} value */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isLoopbackIpv4(host) {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  if (!parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return false;
  return parts[0] === '127';
}

function isLoopbackIpv6(host) {
  if (host === '::1') return true;
  if (!host.startsWith('::ffff:')) return false;
  const tail = host.slice('::ffff:'.length);
  if (isLoopbackIpv4(tail)) return true;
  const groups = tail.split(':');
  return groups.length === 2
    && groups.every((group) => /^[0-9a-f]{1,4}$/i.test(group))
    && (Number.parseInt(groups.map((group) => group.padStart(4, '0')).join(''), 16) >>> 24) === 127;
}

/**
 * Strict hostname check for a loopback URL: exact localhost (or .localhost),
 * 127.0.0.0/8, ::1, and IPv4-mapped loopback. No DNS resolution, no suffix
 * tricks such as `127.example.com`.
 * @param {string} hostname
 * @returns {boolean}
 */
function isLoopbackHostname(hostname) {
  if (typeof hostname !== 'string' || hostname.length === 0) return false;
  const host = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.includes(':')) return isLoopbackIpv6(host);
  return isLoopbackIpv4(host);
}

/**
 * Valid MEBULAR_HTTP_PORT, or null. Kept separate from daemonPort() so the
 * host can tell "port explicitly configured" from "use the default".
 * @param {Record<string, string | undefined>} [env]
 * @returns {number | null}
 */
function envPort(env = process.env) {
  const raw = env?.MEBULAR_HTTP_PORT;
  if (typeof raw !== 'string' || !/^\d{1,5}$/.test(raw)) return null;
  const port = Number(raw);
  return port > 0 && port <= 65535 ? port : null;
}

function defaultDaemonUrl(env = process.env) {
  return `http://127.0.0.1:${envPort(env) ?? DEFAULT_PORT}`;
}

/**
 * Mebular home for runtime.json discovery only. This mirrors the CLI's
 * MEBULAR_HOME default without reading config.json, identity, or secrets.
 * @param {Record<string, string | undefined>} [env]
 */
function mebularHome(env = process.env) {
  const raw = env?.MEBULAR_HOME;
  if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
  return join(homedir(), '.mebular');
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return error?.code !== 'ESRCH';
  }
}

function validRuntimeHost(host) {
  if (typeof host !== 'string') return false;
  const value = host.trim();
  if (value.length === 0 || value.length > 255) return false;
  if (/[\s/@?#]/.test(value)) return false;
  if (value.includes(':')) return /^[0-9a-f:.%]+$/i.test(value);
  return /^[A-Za-z0-9.-]+$/.test(value);
}

/**
 * Read <home>/runtime.json. `options.runtime` (including null) is an injection
 * seam for tests: null disables discovery, an object supplies the document.
 * @param {{
 *   runtime?: unknown,
 *   home?: string,
 *   env?: Record<string, string | undefined>,
 * }} [options]
 * @returns {Record<string, unknown> | null}
 */
function readRuntimeState(options = {}) {
  const opts = isObject(options) ? options : {};
  if (opts.runtime !== undefined) {
    return isObject(opts.runtime) ? opts.runtime : null;
  }
  const env = isObject(opts.env) ? opts.env : process.env;
  const home = typeof opts.home === 'string' && opts.home.length > 0 ? opts.home : mebularHome(env);
  try {
    const value = JSON.parse(readFileSync(join(home, RUNTIME_FILE), 'utf-8'));
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Build a daemon origin from a runtime.json document. A dead pid makes the file
 * stale (ignored); malformed fields never throw.
 * @param {unknown} record
 * @param {{ pidAlive?: (pid: number) => boolean }} [options]
 * @returns {string | null}
 */
export function runtimeDaemonUrl(record, options = {}) {
  if (!isObject(record) || !Number.isInteger(record.pid) || record.pid <= 0) return null;
  if (!isObject(record.http)) return null;
  const host = typeof record.http.host === 'string' ? record.http.host.trim() : '';
  const port = record.http.port;
  if (!validRuntimeHost(host) || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  const pidAlive = typeof options.pidAlive === 'function' ? options.pidAlive : isProcessAlive;
  try {
    if (!pidAlive(record.pid)) return null;
  } catch {
    return null;
  }
  const href = httpUrl(`http://${host.includes(':') ? `[${host}]` : host}:${port}`);
  if (href === null) return null;
  try {
    const url = new URL(href);
    if (url.username !== '' || url.password !== '') return null;
    return url.origin;
  } catch {
    return null;
  }
}

function normalizeDaemonUrl(value, fallback = defaultDaemonUrl()) {
  const href = httpUrl(value);
  if (href === null) return fallback;
  const url = new URL(href);
  if (url.username !== '' || url.password !== '') return fallback;
  const pathname = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${pathname}`;
}

/** @param {unknown} value */
function describeValue(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value);
  return typeof value;
}

/**
 * Resolve plugin config. Invalid integration values fall back to safe defaults
 * and are reported through the optional warning callback; they never fail DSH
 * activation.
 *
 * daemonUrl discovery order: explicit config > MEBULAR_HTTP_PORT > runtime.json
 * (Mebular home, pid must still be alive) > loopback:7331. Discovery never
 * touches config.json, identity, or secrets. The effective URL is later
 * refreshed from `mebular runtime resolve --json` unless it is pinned.
 *
 * @param {unknown} input
 * @param {{
 *   warn?: (message: string) => void,
 *   env?: Record<string, string | undefined>,
 *   home?: string,
 *   runtime?: unknown,
 *   pidAlive?: (pid: number) => boolean,
 * } | ((message: string) => void)} [options]
 * @returns {{
 *   daemonUrl: string,
 *   lifecycle: 'attach' | 'managed' | 'auto',
 *   panel: boolean,
 *   runtime: 'auto' | 'external',
 *   persistence: 'child' | 'service',
 *   bootstrap: 'prompt' | 'never',
 *   pinnedDaemonUrl: boolean,
 *   cliPath?: string,
 * }}
 */
export function resolveConfig(input = {}, options = {}) {
  const config = isObject(input) ? input : {};
  const opts = isObject(options) ? options : {};
  const env = isObject(opts.env) ? opts.env : process.env;
  const warn = typeof options === 'function'
    ? options
    : typeof opts.warn === 'function'
      ? opts.warn
      : null;
  const notify = (message) => {
    if (warn === null) return;
    try {
      warn(message);
    } catch {
      // Logging must never fail plugin activation.
    }
  };

  let lifecycle = 'attach';
  if (config.lifecycle !== undefined) {
    const value = typeof config.lifecycle === 'string'
      ? config.lifecycle.trim().toLowerCase()
      : config.lifecycle;
    if (value === 'attach' || value === 'managed' || value === 'auto') lifecycle = value;
    else notify(`invalid lifecycle ${describeValue(config.lifecycle)}; using "attach"`);
  }

  let panel = true;
  if (config.panel !== undefined) {
    if (typeof config.panel === 'boolean') panel = config.panel;
    else if (config.panel === 'on') panel = true;
    else if (config.panel === 'off') panel = false;
    else notify(`invalid panel ${describeValue(config.panel)}; using true`);
  }

  let runtime = 'auto';
  if (config.runtime !== undefined) {
    const value = typeof config.runtime === 'string' ? config.runtime.trim().toLowerCase() : config.runtime;
    if (value === 'auto' || value === 'external') runtime = value;
    else notify(`invalid runtime ${describeValue(config.runtime)}; using "auto"`);
  }

  let persistence = 'child';
  if (config.persistence !== undefined) {
    const value = typeof config.persistence === 'string'
      ? config.persistence.trim().toLowerCase()
      : config.persistence;
    if (value === 'child' || value === 'service') persistence = value;
    else notify(`invalid persistence ${describeValue(config.persistence)}; using "child"`);
  }

  let bootstrap = 'prompt';
  if (config.bootstrap !== undefined) {
    const value = typeof config.bootstrap === 'string'
      ? config.bootstrap.trim().toLowerCase()
      : config.bootstrap;
    if (value === 'prompt' || value === 'never') bootstrap = value;
    else notify(`invalid bootstrap ${describeValue(config.bootstrap)}; using "prompt"`);
  }

  let cliPath;
  if (config.cliPath !== undefined) {
    if (typeof config.cliPath === 'string' && config.cliPath.trim().length > 0) {
      cliPath = config.cliPath.trim();
    } else {
      notify('invalid cliPath; ignoring it');
    }
  }

  let explicitDaemonUrl = null;
  if (config.daemonUrl !== undefined) {
    const href = httpUrl(config.daemonUrl);
    if (href === null) {
      notify('invalid daemonUrl; using the loopback default');
    } else {
      const parsed = new URL(href);
      if (parsed.username !== '' || parsed.password !== '') {
        notify('credentials in daemonUrl are not allowed; using the loopback default');
      } else {
        explicitDaemonUrl = normalizeDaemonUrl(config.daemonUrl, `http://127.0.0.1:${DEFAULT_PORT}`);
      }
    }
  }

  let daemonUrl;
  if (explicitDaemonUrl !== null) {
    daemonUrl = explicitDaemonUrl;
  } else {
    const port = envPort(env);
    if (port !== null) {
      daemonUrl = `http://127.0.0.1:${port}`;
    } else {
      const runtimeOptions = { env };
      if (opts.home !== undefined) runtimeOptions.home = opts.home;
      // An explicit `runtime` (even null) is a test seam that disables or
      // supplies the document instead of reading <home>/runtime.json.
      if (opts.runtime !== undefined) runtimeOptions.runtime = opts.runtime;
      const runtimeState = readRuntimeState(runtimeOptions);
      daemonUrl = runtimeDaemonUrl(runtimeState, { pidAlive: opts.pidAlive })
        ?? `http://127.0.0.1:${DEFAULT_PORT}`;
    }
  }

  /** @type {ReturnType<typeof resolveConfig>} */
  const resolved = {
    daemonUrl,
    lifecycle,
    panel,
    runtime,
    persistence,
    bootstrap,
    // A pre-resolved config (from apply()) carries the marker; only a raw
    // explicit daemonUrl becomes a pin.
    pinnedDaemonUrl: config.pinnedDaemonUrl === true
      || (config.pinnedDaemonUrl === undefined && explicitDaemonUrl !== null),
  };
  if (cliPath !== undefined) resolved.cliPath = cliPath;
  return resolved;
}

/**
 * Join a base URL and a path without dropping a base path or duplicating slashes.
 * @param {string} base
 * @param {string} [path]
 * @returns {string}
 */
export function joinUrl(base, path = '') {
  const root = String(base ?? '').trim().replace(/\/+$/, '');
  const suffix = String(path ?? '').trim().replace(/^\/+/, '');
  if (suffix.length === 0) return root;
  return `${root}/${suffix}`;
}

/**
 * Whether a URL points at a loopback host (only http/https).
 * @param {unknown} value
 * @returns {boolean}
 */
export function isLoopbackUrl(value) {
  const href = httpUrl(value);
  if (href === null) return false;
  try {
    return isLoopbackHostname(new URL(href).hostname);
  } catch {
    return false;
  }
}

/**
 * Whether a socket peer address is loopback. This is the only gate for the
 * HTTP route: remote clients receive 404, never a status document. Hostnames
 * are not accepted here because `remoteAddress` is always an IP literal.
 * @param {unknown} address
 * @returns {boolean}
 */
export function isLoopbackAddress(address) {
  if (typeof address !== 'string' || address.length === 0) return false;
  const value = address.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (value.includes(':')) return isLoopbackIpv6(value);
  return isLoopbackIpv4(value);
}

/**
 * Port a managed daemon should listen on, derived from daemonUrl.
 * @param {unknown} daemonUrl
 * @returns {number}
 */
export function daemonPortFromUrl(daemonUrl) {
  const href = httpUrl(daemonUrl);
  if (href === null) return DEFAULT_PORT;
  const url = new URL(href);
  if (url.port === '') return url.protocol === 'https:' ? 443 : 80;
  const port = Number(url.port);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_PORT;
}

/**
 * Resolve the Mebular CLI without reading Mebular config or secrets.
 *
 * Order: explicit cliPath, MEBULAR_CLI, then `mebular` on PATH. Every
 * candidate is checked with `exists`; the first existing file wins.
 *
 * @param {{
 *   cliPath?: unknown,
 *   env?: Record<string, string | undefined>,
 *   platform?: string,
 *   exists?: (file: string) => boolean,
 * }} [options]
 * @returns {string | null}
 */
export function resolveCliPath(options = {}) {
  const opts = isObject(options) ? options : {};
  const env = isObject(opts.env) ? opts.env : process.env;
  const platform = typeof opts.platform === 'string' ? opts.platform : process.platform;
  const exists = typeof opts.exists === 'function' ? opts.exists : existsSync;
  const isWindows = platform === 'win32';
  const extList = isWindows
    ? (typeof env.PATHEXT === 'string' ? env.PATHEXT.split(';') : ['.EXE', '.CMD', '.BAT', '.COM']).filter(Boolean)
    : [''];
  const searchDirs = String(env.PATH ?? '')
    .split(isWindows ? ';' : ':')
    .filter((dir) => dir.length > 0);

  /** @type {Array<{ name: string, direct: boolean }>} */
  const candidates = [];
  const add = (value) => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    const direct = isAbsolute(trimmed)
      || trimmed.includes('/')
      || (isWindows && trimmed.includes('\\'));
    candidates.push({ name: trimmed, direct });
  };
  add(opts.cliPath);
  add(env.MEBULAR_CLI);

  for (const candidate of candidates) {
    if (candidate.direct) {
      if (exists(candidate.name)) return candidate.name;
      continue;
    }
    for (const dir of searchDirs) {
      for (const ext of extList) {
        const file = join(dir, `${candidate.name}${ext}`);
        if (exists(file)) return file;
      }
    }
  }

  for (const dir of searchDirs) {
    for (const ext of extList) {
      const file = join(dir, `${DEFAULT_CLI_NAME}${ext}`);
      if (exists(file)) return file;
    }
  }
  return null;
}

/* ------------------------------------------------------------------------- *
 * Shared runtime discovery (non-sensitive)
 * ------------------------------------------------------------------------- */

/**
 * Non-sensitive shared root: MEBULAR_CLOUD_ROOT, else ~/.mebular. Only provider
 * records, profiles/runtime discovery files and runtime.json are read here;
 * never config.json, identity, or secrets.
 * @param {{ env?: Record<string, string | undefined>, userHome?: string }} [options]
 * @returns {string}
 */
export function runtimeCloudRoot(options = {}) {
  const opts = isObject(options) ? options : {};
  const env = isObject(opts.env) ? opts.env : process.env;
  const userHome = typeof opts.userHome === 'string' && opts.userHome.length > 0 ? opts.userHome : homedir();
  const raw = env.MEBULAR_CLOUD_ROOT;
  if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
  return join(userHome, '.mebular');
}

/**
 * Standard App bundle runtime entry candidates, mirroring the shared Runtime
 * Supervisor. App providers are the bundler entry (`.../mebular.mjs`), which is
 * executed with the current Node runtime.
 * @param {{ platform?: string, env?: Record<string, string | undefined>, userHome?: string }} [options]
 * @returns {string[]}
 */
export function standardAppProviderPaths(options = {}) {
  const opts = isObject(options) ? options : {};
  const platform = typeof opts.platform === 'string' ? opts.platform : process.platform;
  const env = isObject(opts.env) ? opts.env : process.env;
  const userHome = typeof opts.userHome === 'string' && opts.userHome.length > 0 ? opts.userHome : homedir();
  if (platform === 'darwin') {
    return [
      join('/Applications', 'Mebular.app', 'Contents', 'Resources', ...APP_PROVIDER_TAIL),
      join(userHome, 'Applications', 'Mebular.app', 'Contents', 'Resources', ...APP_PROVIDER_TAIL),
    ];
  }
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA ?? join(userHome, 'AppData', 'Local');
    return [
      join(local, 'Programs', 'Mebular', 'resources', ...APP_PROVIDER_TAIL),
      join(local, 'Mebular', 'resources', ...APP_PROVIDER_TAIL),
    ];
  }
  return [
    join('/opt', 'Mebular', 'resources', ...APP_PROVIDER_TAIL),
    join(userHome, '.local', 'share', 'Mebular', 'resources', ...APP_PROVIDER_TAIL),
  ];
}

function findFileOnPath(name, { env, platform, exists }) {
  const isWindows = platform === 'win32';
  const exts = isWindows
    ? (typeof env.PATHEXT === 'string' ? env.PATHEXT.split(';') : ['.EXE', '.CMD', '.BAT', '.COM']).filter(Boolean)
    : [''];
  const dirs = String(env.PATH ?? '')
    .split(isWindows ? ';' : ':')
    .filter((dir) => dir.length > 0);
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = join(dir, `${name}${ext}`);
      if (exists(file)) return file;
    }
  }
  return null;
}

function resolveCommandCandidate(value, { env, platform, exists }) {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const trimmed = value.trim();
  const direct = isAbsolute(trimmed)
    || trimmed.includes('/')
    || (platform === 'win32' && trimmed.includes('\\'));
  if (direct) return exists(trimmed) ? trimmed : null;
  return findFileOnPath(trimmed, { env, platform, exists });
}

function providerKindOrder(kind) {
  return kind === 'app' ? 0 : kind === 'cli' ? 1 : kind === 'shared' ? 2 : 9;
}

function providerSourceOrder(source) {
  return source === 'config' ? -1
    : source === 'registry' ? 0
      : source === 'standard' ? 1
        : source === 'env' ? 2
          : source === 'path' ? 3
            : 9;
}

/**
 * Discover launchable runtime providers without reading Mebular config or
 * secrets. Order mirrors the shared supervisor: app > cli > shared, with the
 * registry ahead of standard App paths and PATH. An explicit config `cliPath`
 * is a user pin and wins.
 *
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   platform?: string,
 *   userHome?: string,
 *   cloudRoot?: string,
 *   cliPath?: string,
 *   exists?: (file: string) => boolean,
 *   registry?: unknown,
 *   includeStandardApp?: boolean,
 * }} [options]
 * @returns {Promise<{
 *   cloudRoot: string | null,
 *   providers: Array<{ kind: 'app' | 'cli' | 'shared', path: string, source: string, version: string | null }>,
 *   selected: { kind: 'app' | 'cli' | 'shared', path: string, source: string, version: string | null } | null,
 *   warnings: string[],
 * }>}
 */
export async function discoverRuntimeProviders(options = {}) {
  const opts = isObject(options) ? options : {};
  const env = isObject(opts.env) ? opts.env : process.env;
  const platform = typeof opts.platform === 'string' ? opts.platform : process.platform;
  const userHome = typeof opts.userHome === 'string' && opts.userHome.length > 0 ? opts.userHome : homedir();
  const exists = typeof opts.exists === 'function' ? opts.exists : existsSync;
  const cloudRoot = typeof opts.cloudRoot === 'string' && opts.cloudRoot.length > 0
    ? opts.cloudRoot
    : runtimeCloudRoot({ env, userHome });
  const warnings = [];
  /** @type {Array<{ kind: string, path: string, source: string, version: string | null }>} */
  const providers = [];

  const add = (kind, path, source, version = null) => {
    if (!RUNTIME_PROVIDER_KINDS.has(kind)) return;
    if (typeof path !== 'string' || path.trim().length === 0) return;
    const file = path.trim();
    if (!exists(file)) return;
    providers.push({ kind, path: file, source, version: typeof version === 'string' && version.length > 0 ? version : null });
  };

  const pin = resolveCommandCandidate(opts.cliPath, { env, platform, exists });
  if (pin !== null) add('cli', pin, 'config');

  let registry = opts.registry;
  if (registry === undefined) {
    try {
      registry = JSON.parse(readFileSync(join(cloudRoot, RUNTIME_PROVIDERS_FILE), 'utf-8'));
    } catch {
      registry = null;
    }
  }
  if (isObject(registry) && registry.v === 1 && Array.isArray(registry.providers)) {
    for (const entry of registry.providers) {
      if (!isObject(entry)) continue;
      // The supervisor writes absolute paths; never resolve a registry path
      // relative to the plugin's cwd.
      if (typeof entry.path !== 'string' || !isAbsolute(entry.path)) continue;
      add(entry.kind, entry.path, 'registry', entry.version);
    }
  } else if (registry !== null && registry !== undefined) {
    warnings.push('runtime-providers.json ignored (invalid shape or version)');
  }

  if (opts.includeStandardApp !== false) {
    for (const path of standardAppProviderPaths({ platform, env, userHome })) {
      add('app', path, 'standard');
    }
  }

  const envCli = resolveCommandCandidate(env.MEBULAR_CLI, { env, platform, exists });
  if (envCli !== null) add('cli', envCli, 'env');

  const pathCli = findFileOnPath(DEFAULT_CLI_NAME, { env, platform, exists });
  if (pathCli !== null) add('cli', pathCli, 'path');

  const deduped = new Map();
  for (const provider of providers) {
    const key = `${provider.kind}\n${provider.path}`;
    if (!deduped.has(key)) deduped.set(key, provider);
  }
  const sorted = [...deduped.values()].sort((left, right) => {
    // Explicit config cliPath is a user pin, then app > cli > shared, so a
    // registry CLI never outranks a standard App bundle.
    const leftPinned = left.source === 'config';
    const rightPinned = right.source === 'config';
    if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
    const kind = providerKindOrder(left.kind) - providerKindOrder(right.kind);
    if (kind !== 0) return kind;
    const source = providerSourceOrder(left.source) - providerSourceOrder(right.source);
    if (source !== 0) return source;
    return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
  });

  return {
    cloudRoot,
    providers: sorted,
    selected: sorted[0] ?? null,
    warnings,
  };
}

/* ------------------------------------------------------------------------- *
 * `mebular runtime resolve|supervise` subprocess bridge
 * ------------------------------------------------------------------------- */

function runtimeInvocation(cliPath, { execPath = process.execPath, platform = process.platform } = {}) {
  const path = String(cliPath ?? '');
  // A `.mjs/.cjs/.js` provider (including App bundles) runs on the current Node.
  if (/\.(?:mjs|cjs|js)$/i.test(path)) {
    return { command: execPath, prefix: [path], shell: false };
  }
  // Node cannot exec .cmd/.bat directly on Windows; args stay fixed.
  return {
    command: path,
    prefix: [],
    shell: platform === 'win32' && /\.(?:cmd|bat)$/i.test(path),
  };
}

function runtimeCliArgs(invocation, args) {
  return [...invocation.prefix, 'runtime', ...args];
}

function parseJsonDocument(text) {
  const trimmed = String(text ?? '').trim();
  if (trimmed.length === 0) return null;
  try {
    const value = JSON.parse(trimmed);
    return isObject(value) ? value : null;
  } catch {
    const start = trimmed.indexOf('{');
    if (start === -1) return null;
    try {
      const value = JSON.parse(trimmed.slice(start));
      return isObject(value) ? value : null;
    } catch {
      return null;
    }
  }
}

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    timer.unref?.();
  });
}

/**
 * Run one short `mebular runtime <command> --json` and parse its document.
 * Domain failures stay in `data` (exit code 2 still prints JSON); transport
 * failures return `{ ok: false, error }`. Never throws.
 */
function runRuntimeJson({
  cliPath,
  command,
  spawnFn,
  env,
  platform,
  execPath,
  timeoutMs = DEFAULT_RESOLVE_TIMEOUT_MS,
}) {
  const invocation = runtimeInvocation(cliPath, { execPath, platform });
  const argv = runtimeCliArgs(invocation, [...command, '--json']);
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let child = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child?.kill?.('SIGKILL');
      } catch {
        // Timeout cleanup is best-effort.
      }
      finish({ ok: false, error: 'timeout' });
    }, Math.max(250, timeoutMs));
    timer.unref?.();

    try {
      child = spawnFn(invocation.command, argv, {
        env: { ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        ...(invocation.shell ? { shell: true } : {}),
      });
    } catch {
      finish({ ok: false, error: 'spawn_failed' });
      return;
    }
    if (!child || typeof child !== 'object') {
      finish({ ok: false, error: 'spawn_failed' });
      return;
    }

    const collect = (stream, append) => {
      if (stream === null || typeof stream !== 'object' || typeof stream.on !== 'function') return;
      try {
        stream.on('data', (chunk) => {
          append(String(chunk ?? ''));
          if (stdout.length > MAX_JSON_BYTES) {
            try {
              child.kill?.('SIGKILL');
            } catch {
              // Cleanup is best-effort.
            }
            finish({ ok: false, error: 'output_too_large' });
          }
        });
      } catch {
        // A broken stream surfaces as an empty document below.
      }
    };
    collect(child.stdout, (text) => { stdout += text; });
    collect(child.stderr, () => {});

    const done = () => {
      const data = parseJsonDocument(stdout);
      finish(data === null ? { ok: false, error: 'invalid_json' } : { ok: true, data });
    };
    try {
      if (typeof child.once === 'function') {
        child.once('error', () => finish({ ok: false, error: 'spawn_failed' }));
        child.once('close', done);
        child.once('exit', () => {
          // `exit` can fire before the last stdout chunk; parse on the next
          // tick unless `close` already settled.
          const timer = setTimeout(done, 0);
          timer.unref?.();
        });
      } else if (typeof child.on === 'function') {
        child.on('error', () => finish({ ok: false, error: 'spawn_failed' }));
        child.on('close', done);
      }
    } catch {
      finish({ ok: false, error: 'spawn_failed' });
    }
  });
}

/**
 * Start `mebular runtime supervise --json` and expose its lifecycle:
 *   - `ready` resolves on the authoritative ready JSON (or process exit);
 *   - `exited` resolves with the exit code/signal;
 *   - `stop()` sends SIGTERM, escalating to SIGKILL after the grace period.
 * A service/reused supervise exits normally after ready JSON; a child-mode one
 * stays alive and is the only process this plugin owns.
 */
function startSuperviseProcess({
  cliPath,
  scriptArgs = [],
  spawnFn,
  env,
  platform,
  execPath,
  stopGraceMs = DEFAULT_SUPERVISE_STOP_GRACE_MS,
  killWaitMs = DEFAULT_SUPERVISE_KILL_WAIT_MS,
  wait = delay,
  logLine = null,
}) {
  const invocation = runtimeInvocation(cliPath, { execPath, platform });
  const argv = runtimeCliArgs(invocation, ['supervise', '--json', ...scriptArgs]);
  let child = null;
  let settledReady = false;
  let exited = false;
  let exitCode = null;
  let exitSignal = null;
  let stdoutBuffer = '';
  let stderrTail = '';
  /** @type {Promise<unknown> | null} */
  let stopping = null;
  let resolveReady;
  let resolveExit;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  const exit = new Promise((resolve) => { resolveExit = resolve; });

  const log = (level, line) => {
    if (typeof logLine !== 'function' || typeof line !== 'string' || line.length === 0) return;
    try {
      logLine(level, line);
    } catch {
      // Logging must never break supervision.
    }
  };

  const settleReady = (value) => {
    if (settledReady) return;
    settledReady = true;
    resolveReady(value);
  };

  const finishExit = (code, signal) => {
    if (exited) return;
    exited = true;
    exitCode = Number.isInteger(code) ? code : null;
    exitSignal = typeof signal === 'string' ? signal : null;
    if (!settledReady) settleReady({ ok: false, exited: true, code: exitCode, signal: exitSignal });
    resolveExit({ code: exitCode, signal: exitSignal, stderr: stderrTail });
  };

  try {
    child = spawnFn(invocation.command, argv, {
      env: { ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...(invocation.shell ? { shell: true } : {}),
    });
  } catch {
    child = null;
  }

  const failedHandle = (error) => ({
    command: invocation.command,
    args: argv,
    error,
    ready: Promise.resolve({ ok: false, error }),
    exited: Promise.resolve({ code: null, signal: null, stderr: '' }),
    stop: async () => ({ stopped: false, reason: 'not_running' }),
    getState: () => ({ exited: true, code: null, signal: null }),
  });

  if (!isObject(child)) return failedHandle('spawn_failed');

  const wire = (stream, level, onChunk) => {
    if (stream === null || typeof stream !== 'object' || typeof stream.on !== 'function') return;
    try {
      stream.on('data', (chunk) => {
        const text = String(chunk ?? '');
        for (const line of text.split(/\r?\n/)) {
          if (line.trim().length > 0) log(level, line.trim());
        }
        onChunk(text);
      });
    } catch {
      // A broken stream is covered by the readiness timeout/exit event.
    }
  };

  wire(child.stdout, 'info', (text) => {
    if (settledReady) return;
    stdoutBuffer += text;
    if (stdoutBuffer.length > MAX_JSON_BYTES) stdoutBuffer = stdoutBuffer.slice(-MAX_JSON_BYTES);
    const trimmed = stdoutBuffer.trim();
    if (!trimmed.endsWith('}')) return;
    const data = parseJsonDocument(trimmed);
    if (data !== null) settleReady({ ok: data.ok === true, data });
  });
  wire(child.stderr, 'warn', (text) => {
    stderrTail = `${stderrTail}${text}`.slice(-4096);
  });

  try {
    if (typeof child.once === 'function') {
      child.once('error', () => finishExit(null, null));
      child.once('exit', (code, signal) => finishExit(code, signal));
    } else if (typeof child.on === 'function') {
      child.on('error', () => finishExit(null, null));
      child.on('exit', (code, signal) => finishExit(code, signal));
    }
  } catch {
    finishExit(null, null);
  }

  const signalChild = (signal) => {
    try {
      return child.kill?.(signal) !== false;
    } catch {
      return false;
    }
  };

  const stop = (options = {}) => {
    if (stopping !== null) return stopping;
    const graceMs = Number.isFinite(options.graceMs)
      ? Math.max(0, options.graceMs)
      : stopGraceMs;
    stopping = (async () => {
      if (exited) return { stopped: false, reason: 'already_exited' };
      const termSent = signalChild('SIGTERM');
      const exitedAfterTerm = await Promise.race([
        exit.then(() => true),
        Promise.resolve(wait(graceMs)).then(() => false),
      ]);
      if (exitedAfterTerm) {
        return { stopped: true, escalated: false, termSent, killSent: false, graceMs };
      }
      const killSent = signalChild('SIGKILL');
      const exitedAfterKill = await Promise.race([
        exit.then(() => true),
        Promise.resolve(wait(killWaitMs)).then(() => false),
      ]);
      return {
        stopped: exitedAfterKill,
        escalated: true,
        termSent,
        killSent,
        graceMs,
        reason: exitedAfterKill ? null : 'still_running',
      };
    })();
    return stopping;
  };

  return {
    command: invocation.command,
    args: argv,
    ready,
    exited: exit,
    stop,
    getState: () => ({ exited, code: exitCode, signal: exitSignal }),
  };
}

function daemonUrlFromHttp(http) {
  if (!isObject(http)) return null;
  const scheme = http.scheme === 'https' ? 'https' : 'http';
  const host = typeof http.host === 'string' && http.host.trim().length > 0 ? http.host.trim() : null;
  const port = Number.isInteger(http.port) ? http.port : null;
  if (host === null || port === null) return null;
  const bracketed = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  const href = httpUrl(`${scheme}://${bracketed}:${port}`);
  return href === null ? null : normalizeDaemonUrl(href, href);
}

function sanitizeProfile(value) {
  if (!isObject(value)) return null;
  const id = typeof value.id === 'string' && value.id.length > 0 ? value.id : null;
  const name = typeof value.name === 'string' && value.name.length > 0 ? value.name : null;
  if (id === null && name === null) return null;
  return { id, name };
}

function sanitizeProvider(value) {
  if (!isObject(value)) return null;
  if (!RUNTIME_PROVIDER_KINDS.has(value.kind)) return null;
  return {
    kind: value.kind,
    source: typeof value.source === 'string' ? value.source : null,
    version: typeof value.version === 'string' && value.version.length > 0 ? value.version : null,
  };
}

function sanitizeService(value) {
  if (!isObject(value)) return null;
  return {
    registered: value.registered === true,
    running: value.running === true,
    foreign: value.foreign === true,
  };
}


/**
 * Build the non-sensitive status document returned to the DSH panel.
 *
 * - `status` is `up`, `down`, or `starting` (legacy, stable fields).
 * - `state` adds the shared-runtime detail: `up`, `down`, `starting`,
 *   `download_required`, `profile_mismatch`, `service_conflict`, or
 *   `version_mismatch`.
 * - `mode` is the effective lifecycle; it degrades to `attach` when starting is
 *   not allowed (`lifecycle: attach`, `runtime: external`, or a pinned URL).
 * - `runtimeMode` is how the running daemon was reached: `reused`, `service`,
 *   `child`, or `attach` while nothing is up yet.
 * - `managed` is true only while this plugin owns the running supervise child.
 * - `ok` means "ready to embed": status up, protocol 1, embedConsole, both
 *   sides loopback, and a valid loopback embed URL.
 * - `embedUrl` is null unless `ok`; the panel must never frame a fallback URL.
 * - `reason` is null when `ok`, otherwise a stable diagnostic code.
 *
 * @param {{
 *   daemonUrl?: string,
 *   reachable?: boolean,
 *   health?: Record<string, unknown> | null,
 *   embed?: Record<string, unknown> | null,
 *   status?: 'up' | 'down' | 'starting',
 *   state?: string,
 *   mode?: 'attach' | 'managed',
 *   runtimeMode?: string | null,
 *   managed?: boolean,
 *   panel?: boolean,
 *   reason?: string | null,
 *   version?: string | null,
 *   profile?: unknown,
 *   provider?: unknown,
 *   service?: unknown,
 *   downloadRequired?: boolean,
 *   install?: unknown,
 * }} [input]
 * @returns {{
 *   ok: boolean,
 *   status: 'up' | 'down' | 'starting',
 *   state: string,
 *   mode: 'attach' | 'managed',
 *   runtimeMode: string | null,
 *   managed: boolean,
 *   panel: boolean,
 *   daemonUrl: string,
 *   version: string | null,
 *   profile: { id: string | null, name: string | null } | null,
 *   provider: { kind: string, source: string | null, version: string | null } | null,
 *   service: { registered: boolean, running: boolean, foreign: boolean } | null,
 *   downloadRequired: boolean,
 *   install: ReturnType<typeof sanitizeRuntimeInstallState> | null,
 *   embedProtocol: number | null,
 *   consoleUrl: string,
 *   embedUrl: string | null,
 *   mcpUrl: string,
 *   loopback: boolean,
 *   reason: string | null,
 * }}
 */
export function buildEmbedInfo(input = {}) {
  const config = isObject(input) ? input : {};
  const daemonUrl = resolveConfig({ daemonUrl: config.daemonUrl }).daemonUrl;
  const reachable = config.reachable === true;
  const health = isObject(config.health) ? config.health : null;
  const embed = isObject(config.embed) ? config.embed : null;
  const status = config.status === 'starting' || config.status === 'up' || config.status === 'down'
    ? config.status
    : reachable ? 'up' : 'down';
  const mode = config.mode === 'managed' ? 'managed' : 'attach';
  const managed = config.managed === true;
  const panel = config.panel !== false;
  const reasonOverride = typeof config.reason === 'string' && config.reason.length > 0
    ? config.reason
    : null;
  const runtimeMode = typeof config.runtimeMode === 'string' && config.runtimeMode.length > 0
    ? config.runtimeMode
    : null;

  const daemonLoopback = isLoopbackUrl(daemonUrl);
  const remoteLoopback = embed?.loopback === true;
  const loopback = daemonLoopback && remoteLoopback;
  const embedProtocol = Number.isInteger(embed?.embedProtocol) ? embed.embedProtocol : null;

  const remoteConsoleUrl = httpUrl(embed?.consoleUrl);
  const remoteEmbedUrl = httpUrl(embed?.embedUrl);
  const remoteMcpUrl = httpUrl(embed?.mcpUrl);
  const remoteInvalid = (typeof embed?.consoleUrl === 'string' && !isLoopbackUrl(embed.consoleUrl))
    || (typeof embed?.embedUrl === 'string' && !isLoopbackUrl(embed.embedUrl));

  const consoleUrl = isLoopbackUrl(remoteConsoleUrl) ? remoteConsoleUrl : joinUrl(daemonUrl, '/console');
  const mcpUrl = remoteMcpUrl ?? joinUrl(daemonUrl, '/mcp');
  const resolvedVersion = typeof config.version === 'string' && config.version.length > 0
    ? config.version
    : null;
  const version = typeof health?.version === 'string' && health.version.length > 0
    ? health.version
    : typeof embed?.version === 'string' && embed.version.length > 0
      ? embed.version
      : resolvedVersion;

  /** @type {string | null} */
  let reason = null;
  if (status === 'starting') {
    reason = reasonOverride;
  } else if (!reachable) {
    reason = reasonOverride ?? (health === null ? 'daemon_unreachable' : 'daemon_unhealthy');
  } else if (embed === null) {
    reason = reasonOverride ?? 'embed_info_unavailable';
  } else if (embed.ok !== true) {
    reason = reasonOverride ?? 'embed_not_ok';
  } else if (!daemonLoopback || !remoteLoopback) {
    reason = reasonOverride ?? 'not_loopback';
  } else if (embedProtocol !== EMBED_PROTOCOL) {
    reason = reasonOverride ?? 'embed_protocol_unsupported';
  } else if (embed.capabilities?.embedConsole !== true) {
    reason = reasonOverride ?? 'embed_unsupported';
  } else if (remoteInvalid) {
    reason = reasonOverride ?? 'embed_url_invalid';
  } else if (!isLoopbackUrl(remoteEmbedUrl)) {
    reason = reasonOverride ?? 'embed_url_invalid';
  }

  const knownStates = new Set([
    'up', 'down', 'starting', 'download_required',
    'profile_mismatch', 'service_conflict', 'version_mismatch',
  ]);
  const state = typeof config.state === 'string' && knownStates.has(config.state)
    ? config.state
    : status === 'up' ? 'up' : status === 'starting' ? 'starting' : 'down';
  const downloadRequired = config.downloadRequired === true || reason === 'download_required';

  return {
    ok: status === 'up' && reason === null,
    status,
    state,
    mode,
    runtimeMode,
    managed,
    panel,
    daemonUrl,
    version,
    profile: sanitizeProfile(config.profile),
    provider: sanitizeProvider(config.provider),
    service: sanitizeService(config.service),
    downloadRequired,
    install: isObject(config.install) ? sanitizeRuntimeInstallState(config.install) : null,
    embedProtocol,
    consoleUrl,
    embedUrl: status === 'up' && reason === null ? remoteEmbedUrl : null,
    mcpUrl,
    loopback,
    reason,
  };
}

/**
 * Fetch a JSON document with a short timeout. Never throws.
 * @param {string} url
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} options
 * @returns {Promise<{ ok: boolean, data?: unknown, status?: number, error?: string }>}
 */
async function readJson(url, { fetchImpl, timeoutMs }) {
  if (typeof fetchImpl !== 'function') return { ok: false, error: 'fetch_unavailable' };
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => controller?.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      cache: 'no-store',
      headers: { accept: 'application/json' },
      ...(controller === null ? {} : { signal: controller.signal }),
    });
    if (response?.ok === false) return { ok: false, status: response.status, error: 'http_error' };
    return { ok: true, data: await response.json() };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'network_error',
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe a Mebular daemon: /healthz decides reachability, /app/embed/info
 * supplies the embed contract. Both run in parallel under the same timeout.
 * @param {{
 *   daemonUrl?: string,
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 * }} [options]
 * @returns {Promise<{
 *   reachable: boolean,
 *   health: Record<string, unknown> | null,
 *   embed: Record<string, unknown> | null,
 * }>}
 */
export async function probeDaemon(options = {}) {
  const daemonUrl = resolveConfig({ daemonUrl: options.daemonUrl }).daemonUrl;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_PROBE_TIMEOUT_MS;
  const [healthResult, embedResult] = await Promise.all([
    readJson(joinUrl(daemonUrl, '/healthz'), { fetchImpl, timeoutMs }),
    readJson(joinUrl(daemonUrl, '/app/embed/info'), { fetchImpl, timeoutMs }),
  ]);
  const health = healthResult.ok && isObject(healthResult.data) ? healthResult.data : null;
  const embed = embedResult.ok && isObject(embedResult.data) ? embedResult.data : null;
  const healthy = health !== null && (health.status === 'ok' || health.ok === true);
  return { reachable: healthy, health, embed };
}

const LOG_SECRET_KEY = '[A-Za-z0-9_.-]*(?:token|secret|password|passwd|api[_-]?key|apikey)[A-Za-z0-9_.-]*';
const LOG_SECRET_KV = new RegExp(
  `(["']?)(${LOG_SECRET_KEY})\\1(\\s*[:=]\\s*)("[^"]*"|'[^']*'|[^\\s,;&]+)`,
  'gi',
);

/**
 * Redact secrets before a managed-child log line reaches the DSH logger.
 * Values of token/secret/password/api_key and Authorization headers are
 * replaced with <redacted>; the key name and any Bearer/Basic scheme remain.
 * The caller may supply the CLI path and Mebular home to strip those too.
 *
 * @param {unknown} line
 * @param {{ home?: string, cliPath?: string }} [options]
 * @returns {string}
 */
export function redactLogLine(line, options = {}) {
  const opts = isObject(options) ? options : {};
  let text = typeof line === 'string' ? line : String(line ?? '');
  if (typeof opts.home === 'string' && opts.home.length > 1) {
    text = text.split(opts.home).join('<home>');
  }
  if (typeof opts.cliPath === 'string' && opts.cliPath.length > 0) {
    text = text.split(opts.cliPath).join('<cli>');
  }
  text = text.replace(
    /(\bAuthorization["']?\s*[:=]\s*)(Bearer|Basic)\s+[^\s,;"']+/gi,
    (_match, prefix, scheme) => `${prefix}${scheme} <redacted>`,
  );
  text = text.replace(
    /(\bAuthorization["']?\s*[:=]\s*)(?!(?:Bearer|Basic)\b)[^\s,;"']+/gi,
    '$1<redacted>',
  );
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>');
  text = text.replace(LOG_SECRET_KV, (_match, quote, key, separator, value) => {
    const prefix = `${quote}${key}${quote}${separator}`;
    if (value.startsWith('"')) return `${prefix}"<redacted>"`;
    if (value.startsWith("'")) return `${prefix}'<redacted>'`;
    return `${prefix}<redacted>`;
  });
  if (text.length > MAX_LOG_LINE) text = `${text.slice(0, MAX_LOG_LINE)}…`;
  return text;
}

function safeErrorCode(error) {
  const code = error?.code;
  return typeof code === 'string' && /^[A-Za-z0-9_.-]+$/.test(code) ? code : 'error';
}

function safeLog(logger, level, message) {
  try {
    const fn = logger?.[level];
    if (typeof fn === 'function') fn.call(logger, message);
  } catch {
    // Logging must never fail plugin activation or disposal.
  }
}

function providerFromCliPath(path) {
  if (typeof path !== 'string' || path.trim().length === 0) return null;
  return { kind: 'cli', path: path.trim(), source: 'config', version: null };
}

function failureState(data) {
  const raw = typeof data?.reason === 'string' ? data.reason : '';
  if (data?.mode === 'download_required' || raw === 'download_required') {
    return { state: 'download_required', reason: 'download_required', download: true };
  }
  if (raw === 'instance_mismatch'
    || raw === 'instance_missing'
    || raw === 'cloud_mismatch'
    || raw === 'CLOUD_ALREADY_ACTIVE') {
    return { state: 'profile_mismatch', reason: raw };
  }
  if (raw === 'service_unknown' || raw === 'service_foreign' || raw === 'service_not_registered') {
    return { state: 'service_conflict', reason: raw };
  }
  if (raw === 'version_mismatch') return { state: 'version_mismatch', reason: raw };
  return {
    state: 'down',
    reason: raw.length > 0 ? raw : (data?.mode === 'error' ? 'runtime_error' : null),
  };
}

/* ------------------------------------------------------------------------- *
 * Plugin-only shared runtime install (explicit user action)
 * ------------------------------------------------------------------------- */

function installError(reason, message, extra = {}) {
  const code = INSTALL_REASON_SET.has(reason) ? reason : 'install_failed';
  const error = new Error(message);
  error.code = code;
  for (const [key, value] of Object.entries(extra)) error[key] = value;
  return error;
}

/** Strict semver + path safety; the version is always the plugin's constant. */
export function assertRuntimeInstallVersion(value) {
  if (typeof value !== 'string') {
    throw installError('unsupported_version', 'runtime version must be a string');
  }
  const version = value.trim();
  if (version.length === 0 || version.length > 128 || !SEMVER_RE.test(version)) {
    throw installError('unsupported_version', `unsupported runtime version: ${version.slice(0, 128) || '(empty)'}`);
  }
  return version;
}

export function runtimeInstallDir(cloudRoot) {
  return join(cloudRoot, RUNTIME_DIR);
}

export function runtimeInstallTarget(cloudRoot, version) {
  return join(runtimeInstallDir(cloudRoot), assertRuntimeInstallVersion(version));
}

export function runtimeInstallCliPath(cloudRoot, version) {
  return join(runtimeInstallTarget(cloudRoot, version), RUNTIME_CLI_RELATIVE);
}

export function runtimeManualInstallCommand(version = RUNTIME_INSTALL_VERSION) {
  return `npm install -g ${RUNTIME_PACKAGE_NAME}@${assertRuntimeInstallVersion(version)}`;
}

/**
 * Fixed npm command: `npm install --prefix <tmp> --ignore-scripts --no-audit
 * --no-fund @mebular/core@<version>`. Only Windows `npm.cmd` uses a shell, and
 * every argument is constructed here (never from the client).
 */
export function buildRuntimeInstallCommand({
  version = RUNTIME_INSTALL_VERSION,
  prefix,
  platform = process.platform,
  npmPath = null,
  execPath = process.execPath,
} = {}) {
  const safeVersion = assertRuntimeInstallVersion(version);
  if (typeof prefix !== 'string' || prefix.length === 0) {
    throw installError('install_failed', 'missing npm --prefix');
  }
  let command;
  let leading = [];
  let shell = false;
  const rawPath = typeof npmPath === 'string' && npmPath.trim().length > 0 ? npmPath.trim() : null;
  if (rawPath !== null) {
    const name = platform === 'win32' ? (rawPath.split(/[\\/]/).pop() ?? rawPath) : basename(rawPath);
    if (/\.(mjs|cjs|js)$/i.test(name)) {
      command = execPath;
      leading = [rawPath];
    } else if (platform === 'win32' && (/\.(cmd|bat)$/i.test(name) || name === 'npm')) {
      command = /\.(cmd|bat)$/i.test(name) ? rawPath : `${rawPath}.cmd`;
      shell = true;
    } else {
      command = rawPath;
    }
  } else if (platform === 'win32') {
    command = 'npm.cmd';
    shell = true;
  } else {
    command = 'npm';
  }
  const args = [
    ...leading,
    'install',
    '--prefix',
    prefix,
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    `${RUNTIME_PACKAGE_NAME}@${safeVersion}`,
  ];
  const quote = (value) => (/[\s&|<>^]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  return {
    command: shell && /\s/.test(command) ? `"${command}"` : command,
    args: shell ? args.map((entry) => quote(String(entry))) : args,
    shell,
    version: safeVersion,
  };
}

function sanitizeDetail(value, { home = null, cliPath = null } = {}) {
  const text = redactLogLine(String(value ?? ''), {
    ...(typeof home === 'string' ? { home } : {}),
    ...(typeof cliPath === 'string' ? { cliPath } : {}),
  });
  return text.slice(0, 300);
}

function firstUsefulLine(text, options = {}) {
  const line = String(text ?? '')
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  return line === undefined ? null : sanitizeDetail(line, options);
}

function statusFromInstallText(text) {
  const explicit = /\b(?:E|HTTP\s*)([45]\d{2})\b/i.exec(text);
  if (explicit) return Number(explicit[1]);
  const plain = /(?:^|\s)([45]\d{2})(?:\s|$)/m.exec(text);
  return plain ? Number(plain[1]) : null;
}

/** Map npm spawn/exit/stderr to the stable install reasons. */
export function classifyRuntimeInstallFailure({
  spawnError = null,
  exitCode = null,
  stdout = '',
  stderr = '',
  options = {},
} = {}) {
  const text = `${stderr}\n${stdout}`;
  const lower = text.toLowerCase();
  const spawnCode = typeof spawnError?.code === 'string' ? spawnError.code.toUpperCase() : '';
  const result = (reason, extra = {}) => ({
    reason,
    detail: firstUsefulLine(text, options)
      ?? (spawnError?.message ? sanitizeDetail(spawnError.message, options) : null),
    ...extra,
  });

  if (spawnError) {
    if (spawnCode === 'ENOENT') return result('npm_missing');
    if (spawnCode === 'EACCES' || spawnCode === 'EPERM') return result('permission_denied');
    if (spawnCode === 'ENOSPC') return result('disk_full');
    if (spawnCode === 'ETIMEDOUT' || spawnCode === 'ECONNREFUSED' || spawnCode === 'ECONNRESET') {
      return result('registry_unreachable');
    }
    if (spawnCode === 'ENOTFOUND' || spawnCode === 'EAI_AGAIN'
      || spawnCode === 'ENETUNREACH' || spawnCode === 'EHOSTUNREACH') {
      return result('offline');
    }
  }
  if (/eintegrity|integrity checksum|integrity.*(?:fail|mismatch)|shasum|checksum.*(?:fail|mismatch)/i.test(text)) {
    return result('integrity_mismatch');
  }
  if (/enospc|no space left on device|disk (?:is )?full|not enough space/i.test(text)) {
    return result('disk_full');
  }
  if (/eacces|eperm|permission denied|operation not permitted|access is denied/i.test(text)) {
    return result('permission_denied');
  }
  if (exitCode === 127 || /npm: command not found|npm: not found|'npm' is not recognized|not recognized as an internal/i.test(text)) {
    return result('npm_missing');
  }
  const status = statusFromInstallText(text);
  if (/etarget|no matching version|version not found/i.test(text)) {
    return result('unsupported_version', { status: 404 });
  }
  if (/e404|404 not found|not in this registry/i.test(text)) {
    return result('http_error', { status: 404 });
  }
  if (/e401|401 unauthorized|e403|403 forbidden|unauthorized|forbidden/i.test(text)) {
    return result('http_error', { status: status ?? (/401/.test(text) ? 401 : 403) });
  }
  if (status !== null || /http error|response code|bad gateway|service unavailable|internal server error/i.test(text)) {
    return result('http_error', { status });
  }
  if (/enotfound|eai_again|eai_fail|getaddrinfo|enotreach|network is unreachable|offline|dns lookup/i.test(lower)) {
    return result('offline');
  }
  if (/econnrefused|econnreset|etimedout|esockettimedout|socket hang up|network request.*failed|request to .* failed|registry.*unreachable/i.test(lower)) {
    return result('registry_unreachable');
  }
  return result(exitCode === 0 ? 'install_failed' : 'http_error', { status });
}

function classifyInstallFsError(error) {
  const code = typeof error?.code === 'string' ? error.code.toUpperCase() : '';
  if (code === 'ENOSPC') return 'disk_full';
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return 'permission_denied';
  return 'install_failed';
}

/** Verify a prefix is exactly the pinned shared runtime (manifest + CLI). */
export async function inspectInstalledRuntimePrefix(directory, version) {
  const packagePath = join(directory, RUNTIME_PACKAGE_RELATIVE);
  const cliPath = join(directory, RUNTIME_CLI_RELATIVE);
  let raw;
  try {
    raw = await readFile(packagePath, 'utf-8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: false, reason: 'integrity_mismatch', detail: 'package_json_missing', cliPath };
    return { ok: false, reason: classifyInstallFsError(error), detail: `package_json_unreadable:${error?.code ?? 'error'}`, cliPath };
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'integrity_mismatch', detail: 'package_json_invalid', cliPath };
  }
  if (manifest?.name !== undefined && manifest.name !== RUNTIME_PACKAGE_NAME) {
    return { ok: false, reason: 'integrity_mismatch', detail: 'package_name_mismatch', cliPath };
  }
  if (manifest?.version !== version) {
    return { ok: false, reason: 'integrity_mismatch', detail: 'version_mismatch', cliPath };
  }
  try {
    const info = await stat(cliPath);
    if (!info.isFile()) return { ok: false, reason: 'integrity_mismatch', detail: 'cli_not_file', cliPath };
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: false, reason: 'integrity_mismatch', detail: 'cli_missing', cliPath };
    return { ok: false, reason: classifyInstallFsError(error), detail: `cli_unreadable:${error?.code ?? 'error'}`, cliPath };
  }
  return { ok: true, packageVersion: manifest.version, cliPath };
}

function installTimestamp(now) {
  const raw = typeof now === 'string' ? now : new Date().toISOString();
  return raw.replace(/[^0-9A-Za-z_-]/g, '-');
}

function installRandomSuffix() {
  return randomBytes(6).toString('hex');
}

async function acquireInstallLock({ runtimeDir, version, reinstall, pidAliveFn, now }) {
  await mkdir(runtimeDir, { recursive: true });
  const path = join(runtimeDir, RUNTIME_INSTALL_LOCK_FILE);
  const startedAt = now();
  const payload = JSON.stringify({ pid: process.pid, startedAt, version, mode: reinstall ? 'reinstall' : 'install' });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(path, payload, { mode: 0o600, flag: 'wx' });
      return {
        path,
        async release() {
          try {
            const held = JSON.parse(await readFile(path, 'utf-8'));
            if (held?.pid === process.pid && held?.startedAt === startedAt) await rm(path, { force: true });
          } catch {
            // Already released/reclaimed.
          }
        },
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let held = null;
      try {
        held = JSON.parse(await readFile(path, 'utf-8'));
      } catch {
        held = null;
      }
      const holderPid = Number(held?.pid);
      if (Number.isInteger(holderPid) && holderPid > 0 && pidAliveFn(holderPid)) {
        throw installError('install_locked', `another process is installing the runtime (pid ${holderPid})`, {
          holderPid,
        });
      }
      await rm(path, { force: true }).catch(() => undefined);
    }
  }
  throw installError('install_locked', 'runtime install lock is held');
}

async function removeStaleInstallStaging(runtimeDir) {
  let entries;
  try {
    entries = await readdir(runtimeDir, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(entries
    .filter((entry) => entry.name.startsWith(RUNTIME_STAGING_PREFIX))
    .map((entry) => rm(join(runtimeDir, entry.name), { recursive: true, force: true }).catch(() => undefined)));
}

/**
 * Run one short child (npm/CLI) with a hard timeout and abort support. Never
 * throws; stdout/stderr are bounded and the child is terminated on timeout.
 */
function runInstallProcess({
  command,
  args,
  shell = false,
  cwd,
  env,
  timeoutMs,
  signal,
  spawnFn,
  killGraceMs,
}) {
  return new Promise((resolvePromise) => {
    let child = null;
    let settled = false;
    let stdout = '';
    let stderr = '';
    let timer = null;
    let killTimer = null;
    let forceTimer = null;
    let exitTimer = null;
    let aborted = false;
    let timedOut = false;
    const append = (current, chunk) => `${current}${String(chunk)}`.slice(-MAX_INSTALL_LOG_BYTES);
    const cleanup = () => {
      if (timer !== null) clearTimeout(timer);
      if (killTimer !== null) clearTimeout(killTimer);
      if (forceTimer !== null) clearTimeout(forceTimer);
      if (exitTimer !== null) clearTimeout(exitTimer);
      signal?.removeEventListener?.('abort', onAbort);
    };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise({ stdout, stderr, aborted, timedOut, ...value });
    };
    const kill = (name) => {
      try {
        child?.kill?.(name);
      } catch {
        // Already exited.
      }
    };
    const terminate = () => {
      kill('SIGTERM');
      if (killTimer === null) killTimer = setTimeout(() => kill('SIGKILL'), Math.max(0, killGraceMs));
      if (forceTimer === null) {
        forceTimer = setTimeout(() => finish({ code: null, signal: null, forced: true }), Math.max(0, killGraceMs) + 500);
      }
    };
    const onAbort = () => {
      if (settled) return;
      aborted = true;
      terminate();
    };

    if (signal?.aborted) {
      aborted = true;
      finish({ code: null, signal: null });
      return;
    }
    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      child = spawnFn(command, args, {
        ...(cwd === undefined ? {} : { cwd }),
        env: { ...env },
        shell: shell === true,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      finish({ spawnError: error, code: null, signal: null });
      return;
    }
    child?.stdout?.on?.('data', (chunk) => { stdout = append(stdout, chunk); });
    child?.stderr?.on?.('data', (chunk) => { stderr = append(stderr, chunk); });
    const listen = (event, handler) => {
      if (typeof child?.once === 'function') child.once(event, handler);
      else if (typeof child?.on === 'function') child.on(event, handler);
    };
    listen('error', (error) => finish({ spawnError: error, code: null, signal: null }));
    listen('close', (code, signalName) => finish({ code, signal: signalName }));
    listen('exit', (code, signalName) => {
      if (!child?.stdout && !child?.stderr) {
        finish({ code, signal: signalName });
        return;
      }
      if (exitTimer === null) exitTimer = setTimeout(() => finish({ code, signal: signalName }), 100);
    });
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, timeoutMs);
    }
  });
}

function runInstalledCli({
  cliPath,
  args,
  env,
  platform,
  execPath,
  timeoutMs = DEFAULT_CLI_TIMEOUT_MS,
  signal,
  spawnFn,
  killGraceMs,
}) {
  const invocation = runtimeInvocation(cliPath, { execPath, platform });
  return runInstallProcess({
    command: invocation.command,
    args: [...invocation.prefix, ...args],
    shell: invocation.shell,
    env,
    timeoutMs,
    signal,
    spawnFn,
    killGraceMs,
  });
}

/**
 * Best-effort service registration detection without reading Mebular config or
 * secrets: the service installer writes a manifest under
 * `<serviceHome>/.mebular/services/mebular-serve.json` (or MEBULAR_SERVICE_HOME).
 * A registered service means the install action must start/attach it instead of
 * downloading a second runtime.
 */
export function detectRegisteredRuntimeService({
  env = process.env,
  userHome = homedir(),
  exists = existsSync,
} = {}) {
  const serviceHome = typeof env.MEBULAR_SERVICE_HOME === 'string' && env.MEBULAR_SERVICE_HOME.length > 0
    ? env.MEBULAR_SERVICE_HOME
    : join(userHome, '.mebular', 'services');
  const manifestPath = join(serviceHome, 'mebular-serve.json');
  if (!exists(manifestPath)) return false;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    if (manifest?.kind !== undefined && manifest.kind !== 'mebular-serve') return false;
    if (typeof manifest?.unitPath === 'string' && manifest.unitPath.length > 0) {
      return exists(manifest.unitPath);
    }
    return true;
  } catch {
    return false;
  }
}

/** Non-sensitive install status shared by `/mebular/embed-info` and HTTP. */
export function sanitizeRuntimeInstallState(value, fallback = null) {
  const source = isObject(value) ? value : {};
  const fallbackState = isObject(fallback) ? fallback : {};
  const read = (key) => (source[key] !== undefined ? source[key] : fallbackState[key]);
  const state = ['idle', 'installing', 'failed', 'done'].includes(read('state'))
    ? read('state')
    : 'idle';
  const rawReason = read('reason');
  const reason = typeof rawReason === 'string' && (INSTALL_REASON_SET.has(rawReason) || rawReason === 'not_allowed')
    ? rawReason
    : null;
  const text = (key) => (typeof read(key) === 'string' && read(key).length > 0 ? read(key).slice(0, 600) : null);
  return {
    state,
    reason,
    detail: text('detail'),
    manualCommand: text('manualCommand'),
    targetVersion: text('targetVersion'),
    action: typeof read('action') === 'string' && RUNTIME_INSTALL_ACTIONS.includes(read('action'))
      ? read('action')
      : null,
    startedAt: text('startedAt'),
    finishedAt: text('finishedAt'),
    reused: read('reused') === true,
    installed: read('installed') === true,
    started: read('started') === true,
    allowed: read('allowed') === true,
  };
}

/**
 * Create the install controller. It only runs on an explicit user action; it
 * never downloads from `start()`/`inspect()`/timers. A missing runtime is
 * resolved by (in order) a healthy daemon, a registered service, any App/CLI/
 * shared provider, and only then the fixed npm package. Failures leave no
 * staging directory, lock, provider overwrite, partial runtime or child process.
 *
 * @param {{
 *   config?: unknown,
 *   lifecycle: { inspect: () => Promise<Record<string, unknown>>, startAfterInstall?: () => Promise<Record<string, unknown>> },
 *   version?: string,
 *   env?: Record<string, string | undefined>,
 *   userHome?: string,
 *   cloudRoot?: string,
 *   platform?: string,
 *   execPath?: string,
 *   npmPath?: string | null,
 *   spawnFn?: typeof spawn,
 *   discoverProviders?: typeof discoverRuntimeProviders,
 *   detectService?: (context: Record<string, unknown>) => boolean | Promise<boolean>,
 *   exists?: (file: string) => boolean,
 *   pidAlive?: (pid: number) => boolean,
 *   now?: () => string,
 *   installTimeoutMs?: number,
 *   cliTimeoutMs?: number,
 *   installKillGraceMs?: number,
 *   signal?: AbortSignal | null,
 *   logger?: { info?: (message: string) => void, warn?: (message: string) => void },
 * }} options
 * @returns {{
 *   start: (action?: string) => { accepted: boolean, state: ReturnType<typeof sanitizeRuntimeInstallState> },
 *   cancel: () => Promise<unknown>,
 *   dispose: () => Promise<unknown>,
 *   getState: () => ReturnType<typeof sanitizeRuntimeInstallState>,
 *   allowed: () => boolean,
 *   denialReason: () => string | null,
 * }}
 */
export function createRuntimeInstallManager(options = {}) {
  const opts = isObject(options) ? options : {};
  const env = isObject(opts.env) ? opts.env : process.env;
  const platform = typeof opts.platform === 'string' ? opts.platform : process.platform;
  const execPath = typeof opts.execPath === 'string' && opts.execPath.length > 0 ? opts.execPath : process.execPath;
  const userHome = typeof opts.userHome === 'string' && opts.userHome.length > 0 ? opts.userHome : homedir();
  const config = resolveConfig(opts.config, { env });
  const lifecycle = isObject(opts.lifecycle) && typeof opts.lifecycle.inspect === 'function'
    ? opts.lifecycle
    : null;
  const spawnFn = typeof opts.spawnFn === 'function' ? opts.spawnFn : spawn;
  const discoverProviders = typeof opts.discoverProviders === 'function'
    ? opts.discoverProviders
    : discoverRuntimeProviders;
  const detectService = typeof opts.detectService === 'function'
    ? opts.detectService
    : () => detectRegisteredRuntimeService({
      env,
      userHome,
      platform,
      ...(typeof opts.exists === 'function' ? { exists: opts.exists } : {}),
    });
  const exists = typeof opts.exists === 'function' ? opts.exists : existsSync;
  const pidAliveFn = typeof opts.pidAlive === 'function' ? opts.pidAlive : isProcessAlive;
  const now = typeof opts.now === 'function' ? opts.now : () => new Date().toISOString();
  const installTimeoutMs = Number.isFinite(opts.installTimeoutMs)
    ? Math.max(250, opts.installTimeoutMs)
    : DEFAULT_INSTALL_TIMEOUT_MS;
  const cliTimeoutMs = Number.isFinite(opts.cliTimeoutMs)
    ? Math.max(250, opts.cliTimeoutMs)
    : DEFAULT_CLI_TIMEOUT_MS;
  const killGraceMs = Number.isFinite(opts.installKillGraceMs)
    ? Math.max(0, opts.installKillGraceMs)
    : DEFAULT_INSTALL_KILL_GRACE_MS;
  const logger = isObject(opts.logger) ? opts.logger : null;
  const cloudRoot = typeof opts.cloudRoot === 'string' && opts.cloudRoot.length > 0
    ? opts.cloudRoot
    : runtimeCloudRoot({ env, userHome });
  const version = assertRuntimeInstallVersion(
    typeof opts.version === 'string' && opts.version.length > 0 ? opts.version : RUNTIME_INSTALL_VERSION,
  );
  const manualCommand = runtimeManualInstallCommand(version);

  const denialReason = config.bootstrap === 'never'
    ? 'bootstrap_never'
    : config.runtime === 'external'
      ? 'runtime_external'
      : config.pinnedDaemonUrl === true
        ? 'daemon_url_pinned'
        : null;
  const allowed = denialReason === null && lifecycle !== null;

  let current = sanitizeRuntimeInstallState({
    state: 'idle',
    reason: null,
    manualCommand,
    targetVersion: version,
    allowed,
  });
  let task = null;
  let disposed = false;
  let controller = new AbortController();

  function log(level, message) {
    try {
      const fn = logger?.[level];
      if (typeof fn === 'function') fn.call(logger, message);
    } catch {
      // Logging must never break install.
    }
  }

  function publish(patch) {
    current = sanitizeRuntimeInstallState({ ...current, ...patch }, {
      manualCommand,
      targetVersion: version,
      allowed,
    });
    return current;
  }

  async function discoverProvider() {
    try {
      const discovery = await discoverProviders({
        env,
        platform,
        userHome,
        cloudRoot,
        ...(config.cliPath === undefined ? {} : { cliPath: config.cliPath }),
        ...(typeof opts.registry === 'undefined' ? {} : { registry: opts.registry }),
        ...(typeof opts.includeStandardApp === 'undefined' ? {} : { includeStandardApp: opts.includeStandardApp }),
        ...(typeof opts.exists === 'function' ? { exists: opts.exists } : {}),
      });
      return isObject(discovery?.selected) ? discovery.selected : null;
    } catch {
      return null;
    }
  }

  async function inspectExisting({ includeProviderForUp = false } = {}) {
    let snapshot = null;
    try {
      snapshot = await lifecycle.inspect();
    } catch {
      snapshot = null;
    }
    const up = snapshot?.status === 'up';
    if (up && !includeProviderForUp) return { up: true, snapshot, provider: null, service: false };
    const provider = await discoverProvider();
    let service = snapshot?.service?.registered === true;
    if (!service) {
      try {
        service = (await detectService({ env, userHome, platform, cloudRoot })) === true;
      } catch {
        service = false;
      }
    }
    return {
      up,
      snapshot,
      provider: provider ?? (isObject(snapshot?.provider) ? snapshot.provider : null),
      service,
    };
  }

  async function runCli(cliPath, args, { home = cloudRoot, timeoutMs = cliTimeoutMs } = {}) {
    const result = await runInstalledCli({
      cliPath,
      args,
      env: {
        ...env,
        MEBULAR_CLOUD_ROOT: cloudRoot,
        MEBULAR_HOME: home,
      },
      platform,
      execPath,
      timeoutMs,
      signal: controller.signal,
      spawnFn,
      killGraceMs,
    });
    return {
      ...result,
      ok: result.code === 0 && result.spawnError === undefined && result.aborted !== true && result.timedOut !== true,
    };
  }

  async function registerProvider(cliPath) {
    const result = await runCli(cliPath, [
      'runtime',
      'provider',
      'add',
      '--kind',
      'shared',
      '--path',
      cliPath,
      '--version',
      version,
      '--capabilities',
      'serve',
      '--json',
    ]);
    const data = parseJsonDocument(result.stdout);
    if (!result.ok || data?.ok !== true) {
      throw installError('provider_registration_failed', 'runtime provider registration failed', {
        detail: sanitizeDetail(firstUsefulLine(result.stderr) ?? result.spawnError?.message ?? 'provider_registration_failed', {
          home: cloudRoot,
          cliPath,
        }),
      });
    }
  }

  async function resolveInstalledHome(cliPath) {
    const result = await runCli(cliPath, ['runtime', 'resolve', '--json']);
    const data = parseJsonDocument(result.stdout);
    if (isObject(data) && typeof data.home === 'string' && isAbsolute(data.home)) return resolve(data.home);
    return cloudRoot;
  }

  async function ensureInit(cliPath, home) {
    const configPath = join(home, 'config.json');
    if (exists(configPath)) return { skipped: true };
    const result = await runCli(cliPath, ['init'], { home });
    if (!result.ok) {
      throw installError('init_failed', 'runtime init failed', {
        detail: sanitizeDetail(firstUsefulLine(result.stderr) ?? result.spawnError?.message ?? 'init_failed', {
          home,
          cliPath,
        }),
      });
    }
    if (!exists(configPath)) {
      throw installError('init_failed', 'runtime init did not write config.json', { detail: 'config_missing' });
    }
    return { skipped: false };
  }

  async function startExisting({ installed = false, reused = false, restartOwned = false } = {}) {
    if (typeof lifecycle.startAfterInstall !== 'function') {
      throw installError('start_failed', 'lifecycle does not support explicit start');
    }
    const result = await lifecycle.startAfterInstall({ restartOwned: restartOwned === true });
    let snapshot = isObject(result) ? result : null;
    if (snapshot === null || snapshot.status === undefined) {
      try {
        snapshot = await lifecycle.inspect();
      } catch {
        snapshot = null;
      }
    }
    if (snapshot?.status === 'up') {
      return publish({
        state: 'done',
        reason: null,
        detail: null,
        installed: installed || reused || current.installed,
        reused,
        started: snapshot.managed === true || current.started,
        finishedAt: now(),
      });
    }
    const rawReason = typeof snapshot?.reason === 'string' ? snapshot.reason : null;
    const reason = rawReason !== null && rawReason !== 'download_required' && INSTALL_REASON_SET.has(rawReason)
      ? rawReason
      : 'start_failed';
    throw installError(reason, 'runtime did not become ready after start', {
      detail: sanitizeDetail(rawReason ?? 'start_failed'),
    });
  }

  async function installFiles(reinstall) {
    const runtimeDir = runtimeInstallDir(cloudRoot);
    const targetPath = runtimeInstallTarget(cloudRoot, version);
    const cliPath = runtimeInstallCliPath(cloudRoot, version);
    let lock = null;
    let tempPath = null;
    let backupPath = null;
    try {
      await mkdir(runtimeDir, { recursive: true });
      lock = await acquireInstallLock({ runtimeDir, version, reinstall, pidAliveFn, now });
      await removeStaleInstallStaging(runtimeDir);

      const existing = await inspectInstalledRuntimePrefix(targetPath, version);
      if (!reinstall && existing.ok) {
        publish({ reused: true, installed: true, detail: null });
        log('info', 'shared runtime already installed; reusing the pinned version');
        return { cliPath, reused: true, installed: true, backupPath: null };
      }

      tempPath = join(runtimeDir, `${RUNTIME_STAGING_PREFIX}${version}-${process.pid}-${installRandomSuffix()}`);
      await mkdir(tempPath, { recursive: true });
      const invocation = buildRuntimeInstallCommand({
        version,
        prefix: tempPath,
        platform,
        npmPath: typeof opts.npmPath === 'string' ? opts.npmPath : null,
        execPath,
      });
      const childEnv = { ...env };
      delete childEnv.npm_config_global;
      delete childEnv.npm_config_argv;
      delete childEnv.npm_config_prefix;
      const run = await runInstallProcess({
        command: invocation.command,
        args: invocation.args,
        shell: invocation.shell,
        cwd: tempPath,
        env: childEnv,
        timeoutMs: installTimeoutMs,
        signal: controller.signal,
        spawnFn,
        killGraceMs,
      });
      if (run.aborted) throw installError('cancelled', 'runtime install cancelled', { detail: 'aborted' });
      if (run.timedOut) throw installError('cancelled', 'runtime install timed out', { detail: 'timeout', timedOut: true });
      if (run.spawnError || run.code !== 0) {
        const classified = classifyRuntimeInstallFailure({
          spawnError: run.spawnError,
          exitCode: run.code,
          stdout: run.stdout,
          stderr: run.stderr,
          options: { home: cloudRoot, cliPath },
        });
        throw installError(classified.reason, `runtime install failed (${classified.reason})`, {
          detail: classified.detail,
          status: classified.status,
        });
      }

      const installed = await inspectInstalledRuntimePrefix(tempPath, version);
      if (!installed.ok) {
        throw installError(installed.reason, 'runtime install validation failed', { detail: installed.detail });
      }
      if (exists(targetPath)) {
        backupPath = join(runtimeDir, `${RUNTIME_BACKUP_PREFIX}${version}-${installTimestamp(now())}-${installRandomSuffix()}`);
        await rename(targetPath, backupPath);
      }
      try {
        await rename(tempPath, targetPath);
        tempPath = null;
      } catch (error) {
        if (backupPath !== null) {
          try {
            await rename(backupPath, targetPath);
            backupPath = null;
          } catch (restoreError) {
            throw installError('permission_denied', `failed to restore the previous runtime: ${restoreError?.message ?? restoreError}`, {
              detail: 'swap_restore_failed',
            });
          }
        }
        throw installError(classifyInstallFsError(error), `failed to swap the runtime directory (${error?.code ?? 'error'})`, {
          detail: 'swap_failed',
        });
      }
      const finalCheck = await inspectInstalledRuntimePrefix(targetPath, version);
      if (!finalCheck.ok) {
        let restored = false;
        if (backupPath !== null) {
          await rm(targetPath, { recursive: true, force: true }).catch(() => undefined);
          try {
            await rename(backupPath, targetPath);
            backupPath = null;
            restored = true;
          } catch {
            restored = false;
          }
        }
        throw installError('integrity_mismatch', 'runtime validation failed after atomic swap', {
          detail: finalCheck.detail,
          previousPreserved: restored,
        });
      }
      publish({ installed: true, reused: false, detail: null });
      log('info', `shared runtime ${version} installed`);
      return { cliPath, reused: false, installed: true, backupPath };
    } finally {
      if (tempPath !== null) await rm(tempPath, { recursive: true, force: true }).catch(() => undefined);
      await lock?.release?.();
    }
  }

  async function execute(action) {
    const existing = await inspectExisting({ includeProviderForUp: action === 'reinstall' });
    if (disposed) return;
    if (existing.up && action !== 'reinstall') {
      publish({
        state: 'done',
        reason: null,
        detail: null,
        installed: current.installed,
        reused: true,
        started: false,
        finishedAt: now(),
      });
      return;
    }
    // App/CLI/service are always reused. Only a shared runtime provider may be
    // explicitly reinstalled; that is the one owner the plugin can switch.
    const sharedReinstall = action === 'reinstall'
      && existing.service !== true
      && existing.provider?.kind === 'shared';
    if (!sharedReinstall && (existing.provider !== null || existing.service)) {
      publish({ state: 'installing', reason: 'provisioning', detail: existing.service ? 'service' : 'provider' });
      await startExisting({ installed: false, reused: true });
      return;
    }
    if (existing.up && !sharedReinstall) {
      publish({
        state: 'done',
        reason: null,
        detail: null,
        installed: current.installed,
        reused: true,
        started: false,
        finishedAt: now(),
      });
      return;
    }
    if (action === 'redetect') {
      publish({
        state: 'idle',
        reason: 'download_required',
        detail: null,
        manualCommand,
        finishedAt: now(),
      });
      return;
    }

    publish({ state: 'installing', reason: 'provisioning', detail: null });
    let backupPath = null;
    const restoreBackup = async () => {
      if (backupPath === null) return;
      const targetPath = runtimeInstallTarget(cloudRoot, version);
      await rm(targetPath, { recursive: true, force: true }).catch(() => undefined);
      try {
        await rename(backupPath, targetPath);
        backupPath = null;
        log('warn', 'reinstall did not complete; previous shared runtime restored');
      } catch {
        log('warn', 'reinstall did not complete and the previous shared runtime could not be restored automatically');
      }
    };
    try {
      const files = await installFiles(action === 'reinstall');
      backupPath = files.backupPath ?? null;
      if (disposed) {
        await restoreBackup();
        return;
      }
      await registerProvider(files.cliPath);
      if (disposed) {
        await restoreBackup();
        return;
      }
      const home = await resolveInstalledHome(files.cliPath);
      if (disposed) {
        await restoreBackup();
        return;
      }
      await ensureInit(files.cliPath, home);
      if (disposed) {
        await restoreBackup();
        return;
      }
      publish({ state: 'installing', reason: 'provisioning', detail: 'starting' });
      await startExisting({
        installed: true,
        reused: files.reused === true,
        restartOwned: action === 'reinstall' && files.reused !== true,
      });
      backupPath = null;
    } catch (error) {
      await restoreBackup();
      throw error;
    }
  }

  function fail(error) {
    const reason = typeof error?.code === 'string' && INSTALL_REASON_SET.has(error.code)
      ? error.code
      : 'install_failed';
    const detail = sanitizeDetail(error?.detail ?? error?.message ?? 'install_failed', { home: cloudRoot });
    publish({
      state: 'failed',
      reason,
      detail,
      manualCommand,
      targetVersion: version,
      finishedAt: now(),
    });
    log('warn', `runtime install failed (${reason})`);
  }

  function start(action = 'install') {
    if (!RUNTIME_INSTALL_ACTIONS.includes(action)) {
      return { accepted: false, state: current };
    }
    if (!allowed) return { accepted: false, state: current };
    if (disposed) return { accepted: false, state: current };
    if (task !== null) return { accepted: false, state: current };

    controller = new AbortController();
    publish({
      state: 'installing',
      reason: null,
      detail: null,
      action,
      startedAt: now(),
      finishedAt: null,
      reused: false,
      started: false,
    });
    task = Promise.resolve()
      .then(() => execute(action))
      .catch((error) => {
        if (!disposed) fail(error);
      })
      .finally(() => {
        task = null;
      });
    return { accepted: true, state: current };
  }

  async function dispose() {
    if (disposed) return task ?? undefined;
    disposed = true;
    try {
      controller.abort('plugin_disposed');
    } catch {
      // Abort is best-effort.
    }
    if (task !== null) {
      try {
        await task;
      } catch {
        // The flow cleaned up its staging/lock in `finally`.
      }
    }
    if (current.state === 'installing') {
      publish({
        state: 'failed',
        reason: 'cancelled',
        detail: 'plugin_disposed',
        manualCommand,
        targetVersion: version,
        finishedAt: now(),
      });
    }
    return undefined;
  }

  return {
    start,
    cancel: dispose,
    dispose,
    getState: () => current,
    allowed: () => allowed,
    denialReason: () => denialReason,
  };
}

function readInstallBody(req) {
  return new Promise((resolvePromise) => {
    if (!isObject(req) || typeof req.on !== 'function') {
      const text = typeof req?.body === 'string' ? req.body : '';
      resolvePromise({ ok: true, text });
      return;
    }
    let size = 0;
    let settled = false;
    const chunks = [];
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      const text = String(chunk ?? '');
      size += Buffer.byteLength(text);
      if (size > MAX_INSTALL_BODY_BYTES) {
        finish({ ok: false, error: 'body_too_large' });
        return;
      }
      chunks.push(text);
    });
    req.on('end', () => finish({ ok: true, text: chunks.join('') }));
    req.on('error', () => finish({ ok: false, error: 'read_error' }));
  });
}

/**
 * Loopback-only `POST /mebular/runtime/install`.
 *
 * Remote peers get 404 for every method. The body accepts exactly one optional
 * `action` (`install|retry|reinstall|redetect`); version/URL/registry are never
 * accepted. Installation is asynchronous (202) and the client polls
 * `/mebular/embed-info` for the same host-owned state.
 *
 * @param {{
 *   config?: unknown,
 *   manager: ReturnType<typeof createRuntimeInstallManager>,
 * }} [options]
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createRuntimeInstallHandler(options = {}) {
  const opts = isObject(options) ? options : {};
  const config = resolveConfig(opts.config, { env: opts.env });
  const manager = isObject(opts.manager) ? opts.manager : null;

  function sendJson(res, status, value, extraHeaders = {}) {
    if (res === null || typeof res !== 'object' || typeof res.end !== 'function') return;
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    for (const [key, headerValue] of Object.entries(extraHeaders)) res.setHeader(key, headerValue);
    res.end(JSON.stringify(value));
  }

  return async function handleRuntimeInstall(req, res) {
    if (!isLoopbackAddress(req?.socket?.remoteAddress)) {
      if (res !== null && typeof res === 'object' && typeof res.end === 'function') {
        res.statusCode = 404;
        res.end();
      }
      return;
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method_not_allowed' }, { allow: 'POST' });
      return;
    }
    const body = await readInstallBody(req);
    if (!body.ok) {
      sendJson(res, 400, { ok: false, error: 'invalid_body' });
      return;
    }
    let input = {};
    if (body.text.trim().length > 0) {
      const contentType = String(req.headers?.['content-type'] ?? req.headers?.['Content-Type'] ?? '');
      if (!/^application\/json\b/i.test(contentType)) {
        sendJson(res, 400, { ok: false, error: 'invalid_content_type' });
        return;
      }
      try {
        input = JSON.parse(body.text);
      } catch {
        sendJson(res, 400, { ok: false, error: 'invalid_json' });
        return;
      }
      if (!isObject(input)) {
        sendJson(res, 400, { ok: false, error: 'invalid_json' });
        return;
      }
      const keys = Object.keys(input);
      if (keys.some((key) => key !== 'action')) {
        sendJson(res, 400, { ok: false, error: 'unsupported_parameters' });
        return;
      }
    }
    const action = input.action === undefined ? 'install' : input.action;
    if (typeof action !== 'string' || !RUNTIME_INSTALL_ACTIONS.includes(action)) {
      sendJson(res, 400, { ok: false, error: 'invalid_action' });
      return;
    }
    if (manager === null) {
      sendJson(res, 503, { ok: false, error: 'install_unavailable' });
      return;
    }
    const configDenial = config.bootstrap === 'never'
      ? 'bootstrap_never'
      : config.runtime === 'external'
        ? 'runtime_external'
        : config.pinnedDaemonUrl === true
          ? 'daemon_url_pinned'
          : null;
    if (configDenial !== null) {
      sendJson(res, 403, {
        ok: false,
        error: 'install_not_allowed',
        reason: configDenial,
        ...(config.bootstrap === 'never' ? { bootstrap: 'never' } : {}),
        ...(config.runtime === 'external' ? { runtime: 'external' } : {}),
      });
      return;
    }
    if (typeof manager.allowed === 'function' && manager.allowed() !== true) {
      const reason = typeof manager.denialReason === 'function' ? manager.denialReason() : 'not_allowed';
      sendJson(res, 403, {
        ok: false,
        error: 'install_not_allowed',
        reason: reason ?? 'not_allowed',
        ...(config.bootstrap === 'never' ? { bootstrap: 'never' } : {}),
        ...(config.runtime === 'external' ? { runtime: 'external' } : {}),
      });
      return;
    }
    let result;
    try {
      result = manager.start(action);
    } catch {
      sendJson(res, 500, { ok: false, error: 'install_failed' });
      return;
    }
    sendJson(res, 202, {
      ok: true,
      accepted: result?.accepted === true,
      action,
      install: manager.getState(),
    });
  };
}

/**
 * Create the daemon lifecycle state machine used by the host plugin.
 *
 * attach: resolve + probe only. managed/auto: reuse a healthy daemon, or spawn
 * `mebular runtime supervise --json` exactly once and hold that supervise
 * process (never the daemon itself). A service/reused supervise exits after its
 * ready JSON; a child-mode one stays alive and dispose() sends SIGTERM only to
 * it, letting supervise stop the child it owns.
 *
 * `startAfterInstall()` is the explicit user-consent path used by the install
 * panel: it allows exactly one managed start even when lifecycle is `attach`,
 * is single-flight with the normal start, and never touches an external
 * daemon/service. `retry()` repeats that explicit start (or a read-only inspect
 * when starting is not allowed).
 *
 * @param {{
 *   config?: unknown,
 *   warn?: (message: string) => void,
 *   logger?: { info?: (message: string) => void, warn?: (message: string) => void },
 *   probe?: typeof probeDaemon,
 *   fetchImpl?: typeof fetch,
 *   spawnFn?: typeof spawn,
 *   resolveCli?: (context: { config: ReturnType<typeof resolveConfig> }) => string | null,
 *   discoverProviders?: typeof discoverRuntimeProviders,
 *   runResolve?: (context: Record<string, unknown>) => Promise<{ ok: boolean, data?: Record<string, unknown> | null, error?: string }>,
 *   startSupervise?: (context: Record<string, unknown>) => unknown,
 *   exists?: (file: string) => boolean,
 *   cloudRoot?: string,
 *   registry?: unknown,
 *   includeStandardApp?: boolean,
 *   env?: Record<string, string | undefined>,
 *   userHome?: string,
 *   home?: string,
 *   runtime?: unknown,
 *   pidAlive?: (pid: number) => boolean,
 *   platform?: string,
 *   execPath?: string,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<unknown>,
 *   timeoutMs?: number,
 *   resolveTimeoutMs?: number,
 *   cacheTtlMs?: number,
 *   startTimeoutMs?: number,
 *   pollIntervalMs?: number,
 *   superviseStopGraceMs?: number,
 * }} [options]
 * @returns {{
 *   start: () => Promise<Record<string, unknown>>,
 *   startAfterInstall: () => Promise<Record<string, unknown>>,
 *   retry: () => Promise<Record<string, unknown>>,
 *   inspect: () => Promise<Record<string, unknown>>,
 *   refresh: () => Promise<unknown>,
 *   dispose: () => void,
 *   getState: () => Record<string, unknown>,
 * }}
 */
export function createDaemonLifecycle(options = {}) {
  const opts = isObject(options) ? options : {};
  const env = isObject(opts.env) ? opts.env : process.env;
  const platform = typeof opts.platform === 'string' ? opts.platform : process.platform;
  const execPath = typeof opts.execPath === 'string' && opts.execPath.length > 0
    ? opts.execPath
    : process.execPath;
  const userHome = typeof opts.userHome === 'string' && opts.userHome.length > 0
    ? opts.userHome
    : homedir();
  const configOptions = { warn: opts.warn, env };
  if (opts.home !== undefined) configOptions.home = opts.home;
  if (opts.runtime !== undefined) configOptions.runtime = opts.runtime;
  if (opts.pidAlive !== undefined) configOptions.pidAlive = opts.pidAlive;
  const config = resolveConfig(opts.config, configOptions);
  const probe = typeof opts.probe === 'function' ? opts.probe : probeDaemon;
  const spawnFn = typeof opts.spawnFn === 'function' ? opts.spawnFn : spawn;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const sleep = typeof opts.sleep === 'function'
    ? opts.sleep
    : (ms) => new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_PROBE_TIMEOUT_MS;
  const resolveTimeoutMs = Number.isFinite(opts.resolveTimeoutMs)
    ? opts.resolveTimeoutMs
    : DEFAULT_RESOLVE_TIMEOUT_MS;
  const cacheTtlMs = Number.isFinite(opts.cacheTtlMs) ? opts.cacheTtlMs : DEFAULT_CACHE_TTL_MS;
  const startTimeoutMs = Number.isFinite(opts.startTimeoutMs)
    ? opts.startTimeoutMs
    : DEFAULT_MANAGED_START_TIMEOUT_MS;
  const pollIntervalMs = Number.isFinite(opts.pollIntervalMs)
    ? opts.pollIntervalMs
    : DEFAULT_MANAGED_POLL_INTERVAL_MS;
  const superviseStopGraceMs = Number.isFinite(opts.superviseStopGraceMs)
    ? Math.max(0, opts.superviseStopGraceMs)
    : DEFAULT_SUPERVISE_STOP_GRACE_MS;
  const logHome = typeof opts.home === 'string' && opts.home.length > 0 ? opts.home : mebularHome(env);
  const logger = isObject(opts.logger) ? opts.logger : null;
  const discoverProviders = typeof opts.discoverProviders === 'function'
    ? opts.discoverProviders
    : discoverRuntimeProviders;
  const legacyResolveCli = typeof opts.resolveCli === 'function' ? opts.resolveCli : null;
  const runResolveFn = typeof opts.runResolve === 'function'
    ? opts.runResolve
    : async (context) => {
      try {
        const result = await runRuntimeJson({
          cliPath: context?.provider?.path,
          command: ['resolve'],
          spawnFn,
          env: context?.env ?? env,
          platform: context?.platform ?? platform,
          execPath: context?.execPath ?? execPath,
          timeoutMs: Number.isFinite(context?.timeoutMs) ? context.timeoutMs : resolveTimeoutMs,
        });
        return isObject(result) ? result : { ok: false, error: 'resolve_failed' };
      } catch {
        return { ok: false, error: 'resolve_failed' };
      }
    };
  const startSupervise = typeof opts.startSupervise === 'function'
    ? opts.startSupervise
    : (context) => {
      const handle = startSuperviseProcess({
        cliPath: context?.provider?.path,
        scriptArgs: Array.isArray(context?.scriptArgs) ? context.scriptArgs : [],
        spawnFn,
        env: context?.env ?? env,
        platform: context?.platform ?? platform,
        execPath: context?.execPath ?? execPath,
        stopGraceMs: Number.isFinite(context?.stopGraceMs) ? context.stopGraceMs : superviseStopGraceMs,
        wait: sleep,
        logLine: (level, line) => log(level, redactLogLine(line, {
          home: logHome,
          cliPath: typeof context?.provider?.path === 'string' ? context.provider.path : undefined,
        })),
      });
      if (handle.error) log('warn', `runtime supervise failed to spawn (${handle.error})`);
      return handle;
    };

  const allowStart = (config.lifecycle === 'managed' || config.lifecycle === 'auto')
    && config.runtime !== 'external'
    && config.pinnedDaemonUrl !== true;
  const mode = allowStart ? 'managed' : 'attach';

  let phase = 'down';
  let state = 'down';
  let reason = null;
  let downloadRequired = false;
  let profile = null;
  let provider = null;
  let service = null;
  let version = null;
  let runtimeMode = null;
  let daemonUrl = config.daemonUrl;
  let health = null;
  let embed = null;
  let reachable = false;
  let managed = false;
  let superviseOwned = false;
  let superviseHandle = null;
  let lastProbeAt = -Infinity;
  /** @type {Promise<unknown> | null} */
  let probing = null;
  /** @type {Promise<unknown> | null} */
  let startPromise = null;
  /** Explicit user consent (install/redetect) allows one managed start on attach. */
  let startOnce = false;
  /** @type {Promise<unknown> | null} */
  let disposal = null;
  let disposed = false;
  /** @type {{ state: string, reason: string | null } | null} */
  let sticky = null;

  function log(level, message) {
    safeLog(logger, level, message);
  }

  if (config.pinnedDaemonUrl) {
    log('info', 'daemonUrl is pinned; lifecycle is attach-only');
  } else if (config.lifecycle !== 'attach' && config.runtime === 'external') {
    log('info', 'runtime is external; lifecycle is attach-only');
  }

  function snapshot() {
    return {
      status: phase,
      state: phase === 'up' ? 'up' : state,
      mode,
      runtimeMode,
      managed: managed && superviseOwned && !disposed,
      reason: phase === 'up' ? null : reason,
      reachable: phase === 'up' ? true : reachable,
      health,
      embed,
      daemonUrl,
      profile,
      provider,
      service,
      version,
      downloadRequired,
    };
  }

  function markDownloadRequired() {
    if (config.bootstrap === 'never') {
      downloadRequired = false;
      phase = 'down';
      state = 'down';
      reason = null;
      sticky = { state: 'down', reason: null };
      return;
    }
    downloadRequired = true;
    phase = 'down';
    state = 'download_required';
    reason = 'download_required';
    sticky = { state: 'download_required', reason: 'download_required' };
  }

  function applyResolve(data) {
    if (!isObject(data)) return;
    if (config.pinnedDaemonUrl !== true) {
      const url = daemonUrlFromHttp(data.http);
      if (url !== null) daemonUrl = url;
    }
    const nextProfile = sanitizeProfile(data.profile);
    if (nextProfile !== null) profile = nextProfile;
    else if (typeof data.profileId === 'string' && data.profileId.length > 0) {
      profile = { id: data.profileId, name: null };
    } else {
      profile = null;
    }
    service = sanitizeService(data.service);
    const nextProvider = sanitizeProvider(data.providers?.selected ?? data.provider);
    if (nextProvider !== null) provider = nextProvider;
    if (typeof data.version === 'string' && data.version.length > 0) version = data.version;
  }

  function applyFailure(data) {
    if (!isObject(data)) {
      phase = 'down';
      state = 'down';
      reason = 'runtime_error';
      sticky = { state, reason };
      return;
    }
    applyResolve(data);
    const next = failureState(data);
    if (next.download === true) {
      markDownloadRequired();
      log('warn', 'no Mebular runtime provider; download_required (no download, no spawn)');
      return;
    }
    downloadRequired = false;
    phase = 'down';
    state = next.state;
    reason = next.reason;
    sticky = { state, reason };
    log('warn', `shared runtime unavailable (${reason ?? 'unknown'})`);
  }

  function applyProbe(result) {
    const value = isObject(result) ? result : {};
    health = isObject(value.health) ? value.health : null;
    embed = isObject(value.embed) ? value.embed : null;
    reachable = value.reachable === true;
    lastProbeAt = now();

    if (reachable) {
      phase = 'up';
      state = 'up';
      reason = null;
      sticky = null;
      downloadRequired = false;
      if (typeof health?.version === 'string' && health.version.length > 0) version = health.version;
      if (!superviseOwned) managed = false;
      return;
    }
    if (phase === 'starting') return;
    phase = 'down';
    if (sticky !== null) {
      state = sticky.state;
      reason = sticky.reason;
      return;
    }
    if (downloadRequired) {
      state = 'download_required';
      reason = 'download_required';
      return;
    }
    state = 'down';
    reason = null;
  }

  async function runProbe() {
    try {
      const result = await probe({ daemonUrl, fetchImpl, timeoutMs });
      return isObject(result) ? result : { reachable: false, health: null, embed: null };
    } catch {
      return { reachable: false, health: null, embed: null };
    }
  }

  function refresh() {
    if (probing !== null) return probing;
    probing = (async () => {
      const result = await runProbe();
      if (!disposed) applyProbe(result);
      return snapshot();
    })().finally(() => {
      probing = null;
    });
    return probing;
  }

  async function inspect() {
    if (disposed) return snapshot();
    if (phase === 'starting') return snapshot();
    if (probing !== null) {
      await probing;
      return snapshot();
    }
    if (now() - lastProbeAt < cacheTtlMs) return snapshot();
    await refresh();
    return snapshot();
  }

  async function resolveProvider() {
    if (legacyResolveCli !== null) {
      try {
        return providerFromCliPath(legacyResolveCli({ config }));
      } catch {
        log('warn', 'runtime provider resolution failed; falling back to attach');
        return null;
      }
    }
    const discoveryOptions = { env, platform, userHome, cliPath: config.cliPath };
    if (opts.exists !== undefined) discoveryOptions.exists = opts.exists;
    if (opts.cloudRoot !== undefined) discoveryOptions.cloudRoot = opts.cloudRoot;
    if (opts.registry !== undefined) discoveryOptions.registry = opts.registry;
    if (opts.includeStandardApp !== undefined) discoveryOptions.includeStandardApp = opts.includeStandardApp;
    let discovery;
    try {
      discovery = await discoverProviders(discoveryOptions);
    } catch {
      return null;
    }
    return isObject(discovery?.selected) ? discovery.selected : null;
  }

  /**
   * Stop one plugin-owned supervise process and verify it really exited.
   * A `stopped:false` result is never silent: it is logged and reflected in the
   * lifecycle reason so the panel does not claim a clean shutdown.
   */
  async function stopHandle(handle) {
    if (!isObject(handle) || typeof handle.stop !== 'function') {
      return { stopped: true, reason: 'not_running' };
    }
    let result;
    try {
      result = await handle.stop({ graceMs: superviseStopGraceMs });
    } catch {
      log('warn', 'failed to stop runtime supervise');
      result = { stopped: false, reason: 'stop_failed' };
    }
    const alreadyExited = result?.reason === 'already_exited'
      || handle.getState?.().exited === true;
    if (result?.stopped !== true && !alreadyExited) {
      phase = 'down';
      state = 'down';
      reason = 'supervise_stop_failed';
      sticky = { state, reason };
      log(
        'warn',
        `runtime supervise did not confirm exit (${result?.reason ?? 'still_running'}) after ${superviseStopGraceMs}ms; a supervise/child process may remain`,
      );
    }
    return result;
  }

  async function stopSupervise() {
    const handle = superviseHandle;
    if (handle === null) return { stopped: true, reason: 'not_running' };
    superviseHandle = null;
    const owned = superviseOwned;
    superviseOwned = false;
    managed = false;
    if (!owned) return { stopped: true, reason: 'not_owned' };
    return stopHandle(handle);
  }

  function watchSupervise(handle) {
    if (!isObject(handle) || typeof handle.exited?.then !== 'function') return;
    handle.exited.then((exit) => {
      if (disposed) return;
      superviseOwned = false;
      managed = false;
      // A service/reused supervise exits after its ready JSON: normal.
      if (runtimeMode !== 'child') return;
      phase = 'down';
      state = 'down';
      reason = 'child_exited';
      sticky = { state: 'down', reason: 'child_exited' };
      log('warn', `runtime supervise exited (${exit?.code ?? exit?.signal ?? 'unknown'}) before the child stayed healthy`);
    }).catch(() => {});
  }

  async function awaitReady(handle) {
    const timeout = new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ timedOut: true }), startTimeoutMs);
      timer.unref?.();
    });
    const settled = Promise.resolve(handle.ready)
      .then((value) => ({ value }), () => ({ value: null }));
    return Promise.race([settled, timeout]);
  }

  async function waitForManagedHealth() {
    const deadline = now() + startTimeoutMs;
    while (!disposed) {
      const result = await runProbe();
      if (disposed) return;
      applyProbe(result);
      if (reachable) return;
      const exited = typeof superviseHandle?.getState === 'function'
        ? superviseHandle.getState()?.exited === true
        : !superviseOwned;
      if (exited) {
        phase = 'down';
        state = 'down';
        reason = 'managed_start_failed';
        sticky = { state, reason };
        return;
      }
      if (now() >= deadline) {
        log('warn', `runtime supervise did not become healthy within ${startTimeoutMs}ms`);
        await stopSupervise();
        if (disposed) return;
        phase = 'down';
        state = 'down';
        reason = 'managed_start_failed';
        sticky = { state, reason };
        return;
      }
      await sleep(pollIntervalMs);
    }
  }

  async function waitForDaemonUp() {
    const deadline = now() + startTimeoutMs;
    while (!disposed) {
      const result = await runProbe();
      if (disposed) return;
      applyProbe(result);
      if (reachable) return;
      if (now() >= deadline) return;
      await sleep(pollIntervalMs);
    }
  }

  async function ensureManaged() {
    if (config.pinnedDaemonUrl) {
      await refresh();
      return;
    }
    const cliProvider = await resolveProvider();
    if (disposed) return;
    if (cliProvider === null) {
      await refresh();
      if (!disposed && !reachable) markDownloadRequired();
      return;
    }

    const resolved = await runResolveFn({ provider: cliProvider, config, env, platform, execPath, spawnFn, timeoutMs: resolveTimeoutMs });
    if (disposed) return;
    if (resolved.ok !== true || !isObject(resolved.data)) {
      await refresh();
      if (!reachable && !disposed) {
        phase = 'down';
        state = 'down';
        reason = 'runtime_resolve_failed';
        sticky = { state, reason };
        log('warn', `runtime resolve failed (${resolved.error ?? 'unknown'})`);
      }
      return;
    }

    const data = resolved.data;
    applyResolve(data);
    if (provider === null) provider = sanitizeProvider(cliProvider);
    if (data.mode === 'reused') {
      await refresh();
      return;
    }
    if (data.mode !== 'child' && data.mode !== 'service') {
      applyFailure(data);
      return;
    }

    phase = 'starting';
    state = 'starting';
    reason = 'provisioning';
    managed = false;
    const handle = await startSupervise({
      provider: cliProvider,
      config,
      env,
      platform,
      execPath,
      spawnFn,
      stopGraceMs: superviseStopGraceMs,
      scriptArgs: config.persistence === 'service' ? ['--start', 'service'] : [],
    });
    if (disposed) {
      await stopHandle(handle);
      return;
    }
    if (!isObject(handle)) {
      phase = 'down';
      state = 'down';
      reason = 'supervise_failed';
      sticky = { state, reason };
      return;
    }
    superviseHandle = handle;
    superviseOwned = true;

    const readyResult = await awaitReady(handle);
    if (disposed) {
      await stopSupervise();
      return;
    }
    if (isObject(readyResult) && readyResult.timedOut === true) {
      log('warn', `runtime supervise did not report ready within ${startTimeoutMs}ms`);
      await stopSupervise();
      if (disposed) return;
      phase = 'down';
      state = 'down';
      reason = 'managed_start_failed';
      sticky = { state, reason };
      return;
    }

    const ready = isObject(readyResult) ? readyResult.value : null;
    const readyData = isObject(ready?.data) ? ready.data : null;
    if (readyData === null) {
      await refresh();
      if (!reachable && !disposed) {
        phase = 'down';
        state = 'down';
        reason = ready?.exited === true ? 'supervise_failed' : 'managed_start_failed';
        sticky = { state, reason };
      }
      return;
    }

    applyResolve(readyData);
    runtimeMode = readyData.mode === 'child'
      ? 'child'
      : readyData.mode === 'service' ? 'service' : 'reused';

    if (readyData.ok !== true) {
      if (readyData.mode === 'reused') {
        await refresh();
        return;
      }
      applyFailure(readyData);
      await stopSupervise();
      return;
    }

    watchSupervise(handle);
    managed = runtimeMode === 'child';
    if (runtimeMode === 'child') {
      await waitForManagedHealth();
      if (!reachable && !disposed) await stopSupervise();
      return;
    }

    // service/reused: the ready JSON is authoritative; the supervise process
    // exits normally. Wait briefly for /healthz to confirm, never spawn again.
    await waitForDaemonUp();
    if (!reachable && !disposed) {
      phase = 'down';
      state = 'down';
      reason = runtimeMode === 'service' ? 'service_start_failed' : 'managed_start_failed';
      sticky = { state, reason };
    }
  }

  async function ensureAttach() {
    if (config.pinnedDaemonUrl) {
      await refresh();
      return;
    }
    const cliProvider = await resolveProvider();
    if (disposed) return;
    if (cliProvider === null) {
      await refresh();
      if (!disposed && !reachable) markDownloadRequired();
      return;
    }

    const resolved = await runResolveFn({ provider: cliProvider, config, env, platform, execPath, spawnFn, timeoutMs: resolveTimeoutMs });
    if (disposed) return;
    if (resolved.ok === true && isObject(resolved.data)) {
      const data = resolved.data;
      applyResolve(data);
      if (provider === null) provider = sanitizeProvider(cliProvider);
      await refresh();
      if (reachable || disposed) return;
      if (data.mode === 'download_required' || data.mode === 'conflict' || data.mode === 'error') {
        applyFailure(data);
        return;
      }
      // child/service: a runtime is installed but not running. Attach never
      // starts it; the panel asks the user to open Mebular.
      downloadRequired = false;
      phase = 'down';
      state = 'down';
      reason = null;
      sticky = { state: 'down', reason: null };
      return;
    }

    await refresh();
    if (!reachable && !disposed) {
      phase = 'down';
      state = 'down';
      reason = 'runtime_resolve_failed';
      sticky = { state, reason };
    }
  }

  function start() {
    return beginStart(allowStart);
  }

  /**
   * Explicit user-consented managed start. `lifecycle: attach` still never
   * starts on activation; only this call (install/redetect/retry) opts in for
   * one start. It re-resolves providers first, so a daemon that appeared in the
   * meantime is reused instead of duplicated. `restartOwned` stops only the
   * supervise process this plugin owns before starting the replaced runtime.
   * @param {{ restartOwned?: boolean }} [options]
   * @returns {Promise<Record<string, unknown>>}
   */
  async function startAfterInstall(options = {}) {
    if (disposed) return snapshot();
    if (config.pinnedDaemonUrl || config.runtime === 'external' || config.bootstrap === 'never') {
      await refresh();
      return snapshot();
    }
    startOnce = true;
    sticky = null;
    if (startPromise !== null) {
      try {
        await startPromise;
      } catch {
        // A failed attach/start is retried explicitly below.
      }
    }
    if (disposed) return snapshot();
    if (options?.restartOwned === true && superviseOwned && managed) {
      await stopSupervise();
      if (disposed) return snapshot();
    }
    return beginStart(true);
  }

  /**
   * Retry an explicitly allowed start after a failure. Attach-only lifecycles
   * without prior consent stay read-only and just re-inspect.
   * @returns {Promise<Record<string, unknown>>}
   */
  function retry() {
    if (disposed) return Promise.resolve(snapshot());
    if (!allowStart && !startOnce) return inspect();
    sticky = null;
    return startAfterInstall();
  }

  function beginStart(forceManaged) {
    if (startPromise !== null) return startPromise;
    if (disposed) return Promise.resolve(snapshot());
    const run = (async () => {
      try {
        if (forceManaged) await ensureManaged();
        else await ensureAttach();
      } catch (error) {
        log('warn', `lifecycle start failed (${safeErrorCode(error)})`);
        // A thrown start path must not leave an owned supervise process behind.
        await stopSupervise();
        if (disposed) return snapshot();
        phase = 'down';
        state = 'down';
        reason = forceManaged ? 'managed_start_failed' : null;
        if (reason !== null) sticky = { state, reason };
      }
      return snapshot();
    })();
    const tracked = run.finally(() => {
      if (startPromise === tracked) startPromise = null;
    });
    startPromise = tracked;
    return tracked;
  }

  /**
   * Idempotent async disposal. Callers may ignore the promise, but DSH unload
   * awaits it so the supervise process (and the child it owns) is cleaned up.
   * Repeated calls return the same promise and never signal twice.
   * @returns {Promise<unknown>}
   */
  function dispose() {
    if (disposal !== null) return disposal;
    disposed = true;
    managed = false;
    phase = 'down';
    disposal = (async () => {
      // Signal an already-assigned supervise immediately; waiting for the
      // start promise first could delay cleanup by the full start timeout.
      const immediateStop = stopSupervise();
      // Wait for an in-flight start so a supervise spawned during disposal is
      // still observed and stopped.
      if (startPromise !== null) {
        try {
          await startPromise;
        } catch {
          // A failed start has no owned supervise left; stop below is a no-op.
        }
      }
      await immediateStop;
      await stopSupervise();
    })();
    return disposal;
  }

  return {
    start,
    startAfterInstall,
    retry,
    inspect,
    refresh,
    dispose,
    getState: snapshot,
  };
}

/**
 * Create the exact-path HTTP handler. With a lifecycle, status comes from the
 * lifecycle state machine; without one (tests/tools), the read-only probe and
 * its 1s cache are used directly.
 * @param {{
 *   config?: unknown,
 *   fetchImpl?: typeof fetch,
 *   probe?: typeof probeDaemon,
 *   lifecycle?: ReturnType<typeof createDaemonLifecycle> | null,
 *   installManager?: ReturnType<typeof createRuntimeInstallManager> | null,
 *   now?: () => number,
 *   cacheTtlMs?: number,
 *   timeoutMs?: number,
 *   env?: Record<string, string | undefined>,
 *   home?: string,
 *   runtime?: unknown,
 *   pidAlive?: (pid: number) => boolean,
 * }} [options]
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createEmbedInfoHandler(options = {}) {
  const configOptions = { env: options.env, runtime: options.runtime, home: options.home, pidAlive: options.pidAlive };
  const config = resolveConfig(options.config, configOptions);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const probe = typeof options.probe === 'function' ? options.probe : probeDaemon;
  const lifecycle = options.lifecycle !== null && typeof options.lifecycle?.inspect === 'function'
    ? options.lifecycle
    : null;
  const installManager = options.installManager !== null
    && typeof options.installManager?.getState === 'function'
    ? options.installManager
    : null;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const cacheTtlMs = Number.isFinite(options.cacheTtlMs) ? options.cacheTtlMs : DEFAULT_CACHE_TTL_MS;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_PROBE_TIMEOUT_MS;

  /** @type {ReturnType<typeof buildEmbedInfo> | null} */
  let cached = null;
  let cachedAt = 0;
  /** @type {Promise<ReturnType<typeof buildEmbedInfo>> | null} */
  let inflight = null;

  async function readInfo() {
    if (lifecycle !== null) {
      const snapshot = await lifecycle.inspect();
      return buildEmbedInfo({
        // The lifecycle refreshes this from the shared supervisor's resolve.
        daemonUrl: typeof snapshot?.daemonUrl === 'string' && snapshot.daemonUrl.length > 0
          ? snapshot.daemonUrl
          : config.daemonUrl,
        reachable: snapshot?.reachable === true,
        health: isObject(snapshot?.health) ? snapshot.health : null,
        embed: isObject(snapshot?.embed) ? snapshot.embed : null,
        status: snapshot?.status,
        state: snapshot?.state,
        mode: snapshot?.mode,
        runtimeMode: snapshot?.runtimeMode,
        managed: snapshot?.managed === true,
        panel: config.panel,
        reason: typeof snapshot?.reason === 'string' ? snapshot.reason : null,
        version: typeof snapshot?.version === 'string' ? snapshot.version : null,
        profile: snapshot?.profile,
        provider: snapshot?.provider,
        service: snapshot?.service,
        downloadRequired: snapshot?.downloadRequired === true,
        install: installManager?.getState() ?? null,
      });
    }

    if (cached !== null && now() - cachedAt < cacheTtlMs) return cached;
    if (inflight === null) {
      inflight = Promise.resolve()
        .then(() => probe({ daemonUrl: config.daemonUrl, fetchImpl, timeoutMs }))
        .then((result) => buildEmbedInfo({
          daemonUrl: config.daemonUrl,
          reachable: result?.reachable === true,
          health: isObject(result?.health) ? result.health : null,
          embed: isObject(result?.embed) ? result.embed : null,
          panel: config.panel,
          install: installManager?.getState() ?? null,
        }))
        .catch(() => buildEmbedInfo({
          daemonUrl: config.daemonUrl,
          reachable: false,
          panel: config.panel,
          install: installManager?.getState() ?? null,
        }))
        .then((value) => {
          cached = value;
          cachedAt = now();
          return value;
        })
        .finally(() => {
          inflight = null;
        });
    }
    return inflight;
  }

  function sendJson(res, status, value, extraHeaders = {}) {
    if (res === null || typeof res !== 'object' || typeof res.end !== 'function') return;
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    for (const [key, headerValue] of Object.entries(extraHeaders)) res.setHeader(key, headerValue);
    res.end(JSON.stringify(value));
  }

  return async function handleEmbedInfo(req, res) {
    // Loopback first: a remote peer gets 404 for every method, not a 405 that
    // would confirm the route exists.
    if (!isLoopbackAddress(req?.socket?.remoteAddress)) {
      if (res !== null && typeof res === 'object' && typeof res.end === 'function') {
        res.statusCode = 404;
        res.end();
      }
      return;
    }
    if (req.method !== 'GET') {
      sendJson(res, 405, { ok: false, error: 'method_not_allowed' }, { allow: 'GET' });
      return;
    }
    let info;
    try {
      info = await readInfo();
    } catch {
      info = buildEmbedInfo({
        daemonUrl: config.daemonUrl,
        reachable: false,
        panel: config.panel,
        install: installManager?.getState() ?? null,
      });
    }
    sendJson(res, 200, info);
  };
}

/**
 * JSON embedded in an inline <script>. `<` is escaped so a string value can
 * never close the script tag; U+2028/U+2029 are escaped for older parsers.
 * @param {unknown} value
 * @returns {string}
 */
export function scriptJson(value) {
  let json;
  try {
    json = JSON.stringify(value);
  } catch {
    json = 'null';
  }
  if (typeof json !== 'string') json = 'null';
  return json
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * Browser bootstrap read by client.js before it registers slots. Only the
 * non-sensitive panel switch is exposed.
 * @param {boolean} panel
 * @returns {string}
 */
export function buildPanelGlobalScript(panel) {
  return `<script>window.${PANEL_GLOBAL}=${scriptJson({ panel: panel !== false })};</script>`;
}

/**
 * Insert the panel bootstrap into an index.html document. DSH taps receive the
 * raw index on every response, so insertion is idempotent and non-destructive.
 * @param {string} html
 * @param {boolean} panel
 * @returns {string}
 */
export function injectPanelGlobal(html, panel) {
  if (typeof html !== 'string' || html.length === 0) return html;
  if (html.includes(`window.${PANEL_GLOBAL}=`)) return html;
  const script = buildPanelGlobalScript(panel);
  const headEnd = html.indexOf('</head>');
  if (headEnd !== -1) return `${html.slice(0, headEnd)}${script}${html.slice(headEnd)}`;
  const bodyEnd = html.indexOf('</body>');
  if (bodyEnd !== -1) return `${html.slice(0, bodyEnd)}${script}${html.slice(bodyEnd)}`;
  return `${html}${script}`;
}

/**
 * Dispose a cordis fiber (or a plain disposer returned by a test double).
 * Never throws.
 * @param {unknown} fiber
 * @returns {Promise<void>}
 */
async function disposeFiber(fiber) {
  if (fiber === null || fiber === undefined) return;
  try {
    if (typeof fiber.dispose === 'function') await fiber.dispose();
    else if (typeof fiber === 'function') await fiber();
  } catch {
    // Disposal is best-effort; the supervisor still records the detach.
  }
}

/**
 * Mount the official DSH MCP client against the discovered daemon.
 *
 * The module is imported lazily so this package stays installable without the
 * DSH peer: Jest and plain Node fail the import with a stable code while the
 * status route and panel keep working. Inside DSH the host resolves the peer
 * from its own installation.
 *
 * `failOnStartupError: true` makes the child fiber reject when the initial MCP
 * connection or tool sync fails. Cordis keeps that failure inside the child
 * fiber, so activation of this host continues; mountMcp awaits that fiber,
 * disposes it on failure, and returns a stable code. The caller retries only
 * after a later health check. The returned handle is the only way this plugin
 * can unregister tools when the daemon goes away.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string} daemonUrl
 * @param {{
 *   log?: (level: 'info' | 'warn', message: string) => void,
 *   importModule?: (specifier: string) => Promise<unknown>,
 * }} [options]
 * @returns {Promise<
 *   { ok: true, dispose: () => Promise<void> } |
 *   { ok: false, code: 'ctx_unavailable' | 'peer_missing' | 'peer_import_failed' | 'mcp_client_mount_failed' | 'mcp_client_start_failed' }
 * >}
 */
export async function mountMcp(ctx, daemonUrl, options = {}) {
  const opts = isObject(options) ? options : {};
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  if (ctx === null || typeof ctx !== 'object' || typeof ctx.plugin !== 'function') {
    log('warn', 'mcp client mount failed (ctx_unavailable)');
    return { ok: false, code: 'ctx_unavailable' };
  }

  let module;
  try {
    module = typeof opts.importModule === 'function'
      ? await opts.importModule(MCP_CLIENT_PACKAGE)
      : await import('@deepseek-ai/dsh-mcp-client');
  } catch (error) {
    // Outside a DSH host the peer is absent (ERR_MODULE_NOT_FOUND). Keep the
    // return code stable and never echo the resolver message (it contains
    // absolute paths).
    const code = error?.code === 'ERR_MODULE_NOT_FOUND' || error?.code === 'MODULE_NOT_FOUND'
      ? 'peer_missing'
      : 'peer_import_failed';
    log('warn', `mcp client mount failed (${code})`);
    return { ok: false, code };
  }

  let fiber;
  try {
    fiber = ctx.plugin(module, {
      serverName: 'mebular',
      transport: 'streamable-http',
      url: joinUrl(daemonUrl, '/mcp'),
      failOnStartupError: true,
    });
  } catch {
    log('warn', 'mcp client mount failed (mcp_client_mount_failed)');
    return { ok: false, code: 'mcp_client_mount_failed' };
  }

  // cordis `ctx.plugin()` returns a Fiber that is also PromiseLike; awaiting it
  // settles activation and rethrows a startup error. Only after that may the
  // bridge count as mounted. A plain plugin double has no `then`, so it is
  // already settled.
  try {
    if (fiber !== null && (typeof fiber === 'object' || typeof fiber === 'function') && typeof fiber.then === 'function') {
      await fiber;
    }
    // Pending dependencies keep a cordis fiber in state 0 without rejecting
    // `await`. Treat that (and any other non-active state) as a failed mount so
    // the supervisor retries instead of claiming tools exist.
    if (fiber !== null && typeof fiber === 'object' && typeof fiber.state === 'number' && fiber.state !== 2) {
      throw new Error('inactive fiber');
    }
  } catch {
    await disposeFiber(fiber);
    log('warn', 'mcp client mount failed (mcp_client_start_failed)');
    return { ok: false, code: 'mcp_client_start_failed' };
  }

  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    await disposeFiber(fiber);
  };
  log('info', 'mcp client mounted');
  return { ok: true, dispose };
}

/**
 * Short Agent-facing text for a lifecycle snapshot.
 *
 * The text is empty while the daemon is `up`, so the normal case adds no
 * tokens. Non-up states explain why Mebular memory is missing and give one
 * recovery action; they never let the model claim memory is available.
 *
 * @param {Record<string, unknown> | null | undefined} snapshot
 * @returns {string}
 */
export function agentStatusText(snapshot) {
  const status = snapshot?.status;
  if (status !== 'down' && status !== 'starting') return '';
  if (status === 'starting') {
    return 'Mebular is starting; memory tools are temporarily unavailable. Retry shortly.';
  }
  const reason = snapshot?.reason;
  if (reason === 'download_required') {
    return 'Mebular memory is unavailable because no Mebular runtime was found. Tell the user to open the Mebular app or install the Mebular CLI, then restart DSH; the plugin never downloads it. Do not claim Mebular memory is available.';
  }
  if (reason === 'managed_cli_missing') {
    return 'Mebular memory is unavailable because the Mebular CLI was not found. Tell the user to install Mebular or set MEBULAR_CLI/cliPath, then restart DSH; do not claim Mebular memory is available.';
  }
  if (reason === 'service_unknown' || reason === 'service_foreign' || reason === 'service_not_registered') {
    return 'Mebular memory is unavailable because the shared Mebular service cannot be reused safely. Tell the user to open Mebular and check its service, then retry; do not claim Mebular memory is available.';
  }
  if (reason === 'instance_mismatch'
    || reason === 'instance_missing'
    || reason === 'cloud_mismatch'
    || reason === 'CLOUD_ALREADY_ACTIVE') {
    return 'Mebular memory is unavailable because another Mebular profile owns this address. Tell the user to switch Mebular to this profile or stop the other instance; do not claim Mebular memory is available.';
  }
  if (reason === 'port_in_use') {
    return 'Mebular memory is unavailable because another program uses the Mebular port. Tell the user to free the port or change the Mebular port; do not claim Mebular memory is available.';
  }
  if (reason === 'managed_start_failed') {
    return 'Mebular memory is unavailable because the managed Mebular daemon failed to start. Tell the user to check the Mebular logs, or start the Mebular app or run `mebular serve`; do not claim Mebular memory is available.';
  }
  if (reason === 'supervise_failed'
    || reason === 'child_exited'
    || reason === 'runtime_resolve_failed') {
    return 'Mebular memory is unavailable because the shared Mebular runtime did not start. Tell the user to check the Mebular logs, or start the Mebular app or run `mebular serve`; do not claim Mebular memory is available.';
  }
  if (isObject(snapshot?.health)) {
    return 'Mebular memory is unavailable because the local Mebular daemon is not healthy. Tell the user to check the Mebular app or its logs, then retry; do not claim Mebular memory is available.';
  }
  return 'Mebular memory is unavailable because the local Mebular daemon is not running. Tell the user to start the Mebular app or run `mebular serve`; do not claim Mebular memory is available.';
}

/**
 * Feature-detect the optional DSH `systemPrompt` service. Older DSH versions
 * and profiles without that service simply get no section.
 * @param {Record<string, unknown> | null} ctx
 * @returns {{ section: (section: Record<string, unknown>) => unknown } | null}
 */
function systemPromptService(ctx) {
  if (ctx === null) return null;
  try {
    const service = ctx.systemPrompt;
    const usable = service !== null
      && (typeof service === 'object' || typeof service === 'function')
      && typeof service.section === 'function';
    return usable ? service : null;
  } catch {
    return null;
  }
}

/** Normalize the disposer returned by a cordis effect. @param {unknown} handle */
function asDisposer(handle) {
  if (typeof handle === 'function') return handle;
  if (handle !== null && typeof handle === 'object' && typeof handle.dispose === 'function') {
    return () => handle.dispose();
  }
  return null;
}

/**
 * Keep one DSH system-prompt section aligned with lifecycle snapshots.
 *
 * Cordis requires the service to be injected, so `bind()` is called from an
 * `ctx.inject(['systemPrompt'])` child. Until then the controller still records
 * lifecycle text but contributes no section and emits no notifications.
 *
 * The section provider reads the latest text at assembly time. A
 * `system-prompt/change` notification is emitted only when that text actually
 * changes, so the 2s bridge poll never invalidates the prompt every tick.
 *
 * @param {{
 *   log?: (level: 'info' | 'warn', message: string) => void,
 * }} [options]
 * @returns {{
 *   bind: (
 *     service: unknown,
 *     options?: { emit?: (event: string) => void },
 *   ) => boolean,
 *   unbind: () => void,
 *   update: (snapshot: Record<string, unknown> | null | undefined) => boolean,
 *   dispose: () => void,
 *   getText: () => string,
 *   isRegistered: () => boolean,
 * }}
 */
export function createAgentStatus(options = {}) {
  const opts = isObject(options) ? options : {};
  const log = typeof opts.log === 'function' ? opts.log : () => {};

  let text = '';
  /** @type {((event: string) => void) | null} */
  let emit = null;
  let registered = false;
  /** @type {(() => void) | null} */
  let sectionDisposer = null;
  let disposed = false;

  function bind(service, bindOptions = {}) {
    if (disposed || registered) return false;
    if (service === null
      || (typeof service !== 'object' && typeof service !== 'function')
      || typeof service.section !== 'function') {
      return false;
    }
    const bindOpts = isObject(bindOptions) ? bindOptions : {};
    if (typeof bindOpts.emit === 'function') emit = bindOpts.emit;
    try {
      sectionDisposer = asDisposer(service.section({
        name: AGENT_STATUS_SECTION,
        order: AGENT_STATUS_ORDER,
        text: () => text,
      }));
      registered = true;
      return true;
    } catch {
      // A duplicate section or an older service shape must not affect the
      // panel, the MCP bridge, or plugin activation.
      log('warn', 'agent status section registration failed (section_unavailable); continuing without agent hints');
      return false;
    }
  }

  function unbind() {
    if (!registered) return;
    const disposer = sectionDisposer;
    sectionDisposer = null;
    registered = false;
    if (disposer !== null) {
      try {
        disposer();
      } catch {
        // Disposal is best-effort; plugin unload must continue.
      }
    }
  }

  function update(snapshot) {
    if (disposed) return false;
    const next = agentStatusText(snapshot);
    if (next === text) return false;
    text = next;
    if (registered && emit !== null) {
      try {
        emit('system-prompt/change');
      } catch {
        // A refresh notification must never break the bridge.
      }
    }
    return true;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    unbind();
  }

  return {
    bind,
    unbind,
    update,
    dispose,
    getText: () => text,
    isRegistered: () => registered,
  };
}

/**
 * Stable bridge notice for a lifecycle snapshot.
 * @param {Record<string, unknown> | null | undefined} snapshot
 * @returns {string}
 */
function bridgeReason(snapshot) {
  const reason = snapshot?.reason;
  if (typeof reason === 'string' && reason.length > 0) return reason;
  return 'daemon_unreachable';
}

/**
 * Human-readable log line for an unavailable bridge. Codes are stable and
 * contain no home, token, or CLI path.
 * @param {string} code
 * @returns {string}
 */
function bridgeUnavailableMessage(code) {
  switch (code) {
    case 'daemon_unreachable':
      return 'mcp bridge unavailable (daemon_unreachable): start the Mebular app or run "mebular serve"';
    case 'daemon_starting':
      return 'mcp bridge unavailable (daemon_starting): waiting for the managed daemon to become healthy';
    case 'provisioning':
      return 'mcp bridge unavailable (provisioning): the shared runtime supervisor is starting Mebular';
    case 'download_required':
      return 'mcp bridge unavailable (download_required): open the Mebular app or install the Mebular CLI; this plugin does not download it';
    case 'managed_cli_missing':
      return 'mcp bridge unavailable (managed_cli_missing): install Mebular or set MEBULAR_CLI/cliPath, then restart DSH';
    case 'managed_start_failed':
      return 'mcp bridge unavailable (managed_start_failed): the managed daemon did not become healthy; start Mebular manually';
    case 'supervise_failed':
      return 'mcp bridge unavailable (supervise_failed): the shared runtime supervisor exited before ready; check the Mebular logs';
    case 'child_exited':
      return 'mcp bridge unavailable (child_exited): the runtime this plugin started exited; start Mebular again';
    case 'runtime_resolve_failed':
      return 'mcp bridge unavailable (runtime_resolve_failed): reinstall or update the Mebular app/CLI';
    case 'service_unknown':
    case 'service_foreign':
    case 'service_not_registered':
      return `mcp bridge unavailable (${code}): the Mebular service state cannot be reused safely; check the Mebular service`;
    case 'instance_mismatch':
    case 'instance_missing':
    case 'cloud_mismatch':
    case 'CLOUD_ALREADY_ACTIVE':
      return `mcp bridge unavailable (${code}): another Mebular profile owns this address; switch profiles or stop it`;
    case 'port_in_use':
      return 'mcp bridge unavailable (port_in_use): another program uses the Mebular port; free it or change the port';
    case 'start_locked':
      return 'mcp bridge unavailable (start_locked): another Mebular entry point is starting the runtime; retrying';
    case 'peer_missing':
      return 'mcp bridge unavailable (peer_missing): install @deepseek-ai/dsh-mcp-client in the DSH host';
    case 'ctx_unavailable':
      return 'mcp bridge unavailable (ctx_unavailable): the DSH context cannot mount plugins';
    default:
      return `mcp bridge unavailable (${code}): the official MCP client could not start; retrying while the daemon is healthy`;
  }
}

/**
 * Keep the official MCP client mounted exactly while the lifecycle says `up`.
 *
 * The supervisor polls `lifecycle.inspect()` on one unref'd interval. It mounts
 * nothing while the daemon is down or starting, waits for the child fiber to
 * settle before reporting success, and disposes that fiber as soon as the
 * daemon leaves `up` so last-known tools cannot linger and hang calls. A later
 * `up` mounts a fresh fiber with the same `serverName`; the previous fiber was
 * disposed first, so the official namespace reservation is free again.
 * Notices are deduplicated by state/error code, not repeated every tick.
 *
 * @param {{
 *   lifecycle: { inspect: () => Promise<unknown> },
 *   daemonUrl: string,
 *   mount: (daemonUrl: string) => Promise<
 *     { ok: true, dispose: () => Promise<void> } |
 *     { ok: false, code: string }
 *   >,
 *   log?: (level: 'info' | 'warn', message: string) => void,
 *   onSnapshot?: (snapshot: Record<string, unknown>) => void,
 *   intervalMs?: number,
 *   setIntervalFn?: typeof setInterval,
 *   clearIntervalFn?: typeof clearInterval,
 * }} options
 * @returns {{
 *   start: () => Promise<void>,
 *   check: () => Promise<void>,
 *   dispose: () => Promise<void>,
 *   getState: () => { mounted: boolean, timer: boolean, disposed: boolean },
 * }}
 */
export function createMcpBridgeSupervisor(options = {}) {
  const opts = isObject(options) ? options : {};
  const lifecycle = isObject(opts.lifecycle) ? opts.lifecycle : null;
  const daemonUrl = typeof opts.daemonUrl === 'string' ? opts.daemonUrl : '';
  const mount = typeof opts.mount === 'function' ? opts.mount : null;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const onSnapshot = typeof opts.onSnapshot === 'function' ? opts.onSnapshot : null;
  const intervalMs = Number.isFinite(opts.intervalMs) && opts.intervalMs > 0
    ? opts.intervalMs
    : DEFAULT_BRIDGE_POLL_INTERVAL_MS;
  const setIntervalFn = typeof opts.setIntervalFn === 'function' ? opts.setIntervalFn : setInterval;
  const clearIntervalFn = typeof opts.clearIntervalFn === 'function' ? opts.clearIntervalFn : clearInterval;

  /** @type {{ ok: true, dispose: () => Promise<void> } | null} */
  let mounted = null;
  /** URL of the currently mounted fiber, so a daemon URL change remounts. */
  let mountedUrl = null;
  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null;
  /** @type {Promise<void> | null} */
  let running = null;
  /** @type {Promise<void> | null} */
  let disposal = null;
  let disposed = false;
  /** Last down/starting code that was logged. */
  let lastNotice = null;
  /** Last mount error code that was logged while the daemon stayed up. */
  let lastMountFailure = null;

  async function reconcile() {
    if (lifecycle === null || mount === null) return;
    let snapshot;
    try {
      snapshot = await lifecycle.inspect();
    } catch {
      snapshot = { status: 'down', reason: null };
    }
    if (disposed) return;

    if (onSnapshot !== null) {
      try {
        onSnapshot(snapshot);
      } catch {
        // Agent status hints are best-effort and must not block the bridge.
      }
    }

    const status = snapshot?.status;
    const effectiveUrl = typeof snapshot?.daemonUrl === 'string' && snapshot.daemonUrl.length > 0
      ? snapshot.daemonUrl
      : daemonUrl;
    if (status === 'up') {
      lastNotice = null;
      if (mounted !== null && mountedUrl === effectiveUrl) return;
      if (mounted !== null) {
        // The shared supervisor resolved a different profile/port: release the
        // old fiber first so two bridges never coexist.
        const previous = mounted;
        mounted = null;
        mountedUrl = null;
        try {
          await previous.dispose();
          log('info', 'mcp bridge reattached (daemon_url_changed)');
        } catch {
          log('warn', 'mcp bridge detach failed (mcp_client_dispose_failed): MCP tools may remain registered');
        }
        if (disposed) return;
      }
      let result;
      try {
        result = await mount(effectiveUrl);
      } catch (error) {
        const code = safeErrorCode(error);
        result = { ok: false, code: code === 'error' ? 'mcp_client_start_failed' : code };
      }
      if (disposed) {
        if (result?.ok === true) await disposeFiber(result);
        return;
      }
      if (result?.ok === true && typeof result.dispose === 'function') {
        mounted = result;
        mountedUrl = effectiveUrl;
        lastMountFailure = null;
        return;
      }
      let code = 'mcp_client_start_failed';
      if (result?.ok === true) code = 'mcp_client_mount_failed';
      else if (typeof result?.code === 'string' && result.code.length > 0) code = result.code;
      if (lastMountFailure !== code) {
        lastMountFailure = code;
        log('warn', bridgeUnavailableMessage(code));
      }
      return;
    }

    lastMountFailure = null;
    if (mounted !== null) {
      const handle = mounted;
      mounted = null;
      mountedUrl = null;
      try {
        await handle.dispose();
      } catch {
        log('warn', 'mcp bridge detach failed (mcp_client_dispose_failed): MCP tools may remain registered');
      }
      const code = bridgeReason(snapshot);
      log('warn', `mcp bridge detached (${code}): MCP tools unregistered`);
      lastNotice = code;
      return;
    }

    const code = status === 'starting' ? 'daemon_starting' : bridgeReason(snapshot);
    if (lastNotice !== code) {
      lastNotice = code;
      log(status === 'starting' ? 'info' : 'warn', bridgeUnavailableMessage(code));
    }
  }

  function tick() {
    if (disposed) return Promise.resolve();
    if (running !== null) return running;
    const task = reconcile()
      .catch((error) => {
        if (!disposed) log('warn', `mcp bridge reconcile failed (${safeErrorCode(error)})`);
      })
      .finally(() => {
        if (running === task) running = null;
      });
    running = task;
    return task;
  }

  function start() {
    if (disposed) return Promise.resolve();
    if (timer === null) {
      timer = setIntervalFn(tick, intervalMs);
      timer?.unref?.();
    }
    return tick();
  }

  function dispose() {
    if (disposal !== null) return disposal;
    disposed = true;
    if (timer !== null) {
      clearIntervalFn(timer);
      timer = null;
    }
    const pending = running;
    disposal = Promise.resolve(pending)
      .catch(() => {})
      .then(async () => {
        if (mounted !== null) {
          const handle = mounted;
          mounted = null;
          mountedUrl = null;
          await handle.dispose().catch(() => {});
        }
      });
    return disposal;
  }

  return {
    start,
    check: tick,
    dispose,
    getState: () => ({
      mounted: mounted !== null,
      mountedUrl,
      timer: timer !== null,
      disposed,
    }),
  };
}

/**
 * Mount the host plugin. Attach is the default and never starts a process;
 * managed starts at most one child and stops it on dispose. The route is
 * optional because profiles without a webServer (headless/TUI) never mount it.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {unknown} [config]
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   home?: string,
 *   runtime?: unknown,
 *   pidAlive?: (pid: number) => boolean,
 *   importModule?: (specifier: string) => Promise<unknown>,
 *   lifecycle?: { start?: () => Promise<unknown>, inspect: () => Promise<unknown>, dispose?: () => void },
 *   probe?: typeof probeDaemon,
 *   fetchImpl?: typeof fetch,
 *   now?: () => number,
 *   cacheTtlMs?: number,
 *   bridgeIntervalMs?: number,
 *   setIntervalFn?: typeof setInterval,
 *   clearIntervalFn?: typeof clearInterval,
 * }} [options] Test seams; DSH passes only (ctx, config).
 */
export function apply(ctx, config = {}, options = {}) {
  if (ctx === null || typeof ctx !== 'object') return;
  const raw = isObject(config) ? config : {};
  const opts = isObject(options) ? options : {};
  const rawLogger = ctx.logger;
  const log = (level, message) => {
    try {
      const fn = rawLogger?.[level];
      if (typeof fn === 'function') fn.call(rawLogger, `@mebular/dsh-plugin: ${message}`);
      else if (level !== 'info' && typeof rawLogger?.warn === 'function') {
        rawLogger.warn(`@mebular/dsh-plugin: ${message}`);
      }
    } catch {
      // Logging must never fail plugin activation.
    }
  };

  const configOptions = { warn: (message) => log('warn', message) };
  for (const key of ['env', 'home', 'runtime', 'pidAlive']) {
    if (opts[key] !== undefined) configOptions[key] = opts[key];
  }
  const resolved = resolveConfig(raw, configOptions);

  const lifecycleOptions = {
    config: resolved,
    logger: {
      info: (message) => log('info', message),
      warn: (message) => log('warn', message),
    },
  };
  for (const key of [
    'probe', 'fetchImpl', 'spawnFn', 'resolveCli', 'discoverProviders', 'runResolve', 'startSupervise',
    'exists', 'env', 'home', 'runtime', 'pidAlive', 'platform', 'userHome', 'cloudRoot', 'registry',
    'includeStandardApp', 'execPath', 'now', 'sleep', 'timeoutMs', 'resolveTimeoutMs', 'cacheTtlMs',
    'startTimeoutMs', 'pollIntervalMs', 'superviseStopGraceMs',
  ]) {
    if (opts[key] !== undefined) lifecycleOptions[key] = opts[key];
  }
  const lifecycle = isObject(opts.lifecycle) && typeof opts.lifecycle.inspect === 'function'
    ? opts.lifecycle
    : createDaemonLifecycle(lifecycleOptions);

  const installOptions = {
    config: resolved,
    lifecycle,
  };
  for (const key of [
    'env', 'platform', 'execPath', 'userHome', 'cloudRoot', 'registry', 'includeStandardApp',
    'discoverProviders', 'detectService', 'exists', 'pidAlive', 'spawnFn', 'now', 'npmPath',
    'installTimeoutMs', 'cliTimeoutMs', 'installKillGraceMs', 'version',
  ]) {
    if (opts[key] !== undefined) installOptions[key] = opts[key];
  }
  installOptions.logger = {
    info: (message) => log('info', message),
    warn: (message) => log('warn', message),
  };
  const installManager = isObject(opts.installManager)
    && typeof opts.installManager.start === 'function'
    && typeof opts.installManager.getState === 'function'
    ? opts.installManager
    : createRuntimeInstallManager(installOptions);

  // Agent-visible status is derived from the same lifecycle snapshot as the
  // MCP bridge; it is not a second status source and never adds its own poll.
  // `panel:false` does not disable it because it is prompt text, not UI.
  const agentStatus = createAgentStatus({
    log: (level, message) => log(level, message),
  });
  // Cordis rejects `ctx.systemPrompt` access without this inject, even though
  // the service is loaded by the profile. A profile without the service never
  // runs the callback, so the section is skipped without affecting activation.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['systemPrompt'], (promptCtx) => {
      agentStatus.bind(promptCtx?.systemPrompt, {
        emit: typeof promptCtx?.emit === 'function'
          ? (event) => promptCtx.emit(event)
          : undefined,
      });
      return () => agentStatus.unbind();
    });
  } else {
    // Plain contexts outside cordis may expose the service directly.
    const service = systemPromptService(ctx);
    if (service !== null) {
      agentStatus.bind(service, {
        emit: typeof ctx.emit === 'function' ? (event) => ctx.emit(event) : undefined,
      });
    }
  }

  // Keep the bridge aligned with the lifecycle: mount only after a health probe
  // says `up`, dispose the fiber as soon as the daemon leaves `up`, and retry
  // after recovery. Failure notices are deduplicated inside the supervisor.
  const bridge = createMcpBridgeSupervisor({
    lifecycle,
    daemonUrl: resolved.daemonUrl,
    intervalMs: opts.bridgeIntervalMs,
    setIntervalFn: opts.setIntervalFn,
    clearIntervalFn: opts.clearIntervalFn,
    log: (level, message) => log(level, message),
    onSnapshot: (snapshot) => {
      agentStatus.update(snapshot);
    },
    mount: (daemonUrl) => mountMcp(ctx, daemonUrl, {
      // Success is logged once by mountMcp; failures are logged by the
      // supervisor only when the stable code changes.
      log: (level, message) => {
        if (level === 'info') log(level, message);
      },
      ...(typeof opts.importModule === 'function' ? { importModule: opts.importModule } : {}),
    }),
  });

  if (typeof ctx.effect === 'function') {
    ctx.effect(
      () => () => {
        agentStatus.dispose();
        const bridgeDisposal = Promise.resolve()
          .then(() => bridge.dispose())
          .catch(() => {});
        // Cordis/DSH unload awaits this effect disposal: the supervise process
        // needs its full stop window to release the child daemon it owns.
        const lifecycleDisposal = Promise.resolve()
          .then(() => lifecycle.dispose?.())
          .catch((error) => {
            log('warn', `lifecycle dispose failed (${safeErrorCode(error)})`);
          });
        const installDisposal = Promise.resolve()
          .then(() => installManager.dispose?.())
          .catch((error) => {
            log('warn', `install dispose failed (${safeErrorCode(error)})`);
          });
        return Promise.all([bridgeDisposal, lifecycleDisposal, installDisposal]);
      },
      '@mebular/dsh-plugin: daemon lifecycle, agent status, and MCP bridge',
    );
  }
  const lifecycleStart = Promise.resolve().then(() => lifecycle.start?.());
  lifecycleStart.catch((error) => log('warn', `lifecycle start failed (${safeErrorCode(error)})`));
  void lifecycleStart;
  void bridge.start();

  const handler = createEmbedInfoHandler({ config: resolved, lifecycle, installManager });
  const installHandler = createRuntimeInstallHandler({ config: resolved, manager: installManager, env: opts.env });
  if (typeof ctx.inject !== 'function') return;
  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx?.webServer;
    if (webServer === undefined || webServer === null) return;
    if (typeof webServer.register === 'function') {
      webCtx.effect(
        () => webServer.register({
          kind: 'exact',
          path: EMBED_INFO_PATH,
          handler,
        }),
        '@mebular/dsh-plugin: GET /mebular/embed-info',
      );
      webCtx.effect(
        () => webServer.register({
          kind: 'exact',
          path: RUNTIME_INSTALL_PATH,
          handler: installHandler,
        }),
        '@mebular/dsh-plugin: POST /mebular/runtime/install',
      );
    }
    // DSH 0.2.1-rc.2 exposes WebServer.tapIndex(transform) (see
    // @deepseek-ai/dsh-host-webserver). The global makes panel:false effective
    // before client apply runs. Without a webServer/tapIndex, client defaults
    // to panel:true and embed-info still reports the configured value.
    if (typeof webServer.tapIndex === 'function') {
      webCtx.effect(
        () => webServer.tapIndex((html) => injectPanelGlobal(html, resolved.panel)),
        '@mebular/dsh-plugin: panel bootstrap',
      );
    }
  });
}
